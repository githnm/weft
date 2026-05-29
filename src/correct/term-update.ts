import fs from "node:fs/promises";
import path from "node:path";
import { chat, stripCodeFences } from "../llm/anthropic.js";
import { loadTerms, saveTerms } from "../terms/store.js";
import { validateFilter, checkFilterEnumValues } from "../terms/define.js";
import { computeImpact } from "./impact.js";
import { addCorrection, generateCorrectionId } from "./store.js";
import { detectConnectorKind } from "./utils.js";
import { captureCorrectionTrace } from "../context/instrument.js";
import type { TermUpdateResult, NumericImpact, CorrectionRecord } from "./types.js";
import type { Session } from "../session/types.js";

const FILTER_UPDATE_SYSTEM = `You are an analytics engineer updating a Malloy filter expression based on a user correction.

Given the original filter and the user's correction, produce the updated filter.

Rules:
- Preserve the original filter's structure.
- Add/modify conditions as specified by the correction.
- Use valid Malloy where-clause syntax.
- Use 'and' to combine conditions.
- Preserve value-set syntax: column = 'A' | 'B' (never column = 'A' | column = 'B').
- If the correction adds a numeric condition, use standard comparison operators.

Return JSON (no markdown fences):
{
  "filter": "<updated Malloy filter expression>",
  "reasoning": "<one sentence explaining the change>"
}`;

/**
 * Execute the term-update correction flow:
 * 1. Generate updated filter via LLM
 * 2. Validate it compiles
 * 3. Check enum values
 * 4. Compute numeric impact (optional)
 * 5. Return result for user confirmation
 */
export async function prepareTermUpdate(options: {
  termName: string;
  correctionText: string;
  proposedNewFilter?: string;
  modelsDir: string;
  billingProject?: string;
  session?: Session | null;
  skipImpact?: boolean;
}): Promise<TermUpdateResult> {
  const { termName, correctionText, modelsDir, billingProject, session, skipImpact } = options;

  // 1. Load the existing term
  const terms = await loadTerms(modelsDir);
  const term = terms[termName];
  if (!term) {
    throw new Error(`Term "${termName}" not found in terms.json.`);
  }

  const oldFilter = term.filter;

  // 2. Generate updated filter
  let newFilter: string;
  if (options.proposedNewFilter) {
    newFilter = options.proposedNewFilter;
  } else {
    // Read source model for context
    const sourceContent = await fs.readFile(
      path.join(modelsDir, term.applies_to),
      "utf-8",
    ).catch(() => "");

    const response = await chat({
      system: FILTER_UPDATE_SYSTEM,
      userParts: [
        sourceContent ? `Malloy source model:\n\n${sourceContent}` : "",
        `Current filter for term "${termName}":\n  ${oldFilter}\n\nUser correction: "${correctionText}"\n\nUpdate the filter. Return JSON only.`,
      ].filter(Boolean),
      maxTokens: 512,
    });

    const raw = stripCodeFences(response.text);
    let parsed: { filter: string; reasoning: string };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new Error(`Failed to parse filter update response:\n${raw.slice(0, 300)}`);
    }

    if (!parsed.filter) {
      throw new Error("LLM did not return a filter expression.");
    }
    newFilter = parsed.filter;
  }

  // 3. Validate the new filter compiles
  const compileError = await validateFilter({
    filter: newFilter,
    sourceFilename: term.applies_to,
    modelsDir,
    billingProject,
  });

  if (compileError) {
    // Retry once with the error
    const sourceContent = await fs.readFile(
      path.join(modelsDir, term.applies_to),
      "utf-8",
    ).catch(() => "");

    const retryResponse = await chat({
      system: FILTER_UPDATE_SYSTEM,
      userParts: [
        sourceContent ? `Malloy source model:\n\n${sourceContent}` : "",
        `Current filter for term "${termName}":\n  ${oldFilter}\n\nUser correction: "${correctionText}"`,
        `Previous attempt failed to compile:\nFilter: ${newFilter}\nError: ${compileError}\n\nFix the filter. Return JSON only.`,
      ].filter(Boolean),
      maxTokens: 512,
    });

    const retryRaw = stripCodeFences(retryResponse.text);
    try {
      const retryParsed = JSON.parse(retryRaw);
      newFilter = retryParsed.filter;
    } catch {
      throw new Error(`Updated filter does not compile:\n${compileError}`);
    }

    const retryError = await validateFilter({
      filter: newFilter,
      sourceFilename: term.applies_to,
      modelsDir,
      billingProject,
    });

    if (retryError) {
      throw new Error(
        `Updated filter does not compile after retry.\n\n` +
          `Filter: ${newFilter}\nError: ${retryError}`,
      );
    }
  }

  // 4. Check enum values
  const enumCheck = await checkFilterEnumValues({
    filter: newFilter,
    sourceFilename: term.applies_to,
    modelsDir,
  });

  if (!enumCheck.ok) {
    throw new Error(
      `Updated filter references invalid enum values:\n${enumCheck.errors.join("\n")}`,
    );
  }
  for (const warning of enumCheck.warnings) {
    console.log(`  ⚠ ${warning}`);
  }

  // 5. Compute numeric impact (optional)
  let impact: NumericImpact | null = null;
  if (!skipImpact && session) {
    const connectorKind = await detectConnectorKind(modelsDir);
    impact = await computeImpact({
      session,
      termName,
      oldFilter,
      newFilter,
      modelsDir,
      billingProject,
      sourceFilename: term.applies_to,
      connectorKind,
    });
  }

  // 6. Generate correction ID
  const correctionId = generateCorrectionId(termName);

  return {
    termName,
    oldFilter,
    newFilter,
    impact,
    correctionId,
  };
}

