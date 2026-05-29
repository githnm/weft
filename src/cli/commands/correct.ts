import { loadSession } from "../../session/store.js";
import { classifyCorrection } from "../../correct/classify.js";
import { prepareTermUpdate, applyTermUpdate } from "../../correct/term-update.js";
import { prepareModelSuggestion, logModelSuggestion, copyToClipboard } from "../../correct/model-suggest.js";
import type { TermUpdateResult } from "../../correct/types.js";

export interface CorrectOptions {
  correctionText: string;
  modelsDir: string;
  billingProject?: string;
  source?: string;
  skipImpact?: boolean;
}

/**
 * Run the correction flow. Returns true if a correction was applied/shown,
 * false if the user should fall through to normal ask.
 */
export async function runCorrect(options: CorrectOptions): Promise<boolean> {
  const { correctionText, modelsDir, billingProject, skipImpact } = options;

  // Load session for context
  const session = await loadSession(modelsDir);

  console.log(`\n  Correction: ${correctionText}`);
  console.log("");

  // Classify
  console.log("  Classifying correction...");
  const classification = await classifyCorrection(correctionText, modelsDir, session);

  if (classification.confidence === "low" || classification.type === "unclear") {
    console.log("");
    console.log("  I'm not sure how to apply this correction. Try one of:");
    console.log("    - Be specific about which term to update: 'students should also...'");
    console.log("    - Use 'pnpm cli define' to create a new term");
    console.log("    - Specify the source file if editing the model");
    console.log("");
    return false;
  }

  // ── Term update ────────────────────────────────────────────
  if (classification.type === "term_update") {
    const termName = classification.target.termName;
    if (!termName) {
      console.log("  Could not determine which term to update.");
      console.log(`  Reasoning: ${classification.reasoning}`);
      console.log("");
      return false;
    }

    console.log(`  Type: term update ("${termName}")`);
    console.log(`  Reasoning: ${classification.reasoning}`);
    console.log("");

    let result: TermUpdateResult;
    try {
      result = await prepareTermUpdate({
        termName,
        correctionText,
        proposedNewFilter: classification.proposedChange.new,
        modelsDir,
        billingProject,
        session,
        skipImpact,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Error preparing correction: ${message}`);
      console.log("");
      return false;
    }

    // Show the proposed change
    console.log(`  Proposed change to '${result.termName}':`);
    console.log(`    Before: ${result.oldFilter}`);
    console.log(`    After:  ${result.newFilter}`);
    console.log("");

    if (result.impact) {
      const ni = result.impact;
      console.log("  Numeric impact (re-running last query):");

      if (ni.mode === "scalar_aggregate") {
        // Show per-aggregate comparisons (row count is always 1 — not useful)
        for (const agg of ni.aggregates) {
          const label = agg.column;
          if (agg.before === agg.after) {
            console.log(`    ${label}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (no change)`);
          } else {
            const sign = agg.deltaPct >= 0 ? "+" : "";
            const delta = agg.after - agg.before;
            const deltaSign = delta >= 0 ? "+" : "";
            console.log(`    ${label}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (${deltaSign}${delta.toLocaleString()}, ${sign}${agg.deltaPct.toFixed(2)}%)`);
          }
        }
      } else {
        // Grouped or detail: show row count + optional aggregate sum
        const rowDelta = ni.rowsAfter - ni.rowsBefore;
        if (rowDelta === 0) {
          console.log(`    Rows: ${ni.rowsBefore.toLocaleString()} → ${ni.rowsAfter.toLocaleString()} (no change)`);
        } else {
          const rowSign = ni.rowsDeltaPct >= 0 ? "+" : "";
          const rowDeltaSign = rowDelta >= 0 ? "+" : "";
          console.log(`    Rows: ${ni.rowsBefore.toLocaleString()} → ${ni.rowsAfter.toLocaleString()} (${rowDeltaSign}${rowDelta.toLocaleString()}, ${rowSign}${ni.rowsDeltaPct.toFixed(2)}%)`);
        }

        // Secondary signal: sum of first aggregate column
        for (const agg of ni.aggregates) {
          if (agg.before === agg.after) {
            console.log(`    Sum of ${agg.column}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (no change)`);
          } else {
            const sign = agg.deltaPct >= 0 ? "+" : "";
            const delta = agg.after - agg.before;
            const deltaSign = delta >= 0 ? "+" : "";
            console.log(`    Sum of ${agg.column}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (${deltaSign}${delta.toLocaleString()}, ${sign}${agg.deltaPct.toFixed(2)}%)`);
          }
        }
      }

      // No-impact warning
      const rowsSame = ni.rowsBefore === ni.rowsAfter;
      const allAggsSame = ni.aggregates.every((a) => a.before === a.after);
      if (rowsSame && allAggsSame) {
        console.log("");
        console.log("  ⚠ The correction excludes zero rows from the result.");
        console.log("    Either the filter doesn't match any data, or the data doesn't");
        console.log("    contain values your filter excludes.");
        if (ni.noImpactExplanation) {
          console.log("");
          console.log(`    In this case: ${ni.noImpactExplanation}`);
        }
      }
      console.log("");
    }

    // Apply the change
    console.log("  Applying correction...");
    await applyTermUpdate({
      result,
      correctionText,
      modelsDir,
      session,
      reasoning: classification.reasoning,
    });

    console.log(`  ✓ Term "${result.termName}" updated in terms.json`);
    console.log(`  ✓ Correction logged (ID: ${result.correctionId})`);
    console.log("");
    console.log(`  Rollback: pnpm cli corrections rollback ${result.correctionId} --models ${modelsDir}`);
    console.log("");
    return true;
  }

  // ── Model suggestion ───────────────────────────────────────
  if (classification.type === "model_suggestion") {
    const targetFile = classification.target.file ?? options.source ?? session?.last_source;
    if (!targetFile) {
      console.log("  Could not determine which .malloy file to edit.");
      console.log("  Specify --source <filename> or correct from a session context.");
      console.log("");
      return false;
    }

    console.log(`  Type: model edit (cannot auto-apply)`);
    console.log(`  Reasoning: ${classification.reasoning}`);
    console.log("");

    try {
      const result = await prepareModelSuggestion({
        correctionText,
        targetFile,
        modelsDir,
        billingProject,
        session,
      });

      console.log(`  This requires editing ${result.targetFile}.`);
      console.log("");
      console.log("  Find this line:");
      for (const line of result.findLine.split("\n")) {
        console.log(`    ${line}`);
      }
      console.log("");
      console.log("  Replace with:");
      for (const line of result.replaceLine.split("\n")) {
        console.log(`    ${line}`);
      }
      console.log("");

      if (!result.compileOk) {
        console.log("  ⚠ Warning: the suggested edit may not compile. Verify after applying.");
      }

      console.log("  After editing:");
      console.log("    1. Save the file");
      console.log(`    2. Run: pnpm cli verify --models ${modelsDir}`);
      console.log("    3. If verify passes, your correction is active");
      console.log("");

      // Log to corrections.json
      await logModelSuggestion({
        result,
        correctionText,
        modelsDir,
        session,
        reasoning: classification.reasoning,
      });

      console.log(`  ✓ Suggestion logged (ID: ${result.correctionId})`);

      try {
        const copied = await copyToClipboard(result.replaceLine);
        if (copied) {
          console.log("  ✓ Copied replacement to clipboard");
        }
      } catch {
        // Clipboard not available in this environment
      }

      console.log("");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`  Error generating suggestion: ${message}`);
      console.log("");
    }
    return true;
  }

  // ── New term ───────────────────────────────────────────────
  if (classification.type === "new_term") {
    const name = classification.target.newTermName ?? "my_term";
    console.log("  This looks like a new term definition.");
    console.log("");
    console.log(`  Use: pnpm cli define ${name} --description "${correctionText}" --models ${modelsDir}`);
    console.log("");
    return true;
  }

  return false;
}
