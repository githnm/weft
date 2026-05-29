import path from "node:path";
import { simulateChange } from "../../context/simulate.js";
import { resolveSemanticModelsDir } from "../../models/manifest.js";

export interface ModelWhatIfOptions {
  name: string;
  change: string;
  semanticModelsDir?: string;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
  location?: string;
}

function fmt(n: number | null): string {
  return n === null ? "—" : n.toLocaleString();
}

/**
 * `model whatif` — simulate a proposed change across the model's whole ask
 * history and report the real recomputed impact.
 */
export async function runModelWhatif(options: ModelWhatIfOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));

  console.log(`\n  What if: "${options.change}"`);
  console.log(`  Model:   ${options.name}`);
  console.log("  Re-running affected questions from the trace history...\n");

  const report = await simulateChange({
    modelName: options.name,
    semanticModelsDir,
    proposedChange: options.change,
    billingProject: options.billingProject,
    location: options.location,
  });

  if (report.error && !report.feasible) {
    console.error(`  ✗ ${report.summary}`);
    if (report.error !== report.summary) console.error(`    ${report.error}`);
    if (report.suggestion) {
      console.log("");
      console.log("  Next step:");
      for (const line of report.suggestion.split("\n")) console.log(`    ${line}`);
    }
    console.log(`\n  (LLM usage: ${report.usage.inputTokens} in / ${report.usage.outputTokens} out)\n`);
    return;
  }

  if (report.changedEntities.length > 0) {
    console.log("  Changes to the model:");
    for (const e of report.changedEntities) {
      const sign = e.action === "added" ? "+" : e.action === "removed" ? "-" : "~";
      console.log(`    ${sign} ${e.type}: ${e.name}`);
    }
    console.log("");
  }

  console.log(`  ${report.summary}`);
  console.log("");

  const changed = report.deltas.filter((d) => d.status === "changed");
  if (changed.length > 0) {
    console.log("  Answers that change:");
    for (const d of changed) {
      const q = d.question.length > 60 ? d.question.slice(0, 57) + "..." : d.question;
      const metric = d.metric ? ` [${d.metric}]` : "";
      const pct = d.deltaPct === null ? "" : ` (${d.deltaPct >= 0 ? "+" : ""}${d.deltaPct.toFixed(2)}%)`;
      console.log(`    • ${q}${metric}`);
      console.log(`        ${fmt(d.before)} → ${fmt(d.after)}${pct}   rows ${fmt(d.rowsBefore)} → ${fmt(d.rowsAfter)}`);
    }
    console.log("");
  }

  if (report.unanswerable.length > 0) {
    console.log("  Questions that become UNANSWERABLE:");
    for (const u of report.unanswerable) {
      const q = u.question.length > 60 ? u.question.slice(0, 57) + "..." : u.question;
      console.log(`    ✗ ${q}`);
      console.log(`        ${u.reason}`);
    }
    console.log("");
  }

  const baselineFailed = report.deltas.filter((d) => d.status === "baseline_failed");
  if (baselineFailed.length > 0) {
    console.log(`  ⚠ ${baselineFailed.length} historical question(s) no longer run against the current model (skipped).`);
    console.log("");
  }

  if (report.netSummary) {
    console.log(`  ${report.netSummary}`);
    console.log("");
  }

  console.log(`  (LLM usage: ${report.usage.inputTokens} in / ${report.usage.outputTokens} out)\n`);
}
