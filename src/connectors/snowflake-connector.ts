/**
 * Snowflake implementation of the Connector interface.
 *
 * Heavy auth: password OR key-pair (a PATH to a private-key PEM, never the
 * contents). Account is the org-account identifier. Introspection runs against
 * <db>.INFORMATION_SCHEMA via snowflake-sdk; distinct counts use HyperLogLog
 * (APPROX_COUNT_DISTINCT). Semi-structured VARIANT/OBJECT are sampled as JSON;
 * extraction via GET_PATH. Model compile/execute uses buildMalloyConnection.
 */

import snowflake from "snowflake-sdk";
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
  SnowflakeConnectorConfig,
} from "./types.js";
import { getJsonExtractExpression, getAggregateSafeExpression } from "./types.js";

const DISTINCT_VALUE_LIMIT = 100;
const TOP_N_FREQUENCY = 30;

const TIME_BASES = new Set(["TIMESTAMP", "TIMESTAMP_NTZ", "TIMESTAMP_LTZ", "TIMESTAMP_TZ", "DATETIME", "DATE"]);
const NUMERIC_BASES = new Set([
  "NUMBER", "DECIMAL", "NUMERIC", "INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "BYTEINT",
  "FLOAT", "FLOAT4", "FLOAT8", "DOUBLE", "DOUBLE PRECISION", "REAL",
]);
const INTEGER_BASES = new Set(["INT", "INTEGER", "BIGINT", "SMALLINT", "TINYINT", "BYTEINT"]);

function baseType(raw: string): string {
  return raw.toUpperCase().replace(/\(.+\)$/, "").trim();
}

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

export class SnowflakeConnector implements Connector {
  readonly kind = "snowflake" as const;
  private readonly cfg: SnowflakeConnectorConfig;
  private readonly schema: string;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private conn: any = null;

  constructor(config: SnowflakeConnectorConfig) {
    this.cfg = config;
    this.schema = config.schema ?? "PUBLIC";
  }

  datasetProject(): string { return this.cfg.account; }
  datasetName(): string { return `${this.cfg.database}.${this.schema}`; }
  billingProject(): string { return this.cfg.database; }
  samplePercent(): number { return 1; }

  // ── Connection (snowflake-sdk is callback-based → promisify) ──

  private async getConn() {
    if (this.conn) return this.conn;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const opts: any = {
      account: this.cfg.account,
      username: this.cfg.username,
      warehouse: this.cfg.warehouse,
      database: this.cfg.database,
      schema: this.schema,
      ...(this.cfg.role ? { role: this.cfg.role } : {}),
    };
    if (this.cfg.privateKeyPath) {
      opts.authenticator = "SNOWFLAKE_JWT";
      opts.privateKeyPath = this.cfg.privateKeyPath;
      if (this.cfg.privateKeyPassphrase) opts.privateKeyPass = this.cfg.privateKeyPassphrase;
    } else {
      opts.password = this.cfg.password;
    }
    const conn = snowflake.createConnection(opts);
    await new Promise<void>((resolve, reject) => {
      conn.connect((err) => (err ? reject(err) : resolve()));
    });
    this.conn = conn;
    return conn;
  }

  private async rows(sqlText: string): Promise<Record<string, unknown>[]> {
    const conn = await this.getConn();
    return new Promise((resolve, reject) => {
      conn.execute({
        sqlText,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        complete: (err: unknown, _stmt: unknown, rows: any[]) => (err ? reject(err) : resolve((rows ?? []) as Record<string, unknown>[])),
      });
    });
  }

  private q(name: string): string {
    return `"${name.replace(/"/g, '""')}"`;
  }

  // ── Schema introspection ──────────────────────────────────────

  async listTables(): Promise<{ tables: RawTable[]; bytesProcessed: number }> {
    const r = await this.rows(
      `SELECT TABLE_NAME AS "table_name", TABLE_TYPE AS "table_type"
       FROM ${this.q(this.cfg.database)}.INFORMATION_SCHEMA.TABLES
       WHERE TABLE_SCHEMA = '${this.schema.replace(/'/g, "''")}' ORDER BY TABLE_NAME`,
    );
    return {
      tables: r.map((x) => ({ table_name: String(x.table_name), table_type: String(x.table_type ?? "BASE TABLE") })),
      bytesProcessed: 0,
    };
  }

