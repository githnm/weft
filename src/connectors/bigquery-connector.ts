/**
 * BigQuery implementation of the Connector interface.
 *
 * Encapsulates all BigQuery-specific SQL construction, type mapping,
 * and introspection logic that was previously inline in inspect.ts.
 */

import { BigQuery } from "@google-cloud/bigquery";
import type {
  Connector,
  RawTable,
  RawColumn,
  ColumnStats,
  StatsResult,
  TimeBoundsResult,
  SampleResult,
  DistinctResult,
  FrequencyResult,
  ForeignKey,
  NormalizedType,
  JsonValueType,
  BigQueryConnectorConfig,
} from "./types.js";
import { getJsonExtractExpression } from "./types.js";

// ── Constants ─────────────────────────────────────────────────

/** TABLESAMPLE percentage for large tables */
const SAMPLE_PERCENT = 1;

/** Max distinct values to fetch per column */
const DISTINCT_VALUE_LIMIT = 100;

/** Top-N values to capture by frequency */
const TOP_N_FREQUENCY = 30;

// BQ types that should be skipped (complex/unsupported).
// NOTE: JSON is deliberately NOT skipped — it is sampled so its common keys
// can be exposed as dimensions (see isJsonType / inferJsonKeys).
const SKIPPED_TYPE_PREFIXES = [
  "STRUCT", "RECORD", "ARRAY", "GEOGRAPHY",
  "BIGNUMERIC", "INTERVAL", "RANGE",
];

// BQ time types (for stats query MIN/MAX)
const TIME_TYPES = new Set(["TIMESTAMP", "DATETIME", "DATE"]);

// BQ numeric types (for stats query MIN/MAX)
const NUMERIC_TYPES = new Set([
  "INT64", "FLOAT64", "NUMERIC", "DECIMAL",
  "INTEGER", "FLOAT", "BIGDECIMAL",
]);

// ── Helpers ───────────────────────────────────────────────────

interface QueryResult {
  rows: Record<string, unknown>[];
  bytesProcessed: number;
}

function toISOString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  if (typeof value === "object" && value !== null && "value" in value) {
    return String((value as { value: string }).value);
  }
  return String(value);
}

// ── BigQueryConnector ─────────────────────────────────────────

export class BigQueryConnector implements Connector {
  readonly kind = "bigquery" as const;
  private readonly client: BigQuery;
  private readonly project: string;
  private readonly dataset: string;
  private readonly billing: string;

  constructor(config: BigQueryConnectorConfig) {
    this.project = config.project;
    this.dataset = config.dataset;
    this.billing = config.billingProject;
    this.client = new BigQuery({
      projectId: config.billingProject,
      location: config.location ?? "US",
    });
  }

  datasetProject(): string { return this.project; }
  datasetName(): string { return this.dataset; }
  billingProject(): string { return this.billing; }
  samplePercent(): number { return SAMPLE_PERCENT; }

  // ── Internal query runner ───────────────────────────────────

  private async runQuery(sql: string): Promise<QueryResult> {
    const [job] = await this.client.createQueryJob({ query: sql, useLegacySql: false });
    const [rows] = await job.getQueryResults();
    const [metadata] = await job.getMetadata();
    const stats = (metadata as Record<string, unknown>).statistics as Record<string, unknown> | undefined;
    const bytesProcessed = Number(stats?.totalBytesProcessed ?? 0);
    return { rows: rows as Record<string, unknown>[], bytesProcessed };
  }

  // ── Table reference helpers ─────────────────────────────────

  private tableRef(tableName: string): string {
    return `\`${this.project}\`.\`${this.dataset}\`.\`${tableName}\``;
  }

  private sampledFrom(tableName: string, sampled: boolean): string {
    const ref = this.tableRef(tableName);
    return sampled ? `${ref} TABLESAMPLE SYSTEM (${SAMPLE_PERCENT} PERCENT)` : ref;
  }

  // ── Schema introspection ────────────────────────────────────

  async listTables(): Promise<{ tables: RawTable[]; bytesProcessed: number }> {
    const sql = `SELECT table_name, table_type FROM \`${this.project}\`.\`${this.dataset}\`.INFORMATION_SCHEMA.TABLES ORDER BY table_name`;
    const { rows, bytesProcessed } = await this.runQuery(sql);
    const tables = rows.map((r) => ({
      table_name: String(r.table_name),
      table_type: String(r.table_type),
    }));
    return { tables, bytesProcessed };
  }

  async getColumns(): Promise<{ columns: RawColumn[]; bytesProcessed: number }> {
    const sql = `SELECT table_name, column_name, data_type, is_nullable, ordinal_position FROM \`${this.project}\`.\`${this.dataset}\`.INFORMATION_SCHEMA.COLUMNS ORDER BY table_name, ordinal_position`;
    const { rows, bytesProcessed } = await this.runQuery(sql);
    const columns = rows.map((r) => ({
      table_name: String(r.table_name),
      column_name: String(r.column_name),
      data_type: String(r.data_type),
      is_nullable: String(r.is_nullable),
      ordinal_position: Number(r.ordinal_position),
    }));
    return { columns, bytesProcessed };
  }

