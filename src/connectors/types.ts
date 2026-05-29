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
  | "unsupported";

export type ConnectorKind = "bigquery" | "postgres";

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

export type ConnectorConfig = BigQueryConnectorConfig | PostgresConnectorConfig;

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
export function getAggregateSafeExpression(
  connectorKind: ConnectorKind | undefined,
  columnName: string,
  nativeType: string,
): string | null {
  const castMap = connectorKind === "postgres" ? PG_AGGREGATE_CASTS : BQ_AGGREGATE_CASTS;
  const lower = nativeType.toLowerCase();

  const cast = castMap[lower];
  if (cast) return `${columnName}${cast}`;

  // If the type normalizes to "unsupported", it's un-aggregatable
  const normalized = fallbackNormalizeType(lower);
  if (normalized === "unsupported") return null;

  return columnName; // No cast needed
}
