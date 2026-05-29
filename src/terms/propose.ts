import { normalizeTermKey, type ProposedTerm } from "./types.js";
import { loadTerms, addProposal } from "./store.js";
import type { EnumMatch } from "../agent/types.js";

export interface ProposalResult {
  /** Term key */
  key: string;
  /** The user's original term */
  userTerm: string;
  /** The proposed filter expression */
  filter: string;
}

/**
 * Build a Malloy filter expression from matched enum values.
 * Uses value-set syntax: column = 'A' | 'B' | 'C'
 * NOT: column = 'A' | column = 'B' | column = 'C'
 */
function buildFilter(column: string, values: string[]): string {
  if (values.length === 1) {
    return `${column} = '${values[0]}'`;
  }
  const valueList = values.map((v) => `'${v}'`).join(" | ");
  return `${column} = ${valueList}`;
}

/**
 * After a successful query with matched enum values, propose terms
 * for any new enum matches that don't already exist in terms.json.
 *
 * Returns the list of newly proposed terms (for CLI display).
 */
export async function proposeTermsFromMatches(options: {
  modelsDir: string;
  sourceFilename: string;
  question: string;
  matchedEnumValues: EnumMatch[];
}): Promise<ProposalResult[]> {
  const { modelsDir, sourceFilename, question, matchedEnumValues } = options;

  const existingTerms = await loadTerms(modelsDir);
  const results: ProposalResult[] = [];

  for (const match of matchedEnumValues) {
    // Only propose for matches that have actual values
    if (match.matchedValues.length === 0) continue;

    const key = normalizeTermKey(match.userTerm);
    if (!key) continue;

    // Skip if already a confirmed term
    if (existingTerms[key]) continue;

    const filter = buildFilter(match.column, match.matchedValues);

    const proposal: ProposedTerm = {
      user_term: match.userTerm,
      filter,
      applies_to: sourceFilename,
      proposed_at: new Date().toISOString(),
      question_context: question,
      matched_enum_values: match.matchedValues,
    };

    await addProposal(modelsDir, key, proposal);
    results.push({ key, userTerm: match.userTerm, filter });
  }

  return results;
}
