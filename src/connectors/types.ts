/**
 * Abstract connector interface for warehouse introspection.
 *
 * Each connector encapsulates database-specific SQL, type mapping,
 * and Malloy integration for a single warehouse backend.
 *
 * Current implementations: BigQuery
 * Planned: Postgres
 */

// ── Normalized types ──────────────────────────────────────────

/**
 * Database-agnostic type categories.
 *
 * Every connector maps its raw types (INT64, VARCHAR, etc.) to one
 * of these categories. Downstream code (classify, generate) works
 * exclusively with normalized types.
 */
export type NormalizedType =
  | "integer"
  | "float"
  | "string"
  | "boolean"
  | "timestamp"
  | "datetime"
  | "date"
  | "time"
  | "bytes"
  | "json"
  | "unsupported";

export type ConnectorKind = "bigquery" | "postgres" | "duckdb" | "mysql" | "snowflake";

/**
 * Scalar value type inferred for a key extracted from a JSON/JSONB column.
 * Drives the cast applied by the extraction expression. "string" is the
 * safe default (used when a key's values have mixed types).
 */
export type JsonValueType = "string" | "int" | "float" | "boolean" | "timestamp";

// ── Normalized type helpers ───────────────────────────────────

export function isNumericNormalized(nt: NormalizedType): boolean {
  return nt === "integer" || nt === "float";
}

export function isTimeNormalized(nt: NormalizedType): boolean {
  return nt === "timestamp" || nt === "datetime" || nt === "date" || nt === "time";
}

export function isStringNormalized(nt: NormalizedType): boolean {
  return nt === "string" || nt === "bytes";
}

/**
 * Fallback type normalization for legacy inspection data
 * that doesn't include normalized_type. Recognizes BigQuery types.
 */
export function fallbackNormalizeType(rawType: string): NormalizedType {
  const upper = rawType.toUpperCase();
  if (upper === "INT64" || upper === "INTEGER") return "integer";
  if (upper === "FLOAT64" || upper === "FLOAT" || upper === "NUMERIC" || upper === "DECIMAL") return "float";
  if (upper === "STRING") return "string";
  if (upper === "BYTES") return "bytes";
  if (upper === "BOOL" || upper === "BOOLEAN") return "boolean";
  if (upper === "TIMESTAMP") return "timestamp";
  if (upper === "DATETIME") return "datetime";
  if (upper === "DATE") return "date";
  if (upper === "TIME") return "time";
  if (upper === "JSON" || upper === "JSONB") return "json";
  return "unsupported";
}

/** Get normalized type from a column, with fallback for legacy data */
export function getNormalizedType(col: { type: string; normalized_type?: NormalizedType }): NormalizedType {
  return col.normalized_type ?? fallbackNormalizeType(col.type);
}

// ── Raw data returned by connector ────────────────────────────

export interface RawTable {
  table_name: string;
  table_type: string;
}

export interface RawColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  is_nullable: string;
  ordinal_position: number;
}

// ── Query/stats result types ──────────────────────────────────

export interface ColumnStats {
  distinct: number;
  nulls: number;
  timeMin?: string;
  timeMax?: string;
  numericMin?: number;
  numericMax?: number;
}

export interface StatsResult {
  totalRows: number;
  columns: Map<string, ColumnStats>;
  bytesProcessed: number;
}

export interface TimeBoundsResult {
  columns: Map<string, { min: string; max: string }>;
  bytesProcessed: number;
}

export interface SampleResult {
  rows: Record<string, unknown>[];
  bytesProcessed: number;
}

export interface DistinctResult {
  values: string[];
  bytesProcessed: number;
}

export interface FrequencyResult {
  values: { value: string; freq: number }[];
  bytesProcessed: number;
}

// ── Foreign key metadata ──────────────────────────────────────

export interface ForeignKey {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
}

// ── Connector interface ───────────────────────────────────────

export interface Connector {
  /** Connector type identifier */
  readonly kind: ConnectorKind;

  /** The project/host that owns the data (e.g. GCP project, PG host) */
  datasetProject(): string;

  /** The dataset/schema name */
  datasetName(): string;

  /** The billing/connection project */
  billingProject(): string;

  /** Sample percentage used for large-table stats queries (e.g. 1 for 1%) */
  samplePercent(): number;

  // ── Schema introspection ────────────────────────────────────

  /** List all tables in the target dataset/schema */
  listTables(): Promise<{ tables: RawTable[]; bytesProcessed: number }>;

  /** Get all columns for all tables */
  getColumns(): Promise<{ columns: RawColumn[]; bytesProcessed: number }>;

