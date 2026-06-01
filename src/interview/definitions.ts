/**
 * Concept definitions with explicit aliases.
 *
 * A definition is a CONCEPT, not a single word: one filter/measure baked into
 * model.malloy (the `field`), plus a canonical name and explicit, owner-
 * confirmed aliases recorded in the manifest. The ask pipeline injects the
 * concept→alias map into the generator so any confirmed word applies the same
 * filter. Nothing maps without explicit confirmation — a wrong alias is a
 * silent wrong answer.
 *
 * Reuses the existing bake-in path (refineModel + saveRefinement) and stores
 * aliases in the model manifest (model.json), not a separate terms.json.
 */

import fs from "node:fs/promises";
import path from "node:path";
import type { LLMUsage } from "../llm/anthropic.js";
import { refineModel, saveRefinement } from "./refine.js";
import { computeModelDiff } from "./diff.js";
import {
  loadManifest,
  saveManifest,
  resolveModelDir,
  type ConceptDefinition,
} from "../models/manifest.js";

export interface BakeDefinitionResult {
  applied: boolean;
  noChange?: boolean;
  concept?: ConceptDefinition;
  changeType?: string;
  target?: string;
  diffSummary?: string;
  compileWarning?: string;
  modelMalloy?: string;
  reason?: string;
  error?: string;
  draftMalloy?: string;
  usage: LLMUsage;
}

/** is_external_user → external_users; otherwise the field name unchanged. */
function deriveCanonical(field: string): string {
  return field.replace(/^is_/, "");
}