  async getColumns(): Promise<{ columns: RawColumn[]; bytesProcessed: number }> {
    const r = await this.rows(
      `SELECT TABLE_NAME AS "table_name", COLUMN_NAME AS "column_name", DATA_TYPE AS "data_type",
              IS_NULLABLE AS "is_nullable", ORDINAL_POSITION AS "ordinal_position", NUMERIC_SCALE AS "numeric_scale"
       FROM ${this.q(this.cfg.database)}.INFORMATION_SCHEMA.COLUMNS
       WHERE TABLE_SCHEMA = '${this.schema.replace(/'/g, "''")}' ORDER BY TABLE_NAME, ORDINAL_POSITION`,
    );
    return {
      columns: r.map((x) => {
        // Preserve NUMBER scale so NUMBER(38,0) maps to integer, NUMBER(x,>0) to float.
        let dataType = String(x.data_type);
        if (dataType.toUpperCase() === "NUMBER" && (x.numeric_scale === 0 || x.numeric_scale === "0")) {
          dataType = "NUMBER(38,0)";
        }
        return {
          table_name: String(x.table_name),
          column_name: String(x.column_name),
          data_type: dataType,
          is_nullable: String(x.is_nullable ?? "YES"),
          ordinal_position: asNum(x.ordinal_position),
        };
      }),
      bytesProcessed: 0,
    };
  }

  async getTableRowCounts(): Promise<{ counts: Map<string, number>; bytesProcessed: number }> {
    // No sampling — keep introspection a single, predictable pass.
    return { counts: new Map(), bytesProcessed: 0 };
  }

  async getForeignKeys(): Promise<ForeignKey[]> {
    return []; // name-matching fallback (Snowflake FK metadata is rarely enforced/populated)
  }

  async close(): Promise<void> {
    if (this.conn) {
      const conn = this.conn;
      this.conn = null;
      await new Promise<void>((resolve) => conn.destroy(() => resolve())).catch(() => {});
    }
  }

  // ── Stats ─────────────────────────────────────────────────────

  async runStatsQuery(tableName: string, columns: RawColumn[], _sampled: boolean): Promise<StatsResult> {
    const from = this.q(tableName);
    const exprs = ["COUNT(*) AS \"__total_rows\""];
    for (const col of columns) {
      const c = this.q(col.column_name);
      // HyperLogLog distinct — cheap + sufficient for cardinality heuristics.
      exprs.push(`APPROX_COUNT_DISTINCT(${c}) AS ${this.q(col.column_name + "__distinct")}`);
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
      `SELECT DISTINCT ${c} AS "val" FROM ${this.q(tableName)} WHERE ${c} IS NOT NULL ORDER BY "val" LIMIT ${DISTINCT_VALUE_LIMIT}`,
    );
    return { values: r.map((x) => String(x.val)), bytesProcessed: 0 };
  }

  async getTopValuesByFrequency(tableName: string, columnName: string, _sampled: boolean): Promise<FrequencyResult> {
    const c = this.q(columnName);
    const r = await this.rows(
      `SELECT ${c} AS "val", COUNT(*) AS "freq" FROM ${this.q(tableName)} WHERE ${c} IS NOT NULL GROUP BY ${c} ORDER BY "freq" DESC LIMIT ${TOP_N_FREQUENCY}`,
    );
    return { values: r.map((x) => ({ value: String(x.val), freq: asNum(x.freq) })), bytesProcessed: 0 };
  }

  // ── Type normalization ────────────────────────────────────────

  normalizeType(rawType: string): NormalizedType {
    const b = baseType(rawType);
    if (b === "VARIANT" || b === "OBJECT") return "json";
    if (b === "BOOLEAN") return "boolean";
    if (INTEGER_BASES.has(b)) return "integer";
    if (b === "NUMBER" && /\(\s*\d+\s*,\s*0\s*\)/.test(rawType)) return "integer";
    if (NUMERIC_BASES.has(b)) return "float";
    if (TIME_BASES.has(b)) return b === "DATE" ? "date" : "timestamp";
    if (b === "TIME") return "time";
    if (b === "BINARY" || b === "VARBINARY") return "bytes";
    if (["TEXT", "STRING", "VARCHAR", "CHAR", "CHARACTER", "NVARCHAR", "NCHAR"].includes(b)) return "string";
    return "unsupported"; // ARRAY, GEOGRAPHY, GEOMETRY, etc.
  }

  isSkippedType(rawType: string): boolean {
    const b = baseType(rawType);
    if (b === "VARIANT" || b === "OBJECT") return false; // sampled for keys
    return this.normalizeType(rawType) === "unsupported";
  }

  isJsonType(rawType: string): boolean {
    const b = baseType(rawType);
    return b === "VARIANT" || b === "OBJECT";
  }

  jsonExtractExpression(column: string, jsonPath: string[], valueType: JsonValueType): string {
    return getJsonExtractExpression("snowflake", column, jsonPath, valueType);
  }

  aggregateSafeExpression(columnName: string, nativeType: string): string | null {
    return getAggregateSafeExpression("snowflake", columnName, nativeType);
  }

  // ── Malloy integration ────────────────────────────────────────

  malloyConnectionName(): string {
    return "snowflake";
  }

  malloyTableSource(tableName: string): string {
    return `snowflake.table('${this.schema}.${tableName}')`;
  }
}
