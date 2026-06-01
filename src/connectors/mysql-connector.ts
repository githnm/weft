/**
 * MySQL implementation of the Connector interface.
 *
 * Postgres-shaped (host/port/db/user/password/ssl), with MySQL quirks handled:
 *  - tinyint(1) is MySQL's boolean → normalizeType maps it to "boolean" so
 *    is_x dimensions/measures work (we read COLUMN_TYPE, not just DATA_TYPE).
 *  - declared foreign keys come from information_schema (key_column_usage).
 *  - JSON columns are sampled (not skipped); extraction via json_unquote/json_extract.
 *
 * Uses mysql2/promise for introspection; model compile/execute uses
 * buildMalloyConnection (Malloy's MySQLConnection).
 */

import mysql from "mysql2/promise";
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
  MySQLConnectorConfig,
} from "./types.js";
import { getJsonExtractExpression, getAggregateSafeExpression } from "./types.js";

const DISTINCT_VALUE_LIMIT = 100;
const TOP_N_FREQUENCY = 30;

// base type (strip params): "tinyint(1)" → "tinyint", "varchar(255)" → "varchar"
function baseType(raw: string): string {
  return raw.toLowerCase().replace(/\(.+$/, "").replace(/ unsigned.*$/, "").trim();
}

const TIME_BASES = new Set(["timestamp", "datetime", "date"]);
const NUMERIC_BASES = new Set([
  "tinyint", "smallint", "mediumint", "int", "integer", "bigint", "year",
  "decimal", "numeric", "float", "double", "real",
]);

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

function parseMySQLUrl(url: string): { host: string; port: number; database: string; user: string; password: string; ssl: boolean } {
  const u = new URL(url);
  return {
    host: u.hostname,
    port: parseInt(u.port || "3306", 10),
    database: u.pathname.replace(/^\//, ""),
    user: decodeURIComponent(u.username),
    password: decodeURIComponent(u.password),
    ssl: u.searchParams.get("ssl") === "true" || url.toLowerCase().includes("ssl-mode=required"),
  };
}

export class MySQLConnector implements Connector {
  readonly kind = "mysql" as const;
  private readonly host: string;
  private readonly port: number;
  private readonly database: string;
  private readonly user: string;
  private readonly password: string;
  private readonly ssl: boolean;
  private pool: mysql.Pool | null = null;

  constructor(config: MySQLConnectorConfig) {
    if (config.connectionString) {
      const p = parseMySQLUrl(config.connectionString);
      this.host = p.host; this.port = p.port; this.database = p.database;
      this.user = p.user; this.password = p.password; this.ssl = p.ssl;
    } else {
      this.host = config.host ?? "localhost";
      this.port = config.port ?? 3306;
      this.database = config.database ?? "";
      this.user = config.user ?? "root";
      this.password = config.password ?? "";
      this.ssl = config.ssl === true || (typeof config.ssl === "object");
    }
  }

  datasetProject(): string { return this.host; }
  datasetName(): string { return this.database; }
  billingProject(): string { return this.database; }
  samplePercent(): number { return 1; }

  private getPool(): mysql.Pool {
    if (!this.pool) {
      this.pool = mysql.createPool({
        host: this.host, port: this.port, database: this.database,
        user: this.user, password: this.password,
        connectionLimit: 4, connectTimeout: 10_000,
        ...(this.ssl ? { ssl: { rejectUnauthorized: false } } : {}),
      });
    }
    return this.pool;
  }

  private async rows(sql: string, params?: unknown[]): Promise<Record<string, unknown>[]> {
    const [r] = await this.getPool().query(sql, params);
    return r as Record<string, unknown>[];
  }

  private q(name: string): string {
    return `\`${name.replace(/`/g, "``")}\``;
  }

  // ── Schema introspection ──────────────────────────────────────

  async listTables(): Promise<{ tables: RawTable[]; bytesProcessed: number }> {
    const r = await this.rows(
      `SELECT table_name, table_type FROM information_schema.tables WHERE table_schema = ? ORDER BY table_name`,
      [this.database],
    );
    return {
      tables: r.map((x) => ({ table_name: String(x.table_name ?? x.TABLE_NAME), table_type: String(x.table_type ?? x.TABLE_TYPE ?? "BASE TABLE") })),
      bytesProcessed: 0,
    };
  }

  async getColumns(): Promise<{ columns: RawColumn[]; bytesProcessed: number }> {
    // COLUMN_TYPE (not DATA_TYPE) so we can see tinyint(1) → boolean.
    const r = await this.rows(
      `SELECT table_name, column_name, column_type, is_nullable, ordinal_position
       FROM information_schema.columns WHERE table_schema = ?
       ORDER BY table_name, ordinal_position`,
      [this.database],
    );
    return {
      columns: r.map((x) => ({
        table_name: String(x.table_name ?? x.TABLE_NAME),
        column_name: String(x.column_name ?? x.COLUMN_NAME),
        data_type: String(x.column_type ?? x.COLUMN_TYPE),
        is_nullable: String(x.is_nullable ?? x.IS_NULLABLE ?? "YES"),
        ordinal_position: asNum(x.ordinal_position ?? x.ORDINAL_POSITION),
      })),
      bytesProcessed: 0,
    };
  }

  async getTableRowCounts(): Promise<{ counts: Map<string, number>; bytesProcessed: number }> {
    // information_schema.tables.table_rows is an InnoDB estimate — good enough
    // for the sampling decision, and free.
    const r = await this.rows(
      `SELECT table_name, table_rows FROM information_schema.tables WHERE table_schema = ?`,
      [this.database],
    );
    const counts = new Map<string, number>();
    for (const x of r) counts.set(String(x.table_name ?? x.TABLE_NAME), Math.max(0, asNum(x.table_rows ?? x.TABLE_ROWS)));
    return { counts, bytesProcessed: 0 };
  }

  async getForeignKeys(): Promise<ForeignKey[]> {
    const r = await this.rows(
      `SELECT table_name AS source_table, column_name AS source_column,
              referenced_table_name AS target_table, referenced_column_name AS target_column
       FROM information_schema.key_column_usage
       WHERE table_schema = ? AND referenced_table_name IS NOT NULL
       ORDER BY table_name, column_name`,
      [this.database],
    );
    return r.map((x) => ({
      source_table: String(x.source_table ?? x.SOURCE_TABLE),
      source_column: String(x.source_column ?? x.SOURCE_COLUMN),
      target_table: String(x.target_table ?? x.TARGET_TABLE),
      target_column: String(x.target_column ?? x.TARGET_COLUMN),
    }));
  }

  async close(): Promise<void> {
    await this.pool?.end().catch(() => {});
    this.pool = null;
  }

  // ── Stats ─────────────────────────────────────────────────────

  private sampledFrom(tableName: string, _sampled: boolean): string {
    // MySQL has no TABLESAMPLE; we full-scan (sampling decision returns false
    // for typical sizes). Kept as a hook for future deterministic sampling.
    return this.q(tableName);
  }

  async runStatsQuery(tableName: string, columns: RawColumn[], sampled: boolean): Promise<StatsResult> {
    const from = this.sampledFrom(tableName, sampled);
    const exprs = ["COUNT(*) AS __total_rows"];
    for (const col of columns) {
      const c = this.q(col.column_name);
      exprs.push(`COUNT(DISTINCT ${c}) AS ${this.q(col.column_name + "__distinct")}`);
      exprs.push(`SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) AS ${this.q(col.column_name + "__nulls")}`);
      const b = baseType(col.data_type);
      if (TIME_BASES.has(b) || NUMERIC_BASES.has(b)) {
        exprs.push(`MIN(${c}) AS ${this.q(col.column_name + "__min")}`);
        exprs.push(`MAX(${c}) AS ${this.q(col.column_name + "__max")}`);
      }
    }
    const r = await this.rows(`SELECT ${exprs.join(", ")} FROM ${from}`);
    const columnStats = new Map<string, ColumnStats>();
    let totalRows = 0;
    if (r.length > 0) {
      const row = r[0];
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
    const exprs: string[] = [];
    for (const col of timeColumns) {
      const c = this.q(col.column_name);
      exprs.push(`MIN(${c}) AS ${this.q(col.column_name + "__min")}`);
      exprs.push(`MAX(${c}) AS ${this.q(col.column_name + "__max")}`);
    }
    const r = await this.rows(`SELECT ${exprs.join(", ")} FROM ${this.q(tableName)}`);
    const columns = new Map<string, { min: string; max: string }>();
    if (r.length > 0) {
      const row = r[0];
      for (const col of timeColumns) {
        const min = asISO(row[`${col.column_name}__min`]);
        const max = asISO(row[`${col.column_name}__max`]);
        if (min && max) columns.set(col.column_name, { min, max });
      }
    }
    return { columns, bytesProcessed: 0 };
  }

  async getSampleRows(tableName: string, columns: RawColumn[], limit: number): Promise<SampleResult> {
    const cols = columns.map((c) => this.q(c.column_name)).join(", ");
    const r = await this.rows(`SELECT ${cols} FROM ${this.q(tableName)} LIMIT ${limit}`);
    return { rows: r, bytesProcessed: 0 };
  }

  async getDistinctValues(tableName: string, columnName: string, _sampled: boolean): Promise<DistinctResult> {
    const c = this.q(columnName);
    const r = await this.rows(
      `SELECT DISTINCT ${c} AS val FROM ${this.q(tableName)} WHERE ${c} IS NOT NULL ORDER BY val LIMIT ${DISTINCT_VALUE_LIMIT}`,
    );
    return { values: r.map((x) => String(x.val)), bytesProcessed: 0 };
  }

  async getTopValuesByFrequency(tableName: string, columnName: string, _sampled: boolean): Promise<FrequencyResult> {
    const c = this.q(columnName);
    const r = await this.rows(
      `SELECT ${c} AS val, COUNT(*) AS freq FROM ${this.q(tableName)} WHERE ${c} IS NOT NULL GROUP BY ${c} ORDER BY freq DESC LIMIT ${TOP_N_FREQUENCY}`,
    );
    return { values: r.map((x) => ({ value: String(x.val), freq: asNum(x.freq) })), bytesProcessed: 0 };
  }

  // ── Type normalization ────────────────────────────────────────

  normalizeType(rawType: string): NormalizedType {
    const lower = rawType.toLowerCase();
    if (lower.startsWith("tinyint(1)")) return "boolean"; // MySQL's boolean
    if (lower === "json") return "json";
    const b = baseType(rawType);
    if (b === "bool" || b === "boolean") return "boolean";
    if (NUMERIC_BASES.has(b)) {
      return ["decimal", "numeric", "float", "double", "real"].includes(b) ? "float" : "integer";
    }
    if (b === "timestamp" || b === "datetime") return "timestamp";
    if (b === "date") return "date";
    if (b === "time") return "time";
    if (["blob", "tinyblob", "mediumblob", "longblob", "binary", "varbinary", "bit"].includes(b)) return "bytes";
    if (["varchar", "char", "text", "tinytext", "mediumtext", "longtext", "enum", "set"].includes(b)) return "string";
    return "unsupported";
  }

  isSkippedType(rawType: string): boolean {
    if (rawType.toLowerCase() === "json") return false; // sampled for keys
    return this.normalizeType(rawType) === "unsupported";
  }

  isJsonType(rawType: string): boolean {
    return rawType.toLowerCase() === "json";
  }

  jsonExtractExpression(column: string, jsonPath: string[], valueType: JsonValueType): string {
    return getJsonExtractExpression("mysql", column, jsonPath, valueType);
  }

  aggregateSafeExpression(columnName: string, nativeType: string): string | null {
    return getAggregateSafeExpression("mysql", columnName, nativeType);
  }

  // ── Malloy integration ────────────────────────────────────────

  malloyConnectionName(): string {
    return "mysql";
  }

  malloyTableSource(tableName: string): string {
    return `mysql.table('${this.database}.${tableName}')`;
  }
}
