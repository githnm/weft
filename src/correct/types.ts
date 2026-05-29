// ── Correction classification ────────────────────────────────

export type CorrectionType = "term_update" | "model_suggestion" | "new_term" | "unclear";

export interface ClassifyTarget {
  /** Term name for term_update */
  termName?: string;
  /** .malloy file for model_suggestion */
  file?: string;
  /** Proposed term name for new_term */
  newTermName?: string;
}

export interface ClassifyProposedChange {
  description: string;
  old?: string;
  new?: string;
}

export interface ClassifyResult {
  type: CorrectionType;
  target: ClassifyTarget;
  proposedChange: ClassifyProposedChange;
  reasoning: string;
  confidence: "high" | "medium" | "low";
  usage: { inputTokens: number; outputTokens: number };
}

// ── Numeric impact from re-running a query ───────────────────

export type QueryShape = "scalar_aggregate" | "grouped" | "detail";

export interface AggregateComparison {
  column: string;
  before: number;
  after: number;
  deltaPct: number;
}

export interface NumericImpact {
  mode: QueryShape;
  /** Row count before/after (always present) */
  rowsBefore: number;
  rowsAfter: number;
  rowsDeltaPct: number;
  /** Per-aggregate value comparisons (scalar: all aggs from row 0; grouped: sum of first agg) */
  aggregates: AggregateComparison[];
  /** The Malloy query that was run to measure impact */
  queryRun: string;
  /** Dynamic explanation when correction has no impact */
  noImpactExplanation?: string;
}

// ── Stored correction record ─────────────────────────────────

export interface CorrectionRecord {
  type: "term_update" | "model_suggestion";
  /** Term that was updated (for term_update) */
  targetTerm?: string;
  /** .malloy file with the suggestion (for model_suggestion) */
  targetFile?: string;
  oldFilter?: string;
  newFilter?: string;
  /** The user's original correction text */
  userCorrectionText: string;
  appliedAt: string;
  numericImpact: NumericImpact | null;
  /** The question (from session) that prompted the correction */
  sessionQuestion: string;
  /** Short description for list view */
  description: string;
}

export type CorrectionsStore = Record<string, CorrectionRecord>;

// ── Term update result (returned to CLI) ─────────────────────

export interface TermUpdateResult {
  termName: string;
  oldFilter: string;
  newFilter: string;
  impact: NumericImpact | null;
  correctionId: string;
}

// ── Model suggestion result ──────────────────────────────────

export interface ModelSuggestionResult {
  targetFile: string;
  findLine: string;
  replaceLine: string;
  compileOk: boolean;
  correctionId: string;
}
