/**
 * Postgres implementation of the Connector interface.
 *
 * Targets cloud Postgres providers (Supabase, Neon, RDS) which require SSL.
 * Uses `pg` Pool for introspection SQL and `@malloydata/db-postgres`
 * PostgresConnection for Malloy compilation/execution.
 */

import pg from "pg";
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
  PostgresConnectorConfig,
} from "./types.js";
import { getJsonExtractExpression } from "./types.js";

const { Pool } = pg;

// ── Constants ─────────────────────────────────────────────────

/** TABLESAMPLE percentage for large tables */
const SAMPLE_PERCENT = 1;

/** Max distinct values to fetch per column */
const DISTINCT_VALUE_LIMIT = 100;

/** Top-N values to capture by frequency */
const TOP_N_FREQUENCY = 30;

// PG types that should be skipped (complex/unsupported).
// NOTE: json/jsonb are deliberately NOT skipped — they are sampled so their
// common keys can be exposed as dimensions (see isJsonType / inferJsonKeys).
const SKIPPED_TYPES = new Set([
  "xml", "bytea", "tsvector", "tsquery",
  "point", "line", "lseg", "box", "path", "polygon", "circle",
  "inet", "cidr", "macaddr", "macaddr8",
  "bit", "bit varying", "varbit",
  "pg_lsn", "pg_snapshot", "txid_snapshot",
  "oid", "regclass", "regproc", "regtype",
]);

// PG time types (for stats query MIN/MAX)
const TIME_TYPES = new Set([
  "timestamp without time zone", "timestamp with time zone",
  "date",
  "timestamp", "timestamptz",
]);

// PG numeric types (for stats query MIN/MAX)
const NUMERIC_TYPES = new Set([
  "integer", "int", "int4", "int2", "int8",
  "bigint", "smallint",
  "real", "float4",
  "double precision", "float8",
  "numeric", "decimal",
  "money",
]);

// ── SSL resolution ───────────────────────────────────────────

function resolveSSL(
  config: PostgresConnectorConfig,
): boolean | { rejectUnauthorized: boolean } | undefined {
  if (config.ssl !== undefined) return config.ssl;

  // Auto-detect from connection string
  if (config.connectionString) {
    const lower = config.connectionString.toLowerCase();
    if (lower.includes("sslmode=require") || lower.includes("sslmode=verify")) {
      return { rejectUnauthorized: false };
    }
  }

  // Default for cloud providers: enable SSL
  return { rejectUnauthorized: false };
}

// ── Connection string parsing ────────────────────────────────

interface ParsedPgUrl {
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
}

