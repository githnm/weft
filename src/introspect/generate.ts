import fs from "node:fs/promises";
import path from "node:path";
import type {
  ClassificationResult,
  ClassifiedTable,
  ClassifiedColumn,
  InferredJoin,
  InspectionResult,
} from "./types.js";
import { getNormalizedType } from "../connectors/types.js";

function measureName(columnName: string, agg: string): string {
  if (columnName.startsWith("total_")) return `${columnName}_${agg}`;
  if (agg === "sum") return `total_${columnName}`;
  return `${agg}_${columnName}`;
}

function joinAlias(fkColumn: string): string {
  return fkColumn.replace(/(_id|_key|_uuid)$/, "");
}

function generateMalloySource(
  table: ClassifiedTable,
  joins: InferredJoin[],
  datasetProject: string,
  datasetName: string,
  connectorKind?: string,
): string {
  // Use malloy_table_source if available (connector-agnostic),
  // fall back to BigQuery format for legacy inspection data
  const sourceExpr = table.malloy_table_source ??
    `bigquery.table('${datasetProject}.${datasetName}.${table.name}')`;

  const lines: string[] = [];

  // Imports for matched (non-commented) joins
  const matchedJoins = joins.filter((j) => j.source_table === table.name);
  const importTargets = new Set(matchedJoins.map((j) => j.target_table));
  for (const target of importTargets) {
    lines.push(`import "${target}.malloy"`);
  }
  if (importTargets.size > 0) {
    lines.push("");
  }

  lines.push(`source: ${table.name} is ${sourceExpr} extend {`);

  // Primary key
  const pk = table.columns.find((c) => c.role === "primary_key");
  if (pk) {
    lines.push(`  primary_key: ${pk.name}`);
  }

  // Joins — every FK column gets a real declaration (or commented TODO)
  const fkColumns = table.columns.filter((c) => c.role === "foreign_key");
  const joinByFk = new Map<string, InferredJoin>();
  for (const j of joins.filter((j) => j.source_table === table.name)) {
    joinByFk.set(j.source_column, j);
  }

  if (fkColumns.length > 0) {
    lines.push("");
    for (const fk of fkColumns) {
      const alias = joinAlias(fk.name);
      const join = joinByFk.get(fk.name);
      if (join) {
        lines.push(`  join_one: ${alias} is ${join.target_table}`);
        lines.push(`    on ${fk.name} = ${alias}.${join.target_column}`);
        if (join.confidence === "high" && connectorKind === "postgres") {
          lines.push(`  // CATALOG FK (confidence: ${join.confidence}): real constraint from pg catalog`);
        } else if (connectorKind === "postgres") {
          lines.push(`  // INFERRED (confidence: ${join.confidence}): no FK constraint found in pg catalog`);
        } else {
          lines.push(`  // INFERRED (confidence: ${join.confidence}): no FK exists in BigQuery`);
        }
      } else {
        lines.push(`  // TODO: no matching table found for ${fk.name}`);
        lines.push(`  // join_one: ${alias} is ??? on ${fk.name} = ???`);
      }
    }
  }

  // Source column inventory — listed as comments so the agent knows what's
  // available without emitting redundant `dimension: X is X` declarations
  // (Malloy rejects those as redefinitions since the columns already exist
  // on the source table). These columns are usable directly in queries.
  const dimensions = table.columns.filter((c) => c.role === "dimension");
  const attributes = table.columns.filter((c) => c.role === "attribute");
  const timeDimCols = table.columns.filter((c) => c.role === "time_dimension");
  const measureCols = table.columns.filter((c) => c.role === "measure");
  const fkCols = table.columns.filter((c) => c.role === "foreign_key");

  const hasInventory = dimensions.length > 0 || attributes.length > 0 ||
    timeDimCols.length > 0 || measureCols.length > 0;

  if (hasInventory) {
    lines.push("");
    lines.push("  // Source columns (all queryable — no redeclaration needed):");
    if (pk) {
      lines.push(`  //   pk: ${pk.name}`);
    }
    if (fkCols.length > 0) {
      lines.push(`  //   fk: ${fkCols.map((c) => c.name).join(", ")}`);
    }
    if (dimensions.length > 0) {
      lines.push(`  //   dimension: ${dimensions.map((c) => c.name).join(", ")}`);
    }
    if (attributes.length > 0) {
      lines.push(`  //   attribute: ${attributes.map((c) => c.name).join(", ")}`);
    }
    if (timeDimCols.length > 0) {
      lines.push(`  //   time: ${timeDimCols.map((c) => c.name).join(", ")}`);
    }
    if (measureCols.length > 0) {
      lines.push(`  //   numeric: ${measureCols.map((c) => c.name).join(", ")}`);
    }
  }

  // Time dimensions — derived computed fields for every time column
  if (timeDimCols.length > 0) {
    lines.push("");
    for (const col of timeDimCols) {
      const nt = getNormalizedType(col);
      if (nt === "timestamp" || nt === "datetime") {
        lines.push(`  dimension: ${col.name}_date is ${col.name}::date`);
        lines.push(`  dimension: ${col.name}_month is ${col.name}.month`);
      } else if (nt === "date") {
        lines.push(`  dimension: ${col.name}_month is ${col.name}.month`);
      }
    }
  }

  // Measures
  lines.push("");
  lines.push("  measure: row_count is count()");
  for (const col of measureCols) {
    const agg = col.default_aggregation ?? "sum";
    const mName = measureName(col.name, agg);
    lines.push(`  measure: ${mName} is ${col.name}.${agg}()`);
  }

  // Starter view — only uses low-cardinality dimensions, not attributes
  const firstDim = dimensions[0] ?? timeDimCols[0];
  const firstMeasure = measureCols[0];

  if (firstDim) {
    const firstDimNt = getNormalizedType(firstDim);
    const groupByCol =
      firstDim.role === "time_dimension" && (firstDimNt === "timestamp" || firstDimNt === "datetime")
        ? `${firstDim.name}_date`
        : firstDim.name;

    lines.push("");
    lines.push(`  view: by_${groupByCol} is {`);
    lines.push(`    group_by: ${groupByCol}`);
    const aggs = ["row_count"];
    if (firstMeasure) {
      aggs.push(measureName(firstMeasure.name, firstMeasure.default_aggregation ?? "sum"));
    }
    lines.push(`    aggregate: ${aggs.join(", ")}`);
    lines.push("    limit: 10");
    lines.push("  }");
  }

  lines.push("}");
  return lines.join("\n");
}

