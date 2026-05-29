import { chat, stripCodeFences } from "../llm/anthropic.js";
import { loadTerms, filterTermsForSource } from "../terms/store.js";
import { loadSession } from "../session/store.js";
import type { ClassifyResult, CorrectionType, ClassifyTarget, ClassifyProposedChange } from "./types.js";
import type { Session } from "../session/types.js";

const SYSTEM_PROMPT = `You classify a user correction into one of four types and identify what needs to change.

Types:
- "term_update": the user wants to modify an existing term's filter expression. Example: "students should exclude short trips" → update the "students" term. The term must exist in the provided terms.json.
- "model_suggestion": the user wants a structural change that requires editing the .malloy file. Example: "revenue should exclude refunds" → modify the revenue measure definition. Use this when no matching term exists and the change targets a measure or dimension definition.
- "new_term": the user wants to define a new business term. Example: "I'll call paying customers Local365 or Annual plans" → create a new term.
- "unclear": can't determine what the user wants. Ask for clarification.

Return JSON (no markdown fences, no commentary):
{
  "type": "term_update" | "model_suggestion" | "new_term" | "unclear",
  "target": {
    "term_name": "<string, for term_update>",
    "file": "<string, for model_suggestion>",
    "new_term_name": "<string, for new_term>"
  },
  "proposed_change": {
    "description": "<short description of the change>",
    "old": "<existing definition if updating>",
    "new": "<proposed new Malloy expression>"
  },
  "reasoning": "<one or two sentences>",
  "confidence": "high" | "medium" | "low"
}

Rules:
- If the correction references an existing term by name or by the concept it represents, prefer "term_update" over "model_suggestion".
- If the user says "should also exclude/include" or "should filter by", that's a filter change → term_update if a term exists, model_suggestion otherwise.
- If the user defines a wholly new concept with new values, that's "new_term".
- Always set target fields relevant to the chosen type.
- The "proposed_change.new" field should be a valid Malloy filter expression for term_update, or a Malloy measure/dimension definition for model_suggestion.`;

/**
 * Classify a user's correction text into one of the correction types.
 * Uses session state and terms.json to identify what the user is correcting.
 */
export async function classifyCorrection(
  correctionText: string,
  modelsDir: string,
  session?: Session | null,
): Promise<ClassifyResult> {
  const userParts: string[] = [];

  // Provide session context
  if (session) {
    const sessionLines: string[] = [
      "Previous query context:",
      `  Question: "${session.last_question}"`,
      `  Source: ${session.last_source}`,
      `  Malloy: ${session.last_malloy}`,
    ];
    if (session.last_filters.length > 0) {
      const filters = session.last_filters.map((f) => {
        return f.applied_term ? `${f.expression} (term: "${f.applied_term}")` : f.expression;
      });
      sessionLines.push(`  Filters: ${filters.join("; ")}`);
    }
    userParts.push(sessionLines.join("\n"));
  }

  // Provide existing terms
  const allTerms = await loadTerms(modelsDir);
  const termEntries = Object.entries(allTerms);
  if (termEntries.length > 0) {
    // If we have a session, show terms for that source first
    const sourceFile = session?.last_source;
    const relevantTerms = sourceFile
      ? Object.entries(filterTermsForSource(allTerms, sourceFile))
      : termEntries;

    const termLines: string[] = ["Existing terms:"];
    for (const [key, term] of relevantTerms) {
      termLines.push(`  "${key}": filter = \`${term.filter}\` (${term.description}), source: ${term.applies_to}`);
    }
    userParts.push(termLines.join("\n"));
  } else {
    userParts.push("Existing terms: (none)");
  }

  userParts.push(
    `User correction: "${correctionText}"\n\nClassify this correction. Return JSON only.`,
  );

  const response = await chat({
    system: SYSTEM_PROMPT,
    userParts,
    maxTokens: 512,
  });

  const raw = stripCodeFences(response.text);
  let parsed: {
    type: string;
    target: { term_name?: string; file?: string; new_term_name?: string };
    proposed_change: { description: string; old?: string; new?: string };
    reasoning: string;
    confidence: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      type: "unclear",
      target: {},
      proposedChange: { description: "Failed to parse classification response" },
      reasoning: "Parse error in LLM response",
      confidence: "low",
      usage: response.usage,
    };
  }

  const type = (["term_update", "model_suggestion", "new_term", "unclear"].includes(parsed.type)
    ? parsed.type
    : "unclear") as CorrectionType;

  const target: ClassifyTarget = {
    termName: parsed.target?.term_name,
    file: parsed.target?.file,
    newTermName: parsed.target?.new_term_name,
  };

  const proposedChange: ClassifyProposedChange = {
    description: parsed.proposed_change?.description ?? "",
    old: parsed.proposed_change?.old,
    new: parsed.proposed_change?.new,
  };

  return {
    type,
    target,
    proposedChange,
    reasoning: parsed.reasoning ?? "",
    confidence: (parsed.confidence as "high" | "medium" | "low") ?? "medium",
    usage: response.usage,
  };
}

// ── Inline detection: fast regex pre-filter ──────────────────

const CORRECTION_START = /^(no[,.]?\s|wrong|actually[,.]?\s|that's wrong|that's not right|that is wrong|incorrect)/i;
const CORRECTION_SIGNAL = /(should\s+(exclude|include|not include|be\s|filter|match)|isn't\s+(correct|right)|isn't supposed to|is not correct|is not right)/i;

/**
 * Fast regex check: does this question look like a correction?
 * Returns true if the text matches correction phrasing patterns.
 * This is a cheap pre-filter — the real judgment is in classifyCorrection.
 */
export function looksLikeCorrection(text: string): boolean {
  return CORRECTION_START.test(text.trim()) || CORRECTION_SIGNAL.test(text);
}