  /** Get row count estimates for all tables */
  getTableRowCounts(): Promise<{ counts: Map<string, number>; bytesProcessed: number }>;

  /**
   * Get real foreign key constraints from the database catalog.
   * Returns empty array for databases without FK support or discovery.
   * BigQuery has no FK catalog; Postgres reads from information_schema.
   */
  getForeignKeys(): Promise<ForeignKey[]>;

  /**
   * Release any held resources (connection pools, etc.).
   * Safe to call multiple times. No-op for stateless connectors.
   */
  close(): Promise<void>;

  // ── Per-table statistics (throw on failure — caller handles retry) ──

  /**
   * Run a column statistics query. Returns distinct counts, null counts,
   * and min/max for time/numeric columns. Throws on failure.
   */
  runStatsQuery(
    tableName: string,
    columns: RawColumn[],
    sampled: boolean,
  ): Promise<StatsResult>;

  /** Get precise time bounds (full scan MIN/MAX). Throws on failure. */
  runTimeBoundsQuery(
    tableName: string,
    timeColumns: RawColumn[],
  ): Promise<TimeBoundsResult>;

  /** Get sample rows from a table */
  getSampleRows(
    tableName: string,
    columns: RawColumn[],
    limit: number,
  ): Promise<SampleResult>;

  /**
   * Get distinct values for a low-cardinality column.
   * If sampled=true and sampling fails, implementations should
   * retry without sampling. Throws on complete failure.
   */
  getDistinctValues(
    tableName: string,
    columnName: string,
    sampled: boolean,
  ): Promise<DistinctResult>;

  /**
   * Get top-N values by frequency for a medium-cardinality column.
   * Same retry semantics as getDistinctValues.
   */
  getTopValuesByFrequency(
    tableName: string,
    columnName: string,
    sampled: boolean,
  ): Promise<FrequencyResult>;

  // ── Type normalization ──────────────────────────────────────

  /** Normalize a raw database type to a NormalizedType */
  normalizeType(rawType: string): NormalizedType;

  /** Check if a raw type should be skipped during introspection */
  isSkippedType(rawType: string): boolean;

  /**
   * Check if a raw type is a JSON document type (Postgres json/jsonb,
   * BigQuery JSON). JSON columns are NOT skipped — they are sampled at
   * introspection so their common keys can be exposed as dimensions.
   */
  isJsonType(rawType: string): boolean;

  // ── JSON key extraction ─────────────────────────────────────

  /**
   * Return the connector-specific SQL/Malloy expression that extracts a
   * single key (by path) from a JSON column, cast to the given scalar type.
   *
   * - Postgres: `col ->> 'key'`, `col -> 'obj' ->> 'subkey'`, with casts
   *   (`(col ->> 'n')::int`).
   * - BigQuery: `JSON_VALUE(col, '$.key')`, wrapped in SAFE_CAST for non-string.
   *
   * `path` is the key path: ["browser"] for a top-level key, ["geo","country"]
   * for one level of nesting. `nativeType` is the column's raw type (Postgres
   * json vs jsonb selects the accessor function). The engine stays warehouse-
   * agnostic — this is the single connector seam, mirroring aggregateSafeExpression.
   */
  jsonExtractExpression(column: string, path: string[], valueType: JsonValueType, nativeType?: string): string;

  // ── Aggregate safety ────────────────────────────────────────

  /**
   * Return the Malloy expression to safely use a column in an aggregate
   * function (count, sum, avg, min, max) for this connector.
   *
   * Some native types can't go directly into Malloy aggregates — the
   * specific set depends on the connector. For example, Postgres uuid
   * needs `col::string`; BigQuery has no such restriction.
   *
   * If no cast is needed, returns the column name unchanged.
   * If the type is un-aggregatable (e.g. json), returns null.
   */
  aggregateSafeExpression(columnName: string, nativeType: string): string | null;

  // ── Malloy integration ──────────────────────────────────────

  /** The Malloy connection name used in .malloy source files (e.g. "bigquery") */
  malloyConnectionName(): string;

  /**
   * Generate a full Malloy table source expression.
   * e.g. "bigquery.table('project.dataset.table')"
   */
  malloyTableSource(tableName: string): string;
}

// ── Connector configuration ───────────────────────────────────

export interface BigQueryConnectorConfig {
  kind: "bigquery";
  /** GCP project that owns the dataset (e.g. "bigquery-public-data") */
  project: string;
  /** BigQuery dataset name (e.g. "austin_bikeshare") */
  dataset: string;
  /** GCP project billed for queries */
  billingProject: string;
  /** Dataset region (default: "US") */
  location?: string;
}