  async getTableRowCounts(): Promise<{ counts: Map<string, number>; bytesProcessed: number }> {
    const sql = `SELECT table_id, row_count FROM \`${this.project}\`.\`${this.dataset}\`.__TABLES__`;
    const { rows, bytesProcessed } = await this.runQuery(sql);
    const counts = new Map<string, number>();
    for (const row of rows) {
      counts.set(String(row.table_id), Number(row.row_count ?? 0));
    }
    return { counts, bytesProcessed };
  }

  async getForeignKeys(): Promise<ForeignKey[]> {
    // BigQuery has no foreign key catalog — return empty
    return [];
  }

  async close(): Promise<void> {
    // BigQuery client is stateless — no-op
  }

  // ── Stats ───────────────────────────────────────────────────

  async runStatsQuery(
    tableName: string,
    columns: RawColumn[],
    sampled: boolean,
  ): Promise<StatsResult> {
    const fromClause = this.sampledFrom(tableName, sampled);
    const exprs = ["COUNT(*) AS __total_rows"];

    for (const col of columns) {
      const c = `\`${col.column_name}\``;
      exprs.push(`APPROX_COUNT_DISTINCT(${c}) AS \`${col.column_name}__distinct\``);
      exprs.push(`COUNTIF(${c} IS NULL) AS \`${col.column_name}__nulls\``);

      const upperType = col.data_type.toUpperCase();
      if (TIME_TYPES.has(upperType) || NUMERIC_TYPES.has(upperType)) {
        exprs.push(`MIN(${c}) AS \`${col.column_name}__min\``);
        exprs.push(`MAX(${c}) AS \`${col.column_name}__max\``);
      }
    }

    const sql = `SELECT ${exprs.join(", ")} FROM ${fromClause}`;
    const { rows, bytesProcessed } = await this.runQuery(sql);

    const columnStats = new Map<string, ColumnStats>();
    let totalRows = 0;

    if (rows.length > 0) {
      const row = rows[0];
      totalRows = Number(row.__total_rows ?? 0);
      for (const col of columns) {
        columnStats.set(col.column_name, this.parseColumnStats(row, col));
      }
    }

    return { totalRows, columns: columnStats, bytesProcessed };
  }

  private parseColumnStats(row: Record<string, unknown>, col: RawColumn): ColumnStats {
    const upperType = col.data_type.toUpperCase();
    const stats: ColumnStats = {
      distinct: Number(row[`${col.column_name}__distinct`] ?? 0),
      nulls: Number(row[`${col.column_name}__nulls`] ?? 0),
    };

    if (TIME_TYPES.has(upperType)) {
      stats.timeMin = toISOString(row[`${col.column_name}__min`]);
      stats.timeMax = toISOString(row[`${col.column_name}__max`]);
    } else if (NUMERIC_TYPES.has(upperType)) {
      const minVal = row[`${col.column_name}__min`];
      const maxVal = row[`${col.column_name}__max`];
      if (minVal !== null && minVal !== undefined) stats.numericMin = Number(minVal);
      if (maxVal !== null && maxVal !== undefined) stats.numericMax = Number(maxVal);
    }

    return stats;
  }

  // ── Time bounds ─────────────────────────────────────────────

  async runTimeBoundsQuery(
    tableName: string,
    timeColumns: RawColumn[],
  ): Promise<TimeBoundsResult> {
    const tableRefStr = this.tableRef(tableName);
    const exprs: string[] = [];
    for (const col of timeColumns) {
      const c = `\`${col.column_name}\``;
      exprs.push(`MIN(${c}) AS \`${col.column_name}__min\``);
      exprs.push(`MAX(${c}) AS \`${col.column_name}__max\``);
    }
    const sql = `SELECT ${exprs.join(", ")} FROM ${tableRefStr}`;
    const { rows, bytesProcessed } = await this.runQuery(sql);

    const columns = new Map<string, { min: string; max: string }>();
    if (rows.length > 0) {
      const row = rows[0];
      for (const col of timeColumns) {
        const min = toISOString(row[`${col.column_name}__min`]);
        const max = toISOString(row[`${col.column_name}__max`]);
        if (min && max) {
          columns.set(col.column_name, { min, max });
        }
      }
    }

    return { columns, bytesProcessed };
  }

  // ── Sample rows ─────────────────────────────────────────────

  async getSampleRows(
    tableName: string,
    columns: RawColumn[],
    limit: number,
  ): Promise<SampleResult> {
    const tableRefStr = this.tableRef(tableName);
    const cols = columns.map((c) => `\`${c.column_name}\``).join(", ");
    const sql = `SELECT ${cols} FROM ${tableRefStr} LIMIT ${limit}`;
    const { rows, bytesProcessed } = await this.runQuery(sql);
    return { rows, bytesProcessed };
  }

  // ── Distinct values ─────────────────────────────────────────