/**
 * Apply a confirmed term update: write to terms.json and log to corrections.json.
 */
export async function applyTermUpdate(options: {
  result: TermUpdateResult;
  correctionText: string;
  modelsDir: string;
  session?: Session | null;
  /** The classification reasoning that prompted this correction (for the trace) */
  reasoning?: string;
}): Promise<void> {
  const { result, correctionText, modelsDir, session, reasoning } = options;

  // Update terms.json
  const terms = await loadTerms(modelsDir);
  const term = terms[result.termName];
  if (term) {
    term.filter = result.newFilter;
    await saveTerms(modelsDir, terms);
  }

  // Log to corrections.json
  const record: CorrectionRecord = {
    type: "term_update",
    targetTerm: result.termName,
    oldFilter: result.oldFilter,
    newFilter: result.newFilter,
    userCorrectionText: correctionText,
    appliedAt: new Date().toISOString(),
    numericImpact: result.impact,
    sessionQuestion: session?.last_question ?? "",
    description: correctionText.slice(0, 60),
  };

  await addCorrection(modelsDir, result.correctionId, record);

  // Capture a correction trace: links to the asks it affects, and marks the
  // prior definition of this term 'reversed'. Never throws.
  await captureCorrectionTrace({
    modelsDir,
    correctionText,
    reasoning,
    termName: result.termName,
    oldFilter: result.oldFilter,
    newFilter: result.newFilter,
    impact: result.impact,
    correctionId: result.correctionId,
  });
}

/**
 * Rollback a term update: restore the old filter from corrections.json.
 */
export async function rollbackTermUpdate(options: {
  correctionId: string;
  modelsDir: string;
}): Promise<{ termName: string; restoredFilter: string }> {
  const { correctionId, modelsDir } = options;

  const { getCorrection } = await import("./store.js");
  const record = await getCorrection(modelsDir, correctionId);
  if (!record) {
    throw new Error(`Correction "${correctionId}" not found.`);
  }
  if (record.type !== "term_update") {
    throw new Error(`Correction "${correctionId}" is a ${record.type}, not a term_update. Cannot auto-rollback.`);
  }
  if (!record.targetTerm || !record.oldFilter) {
    throw new Error("Correction record is missing target term or old filter.");
  }

  const terms = await loadTerms(modelsDir);
  const term = terms[record.targetTerm];
  if (!term) {
    throw new Error(`Term "${record.targetTerm}" no longer exists.`);
  }

  term.filter = record.oldFilter;
  await saveTerms(modelsDir, terms);

  return { termName: record.targetTerm, restoredFilter: record.oldFilter };
}

