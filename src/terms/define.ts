import fs from "node:fs/promises";
import path from "node:path";
import { normalizeTermKey, type Term } from "./types.js";
import {
  loadProposedTerms,
  removeProposal,
  addTerm,
  loadTerms,
} from "./store.js";
import { compileQuery } from "../agent/execute.js";
import type { ConnectorKind } from "../connectors/types.js";
import { chat, stripCodeFences } from "../llm/anthropic.js";
import { extractSourceSummary } from "../agent/catalog.js";
import { loadMetadata, getSourceMetadata } from "../agent/metadata-loader.js";
import { captureTermDefineTrace } from "../context/instrument.js";

// ── Shared: compile-validate a filter ─────────────────────────────

/**
 * Validate that a Malloy filter expression compiles against a source.
 * Returns null on success, or an error string on failure.
 */
export async function validateFilter(options: {
  filter: string;
  sourceFilename: string;
  modelsDir: string;
  billingProject?: string;
}): Promise<string | null> {
  const { filter, sourceFilename, modelsDir, billingProject } = options;

  // Read all .malloy files
  const entries = await fs.readdir(modelsDir);
  const malloyFileNames = entries.filter((f) => f.endsWith(".malloy")).sort();
  const malloyFiles = new Map<string, string>();
  for (const name of malloyFileNames) {
    const content = await fs.readFile(path.join(modelsDir, name), "utf-8");
    malloyFiles.set(name, content);
  }

  // Extract source name from file
  const sourceContent = malloyFiles.get(sourceFilename);
  if (!sourceContent) return `Source file "${sourceFilename}" not found.`;

  const summary = extractSourceSummary(sourceFilename, sourceContent);
  if (!summary) return `Could not parse source from "${sourceFilename}".`;

  // Detect connector kind so the right connection is used
  let connectorKind: ConnectorKind | undefined;
  try {
    const inspRaw = await fs.readFile(path.join(modelsDir, "inspection.json"), "utf-8");
    connectorKind = JSON.parse(inspRaw).connector_kind;
  } catch { /* default to bigquery */ }

  // Build a minimal run block that uses the filter as a where clause.
  // Use a unique aggregate name to avoid clashes with existing measures.
  const runBlock = `run: ${summary.sourceName} -> {\n  where: ${filter}\n  aggregate: _validation_count is count()\n}`;

  return compileQuery({
    sourceFilename,
    runBlock,
    modelsDir,
    malloyFiles,
    billingProject,
    connectorKind,
  });
}

// ── Shared: check filter values against captured enums ───────────

/**
 * Extract literal string values from a filter expression.
 * Matches patterns like: column = 'A' | 'B' | 'C'
 * Returns { column, values } or null if parsing fails.
 */
function extractFilterLiterals(filter: string): { column: string; values: string[] } | null {
  // Match: <column> = 'val1' possibly followed by | 'val2' | 'val3' ...
  const match = filter.match(/^(\w+)\s*=\s*'([^']*)'((?:\s*\|\s*'[^']*')*)$/);
  if (!match) return null;

  const column = match[1];
  const values: string[] = [match[2]];

  // Extract additional | 'value' entries
  if (match[3]) {
    const extras = match[3].matchAll(/\|\s*'([^']*)'/g);
    for (const e of extras) {
      values.push(e[1]);
    }
  }

  return { column, values };
}

export interface EnumCheckResult {
  ok: boolean;
  /** Hard errors — values don't exist and enum is complete */
  errors: string[];
  /** Soft warnings — values not in top-N but enum is truncated */
  warnings: string[];
}

/**
 * After compile passes, check that literal string values in the filter
 * actually exist in the captured enum for that column (if available in metadata).
 */
export async function checkFilterEnumValues(options: {
  filter: string;
  sourceFilename: string;
  modelsDir: string;
}): Promise<EnumCheckResult> {
  const { filter, sourceFilename, modelsDir } = options;
  const result: EnumCheckResult = { ok: true, errors: [], warnings: [] };

  const parsed = extractFilterLiterals(filter);
  if (!parsed) return result; // Complex filter — skip this check

  const metadata = await loadMetadata(modelsDir);
  if (!metadata) return result; // No metadata available

  // Find the source name from the .malloy file
  const sourceContent = await fs.readFile(path.join(modelsDir, sourceFilename), "utf-8").catch(() => null);
  if (!sourceContent) return result;

  const summary = extractSourceSummary(sourceFilename, sourceContent);
  if (!summary) return result;

  const sourceMeta = getSourceMetadata(metadata, summary.sourceName);
  if (!sourceMeta) return result;

  const enumInfo = sourceMeta.enums[parsed.column];
  if (!enumInfo) return result; // No enum captured for this column

  const knownValues = new Set(enumInfo.values.map((v) => v.toLowerCase()));
  const badValues: string[] = [];

  for (const val of parsed.values) {
    if (!knownValues.has(val.toLowerCase())) {
      badValues.push(val);
    }
  }

  if (badValues.length === 0) return result;

  if (enumInfo.truncated) {
    result.warnings.push(
      `Term filter references ${badValues.map((v) => `'${v}'`).join(", ")} not in the top-${enumInfo.values.length} captured values for ${parsed.column}. ` +
      `The enum is truncated (${enumInfo.total_distinct ?? "?"} total values); these may exist in the long tail. Saving anyway.`,
    );
  } else {
    result.ok = false;
    result.errors.push(
      `Term filter references values that don't exist in ${parsed.column}: ${badValues.map((v) => `'${v}'`).join(", ")}. ` +
      `Known values: ${enumInfo.values.map((v) => `'${v}'`).join(", ")}`,
    );
  }

  return result;
}

