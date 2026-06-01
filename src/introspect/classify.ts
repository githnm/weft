import type {
  InspectionResult,
  ColumnInspection,
  ClassifiedColumn,
  ClassifiedTable,
  ClassificationResult,
  InferredJoin,
  ColumnRole,
} from "./types.js";
import type { ForeignKey } from "../connectors/types.js";
import {
  getNormalizedType,
  isNumericNormalized,
  isTimeNormalized,
} from "../connectors/types.js";

const ID_PATTERN = /^id$|^(.+?)(?:_id|_key|_uuid)$/;
const TIME_NAME_PATTERN = /(?:_at|_date|_timestamp|_time)$/;
const MEASURE_SUM_PATTERN = /(?:_amount|_revenue|_cost|_price|_total|_value)$/;
const MEASURE_COUNT_PATTERN = /(?:_count|_qty|_quantity|_num)$/;

function singularize(word: string): string {
  if (word.endsWith("ies")) return word.slice(0, -3) + "y";
  if (word.endsWith("ses")) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

function matchesTableSingular(stem: string, tableName: string): boolean {
  if (stem === singularize(tableName)) return true;
  const parts = tableName.split("_");
  return stem === singularize(parts[parts.length - 1]);
}

export function classifyColumn(col: ColumnInspection, tableName: string): ClassifiedColumn {
  const base = { ...col };
  const name = col.name;
  const nt = getNormalizedType(col);

  // a. ID pattern
  const idMatch = name.match(ID_PATTERN);
  if (idMatch) {
    if (name === "id") {
      return { ...base, role: "primary_key" };
    }
    const stem = idMatch[1]!;
    if (matchesTableSingular(stem, tableName)) {
      return { ...base, role: "primary_key" };
    }
    return { ...base, role: "foreign_key" };
  }

  // b. Time type
  if (isTimeNormalized(nt)) {
    return { ...base, role: "time_dimension" };
  }

  // c. Time name pattern
  if (TIME_NAME_PATTERN.test(name)) {
    return { ...base, role: "time_dimension" };
  }

  // d. Measure (sum) by name — amount/revenue/cost/price/total/value
  if (MEASURE_SUM_PATTERN.test(name)) {
    return { ...base, role: "measure", default_aggregation: "sum" };
  }

  // e. Measure (sum) by name — count/qty/quantity/num
  if (MEASURE_COUNT_PATTERN.test(name)) {
    return { ...base, role: "measure", default_aggregation: "sum" };
  }

  // f-g. Numeric type by cardinality
  if (isNumericNormalized(nt)) {
    if (col.distinct_count < 50) {
      const result: ClassifiedColumn = { ...base, role: "dimension" };
      if (col.distinct_count > 20) {
        result.ambiguous = true;
        result.ambiguity_reason = `numeric with ${col.distinct_count} distinct values (threshold: 50)`;
      }
      return result;
    }
    const result: ClassifiedColumn = { ...base, role: "measure", default_aggregation: "sum" };
    if (col.distinct_count < 100) {
      result.ambiguous = true;
      result.ambiguity_reason = `numeric with ${col.distinct_count} distinct values — could be dimension`;
    }
    return result;
  }

  // h-i. STRING by cardinality
  if (nt === "string") {
    if (col.distinct_count < 1000) {
      const result: ClassifiedColumn = { ...base, role: "dimension" };
      if (col.distinct_count > 500) {
        result.ambiguous = true;
        result.ambiguity_reason = `string with ${col.distinct_count} distinct values (threshold: 1000)`;
      }
      return result;
    }
    // High-cardinality string: still emitted as a dimension in the model
    // (queryable for filtering/grouping) but excluded from auto-generated
    // starter views where grouping by thousands of values isn't useful.
    return { ...base, role: "attribute" };
  }

  // j. BOOL
  if (nt === "boolean") {
    return { ...base, role: "dimension" };
  }

  // j2. JSON document — queryable through its discovered keys (json_keys),
  // not as a scalar dimension. Marked "attribute" so it surfaces in catalogs.
  if (nt === "json") {
    return { ...base, role: "attribute" };
  }

  // k. Anything else
  return { ...base, role: "skip", skip_reason: `unhandled type: ${col.type}` };
}

function classifyTable(table: { name: string; malloy_table_source?: string; row_count: number; columns: ColumnInspection[]; skipped_columns: { name: string; type: string; reason: string }[] }): ClassifiedTable {
  const columns = table.columns.map((col) => classifyColumn(col, table.name));
  return {
    name: table.name,
    malloy_table_source: table.malloy_table_source,
    row_count: table.row_count,
    columns,
    skipped_columns: table.skipped_columns,
  };
}

const FK_PREFIXES = ["start_", "end_", "src_", "dst_"];

function findByExactName(
  stem: string,
  nameMap: Map<string, string>,
  selfName: string
): string | null {
  const hit = nameMap.get(stem.toLowerCase());
  return hit && hit.toLowerCase() !== selfName.toLowerCase() ? hit : null;
}

function findBySegment(
  stem: string,
  allTableNames: string[],
  selfName: string
): string | null {
  const lower = stem.toLowerCase();
  for (const tn of allTableNames) {
    if (tn.toLowerCase() === selfName.toLowerCase()) continue;
    const segments = tn.toLowerCase().split("_");
    if (segments.some((seg) => singularize(seg) === lower)) return tn;
  }
  return null;
}

export function inferJoins(
  tables: ClassifiedTable[],
  allTableNames: string[],
  catalogForeignKeys?: ForeignKey[],
): InferredJoin[] {
  const nameMap = new Map<string, string>();
  for (const n of allTableNames) {
    nameMap.set(n.toLowerCase(), n);
  }

  const tableByName = new Map<string, ClassifiedTable>();
  for (const t of tables) {
    tableByName.set(t.name.toLowerCase(), t);
  }

  const joins: InferredJoin[] = [];

  // Track which source_table.source_column pairs have catalog FKs
  // so the heuristic pass doesn't duplicate them
  const catalogCovered = new Set<string>();

  // ── Phase 1: Real FK constraints from catalog (high confidence) ──
  if (catalogForeignKeys && catalogForeignKeys.length > 0) {
    for (const fk of catalogForeignKeys) {
      // Only include FKs where both tables are in the inspected set
      if (!nameMap.has(fk.source_table.toLowerCase())) continue;
      if (!nameMap.has(fk.target_table.toLowerCase())) continue;

      const key = `${fk.source_table}.${fk.source_column}`;
      catalogCovered.add(key);

      joins.push({
        source_table: fk.source_table,
        source_column: fk.source_column,
        target_table: fk.target_table,
        target_column: fk.target_column,
        confidence: "high",
      });
    }
  }

  // ── Phase 2: Heuristic FK inference (existing logic) ──
  for (const table of tables) {
    for (const col of table.columns) {
      if (col.role !== "foreign_key") continue;

      // Skip if already covered by a real catalog FK
      const key = `${table.name}.${col.name}`;
      if (catalogCovered.has(key)) continue;

      const idMatch = col.name.match(ID_PATTERN);
      if (!idMatch || !idMatch[1]) continue;
      const rawStem = idMatch[1];

      const stems = [rawStem];
      for (const prefix of FK_PREFIXES) {
        if (rawStem.startsWith(prefix)) {
          stems.push(rawStem.slice(prefix.length));
        }
      }

      let match: { tableName: string; confidence: "high" | "medium" } | null = null;

      for (const stem of stems) {
        if (match) break;
        const isRaw = stem === rawStem;

        const exact = findByExactName(stem, nameMap, table.name);
        if (exact) { match = { tableName: exact, confidence: isRaw ? "high" : "medium" }; break; }

        const plural = findByExactName(stem + "s", nameMap, table.name);
        if (plural) { match = { tableName: plural, confidence: "medium" }; break; }

        for (const variant of ["dim_" + stem, stem + "_dim"]) {
          const dim = findByExactName(variant, nameMap, table.name);
          if (dim) { match = { tableName: dim, confidence: "medium" }; break; }
        }
        if (match) break;

        const seg = findBySegment(stem, allTableNames, table.name);
        if (seg) { match = { tableName: seg, confidence: "medium" }; break; }
      }

      if (match) {
        const targetTable = tableByName.get(match.tableName.toLowerCase());
        const targetPk = targetTable?.columns.find((c) => c.role === "primary_key");

        joins.push({
          source_table: table.name,
          source_column: col.name,
          target_table: match.tableName,
          target_column: targetPk?.name ?? "id",
          confidence: match.confidence,
        });
      }
    }
  }

  return joins;
}

export function classifyDataset(inspection: InspectionResult): ClassificationResult {
  const allTableNames = [
    ...inspection.tables.map((t) => t.name),
    ...inspection.skipped_tables.map((t) => t.name),
  ];

  const tables = inspection.tables.map((t) => classifyTable(t));
  const inferred_joins = inferJoins(tables, allTableNames, inspection.foreign_keys);

  return {
    connector_kind: inspection.connector_kind,
    dataset_project: inspection.dataset_project,
    dataset_name: inspection.dataset_name,
    tables,
    skipped_tables: inspection.skipped_tables,
    inferred_joins,
  };
}
