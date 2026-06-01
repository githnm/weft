import type {
  Connector,
  RawColumn,
  RawTable,
  ColumnStats,
} from "../connectors/types.js";
import { isStringNormalized } from "../connectors/types.js";
import type {
  InspectionResult,
  TableInspection,
  ColumnInspection,
  SkippedTable,
  SkippedColumn,
  IntrospectOptions,
} from "./types.js";
import { inferJsonKeys } from "./json-keys.js";

// ── Table filtering ──────────────────────────────────────────

const SKIPPED_TABLE_PATTERNS = [/^stg_/i, /^_airbyte_/i, /^_dbt_/i, /^tmp_/i, /^temp_/i];

const INCLUDED_TABLE_TYPES = new Set(["BASE TABLE", "CLONE", "SNAPSHOT", "EXTERNAL", "MATERIALIZED VIEW"]);

function isSkippedTable(name: string): string | null {
  for (const pattern of SKIPPED_TABLE_PATTERNS) {
    if (pattern.test(name)) return `name matches skip pattern ${pattern.source}`;
  }
  return null;
}

function classifyTableRow(t: RawTable): { status: string; reason?: string } {
  if (!INCLUDED_TABLE_TYPES.has(t.table_type)) {
    return { status: "excluded", reason: "table type" };
  }
  const nameReason = isSkippedTable(t.table_name);
  if (nameReason) {
    return { status: "excluded", reason: "name pattern" };
  }
  return { status: "included" };
}

// ── Thresholds ──────────────────────────────────────────────

/** Max number of low-cardinality columns we'll run distinct-value queries for */
const MAX_DISTINCT_VALUE_QUERIES = 50;
/** Threshold: only fetch distinct values if distinct_count < this */
const LOW_CARDINALITY_THRESHOLD = 50;
/** Medium-cardinality upper bound: skip frequency queries above this */
const MEDIUM_CARDINALITY_THRESHOLD = 500;
/** Top-N values to capture by frequency for medium-cardinality columns */
const MAX_FREQUENCY_QUERIES = 30;

/** Row count above which we use sampling for stats queries */
const SAMPLE_THRESHOLD = 10_000_000;

/** Rows sampled from each JSON/JSONB column to discover its common keys */
const JSON_SAMPLE_ROWS = 500;
/** Only propose JSON keys present in at least this fraction of sampled docs */
const JSON_KEY_FREQUENCY_THRESHOLD = 0.05;

/** Skip enum capture if the longest captured value exceeds this */
const FREE_TEXT_MAX_LENGTH = 60;
/** Skip enum capture if the 75th-percentile value length exceeds this */
const FREE_TEXT_P75_LENGTH = 30;

// ── Data helpers ────────────────────────────────────────────

function toJsonSafe(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "object" && value !== null && "value" in value) {
    return (value as { value: string }).value;
  }
  return String(value);
}

function extractSampleValues(rows: Record<string, unknown>[], columnName: string): unknown[] {
  const seen = new Set<string>();
  const values: unknown[] = [];
  for (const row of rows) {
    if (values.length >= 5) break;
    const val = row[columnName];
    if (val == null) continue;
    const safe = toJsonSafe(val);
    const key = JSON.stringify(safe);
    if (seen.has(key)) continue;
    seen.add(key);
    values.push(safe);
  }
  return values;
}

/** Capture up to 3 JSON documents as compact strings for display. */
function extractJsonSampleValues(rows: Record<string, unknown>[], columnName: string): unknown[] {
  const values: unknown[] = [];
  for (const row of rows) {
    if (values.length >= 3) break;
    const val = row[columnName];
    if (val == null) continue;
    let str: string;
    if (typeof val === "string") {
      str = val;
    } else {
      try {
        str = JSON.stringify(val);
      } catch {
        str = String(val);
      }
    }
    values.push(str.length > 300 ? str.slice(0, 297) + "..." : str);
  }
  return values;
}

/** Compute max and p75 string length from actual captured distinct values */
function computeValueLengthStats(values: string[]): { max: number; p75: number } {
  if (values.length === 0) return { max: 0, p75: 0 };
  const lengths = values.map((v) => v.length).sort((a, b) => a - b);
  const max = lengths[lengths.length - 1];
  const p75Index = Math.max(0, Math.ceil(lengths.length * 0.75) - 1);
  const p75 = lengths[p75Index];
  return { max, p75 };
}

