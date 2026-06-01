/**
 * DuckDB implementation of the Connector interface.
 *
 * File-based — a connection is a FILE PATH, not a server. Two modes:
 *  - DATABASE file (`.duckdb` / `.db` / `:memory:`): tables come from
 *    information_schema (DuckDB's default schema is `main`).
 *  - DATA file (`.parquet` / `.csv` / `.tsv` / `.json`): the file IS the table.
 *    We connect to `:memory:` and read it via read_parquet/read_csv_auto/…,
 *    deriving columns with `DESCRIBE`. This is the zero-setup path.
 *
 * Introspection uses @duckdb/node-api directly (the same engine Malloy's
 * DuckDBConnection runs on); model compile/execute uses buildMalloyConnection.
 */

import path from "node:path";
import { DuckDBInstance } from "@duckdb/node-api";
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
  DuckDBConnectorConfig,
} from "./types.js";
import { getJsonExtractExpression, getAggregateSafeExpression } from "./types.js";

const SAMPLE_PERCENT = 1;
const DISTINCT_VALUE_LIMIT = 100;
const TOP_N_FREQUENCY = 30;

const DATA_FILE_EXT = new Set([".parquet", ".csv", ".tsv", ".json", ".ndjson", ".jsonl"]);

// ── Type helpers (independent of isSkippedType to avoid recursion) ──

/** Strip DECIMAL(18,3) → DECIMAL, and a trailing [] suffix to detect lists. */
function baseType(raw: string): string {
  return raw.toUpperCase().replace(/\(.+\)$/, "").trim();
}

function duckdbComplex(raw: string): boolean {
  const u = raw.toUpperCase();
  return (
    u.includes("[]") ||
    u.startsWith("STRUCT") ||
    u.startsWith("MAP") ||
    u.startsWith("LIST") ||
    u.startsWith("UNION") ||
    u.startsWith("INTERVAL")
  );
}

const TIME_BASES = new Set(["TIMESTAMP", "TIMESTAMPTZ", "TIMESTAMP WITH TIME ZONE", "DATETIME", "DATE"]);
const NUMERIC_BASES = new Set([
  "TINYINT", "SMALLINT", "INTEGER", "BIGINT", "HUGEINT", "UTINYINT", "USMALLINT", "UINTEGER",
  "UBIGINT", "UHUGEINT", "INT", "INT1", "INT2", "INT4", "INT8", "DOUBLE", "FLOAT", "REAL",
  "DECIMAL", "NUMERIC",
]);

// ── Value coercion from @duckdb/node-api row objects ────────────────

function asNum(v: unknown): number {
  if (typeof v === "bigint") return Number(v);
  if (typeof v === "number") return v;
  return Number(v ?? 0);
}
function asISO(v: unknown): string | undefined {
  if (v === null || v === undefined) return undefined;
  if (v instanceof Date) return v.toISOString();
  return String(v);
}

/**
 * Coerce a @duckdb/node-api cell into a JSON-safe primitive. The driver returns
 * BigInt for BIGINT/HUGEINT and value objects for DECIMAL/TIMESTAMP/etc.; left
 * as-is these break JSON.stringify when the inspection is written to disk.
 */
function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined) return v;
  if (typeof v === "bigint") return Number(v);
  if (v instanceof Date) return v.toISOString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === "object") return String(v); // DECIMAL/TIMESTAMP value objects → their string form
  return v;
}

// ── DuckDBConnector ─────────────────────────────────────────────

export class DuckDBConnector implements Connector {
  readonly kind = "duckdb" as const;
  private readonly filePath: string;
  private readonly isDataFile: boolean;
  private readonly databasePath: string;
  /** For data-file mode: the single synthetic table name + its read expression. */
  private readonly fileTableName: string;
  private readonly fileReadExpr: string;

  private instance: DuckDBInstance | null = null;
  private conn: Awaited<ReturnType<DuckDBInstance["connect"]>> | null = null;

