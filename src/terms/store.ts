import fs from "node:fs/promises";
import path from "node:path";
import type { TermsStore, ProposedTermsStore, Term, ProposedTerm } from "./types.js";

const TERMS_FILE = "terms.json";
const PROPOSED_FILE = "proposed-terms.json";

// ── Read ──────────────────────────────────────────────────────────

export async function loadTerms(modelsDir: string): Promise<TermsStore> {
  const p = path.join(modelsDir, TERMS_FILE);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as TermsStore;
  } catch {
    return {};
  }
}

export async function loadProposedTerms(modelsDir: string): Promise<ProposedTermsStore> {
  const p = path.join(modelsDir, PROPOSED_FILE);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as ProposedTermsStore;
  } catch {
    return {};
  }
}

// ── Write ─────────────────────────────────────────────────────────

export async function saveTerms(modelsDir: string, terms: TermsStore): Promise<void> {
  const p = path.join(modelsDir, TERMS_FILE);
  await fs.writeFile(p, JSON.stringify(terms, null, 2), "utf-8");
}

export async function saveProposedTerms(modelsDir: string, proposals: ProposedTermsStore): Promise<void> {
  const p = path.join(modelsDir, PROPOSED_FILE);
  await fs.writeFile(p, JSON.stringify(proposals, null, 2), "utf-8");
}

// ── Mutations ─────────────────────────────────────────────────────

export async function addTerm(modelsDir: string, key: string, term: Term): Promise<void> {
  const terms = await loadTerms(modelsDir);
  terms[key] = term;
  await saveTerms(modelsDir, terms);
}

export async function removeTerm(modelsDir: string, key: string): Promise<boolean> {
  const terms = await loadTerms(modelsDir);
  if (!(key in terms)) return false;
  delete terms[key];
  await saveTerms(modelsDir, terms);
  return true;
}

export async function addProposal(
  modelsDir: string,
  key: string,
  proposal: ProposedTerm,
): Promise<void> {
  const proposals = await loadProposedTerms(modelsDir);
  proposals[key] = proposal;
  await saveProposedTerms(modelsDir, proposals);
}

export async function removeProposal(modelsDir: string, key: string): Promise<boolean> {
  const proposals = await loadProposedTerms(modelsDir);
  if (!(key in proposals)) return false;
  delete proposals[key];
  await saveProposedTerms(modelsDir, proposals);
  return true;
}

/**
 * Increment matched_count for a list of term keys.
 */
export async function incrementTermUsage(modelsDir: string, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  const terms = await loadTerms(modelsDir);
  let changed = false;
  for (const key of keys) {
    if (terms[key]) {
      terms[key].matched_count += 1;
      changed = true;
    }
  }
  if (changed) {
    await saveTerms(modelsDir, terms);
  }
}

/**
 * Get terms that apply to a specific source filename.
 */
export function filterTermsForSource(terms: TermsStore, sourceFilename: string): TermsStore {
  const filtered: TermsStore = {};
  for (const [key, term] of Object.entries(terms)) {
    if (term.applies_to === sourceFilename) {
      filtered[key] = term;
    }
  }
  return filtered;
}