export interface PostgresConnectorConfig {
  kind: "postgres";
  /** Full connection string (postgres://user:pass@host:port/db?sslmode=require) */
  connectionString?: string;
  /** Host (can be omitted if connectionString is provided) */
  host?: string;
  /** Port (default: 5432) */
  port?: number;
  /** Database name */
  database?: string;
  /** Schema to introspect (default: "public") */
  schema?: string;
  /** Username */
  user?: string;
  /** Password */
  password?: string;
  /** SSL config — true for { rejectUnauthorized: false } (cloud PG default) */
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface DuckDBConnectorConfig {
  kind: "duckdb";
  /**
   * A FILE PATH — either a `.duckdb`/`.db` database file, or a data file
   * (.parquet/.csv/.tsv/.json) that DuckDB reads directly. `:memory:` is also
   * accepted. No host/port/credentials — this is the zero-setup path.
   */
  filePath: string;
}

export interface MySQLConnectorConfig {
  kind: "mysql";
  connectionString?: string;
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  password?: string;
  /** SSL config — true for { rejectUnauthorized: false } (cloud MySQL default) */
  ssl?: boolean | { rejectUnauthorized: boolean };
}

export interface SnowflakeConnectorConfig {
  kind: "snowflake";
  /** Org-account identifier, e.g. "myorg-myaccount". */
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema?: string;
  role?: string;
  /** Password auth (omit when using key-pair). */
  password?: string;
  /** Key-pair auth: PATH to the private key PEM (not the key contents). */
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
}

export type ConnectorConfig =
  | BigQueryConnectorConfig
  | PostgresConnectorConfig
  | DuckDBConnectorConfig
  | MySQLConnectorConfig
  | SnowflakeConnectorConfig;

// ── Offline aggregate safety ─────────────────────────────────

/**
 * Postgres native types that require a cast before use in Malloy aggregates.
 * Key = raw type (lowercase), Value = Malloy cast suffix (e.g. "::string").
 *
 * Malloy's ExprCountDistinct accepts: number, string, date, timestamp, timestamptz.
 * Postgres types outside that set need casting. This map is the single source
 * of truth — the connector's aggregateSafeExpression delegates to it, and the
 * structural validator uses it offline (no live connection needed).
 */
const PG_AGGREGATE_CASTS: Record<string, string> = {
  uuid: "::string",
  // Future: add other types here as connectors encounter them
  // e.g. "cidr": "::string", "inet": "::string", "macaddr": "::string"
};

/**
 * BigQuery types that require a cast before use in Malloy aggregates.
 * BigQuery's type system maps cleanly to Malloy's legal aggregate types,
 * so this is currently empty. If a future BQ type needs casting, add it here.
 */
const BQ_AGGREGATE_CASTS: Record<string, string> = {
  // Currently none — all BQ types Malloy exposes are directly aggregatable
};

/**
 * Standalone (no-connector-instance) function to get the Malloy expression
 * for safely using a column in an aggregate, given the connector kind and
 * the column's native database type.
 *
 * Used by structural validation (which runs offline, without a live
 * database connection) and by table catalog builders.
 *
 * Returns the column expression (possibly with a cast), or null if the type
 * is un-aggregatable.
 */
/** DuckDB: complex/un-aggregatable types (structs, lists, maps, json). */
function duckdbComplex(lower: string): boolean {
  return (
    lower.includes("[]") ||
    lower.startsWith("struct") ||
    lower.startsWith("map") ||
    lower.startsWith("list") ||
    lower.startsWith("union") ||
    lower === "json"
  );
}

/** Snowflake: VARIANT/OBJECT/ARRAY/GEO are semi-structured → not aggregatable. */
function snowflakeComplex(lower: string): boolean {
  return ["variant", "object", "array", "geography", "geometry"].includes(lower);
}

export function getAggregateSafeExpression(
  connectorKind: ConnectorKind | undefined,
  columnName: string,
  nativeType: string,
): string | null {
  const lower = nativeType.toLowerCase();

  // Connector-aware dialects whose raw types the BQ-centric fallback below
  // doesn't recognize. DuckDB/MySQL aggregate scalars directly; Snowflake's
  // semi-structured types are un-aggregatable; JSON is handled as keys.
  if (connectorKind === "duckdb") {
    return duckdbComplex(lower) ? null : columnName;
  }
  if (connectorKind === "mysql") {
    return lower === "json" ? null : columnName;
  }
  if (connectorKind === "snowflake") {
    return snowflakeComplex(lower) ? null : columnName;
  }

  const castMap = connectorKind === "postgres" ? PG_AGGREGATE_CASTS : BQ_AGGREGATE_CASTS;

  const cast = castMap[lower];
  if (cast) return `${columnName}${cast}`;

  // If the type normalizes to "unsupported" or "json", it's un-aggregatable
  // as a whole column. (JSON keys are exposed as dimensions instead — see
  // getJsonExtractExpression.)
  const normalized = fallbackNormalizeType(lower);
  if (normalized === "unsupported" || normalized === "json") return null;

  return columnName; // No cast needed
}

// ── Offline JSON key extraction ──────────────────────────────
//
// Mirrors getAggregateSafeExpression: a standalone (no live connection)
// function used by the build's table catalog and structural layer so JSON
// dimensions can be generated and validated offline. The connector instances
// delegate to this so there is ONE source of truth per connector.

/** Quote a JSON object key as a single-quoted SQL string literal. */
function sqlKeyLiteral(key: string): string {
  return `'${key.replace(/'/g, "''")}'`;
}

/**
 * Malloy cast suffix for a JSON scalar value type (string → none).
 *
 * Extraction functions return TEXT; the Malloy `::type` cast is dialect-
 * agnostic (Malloy compiles it to the right per-warehouse CAST), so the same
 * cast works for Postgres and BigQuery. Malloy has a single numeric type.
 */
function malloyCast(valueType: JsonValueType): string {
  switch (valueType) {
    case "int":
    case "float": return "::number";
    case "boolean": return "::boolean";
    case "timestamp": return "::timestamp";
    default: return "";
  }
}

/** Build a BigQuery JSONPath ($.a.b) from a key path, best-effort. */
function bqJsonPath(path: string[]): string {
  // Simple identifier keys use dot notation; others fall back to bracket+quote.
  return (
    "$" +
    path
      .map((k) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) ? `.${k}` : `['${k.replace(/'/g, "\\'")}']`))
      .join("")
  );
}

