/**
 * "What if" simulation — the payoff of the trace store as a world model.
 *
 * Given a proposed change in plain English, we compute its REAL effect across
 * the whole history of questions that touched the affected part of the model —
 * not an estimate, and not just a retrieval of past decisions.
 *
 * It generalizes the existing correction-impact (which recomputes ONE last
 * query for a single term swap) to the WHOLE history, for any model change:
 *
 *   1. TERM/MEASURE CHANGE IMPACT — re-run every past ask that used the
 *      changed measure/dimension against the proposed model; report which
 *      answers change and by how much.
 *   2. MODEL CHANGE BLAST RADIUS — re-run every past ask that referenced a
 *      dropped join/field; report which become unanswerable.
 *
 * Reuses existing machinery end-to-end:
 *   - refineModel()      → turn the plain-English change into a COMPILING
 *                          candidate model.malloy (without saving it).
 *   - computeModelDiff() → learn exactly which entities changed.
 *   - the ask trace log  → the historical questions + their stored Malloy.
 *   - executeQuery()     → re-run each stored query against the candidate.
 * Connector-aware (Postgres + BigQuery) because executeQuery is.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { refineModel } from "../interview/refine.js";
import { computeModelDiff, type ModelDiffEntry } from "../interview/diff.js";
import { executeQuery } from "../agent/execute.js";
import { queryTraces, type Trace } from "./trace.js";
import { loadManifest, resolveModelDir } from "../models/manifest.js";
import type { ConnectorKind } from "../connectors/types.js";
import type { ExecutionResult, LLMUsage } from "../agent/types.js";

export interface AnswerDelta {
  question: string;
  traceId: string;
  /** The metric column that was compared (first numeric output column) */
  metric: string | null;
  before: number | null;
  after: number | null;
  deltaPct: number | null;
  rowsBefore: number | null;
  rowsAfter: number | null;
  status: "changed" | "unchanged" | "unanswerable" | "baseline_failed";
  detail?: string;
}

export interface WhatIfReport {
  modelName: string;
  proposedChange: string;
  /** Whether the change could be turned into a compiling candidate model */
  feasible: boolean;
  /** Structural entities the change touched */
  changedEntities: { type: string; action: string; name: string }[];
  affectedCount: number;
  deltas: AnswerDelta[];
  unanswerable: { question: string; reason: string }[];
  /** One-line human summary */
  summary: string;
  /** Net average magnitude across changed numeric answers */
  netSummary?: string;
  /** Constructive next step when the change can't be simulated as-is */
  suggestion?: string;
  error?: string;
  usage: LLMUsage;
}

export interface SimulateOptions {
  modelName: string;
  semanticModelsDir: string;
  proposedChange: string;
  billingProject?: string;
  location?: string;
  /** Cap how many historical asks to re-run (safety valve for huge histories) */
  maxReplays?: number;
}

const DEFAULT_MAX_REPLAYS = 50;

// ── Helpers ──────────────────────────────────────────────────────

/** First numeric output column summarized: scalar value, or sum across rows. */
function summarizeMetric(exec: ExecutionResult): { column: string; value: number } | null {
  const rows = exec.rows ?? [];
  if (rows.length === 0) return null;
  const first = rows[0];
  const numericCol = Object.keys(first).find((k) => typeof first[k] === "number");
  if (!numericCol) return null;
  if (rows.length === 1) {
    return { column: numericCol, value: first[numericCol] as number };
  }
  let sum = 0;
  for (const r of rows) {
    const v = r[numericCol];
    if (typeof v === "number") sum += v;
  }
  return { column: numericCol, value: sum };
}

function pctChange(before: number, after: number): number {
  if (before === 0) return after === 0 ? 0 : 100;
  return Math.round(((after - before) / before) * 10000) / 100;
}

/** Does the stored query reference any of the changed entity names as a token? */
function queryReferencesEntity(malloy: string, names: Set<string>): boolean {
  for (const name of names) {
    if (!name) continue;
    const re = new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
    if (re.test(malloy)) return true;
  }
  return false;
}

/**
 * When a change can't be turned into a direct model edit, keep the honest
 * refusal but add a constructive next step. If the reason looks like a
 * two-level / per-entity aggregation (the common case — "users with at least
 * N events"), point at the nested-view form that WOULD work; otherwise give
 * the generic "express it as a concrete model edit" guidance. Dataset-agnostic.
 */
