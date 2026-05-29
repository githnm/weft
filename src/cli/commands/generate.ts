import fs from "node:fs/promises";
import path from "node:path";
import { classifyDataset } from "../../introspect/classify.js";
import { generateFiles } from "../../introspect/generate.js";
import type { InspectionResult } from "../../introspect/types.js";

export async function runGenerate(options: { from: string; outputDir: string }): Promise<void> {
  console.log(`\n=== Generating Malloy models from ${options.from} ===\n`);

  const raw = await fs.readFile(options.from, "utf-8");
  const inspection: InspectionResult = JSON.parse(raw);

  const classification = classifyDataset(inspection);
  await generateFiles(classification, inspection, options.outputDir);

  const joinCount = classification.inferred_joins.length;
  const unmatchedFks = classification.tables.reduce(
    (sum, t) => sum + t.columns.filter((c) => c.role === "foreign_key").length,
    0
  ) - joinCount;
  const ambiguousCount = classification.tables.reduce(
    (sum, t) => sum + t.columns.filter((c) => c.ambiguous).length,
    0
  );

  console.log("\n  Summary:");
  console.log(`    .malloy files:     ${classification.tables.length}`);
  console.log(`    Inferred joins:    ${joinCount}`);
  console.log(`    Unmatched FKs:     ${unmatchedFks}`);
  console.log(`    Ambiguous columns: ${ambiguousCount}`);
  console.log(`\n  Done. Review ${path.join(options.outputDir, "review.md")} for details.\n`);
}