/**
 * Connector-aware Malloy expression that extracts one key (by path) from a
 * JSON column, cast to a scalar type. `path.length === 1` is a top-level key;
 * length 2 is one level of nesting. Deeper paths are still emitted but the
 * introspector does not propose them.
 *
 * Malloy does not parse raw SQL operators (`->>`), so we use Malloy's raw-SQL
 * function-call escape (`fn!(...)`) for the dialect's JSON accessor, then apply
 * a dialect-agnostic Malloy `::type` cast for non-string values:
 *
 *   Postgres (jsonb):  jsonb_extract_path_text!(col, 'geo', 'country')
 *                      jsonb_extract_path_text!(col, 'age')::number
 *   Postgres (json):   json_extract_path_text!(col, 'geo', 'country')
 *   BigQuery:          JSON_VALUE!(col, '$.geo.country')
 *                      JSON_VALUE!(col, '$.age')::number
 *
 * `nativeType` (Postgres only) selects the json vs jsonb accessor function;
 * it defaults to the jsonb accessor (the common case).
 */
export function getJsonExtractExpression(
  connectorKind: ConnectorKind | undefined,
  column: string,
  path: string[],
  valueType: JsonValueType = "string",
  nativeType?: string,
): string {
  if (path.length === 0) return column;
  const cast = malloyCast(valueType);

  if (connectorKind === "postgres") {
    const fn = (nativeType ?? "jsonb").toLowerCase() === "json"
      ? "json_extract_path_text"
      : "jsonb_extract_path_text";
    const args = [column, ...path.map(sqlKeyLiteral)].join(", ");
    return `${fn}!(${args})${cast}`;
  }

  if (connectorKind === "duckdb") {
    // DuckDB: json_extract_string(col, '$.a.b') → TEXT.
    return `json_extract_string!(${column}, '${bqJsonPath(path)}')${cast}`;
  }

  if (connectorKind === "mysql") {
    // MySQL: json_unquote(json_extract(col, '$.a.b')) → TEXT.
    return `json_unquote!(json_extract!(${column}, '${bqJsonPath(path)}'))${cast}`;
  }

  if (connectorKind === "snowflake") {
    // Snowflake: GET_PATH(col, 'a.b') → VARIANT; cast (::string default below).
    const sfPath = path.join(".");
    return `get_path!(${column}, '${sfPath}')${cast || "::string"}`;
  }

  // BigQuery (default): JSON_VALUE returns a STRING; Malloy ::type cast handles
  // typing (a bad cast yields NULL/erroring at query time, surfaced by probes).
  return `JSON_VALUE!(${column}, '${bqJsonPath(path)}')${cast}`;
}
