import { chat, stripCodeFences } from "../llm/anthropic.js";
import { formatMetadataForPrompt, isEnumTruncated, getEnumTotalDistinct } from "./metadata-loader.js";
import type { SourceMetadata } from "./metadata-loader.js";
import type { FeasibilityResult, DataIssues, EnumMatch, MatchedTerm } from "./types.js";
import type { TermsStore } from "../terms/types.js";
import type { SessionContext } from "../session/types.js";

const SYSTEM_PROMPT = `You are a strict semantic gatekeeper. Your only job is to determine whether the user's question can be answered using ONLY the columns, dimensions, measures, and joins defined in the provided Malloy model.

Return JSON (no markdown fences, no commentary outside JSON):
{
  "feasible": true | false,
  "reasoning": "one or two sentences explaining your decision",
  "missing_concepts": [],
  "matched_enum_values": [],
  "matched_terms": [],
  "data_issues": null
}

A question is feasible if every business concept it references maps to something in the model:
- "trips" -> a trips source exists: YES
- "average duration" -> duration_minutes column with .avg(): YES
- "subscriber type" -> subscriber_type dimension: YES
- "revenue" -> NO revenue/price/amount/cost column exists: NOT FEASIBLE
- "profit margin" -> NO cost or revenue data: NOT FEASIBLE
- "customer satisfaction" -> NO rating column: NOT FEASIBLE

DO NOT infer business rules. If the user asks about revenue and there is no revenue column, the question is NOT feasible, even if you could construct a formula using duration * hypothetical price. Inventing a price is fabrication, not analysis.

DO NOT be overly strict. Synonyms and reasonable interpretations are fine:
- "users" meaning the subscriber_type dimension: feasible
- "rides" meaning trips: feasible
- "most popular" meaning highest count: feasible
- "recent" meaning latest dates: feasible
- "busiest" meaning highest count: feasible
- "longest" meaning max duration: feasible

The threshold is: is there a concrete column or measure in the model that maps to each concept in the question? If yes, feasible. If you have to invent a constant, a rate, a price, or a business rule, NOT feasible.

When not feasible, list each missing concept in "missing_concepts". These should be short labels like "revenue", "customer rating", "cost per unit".`;

const ENUM_MATCHING_RULES = `
RULE: Enum value matching.

When a question references a category, type, role, or status, and the metadata provides enum values for a relevant dimension, check whether the requested concept matches any of those values (even by substring, case-insensitive).

Some enums are COMPLETE (all values captured) and some are TRUNCATED (only the most frequent values captured, marked with "top N of M values"). This distinction matters for unknown-value handling.

Examples:
- Question: 'how many trips by students?'
  Enum subscriber_type contains: ['Walk Up', 'Local365', 'Student Membership', 'U.T. Student Membership', ...]
  RESULT: feasible. The query should filter subscriber_type IN ('Student Membership', 'U.T. Student Membership').
  Set matched_enum_values: [{"column": "subscriber_type", "matched_values": ["Student Membership", "U.T. Student Membership"], "user_term": "students"}]

- Question: 'how many active stations?'
  Enum status contains: ['active', 'closed']
  RESULT: feasible. The query should filter status = 'active'.
  Set matched_enum_values: [{"column": "status", "matched_values": ["active"], "user_term": "active"}]

- Question: 'how many BMW trips?'
  Enum bike_type contains: ['electric', 'classic'] (complete)
  RESULT: NOT feasible. 'BMW' doesn't match any value and the enum is complete. Set data_issues.unknown_filter_value with the user's term and available values, and enum_was_truncated: false.

Substring matching rules:
- Case-insensitive
- Match if the question's word appears as a substring of any enum value, OR vice versa
- Match if any enum value's words (split on spaces, hyphens, underscores) contain the question's word

If MULTIPLE enum values match (like 'Student Membership' and 'U.T. Student Membership' both matching 'students'), the question is still feasible. List ALL matching values in matched_enum_values.

TRUNCATED ENUM HANDLING:
If a user term doesn't match any captured enum value, and the enum is marked as truncated (only top N of M values shown), treat this as POSSIBLY feasible — NOT definitively unknown. The captured values are the most common; the user's term may exist in the long tail. In this case:
- Mark as feasible: true
- Set matched_enum_values with the user_term and an empty matched_values array
- Add a note in reasoning that the value may exist in the long tail of the truncated enum

If the question's concept doesn't match ANY enum value AND the enum is complete (not truncated), mark as NOT feasible. Set data_issues.unknown_filter_value with enum_was_truncated: false.

matched_enum_values format (empty array if no matches):
[{"column": "subscriber_type", "matched_values": ["Student Membership", "U.T. Student Membership"], "user_term": "students"}]

data_issues.unknown_filter_value format (includes truncation flag):
{"user_term": "BMW", "column": "bike_type", "known_values": ["electric", "classic"], "enum_was_truncated": false}

CRITICAL: Recognizing enum matches is NOT the same as inventing business rules. We are matching user words to data that exists in the column. We are not inferring revenue from duration. The boundary: if the data exists in the model (as a column value), matching it is fine. If you have to invent a constant or formula, that's fabrication.`;