function parsePgUrl(url: string): ParsedPgUrl {
  const parsed = new URL(url);
  return {
    host: parsed.hostname,
    port: parseInt(parsed.port || "5432", 10),
    database: parsed.pathname.replace(/^\//, ""),
    user: decodeURIComponent(parsed.username),
    password: decodeURIComponent(parsed.password),
  };
}

// ── Helpers ───────────────────────────────────────────────────

interface QueryResult {
  rows: Record<string, unknown>[];
}

function quoteIdent(name: string): string {
  // PG uses double quotes for identifiers
  return `"${name.replace(/"/g, '""')}"`;
}

function toISOString(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (value instanceof Date) return value.toISOString();
  return String(value);
}

// ── PG type normalization map ────────────────────────────────

const PG_TYPE_MAP: Record<string, NormalizedType> = {
  // Integer types
  "integer": "integer",
  "int": "integer",
  "int2": "integer",
  "int4": "integer",
  "int8": "integer",
  "smallint": "integer",
  "bigint": "integer",
  "serial": "integer",
  "bigserial": "integer",
  "smallserial": "integer",

  // Float types
  "real": "float",
  "float4": "float",
  "double precision": "float",
  "float8": "float",
  "numeric": "float",
  "decimal": "float",
  "money": "float",

  // String types
  "character varying": "string",
  "varchar": "string",
  "character": "string",
  "char": "string",
  "text": "string",
  "name": "string",
  "uuid": "string",
  "citext": "string",

  // Boolean
  "boolean": "boolean",
  "bool": "boolean",

  // JSON document types — sampled for key discovery, not skipped
  "json": "json",
  "jsonb": "json",

  // Time types
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  "timestamp": "timestamp",
  "timestamptz": "timestamp",
  "date": "date",
  "time without time zone": "time",
  "time with time zone": "time",
  "time": "time",
  "timetz": "time",
  "interval": "unsupported",

  // Binary / unsupported
  "bytea": "bytes",
};

// ── PostgresConnector ─────────────────────────────────────────

export class PostgresConnector implements Connector {
  readonly kind = "postgres" as const;
  private readonly pool: pg.Pool;
  private readonly schema: string;
  private readonly dbName: string;
  private readonly hostName: string;

  constructor(config: PostgresConnectorConfig) {
    const ssl = resolveSSL(config);

    // statement_timeout prevents individual queries from hanging
    // indefinitely (e.g. on Supabase free tier with tight limits).
    // 60s is generous for introspection; individual heavy queries
    // fail cleanly instead of hanging the MCP server.
    const STATEMENT_TIMEOUT_MS = 60_000;

    if (config.connectionString) {
      const parsed = parsePgUrl(config.connectionString);
      this.hostName = parsed.host;
      this.dbName = parsed.database;
      this.pool = new Pool({
        connectionString: config.connectionString,
        ssl,
        max: 4,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: STATEMENT_TIMEOUT_MS,
      });
    } else {
      this.hostName = config.host ?? "localhost";
      this.dbName = config.database ?? "postgres";
      this.pool = new Pool({
        host: config.host ?? "localhost",
        port: config.port ?? 5432,
        database: config.database ?? "postgres",
        user: config.user,
        password: config.password,
        ssl,
        max: 4,
        connectionTimeoutMillis: 10_000,
        idleTimeoutMillis: 30_000,
        statement_timeout: STATEMENT_TIMEOUT_MS,
      });
    }

    this.schema = config.schema ?? "public";
  }

  datasetProject(): string { return this.hostName; }
  datasetName(): string { return this.schema; }
  billingProject(): string { return this.dbName; }
  samplePercent(): number { return SAMPLE_PERCENT; }

  // ── Internal query runner ───────────────────────────────────

  /** Hard per-query timeout. Prevents any single query from hanging. */
  private static readonly QUERY_TIMEOUT_MS = 30_000;

  private async runQuery(sql: string, params?: unknown[]): Promise<QueryResult> {
    const client = await this.pool.connect();
    try {
      // Set per-query statement_timeout as a belt-and-suspenders
      // safeguard in addition to the pool-level timeout.
      await client.query(
        `SET LOCAL statement_timeout = '${PostgresConnector.QUERY_TIMEOUT_MS}'`,
      );
      const result = await client.query(sql, params);
      return { rows: result.rows as Record<string, unknown>[] };
    } finally {
      client.release();
    }
  }

  // ── Table reference helpers ─────────────────────────────────

  private tableRef(tableName: string): string {
    return `${quoteIdent(this.schema)}.${quoteIdent(tableName)}`;
  }

  private sampledFrom(tableName: string, sampled: boolean): string {
    const ref = this.tableRef(tableName);
    return sampled ? `${ref} TABLESAMPLE SYSTEM (${SAMPLE_PERCENT})` : ref;
  }

  // ── Schema introspection ────────────────────────────────────

  async listTables(): Promise<{ tables: RawTable[]; bytesProcessed: number }> {
    const sql = `
      SELECT table_name, table_type
      FROM information_schema.tables
      WHERE table_schema = $1
      ORDER BY table_name
    `;
    const { rows } = await this.runQuery(sql, [this.schema]);
    const tables = rows.map((r) => ({
      table_name: String(r.table_name),
      table_type: String(r.table_type),
    }));
    return { tables, bytesProcessed: 0 };
  }

  async getColumns(): Promise<{ columns: RawColumn[]; bytesProcessed: number }> {
    const sql = `
      SELECT table_name, column_name, data_type, is_nullable, ordinal_position
      FROM information_schema.columns
      WHERE table_schema = $1
      ORDER BY table_name, ordinal_position
    `;
    const { rows } = await this.runQuery(sql, [this.schema]);
    const columns = rows.map((r) => ({
      table_name: String(r.table_name),
      column_name: String(r.column_name),
      data_type: String(r.data_type),
      is_nullable: String(r.is_nullable),
      ordinal_position: Number(r.ordinal_position),
    }));
    return { columns, bytesProcessed: 0 };
  }

  async getTableRowCounts(): Promise<{ counts: Map<string, number>; bytesProcessed: number }> {
    // Use pg_class for fast row count estimates (reltuples)
    const sql = `
      SELECT c.relname AS table_name, c.reltuples::bigint AS row_count
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = $1
        AND c.relkind IN ('r', 'm')
    `;
    const { rows } = await this.runQuery(sql, [this.schema]);
    const counts = new Map<string, number>();
    for (const row of rows) {
      const count = Number(row.row_count ?? 0);
      counts.set(String(row.table_name), Math.max(0, count));
    }
    return { counts, bytesProcessed: 0 };
  }

  // ── Foreign keys ───────────────────────────────────────────

  async getForeignKeys(): Promise<ForeignKey[]> {
    const sql = `
      SELECT
        kcu.table_name    AS source_table,
        kcu.column_name   AS source_column,
        ccu.table_name    AS target_table,
        ccu.column_name   AS target_column
      FROM information_schema.table_constraints tc
      JOIN information_schema.key_column_usage kcu
        ON tc.constraint_name = kcu.constraint_name
        AND tc.table_schema = kcu.table_schema
      JOIN information_schema.constraint_column_usage ccu
        ON tc.constraint_name = ccu.constraint_name
        AND tc.table_schema = ccu.table_schema
      WHERE tc.constraint_type = 'FOREIGN KEY'
        AND tc.table_schema = $1
      ORDER BY kcu.table_name, kcu.column_name
    `;
    const { rows } = await this.runQuery(sql, [this.schema]);
    return rows.map((r) => ({
      source_table: String(r.source_table),
      source_column: String(r.source_column),
      target_table: String(r.target_table),
      target_column: String(r.target_column),
    }));
  }

  // ── Cleanup ─────────────────────────────────────────────────

  async close(): Promise<void> {
    await this.pool.end();
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
      const c = quoteIdent(col.column_name);
      exprs.push(`COUNT(DISTINCT ${c}) AS ${quoteIdent(col.column_name + "__distinct")}`);
      exprs.push(`SUM(CASE WHEN ${c} IS NULL THEN 1 ELSE 0 END) AS ${quoteIdent(col.column_name + "__nulls")}`);

      const lower = col.data_type.toLowerCase();
      if (TIME_TYPES.has(lower) || NUMERIC_TYPES.has(lower)) {
        exprs.push(`MIN(${c}) AS ${quoteIdent(col.column_name + "__min")}`);
        exprs.push(`MAX(${c}) AS ${quoteIdent(col.column_name + "__max")}`);
      }
    }

    const sql = `SELECT ${exprs.join(", ")} FROM ${fromClause}`;
    const { rows } = await this.runQuery(sql);

    const columnStats = new Map<string, ColumnStats>();
    let totalRows = 0;

    if (rows.length > 0) {
      const row = rows[0];
      totalRows = Number(row.__total_rows ?? 0);
      for (const col of columns) {
        columnStats.set(col.column_name, this.parseColumnStats(row, col));
      }
    }

    return { totalRows, columns: columnStats, bytesProcessed: 0 };
  }

  private parseColumnStats(row: Record<string, unknown>, col: RawColumn): ColumnStats {
    const lower = col.data_type.toLowerCase();
    const stats: ColumnStats = {
      distinct: Number(row[`${col.column_name}__distinct`] ?? 0),
      nulls: Number(row[`${col.column_name}__nulls`] ?? 0),
    };

    if (TIME_TYPES.has(lower)) {
      stats.timeMin = toISOString(row[`${col.column_name}__min`]);
      stats.timeMax = toISOString(row[`${col.column_name}__max`]);
    } else if (NUMERIC_TYPES.has(lower)) {
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
      const c = quoteIdent(col.column_name);
      exprs.push(`MIN(${c}) AS ${quoteIdent(col.column_name + "__min")}`);
      exprs.push(`MAX(${c}) AS ${quoteIdent(col.column_name + "__max")}`);
    }
    const sql = `SELECT ${exprs.join(", ")} FROM ${tableRefStr}`;
    const { rows } = await this.runQuery(sql);

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

    return { columns, bytesProcessed: 0 };
  }

  // ── Sample rows ─────────────────────────────────────────────

  async getSampleRows(
    tableName: string,
    columns: RawColumn[],
    limit: number,
  ): Promise<SampleResult> {
    const tableRefStr = this.tableRef(tableName);
    const cols = columns.map((c) => quoteIdent(c.column_name)).join(", ");
    const sql = `SELECT ${cols} FROM ${tableRefStr} LIMIT ${limit}`;
    const { rows } = await this.runQuery(sql);
    return { rows, bytesProcessed: 0 };
  }

  // ── Distinct values ─────────────────────────────────────────

  async getDistinctValues(
    tableName: string,
    columnName: string,
    sampled: boolean,
  ): Promise<DistinctResult> {
    const fromClause = this.sampledFrom(tableName, sampled);
    const col = quoteIdent(columnName);
    const sql = `SELECT DISTINCT ${col} AS val FROM ${fromClause} WHERE ${col} IS NOT NULL ORDER BY val LIMIT ${DISTINCT_VALUE_LIMIT}`;

    try {
      const { rows } = await this.runQuery(sql);
      return { values: rows.map((r) => String(r.val)), bytesProcessed: 0 };
    } catch (err) {
      // If sampled query fails, retry without sampling
      if (sampled) {
        const fallbackSql = `SELECT DISTINCT ${col} AS val FROM ${this.tableRef(tableName)} WHERE ${col} IS NOT NULL ORDER BY val LIMIT ${DISTINCT_VALUE_LIMIT}`;
        const { rows } = await this.runQuery(fallbackSql);
        return { values: rows.map((r) => String(r.val)), bytesProcessed: 0 };
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
    const col = quoteIdent(columnName);
    const sql = `SELECT ${col} AS val, COUNT(*) AS freq FROM ${fromClause} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY freq DESC LIMIT ${TOP_N_FREQUENCY}`;

    try {
      const { rows } = await this.runQuery(sql);
      return {
        values: rows.map((r) => ({ value: String(r.val), freq: Number(r.freq) })),
        bytesProcessed: 0,
      };
    } catch (err) {
      if (sampled) {
        const fallbackSql = `SELECT ${col} AS val, COUNT(*) AS freq FROM ${this.tableRef(tableName)} WHERE ${col} IS NOT NULL GROUP BY ${col} ORDER BY freq DESC LIMIT ${TOP_N_FREQUENCY}`;
        const { rows } = await this.runQuery(fallbackSql);
        return {
          values: rows.map((r) => ({ value: String(r.val), freq: Number(r.freq) })),
          bytesProcessed: 0,
        };
      }
      throw err;
    }
  }

  // ── Type normalization ──────────────────────────────────────

  normalizeType(rawType: string): NormalizedType {
    const lower = rawType.toLowerCase();

    if (this.isSkippedType(rawType)) return "unsupported";

    // Check direct map first
    const mapped = PG_TYPE_MAP[lower];
    if (mapped) return mapped;

    // Handle parameterized types: character varying(255) → character varying
    const base = lower.replace(/\(.+\)$/, "").trim();
    const baseMapped = PG_TYPE_MAP[base];
    if (baseMapped) return baseMapped;

    // Handle USER-DEFINED (enums, composites) — treat as string
    if (lower === "user-defined") return "string";

    // Handle array types
    if (lower === "array" || lower.startsWith("_") || lower.endsWith("[]")) return "unsupported";

    return "unsupported";
  }

  isSkippedType(rawType: string): boolean {
    const lower = rawType.toLowerCase();
    if (SKIPPED_TYPES.has(lower)) return true;
    // Skip array types
    if (lower === "array" || lower.startsWith("_") || lower.endsWith("[]")) return true;
    return false;
  }

  isJsonType(rawType: string): boolean {
    const lower = rawType.toLowerCase();
    return lower === "json" || lower === "jsonb";
  }

  // ── JSON key extraction ─────────────────────────────────────

  jsonExtractExpression(column: string, path: string[], valueType: JsonValueType, nativeType?: string): string {
    return getJsonExtractExpression("postgres", column, path, valueType, nativeType);
  }

  // ── Aggregate safety ────────────────────────────────────────

  aggregateSafeExpression(columnName: string, nativeType: string): string | null {
    const lower = nativeType.toLowerCase();

    // Skipped types are un-aggregatable
    if (this.isSkippedType(nativeType)) return null;

    // UUID needs ::string cast for Malloy aggregates
    if (lower === "uuid") return `${columnName}::string`;

    // Check if normalized type is unsupported / a JSON document (the column
    // as a whole is not aggregatable; its keys are exposed as dimensions)
    const normalized = this.normalizeType(nativeType);
    if (normalized === "unsupported" || normalized === "json") return null;

    return columnName;
  }

  // ── Malloy integration ──────────────────────────────────────

  malloyConnectionName(): string {
    return "postgres";
  }

  malloyTableSource(tableName: string): string {
    // Malloy Postgres table source: postgres.table('schema.table')
    return `postgres.table('${this.schema}.${tableName}')`;
  }
}
