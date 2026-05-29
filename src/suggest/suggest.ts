import { chat, stripCodeFences } from "../llm/anthropic.js";
import { MALLOY_SYNTAX_RULES, MALLOY_SYNTAX_REFERENCE } from "../llm/malloy-syntax-ref.js";
import type { SuggestResponse, SuggestResult } from "./types.js";

const FEW_SHOT_EXAMPLES = `FEW-SHOT EXAMPLES

These are examples of well-formed suggestions in correct Malloy syntax:

EXAMPLE 1 - filtered measure on a known field:
  measure: short_trips is row_count { where: duration_minutes < 15 }

EXAMPLE 2 - composite measure:
  measure: avg_trip_minutes is duration_minutes.avg()
  measure: pct_long_trips is (
    row_count { where: duration_minutes > 60 } / row_count * 100
  )

EXAMPLE 3 - view using a join:
  view: top_stations is {
    group_by: start_station.name
    aggregate:
      trip_count is row_count
      avg_duration is duration_minutes.avg()
    order_by: trip_count desc
    limit: 20
  }`;

const SYSTEM_PROMPT = `You are a senior analytics engineer. You read BigQuery dataset inspection metadata and Malloy model files, then propose additional measures, views, and named filters that a business user would likely want but are not auto-derivable from simple column classification.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

${FEW_SHOT_EXAMPLES}

WHAT MAKES A GOOD SUGGESTION:
- Each suggestion answers ONE specific business question a user would actually ask.
- Be specific and named — "weekend_trips" not "filtered_count_1".
- Business-meaningful — tied to the domain, not generic.
- Avoid trivial measures (e.g. sum of a primary key, count that already exists).
- Suggestion types to consider:
  * Filtered measures (count where status = 'active')
  * Named filters / where clauses (is_weekend is dayofweek(start_time) > 5)
  * Composite measures (avg_trip_duration is duration_minutes.avg())
  * Views that answer a specific question (trips_by_day_of_week, station_utilization)
  * Time-window measures (trips_last_30_days)
  * Ratio measures (pct_subscriber is subscriber_count / row_count * 100)

OUTPUT FORMAT:
Return a single JSON object (no markdown fences, no commentary outside JSON):
{
  "domain": "one sentence describing the business domain",
  "suggestions": [
    {
      "title": "short descriptive title",
      "target_source": "filename.malloy",
      "reasoning": "1-2 sentences: what business question this answers",
      "malloy_code": "the Malloy code to add inside the source extend block",
      "confidence": "high" | "medium" | "low"
    }
  ]
}`;

export async function generateSuggestions(
  inspectionJson: string,
  malloyFiles: Map<string, string>,
  maxSuggestions: number
): Promise<SuggestResult> {
  const malloyContext = Array.from(malloyFiles.entries())
    .map(([name, content]) => `=== ${name} ===\n${content}`)
    .join("\n\n");

  const response = await chat({
    system: SYSTEM_PROMPT,
    userParts: [
      `Here is the BigQuery dataset inspection metadata:\n\n${inspectionJson}`,
      `Here are the current Malloy model files:\n\n${malloyContext}`,
      `Propose up to ${maxSuggestions} suggestions. Return JSON only.`,
    ],
  });

  const raw = stripCodeFences(response.text);

  let parsed: SuggestResponse;
  try {
    parsed = JSON.parse(raw) as SuggestResponse;
  } catch {
    throw new Error(
      `Failed to parse LLM response as JSON.\n\nRaw response:\n${raw.slice(0, 500)}`
    );
  }

  if (!parsed.domain || !Array.isArray(parsed.suggestions)) {
    throw new Error(
      `LLM response missing required fields (domain, suggestions).\n\nParsed:\n${JSON.stringify(parsed, null, 2).slice(0, 500)}`
    );
  }

  return {
    response: parsed,
    model: response.model,
    inputTokens: response.usage.inputTokens,
    outputTokens: response.usage.outputTokens,
  };
}
