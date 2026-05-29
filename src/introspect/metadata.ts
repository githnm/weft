import fs from "node:fs";
import type { InspectionResult } from "./types.js";

// ── Metadata types ────────────────────────────────────────────────

export interface TimeBound {
  min: string;
  max: string;
  column_type: string;
}

export interface NumericRange {
  min: number;
  max: number;
}

export interface EnumInfo {
  /** The known values (all values if complete, top-N if truncated) */
  values: string[];
  /** True if only the most frequent values are captured (medium-cardinality) */
  truncated: boolean;
  /** Total distinct count from APPROX_COUNT_DISTINCT (present when truncated) */
  total_distinct?: number;
}

export interface SourceMetadata {
  row_count: number;
  time_bounds: Record<string, TimeBound>;
  enums: Record<string, EnumInfo>;
  numeric_ranges: Record<string, NumericRange>;
  latest_data_date: string;
  is_stale: boolean;
  staleness_days: number;
  /** "full" or "sampled" — whether stats used TABLESAMPLE */
  introspection_method: "full" | "sampled";
  /** Sample rate used (1.0 for full, 0.01 for 1% sample) */
  sample_rate: number;
}

export interface DatasetMetadata {
  generated_at: string;
  dataset: string;
  sources: Record<string, SourceMetadata>;
}

// ── Generator ─────────────────────────────────────────────────────

const STALE_THRESHOLD_DAYS = 30;

function daysBetween(a: Date, b: Date): number {
  return Math.floor(Math.abs(b.getTime() - a.getTime()) / (1000 * 60 * 60 * 24));
}

/**
 * Distill inspection.json into a focused metadata.json.
 * Writes synchronously — this is a fast, in-memory transform.
 */
export function generateMetadata(inspection: InspectionResult, outputPath: string): DatasetMetadata {
  const now = new Date();
  const sources: Record<string, SourceMetadata> = {};

  for (const table of inspection.tables) {
    const timeBounds: Record<string, TimeBound> = {};
    const enums: Record<string, EnumInfo> = {};
    const numericRanges: Record<string, NumericRange> = {};
    let latestDate: Date | null = null;

    for (const col of table.columns) {
      // Time bounds
      if (col.time_min && col.time_max) {
        timeBounds[col.name] = {
          min: col.time_min,
          max: col.time_max,
          column_type: col.type,
        };

        // Track latest date across all time columns
        try {
          const maxDate = new Date(col.time_max);
          if (!isNaN(maxDate.getTime()) && (!latestDate || maxDate > latestDate)) {
            latestDate = maxDate;
          }
        } catch {
          // skip invalid dates
        }
      }

      // Enum values — full capture (low-cardinality)
      if (col.distinct_values && col.distinct_values.length > 0) {
        enums[col.name] = {
          values: col.distinct_values,
          truncated: false,
        };
      }

      // Enum values — truncated capture (medium-cardinality, top-N by frequency)
      if (col.distinct_values_truncated && col.distinct_values_truncated.length > 0) {
        enums[col.name] = {
          values: col.distinct_values_truncated.map((v) => v.value),
          truncated: true,
          total_distinct: col.distinct_count,
        };
      }

      // Numeric ranges
      if (col.numeric_min !== undefined && col.numeric_max !== undefined) {
        numericRanges[col.name] = {
          min: col.numeric_min,
          max: col.numeric_max,
        };
      }
    }

    const latestDataDate = latestDate ? latestDate.toISOString() : "";
    const stalenessDays = latestDate ? daysBetween(latestDate, now) : 0;

    // Detect if any column was sampled
    const wasSampled = table.columns.some((c) => c.stats_source === "sampled");

    sources[table.name] = {
      row_count: table.row_count,
      time_bounds: timeBounds,
      enums,
      numeric_ranges: numericRanges,
      latest_data_date: latestDataDate,
      is_stale: latestDate ? stalenessDays > STALE_THRESHOLD_DAYS : false,
      staleness_days: stalenessDays,
      introspection_method: wasSampled ? "sampled" : "full",
      sample_rate: wasSampled ? 0.01 : 1.0,
    };
  }

  const metadata: DatasetMetadata = {
    generated_at: now.toISOString(),
    dataset: `${inspection.dataset_project}.${inspection.dataset_name}`,
    sources,
  };

  fs.writeFileSync(outputPath, JSON.stringify(metadata, null, 2), "utf-8");

  return metadata;
}
