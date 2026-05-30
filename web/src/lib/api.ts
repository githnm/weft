// Client for the Weft local API (Fastify on :4000; Vite proxies /api in dev).

import type { Row } from "@/components/results-table";

export interface ModelInfo {
  name: string;
  purpose: string;
  tableCount: number;
  measureCount: number;
  connector: string | null;
}

export interface AskResult {
  question: string;
  refusal: boolean;
  missingConcepts?: string[];
  refusalReason?: string;
  dataIssues?: {
    unknownFilterValue?: { userTerm: string; column: string; knownValues: string[] };
    timeOutOfRange?: { requested: string; available: string };
    staleData?: { latest: string; daysOld: number };
  };
  source: { name: string | null; filename: string | null; reasoning: string | null };
  columns: string[];
  rows: Row[];
  malloy: string | null;
  explanation: string | null;
  verification: {
    intentMatch: "yes" | "partial" | "no" | null;
    confidence: "high" | "medium" | "low" | null;
    reasoning: string | null;
    caveats: string[];
  } | null;
  meta: {
    rowCount: number;
    bytesScanned: number | null;
    bytesLabel: string | null;
    llmCost: number;
    bqCost: number;
    cost: string;
  };
}

export interface StageEvent {
  stage: "source_selected" | "feasibility" | "generating" | "executing" | "verifying";
  detail?: Record<string, unknown>;
}

export interface CorrectResult {
  type: "term_update" | "model_suggestion" | "new_term" | "unclear" | string;
  reasoning?: string;
  termName?: string;
  oldFilter?: string;
  newFilter?: string;
  correctionId?: string;
  targetFile?: string;
  findLine?: string;
  replaceLine?: string;
  compileOk?: boolean;
  name?: string | null;
  impact?: {
    mode?: string;
    rowsBefore?: number;
    rowsAfter?: number;
    rowsDeltaPct?: number;
    aggregates?: { column: string; before: number; after: number; deltaPct: number }[];
  } | null;
}

export async function fetchModels(): Promise<ModelInfo[]> {
  const r = await fetch("/api/models");
  if (!r.ok) throw new Error(`Failed to load models (${r.status})`);
  return r.json();
}

export interface Health {
  ok: boolean;
  connector: string | null;
  modelsDir: string;
  substrateDir: string;
  hasSubstrate: boolean;
}

export async function fetchHealth(): Promise<Health> {
  const r = await fetch("/api/health");
  if (!r.ok) throw new Error(`Health check failed (${r.status})`);
  return r.json();
}

export async function correct(correctionText: string, modelName: string): Promise<CorrectResult> {
  const r = await fetch("/api/correct", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ correction_text: correctionText, model_name: modelName }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Correction failed (${r.status})`);
  return data;
}

interface AskHandlers {
  onStage: (e: StageEvent) => void;
  onDone: (r: AskResult) => void;
  onError: (message: string) => void;
}

// POST + SSE: EventSource only does GET, so we read the streamed body and
// parse `event:` / `data:` frames manually.
export async function askStream(
  body: { question: string; model_name?: string },
  handlers: AskHandlers,
): Promise<void> {
  let resp: Response;
  try {
    resp = await fetch("/api/ask", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err) {
    handlers.onError(err instanceof Error ? err.message : "Network error");
    return;
  }
  if (!resp.ok || !resp.body) {
    handlers.onError(`Request failed (${resp.status})`);
    return;
  }

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  const handleFrame = (frame: string) => {
    let event = "message";
    let data = "";
    for (const line of frame.split("\n")) {
      if (line.startsWith("event:")) event = line.slice(6).trim();
      else if (line.startsWith("data:")) data += line.slice(5).trim();
    }
    if (!data) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    if (event === "stage") handlers.onStage(parsed as StageEvent);
    else if (event === "done") handlers.onDone(parsed as AskResult);
    else if (event === "error") handlers.onError((parsed as { error?: string }).error ?? "Error");
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const frame = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      handleFrame(frame);
    }
  }
  if (buffer.trim()) handleFrame(buffer);
}

// ── Model detail (view mode) ─────────────────────────────────────

export interface ModelDetail {
  name: string;
  purpose: string;
  connector: string | null;
  measures: { name: string; expr: string }[];
  dimensions: { name: string; expr: string }[];
  views: string[];
  malloy: string;
  decisions: { decision_id: string; chosen: string }[];
}

export async function fetchModelDetail(name: string): Promise<ModelDetail> {
  const r = await fetch(`/api/models/${encodeURIComponent(name)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Failed to load model (${r.status})`);
  return data;
}

// ── Design: plan ─────────────────────────────────────────────────

export interface DecisionOption {
  label: string;
  description: string;
  recommended: boolean;
}

export interface PlanDecision {
  id: string;
  question: string;
  explanation: string;
  allowCustom: boolean;
  options: DecisionOption[];
}

export interface DesignPlan {
  name: string;
  purpose: string;
  substrateDir: string;
  relevantTables: { name: string; reason: string }[];
  excludedCount: number;
  tableSelectionReasoning: string;
  decisions: PlanDecision[];
}

export async function designPlan(body: {
  name: string;
  purpose: string;
  tables?: string[];
  substrate_dir?: string;
}): Promise<DesignPlan> {
  const r = await fetch("/api/models/design/plan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Plan failed (${r.status})`);
  return data;
}

// ── Design: build ────────────────────────────────────────────────

export interface ClarifyQuestion {
  id: string;
  question: string;
  options: string[];
  grounded_in: string;
}

export interface BuildOutcome {
  success: boolean;
  incomplete: boolean;
  modelName: string;
  modelDir: string | null;
  measuresCount: number;
  dimensionsCount: number;
  viewsCount: number;
  failedItems: { name: string; kind: string; error: string }[];
  unmetDecisions: { decision_id: string; chosen: string; expectation: string }[];
  dataWarnings: { measure: string; status: string; detail: string }[];
  clarificationsNeeded: ClarifyQuestion[];
  compileWarning: string | null;
  modelMalloy: string | null;
  error: string | null;
}

export async function designBuild(body: {
  name: string;
  purpose: string;
  resolved_decisions: { decision_id: string; chosen: string }[];
  relevant_tables: { name: string; reason: string }[];
  substrate_dir?: string;
  clarifications?: { question: string; answer: string }[];
}): Promise<BuildOutcome> {
  const r = await fetch("/api/models/design/build", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Build failed (${r.status})`);
  return data;
}

// ── Context: decision traces ─────────────────────────────────────

export interface Trace {
  id: string;
  timestamp: string;
  model_name: string | null;
  decision_type: string;
  observation: string;
  reasoning: string;
  action: Record<string, unknown>;
  outcome: { status: string; detail?: string; result_summary?: Record<string, unknown> };
  links: string[];
}

export async function fetchTraces(model: string): Promise<Trace[]> {
  const r = await fetch(`/api/context/${encodeURIComponent(model)}/traces`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Failed to load traces (${r.status})`);
  return data;
}

// ── Context: what-if ─────────────────────────────────────────────

export interface AnswerDelta {
  question: string;
  traceId: string;
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
  feasible: boolean;
  changedEntities: { type: string; action: string; name: string }[];
  affectedCount: number;
  deltas: AnswerDelta[];
  unanswerable: { question: string; reason: string }[];
  summary: string;
  netSummary?: string;
  suggestion?: string;
  error?: string;
}

export async function runWhatIf(model: string, changeText: string): Promise<WhatIfReport> {
  const r = await fetch(`/api/context/${encodeURIComponent(model)}/whatif`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ change_text: changeText }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Simulation failed (${r.status})`);
  return data;
}
