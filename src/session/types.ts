// ── Session state persisted between queries ──────────────────

export interface SessionFilter {
  expression: string;
  /** The business term that produced this filter (if any) */
  applied_term?: string;
}

export interface SessionTimeRange {
  column: string;
  start: string;
  end: string;
}

export interface SessionResultSummary {
  row_count: number;
  first_row: Record<string, unknown> | null;
}

export interface Session {
  last_question: string;
  last_source: string;
  last_malloy: string;
  last_filters: SessionFilter[];
  last_group_by: string[];
  last_aggregates: string[];
  last_time_range: SessionTimeRange | null;
  last_result_summary: SessionResultSummary;
  last_at: string;
}

// ── Follow-up classification result ──────────────────────────

export interface FollowUpInherit {
  source: boolean;
  filters: boolean;
  group_by: boolean;
  time_range: boolean;
}

export interface FollowUpResult {
  isFollowUp: boolean;
  confidence: "high" | "medium" | "low";
  reasoning: string;
  inherit: FollowUpInherit;
  usage: { inputTokens: number; outputTokens: number };
}

// ── Session context passed to feasibility / generate ─────────

export interface SessionContext {
  lastQuestion: string;
  lastSource: string;
  lastMalloy: string;
  lastFilters: SessionFilter[];
  lastGroupBy: string[];
  lastAggregates: string[];
  lastTimeRange: SessionTimeRange | null;
  inherit: FollowUpInherit;
}
