import fs from "node:fs/promises";
import path from "node:path";
import { createConnector } from "../../connectors/factory.js";
import type { Connector } from "../../connectors/types.js";
import { inspectDataset } from "../../introspect/inspect.js";
import { classifyDataset } from "../../introspect/classify.js";
import { generateFiles } from "../../introspect/generate.js";
import { generateMetadata } from "../../introspect/metadata.js";
import type { IntrospectOptions } from "../../introspect/types.js";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export async function runIntrospect(
  connector: Connector,
  outputDir: string,
  options: IntrospectOptions,
): Promise<void> {
  // === Pass A: Inspection ===
  console.log("\n=== Pass A: Inspecting BigQuery dataset ===\n");

  const { inspection, metadataBytesScanned } = await inspectDataset(connector, options);

  const jsonPath = path.join(outputDir, "inspection.json");
  await fs.mkdir(outputDir, { recursive: true });
  await fs.writeFile(jsonPath, JSON.stringify(inspection, null, 2), "utf-8");
  console.log(`\n  Wrote ${jsonPath}`);

  const totalColumns = inspection.tables.reduce((sum, t) => sum + t.columns.length, 0);
  const tbScanned = inspection.bytes_scanned / 1e12;
  const estimatedCost = tbScanned * 5;

  console.log("\n  Pass A summary:");
  console.log(`    Tables inspected:  ${inspection.tables.length}`);
  console.log(`    Tables skipped:    ${inspection.skipped_tables.length}`);
  console.log(`    Columns inspected: ${totalColumns}`);
  console.log(`    Bytes scanned:     ${formatBytes(inspection.bytes_scanned)}`);
  if (metadataBytesScanned > 0) {
    console.log(`    Metadata bytes:    ${formatBytes(metadataBytesScanned)} (distinct values)`);
  }
  console.log(`    Estimated cost:    $${estimatedCost.toFixed(4)}`);

  if (inspection.bytes_scanned > 10 * 1024 ** 3) {
    console.warn("\n  ⚠ WARNING: Over 10 GB scanned. Review query costs before re-running.");
  }

  if (inspection.warnings && inspection.warnings.length > 0) {
    console.log(`\n  Warnings (${inspection.warnings.length}):`);
    for (const warning of inspection.warnings) {
      console.log(`    - ${warning}`);
    }
  } else {
    console.log("\n  Warnings: none.");
  }

  // === Pass B: Classification + Generation ===
  console.log("\n=== Pass B: Generating Malloy models ===\n");

  const classification = classifyDataset(inspection);
  await generateFiles(classification, inspection, outputDir);

  const joinCount = classification.inferred_joins.length;
  const ambiguousCount = classification.tables.reduce(
    (sum, t) => sum + t.columns.filter((c) => c.ambiguous).length,
    0
  );

  console.log("\n  Pass B summary:");
  console.log(`    .malloy files:     ${classification.tables.length}`);
  console.log(`    Inferred joins:    ${joinCount}`);
  console.log(`    Ambiguous columns: ${ambiguousCount}`);

  // === Pass C: Metadata ===
  console.log("\n=== Pass C: Generating metadata ===\n");

  const metadataPath = path.join(outputDir, "metadata.json");
  generateMetadata(inspection, metadataPath);
  console.log(`  Wrote ${metadataPath}`);

  console.log(`\n  Done. Review ${path.join(outputDir, "review.md")} for details.\n`);
}

export async function runRefreshMetadata(options: { modelsDir: string }): Promise<void> {
  const inspectionPath = path.join(options.modelsDir, "inspection.json");
  const metadataPath = path.join(options.modelsDir, "metadata.json");

  console.log(`\n=== Pass C: Refreshing metadata from ${inspectionPath} ===\n`);

  let raw: string;
  try {
    raw = await fs.readFile(inspectionPath, "utf-8");
  } catch {
    throw new Error(
      `Cannot read ${inspectionPath}\n` +
        "Run 'pnpm cli introspect' first to generate inspection.json.",
    );
  }

  const inspection = JSON.parse(raw);
  generateMetadata(inspection, metadataPath);

  console.log(`  Wrote ${metadataPath}`);
  console.log("");
}
