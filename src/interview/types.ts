import type { LLMUsage } from "../llm/anthropic.js";

// ── Decision types ───────────────────────────────────────────────

export interface DecisionOption {
  /** Short option label (e.g. "Per user per day") */
  label: string;
  /** What this means, referencing real columns/tables */
  detail: string;
  /** How this translates to Malloy constructs */
  malloy_hint: string;
  /** Whether this is the recommended option */
  recommended: boolean;
}

export interface Decision {
  /** Machine-readable ID (e.g. "grain", "user_identity") */
  id: string;
  /** Human-readable question */
  question: string;
  /** One sentence on why this matters */
  why_it_matters: string;
  /** Schema-grounded options */
  options: DecisionOption[];
  /** Whether the user can give a free-text answer */
  allow_custom: boolean;
}

// ── Plan types ───────────────────────────────────────────────────

export interface RelevantTable {
  name: string;
  reason: string;
}

export interface ModelPlan {
  purpose: string;
  relevant_tables: RelevantTable[];
  excluded_tables_count: number;
  table_selection_reasoning: string;
  decisions: Decision[];
  substrate_dir: string;
  usage: LLMUsage;
}

// ── Build types ──────────────────────────────────────────────────

export interface ResolvedDecision {
  decision_id: string;
  /** Matches an option label, or free text if allow_custom */
  chosen: string;
}

export interface BuildResult {
  success: boolean;
  model_dir?: string;
  model_malloy?: string;
  measures_count?: number;
  dimensions_count?: number;
  named_filters_count?: number;
  views_count?: number;
  error?: string;
  /** The draft Malloy if compilation failed — useful for debugging */
  draft_malloy?: string;
  /** Warning when model was saved despite compile timeout */
  compile_warning?: string;
  /**
   * Build contract status (Defect 1/5). True when the model was written but
   * does NOT satisfy the build contract: one or more measures/dimensions don't
   * compile, or a resolved interview decision is not reflected. An incomplete
   * model must NOT be reported as a clean success.
   */
  incomplete?: boolean;
  /** Measures/dimensions that still fail to compile after auto-repair. */
  failed_items?: { name: string; kind: string; error: string }[];
  /** Interview decisions the assembled model does not fulfil. */
  unmet_decisions?: { decision_id: string; chosen: string; expectation: string }[];
  /**
   * Measures that COMPILE but PRODUCE NO DATA (all-zero/null/empty) on an
   * unfiltered probe — semantically suspect even though the model compiled.
   */
  data_warnings?: DataWarning[];
  /**
   * Genuine ambiguities (type B) that only the user can resolve, surfaced when
   * the auto-fix loop is stuck. Present means the build paused for a batch of
   * user decisions; answer them and re-invoke with `clarifications`.
   */
  clarifications_needed?: ClarifyQuestion[];
  usage: LLMUsage;
}

/** A measure that compiled but returned no data on an unfiltered probe. */
export interface DataWarning {
  measure: string;
  status: "zero" | "null" | "empty" | "error";
  /** Human-readable likely cause (e.g. a broken/low-coverage join). */
  detail: string;
}

/**
 * A targeted clarification question generated from a REAL build diagnostic.
 * Only asked for genuine ambiguities the user must decide — never for the
 * build's own inconsistencies (those are auto-fixed).
 */
export interface ClarifyQuestion {
  id: string;
  question: string;
  /** Concrete options derived from the schema/decision (the user may also answer freely). */
  options: string[];
  /** The actual build failure this question is grounded in. */
  grounded_in: string;
}

/** A user's answer to a clarification question, fed back into the rebuild. */
export interface ClarifyAnswer {
  question: string;
  answer: string;
}

// ── Design provenance (stored in manifest) ───────────────────────

export interface DesignProvenance {
  planned_at: string;
  decisions: ResolvedDecision[];
  relevant_tables: RelevantTable[];
}

// ── Refinement types ────────────────────────────────────────────

export type RefinementChangeType =
  | "add_measure"
  | "add_dimension"
  | "add_view"
  | "modify_measure"
  | "modify_filter"
  | "add_join"
  | "remove_join"
  | "change_grain"
  | "other";

export interface RefinementClassification {
  change_type: RefinementChangeType;
  /** What's being changed (e.g. "total_tool_calls measure") */
  target: string;
  /** Whether the change can be done with available columns/tables */
  feasible: boolean;
  /** Explanation of what the change entails */
  reasoning: string;
  /** If not feasible, what's missing */
  missing?: string[];
  /**
   * UNDERSPECIFIED, not impossible: the concept is expressible with fields that
   * DO exist (email, name, domain, timestamps…), but the request didn't say HOW
   * to compute it. When true, this is a clarification — NOT a flat refusal.
   * (Distinct from `feasible:false` with no relevant field, which is impossible.)
   */
  needs_clarification?: boolean;
  /** A specific, field-grounded question to ask the user when underspecified. */
  clarification_question?: string;
}

export interface RefinementResult {
  success: boolean;
  /** Classification of the change */
  classification: RefinementClassification;
  /** The new model.malloy content (if feasible and compiled) */
  new_malloy?: string;
  /** The old model.malloy content (for diff) */
  old_malloy?: string;
  /** Human-readable diff summary */
  diff_summary?: string;
  /** Error message if the refinement failed */
  error?: string;
  /** Draft Malloy if compilation failed */
  draft_malloy?: string;
  /** Warning (e.g. compile timeout but saved anyway) */
  compile_warning?: string;
  /**
   * The request is underspecified but groundable — ask this question, then
   * re-submit with the answer appended. Set when the classifier marked the
   * change as needing clarification rather than impossible.
   */
  needs_clarification?: boolean;
  clarification_question?: string;
  usage: LLMUsage;
}

/** Stored in the manifest's refinement_history array */
export interface RefinementRecord {
  /** ISO 8601 timestamp */
  refined_at: string;
  /** The natural-language refinement request */
  refinement: string;
  /** What kind of change it was */
  change_type: RefinementChangeType;
  /** What was changed */
  target: string;
}