// ── Confirm mode ──────────────────────────────────────────────────

export interface ConfirmResult {
  key: string;
  filter: string;
  sourceFilename: string;
  sourceName: string;
}

export async function confirmTerm(options: {
  term: string;
  modelsDir: string;
  billingProject?: string;
}): Promise<ConfirmResult> {
  const { term, modelsDir, billingProject } = options;

  const key = normalizeTermKey(term);
  const proposals = await loadProposedTerms(modelsDir);

  // Case-insensitive lookup
  let matchKey: string | undefined;
  for (const k of Object.keys(proposals)) {
    if (k === key || k.toLowerCase() === key.toLowerCase()) {
      matchKey = k;
      break;
    }
  }

  if (!matchKey) {
    throw new Error(
      `No proposal exists for '${term}'.\n` +
        `Use manual mode: pnpm cli define ${term} --description "..." --models ${modelsDir}`,
    );
  }

  const proposal = proposals[matchKey];

  // Validate the filter compiles
  const compileError = await validateFilter({
    filter: proposal.filter,
    sourceFilename: proposal.applies_to,
    modelsDir,
    billingProject,
  });

  if (compileError) {
    throw new Error(
      `Proposed filter does not compile:\n${compileError}\n\n` +
        `Filter: ${proposal.filter}\n` +
        `Source: ${proposal.applies_to}\n\n` +
        `The proposal may be stale. Try defining the term manually.`,
    );
  }

  // Check filter values against captured enums
  const enumCheck = await checkFilterEnumValues({
    filter: proposal.filter,
    sourceFilename: proposal.applies_to,
    modelsDir,
  });

  if (!enumCheck.ok) {
    throw new Error(
      enumCheck.errors.join("\n") + "\n\n" +
        `Filter: ${proposal.filter}\n` +
        `Try defining the term manually with correct values.`,
    );
  }

  // Print warnings (truncated enums) but allow saving
  for (const warning of enumCheck.warnings) {
    console.log(`  ⚠ ${warning}`);
  }

  // Resolve source name for display
  const sourceContent = await fs.readFile(path.join(modelsDir, proposal.applies_to), "utf-8");
  const summary = extractSourceSummary(proposal.applies_to, sourceContent);

  // Promote to terms.json
  const confirmedTerm: Term = {
    filter: proposal.filter,
    applies_to: proposal.applies_to,
    description: `Auto-proposed from question: "${proposal.question_context}"`,
    created_at: new Date().toISOString(),
    created_via: "auto-confirmed",
    matched_count: 0,
  };

  await addTerm(modelsDir, matchKey, confirmedTerm);
  await removeProposal(modelsDir, matchKey);

  // Capture a term_define trace (never throws).
  await captureTermDefineTrace({
    modelsDir,
    termKey: matchKey,
    description: confirmedTerm.description,
    filter: proposal.filter,
    sourceName: summary?.sourceName ?? proposal.applies_to,
    via: "auto-confirmed",
  });

  return {
    key: matchKey,
    filter: proposal.filter,
    sourceFilename: proposal.applies_to,
    sourceName: summary?.sourceName ?? proposal.applies_to,
  };
}

// ── Manual mode ───────────────────────────────────────────────────

const DEFINE_SYSTEM_PROMPT = `You are an analytics engineer helping define a business term as a Malloy filter expression. Given the term, its description, and the available source model, produce a filter that captures the user's intent.

The filter must be a valid Malloy \`where:\` clause expression. Use dimension names and string literals from the model.

Examples of valid filters:
- subscriber_type = 'Student Membership' | 'U.T. Student Membership'
- status = 'active'
- duration_minutes > 60
- start_time > @2024-01-01

Return JSON only (no markdown fences):
{
  "filter": "<malloy filter expression>",
  "reasoning": "<one sentence explaining what you mapped>",
  "confidence": "high" | "medium" | "low"
}`;

