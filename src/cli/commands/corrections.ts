import { loadCorrections, getCorrection } from "../../correct/store.js";
import { rollbackTermUpdate } from "../../correct/term-update.js";

export async function runCorrectionsList(options: { modelsDir: string }): Promise<void> {
  const store = await loadCorrections(options.modelsDir);
  const entries = Object.entries(store);

  if (entries.length === 0) {
    console.log("\n  No corrections recorded.\n");
    return;
  }

  // Sort by date descending
  entries.sort(([, a], [, b]) => b.appliedAt.localeCompare(a.appliedAt));

  // Column widths
  const dateW = 12;
  const targetW = 18;
  const typeW = 14;
  const descW = 40;

  console.log("");
  console.log(
    `  ${"Date".padEnd(dateW)}  ${"Target".padEnd(targetW)}  ${"Type".padEnd(typeW)}  Description`,
  );
  console.log(
    `  ${"─".repeat(dateW)}  ${"─".repeat(targetW)}  ${"─".repeat(typeW)}  ${"─".repeat(descW)}`,
  );

  for (const [id, record] of entries) {
    const date = record.appliedAt.slice(0, 10);
    const target = (record.targetTerm ?? record.targetFile ?? "—").slice(0, targetW);
    const type = record.type === "term_update" ? "term_update" : "model_sug.";
    const desc = record.description.slice(0, descW);
    console.log(
      `  ${date.padEnd(dateW)}  ${target.padEnd(targetW)}  ${type.padEnd(typeW)}  ${desc}`,
    );
  }
  console.log("");
}

export async function runCorrectionsShow(options: {
  correctionId: string;
  modelsDir: string;
}): Promise<void> {
  const record = await getCorrection(options.modelsDir, options.correctionId);
  if (!record) {
    console.log(`\n  Correction "${options.correctionId}" not found.\n`);
    return;
  }

  console.log("\n  Correction details:");
  console.log(`    ID:          ${options.correctionId}`);
  console.log(`    Type:        ${record.type}`);
  console.log(`    Applied at:  ${record.appliedAt}`);
  console.log(`    Description: ${record.description}`);
  console.log("");
  console.log(`    User text:   ${record.userCorrectionText}`);
  console.log(`    Session Q:   ${record.sessionQuestion || "(none)"}`);
  console.log("");

  if (record.targetTerm) {
    console.log(`    Term:        ${record.targetTerm}`);
  }
  if (record.targetFile) {
    console.log(`    File:        ${record.targetFile}`);
  }
  if (record.oldFilter) {
    console.log(`    Old filter:  ${record.oldFilter}`);
  }
  if (record.newFilter) {
    console.log(`    New filter:  ${record.newFilter}`);
  }
  console.log("");

  if (record.numericImpact) {
    const ni = record.numericImpact;
    console.log(`    Numeric impact (${ni.mode}):`);

    if (ni.mode === "scalar_aggregate") {
      for (const agg of ni.aggregates) {
        if (agg.before === agg.after) {
          console.log(`      ${agg.column}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (no change)`);
        } else {
          const sign = agg.deltaPct >= 0 ? "+" : "";
          console.log(`      ${agg.column}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (${sign}${agg.deltaPct.toFixed(2)}%)`);
        }
      }
    } else {
      const rowSign = ni.rowsDeltaPct >= 0 ? "+" : "";
      console.log(`      Rows: ${ni.rowsBefore.toLocaleString()} → ${ni.rowsAfter.toLocaleString()} (${rowSign}${ni.rowsDeltaPct.toFixed(2)}%)`);
      for (const agg of ni.aggregates) {
        const sign = agg.deltaPct >= 0 ? "+" : "";
        console.log(`      Sum of ${agg.column}: ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (${sign}${agg.deltaPct.toFixed(2)}%)`);
      }
    }

    if (ni.noImpactExplanation) {
      console.log(`      ⚠ ${ni.noImpactExplanation}`);
    }
    console.log("");
  }
}

export async function runCorrectionsRollback(options: {
  correctionId: string;
  modelsDir: string;
}): Promise<void> {
  const record = await getCorrection(options.modelsDir, options.correctionId);
  if (!record) {
    console.log(`\n  Correction "${options.correctionId}" not found.\n`);
    return;
  }

  if (record.type === "model_suggestion") {
    console.log("\n  Model suggestions cannot be auto-rolled-back.");
    console.log(`  Edit ${record.targetFile} manually to undo the change.`);
    if (record.oldFilter) {
      console.log("");
      console.log("  Original line:");
      for (const line of record.oldFilter.split("\n")) {
        console.log(`    ${line}`);
      }
    }
    console.log("");
    return;
  }

  try {
    const result = await rollbackTermUpdate({
      correctionId: options.correctionId,
      modelsDir: options.modelsDir,
    });
    console.log(`\n  ✓ Rolled back term "${result.termName}"`);
    console.log(`    Restored filter: ${result.restoredFilter}`);
    console.log("");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  Error: ${message}\n`);
    process.exit(1);
  }
}
