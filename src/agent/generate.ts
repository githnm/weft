import { chat, stripCodeFences, type LLMUsage } from "../llm/anthropic.js";
import { MALLOY_SYNTAX_RULES, MALLOY_SYNTAX_REFERENCE } from "../llm/malloy-syntax-ref.js";
import { formatEnumsForGeneration } from "./metadata-loader.js";
import type { SourceMetadata } from "./metadata-loader.js";
import type { GeneratedQuery, EnumMatch, MatchedTerm } from "./types.js";
import type { SessionContext } from "../session/types.js";

const SYSTEM_PROMPT = `You are a senior analytics engineer who writes Malloy queries. Given a natural-language question and a Malloy source model, generate a query that answers the question precisely.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

QUERY GENERATION RULES:
- Output a \`run:\` block that targets the source, e.g.: run: bikeshare_trips -> { ... }
- Use existing measures and dimensions where possible — do NOT recompute aggregations that already exist on the source.
- Use existing views as starting points when they match the question.
- Add \`limit: 50\` to any group_by query unless the user asked for "all" or "every".
- Use \`order_by:\` to put the most relevant rows first (usually descending by a measure).
- For "how many" or "total" questions, a simple aggregate block with no group_by is fine.
- To traverse joins, use dot notation: \`start_station.name\`.
- Do NOT add \`import\` statements — we prepend those automatically.
- Do NOT declare new sources — query the existing source directly.
- Do NOT use \`extend\` blocks in the run statement unless absolutely needed for the question. Prefer inline expressions or existing fields.
- Source columns listed in inventory comments (e.g. \`//   dimension: col1, col2\`) are available for use directly — you do NOT need to redeclare them.
- To filter by email domain, use a LIKE pattern: \`where: email ~ '%@domain.com'\`. This works across all SQL dialects without connector-specific functions.

OUTPUT FORMAT:
Return a JSON object (no markdown fences, no commentary outside JSON):
{
  "malloy": "run: source_name -> { ... }",
  "explanation": "2-3 sentence description of what this query does and why"
}`;

const RETRY_SYSTEM_PROMPT = `You are a senior analytics engineer debugging a Malloy query that failed. Fix the query so it compiles AND executes successfully. Do NOT change what the query is trying to answer — only fix the syntax, field references, or type issues.

Common failure modes:
- Malloy compile error: invalid syntax, undefined fields, wrong aggregation form
- BigQuery execution error: type mismatches in comparisons (e.g. STRING = INT64), missing CAST operations, invalid function arguments, columns that need explicit type coercion

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

OUTPUT FORMAT:
Return a JSON object (no markdown fences, no commentary outside JSON):
{
  "malloy": "run: source_name -> { ... }",
  "explanation": "2-3 sentence description of what this query does and what you fixed"
}`;

interface GenerateOptions {
  question: string;
  sourceName: string;
  sourceContent: string;
  importedFiles?: Map<string, string>;
  /** Source metadata for known enum values (optional) */
  sourceMetadata?: SourceMetadata;
  /** Enum values matched during feasibility — use as exact filter values */
  matchedEnumValues?: EnumMatch[];
  /** Pre-defined business terms matched during feasibility — use their filters directly */
  matchedTerms?: MatchedTerm[];
  /** Session context for follow-up queries — inherit filters/group_by from prior turn */
  sessionContext?: SessionContext;
}

/**
 * Format matched enum values from feasibility into a prompt section
 * that tells the LLM exactly which filter values to use.
 */
function formatMatchedEnums(matches: EnumMatch[]): string {
  const lines: string[] = [
    "For this question, the user is referring to categories that match these specific enum values. Use them as exact filter values:",
  ];
  for (const m of matches) {
    const matchedValues = m.matchedValues ?? [];
    if (matchedValues.length > 0) {
      const values = matchedValues.map((v) => `'${v}'`).join(", ");
      lines.push(`- "${m.userTerm ?? "?"}" matches ${m.column ?? "unknown"} values: [${values}]`);
      if (m.enumWasTruncated) {
        lines.push(`  (The enum is truncated — top ${m.totalDistinct ? `30 of ${m.totalDistinct}` : "N"} values captured. The long tail may include other "${m.userTerm ?? "?"}"-related values not shown. Filter on the matched values above.)`);
      }
    } else if (m.enumWasTruncated) {
      // No match in captured values, but enum is truncated — generate best-guess filter
      lines.push(`- "${m.userTerm ?? "?"}" did not match any of the top captured values for ${m.column ?? "unknown"}, but the enum is truncated (top ${m.totalDistinct ? `30 of ${m.totalDistinct}` : "N"} values). The value may exist in the long tail. Generate the query using "${m.userTerm ?? "?"}" as a best-guess filter value for ${m.column ?? "unknown"}, using a case-insensitive LIKE or substring match if possible.`);
    }
  }
  return lines.join("\n");
}

/**
 * Format matched business terms into a prompt section
 * that tells the LLM exactly which pre-defined filters to apply.
 */
function formatMatchedTerms(terms: MatchedTerm[]): string {
  const lines: string[] = [
    "SAVED TERM DEFINITIONS (use these, do not redefine them):",
    "The following pre-defined business terms matched the user's question. Their filter expressions are pre-validated and MUST be used exactly as shown.",
    "",
  ];
  for (const t of terms) {
    lines.push(`- "${t.name}":`);
    lines.push(`  where: ${t.filter}`);
    lines.push(`  Description: ${t.description}`);
  }
  lines.push("");
  lines.push("CRITICAL: Copy these filter expressions verbatim into the where: clause of the generated query. Do NOT rewrite, simplify, or derive alternative filters for these concepts. The filters above are the authoritative definitions.");
  return lines.join("\n");
}

