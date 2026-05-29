/**
 * Append-only decision-trace store — the engine's "event clock".
 *
 * Every decision the engine makes is captured as a Trace: the observation
 * (the input), the reasoning (WHY), the action (what was done), and the
 * outcome (what happened — which may only become known later). Traces append;
 * the ONLY mutation is updateOutcome, and only forward (pending → known).
 *
 * This is deliberately distinct from the engine's STATE (terms.json,
 * model.malloy). State is the current world; traces are the history of how it
 * got there and whether each decision worked out.
 *
 * Backed by JSONL (one trace per line) colocated with the model/substrate dir
 * the decision pertains to: <dir>/traces.jsonl. No external dependency,
 * naturally append-only, trivially greppable. (No graph DB, no embeddings in
 * v1 — add structure later only if needed.)
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomBytes } from "node:crypto";

// ── Schema ──────────────────────────────────────────────────────

export type DecisionType =
  | "ask"
  | "term_define"
  | "correction"
  | "model_design"
  | "model_refine"
  | "feasibility_refusal";

export type OutcomeStatus =
  | "pending"
  | "verified"
  | "accepted"
  | "rejected"
  | "reversed"
  | "failed";

export interface TraceOutcome {
  status: OutcomeStatus;
  /** Verification result, error, or user response */
  detail?: string;
  /** Row count, key values, etc. for ask/correction */
  result_summary?: Record<string, unknown>;
}

export interface Trace {
  /** ULID — time-sortable unique id */
  id: string;
  /** ISO 8601 */
  timestamp: string;
  /** Which semantic model this pertains to, if any */
  model_name: string | null;
  decision_type: DecisionType;
  /** The input: question, correction text, purpose */
  observation: string;
  /** WHY the engine chose what it did (produced by the LLM in each flow) */
  reasoning: string;
  /** What was done: generated Malloy, term filter, model decisions, the diff */
  action: Record<string, unknown>;
  outcome: TraceOutcome;
  /** ids of related traces (e.g. a correction → the asks it affects) */
  links: string[];
}

// ── ULID (dependency-free, time-sortable) ────────────────────────

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ"; // Crockford base32

function encodeTime(ms: number, len: number): string {
  let out = "";
  let n = ms;
  for (let i = len - 1; i >= 0; i--) {
    const mod = n % 32;
    out = CROCKFORD[mod] + out;
    n = (n - mod) / 32;
  }
  return out;
}

function encodeRandom(len: number): string {
  const bytes = randomBytes(len);
  let out = "";
  for (let i = 0; i < len; i++) out += CROCKFORD[bytes[i] % 32];
  return out;
}

/**
 * Generate a ULID: 10 chars of millisecond timestamp + 16 chars of
 * randomness. Lexicographically sortable by creation time.
 */
export function ulid(now: number = Date.now()): string {
  return encodeTime(now, 10) + encodeRandom(16);
}

// ── Store I/O ────────────────────────────────────────────────────

const TRACE_FILE = "traces.jsonl";

function tracePath(dir: string): string {
  return path.join(dir, TRACE_FILE);
}

/**
 * Build a Trace, filling id + timestamp. Caller supplies the rest.
 */
export function buildTrace(
  fields: Omit<Trace, "id" | "timestamp"> & { id?: string; timestamp?: string },
  now: number = Date.now(),
): Trace {
  return {
    id: fields.id ?? ulid(now),
    timestamp: fields.timestamp ?? new Date(now).toISOString(),
    model_name: fields.model_name,
    decision_type: fields.decision_type,
    observation: fields.observation,
    reasoning: fields.reasoning,
    action: fields.action,
    outcome: fields.outcome,
    links: fields.links ?? [],
  };
}

/**
 * Append a trace to the store. Creates the dir/file if needed.
 */
export async function appendTrace(dir: string, trace: Trace): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(tracePath(dir), JSON.stringify(trace) + "\n", "utf-8");
}

/**
 * Read all traces from the store (oldest first). Tolerant of malformed lines.
 */
export async function readTraces(dir: string): Promise<Trace[]> {
  let raw: string;
  try {
    raw = await fs.readFile(tracePath(dir), "utf-8");
  } catch {
    return [];
  }
  const traces: Trace[] = [];
  for (const line of raw.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      traces.push(JSON.parse(t) as Trace);
    } catch {
      // skip a corrupt line — the rest of the store is still readable
    }
  }
  return traces;
}

async function rewrite(dir: string, traces: Trace[]): Promise<void> {
  const body = traces.map((t) => JSON.stringify(t)).join("\n") + (traces.length ? "\n" : "");
  await fs.writeFile(tracePath(dir), body, "utf-8");
}

/**
 * Update the outcome of an existing trace. The ONLY mutation allowed on a
 * trace, and it is meant to move forward (pending → known: verified /
 * reversed / failed / …). Returns true if the trace was found.
 */
export async function updateOutcome(
  dir: string,
  traceId: string,
  outcome: TraceOutcome,
): Promise<boolean> {
  const traces = await readTraces(dir);
  let found = false;
  for (const t of traces) {
    if (t.id === traceId) {
      t.outcome = outcome;
      found = true;
    }
  }
  if (found) await rewrite(dir, traces);
  return found;
}

/**
 * Record a relationship from one trace to another (stored on `from`).
 * Only grows the links array — never removes. Returns true if `from` exists.
 */
export async function linkTraces(dir: string, fromId: string, toId: string): Promise<boolean> {
  const traces = await readTraces(dir);
  let found = false;
  for (const t of traces) {
    if (t.id === fromId) {
      if (!t.links.includes(toId)) t.links.push(toId);
      found = true;
    }
  }
  if (found) await rewrite(dir, traces);
  return found;
}

// ── Query ────────────────────────────────────────────────────────

export interface TraceFilter {
  /** Match a specific model (use null to match substrate-level traces) */
  model_name?: string | null;
  decision_type?: DecisionType | DecisionType[];
  status?: OutcomeStatus | OutcomeStatus[];
  /** ISO timestamp lower bound (inclusive) */
  since?: string;
  /** ISO timestamp upper bound (inclusive) */
  until?: string;
  /** Substring match against observation / reasoning / serialized action */
  entity?: string;
  /** Keep only the most recent N (still returned chronologically) */
  limit?: number;
}

/**
 * Query traces with optional filters. Returns chronological (oldest first).
 */
export async function queryTraces(dir: string, filter: TraceFilter = {}): Promise<Trace[]> {
  let traces = await readTraces(dir);

  if (filter.decision_type) {
    const types = Array.isArray(filter.decision_type) ? filter.decision_type : [filter.decision_type];
    traces = traces.filter((t) => types.includes(t.decision_type));
  }
  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
    traces = traces.filter((t) => statuses.includes(t.outcome.status));
  }
  if (filter.model_name !== undefined) {
    traces = traces.filter((t) => t.model_name === filter.model_name);
  }
  if (filter.since) traces = traces.filter((t) => t.timestamp >= filter.since!);
  if (filter.until) traces = traces.filter((t) => t.timestamp <= filter.until!);
  if (filter.entity) {
    const needle = filter.entity.toLowerCase();
    traces = traces.filter((t) => {
      const hay = `${t.observation} ${t.reasoning} ${JSON.stringify(t.action)}`.toLowerCase();
      return hay.includes(needle);
    });
  }

  if (filter.limit !== undefined && filter.limit >= 0 && traces.length > filter.limit) {
    traces = traces.slice(traces.length - filter.limit);
  }
  return traces;
}