/** Normalize + dedupe explicit aliases (never auto-added; this only cleans). */
function cleanAliases(aliases: string[] | undefined, canonical: string, field: string): string[] {
  const seen = new Set<string>([canonical.toLowerCase(), field.toLowerCase()]);
  const out: string[] = [];
  for (const a of aliases ?? []) {
    const t = a.trim();
    if (!t) continue;
    const key = t.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

/** Record (or replace by canonical name) a concept in the manifest. */
export async function recordConcept(modelDir: string, concept: ConceptDefinition): Promise<void> {
  const manifest = await loadManifest(modelDir);
  const concepts = (manifest.concepts ?? []).filter(
    (c) => c.canonical_name.toLowerCase() !== concept.canonical_name.toLowerCase(),
  );
  concepts.push(concept);
  await saveManifest(modelDir, { ...manifest, concepts });
}

/**
 * Derive the concept a change baked in by diffing the model before/after.
 * The concept's field is the added (or changed) dimension — segments are the
 * filterable, meaningful part — else the added/changed measure. Pure: records
 * nothing. Shared by bakeDefinition and the web editor's apply path so both
 * derive the SAME concept from the SAME diff.
 */
export function deriveConceptFromDiff(
  beforeMalloy: string,
  newMalloy: string,
  opts: { aliases?: string[]; canonicalName?: string },
): ConceptDefinition | undefined {
  const diff = computeModelDiff(beforeMalloy, newMalloy);
  const added = diff.entries.filter(
    (e) => (e.type === "dimension" || e.type === "measure") && (e.action === "added" || e.action === "changed"),
  );
  const primary = added.find((e) => e.type === "dimension") ?? added[0];
  if (!primary) return undefined;

  const field = primary.name;
  const exprMatch = (primary.new ?? "").match(/^(?:measure|dimension):\s+\w+\s+is\s+([\s\S]+)$/);
  const canonical = opts.canonicalName?.trim() || deriveCanonical(field);
  return {
    canonical_name: canonical,
    aliases: cleanAliases(opts.aliases, canonical, field),
    field,
    kind: primary.type === "measure" ? "measure" : "dimension",
    filter: exprMatch ? exprMatch[1].trim() : undefined,
  };
}

/** Load a model's baked concepts (empty if none / unreadable). */
export async function loadConcepts(modelDir: string): Promise<ConceptDefinition[]> {
  try {
    const manifest = await loadManifest(modelDir);
    return manifest.concepts ?? [];
  } catch {
    return [];
  }
}

/**
 * Bake a plain-English definition into model.malloy (via refine) and record the
 * resulting concept with its owner-confirmed aliases. Single definition in,
 * single concept out — the new field is found by diffing the model.
 */
export async function bakeDefinition(opts: {
  modelName: string;
  semanticModelsDir: string;
  definition: string;
  aliases?: string[];
  canonicalName?: string;
  billingProject?: string;
}): Promise<BakeDefinitionResult> {
  const { modelName, semanticModelsDir, definition, billingProject } = opts;
  const modelDir = resolveModelDir(semanticModelsDir, modelName);
  const before = await fs.readFile(path.join(modelDir, "model.malloy"), "utf-8").catch(() => "");

  const refine = await refineModel({ modelName, semanticModelsDir, refinement: definition, billingProject });

  if (!refine.success || !refine.new_malloy) {
    return {
      applied: false,
      reason: refine.classification?.reasoning,
      error: refine.error,
      draftMalloy: refine.draft_malloy,
      changeType: refine.classification?.change_type,
      target: refine.classification?.target,
      usage: refine.usage,
    };
  }

  if (refine.new_malloy === refine.old_malloy) {
    return {
      applied: false,
      noChange: true,
      reason: refine.diff_summary ?? refine.classification.reasoning,
      changeType: refine.classification.change_type,
      target: refine.classification.target,
      usage: refine.usage,
    };
  }

  await saveRefinement({
    modelName,
    semanticModelsDir,
    newMalloy: refine.new_malloy,
    refinement: definition,
    classification: refine.classification,
  });

  // Find the field this definition baked (added/changed dimension, else measure)
  // and record the concept with its explicit aliases.
  const concept = deriveConceptFromDiff(before, refine.new_malloy, {
    aliases: opts.aliases,
    canonicalName: opts.canonicalName,
  });
  if (concept) {
    await recordConcept(modelDir, concept);
  }

  return {
    applied: true,
    concept,
    changeType: refine.classification.change_type,
    target: refine.classification.target,
    diffSummary: refine.diff_summary,
    compileWarning: refine.compile_warning,
    modelMalloy: refine.new_malloy,
    usage: refine.usage,
  };
}

/**
 * Build the concept→alias map for the generate (and feasibility) prompt.
 * Returns "" when the model has no concepts. The instruction is strict: apply a
 * concept ONLY for its canonical name or a listed alias — never guess synonyms —
 * and honor an explicit opt-out (all / everyone / including-internal).
 */
export function buildConceptsPrompt(concepts: ConceptDefinition[]): string {
  if (concepts.length === 0) return "";
  const lines = [
    "MODEL CONCEPTS — baked business definitions with explicit aliases.",
    "When the question refers to a concept by its canonical name OR any listed alias, APPLY it:",
    "  - a dimension concept → add `where: <field>` (it is a boolean segment),",
    "  - a measure concept → use the measure `<field>`.",
    "",
  ];
  for (const c of concepts) {
    const akas = c.aliases.length > 0 ? ` (aka ${c.aliases.join(", ")})` : "";
    const how = c.kind === "measure" ? `use measure \`${c.field}\`` : `apply \`where: ${c.field}\``;
    lines.push(`- ${c.canonical_name}${akas} → ${how}${c.filter ? `   // ${c.filter}` : ""}`);
  }
  lines.push("");
  lines.push(
    "Apply a concept's filter when the question uses the concept or any of its listed aliases, " +
      "UNLESS the question explicitly asks for all / everyone / every / including-internal (an explicit opt-out — then do NOT apply it). " +
      "Apply a concept ONLY for these exact words (canonical name or a listed alias). " +
      "Do NOT treat any other word as a synonym; if a word is not a listed concept/alias, take it literally with no added filter.",
  );
  return lines.join("\n");
}
