import { chat, stripCodeFences } from "../llm/anthropic.js";
import type { Session, FollowUpResult, FollowUpInherit } from "./types.js";

const SYSTEM_PROMPT = `You are a conversation analyst. Your job is to determine whether the user's current question is a follow-up to their previous question, and if so, what context should be inherited.

Return JSON (no markdown fences, no commentary outside JSON):
{
  "is_follow_up": true | false,
  "confidence": "high" | "medium" | "low",
  "reasoning": "one or two sentences",
  "inherit": {
    "source": true | false,
    "filters": true | false,
    "group_by": true | false,
    "time_range": true | false
  }
}

CLASSIFICATION RULES:

A question IS a follow-up if it:
- Uses pronouns or references to prior results: "that", "those", "this", "the same", "them"
- Modifies the prior query: "but by month", "and for students", "now break that down by..."
- Narrows/expands: "what about just for Q1?", "include walk-ups too"
- Asks about the same data differently: "show me a breakdown", "what's the average?"
- Uses comparative language referencing prior: "compared to walk-ups", "instead of by station"

A question is NOT a follow-up if it:
- Asks about a completely different topic or entity type
- Would naturally use a different data source (e.g. trips vs stations)
- Is self-contained with no implicit references

INHERIT RULES:

When is_follow_up is true, decide what to carry forward:

"source": true — almost always true for follow-ups (same data source)

"filters": true — keep existing filters UNLESS the user explicitly replaces them
  - "now break that down by month" → filters: true (keep existing filters, change grouping)
  - "what about for walk-ups?" → filters: false (user is replacing the filter subject)
  - "also filter by active status" → filters: true (user is ADDING a filter)
  - "remove the student filter" → filters: false

"group_by": true — keep existing group_by UNLESS the user changes the breakdown
  - "and what about for walk-ups?" → group_by: true (same breakdown, different filter)
  - "break that down by month" → group_by: false (user wants a new breakdown)
  - "add a breakdown by station" → group_by: true (user is ADDING, not replacing)

"time_range": true — keep time range UNLESS the user specifies a new one
  - "what about last month?" → time_range: false (new time range)
  - "break that down by station" → time_range: true (unchanged)

When is_follow_up is false, all inherit values should be false.`;

/**
 * Classify whether the current question is a follow-up to the previous one.
 * Uses the structured session state — not a full transcript.
 */
export async function classifyFollowUp(
  currentQuestion: string,
  session: Session,
): Promise<FollowUpResult> {
  // Build a concise summary of the previous query
  const prevLines: string[] = [
    `Previous question: "${session.last_question}"`,
    `Source: ${session.last_source}`,
  ];

  if (session.last_filters.length > 0) {
    const filterStrs = session.last_filters.map((f) => {
      const termNote = f.applied_term ? ` (term: "${f.applied_term}")` : "";
      return `${f.expression}${termNote}`;
    });
    prevLines.push(`Filters applied: ${filterStrs.join("; ")}`);
  } else {
    prevLines.push("Filters applied: none");
  }

  if (session.last_group_by.length > 0) {
    prevLines.push(`Grouped by: ${session.last_group_by.join(", ")}`);
  } else {
    prevLines.push("Grouped by: (none — aggregate only)");
  }

  if (session.last_aggregates.length > 0) {
    prevLines.push(`Aggregates: ${session.last_aggregates.join(", ")}`);
  }

  if (session.last_time_range) {
    prevLines.push(
      `Time range: ${session.last_time_range.column} from ${session.last_time_range.start} to ${session.last_time_range.end}`,
    );
  }

  if (session.last_result_summary) {
    prevLines.push(`Result: ${session.last_result_summary.row_count} rows`);
  }

  const userParts = [
    `Previous query context:\n${prevLines.join("\n")}`,
    `Current question: "${currentQuestion}"\n\nIs this a follow-up? Return JSON only.`,
  ];

  const response = await chat({
    system: SYSTEM_PROMPT,
    userParts,
    maxTokens: 256,
  });

  const raw = stripCodeFences(response.text);
  let parsed: {
    is_follow_up: boolean;
    confidence: string;
    reasoning: string;
    inherit: {
      source: boolean;
      filters: boolean;
      group_by: boolean;
      time_range: boolean;
    };
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    // If parsing fails, treat as not a follow-up (safe default)
    return {
      isFollowUp: false,
      confidence: "low",
      reasoning: "Failed to parse follow-up classification response",
      inherit: { source: false, filters: false, group_by: false, time_range: false },
      usage: response.usage,
    };
  }

  if (typeof parsed.is_follow_up !== "boolean") {
    return {
      isFollowUp: false,
      confidence: "low",
      reasoning: "Invalid follow-up classification response",
      inherit: { source: false, filters: false, group_by: false, time_range: false },
      usage: response.usage,
    };
  }

  const inherit: FollowUpInherit = parsed.is_follow_up
    ? {
        source: parsed.inherit?.source ?? true,
        filters: parsed.inherit?.filters ?? false,
        group_by: parsed.inherit?.group_by ?? false,
        time_range: parsed.inherit?.time_range ?? false,
      }
    : { source: false, filters: false, group_by: false, time_range: false };

  return {
    isFollowUp: parsed.is_follow_up,
    confidence: (parsed.confidence as "high" | "medium" | "low") ?? "medium",
    reasoning: parsed.reasoning ?? "",
    inherit,
    usage: response.usage,
  };
}
