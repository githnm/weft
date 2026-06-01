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

// ── Connections (credentials stored locally on the server; metadata only here) ──

export type ConnectorType = "postgres" | "bigquery" | "duckdb" | "mysql" | "snowflake";

export interface ConnectionMeta {
  id: string;
  name: string;
  type: ConnectorType;
  masked: string;
  active: boolean;
  created_at: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslmode?: string;
  ssl?: boolean;
  project_id?: string;
  location?: string;
  data_project?: string;
  dataset?: string;
  key_file_path?: string;
  // duckdb
  file_path?: string;
  // snowflake
  account?: string;
  username?: string;
  warehouse?: string;
  schema?: string;
  role?: string;
  auth?: "password" | "key-pair";
  /** This connection's own substrate directory (per-connection introspection). */
  substrateDir?: string;
  /** Whether this connection has been introspected (its substrate exists). */
  hasSubstrate?: boolean;
}

export interface PostgresDraft {
  type: "postgres";
  name: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  sslmode?: string;
}

export interface BigQueryDraft {
  type: "bigquery";
  name: string;
  /** Billing/compute project. */
  project_id: string;
  location?: string;
  /** Data project (where the dataset lives). Defaults to project_id. */
  data_project?: string;
  /** Dataset to introspect. */
  dataset?: string;
  key_file_path?: string;
}

export interface DuckDBDraft {
  type: "duckdb";
  name: string;
  file_path: string;
}

