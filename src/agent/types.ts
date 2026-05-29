import type { LLMUsage } from "../llm/anthropic.js";
import type { MatchedTerm } from "../terms/types.js";
import type { FollowUpResult } from "../session/types.js";
import type { ClassifyResult } from "../correct/types.js";

export type { LLMUsage } from "../llm/anthropic.js";
export type { MatchedTerm } from "../terms/types.js";
export type { FollowUpResult } from "../session/types.js";
export type { ClassifyResult } from "../correct/types.js";

/** Compact summary of a single Malloy source, used for source selection. */
export interface SourceSummary {
  /** The .malloy filename */
  filename: string;
  /** The Malloy source name (e.g. "bikeshare_trips") */
  sourceName: string;
  /** Primary key column, if declared */
  primaryKey?: string;
  /** Join target names */
  joins: string[];
  /** Dimension names (including computed) */
  dimensions: string[];
  /** Measure names */
  measures: string[];
  /** View names */
  views: string[];
}

/** Stage 1 result: which source to query */
export interface SourceSelection {
  filename: string;
  sourceName: string;
  reasoning: string;
  usage: LLMUsage;
}

/** A single enum-value match: the user's term resolved to specific column values */
export interface EnumMatch {
  /** The dimension column containing the matched values */
  column: string;
  /** The exact enum values that matched the user's term */
  matchedValues: string[];
  /** The user's original term that triggered the match */
  userTerm: string;
  /** True if the enum was truncated (only top-N captured) — long tail may have more matches */
  enumWasTruncated?: boolean;
  /** Total distinct count for truncated enums */
  totalDistinct?: number;
}

/** Stage 1.5 result: feasibility check */
export interface FeasibilityResult {
  feasible: boolean;
  reasoning: string;
  missingConcepts: string[];
  /** Data-level issues discovered via metadata (time ranges, enum mismatches, stale data) */
  dataIssues?: DataIssues;
  /** Enum values matched from the user's question — passed to generation for exact filters */
  matchedEnumValues?: EnumMatch[];
  /** Business terms matched from terms.json — passed to generation for pre-defined filters */
  matchedTerms?: MatchedTerm[];
  usage: LLMUsage;
}

export interface DataIssues {
  timeOutOfRange?: { requested: string; available: string };
  unknownFilterValue?: {
    userTerm: string;
    column: string;
    knownValues: string[];
    /** True if the enum was truncated (only top-N values captured) — value may exist in long tail */
    enumWasTruncated?: boolean;
  };
  staleData?: { latest: string; daysOld: number };
}

/** Stage 2 result: the generated Malloy query */
export interface GeneratedQuery {
  /** The full `run: source -> { ... }` block (no import) */
  malloy: string;
  /** Plain-English description of what the query does */
  explanation: string;
  usage: LLMUsage;
  /** True if this was produced by the retry path */
  wasRetried?: boolean;
}

/** Stage 3 result: query execution output */
export interface ExecutionResult {
  /** Flat rows as plain objects */
  rows: Record<string, unknown>[];
  totalRows: number;
  /** BigQuery bytes scanned, if available */
  bytesScanned?: number;
}

/** Layer 1: a single deterministic structural check result */
export interface StructuralCheck {
  id: string;
  severity: "warning" | "info";
  message: string;
}

/** Layer 2: LLM semantic check result */
export interface SemanticCheck {
  matchesIntent: "yes" | "partial" | "no";
  confidence: "high" | "medium" | "low";
  reasoning: string;
  caveats: string[];
  usage: LLMUsage;
}

/** Combined verification result (both layers) */
export interface VerificationResult {
  structuralChecks: StructuralCheck[];
  semantic?: SemanticCheck;
  usage: LLMUsage;
}

/** Full pipeline result */
export interface AskResult {
  question: string;
  source: SourceSelection;
  /** Follow-up classification result (present when session existed) */
  followUp?: FollowUpResult;
  feasibility?: FeasibilityResult;
  query?: GeneratedQuery;
  execution?: ExecutionResult;
  verification?: VerificationResult;
  /** Terms auto-proposed from this query's enum matches */
  proposedTerms?: { key: string; userTerm: string; filter: string }[];
  /** The previous question (when session was loaded, regardless of follow-up status) */
  previousQuestion?: string;
  /** Set when inline correction detection triggered — the CLI handles this result type */
  correctionDetected?: ClassifyResult;
  /** Aggregated token usage across all LLM calls */
  totalUsage: LLMUsage;
}