function buildRefusalSuggestion(modelName: string, proposedChange: string, reason?: string): string {
  const r = (reason ?? "").toLowerCase();
  const needsNestedView =
    /aggregat|nested|having|two[- ]?level|per[- ]?(user|entity|row)|group by|count of count|distinct count of/.test(r) ||
    /at least|more than|fewer than|>=|<=|threshold/.test(proposedChange.toLowerCase());

  if (needsNestedView) {
    return (
      "This needs a nested view, not a measure tweak — it filters entities by a per-entity aggregate " +
      "(a GROUP BY followed by a HAVING-style condition), which a single measure can't express. " +
      "To make it simulatable: add that structure first, e.g.\n" +
      `    pnpm cli model refine ${modelName} "add a view that groups by the user key, computes each user's event count, ` +
      `and keeps only users meeting the threshold"\n` +
      "(or the refine_model tool). Once the view exists, re-run `model whatif` against it and the historical impact can be recomputed."
    );
  }

  return (
    "The change couldn't be applied as a direct edit to a measure, dimension, view, join, or filter, so there's nothing to " +
    "simulate yet. Re-state it as a concrete model edit and apply it with " +
    `\`pnpm cli model refine ${modelName} "..."\` (or the refine_model tool), then re-run \`model whatif\` to recompute the impact across history.`
  );
}

async function detectConnectorKind(modelDir: string, substrateDir: string): Promise<ConnectorKind | undefined> {
  try {
    const manifest = await loadManifest(modelDir);
    if (manifest.connector_kind) return manifest.connector_kind as ConnectorKind;
  } catch {
    /* fall through */
  }
  try {
    const raw = await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
    return JSON.parse(raw).connector_kind as ConnectorKind;
  } catch {
    return undefined;
  }
}

async function readMalloyFiles(dir: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  const entries = await fs.readdir(dir);
  for (const name of entries.filter((f) => f.endsWith(".malloy")).sort()) {
    map.set(name, await fs.readFile(path.join(dir, name), "utf-8"));
  }
  return map;
}

// ── Main ─────────────────────────────────────────────────────────

