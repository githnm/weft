/** A confirmed term stored in terms.json */
export interface Term {
  /** Malloy filter expression (e.g. "subscriber_type = 'Student Membership' | 'U.T. Student Membership'") */
  filter: string;
  /** Source filename this term applies to */
  applies_to: string;
  /** Human-readable description */
  description: string;
  /** When this term was created */
  created_at: string;
  /** How this term was created */
  created_via: "manual" | "auto-confirmed";
  /** How many times this term has been matched in queries */
  matched_count: number;
}

/** A pending term proposal stored in proposed-terms.json */
export interface ProposedTerm {
  /** The user's original term */
  user_term: string;
  /** Proposed Malloy filter expression */
  filter: string;
  /** Source filename this term applies to */
  applies_to: string;
  /** When this was proposed */
  proposed_at: string;
  /** The question that triggered the proposal */
  question_context: string;
  /** The enum values that were matched */
  matched_enum_values: string[];
}

/** terms.json shape: keys are normalized term names */
export type TermsStore = Record<string, Term>;

/** proposed-terms.json shape: keys are normalized term names */
export type ProposedTermsStore = Record<string, ProposedTerm>;

/** A matched term from feasibility, passed to generation */
export interface MatchedTerm {
  /** The normalized term key */
  name: string;
  /** The Malloy filter expression to apply */
  filter: string;
  /** Human-readable description */
  description: string;
}

/**
 * Normalize a user term into a storage key.
 * Lowercases, strips punctuation, replaces spaces with underscores.
 * "VIP customers!" → "vip_customers"
 */
export function normalizeTermKey(term: string): string {
  return term
    .toLowerCase()
    .replace(/[^\w\s]/g, "")
    .trim()
    .replace(/\s+/g, "_");
}