const METADATA_ADDENDUM = `
When data metadata is provided, additionally verify:
1. If the question mentions relative time (yesterday, last week, this month), check that the requested range falls within the time bounds. If 'yesterday' is requested but the data is months old, mark as NOT FEASIBLE with reason 'data does not include the requested time range'. Set data_issues.time_out_of_range with the requested vs available range.
2. If the question mentions specific values (a status, type, category, name), check whether the value matches enum values using the enum matching rules above. If it matches, mark as feasible and record the matches in matched_enum_values. If it does NOT match any enum value for the relevant column, mark as NOT FEASIBLE. Set data_issues.unknown_filter_value with the user_term, column, and known_values. Include a suggestion: "Did you mean one of: <values>?"
3. If the data is stale (>30 days old) AND the question implies current data ('current', 'now', 'today', 'this week'), mark as NOT FEASIBLE with reason 'data is N days out of date'. Set data_issues.stale_data with latest and days_old.

data_issues format (set to null if no data issues):
{
  "time_out_of_range": { "requested": "yesterday", "available": "2013-12-21 to 2014-03-31" },
  "unknown_filter_value": { "user_term": "BMW", "column": "bike_type", "known_values": ["electric", "classic"], "enum_was_truncated": false },
  "stale_data": { "latest": "2014-03-31", "days_old": 4075 }
}

Otherwise, follow the existing feasibility rules.`;

const TERMS_ADDENDUM = `
BUSINESS TERMS (CRITICAL — always check these first):
The following pre-defined business terms are available. Each maps a user-friendly name to a pre-validated Malloy filter expression.

MANDATORY: Before analyzing enum values or model columns, check if any business term matches the user's question. If a term matches, you MUST include it in "matched_terms" and mark the question as feasible for that concept. Business terms take priority over raw enum matching.

matched_terms format (empty array if no terms matched):
[{"name": "students", "filter": "subscriber_type = 'Student Membership' | 'U.T. Student Membership'", "description": "Student subscribers"}]

Rules for matching:
- Case-insensitive
- Match on the term name or reasonable synonyms (e.g. "student trips" matches term "students", "VIP customers" matches term "vip_customers")
- If a business term matches, the question is feasible for that concept (the filter is pre-validated)
- Business terms take PRIORITY over raw enum matching — if a term exists for a concept, use the term, do NOT also add matched_enum_values for the same concept
- Multiple terms can match in one question
- ALWAYS populate matched_terms when a term matches — do not skip this field
`;

interface FeasibilityOptions {
  question: string;
  sourceContent: string;
  sourceName?: string;
  importedFiles?: Map<string, string>;
  /** Source metadata from metadata.json (optional) */
  sourceMetadata?: SourceMetadata;
  /** Business terms that apply to this source (from terms.json) */
  sourceTerms?: TermsStore;
  /** Baked concept → alias map (built by buildConceptsPrompt). Concept names +
   *  aliases are answerable vocabulary. */
  concepts?: string;
  /** Session context for follow-up questions */
  sessionContext?: SessionContext;
}