export interface MySQLDraft {
  type: "mysql";
  name: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface SnowflakeDraft {
  type: "snowflake";
  name: string;
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema?: string;
  role?: string;
  password?: string;
  private_key_path?: string;
  private_key_passphrase?: string;
}

export type ConnectionDraft = PostgresDraft | BigQueryDraft | DuckDBDraft | MySQLDraft | SnowflakeDraft;

export interface TestResult {
  ok: boolean;
  error?: string;
}

export async function fetchConnections(): Promise<{ activeId: string | null; connections: ConnectionMeta[] }> {
  const r = await fetch("/api/connections");
  if (!r.ok) throw new Error(`Failed to load connections (${r.status})`);
  return r.json();
}

// Add a connection. The password is sent once over localhost to be stored on
// the user's machine; the response is metadata only — it never comes back.
export async function createConnection(draft: ConnectionDraft): Promise<ConnectionMeta> {
  const r = await fetch("/api/connections", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Could not save connection (${r.status})`);
  return data;
}

// Test an unsaved draft (the form's "Test connection" before saving).
export async function testConnectionDraft(draft: ConnectionDraft): Promise<TestResult> {
  const r = await fetch("/api/connections/test", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(draft),
  });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: data?.error ?? `Test failed (${r.status})` };
  return data;
}

// Test a saved connection (the card's "Test").
export async function testSavedConnection(id: string): Promise<TestResult> {
  const r = await fetch(`/api/connections/${encodeURIComponent(id)}/test`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) return { ok: false, error: data?.error ?? `Test failed (${r.status})` };
  return data;
}

export interface IntrospectResult {
  substrateDir: string;
  datasetProject: string;
  datasetName: string;
  billingProject: string;
  tableCount: number;
  skippedCount: number;
  bytesScanned: number;
  warnings: string[];
}

export type IntrospectStage =
  | "connecting"
  | "listing_tables"
  | "reading_columns"
  | "sampling"
  | "writing"
  | "done";

export interface IntrospectJobStatus {
  id: string;
  connectionId: string;
  status: "running" | "done" | "error";
  stage: IntrospectStage | string;
  message: string;
  tablesTotal: number | null;
  tablesDone: number | null;
  result: IntrospectResult | null;
  error: string | null;
}

/** Start a background introspection job. Returns immediately with a job id. */
export async function startIntrospection(id: string): Promise<{ jobId: string }> {
  const r = await fetch(`/api/connections/${encodeURIComponent(id)}/introspect`, { method: "POST" });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Could not start introspection (${r.status})`);
  return data;
}

/** Poll a job's progress. */
export async function getIntrospectStatus(jobId: string): Promise<IntrospectJobStatus> {
  const r = await fetch(`/api/introspect/${encodeURIComponent(jobId)}/status`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Could not read job status (${r.status})`);
  return data;
}

/**
 * Start an introspection job and poll it to completion, reporting each progress
 * tick via onProgress. Resolves with the final (done) status, rejects on error.
 * Pass a `signal` to stop polling (e.g. on unmount) without rejecting.
 */
export async function runIntrospection(
  id: string,
  onProgress: (s: IntrospectJobStatus) => void,
  signal?: { cancelled: boolean },
): Promise<IntrospectJobStatus> {
  const { jobId } = await startIntrospection(id);
  return new Promise<IntrospectJobStatus>((resolve, reject) => {
    const tick = async () => {
      if (signal?.cancelled) return;
      try {
        const s = await getIntrospectStatus(jobId);
        if (signal?.cancelled) return;
        onProgress(s);
        if (s.status === "done") return resolve(s);
        if (s.status === "error") return reject(new Error(s.error || "Introspection failed"));
        setTimeout(tick, 1000);
      } catch (e) {
        reject(e);
      }
    };
    tick();
  });
}

export async function activateConnection(id: string): Promise<void> {
  const r = await fetch(`/api/connections/${encodeURIComponent(id)}/activate`, { method: "POST" });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data?.error ?? `Could not activate (${r.status})`);
  }
}

export async function removeConnection(id: string): Promise<void> {
  const r = await fetch(`/api/connections/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!r.ok) {
    const data = await r.json().catch(() => ({}));
    throw new Error(data?.error ?? `Could not delete (${r.status})`);
  }
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

export interface ModelSource {
  name: string;
  rowCount: number;
  columns: { name: string; type: string; jsonKeys: number }[];
}

export interface ModelConcept {
  canonical_name: string;
  aliases: string[];
  field: string;
  kind: "dimension" | "measure";
  filter: string | null;
}

export interface ModelDetail {
  name: string;
  purpose: string;
  connector: string | null;
  /** The datasource (connection) this model was built from, if recorded. */
  datasource: string | null;
  measures: { name: string; expr: string }[];
  dimensions: { name: string; expr: string }[];
  views: string[];
  malloy: string;
  decisions: { decision_id: string; chosen: string }[];
  concepts: ModelConcept[];
  sources: ModelSource[];
}

export async function fetchModelDetail(name: string): Promise<ModelDetail> {
  const r = await fetch(`/api/models/${encodeURIComponent(name)}`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Failed to load model (${r.status})`);
  return data;
}

// Hard delete — destructive and irreversible. The server enforces path safety
// and refuses anything that isn't a model directly inside semantic-models.
export async function deleteModel(name: string): Promise<{ deleted: string }> {
  const r = await fetch(`/api/models/${encodeURIComponent(name)}`, { method: "DELETE" });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Delete failed (${r.status})`);
  return data;
}

// ── One conversational surface: propose → confirm → apply ────────
// The editor sends ONE plain-language string; the server routes + previews it.

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

export interface ChangeProposal {
  feasible: boolean;
  noChange: boolean;
  /** Underspecified-but-groundable: ask `clarificationQuestion`, then re-propose. */
  needsClarification?: boolean;
  clarificationQuestion?: string | null;
  isDefinition: boolean;
  /** Machine route ("definition" | "measure" | "view" | "correction" | "change" | "no_change" | "error"). */
  route: string;
  /** Human label for the routed action. */
  routeLabel: string;
  conceptField: string | null;
  conceptName: string | null;
  changeType: string | null;
  target: string | null;
  reasoning: string | null;
  addedItems: DiffAdded[];
  changedItems: DiffChanged[];
  removedItems: { kind: string; name: string }[];
  diffSummary?: string | null;
  compileWarning?: string | null;
  oldMalloy: string | null;
  newMalloy: string | null;
  /** Opaque classification, round-tripped back to /apply unchanged. */
  classification: unknown;
  error: string | null;
  draftMalloy?: string | null;
}

export async function proposeChange(model: string, text: string): Promise<ChangeProposal> {
  const r = await fetch(`/api/models/${encodeURIComponent(model)}/propose`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Could not propose change (${r.status})`);
  return data;
}

export async function applyChange(
  model: string,
  body: {
    text: string;
    new_malloy: string;
    classification: unknown;
    is_definition?: boolean;
    canonical_name?: string;
    aliases?: string[];
  },
): Promise<{ applied: boolean; concept: ModelConcept | null }> {
  const r = await fetch(`/api/models/${encodeURIComponent(model)}/apply`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Apply failed (${r.status})`);
  return data;
}

// ── Conversational model-building agent ──────────────────────────
// READ tools run freely; the WRITE tool returns a `pending` proposal the user
// must Confirm/Reject. `messages` is opaque conversation state — echo it back.

export interface AgentEvent {
  kind: "text" | "tool";
  text?: string;
  tool?: string;
  detail?: string;
}

export interface AgentPending {
  toolUseId: string;
  description: string;
  isDefinition: boolean;
  canonicalName: string | null;
  aliases: string[];
  route: string;
  routeLabel: string;
  reasoning: string | null;
  addedItems: DiffAdded[];
  changedItems: DiffChanged[];
  removedItems: { kind: string; name: string }[];
  conceptField: string | null;
  conceptName: string | null;
  newMalloy: string;
  classification: unknown;
}

export interface AgentResponse {
  messages: unknown[];
  events: AgentEvent[];
  pending: AgentPending | null;
  applied?: boolean;
}

export async function agentTurn(model: string, messages: unknown[], userText: string): Promise<AgentResponse> {
  const r = await fetch(`/api/models/${encodeURIComponent(model)}/agent`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, userText }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Agent failed (${r.status})`);
  return data;
}

export async function agentConfirm(
  model: string,
  messages: unknown[],
  toolUseId: string,
  decision: "confirm" | "reject",
  apply?: AgentPending,
): Promise<AgentResponse> {
  const r = await fetch(`/api/models/${encodeURIComponent(model)}/agent/confirm`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages, toolUseId, decision, apply }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Confirm failed (${r.status})`);
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

export interface PlanTable {
  name: string;
  rowCount: number;
  columnCount: number;
  proposed: boolean;
  reason: string;
}

export interface DesignPlan {
  name: string;
  purpose: string;
  substrateDir: string;
  relevantTables: { name: string; reason: string }[];
  excludedCount: number;
  /** Every table in the substrate, flagged proposed/not, with metadata. */
  allTables: PlanTable[];
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

// ── Design: decisions (generated from the finalized table set) ───

export async function designDecisions(body: {
  purpose: string;
  substrate_dir?: string;
  tables: string[];
}): Promise<PlanDecision[]> {
  const r = await fetch("/api/models/design/decisions", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Decisions failed (${r.status})`);
  return data.decisions as PlanDecision[];
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
  definitions?: string[];
  substrate_dir?: string;
  clarifications?: { question: string; answer: string }[];
  datasource?: string;
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

// ── Refine / add a definition (baked into model.malloy) ──────────

export interface RefineOutcome {
  applied: boolean;
  noChange?: boolean;
  changeType: string | null;
  target: string | null;
  reason?: string | null;
  diffSummary?: string | null;
  compileWarning?: string | null;
  modelMalloy?: string | null;
  draftMalloy?: string | null;
  error?: string | null;
}

export async function refineModelChange(model: string, change: string): Promise<RefineOutcome> {
  const r = await fetch(`/api/models/${encodeURIComponent(model)}/refine`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ change }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Refine failed (${r.status})`);
  return data;
}

// ── Definitions with explicit aliases (concept baked into the model) ──

export interface Concept {
  canonical_name: string;
  aliases: string[];
  field: string;
  kind: "dimension" | "measure";
  filter?: string;
}

export interface DefinitionOutcome {
  applied: boolean;
  noChange?: boolean;
  concept: Concept | null;
  changeType: string | null;
  target: string | null;
  diffSummary: string | null;
  compileWarning: string | null;
  modelMalloy: string | null;
  reason: string | null;
  error: string | null;
}

export async function addDefinition(
  model: string,
  definition: string,
  aliases: string[],
  canonicalName?: string,
): Promise<DefinitionOutcome> {
  const r = await fetch(`/api/models/${encodeURIComponent(model)}/definition`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ definition, aliases, canonical_name: canonicalName }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Definition failed (${r.status})`);
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

// ── Context: entity-centric graph (reorganized traces) ───────────

export type EntityKind = "measure" | "dimension" | "definition" | "view";

export interface GraphEntity {
  id: string;
  kind: EntityKind;
  name: string;
  expr: string | null;
  aliases: string[];
  questionIds: string[];
  usageCount: number;
  changeIds: string[];
}
export interface GraphQuestion {
  id: string;
  text: string;
  status: string;
  timestamp: string;
  usedEntityIds: string[];
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
  gapIds: string[];
}
export interface EntityGraph {
  model: string;
  entities: GraphEntity[];
  questions: GraphQuestion[];
  changes: GraphChange[];
  gaps: GraphGap[];
  gapConcepts: GraphGapConcept[];
  unclusteredQuestionIds: string[];
  stats: { questions: number; entities: number; gaps: number; changes: number };
}

export async function fetchContextGraph(model: string): Promise<EntityGraph> {
  const r = await fetch(`/api/context/${encodeURIComponent(model)}/graph`);
  const data = await r.json();
  if (!r.ok) throw new Error(data?.error ?? `Failed to load context graph (${r.status})`);
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
