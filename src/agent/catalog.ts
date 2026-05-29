import type { SourceSummary } from "./types.js";

/**
 * Parse a .malloy file and extract a compact catalog entry.
 *
 * This is a lightweight regex-based parser — it doesn't need the
 * Malloy compiler, just enough structure to build a catalog for
 * source selection.
 */
export function extractSourceSummary(filename: string, content: string): SourceSummary | null {
  // Match `source: <name> is ...`
  const sourceMatch = content.match(/^\s*source:\s+(\w+)\s+is\b/m);
  if (!sourceMatch) return null;

  const sourceName = sourceMatch[1];

  // primary_key
  const pkMatch = content.match(/^\s*primary_key:\s+(\w+)/m);
  const primaryKey = pkMatch?.[1];

  // join_one targets: `join_one: <alias> is <source_name>`
  const joins: string[] = [];
  for (const m of content.matchAll(/^\s*join_one:\s+(\w+)\s+is\b/gm)) {
    joins.push(m[1]);
  }

  // dimensions: `dimension: <name> is ...` (explicit declarations — derived fields)
  const dimensions: string[] = [];
  for (const m of content.matchAll(/^\s*dimension:\s+(\w+)\s+is\b/gm)) {
    dimensions.push(m[1]);
  }

  // Source columns from inventory comments (pass-through columns on the source
  // table — queryable without declaration). These lines look like:
  //   //   dimension: col1, col2
  //   //   attribute: col3, col4
  //   //   time: col5, col6
  for (const m of content.matchAll(/^\s*\/\/\s{2,}(dimension|attribute|time|pk|fk|numeric):\s*(.+)/gm)) {
    const cols = m[2].split(",").map((s) => s.trim()).filter(Boolean);
    dimensions.push(...cols);
  }

  // measures: `measure: <name> is ...`
  const measures: string[] = [];
  for (const m of content.matchAll(/^\s*measure:\s+(\w+)\s+is\b/gm)) {
    measures.push(m[1]);
  }

  // views: `view: <name> is ...`
  const views: string[] = [];
  for (const m of content.matchAll(/^\s*view:\s+(\w+)\s+is\b/gm)) {
    views.push(m[1]);
  }

  return {
    filename,
    sourceName,
    primaryKey,
    joins,
    dimensions,
    measures,
    views,
  };
}

/**
 * Format a catalog of source summaries into a compact text block
 * suitable for an LLM prompt (< 1KB per source).
 */
export function formatCatalog(summaries: SourceSummary[]): string {
  return summaries
    .map((s) => {
      const lines: string[] = [];
      lines.push(`FILE: ${s.filename}`);
      lines.push(`  source: ${s.sourceName}`);
      if (s.primaryKey) lines.push(`  primary_key: ${s.primaryKey}`);
      if (s.joins.length > 0) lines.push(`  joins: ${s.joins.join(", ")}`);
      if (s.dimensions.length > 0) lines.push(`  dimensions: ${s.dimensions.join(", ")}`);
      if (s.measures.length > 0) lines.push(`  measures: ${s.measures.join(", ")}`);
      if (s.views.length > 0) lines.push(`  views: ${s.views.join(", ")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}