export async function generateQuery(options: GenerateOptions): Promise<GeneratedQuery> {
  const { question, sourceName, sourceContent, importedFiles, sourceMetadata, matchedEnumValues, matchedTerms, sessionContext } = options;

  const userParts: string[] = [];

  // Part A: the source model
  userParts.push(`Here is the Malloy source model:\n\n${sourceContent}`);

  // Part B: any imported files (for join resolution context)
  if (importedFiles && importedFiles.size > 0) {
    const imports = Array.from(importedFiles.entries())
      .map(([name, content]) => `=== ${name} ===\n${content}`)
      .join("\n\n");
    userParts.push(`Imported files (available for join resolution):\n\n${imports}`);
  }

  // Part B.5: known enum values from metadata
  if (sourceMetadata) {
    const enumText = formatEnumsForGeneration(sourceMetadata);
    if (enumText) {
      userParts.push(enumText);
    }
  }

  // Part B.6: matched enum values from feasibility (highest priority — exact filters)
  if (matchedEnumValues && matchedEnumValues.length > 0) {
    userParts.push(formatMatchedEnums(matchedEnumValues));
  }

  // Part B.7: matched business terms (pre-defined filters — highest priority)
  if (matchedTerms && matchedTerms.length > 0) {
    userParts.push(formatMatchedTerms(matchedTerms));
  }

  // Part D: session context for follow-up queries
  if (sessionContext) {
    const ctxLines: string[] = [
      "FOLLOW-UP CONTEXT: This is a follow-up to a previous query. Inherit and modify as specified:",
      `Previous question: "${sessionContext.lastQuestion}"`,
      `Previous Malloy:\n${sessionContext.lastMalloy}`,
      "",
      "Inherit the following from the prior query:",
    ];

    if (sessionContext.inherit.filters && sessionContext.lastFilters.length > 0) {
      const filterStrs = sessionContext.lastFilters.map((f) => f.expression);
      ctxLines.push(`- Filters (KEEP): ${filterStrs.join("; ")}`);
    }
    if (sessionContext.inherit.group_by && sessionContext.lastGroupBy.length > 0) {
      ctxLines.push(`- Group by (KEEP): ${sessionContext.lastGroupBy.join(", ")}`);
    }
    if (sessionContext.inherit.time_range && sessionContext.lastTimeRange) {
      ctxLines.push(
        `- Time range (KEEP): ${sessionContext.lastTimeRange.column} from ${sessionContext.lastTimeRange.start} to ${sessionContext.lastTimeRange.end}`,
      );
    }

    ctxLines.push(
      "",
      "Modify them based on the user's new question. Do not lose inherited context unless the user explicitly asks to remove it.",
    );
    userParts.push(ctxLines.join("\n"));
  }

  // Part E: the question
  userParts.push(
    `Question: ${question}\n\n` +
      `The target source name is "${sourceName}". Generate a \`run:\` block. Return JSON only.`,
  );

  const response = await chat({
    system: SYSTEM_PROMPT,
    userParts,
    maxTokens: 2048,
  });

  return parseGenerateResponse(response.text, response.usage, false);
}

export async function retryQuery(options: {
  question: string;
  sourceName: string;
  sourceContent: string;
  failedMalloy: string;
  /** The error message — can be a compile error or a BigQuery execution error */
  error: string;
  /** Label for the error type shown to the LLM */
  errorPhase: "compile" | "execute";
}): Promise<GeneratedQuery> {
  const { question, sourceName, sourceContent, failedMalloy, error, errorPhase } = options;

  const errorLabel =
    errorPhase === "compile"
      ? "Malloy compile error"
      : "BigQuery execution error (the Malloy compiled but BigQuery rejected the SQL)";

  const response = await chat({
    system: RETRY_SYSTEM_PROMPT,
    userParts: [
      `Source model:\n\n${sourceContent}`,
      `Original question: ${question}\nTarget source: "${sourceName}"`,
      `Failed query:\n\`\`\`malloy\n${failedMalloy}\n\`\`\`\n\n${errorLabel}:\n${error}`,
      `Fix the query. Return JSON only.`,
    ],
    maxTokens: 2048,
  });

  return parseGenerateResponse(response.text, response.usage, true);
}

function parseGenerateResponse(raw: string, usage: LLMUsage, wasRetried: boolean): GeneratedQuery {
  const cleaned = stripCodeFences(raw);
  let parsed: { malloy: string; explanation: string };
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    throw new Error(`Failed to parse query generation response:\n${cleaned.slice(0, 500)}`);
  }

  if (!parsed.malloy || !parsed.explanation) {
    throw new Error(
      `Query generation response missing required fields:\n${JSON.stringify(parsed, null, 2).slice(0, 500)}`,
    );
  }

  // Strip any import lines the LLM may have included
  const malloy = parsed.malloy
    .split("\n")
    .filter((line) => !line.trim().startsWith("import "))
    .join("\n")
    .trim();

  return {
    malloy,
    explanation: parsed.explanation,
    usage,
    wasRetried,
  };
}