// ── Per-table inspection ────────────────────────────────────

async function inspectTable(
  connector: Connector,
  tableName: string,
  allColumns: RawColumn[],
  sampleRows: number,
  rowCountEstimate: number,
  warnings: string[],
  excludeEnumCols: Set<string>,
): Promise<{ table: TableInspection; bytesProcessed: number; metadataBytes: number }> {
  const tableColumns = allColumns.filter((c) => c.table_name === tableName);

  const supported: RawColumn[] = [];
  const jsonColumns: RawColumn[] = [];
  const skipped: SkippedColumn[] = [];
  for (const col of tableColumns) {
    if (connector.isJsonType(col.data_type)) {
      // JSON/JSONB: not skipped — sampled separately for key discovery so its
      // contents become queryable as connector-aware dimensions.
      jsonColumns.push(col);
    } else if (connector.isSkippedType(col.data_type)) {
      skipped.push({ name: col.column_name, type: col.data_type, reason: "unsupported type" });
      warnings.push(`Skipped stats for ${tableName}.${col.column_name} (${col.data_type} type)`);
    } else {
      supported.push(col);
    }
  }

  let totalBytes = 0;
  let metadataBytes = 0;
  let rowCount = rowCountEstimate;
  const statsMap = new Map<string, ColumnStats>();

  // Decide whether to sample
  const shouldSample = rowCountEstimate > SAMPLE_THRESHOLD;
  let wasSampled = false;

  // ── Stats query (with sampling + fallback) ──────────────────
  if (supported.length > 0) {
    let statsFailed = false;
    let statsError = "";

    // Try batched stats query (sampled if large table)
    try {
      const result = await connector.runStatsQuery(tableName, supported, shouldSample);
      totalBytes += result.bytesProcessed;

      // For sampled tables, use the estimate from row counts (more accurate)
      if (!shouldSample) {
        rowCount = result.totalRows;
      }
      for (const [k, v] of result.columns) {
        statsMap.set(k, v);
      }
      wasSampled = shouldSample;
      if (shouldSample) {
        warnings.push(`Sampled stats for ${tableName} (${rowCountEstimate.toLocaleString()} rows, sample rate ${connector.samplePercent()}%)`);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      // If sampling failed, retry without
      if (shouldSample) {
        try {
          const result = await connector.runStatsQuery(tableName, supported, false);
          totalBytes += result.bytesProcessed;
          rowCount = result.totalRows;
          for (const [k, v] of result.columns) {
            statsMap.set(k, v);
          }
          warnings.push(`TABLESAMPLE failed for ${tableName}, fell back to full scan: ${msg.slice(0, 80)}`);
        } catch (err2: unknown) {
          statsError = err2 instanceof Error ? err2.message : String(err2);
          statsFailed = true;
        }
      } else {
        statsError = msg;
        statsFailed = true;
      }
    }

    // Per-column fallback if batched query failed
    if (statsFailed) {
      warnings.push(`Stats query failed for ${tableName}, trying per-column fallback: ${statsError.slice(0, 100)}`);
      const survivingCols: RawColumn[] = [];
      for (const col of supported) {
        try {
          const result = await connector.runStatsQuery(tableName, [col], false);
          totalBytes += result.bytesProcessed;
          if (rowCount === 0) rowCount = result.totalRows;
          const colStats = result.columns.get(col.column_name);
          if (colStats) statsMap.set(col.column_name, colStats);
          survivingCols.push(col);
        } catch (colErr: unknown) {
          const colMsg = colErr instanceof Error ? colErr.message : String(colErr);
          skipped.push({ name: col.column_name, type: col.data_type, reason: `stats query failed: ${colMsg.slice(0, 80)}` });
          warnings.push(`Skipped stats for ${tableName}.${col.column_name} (${col.data_type}): ${colMsg.slice(0, 80)}`);
        }
      }
      // Replace supported with only surviving columns
      supported.length = 0;
      supported.push(...survivingCols);
    }

    // If we sampled, run precise time bounds query (MIN/MAX are sensitive to sampling)
    const timeColumns = supported.filter((col) => {
      const nt = connector.normalizeType(col.data_type);
      return nt === "timestamp" || nt === "datetime" || nt === "date";
    });
    if (wasSampled && timeColumns.length > 0) {
      try {
        const tbResult = await connector.runTimeBoundsQuery(tableName, timeColumns);
        totalBytes += tbResult.bytesProcessed;
        for (const [colName, bounds] of tbResult.columns) {
          const existing = statsMap.get(colName);
          if (existing) {
            existing.timeMin = bounds.min;
            existing.timeMax = bounds.max;
          }
        }
      } catch {
        warnings.push(`Precise time bounds query failed for ${tableName}, using sampled bounds`);
      }
    }
  }

  // ── Sample data ─────────────────────────────────────────────
  let sampleData: Record<string, unknown>[] = [];
  if (supported.length > 0 && rowCount > 0) {
    const sampleResult = await connector.getSampleRows(tableName, supported, sampleRows);
    totalBytes += sampleResult.bytesProcessed;
    sampleData = sampleResult.rows;
  }

  // ── Enum capture (distinct/frequency values) ────────────────
  const distinctValuesMap = new Map<string, string[]>();
  const truncatedValuesMap = new Map<string, { value: string; freq: number }[]>();
  const skippedEnumReasons = new Map<string, string>();

  const stringCols = supported.filter((col) => {
    const nt = connector.normalizeType(col.data_type);
    return isStringNormalized(nt);
  });

  // Pre-filter: apply --exclude-enum manual overrides before fetching
  const enumCandidates = stringCols.filter((col) => {
    if (excludeEnumCols.has(col.column_name)) {
      skippedEnumReasons.set(col.column_name, "excluded via --exclude-enum");
      warnings.push(`Skipped enum capture for ${tableName}.${col.column_name} (--exclude-enum)`);
      return false;
    }
    return true;
  });

  // Tier 1: low-cardinality (< 50 distinct) — capture all values
  const lowCardCols = enumCandidates.filter((col) => {
    const stats = statsMap.get(col.column_name);
    return stats && stats.distinct > 0 && stats.distinct < LOW_CARDINALITY_THRESHOLD;
  });

  // Tier 2: medium-cardinality (50–500 distinct) — capture top-N by frequency
  const medCardCols = enumCandidates.filter((col) => {
    const stats = statsMap.get(col.column_name);
    return stats && stats.distinct >= LOW_CARDINALITY_THRESHOLD && stats.distinct < MEDIUM_CARDINALITY_THRESHOLD;
  });
  medCardCols.sort((a, b) => {
    const da = statsMap.get(a.column_name)?.distinct ?? 0;
    const db = statsMap.get(b.column_name)?.distinct ?? 0;
    return da - db;
  });
  const medCardToQuery = medCardCols.slice(0, MAX_FREQUENCY_QUERIES);

  // Cost control: skip low-card if too many columns
  if (lowCardCols.length <= MAX_DISTINCT_VALUE_QUERIES) {
    for (const col of lowCardCols) {
      try {
        const { values, bytesProcessed: bDist } = await connector.getDistinctValues(
          tableName, col.column_name, shouldSample,
        );
        metadataBytes += bDist;
        totalBytes += bDist;
        distinctValuesMap.set(col.column_name, values);
      } catch {
        warnings.push(`Failed to fetch distinct values for ${tableName}.${col.column_name}`);
      }
    }
  }

  // Frequency queries for medium-cardinality columns
  for (const col of medCardToQuery) {
    try {
      const { values, bytesProcessed: bFreq } = await connector.getTopValuesByFrequency(
        tableName, col.column_name, shouldSample,
      );
      metadataBytes += bFreq;
      totalBytes += bFreq;
      truncatedValuesMap.set(col.column_name, values);
    } catch {
      warnings.push(`Failed to fetch frequency values for ${tableName}.${col.column_name}`);
    }
  }

  // Post-fetch free-text check — max length > 60 OR p75 > 30 on captured values
  for (const [colName, values] of distinctValuesMap) {
    const { max, p75 } = computeValueLengthStats(values);
    if (max > FREE_TEXT_MAX_LENGTH || p75 > FREE_TEXT_P75_LENGTH) {
      distinctValuesMap.delete(colName);
      skippedEnumReasons.set(colName, `free-text heuristic (max length ${max}, p75 ${p75})`);
      warnings.push(`Skipped enum capture for ${tableName}.${colName} (max length ${max}, p75 ${p75})`);
    }
  }
  for (const [colName, entries] of truncatedValuesMap) {
    const { max, p75 } = computeValueLengthStats(entries.map((e) => e.value));
    if (max > FREE_TEXT_MAX_LENGTH || p75 > FREE_TEXT_P75_LENGTH) {
      truncatedValuesMap.delete(colName);
      skippedEnumReasons.set(colName, `free-text heuristic (max length ${max}, p75 ${p75})`);
      warnings.push(`Skipped enum capture for ${tableName}.${colName} (max length ${max}, p75 ${p75})`);
    }
  }

  // ── Build column results ────────────────────────────────────
  const columns: ColumnInspection[] = supported.map((col) => {
    const stats = statsMap.get(col.column_name) ?? { distinct: 0, nulls: 0 };
    const nt = connector.normalizeType(col.data_type);

    // For sampled stats, scale null_count from the sample ratio
    const effectiveNulls = wasSampled ? Math.round(stats.nulls * (100 / connector.samplePercent())) : stats.nulls;

    const result: ColumnInspection = {
      name: col.column_name,
      type: col.data_type,
      normalized_type: nt,
      nullable: col.is_nullable === "YES",
      distinct_count: stats.distinct,
      null_count: effectiveNulls,
      null_ratio: rowCount > 0 ? effectiveNulls / rowCount : 0,
      sample_values: extractSampleValues(sampleData, col.column_name),
      stats_source: wasSampled ? "sampled" : "full",
    };

    if (stats.timeMin) result.time_min = stats.timeMin;
    if (stats.timeMax) result.time_max = stats.timeMax;
    if (stats.numericMin !== undefined) result.numeric_min = stats.numericMin;
    if (stats.numericMax !== undefined) result.numeric_max = stats.numericMax;

    const dv = distinctValuesMap.get(col.column_name);
    if (dv && dv.length > 0) result.distinct_values = dv;

    const tv = truncatedValuesMap.get(col.column_name);
    if (tv && tv.length > 0) result.distinct_values_truncated = tv;

    const skipReason = skippedEnumReasons.get(col.column_name);
    if (skipReason) result.skipped_enum_reason = skipReason;

    return result;
  });

  // ── JSON/JSONB key discovery ────────────────────────────────
  // Sample each JSON column, infer its common keys (top-level + one nesting
  // level), and emit it as a ColumnInspection carrying json_keys. The keys
  // become connector-aware dimensions at model build.
  if (jsonColumns.length > 0 && rowCount > 0) {
    let jsonRows: Record<string, unknown>[] = [];
    try {
      const jsonSample = await connector.getSampleRows(tableName, jsonColumns, JSON_SAMPLE_ROWS);
      totalBytes += jsonSample.bytesProcessed;
      jsonRows = jsonSample.rows;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      warnings.push(`Failed to sample JSON column(s) in ${tableName}: ${msg.slice(0, 80)}`);
    }

    for (const col of jsonColumns) {
      const rawValues = jsonRows.map((r) => r[col.column_name]);
      const { keys, sampledRows } = inferJsonKeys(rawValues);
      const nonNull = rawValues.filter((v) => v != null).length;
      const exposable = keys.filter(
        (k) => k.kind === "scalar" && k.frequency >= JSON_KEY_FREQUENCY_THRESHOLD,
      ).length;

      const result: ColumnInspection = {
        name: col.column_name,
        type: col.data_type,
        normalized_type: "json",
        nullable: col.is_nullable === "YES",
        distinct_count: 0,
        null_count: jsonRows.length > 0 ? jsonRows.length - nonNull : 0,
        null_ratio: jsonRows.length > 0 ? (jsonRows.length - nonNull) / jsonRows.length : 0,
        sample_values: extractJsonSampleValues(jsonRows, col.column_name),
        stats_source: "sampled",
        json_sampled_rows: sampledRows,
        json_keys: keys,
      };
      columns.push(result);

      warnings.push(
        `Sampled JSON column ${tableName}.${col.column_name} (${col.data_type}): ` +
          `${sampledRows} docs, ${keys.length} key(s) discovered, ${exposable} proposable (≥${Math.round(JSON_KEY_FREQUENCY_THRESHOLD * 100)}%)`,
      );
    }
  }

  return {
    table: {
      name: tableName,
      malloy_table_source: connector.malloyTableSource(tableName),
      row_count: rowCount,
      columns,
      skipped_columns: skipped,
    },
    bytesProcessed: totalBytes,
    metadataBytes,
  };
}

// ── Public API ───────────────────────────────────────────────

export interface InspectResult {
  inspection: InspectionResult;
  metadataBytesScanned: number;
}

/**
 * Detect date-sharded tables (e.g. ga_sessions_20170801) and collapse each
 * shard family into ONE logical wildcard source (ga_sessions_*). BigQuery
 * treats `prefix_*` as a single wildcard table, so we inspect only the latest
 * shard (schemas are identical across shards) instead of all ~366 of them.
 */
export function collapseDateShards(names: string[]): {
  kept: string[];
  groups: Map<string, { logical: string; members: string[] }>;
} {
  const SHARD = /^(.+?)_(\d{8})$/; // <base>_YYYYMMDD
  const byBase = new Map<string, string[]>();
  const nonShard: string[] = [];
  for (const n of names) {
    const m = n.match(SHARD);
    if (m) {
      if (!byBase.has(m[1])) byBase.set(m[1], []);
      byBase.get(m[1])!.push(n);
    } else {
      nonShard.push(n);
    }
  }
  const kept = [...nonShard];
  const groups = new Map<string, { logical: string; members: string[] }>();
  for (const [base, members] of byBase) {
    if (members.length >= 2) {
      members.sort(); // ascending — last is the most recent shard
      const rep = members[members.length - 1];
      kept.push(rep);
      groups.set(rep, { logical: `${base}_*`, members });
    } else {
      kept.push(...members); // a lone date-suffixed table is not a shard family
    }
  }
  return { kept, groups };
}

export async function inspectDataset(
  connector: Connector,
  options: IntrospectOptions,
): Promise<InspectResult> {
  const { sampleRows, onProgress } = options;
  let totalBytes = 0;
  let totalMetadataBytes = 0;
  const warnings: string[] = [];

  onProgress?.({ stage: "listing_tables", message: `Listing tables in ${connector.datasetProject()}.${connector.datasetName()}…` });
  console.log(`  Listing tables in ${connector.datasetProject()}.${connector.datasetName()}...`);
  const { tables: allRawTables, bytesProcessed: b1 } = await connector.listTables();
  totalBytes += b1;

  console.log("");
  console.log(`  ${"TABLE".padEnd(40)} ${"TYPE".padEnd(22)} STATUS`);
  console.log("  " + "-".repeat(80));
  const includedTables: string[] = [];
  const skippedTables: SkippedTable[] = [];
  for (const t of allRawTables) {
    const { status, reason } = classifyTableRow(t);
    const label = status === "included" ? "included" : `excluded (${reason})`;
    console.log(`  ${t.table_name.padEnd(40)} ${t.table_type.padEnd(22)} ${label}`);
    if (status === "included") {
      includedTables.push(t.table_name);
    } else {
      skippedTables.push({ name: t.table_name, reason: reason! });
    }
  }
  console.log("");
  console.log(`  Found ${allRawTables.length} tables (${includedTables.length} included, ${skippedTables.length} skipped)`);

  // Collapse date-sharded tables (ga_sessions_YYYYMMDD → ga_sessions_*) so we
  // inspect one representative shard, not hundreds. BigQuery wildcard tables
  // make the collapsed source directly queryable.
  let shardGroups = new Map<string, { logical: string; members: string[] }>();
  let inspectList = includedTables;
  if (connector.kind === "bigquery") {
    const collapsed = collapseDateShards(includedTables);
    inspectList = collapsed.kept;
    shardGroups = collapsed.groups;
    if (shardGroups.size > 0) {
      const totalShards = [...shardGroups.values()].reduce((s, g) => s + g.members.length, 0);
      const logicals = [...shardGroups.values()].map((g) => g.logical).join(", ");
      const msg = `${totalShards} date-sharded tables collapsed into ${shardGroups.size} wildcard source(s): ${logicals}`;
      warnings.push(msg);
      console.log(`  ${msg}`);
    }
  }

  // Fetch row counts for sampling decisions
  let rowCounts = new Map<string, number>();
  try {
    const { counts, bytesProcessed: bCounts } = await connector.getTableRowCounts();
    totalBytes += bCounts;
    rowCounts = counts;
  } catch {
    warnings.push("Could not fetch row counts from __TABLES__, sampling disabled");
  }

  onProgress?.({ stage: "reading_columns", message: "Reading column metadata…", tablesTotal: inspectList.length, tablesDone: 0 });
  console.log("  Fetching column metadata...");
  const { columns: allColumns, bytesProcessed: b2 } = await connector.getColumns();
  totalBytes += b2;

  // Build per-table exclude-enum sets from --exclude-enum options
  const excludeEnumsByTable = new Map<string, Set<string>>();
  if (options.excludeEnums) {
    for (const entry of options.excludeEnums) {
      const dot = entry.indexOf(".");
      if (dot > 0) {
        const tbl = entry.slice(0, dot);
        const col = entry.slice(dot + 1);
        if (!excludeEnumsByTable.has(tbl)) excludeEnumsByTable.set(tbl, new Set());
        excludeEnumsByTable.get(tbl)!.add(col);
      }
    }
  }

  const tables: TableInspection[] = [];
  for (let idx = 0; idx < inspectList.length; idx++) {
    const tableName = inspectList[idx];
    const group = shardGroups.get(tableName);
    const estimate = rowCounts.get(tableName) ?? 0;
    const sampleNote = estimate > SAMPLE_THRESHOLD ? ` (${estimate.toLocaleString()} rows, will sample)` : "";
    onProgress?.({
      stage: "sampling",
      message: `Reading ${group ? group.logical : tableName} (${idx + 1} of ${inspectList.length})`,
      tablesTotal: inspectList.length,
      tablesDone: idx,
    });
    console.log(`  Inspecting ${tableName}...${sampleNote}${group ? ` → ${group.logical}` : ""}`);
    const { table, bytesProcessed, metadataBytes } = await inspectTable(
      connector,
      tableName,
      allColumns,
      sampleRows,
      estimate,
      warnings,
      excludeEnumsByTable.get(tableName) ?? new Set(),
    );
    totalBytes += bytesProcessed;
    totalMetadataBytes += metadataBytes;
    // For a shard family, present it as the wildcard source and sum row counts.
    if (group) {
      table.name = group.logical;
      table.malloy_table_source = connector.malloyTableSource(group.logical);
      table.row_count = group.members.reduce((s, m) => s + (rowCounts.get(m) ?? 0), 0);
    }
    tables.push(table);
  }

  onProgress?.({ stage: "sampling", message: "Finished reading tables", tablesTotal: inspectList.length, tablesDone: inspectList.length });

  // Fetch real foreign key constraints (Postgres has them; BigQuery returns [])
  let foreignKeys;
  try {
    const fks = await connector.getForeignKeys();
    if (fks.length > 0) {
      foreignKeys = fks;
      console.log(`  Found ${fks.length} foreign key constraint(s)`);
    }
  } catch {
    warnings.push("Could not fetch foreign key constraints from catalog");
  }

  return {
    inspection: {
      connector_kind: connector.kind,
      dataset_project: connector.datasetProject(),
      dataset_name: connector.datasetName(),
      billing_project: connector.billingProject(),
      inspected_at: new Date().toISOString(),
      bytes_scanned: totalBytes,
      tables,
      skipped_tables: skippedTables,
      foreign_keys: foreignKeys,
      warnings,
    },
    metadataBytesScanned: totalMetadataBytes,
  };
}
