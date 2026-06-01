/**
 * Entity-centric context graph — a reorganization of the existing decision
 * traces around the semantic objects the OWNER reasons about (measures,
 * definitions, questions, gaps), NOT the engine's internal decision types.
 *
 * Pure aggregation over what's already logged:
 *  - `ask` traces      → Questions, clustered under the measures/definitions
 *                        their generated Malloy / matched terms referenced.
 *  - `correction` /
 *    `model_refine` /
 *    `term_define`      → Changes, attached to the entity they changed and the
 *                        questions they affected.
 *  - `feasibility_refusal` → Gaps, grouped by the concept that was missing.
 *
 * No new capture — the traces already record measure/source/Malloy per question
 * and which definitions corrections changed.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { showModel } from "../models/registry.js";
import { parseModelItems } from "../interview/compile.js";
import { readTraces, type Trace } from "../context/trace.js";

// ── Output shapes ────────────────────────────────────────────────

export type EntityKind = "measure" | "dimension" | "definition" | "view";

export interface GraphEntity {
  id: string;
  kind: EntityKind;
  name: string;
  expr: string | null;
  aliases: string[];
  /** Questions clustered under this entity (their primary entity). */
  questionIds: string[];
  /** Total questions that referenced it (== questionIds.length here). */
  usageCount: number;
  /** Change ids (corrections / refines / defines) that touched this entity. */
  changeIds: string[];
}

export interface GraphQuestion {
  id: string;
  text: string;
  status: string;
  timestamp: string;
  /** All entities this question referenced. */
  usedEntityIds: string[];
  /** The entity it's clustered under (first referenced; definitions win). */
  primaryEntityId: string | null;
}

export interface GraphChange {
  id: string;
  kind: "definition_change" | "field_change" | "term_define" | "refine";
  label: string;
  detail: string | null;
  targetEntityId: string | null;
  affectedQuestionIds: string[];
  timestamp: string;
}

export interface GraphGap {
  id: string;
  text: string;
  missing: string[];
  timestamp: string;
}

export interface GraphGapConcept {
  concept: string;
  /** Gap (refusal) ids that were missing this concept. */
  gapIds: string[];
}

export interface EntityGraph {
  model: string;
  entities: GraphEntity[];
  questions: GraphQuestion[];
  changes: GraphChange[];
  gaps: GraphGap[];
  gapConcepts: GraphGapConcept[];
  /** Questions that referenced no known entity (clustered under the model). */
  unclusteredQuestionIds: string[];
  stats: { questions: number; entities: number; gaps: number; changes: number };
}

// ── Helpers ──────────────────────────────────────────────────────