export async function simulateChange(options: SimulateOptions): Promise<WhatIfReport> {
  const { modelName, semanticModelsDir, proposedChange, billingProject, location } = options;
  const maxReplays = options.maxReplays ?? DEFAULT_MAX_REPLAYS;

  const modelDir = resolveModelDir(semanticModelsDir, modelName);

  const base: WhatIfReport = {
    modelName,
    proposedChange,
    feasible: false,
    changedEntities: [],
    affectedCount: 0,
    deltas: [],
    unanswerable: [],
    summary: "",
    usage: { inputTokens: 0, outputTokens: 0 },
  };

  // ── Step 1: read current model + connector ──
  let currentMalloy: string;
  try {
    currentMalloy = await fs.readFile(path.join(modelDir, "model.malloy"), "utf-8");
  } catch {
    return { ...base, error: `model.malloy not found for model "${modelName}".`, summary: "Model not found." };
  }
  let substrateDir = modelDir;
  try {
    const manifest = await loadManifest(modelDir);
    substrateDir = path.resolve(modelDir, manifest.substrate_dir);
  } catch {
    /* substrate detection is best-effort */
  }
  const connectorKind = await detectConnectorKind(modelDir, substrateDir);

  // ── Step 2: turn the plain-English change into a compiling candidate model ──
  // refineModel returns the new model.malloy WITHOUT saving it — perfect for a
  // hypothetical. It also guarantees the candidate compiles.
  const refine = await refineModel({ modelName, semanticModelsDir, refinement: proposedChange, billingProject });
  base.usage = refine.usage;

  if (!refine.success || !refine.new_malloy) {
    return {
      ...base,
      error: refine.error ?? "Could not construct a candidate model for this change.",
      summary: `Cannot simulate: ${refine.classification?.reasoning ?? refine.error ?? "the change is not feasible."}`,
      suggestion: buildRefusalSuggestion(modelName, proposedChange, refine.classification?.reasoning ?? refine.error),
    };
  }

  const candidateMalloy = refine.new_malloy;

  // Already-satisfied / no-op change → nothing to simulate.
  if (candidateMalloy.trim() === currentMalloy.trim()) {
    return {
      ...base,
      feasible: true,
      summary: "No change needed — the model already satisfies this. No past answers are affected.",
    };
  }

  // ── Step 3: which entities changed? ──
  const diff = computeModelDiff(currentMalloy, candidateMalloy);
  const changedEntities = diff.entries.map((e: ModelDiffEntry) => ({ type: e.type, action: e.action, name: e.name }));
  base.changedEntities = changedEntities;
  const changedNames = new Set(changedEntities.map((e) => e.name));

  // ── Step 4: load ask history for this model ──
  const askTraces = await queryTraces(modelDir, { decision_type: "ask" });
  const replayable = askTraces.filter((t) => typeof (t.action ?? {}).malloy === "string");

  // ── Step 5: find affected asks ──
  const affected = replayable.filter((t) => {
    const malloy = (t.action as { malloy: string }).malloy;
    // sources_changed (e.g. a dropped join can ripple) → treat all as candidates;
    // otherwise an ask is affected only if it references a changed entity name.
    return diff.sources_changed || queryReferencesEntity(malloy, changedNames);
  });
  base.affectedCount = affected.length;
  base.feasible = true;

  if (affected.length === 0) {
    return {
      ...base,
      summary:
        `The change touches [${[...changedNames].join(", ") || "the model"}] but no past questions in the trace ` +
        `history used it. 0 of ${replayable.length} past answers are affected.`,
    };
  }

  // ── Step 6: re-run each affected ask against current (baseline) and candidate ──
  const baselineFiles = await readMalloyFiles(modelDir);
  const candidateFiles = new Map(baselineFiles);
  candidateFiles.set("model.malloy", candidateMalloy);

  const toReplay = affected.slice(0, maxReplays);
  const droppedFromCap = affected.length - toReplay.length;

  const deltas: AnswerDelta[] = [];
  const unanswerable: { question: string; reason: string }[] = [];

  for (const t of toReplay) {
    const action = t.action as { malloy: string; source?: string };
    const sourceFilename = typeof action.source === "string" ? action.source : "model.malloy";
    const runBlock = action.malloy;

    const baseline = await executeQuery({
      sourceFilename,
      runBlock,
      modelsDir: modelDir,
      malloyFiles: baselineFiles,
      billingProject,
      location,
      connectorKind,
    });

    if (!baseline.ok) {
      deltas.push({
        question: t.observation,
        traceId: t.id,
        metric: null,
        before: null,
        after: null,
        deltaPct: null,
        rowsBefore: null,
        rowsAfter: null,
        status: "baseline_failed",
        detail: `Historical query no longer runs against the current model (${baseline.phase}).`,
      });
      continue;
    }

    const candidate = await executeQuery({
      sourceFilename,
      runBlock,
      modelsDir: modelDir,
      malloyFiles: candidateFiles,
      billingProject,
      location,
      connectorKind,
    });

    if (!candidate.ok) {
      unanswerable.push({ question: t.observation, reason: `${candidate.phase} error: ${candidate.error.split("\n")[0]}` });
      deltas.push({
        question: t.observation,
        traceId: t.id,
        metric: null,
        before: null,
        after: null,
        deltaPct: null,
        rowsBefore: baseline.result.totalRows,
        rowsAfter: null,
        status: "unanswerable",
        detail: `Becomes unanswerable under the change (${candidate.phase} error).`,
      });
      continue;
    }

    const beforeMetric = summarizeMetric(baseline.result);
    const afterMetric = summarizeMetric(candidate.result);
    const rowsBefore = baseline.result.totalRows;
    const rowsAfter = candidate.result.totalRows;

    const before = beforeMetric?.value ?? null;
    const after = afterMetric?.value ?? null;
    const metric = beforeMetric?.column ?? afterMetric?.column ?? null;
    const deltaPct = before !== null && after !== null ? pctChange(before, after) : null;

    const changed =
      rowsBefore !== rowsAfter || (before !== null && after !== null && before !== after);

    deltas.push({
      question: t.observation,
      traceId: t.id,
      metric,
      before,
      after,
      deltaPct,
      rowsBefore,
      rowsAfter,
      status: changed ? "changed" : "unchanged",
    });
  }

  // ── Step 7: synthesize the report ──
  const changedDeltas = deltas.filter((d) => d.status === "changed");
  const numericChanged = changedDeltas.filter((d) => d.deltaPct !== null);
  let netSummary: string | undefined;
  if (numericChanged.length > 0) {
    const avg = numericChanged.reduce((s, d) => s + (d.deltaPct ?? 0), 0) / numericChanged.length;
    netSummary = `Net: affected metrics change by ${avg >= 0 ? "+" : ""}${avg.toFixed(1)}% on average across ${numericChanged.length} answer(s).`;
  }

  const summaryParts = [
    `This change affects ${affected.length} past question${affected.length === 1 ? "" : "s"}.`,
    `${changedDeltas.length} answer${changedDeltas.length === 1 ? "" : "s"} change.`,
  ];
  if (unanswerable.length > 0) {
    summaryParts.push(`${unanswerable.length} question${unanswerable.length === 1 ? "" : "s"} become unanswerable.`);
  }
  if (droppedFromCap > 0) {
    summaryParts.push(`(Capped at ${maxReplays} replays; ${droppedFromCap} additional affected question(s) not re-run.)`);
  }

  return {
    ...base,
    deltas,
    unanswerable,
    netSummary,
    summary: summaryParts.join(" "),
  };
}