export interface ManualDefineResult {
  key: string;
  filter: string;
  reasoning: string;
  confidence: "high" | "medium" | "low";
  sourceFilename: string;
  sourceName: string;
}

export async function defineTermManually(options: {
  term: string;
  description: string;
  sourceFilename: string;
  modelsDir: string;
  billingProject?: string;
}): Promise<ManualDefineResult> {
  const { term, description, sourceFilename, modelsDir, billingProject } = options;

  const key = normalizeTermKey(term);

  // Read the source file
  const sourceContent = await fs.readFile(path.join(modelsDir, sourceFilename), "utf-8");
  const summary = extractSourceSummary(sourceFilename, sourceContent);
  if (!summary) {
    throw new Error(`Could not parse source from "${sourceFilename}".`);
  }

  // Ask the LLM for a filter
  const response = await chat({
    system: DEFINE_SYSTEM_PROMPT,
    userParts: [
      `Malloy source model:\n\n${sourceContent}`,
      `Term: "${term}"\nDescription: ${description}\nSource name: ${summary.sourceName}\n\nGenerate a Malloy filter expression. Return JSON only.`,
    ],
    maxTokens: 512,
  });

  const raw = stripCodeFences(response.text);
  let parsed: { filter: string; reasoning: string; confidence: "high" | "medium" | "low" };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse LLM response for term definition:\n${raw.slice(0, 300)}`);
  }

  if (!parsed.filter || !parsed.reasoning) {
    throw new Error(`LLM response missing required fields:\n${JSON.stringify(parsed, null, 2).slice(0, 300)}`);
  }

  // Validate the filter compiles
  let compileError = await validateFilter({
    filter: parsed.filter,
    sourceFilename,
    modelsDir,
    billingProject,
  });

  // Retry once if compilation fails
  if (compileError) {
    const retryResponse = await chat({
      system: DEFINE_SYSTEM_PROMPT,
      userParts: [
        `Malloy source model:\n\n${sourceContent}`,
        `Term: "${term}"\nDescription: ${description}\nSource name: ${summary.sourceName}`,
        `Previous attempt failed to compile:\nFilter: ${parsed.filter}\nError: ${compileError}\n\nFix the filter. Return JSON only.`,
      ],
      maxTokens: 512,
    });

    const retryRaw = stripCodeFences(retryResponse.text);
    try {
      parsed = JSON.parse(retryRaw);
    } catch {
      throw new Error(`Failed to parse retry response:\n${retryRaw.slice(0, 300)}`);
    }

    compileError = await validateFilter({
      filter: parsed.filter,
      sourceFilename,
      modelsDir,
      billingProject,
    });

    if (compileError) {
      throw new Error(
        `Filter still does not compile after retry.\n\n` +
          `Filter: ${parsed.filter}\nError: ${compileError}\n\n` +
          `Try a different description or define the filter manually.`,
      );
    }
  }

  // Check filter values against captured enums
  const enumCheck = await checkFilterEnumValues({
    filter: parsed.filter,
    sourceFilename,
    modelsDir,
  });

  if (!enumCheck.ok) {
    throw new Error(
      enumCheck.errors.join("\n") + "\n\n" +
        `Filter: ${parsed.filter}\n` +
        `Try a different description or specify exact values.`,
    );
  }

  // Print warnings (truncated enums) but allow saving
  for (const warning of enumCheck.warnings) {
    console.log(`  ⚠ ${warning}`);
  }

  // Capture a term_define trace with the LLM's filter-derivation reasoning
  // (never throws). Manual define is persisted immediately by the caller.
  await captureTermDefineTrace({
    modelsDir,
    termKey: key,
    description,
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
    filter: parsed.filter,
    sourceName: summary.sourceName,
    via: "manual",
  });

  return {
    key,
    filter: parsed.filter,
    reasoning: parsed.reasoning,
    confidence: parsed.confidence,
    sourceFilename,
    sourceName: summary.sourceName,
  };
}

/**
 * Save a manually-defined term after the user confirms.
 */
export async function saveManualTerm(options: {
  key: string;
  filter: string;
  description: string;
  sourceFilename: string;
  modelsDir: string;
}): Promise<void> {
  const { key, filter, description, sourceFilename, modelsDir } = options;

  const existing = await loadTerms(modelsDir);
  existing[key] = {
    filter,
    applies_to: sourceFilename,
    description,
    created_at: new Date().toISOString(),
    created_via: "manual",
    matched_count: 0,
  };
  const { saveTerms } = await import("./store.js");
  await saveTerms(modelsDir, existing);
}
