/**
 * Shared "change the model" core: preview (no write) + apply (commit).
 *
 * One source of truth used by BOTH the /propose+/apply endpoints and the chat
 * agent's write tool. Preview routes a plain-language change through the
 * existing refineModel classifier (which compile-checks and can ask for
 * clarification); apply commits exactly the previewed Malloy via saveRefinement
 * and records the concept + aliases for a definition. Nothing here writes
 * unless applyChange is called.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { refineModel, saveRefinement } from "../interview/refine.js";
import { recordConcept, deriveConceptFromDiff } from "../interview/definitions.js";
import { computeModelDiff } from "../interview/diff.js";
import { resolveModelDir, type ConceptDefinition } from "../models/manifest.js";
import type { RefinementClassification } from "../interview/types.js";

export interface DiffAdded {
  kind: string;
  name: string;
  expr: string;
}
export interface DiffChanged {
  kind: string;
  name: string;
  before: string;
  after: string;
}

export interface ChangePreview {
  feasible: boolean;
  noChange: boolean;
  needsClarification: boolean;
  clarificationQuestion: string | null;
  isDefinition: boolean;
  route: string;
  routeLabel: string;
  conceptField: string | null;
  conceptName: string | null;
  changeType: string | null;
  target: string | null;
  reasoning: string | null;
  addedItems: DiffAdded[];
  changedItems: DiffChanged[];
  removedItems: { kind: string; name: string }[];
  diffSummary: string | null;
  compileWarning: string | null;
  oldMalloy: string;
  newMalloy: string | null;
  classification: RefinementClassification | null;
  error: string | null;
}

/** Strip the "measure|dimension: name is " prefix to show just the expression. */
function exprOf(def: string | undefined): string {
  if (!def) return "";
  const m = def.match(/^(?:measure|dimension|join_(?:one|many|cross)|view|where):\s+\w+\s+is\s+([\s\S]+)$/);
  return (m ? m[1] : def).trim();
}

function emptyPreview(before: string): ChangePreview {
  return {
    feasible: false, noChange: false, needsClarification: false, clarificationQuestion: null,
    isDefinition: false, route: "error", routeLabel: "Can't apply",
    conceptField: null, conceptName: null, changeType: null, target: null, reasoning: null,
    addedItems: [], changedItems: [], removedItems: [],
    diffSummary: null, compileWarning: null, oldMalloy: before, newMalloy: null,
    classification: null, error: null,
  };
}

/**
 * Route + generate the proposed edit WITHOUT writing. Returns a structured,
 * grounded preview (or a clarification / honest refusal). Goes through the
 * build contract (refineModel compile-checks; failure is reported, not hidden).
 */