function tokenRe(name: string): RegExp {
  return new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`);
}

interface Matcher {
  entity: GraphEntity;
  /** Names to token-match in a question's Malloy. */
  tokens: string[];
  /** Names to match against a question's matched_terms (definitions). */
  termTokens: string[];
}

/** Does this ask trace reference the entity (by Malloy token or matched term)? */
function askUses(m: Matcher, malloy: string, matchedTerms: string[]): boolean {
  if (m.termTokens.some((t) => matchedTerms.includes(t))) return true;
  return m.tokens.some((t) => tokenRe(t).test(malloy));
}

function actionStr(t: Trace, key: string): string | null {
  const v = (t.action ?? {})[key];
  return typeof v === "string" ? v : null;
}
function actionArr(t: Trace, key: string): string[] {
  const v = (t.action ?? {})[key];
  return Array.isArray(v) ? (v as unknown[]).map(String) : [];
}

function truncateText(s: string, n: number): string {
  return s && s.length > n ? s.slice(0, n - 1) + "…" : s || "";
}

// ── Build ────────────────────────────────────────────────────────

export async function buildEntityGraph(opts: {
  semanticModelsDir: string;
  modelName: string;
}): Promise<EntityGraph> {
  const detail = await showModel(opts.semanticModelsDir, opts.modelName);
  const modelDir = detail.dir;
  const malloy = await fs.readFile(path.join(modelDir, "model.malloy"), "utf-8").catch(() => "");
  const items = parseModelItems(malloy);
  const concepts = detail.manifest.concepts ?? [];
  const conceptFields = new Set(concepts.map((c) => c.field));

  // ── Entity nodes (definitions first so they win as a question's cluster) ──
  const entities: GraphEntity[] = [];
  const matchers: Matcher[] = [];
  const byKey = new Map<string, GraphEntity>(); // lower(name/field/alias) → entity

  const register = (entity: GraphEntity, matchTokens: string[], termTokens: string[], keys: string[]) => {
    entities.push(entity);
    matchers.push({ entity, tokens: matchTokens, termTokens });
    for (const k of keys) byKey.set(k.toLowerCase(), entity);
  };

  for (const c of concepts) {
    const e: GraphEntity = {
      id: `def:${c.canonical_name}`, kind: "definition", name: c.canonical_name,
      expr: c.filter ?? null, aliases: c.aliases ?? [], questionIds: [], usageCount: 0, changeIds: [],
    };
    register(e, [c.field, c.canonical_name], [c.canonical_name, ...(c.aliases ?? [])], [c.canonical_name, c.field, ...(c.aliases ?? [])]);
  }
  for (const it of items) {
    if (it.kind === "measure") {
      const e: GraphEntity = { id: `measure:${it.name}`, kind: "measure", name: it.name, expr: it.expr, aliases: [], questionIds: [], usageCount: 0, changeIds: [] };
      register(e, [it.name], [], [it.name]);
    } else if (it.kind === "dimension" && !conceptFields.has(it.name)) {
      const e: GraphEntity = { id: `dimension:${it.name}`, kind: "dimension", name: it.name, expr: it.expr, aliases: [], questionIds: [], usageCount: 0, changeIds: [] };
      register(e, [it.name], [], [it.name]);
    }
  }
  // Views are building blocks too — a question that runs a view clusters here.
  for (const m of malloy.matchAll(/^\s*view:\s+(\w+)\s+is\s+\{/gm)) {
    const name = m[1];
    const e: GraphEntity = { id: `view:${name}`, kind: "view", name, expr: null, aliases: [], questionIds: [], usageCount: 0, changeIds: [] };
    register(e, [name], [], [name]);
  }

  const traces = await readTraces(modelDir);

  // ── Questions (ask traces) clustered under the entities they used ──
  const questions: GraphQuestion[] = [];
  const unclusteredQuestionIds: string[] = [];
  for (const t of traces) {
    if (t.decision_type !== "ask") continue;
    const malloyText = actionStr(t, "malloy") ?? "";
    const matchedTerms = actionArr(t, "matched_terms");
    const used: GraphEntity[] = [];
    for (const m of matchers) {
      if (askUses(m, malloyText, matchedTerms)) used.push(m.entity);
    }
    const primary = used[0] ?? null; // matchers are definition-first → definitions win
    const q: GraphQuestion = {
      id: t.id,
      text: t.observation,
      status: t.outcome?.status ?? "pending",
      timestamp: t.timestamp,
      usedEntityIds: used.map((e) => e.id),
      primaryEntityId: primary?.id ?? null,
    };
    questions.push(q);
    if (primary) {
      primary.questionIds.push(t.id);
      primary.usageCount++;
    } else {
      unclusteredQuestionIds.push(t.id);
    }
  }

  // ── Changes (corrections / term_define / model_refine) ──
  const changes: GraphChange[] = [];
  const askMalloyById = new Map<string, string>();
  for (const t of traces) if (t.decision_type === "ask") askMalloyById.set(t.id, actionStr(t, "malloy") ?? "");
  const allAskIds = questions.map((q) => q.id);

  /** Asks that reference `name` in their Malloy — fallback when no affected_ask_ids. */
  const asksReferencing = (name: string | null): string[] => {
    if (!name) return [];
    const re = tokenRe(name);
    return allAskIds.filter((id) => re.test(askMalloyById.get(id) ?? ""));
  };

  for (const t of traces) {
    const dt = t.decision_type;
    if (dt !== "correction" && dt !== "term_define" && dt !== "model_refine") continue;

    let kind: GraphChange["kind"];
    let detail: string | null = t.outcome?.detail ?? null;
    let affected = actionArr(t, "affected_ask_ids");
    // Real entity names this change touched (NOT the free-text `target`).
    const targetNames: string[] = [];

    if (dt === "term_define") {
      kind = "term_define";
      const term = actionStr(t, "term");
      if (term) targetNames.push(term);
      const filter = actionStr(t, "filter");
      if (filter) detail = filter;
    } else if (dt === "correction") {
      const type = actionStr(t, "type");
      if (type === "term_update") {
        kind = "definition_change";
        const term = actionStr(t, "term");
        if (term) targetNames.push(term);
        const oldF = actionStr(t, "old_filter");
        const newF = actionStr(t, "new_filter");
        if (oldF || newF) detail = `${oldF ?? "∅"} → ${newF ?? "∅"}`;
      } else {
        kind = "field_change";
        const ent = actionStr(t, "entity");
        if (ent) targetNames.push(ent);
        const find = actionStr(t, "find_line");
        const repl = actionStr(t, "replace_line");
        if (find || repl) detail = `${find ?? ""} → ${repl ?? ""}`.trim();
      }
    } else {
      kind = "refine";
      const changedArr = (t.action?.changed as { type: string; action: string; name: string }[] | undefined) ?? [];
      for (const c of changedArr) if (c?.name) targetNames.push(c.name);
      detail = changedArr.length
        ? changedArr.map((c) => `${c.action} ${c.type} ${c.name}`).join(", ")
        : (actionStr(t, "change_type") ?? "refine");
    }

    // Map names → entities (a refine can touch several: e.g. a measure + the
    // definition it baked). The change is attached to ALL of them.
    const matched: GraphEntity[] = [];
    for (const n of targetNames) {
      const e = byKey.get(n.toLowerCase());
      if (e && !matched.includes(e)) matched.push(e);
    }

    // Affected questions: explicit ids, else asks referencing any touched name.
    if (affected.length === 0) {
      const set = new Set<string>();
      for (const n of targetNames) for (const id of asksReferencing(n)) set.add(id);
      affected = [...set];
    }
    affected = affected.filter((id) => allAskIds.includes(id));

    // Label = the user's own words (the request/correction text).
    const label = truncateText(t.observation, 100) || (kind === "refine" ? "Refined the model" : "Change");

    const change: GraphChange = {
      id: t.id,
      kind,
      label,
      detail,
      targetEntityId: matched[0]?.id ?? null,
      affectedQuestionIds: affected,
      timestamp: t.timestamp,
    };
    changes.push(change);
    for (const e of matched) e.changeIds.push(t.id);
  }

  // ── Gaps (refusals) grouped by the missing concept ──
  const gaps: GraphGap[] = [];
  const gapConceptMap = new Map<string, string[]>();
  for (const t of traces) {
    if (t.decision_type !== "feasibility_refusal") continue;
    const missing = actionArr(t, "missing_concepts");
    gaps.push({ id: t.id, text: t.observation, missing, timestamp: t.timestamp });
    const keys = missing.length ? missing : ["(unspecified)"];
    for (const c of keys) {
      const arr = gapConceptMap.get(c) ?? [];
      arr.push(t.id);
      gapConceptMap.set(c, arr);
    }
  }
  const gapConcepts: GraphGapConcept[] = [...gapConceptMap.entries()]
    .map(([concept, gapIds]) => ({ concept, gapIds }))
    .sort((a, b) => b.gapIds.length - a.gapIds.length);

  // Most-used entities first; keep only entities that exist (all do).
  entities.sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name));

  return {
    model: detail.name,
    entities,
    questions,
    changes,
    gaps,
    gapConcepts,
    unclusteredQuestionIds,
    stats: { questions: questions.length, entities: entities.length, gaps: gaps.length, changes: changes.length },
  };
}
