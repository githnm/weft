/**
 * Trace instrumentation — the bridge between the engine's existing flows and
 * the append-only trace store.
 *
 * Each helper builds a domain-specific Trace from data a flow already has and
 * appends it. Every helper is wrapped so that a tracing failure NEVER breaks
 * the underlying operation — tracing is purely additive (log and continue).
 *
 * The flows already produce the reasoning (source-selection rationale, query
 * plans, classification reasoning, filter derivations, model-design
 * decisions). We capture it — we do not invent new reasoning.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  appendTrace,
  buildTrace,
  readTraces,
  updateOutcome,
  type Trace,
} from "./trace.js";
import { extractFilters } from "../session/parse-malloy.js";
import { computeModelDiff } from "../interview/diff.js";
import type { AskResult } from "../agent/types.js";
import type { NumericImpact } from "../correct/types.js";
import type { ResolvedDecision, RelevantTable } from "../interview/types.js";

function logTraceError(where: string, err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  // console.log is redirected to stderr in the MCP server, so this is safe.
  console.error(`[trace] ${where} failed (non-fatal): ${msg}`);
}

/**
 * Best-effort: derive the semantic-model name for a directory by reading its
 * model.json. Returns null for substrate-level dirs (no manifest).
 */
async function deriveModelName(dir: string): Promise<string | null> {
  try {
    const raw = await fs.readFile(path.join(dir, "model.json"), "utf-8");
    const m = JSON.parse(raw);
    return typeof m.name === "string" ? m.name : null;
  } catch {
    return null;
  }
}

function safeFilterExpressions(malloy: string): string[] {
  try {
    return extractFilters(malloy).map((f) => f.expression);
  } catch {
    return [];
  }
}

function impactDetail(impact?: NumericImpact | null): string | undefined {
  if (!impact) return undefined;
  const parts = [`rows ${impact.rowsBefore.toLocaleString()} → ${impact.rowsAfter.toLocaleString()}`];
  for (const agg of impact.aggregates) {
    parts.push(`${agg.column} ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (${agg.deltaPct >= 0 ? "+" : ""}${agg.deltaPct.toFixed(2)}%)`);
  }
  return parts.join("; ");
}

// ── ask + feasibility_refusal ────────────────────────────────────

/**
 * Capture the outcome of an ask() call as a trace, then return the result
 * unchanged. Decides the trace type from the result:
 *   - correctionDetected → no trace here (the correction flow traces it)
 *   - infeasible          → feasibility_refusal (a high-value trace)
 *   - otherwise (a query) → ask
 *
 * Wrapped so it can never throw — call as `return captureAskOutcome(dir, {...})`.
 */
export async function captureAskOutcome(modelsDir: string, result: AskResult): Promise<AskResult> {
  try {
    if (result.correctionDetected) return result; // handled by the correction flow

    const model_name = await deriveModelName(modelsDir);

    // Feasibility refusal — the engine declined to answer.
    if (result.feasibility && !result.feasibility.feasible) {
      const di = result.feasibility.dataIssues;
      const missing = result.feasibility.missingConcepts ?? [];
      await appendTrace(
        modelsDir,
        buildTrace({
          model_name,
          decision_type: "feasibility_refusal",
          observation: result.question,
          reasoning: result.feasibility.reasoning,
          action: {
            source: result.source?.filename ?? null,
            missing_concepts: missing,
            data_issues: di ?? null,
          },
          outcome: {
            status: "rejected",
            detail: missing.length ? `missing: ${missing.join(", ")}` : result.feasibility.reasoning,
          },
          links: [],
        }),
      );
      return result;
    }

    // A real query was generated (executed, or compiled in dry-run).
    if (result.query) {
      const malloy = result.query.malloy;
      const matchedTerms = (result.feasibility?.matchedTerms ?? []).map((t) => t.name);
      const semantic = result.verification?.semantic;
      const executed = !!result.execution;

      const detailParts: string[] = [];
      if (result.query.wasRetried) detailParts.push("query fixed after a failed first attempt");
      if (semantic) detailParts.push(`intent match: ${semantic.matchesIntent} (${semantic.confidence})`);
      if (semantic?.caveats?.length) detailParts.push(`caveats: ${semantic.caveats.join("; ")}`);

      await appendTrace(
        modelsDir,
        buildTrace({
          model_name,
          decision_type: "ask",
          observation: result.question,
          reasoning: [result.source?.reasoning, result.query.explanation].filter(Boolean).join(" | "),
          action: {
            source: result.source?.filename ?? null,
            source_name: result.source?.sourceName ?? null,
            malloy,
            filters: safeFilterExpressions(malloy),
            matched_terms: matchedTerms,
          },
          outcome: {
            status: executed ? "verified" : "pending",
            detail: detailParts.join("; ") || undefined,
            result_summary: executed
              ? { rows: result.execution!.totalRows, first_row: result.execution!.rows?.[0] ?? null }
              : undefined,
          },
          links: [],
        }),
      );
    }
  } catch (err) {
    logTraceError("captureAskOutcome", err);
  }
  return result;
}