export async function previewChange(opts: {
  modelName: string;
  semanticModelsDir: string;
  billingProject?: string;
  text: string;
}): Promise<ChangePreview> {
  const { modelName, semanticModelsDir, billingProject, text } = opts;
  const modelDir = path.resolve(resolveModelDir(semanticModelsDir, modelName));
  const before = await fs.readFile(path.join(modelDir, "model.malloy"), "utf-8").catch(() => "");

  const refine = await refineModel({ modelName, semanticModelsDir, refinement: text, billingProject });

  // Underspecified but groundable — ask, don't dead-end.
  if (!refine.success && refine.needs_clarification && refine.clarification_question) {
    return {
      ...emptyPreview(before),
      feasible: false,
      needsClarification: true,
      clarificationQuestion: refine.clarification_question,
      route: "clarify",
      routeLabel: "One detail needed",
      reasoning: refine.classification?.reasoning ?? null,
      changeType: refine.classification?.change_type ?? null,
      target: refine.classification?.target ?? null,
      classification: refine.classification ?? null,
    };
  }

  // Not feasible / failed to compile after retry — honest refusal.
  if (!refine.success || !refine.new_malloy) {
    return {
      ...emptyPreview(before),
      error: refine.error ?? "Could not produce a valid change.",
      reasoning: refine.classification?.reasoning ?? null,
      changeType: refine.classification?.change_type ?? null,
      target: refine.classification?.target ?? null,
      classification: refine.classification ?? null,
    };
  }

  // Already satisfied.
  if (refine.new_malloy === refine.old_malloy) {
    return {
      ...emptyPreview(before),
      feasible: true,
      noChange: true,
      route: "no_change",
      routeLabel: "Already satisfied",
      reasoning: refine.diff_summary ?? refine.classification.reasoning,
      changeType: refine.classification.change_type,
      target: refine.classification.target,
      classification: refine.classification,
    };
  }

  const diff = computeModelDiff(before, refine.new_malloy);
  const addedItems = diff.entries
    .filter((e) => e.action === "added")
    .map((e) => ({ kind: e.type, name: e.name, expr: exprOf(e.new) }));
  const changedItems = diff.entries
    .filter((e) => e.action === "changed")
    .map((e) => ({ kind: e.type, name: e.name, before: exprOf(e.old), after: exprOf(e.new) }));
  const removedItems = diff.entries
    .filter((e) => e.action === "removed")
    .map((e) => ({ kind: e.type, name: e.name }));

  const newDimension = diff.entries.find(
    (e) => e.type === "dimension" && (e.action === "added" || e.action === "changed"),
  );
  const isDefinition = !!newDimension;
  const conceptField = newDimension?.name ?? null;
  const conceptName = conceptField ? conceptField.replace(/^is_/, "") : null;

  let route = "change";
  let routeLabel = "Update the model";
  if (isDefinition) {
    route = "definition";
    routeLabel = "Define a concept";
  } else if (addedItems.some((i) => i.kind === "measure")) {
    route = "measure";
    routeLabel = "Add a measure";
  } else if (addedItems.some((i) => i.kind === "view")) {
    route = "view";
    routeLabel = "Add a view";
  } else if (changedItems.length > 0) {
    route = "correction";
    routeLabel = "Correct an existing field";
  }

  return {
    feasible: true,
    noChange: false,
    needsClarification: false,
    clarificationQuestion: null,
    isDefinition,
    route,
    routeLabel,
    conceptField,
    conceptName,
    changeType: refine.classification.change_type,
    target: refine.classification.target,
    reasoning: refine.classification.reasoning,
    addedItems,
    changedItems,
    removedItems,
    diffSummary: refine.diff_summary ?? null,
    compileWarning: refine.compile_warning ?? null,
    oldMalloy: before,
    newMalloy: refine.new_malloy,
    classification: refine.classification,
    error: null,
  };
}

export interface ApplyResult {
  summary: string;
  concept: ConceptDefinition | null;
}

/**
 * Commit exactly the previewed Malloy (backs up, writes, records history +
 * trace). For a definition, records the concept + explicit aliases from the
 * SAME diff the preview showed. No second LLM round.
 */
export async function applyChange(opts: {
  modelName: string;
  semanticModelsDir: string;
  text: string;
  newMalloy: string;
  classification: RefinementClassification;
  isDefinition?: boolean;
  canonicalName?: string;
  aliases?: string[];
}): Promise<ApplyResult> {
  const { modelName, semanticModelsDir, text, newMalloy, classification, isDefinition, canonicalName, aliases } = opts;
  const modelDir = path.resolve(resolveModelDir(semanticModelsDir, modelName));
  const before = await fs.readFile(path.join(modelDir, "model.malloy"), "utf-8").catch(() => "");

  await saveRefinement({ modelName, semanticModelsDir, newMalloy, refinement: text, classification });

  let concept: ConceptDefinition | null = null;
  if (isDefinition) {
    const derived = deriveConceptFromDiff(before, newMalloy, {
      aliases: (aliases ?? []).map((a) => String(a).trim()).filter(Boolean),
      canonicalName,
    });
    if (derived) {
      await recordConcept(modelDir, derived);
      concept = derived;
    }
  }

  const diff = computeModelDiff(before, newMalloy);
  const parts: string[] = [];
  diff.entries.filter((e) => e.action === "added").forEach((e) => parts.push(`+${e.type} ${e.name}`));
  diff.entries.filter((e) => e.action === "changed").forEach((e) => parts.push(`~${e.type} ${e.name}`));
  const summary = concept
    ? `${concept.canonical_name}${concept.aliases.length ? ` (aka ${concept.aliases.join(", ")})` : ""}`
    : parts.join(", ") || "model updated";

  return { summary, concept };
}
