import fs from "node:fs/promises";
import path from "node:path";
import type { DatasetMetadata, SourceMetadata } from "../introspect/metadata.js";

export type { DatasetMetadata, SourceMetadata } from "../introspect/metadata.js";

/**
 * Load metadata.json from a models directory.
 * Returns null if the file doesn't exist (metadata is optional).
 */
export async function loadMetadata(modelsDir: string): Promise<DatasetMetadata | null> {
  const metadataPath = path.join(modelsDir, "metadata.json");
  try {
    const raw = await fs.readFile(metadataPath, "utf-8");
    return JSON.parse(raw) as DatasetMetadata;
  } catch {
    return null;
  }
}

/**
 * Find metadata for a source by matching the source name against
 * table names in the metadata. Malloy source names are typically
 * the table name (e.g. "bikeshare_trips" matches table "bikeshare_trips").
 */
export function getSourceMetadata(
  metadata: DatasetMetadata,
  sourceName: string,
): SourceMetadata | null {
  // Direct match
  if (metadata.sources[sourceName]) {
    return metadata.sources[sourceName];
  }

  // Try case-insensitive match
  const lower = sourceName.toLowerCase();
  for (const [key, value] of Object.entries(metadata.sources)) {
    if (key.toLowerCase() === lower) return value;
  }

  return null;
}

/**
 * Format source metadata into a compact text block for LLM prompts.
 */
export function formatMetadataForPrompt(sourceName: string, meta: SourceMetadata): string {
  const lines: string[] = [];
  lines.push(`Data metadata for "${sourceName}":`);
  lines.push(`  Row count: ${meta.row_count.toLocaleString()}`);

  // Time bounds
  const timeEntries = Object.entries(meta.time_bounds ?? {});
  if (timeEntries.length > 0) {
    lines.push("  Time ranges:");
    for (const [col, bound] of timeEntries) {
      lines.push(`    ${col} (${bound.column_type}): ${bound.min} to ${bound.max}`);
    }
  }

  // Latest data
  if (meta.latest_data_date) {
    lines.push(`  Latest data: ${meta.latest_data_date} (${meta.staleness_days} days ago)`);
    if (meta.is_stale) {
      lines.push(`  ⚠ Data is stale (>${meta.staleness_days} days old)`);
    }
  }

  // Enums
  const enumEntries = Object.entries(meta.enums ?? {});
  if (enumEntries.length > 0) {
    lines.push("  Known values:");
    for (const [col, info] of enumEntries) {
      const values = info?.values ?? [];
      if (values.length === 0) continue;
      const display = values.length > 10
        ? values.slice(0, 10).map((v) => `'${v}'`).join(", ") + `, ... (${values.length} shown)`
        : values.map((v) => `'${v}'`).join(", ");
      const suffix = info.truncated
        ? ` (top ${values.length} of ${info.total_distinct ?? "?"} values)`
        : "";
      lines.push(`    ${col}: [${display}]${suffix}`);
    }
  }

  // Numeric ranges
  const numEntries = Object.entries(meta.numeric_ranges ?? {});
  if (numEntries.length > 0) {
    lines.push("  Numeric ranges:");
    for (const [col, range] of numEntries) {
      lines.push(`    ${col}: ${range.min} to ${range.max}`);
    }
  }

  return lines.join("\n");
}

/**
 * Format known enum values for query generation prompts.
 * Only includes columns that have captured distinct values.
 */
export function formatEnumsForGeneration(meta: SourceMetadata): string | null {
  const enumEntries = Object.entries(meta.enums ?? {});
  if (enumEntries.length === 0) return null;

  const lines: string[] = ["Known values for filterable columns:"];
  for (const [col, info] of enumEntries) {
    const values = info?.values ?? [];
    if (values.length === 0) continue;
    const display = values.map((v) => `'${v}'`).join(", ");
    lines.push(`  ${col}: [${display}]`);
    if (info.truncated) {
      lines.push(`  (Top ${values.length} of ${info.total_distinct ?? "?"} values shown for ${col}.)`);
    }
    lines.push(`  When filtering on ${col}, use one of these exact values.`);
  }
  return lines.length > 1 ? lines.join("\n") : null;
}

/**
 * Check if a given enum column is truncated (medium-cardinality, not all values captured).
 */
export function isEnumTruncated(meta: SourceMetadata, column: string): boolean {
  const info = meta.enums?.[column];
  return info ? info.truncated : false;
}

/**
 * Get total distinct count for a truncated enum column.
 */
export function getEnumTotalDistinct(meta: SourceMetadata, column: string): number | undefined {
  const info = meta.enums?.[column];
  return info?.total_distinct;
}