function generateReviewMd(
  classification: ClassificationResult,
  inspection: InspectionResult
): string {
  const lines: string[] = [];
  const { tables, skipped_tables, inferred_joins } = classification;

  lines.push("# Introspection Review");
  lines.push("");
  lines.push(`**Dataset:** ${inspection.dataset_project}.${inspection.dataset_name}`);
  lines.push(`**Inspected:** ${inspection.inspected_at}`);
  lines.push(`**Bytes scanned:** ${formatBytes(inspection.bytes_scanned)}`);
  if (inspection.connector_kind !== "postgres") {
    lines.push(`**Estimated cost:** $${((inspection.bytes_scanned / 1e12) * 5).toFixed(4)}`);
  }
  lines.push("");

  // Tables inspected
  lines.push("## Tables inspected");
  lines.push("");
  lines.push("| Table | Rows | Columns | Skipped columns |");
  lines.push("|-------|------|---------|-----------------|");
  for (const t of tables) {
    lines.push(`| ${t.name} | ${t.row_count.toLocaleString()} | ${t.columns.length} | ${t.skipped_columns.length} |`);
  }
  lines.push("");

  // Tables skipped
  lines.push("## Tables skipped");
  lines.push("");
  if (skipped_tables.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Table | Reason |");
    lines.push("|-------|--------|");
    for (const t of skipped_tables) {
      lines.push(`| ${t.name} | ${t.reason} |`);
    }
  }
  lines.push("");

  // Inferred joins
  lines.push("## Inferred joins");
  lines.push("");
  if (inferred_joins.length === 0) {
    lines.push("None detected.");
  } else {
    lines.push("| Source table | Column | Target table | Confidence |");
    lines.push("|-------------|--------|--------------|------------|");
    for (const j of inferred_joins) {
      lines.push(`| ${j.source_table} | ${j.source_column} | ${j.target_table} | ${j.confidence} |`);
    }
  }
  lines.push("");

  // Ambiguous columns
  lines.push("## Ambiguous columns");
  lines.push("");
  const ambiguous: Array<{ table: string; col: ClassifiedColumn }> = [];
  for (const t of tables) {
    for (const c of t.columns) {
      if (c.ambiguous) ambiguous.push({ table: t.name, col: c });
    }
  }
  if (ambiguous.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Table.Column | Type | Classified as | Reason |");
    lines.push("|-------------|------|---------------|--------|");
    for (const { table, col } of ambiguous) {
      lines.push(`| ${table}.${col.name} | ${col.type} | ${col.role} | ${col.ambiguity_reason} |`);
    }
  }
  lines.push("");

  // Skipped columns
  lines.push("## Skipped columns");
  lines.push("");
  const allSkipped: Array<{ table: string; name: string; type: string; reason: string }> = [];
  for (const t of tables) {
    for (const c of t.skipped_columns) {
      allSkipped.push({ table: t.name, ...c });
    }
    for (const c of t.columns) {
      if (c.role === "skip") {
        allSkipped.push({ table: t.name, name: c.name, type: c.type, reason: c.skip_reason ?? "unknown" });
      }
    }
  }
  if (allSkipped.length === 0) {
    lines.push("None.");
  } else {
    lines.push("| Table.Column | Type | Reason |");
    lines.push("|-------------|------|--------|");
    for (const s of allSkipped) {
      lines.push(`| ${s.table}.${s.name} | ${s.type} | ${s.reason} |`);
    }
  }
  lines.push("");

  // Suggested next steps
  lines.push("## Suggested next steps");
  lines.push("");
  lines.push("- [ ] Review ambiguous columns and reclassify if needed");
  lines.push("- [ ] Uncomment inferred joins after verifying relationships");
  lines.push("- [ ] Add descriptions to sources and dimensions");
  lines.push("- [ ] Create cross-table exploration views");
  lines.push("- [ ] Add filters for common query patterns");
  lines.push("- [ ] Run each .malloy file to verify it compiles");
  lines.push("");

  return lines.join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

export async function generateFiles(
  classification: ClassificationResult,
  inspection: InspectionResult,
  outputDir: string
): Promise<void> {
  await fs.mkdir(outputDir, { recursive: true });

  for (const table of classification.tables) {
    const joins = classification.inferred_joins.filter((j) => j.source_table === table.name);
    const malloy = generateMalloySource(
      table,
      joins,
      classification.dataset_project,
      classification.dataset_name,
      classification.connector_kind,
    );
    const filePath = path.join(outputDir, `${table.name}.malloy`);
    await fs.writeFile(filePath, malloy + "\n", "utf-8");
    console.log(`  Wrote ${filePath}`);
  }

  const review = generateReviewMd(classification, inspection);
  const reviewPath = path.join(outputDir, "review.md");
  await fs.writeFile(reviewPath, review, "utf-8");
  console.log(`  Wrote ${reviewPath}`);
}