  constructor(config: DuckDBConnectorConfig) {
    this.filePath = config.filePath;
    const ext = path.extname(this.filePath).toLowerCase();
    const isDbFile = ext === ".duckdb" || ext === ".db" || this.filePath === ":memory:";
    this.isDataFile = !isDbFile;
    this.databasePath = this.isDataFile ? ":memory:" : this.filePath;

    if (this.isDataFile) {
      const abs = path.resolve(this.filePath).replace(/'/g, "''");
      const base = path.basename(this.filePath, ext).replace(/[^A-Za-z0-9_]/g, "_") || "data";
      this.fileTableName = base;
      if (ext === ".csv" || ext === ".tsv") this.fileReadExpr = `read_csv_auto('${abs}')`;
      else if (ext === ".json" || ext === ".ndjson" || ext === ".jsonl") this.fileReadExpr = `read_json_auto('${abs}')`;
      else this.fileReadExpr = `read_parquet('${abs}')`;
    } else {
      this.fileTableName = "";
      this.fileReadExpr = "";
    }
  }

  datasetProject(): string { return "duckdb"; }
  datasetName(): string { return path.basename(this.filePath); }
  billingProject(): string { return this.filePath; }
  samplePercent(): number { return SAMPLE_PERCENT; }

  // ── Query runner ──────────────────────────────────────────────

  private async getConn() {
    if (!this.conn) {
      this.instance = await DuckDBInstance.create(this.databasePath);
      this.conn = await this.instance.connect();
    }
    return this.conn;
  }

  private async rows(sql: string): Promise<Record<string, unknown>[]> {
    const c = await this.getConn();
    const reader = await c.runAndReadAll(sql);
    const raw = reader.getRowObjects() as Record<string, unknown>[];
    // Normalize cells to JSON-safe primitives (no BigInt / driver value objects).
    return raw.map((row) => {
      const out: Record<string, unknown> = {};
      for (const k of Object.keys(row)) out[k] = jsonSafe(row[k]);
      return out;
    });
  }

  private quoteIdent(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  /** FROM expression for a table: the file reader (data mode) or the quoted name. */
  private fromExpr(_tableName: string): string {
    return this.isDataFile ? this.fileReadExpr : this.quoteIdent(_tableName);
  }

  private sampledFrom(tableName: string, sampled: boolean): string {
    const ref = this.fromExpr(tableName);
    return sampled ? `${ref} USING SAMPLE ${SAMPLE_PERCENT}%` : ref;
  }

  // ── Schema introspection ──────────────────────────────────────

  async listTables(): Promise<{ tables: RawTable[]; bytesProcessed: number }> {
    if (this.isDataFile) {
      return { tables: [{ table_name: this.fileTableName, table_type: "BASE TABLE" }], bytesProcessed: 0 };
    }
    const rows = await this.rows(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = 'main' ORDER BY table_name`,
    );
    return {
      tables: rows.map((r) => ({ table_name: String(r.table_name), table_type: String(r.table_type ?? "BASE TABLE") })),
      bytesProcessed: 0,
    };
  }

  async getColumns(): Promise<{ columns: RawColumn[]; bytesProcessed: number }> {
    if (this.isDataFile) {
      const desc = await this.rows(`DESCRIBE SELECT * FROM ${this.fileReadExpr}`);
      const columns = desc.map((r, i) => ({
        table_name: this.fileTableName,
        column_name: String(r.column_name),
        data_type: String(r.column_type),
        is_nullable: String(r.null ?? "YES") === "NO" ? "NO" : "YES",
        ordinal_position: i + 1,
      }));
      return { columns, bytesProcessed: 0 };
    }
    const rows = await this.rows(
      `SELECT table_name, column_name, data_type, is_nullable, ordinal_position
       FROM information_schema.columns WHERE table_schema = 'main'
       ORDER BY table_name, ordinal_position`,
    );
    return {
      columns: rows.map((r) => ({
        table_name: String(r.table_name),
        column_name: String(r.column_name),
        data_type: String(r.data_type),
        is_nullable: String(r.is_nullable ?? "YES"),
        ordinal_position: asNum(r.ordinal_position),
      })),
      bytesProcessed: 0,
    };
  }

  async getTableRowCounts(): Promise<{ counts: Map<string, number>; bytesProcessed: number }> {
    // Local engine — full scans are cheap; skip the estimate pass (no sampling).
    return { counts: new Map(), bytesProcessed: 0 };
  }

  async getForeignKeys(): Promise<ForeignKey[]> {
    // Name-matching fallback covers joins (like BigQuery). DuckDB FK catalog
    // exists but is rarely populated for analytical files.
    return [];
  }

  async close(): Promise<void> {
    try {
      this.conn?.disconnectSync?.();
    } catch {
      /* best effort */
    }
    this.conn = null;
    this.instance = null;
  }

  // ── Stats ─────────────────────────────────────────────────────

  async runStatsQuery(tableName: string, columns: RawColumn[], sampled: boolean): Promise<StatsResult> {
    const from = this.sampledFrom(tableName, sampled);
    const exprs = ["COUNT(*) AS __total_rows"];
    for (const col of columns) {
      const c = this.quoteIdent(col.column_name);
      exprs.push(`COUNT(DISTINCT ${c}) AS ${this.quoteIdent(col.column_name + "__distinct")}`);
      exprs.push(`SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) AS ${this.quoteIdent(col.column_name + "__nulls")}`);
      const b = baseType(col.data_type);
      if (TIME_BASES.has(b) || NUMERIC_BASES.has(b)) {
        exprs.push(`MIN(${c}) AS ${this.quoteIdent(col.column_name + "__min")}`);
        exprs.push(`MAX(${c}) AS ${this.quoteIdent(col.column_name + "__max")}`);
      }
    }
    const rows = await this.rows(`SELECT ${exprs.join(", ")} FROM ${from}`);
    const columnStats = new Map<string, ColumnStats>();
    let totalRows = 0;
    if (rows.length > 0) {
      const row = rows[0];
      totalRows = asNum(row.__total_rows);
      for (const col of columns) columnStats.set(col.column_name, this.parseColumnStats(row, col));
    }
    return { totalRows, columns: columnStats, bytesProcessed: 0 };
  }

  private parseColumnStats(row: Record<string, unknown>, col: RawColumn): ColumnStats {
    const b = baseType(col.data_type);
    const stats: ColumnStats = {
      distinct: asNum(row[`${col.column_name}__distinct`]),
      nulls: asNum(row[`${col.column_name}__nulls`]),
    };
    if (TIME_BASES.has(b)) {
      stats.timeMin = asISO(row[`${col.column_name}__min`]);
      stats.timeMax = asISO(row[`${col.column_name}__max`]);
    } else if (NUMERIC_BASES.has(b)) {
      const mn = row[`${col.column_name}__min`];
      const mx = row[`${col.column_name}__max`];
      if (mn !== null && mn !== undefined) stats.numericMin = asNum(mn);
      if (mx !== null && mx !== undefined) stats.numericMax = asNum(mx);
    }
    return stats;
  }

  async runTimeBoundsQuery(tableName: string, timeColumns: RawColumn[]): Promise<TimeBoundsResult> {
    const from = this.fromExpr(tableName);
    const exprs: string[] = [];
    for (const col of timeColumns) {
      const c = this.quoteIdent(col.column_name);
      exprs.push(`MIN(${c}) AS ${this.quoteIdent(col.column_name + "__min")}`);
      exprs.push(`MAX(${c}) AS ${this.quoteIdent(col.column_name + "__max")}`);
    }
    const rows = await this.rows(`SELECT ${exprs.join(", ")} FROM ${from}`);
    const columns = new Map<string, { min: string; max: string }>();
    if (rows.length > 0) {
      const row = rows[0];
      for (const col of timeColumns) {
        const min = asISO(row[`${col.column_name}__min`]);
        const max = asISO(row[`${col.column_name}__max`]);
        if (min && max) columns.set(col.column_name, { min, max });
      }
    }
    return { columns, bytesProcessed: 0 };
  }

  async getSampleRows(tableName: string, columns: RawColumn[], limit: number): Promise<SampleResult> {
    const cols = columns.map((c) => this.quoteIdent(c.column_name)).join(", ");
    const rows = await this.rows(`SELECT ${cols} FROM ${this.fromExpr(tableName)} LIMIT ${limit}`);
    return { rows, bytesProcessed: 0 };
  }

  async getDistinctValues(tableName: string, columnName: string, _sampled: boolean): Promise<DistinctResult> {
    const c = this.quoteIdent(columnName);
    const rows = await this.rows(
      `SELECT DISTINCT ${c} AS val FROM ${this.fromExpr(tableName)} WHERE ${c} IS NOT NULL ORDER BY val LIMIT ${DISTINCT_VALUE_LIMIT}`,
    );
    return { values: rows.map((r) => String(r.val)), bytesProcessed: 0 };
  }

  async getTopValuesByFrequency(tableName: string, columnName: string, _sampled: boolean): Promise<FrequencyResult> {
    const c = this.quoteIdent(columnName);
    const rows = await this.rows(
      `SELECT ${c} AS val, COUNT(*) AS freq FROM ${this.fromExpr(tableName)} WHERE ${c} IS NOT NULL GROUP BY ${c} ORDER BY freq DESC LIMIT ${TOP_N_FREQUENCY}`,
    );
    return { values: rows.map((r) => ({ value: String(r.val), freq: asNum(r.freq) })), bytesProcessed: 0 };
  }

  // ── Type normalization ────────────────────────────────────────

  normalizeType(rawType: string): NormalizedType {
    const u = rawType.toUpperCase();
    if (u === "JSON") return "json";
    if (duckdbComplex(rawType)) return "unsupported";
    const b = baseType(rawType);
    if (NUMERIC_BASES.has(b)) {
      return ["DOUBLE", "FLOAT", "REAL", "DECIMAL", "NUMERIC"].includes(b) ? "float" : "integer";
    }
    if (b === "BOOLEAN" || b === "BOOL" || b === "LOGICAL") return "boolean";
    if (b === "TIMESTAMP" || b === "TIMESTAMPTZ" || b === "TIMESTAMP WITH TIME ZONE" || b === "DATETIME") return "timestamp";
    if (b === "DATE") return "date";
    if (b === "TIME" || b === "TIMETZ" || b === "TIME WITH TIME ZONE") return "time";
    if (b === "BLOB" || b === "BYTEA" || b === "BINARY" || b === "VARBINARY") return "bytes";
    if (["VARCHAR", "CHAR", "TEXT", "STRING", "BPCHAR", "UUID", "ENUM"].includes(b)) return "string";
    return "unsupported";
  }

  isSkippedType(rawType: string): boolean {
    if (rawType.toUpperCase() === "JSON") return false; // sampled for keys
    return this.normalizeType(rawType) === "unsupported";
  }

  isJsonType(rawType: string): boolean {
    return rawType.toUpperCase() === "JSON";
  }

  jsonExtractExpression(column: string, jsonPath: string[], valueType: JsonValueType): string {
    return getJsonExtractExpression("duckdb", column, jsonPath, valueType);
  }

  aggregateSafeExpression(columnName: string, nativeType: string): string | null {
    return getAggregateSafeExpression("duckdb", columnName, nativeType);
  }

  // ── Malloy integration ────────────────────────────────────────

  malloyConnectionName(): string {
    return "duckdb";
  }

  malloyTableSource(tableName: string): string {
    if (this.isDataFile) {
      // DuckDB reads the file directly from the path.
      return `duckdb.table('${path.resolve(this.filePath).replace(/'/g, "''")}')`;
    }
    return `duckdb.table('${tableName}')`;
  }
}
