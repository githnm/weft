import { chat, stripCodeFences } from "../llm/anthropic.js";
import type { SemanticCheck } from "./types.js";

const SYSTEM_PROMPT = `You are a strict result reviewer. Given a user's question, the Malloy query that ran, and the results, determine whether the results actually answer the question.

Return JSON (no markdown fences, no commentary outside JSON):
{
  "matches_intent": "yes" | "partial" | "no",
  "confidence": "high" | "medium" | "low",
  "reasoning": "1-2 sentences",
  "caveats": ["zero or more notes the user should know"]
}

Guidelines:
- "yes" means the result directly answers the question.
- "partial" means the result is related but doesn't fully answer (e.g. user asked for a comparison but only one side was returned).
- "no" means the result answers a different question entirely.

Caveats to surface (when applicable):
- The result excludes nulls in the grouping column
- The result is capped at N rows by a limit clause
- The query made a unit assumption (e.g. duration in minutes)
- The query used an inferred join that may not match user expectation
- The result represents a subset (e.g. only one year of data)
- A specific dimension was used as a proxy for the user's concept

DO NOT add caveats for things that are obvious (e.g. "this is from BigQuery") or things that don't apply.

DO NOT recompute the answer or suggest alternative queries. Your job is to flag whether the result matches intent and call out caveats.`;

/**
 * Format result rows as a compact text table for the LLM prompt.
 * Shows at most 10 rows.
 */
function formatRowsForPrompt(
  rows: Record<string, unknown>[],
  totalRows: number,
): string {
  const sample = rows.slice(0, 10);
  if (sample.length === 0) return "(no rows)";

  const columns = Object.keys(sample[0]);
  const lines: string[] = [];

  // Header
  lines.push(columns.join(" | "));
  lines.push(columns.map((c) => "-".repeat(c.length)).join(" | "));

  // Rows
  for (const row of sample) {
    lines.push(columns.map((col) => formatValue(row[col])).join(" | "));
  }

  if (totalRows > 10) {
    lines.push(`... (${totalRows - 10} more rows, ${totalRows} total)`);
  }

  return lines.join("\n");
}

function formatValue(val: unknown): string {
  if (val === null || val === undefined) return "NULL";
  if (val instanceof Date) return val.toISOString().split("T")[0];
  if (typeof val === "object") return JSON.stringify(val);
  return String(val);
}

export async function checkSemantic(options: {
  question: string;
  malloy: string;
  rows: Record<string, unknown>[];
  totalRows: number;
  aggregateColumns: string[];
}): Promise<SemanticCheck> {
  const { question, malloy, rows, totalRows, aggregateColumns } = options;

  const resultTable = formatRowsForPrompt(rows, totalRows);

  const aggInfo =
    aggregateColumns.length > 0
      ? `Aggregate columns: ${aggregateColumns.join(", ")}`
      : "Aggregate columns: (could not determine)";

  const response = await chat({
    system: SYSTEM_PROMPT,
    userParts: [
      `User question: ${question}`,
      `Malloy query:\n\`\`\`\n${malloy}\n\`\`\`\n\n${aggInfo}`,
      `Results (first ${Math.min(rows.length, 10)} of ${totalRows} rows):\n${resultTable}\n\nReturn JSON only.`,
    ],
    maxTokens: 512,
  });

  const raw = stripCodeFences(response.text);
  let parsed: {
    matches_intent: "yes" | "partial" | "no";
    confidence: "high" | "medium" | "low";
    reasoning: string;
    caveats: string[];
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    // If we can't parse the LLM response, return a degraded result
    // rather than crashing the entire pipeline.
    return {
      matchesIntent: "partial",
      confidence: "low",
      reasoning: "Could not parse verification response.",
      caveats: [],
      usage: response.usage,
    };
  }

  return {
    matchesIntent: parsed.matches_intent ?? "partial",
    confidence: parsed.confidence ?? "low",
    reasoning: parsed.reasoning ?? "",
    caveats: parsed.caveats ?? [],
    usage: response.usage,
  };
}