export async function checkFeasibility(options: FeasibilityOptions): Promise<FeasibilityResult> {
  const { question, sourceContent, sourceName, importedFiles, sourceMetadata, sourceTerms, concepts, sessionContext } = options;

  // Build system prompt — add enum matching rules + metadata addendum if metadata is available
  let system = sourceMetadata
    ? SYSTEM_PROMPT + "\n" + ENUM_MATCHING_RULES + "\n" + METADATA_ADDENDUM
    : SYSTEM_PROMPT;

  // Add terms addendum if terms exist for this source
  const hasTerms = sourceTerms && Object.keys(sourceTerms).length > 0;
  if (hasTerms) {
    system += "\n" + TERMS_ADDENDUM;
  }

  const userParts: string[] = [];

  userParts.push(`Here is the Malloy source model:\n\n${sourceContent}`);

  if (importedFiles && importedFiles.size > 0) {
    const imports = Array.from(importedFiles.entries())
      .map(([name, content]) => `=== ${name} ===\n${content}`)
      .join("\n\n");
    userParts.push(`Imported files (joined sources):\n\n${imports}`);
  }

  // Add metadata if available
  if (sourceMetadata && sourceName) {
    userParts.push(formatMetadataForPrompt(sourceName, sourceMetadata));
  }

  // Add business terms if available
  if (hasTerms) {
    const termLines: string[] = ["Available business terms:"];
    for (const [key, term] of Object.entries(sourceTerms!)) {
      termLines.push(`- "${key}": filter = \`${term.filter}\` (${term.description})`);
    }
    userParts.push(termLines.join("\n"));
  }

  // Add baked concepts — their canonical names + aliases are answerable.
  if (concepts) {
    userParts.push(
      concepts +
        "\n\nA question that uses a concept name or any of its aliases IS feasible (the concept is defined in the model).",
    );
  }

  // Add follow-up context if this is a continuation of a previous query
  if (sessionContext) {
    const ctxLines: string[] = [
      "FOLLOW-UP CONTEXT: This is a follow-up question. The user is building on a prior query.",
      `- Previous question: "${sessionContext.lastQuestion}"`,
    ];
    if (sessionContext.lastFilters.length > 0) {
      const filterStrs = sessionContext.lastFilters.map((f) => f.expression);
      ctxLines.push(`- Previous filters: ${filterStrs.join("; ")}`);
    }
    if (sessionContext.lastGroupBy.length > 0) {
      ctxLines.push(`- Previous group_by: ${sessionContext.lastGroupBy.join(", ")}`);
    }
    ctxLines.push(
      "",
      'Treat references like "that", "those", "this" as referring to the prior query\'s results.',
      'Treat additions like "and by X" as modifications to the prior query, not new questions.',
      "Concepts already established in the prior query (filters, groupings) are available.",
    );
    userParts.push(ctxLines.join("\n"));
  }

  userParts.push(
    `Question: ${question}\n\n` +
      `Can this question be answered using ONLY the data in the model above? Return JSON only.`,
  );

  const response = await chat({
    system,
    userParts,
    maxTokens: 512,
  });

  const raw = stripCodeFences(response.text);
  let parsed: {
    feasible: boolean;
    reasoning: string;
    missing_concepts: string[];
    matched_enum_values?: { column: string; matched_values: string[]; user_term: string }[];
    matched_terms?: { name: string; filter: string; description: string }[];
    data_issues?: {
      time_out_of_range?: { requested: string; available: string };
      unknown_filter_value?: {
        user_term?: string;
        value?: string;
        column: string;
        known_values: string[];
        enum_was_truncated?: boolean;
      };
      stale_data?: { latest: string; days_old: number };
    } | null;
  };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse feasibility check response:\n${raw.slice(0, 300)}`);
  }

  if (typeof parsed.feasible !== "boolean" || !parsed.reasoning) {
    throw new Error(
      `Feasibility response missing required fields:\n${JSON.stringify(parsed, null, 2).slice(0, 300)}`,
    );
  }

  // Map matched_enum_values from LLM response to typed EnumMatch[]
  // Enrich with truncation info from source metadata
  let matchedEnumValues: EnumMatch[] | undefined;
  if (parsed.matched_enum_values && parsed.matched_enum_values.length > 0) {
    matchedEnumValues = parsed.matched_enum_values.map((m) => {
      const col = m.column ?? "";
      const truncated = sourceMetadata && col ? isEnumTruncated(sourceMetadata, col) : false;
      const totalDistinct = sourceMetadata && col ? getEnumTotalDistinct(sourceMetadata, col) : undefined;
      return {
        column: col,
        matchedValues: m.matched_values ?? [],
        userTerm: m.user_term ?? "",
        enumWasTruncated: truncated || undefined,
        totalDistinct: truncated ? totalDistinct : undefined,
      };
    });
  }

  // Map data_issues from LLM response to typed DataIssues
  let dataIssues: DataIssues | undefined;
  if (parsed.data_issues) {
    const di = parsed.data_issues;
    dataIssues = {};
    if (di.time_out_of_range) {
      dataIssues.timeOutOfRange = { requested: di.time_out_of_range.requested, available: di.time_out_of_range.available };
    }
    if (di.unknown_filter_value) {
      // Determine truncation: trust LLM response, fall back to metadata
      const llmTruncated = di.unknown_filter_value.enum_was_truncated;
      const metaTruncated = sourceMetadata ? isEnumTruncated(sourceMetadata, di.unknown_filter_value.column) : false;
      dataIssues.unknownFilterValue = {
        userTerm: di.unknown_filter_value.user_term ?? di.unknown_filter_value.value ?? "",
        column: di.unknown_filter_value.column,
        knownValues: di.unknown_filter_value.known_values,
        enumWasTruncated: llmTruncated ?? metaTruncated,
      };
    }
    if (di.stale_data) {
      dataIssues.staleData = { latest: di.stale_data.latest, daysOld: di.stale_data.days_old };
    }
    // Only set if at least one issue present
    if (!dataIssues.timeOutOfRange && !dataIssues.unknownFilterValue && !dataIssues.staleData) {
      dataIssues = undefined;
    }
  }

  // Map matched_terms from LLM response — validate against actual terms.json
  let matchedTerms: MatchedTerm[] | undefined;
  if (hasTerms) {
    const matched = new Set<string>();

    // First: use LLM-returned matched_terms (validated against real terms)
    if (parsed.matched_terms && parsed.matched_terms.length > 0) {
      matchedTerms = [];
      for (const mt of parsed.matched_terms) {
        // Verify the term actually exists in terms.json (LLM might hallucinate)
        const actual = sourceTerms![mt.name];
        if (actual) {
          matchedTerms.push({
            name: mt.name,
            filter: actual.filter,           // Use the stored filter, not the LLM's version
            description: actual.description,
          });
          matched.add(mt.name);
        }
      }
    }

    // Fallback: local substring match of term keys against the question.
    // Catches cases where the LLM didn't return matched_terms despite
    // terms being relevant (Bug 4 — LLMs are unreliable at following instructions).
    const questionLower = question.toLowerCase();
    for (const [key, term] of Object.entries(sourceTerms!)) {
      if (matched.has(key)) continue;
      // Match if any word in the term key appears in the question
      const keyWords = key.split("_");
      const keyMatches = keyWords.some((w) => w.length >= 3 && questionLower.includes(w));
      if (keyMatches) {
        if (!matchedTerms) matchedTerms = [];
        matchedTerms.push({
          name: key,
          filter: term.filter,
          description: term.description,
        });
      }
    }

    if (matchedTerms && matchedTerms.length === 0) matchedTerms = undefined;
  }

  return {
    feasible: parsed.feasible,
    reasoning: parsed.reasoning,
    missingConcepts: parsed.missing_concepts ?? [],
    dataIssues,
    matchedEnumValues,
    matchedTerms,
    usage: response.usage,
  };
}