  async getDistinctValues(
    tableName: string,
    columnName: string,
    sampled: boolean,
  ): Promise<DistinctResult> {
    const fromClause = this.sampledFrom(tableName, sampled);
    const sql = `SELECT DISTINCT \`${columnName}\` AS val FROM ${fromClause} WHERE \`${columnName}\` IS NOT NULL ORDER BY val LIMIT ${DISTINCT_VALUE_LIMIT}`;

    try {
      const { rows, bytesProcessed } = await this.runQuery(sql);
      return { values: rows.map((r) => String(r.val)), bytesProcessed };
    } catch (err) {
      // If sampled query fails, retry without sampling
      if (sampled) {
        const fallbackSql = `SELECT DISTINCT \`${columnName}\` AS val FROM ${this.tableRef(tableName)} WHERE \`${columnName}\` IS NOT NULL ORDER BY val LIMIT ${DISTINCT_VALUE_LIMIT}`;
        const { rows, bytesProcessed } = await this.runQuery(fallbackSql);
        return { values: rows.map((r) => String(r.val)), bytesProcessed };
      }
      throw err;
    }
  }

  // ── Frequency values ────────────────────────────────────────

  async getTopValuesByFrequency(
    tableName: string,
    columnName: string,
    sampled: boolean,
  ): Promise<FrequencyResult> {
    const fromClause = this.sampledFrom(tableName, sampled);
    const sql = `SELECT \`${columnName}\` AS val, COUNT(*) AS freq FROM ${fromClause} WHERE \`${columnName}\` IS NOT NULL GROUP BY \`${columnName}\` ORDER BY freq DESC LIMIT ${TOP_N_FREQUENCY}`;

    try {
      const { rows, bytesProcessed } = await this.runQuery(sql);
      return {
        values: rows.map((r) => ({ value: String(r.val), freq: Number(r.freq) })),
        bytesProcessed,
      };
    } catch (err) {
      if (sampled) {
        const fallbackSql = `SELECT \`${columnName}\` AS val, COUNT(*) AS freq FROM ${this.tableRef(tableName)} WHERE \`${columnName}\` IS NOT NULL GROUP BY \`${columnName}\` ORDER BY freq DESC LIMIT ${TOP_N_FREQUENCY}`;
        const { rows, bytesProcessed } = await this.runQuery(fallbackSql);
        return {
          values: rows.map((r) => ({ value: String(r.val), freq: Number(r.freq) })),
          bytesProcessed,
        };
      }
      throw err;
    }
  }

  // ── Type normalization ──────────────────────────────────────

  normalizeType(rawType: string): NormalizedType {
    const upper = rawType.toUpperCase();

    // Check for unsupported types first
    if (this.isSkippedType(rawType)) return "unsupported";

    // Time types
    if (upper === "TIMESTAMP") return "timestamp";
    if (upper === "DATETIME") return "datetime";
    if (upper === "DATE") return "date";
    if (upper === "TIME") return "time";

    // Numeric types
    if (upper === "INT64" || upper === "INTEGER") return "integer";
    if (upper === "FLOAT64" || upper === "FLOAT" || upper === "NUMERIC" || upper === "DECIMAL" || upper === "BIGDECIMAL") return "float";

    // String types
    if (upper === "STRING") return "string";
    if (upper === "BYTES") return "bytes";

    // Boolean
    if (upper === "BOOL" || upper === "BOOLEAN") return "boolean";

    // JSON document type — sampled for key discovery, not skipped
    if (upper === "JSON") return "json";

    return "unsupported";
  }

  isSkippedType(rawType: string): boolean {
    const upper = rawType.toUpperCase();
    if (SKIPPED_TYPE_PREFIXES.some((p) => upper === p || upper.startsWith(p + "<"))) return true;
    // Skip any parameterized/templated type (contains angle brackets)
    if (upper.includes("<")) return true;
    return false;
  }

  isJsonType(rawType: string): boolean {
    return rawType.toUpperCase() === "JSON";
  }

  // ── JSON key extraction ─────────────────────────────────────

  jsonExtractExpression(column: string, path: string[], valueType: JsonValueType, nativeType?: string): string {
    return getJsonExtractExpression("bigquery", column, path, valueType, nativeType);
  }

  // ── Aggregate safety ────────────────────────────────────────

  aggregateSafeExpression(columnName: string, nativeType: string): string | null {
    // BigQuery types map cleanly to Malloy's legal aggregate types.
    // If the type is skipped/unsupported/JSON, it's un-aggregatable as a whole.
    if (this.isSkippedType(nativeType)) return null;
    const normalized = this.normalizeType(nativeType);
    if (normalized === "unsupported" || normalized === "json") return null;
    return columnName;
  }

  // ── Malloy integration ──────────────────────────────────────

  malloyConnectionName(): string {
    return "bigquery";
  }

  malloyTableSource(tableName: string): string {
    return `bigquery.table('${this.project}.${this.dataset}.${tableName}')`;
  }
}