// ── correction ───────────────────────────────────────────────────

function tokenRe(name: string): RegExp {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

/**
 * Does an ask trace reference the affected entity? Matching, in order:
 *  1. the entity is in the ask's matched_terms,
 *  2. the entity name appears as a token in the generated Malloy (measure /
 *     dimension / join / column reference) — the most general, robust signal,
 *  3. (term corrections) the old filter text appears in the Malloy or filters.
 */
function askReferencesEntity(t: Trace, entity: string | null, oldFilter?: string): boolean {
  const action = t.action ?? {};
  const malloy = typeof action.malloy === "string" ? action.malloy : "";

  if (entity) {
    const matched = Array.isArray(action.matched_terms) ? (action.matched_terms as unknown[]) : [];
    if (matched.includes(entity)) return true;
    if (tokenRe(entity).test(malloy)) return true;
  }
  if (oldFilter) {
    if (malloy.includes(oldFilter)) return true;
    const filters = Array.isArray(action.filters) ? (action.filters as unknown[]) : [];
    if (filters.some((f) => typeof f === "string" && (f.includes(oldFilter) || oldFilter.includes(f)))) {
      return true;
    }
  }
  return false;
}

/** Extract the declared entity name from a Malloy definition line (a find-line). */
function extractMalloyEntityName(line?: string): string | null {
  if (!line) return null;
  const m = line.match(/\b(?:measure|dimension|join_one|join_many|join_cross|view|source)\s*:\s+(\w+)/);
  return m ? m[1] : null;
}

/** Shared: ids of ask traces affected by a change to `entity` (and/or filter). */
function affectedAskIds(traces: Trace[], entity: string | null, oldFilter?: string): string[] {
  return traces
    .filter((t) => t.decision_type === "ask" && askReferencesEntity(t, entity, oldFilter))
    .map((t) => t.id);
}

function traceActionTerm(t: Trace): string | null {
  const term = (t.action ?? {}).term;
  return typeof term === "string" ? term : null;
}

/**
 * Capture a term-update correction. Links the correction to the ask trace(s)
 * it affects (those that used the term), and — if it reverses a prior
 * definition of the same term — links to that prior trace and marks its
 * outcome 'reversed'.
 */
export async function captureCorrectionTrace(opts: {
  modelsDir: string;
  correctionText: string;
  reasoning?: string;
  termName: string;
  oldFilter: string;
  newFilter: string;
  impact?: NumericImpact | null;
  correctionId: string;
}): Promise<void> {
  try {
    const { modelsDir, correctionText, termName, oldFilter, newFilter, impact, correctionId } = opts;
    const model_name = await deriveModelName(modelsDir);
    const all = await readTraces(modelsDir);

    // Asks this correction affects: those that used the term — by name in
    // matched_terms, by the term name as a token in the Malloy, or by filter text.
    const affected = affectedAskIds(all, termName, oldFilter);

    // The prior define/correction trace for this term (most recent) is reversed.
    const priors = all.filter(
      (t) => (t.decision_type === "term_define" || t.decision_type === "correction") && traceActionTerm(t) === termName,
    );
    const reversed = priors.length ? priors[priors.length - 1] : null;

    const links = [...affected];
    if (reversed) links.push(reversed.id);

    const trace = buildTrace({
      model_name,
      decision_type: "correction",
      observation: correctionText,
      reasoning: opts.reasoning ?? "User correction to a term filter.",
      action: {
        type: "term_update",
        term: termName,
        old_filter: oldFilter,
        new_filter: newFilter,
        correction_id: correctionId,
        impact: impact ?? null,
        affected_ask_ids: affected,
        reversed_trace_id: reversed?.id ?? null,
      },
      outcome: {
        status: "accepted",
        detail: impactDetail(impact),
        result_summary: impact ? { rows_before: impact.rowsBefore, rows_after: impact.rowsAfter } : undefined,
      },
      links,
    });
    await appendTrace(modelsDir, trace);

    if (reversed) {
      await updateOutcome(modelsDir, reversed.id, {
        ...reversed.outcome,
        status: "reversed",
        detail: `Reversed by correction "${correctionText.slice(0, 80)}" (${trace.id})`,
      });
    }
  } catch (err) {
    logTraceError("captureCorrectionTrace", err);
  }
}

/**
 * Capture a model_suggestion correction — a manual find/replace edit the user
 * must apply themselves (e.g. changing a measure definition). Outcome is
 * 'pending' because it has not been applied + verified yet. The key payoff:
 * it links to the ask trace(s) whose generated Malloy referenced the affected
 * entity (the measure/dimension/join named on the find-line).
 */
export async function captureModelSuggestionTrace(opts: {
  modelsDir: string;
  correctionText: string;
  reasoning?: string;
  targetFile: string;
  findLine: string;
  replaceLine: string;
  correctionId: string;
  compileOk?: boolean;
}): Promise<void> {
  try {
    const model_name = await deriveModelName(opts.modelsDir);
    const all = await readTraces(opts.modelsDir);

    // The affected entity is whatever the find-line declares (e.g. the
    // active_users measure). Link every ask whose Malloy referenced it.
    const entity = extractMalloyEntityName(opts.findLine);
    const affected = affectedAskIds(all, entity);

    await appendTrace(
      opts.modelsDir,
      buildTrace({
        model_name,
        decision_type: "correction",
        observation: opts.correctionText,
        reasoning: opts.reasoning ?? "User correction requiring a manual model edit.",
        action: {
          type: "model_suggestion",
          target_file: opts.targetFile,
          entity,
          find_line: opts.findLine,
          replace_line: opts.replaceLine,
          correction_id: opts.correctionId,
          compile_ok: opts.compileOk ?? null,
          affected_ask_ids: affected,
        },
        outcome: {
          status: "pending",
          detail:
            opts.compileOk === false
              ? "Suggested edit may not compile — apply the find/replace and run verify to confirm."
              : "Manual model edit suggested — apply the find/replace and run verify to confirm.",
        },
        links: affected,
      }),
    );
  } catch (err) {
    logTraceError("captureModelSuggestionTrace", err);
  }
}

// ── term_define ──────────────────────────────────────────────────

export async function captureTermDefineTrace(opts: {
  modelsDir: string;
  termKey: string;
  description: string;
  reasoning?: string;
  confidence?: string;
  filter: string;
  sourceName: string;
  via: "manual" | "auto-confirmed";
}): Promise<void> {
  try {
    const model_name = await deriveModelName(opts.modelsDir);
    await appendTrace(
      opts.modelsDir,
      buildTrace({
        model_name,
        decision_type: "term_define",
        observation: `${opts.termKey}: ${opts.description}`,
        reasoning: opts.reasoning ?? "Filter derived from matched enum values (auto-proposed).",
        action: {
          term: opts.termKey,
          filter: opts.filter,
          source: opts.sourceName,
          via: opts.via,
          confidence: opts.confidence ?? null,
        },
        outcome: {
          status: "accepted",
          detail: opts.confidence ? `confidence: ${opts.confidence}` : undefined,
        },
        links: [],
      }),
    );
  } catch (err) {
    logTraceError("captureTermDefineTrace", err);
  }
}

// ── model_design ─────────────────────────────────────────────────

export async function captureModelDesignTrace(opts: {
  modelDir: string;
  name: string;
  purpose: string;
  decisions: ResolvedDecision[];
  relevantTables: RelevantTable[];
  modelMalloy: string;
  counts: { measures: number; dimensions: number; named_filters: number; views: number };
  compileWarning?: string;
}): Promise<void> {
  try {
    const reasoningParts: string[] = [];
    if (opts.relevantTables?.length) {
      reasoningParts.push("Tables: " + opts.relevantTables.map((t) => `${t.name} (${t.reason})`).join("; "));
    }
    if (opts.decisions?.length) {
      reasoningParts.push("Decisions: " + opts.decisions.map((d) => `${d.decision_id}=${d.chosen}`).join("; "));
    }
    await appendTrace(
      opts.modelDir,
      buildTrace({
        model_name: opts.name,
        decision_type: "model_design",
        observation: opts.purpose,
        reasoning: reasoningParts.join(" | ") || "Model designed from substrate.",
        action: {
          decisions: opts.decisions,
          relevant_tables: opts.relevantTables,
          counts: opts.counts,
          model_malloy: opts.modelMalloy,
        },
        outcome: { status: "accepted", detail: opts.compileWarning },
        links: [],
      }),
    );
  } catch (err) {
    logTraceError("captureModelDesignTrace", err);
  }
}

// ── model_refine ─────────────────────────────────────────────────

export async function captureModelRefineTrace(opts: {
  modelDir: string;
  modelName: string;
  refinement: string;
  reasoning?: string;
  changeType?: string;
  target?: string;
  oldMalloy?: string;
  newMalloy: string;
}): Promise<void> {
  try {
    let changed: { type: string; action: string; name: string }[] = [];
    if (opts.oldMalloy) {
      changed = computeModelDiff(opts.oldMalloy, opts.newMalloy).entries.map((e) => ({
        type: e.type,
        action: e.action,
        name: e.name,
      }));
    }
    await appendTrace(
      opts.modelDir,
      buildTrace({
        model_name: opts.modelName,
        decision_type: "model_refine",
        observation: opts.refinement,
        reasoning: opts.reasoning ?? `${opts.changeType ?? "refine"} — ${opts.target ?? ""}`.trim(),
        action: {
          change_type: opts.changeType ?? null,
          target: opts.target ?? null,
          changed,
          model_malloy: opts.newMalloy,
        },
        outcome: { status: "accepted" },
        links: [],
      }),
    );
  } catch (err) {
    logTraceError("captureModelRefineTrace", err);
  }
}
