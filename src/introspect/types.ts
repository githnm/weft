import type { ConnectorKind, NormalizedType, ForeignKey } from "../connectors/types.js";

// === Inspection types (Pass A output / inspection.json) ===

export interface InspectionResult {
  /** Connector that produced this inspection (absent in legacy data) */
  connector_kind?: ConnectorKind;
  dataset_project: string;
  dataset_name: string;
  billing_project: string;
  inspected_at: string;
  bytes_scanned: number;
  tables: TableInspection[];
  skipped_tables: SkippedTable[];
  /** Real foreign key constraints from the database catalog (Postgres only; empty for BigQuery) */
  foreign_keys?: ForeignKey[];
  /** Accumulated warnings from the inspection pass */
  warnings: string[];
}

export interface TableInspection {
  name: string;
  /** Malloy source expression, e.g. "bigquery.table('...')" (absent in legacy data) */
  malloy_table_source?: string;
  row_count: number;
  columns: ColumnInspection[];
  skipped_columns: SkippedColumn[];
}

export interface ColumnInspection {
  name: string;
  type: string;
  /** Normalized type category (absent in legacy data) */
  normalized_type?: NormalizedType;
  nullable: boolean;
  distinct_count: number;
  null_count: number;
  null_ratio: number;
  sample_values: unknown[];
  /** MIN value for TIMESTAMP / DATETIME / DATE columns (ISO string) */
  time_min?: string;
  /** MAX value for TIMESTAMP / DATETIME / DATE columns (ISO string) */
  time_max?: string;
  /** All distinct values for low-cardinality string columns (distinct_count < 50), up to 100 */
  distinct_values?: string[];
  /** Top values by frequency for medium-cardinality string columns (50 ≤ distinct_count < 500) */
  distinct_values_truncated?: { value: string; freq: number }[];
  /** MIN value for numeric columns */
  numeric_min?: number;
  /** MAX value for numeric columns */
  numeric_max?: number;
  /** "full" if all rows scanned, "sampled" if TABLESAMPLE was used */
  stats_source?: "sampled" | "full";
  /** Reason this column was skipped for enum capture */
  skipped_enum_reason?: string;
}

export interface SkippedTable {
  name: string;
  reason: string;
}

export interface SkippedColumn {
  name: string;
  type: string;
  reason: string;
}

// === Classification types (Pass B intermediate) ===

export type ColumnRole =
  | "primary_key"
  | "foreign_key"
  | "dimension"
  | "measure"
  | "time_dimension"
  | "attribute"
  | "skip";

export interface ClassifiedColumn extends ColumnInspection {
  role: ColumnRole;
  default_aggregation?: string;
  skip_reason?: string;
  ambiguous?: boolean;
  ambiguity_reason?: string;
}

export interface InferredJoin {
  source_table: string;
  source_column: string;
  target_table: string;
  target_column: string;
  confidence: "high" | "medium";
}

export interface ClassifiedTable {
  name: string;
  /** Malloy source expression (flows through from TableInspection) */
  malloy_table_source?: string;
  row_count: number;
  columns: ClassifiedColumn[];
  skipped_columns: SkippedColumn[];
}

export interface ClassificationResult {
  /** Connector kind (flows through from InspectionResult) */
  connector_kind?: ConnectorKind;
  dataset_project: string;
  dataset_name: string;
  tables: ClassifiedTable[];
  skipped_tables: SkippedTable[];
  inferred_joins: InferredJoin[];
}

// === Introspection options (engine-level, connector-agnostic) ===

export interface IntrospectOptions {
  sampleRows: number;
  /** Force-skip enum capture for these table.column pairs (e.g. ["bikeshare_stations.address"]) */
  excludeEnums?: string[];
}
