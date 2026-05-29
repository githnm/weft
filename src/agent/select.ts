import { chat, stripCodeFences } from "../llm/anthropic.js";
import type { SourceSummary, SourceSelection } from "./types.js";
import { formatCatalog } from "./catalog.js";

const SYSTEM_PROMPT = `You are a data analyst. Given a natural-language question and a catalog of available Malloy data sources, pick the source that is most likely to answer the question.

Return a JSON object (no markdown fences, no commentary):
{
  "source": "<filename.malloy>",
  "reasoning": "<one sentence explaining why this source is the best match>"
}

Rules:
- Pick exactly one source.
- Consider column names, measures, joins, and the domain implied by the source name.
- If the question mentions a specific table or entity name, prefer the source that covers it.
- If the question involves relationships (e.g. "trips per station"), prefer a source with relevant joins.`;

export async function selectSource(
  question: string,
  summaries: SourceSummary[],
): Promise<SourceSelection> {
  const catalog = formatCatalog(summaries);

  const response = await chat({
    system: SYSTEM_PROMPT,
    userParts: [
      `Available sources:\n\n${catalog}`,
      `Question: ${question}\n\nReturn JSON only.`,
    ],
    maxTokens: 256,
  });

  const raw = stripCodeFences(response.text);
  let parsed: { source: string; reasoning: string };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse source selection response:\n${raw.slice(0, 300)}`);
  }

  if (!parsed.source || !parsed.reasoning) {
    throw new Error(`Source selection response missing required fields:\n${JSON.stringify(parsed)}`);
  }

  // Resolve filename to a summary to get the source name
  const match = summaries.find((s) => s.filename === parsed.source);
  if (!match) {
    // Try partial match (in case LLM dropped .malloy extension)
    const partial = summaries.find(
      (s) => s.filename.replace(".malloy", "") === parsed.source.replace(".malloy", ""),
    );
    if (!partial) {
      throw new Error(
        `LLM selected source "${parsed.source}" which does not exist.\nAvailable: ${summaries.map((s) => s.filename).join(", ")}`,
      );
    }
    return {
      filename: partial.filename,
      sourceName: partial.sourceName,
      reasoning: parsed.reasoning,
      usage: response.usage,
    };
  }

  return {
    filename: match.filename,
    sourceName: match.sourceName,
    reasoning: parsed.reasoning,
    usage: response.usage,
  };
}
