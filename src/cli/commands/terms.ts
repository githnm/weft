import { loadTerms, loadProposedTerms, removeTerm } from "../../terms/store.js";

/**
 * Truncate a string to maxLen, adding … if truncated.
 */
function truncate(s: string, maxLen: number): string {
  return s.length > maxLen ? s.slice(0, maxLen - 1) + "…" : s;
}

/**
 * CLI: pnpm cli terms list --models <dir>
 *
 * Lists all confirmed terms (tabular, sorted by matched_count desc)
 * and pending proposals.
 */
export async function runTermsList(options: { modelsDir: string }): Promise<void> {
  const { modelsDir } = options;

  const terms = await loadTerms(modelsDir);
  const proposals = await loadProposedTerms(modelsDir);

  const termKeys = Object.keys(terms);
  const proposalKeys = Object.keys(proposals);

  if (termKeys.length === 0 && proposalKeys.length === 0) {
    console.log("\n  No terms or proposals found.");
    console.log("  Use 'pnpm cli define <term>' to create one, or ask a question to auto-propose.");
    console.log("");
    return;
  }

  // ── Confirmed terms (tabular, sorted by matched_count desc) ──
  if (termKeys.length > 0) {
    const sorted = termKeys.sort((a, b) => terms[b].matched_count - terms[a].matched_count);

    // Compute column widths
    const nameW = Math.max(4, ...sorted.map((k) => k.length));
    const filterW = Math.min(45, Math.max(6, ...sorted.map((k) => terms[k].filter.length)));
    const usedW = 4;
    const createdW = 10;

    console.log(`\n  Confirmed terms (${termKeys.length}):`);
    console.log("");

    // Header
    const header = `    ${"Term".padEnd(nameW)}  ${"Filter".padEnd(filterW)}  ${"Used".padStart(usedW)}  ${"Created".padEnd(createdW)}`;
    const separator = `    ${"─".repeat(nameW)}  ${"─".repeat(filterW)}  ${"─".repeat(usedW)}  ${"─".repeat(createdW)}`;
    console.log(header);
    console.log(separator);

    // Rows
    for (const key of sorted) {
      const t = terms[key];
      const created = t.created_at.slice(0, 10); // YYYY-MM-DD
      const line = `    ${key.padEnd(nameW)}  ${truncate(t.filter, filterW).padEnd(filterW)}  ${String(t.matched_count).padStart(usedW)}  ${created}`;
      console.log(line);
    }
    console.log("");
  }

  // ── Pending proposals ──
  if (proposalKeys.length > 0) {
    console.log(`  Pending proposals (${proposalKeys.length}):`);
    console.log("");
    for (const key of proposalKeys.sort()) {
      const p = proposals[key];
      console.log(`    ${key}`);
      console.log(`      Filter:   ${p.filter}`);
      console.log(`      Source:   ${p.applies_to}`);
      console.log(`      Context:  "${p.question_context}"`);
      console.log(`      Values:   [${p.matched_enum_values.join(", ")}]`);
      console.log(`      Confirm:  pnpm cli define ${key} --confirm --models ${modelsDir}`);
      console.log("");
    }
  }
}

/**
 * CLI: pnpm cli terms show <term> --models <dir>
 *
 * Prints full details for a single term.
 */
export async function runTermsShow(options: {
  term: string;
  modelsDir: string;
}): Promise<void> {
  const { term, modelsDir } = options;

  const terms = await loadTerms(modelsDir);
  const t = terms[term];

  if (!t) {
    // Check proposals
    const proposals = await loadProposedTerms(modelsDir);
    const p = proposals[term];

    if (p) {
      console.log(`\n  Pending proposal: "${term}"`);
      console.log(`    Filter:      ${p.filter}`);
      console.log(`    Source:      ${p.applies_to}`);
      console.log(`    Proposed:    ${p.proposed_at}`);
      console.log(`    Context:     "${p.question_context}"`);
      console.log(`    Values:      [${p.matched_enum_values.join(", ")}]`);
      console.log("");
      console.log(`    Confirm:     pnpm cli define ${term} --confirm --models ${modelsDir}`);
      console.log("");
      return;
    }

    console.error(`\n  Error: Term "${term}" not found.`);
    const keys = Object.keys(terms);
    if (keys.length > 0) {
      console.error(`  Available terms: ${keys.sort().join(", ")}`);
    }
    console.error("");
    process.exit(1);
  }

  console.log(`\n  Term: "${term}"`);
  console.log(`    Filter:       ${t.filter}`);
  console.log(`    Source:       ${t.applies_to}`);
  console.log(`    Description:  ${t.description}`);
  console.log(`    Created:      ${t.created_at}`);
  console.log(`    Created via:  ${t.created_via}`);
  console.log(`    Used:         ${t.matched_count} time${t.matched_count !== 1 ? "s" : ""}`);
  console.log("");
}

/**
 * CLI: pnpm cli terms delete <term> --models <dir>
 *
 * Deletes a confirmed term from terms.json.
 */
export async function runTermsDelete(options: {
  term: string;
  modelsDir: string;
}): Promise<void> {
  const { term, modelsDir } = options;

  const removed = await removeTerm(modelsDir, term);

  if (removed) {
    console.log(`\n  ✓ Term "${term}" deleted from terms.json.`);
    console.log("");
  } else {
    console.error(`\n  Error: Term "${term}" not found in terms.json.`);
    console.error("");

    // Show available terms
    const terms = await loadTerms(modelsDir);
    const keys = Object.keys(terms);
    if (keys.length > 0) {
      console.error(`  Available terms: ${keys.sort().join(", ")}`);
      console.error("");
    }
    process.exit(1);
  }
}
