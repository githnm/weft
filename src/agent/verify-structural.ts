import type { StructuralCheck } from "./types.js";

/**
 * Extract aggregate column names from a Malloy `run:` block.
 *
 * Looks for `aggregate:` sections and collects bare names and
 * `name is ...` patterns. Falls back to returning an empty array
 * if parsing fails (caller should then use numeric-column heuristic).
 */
export function parseAggregateNames(malloy: string): string[] {
  const names: string[] = [];
  // Match lines inside an aggregate: block
  // We look for the aggregate: keyword then collect indented lines until
  // we hit a line at the same or lesser indentation with a different keyword.
  const aggregateBlockRe = /\baggregate:\s*\n((?:[ \t]+.+\n?)*)/g;
  // Also match single-line: aggregate: name, name2
  const aggregateInlineRe = /\baggregate:\s+(.+)/g;

  for (const m of malloy.matchAll(aggregateBlockRe)) {
    const block = m[1];
    for (const line of block.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("//")) continue;
      // `name is expr` → name
      const isMatch = trimmed.match(/^(\w+)\s+is\b/);
      if (isMatch) {
        names.push(isMatch[1]);
        continue;
      }
      // bare reference to existing measure: just a word (possibly with commas)
      for (const token of trimmed.split(",")) {
        const word = token.trim().match(/^(\w+)$/);
        if (word) names.push(word[1]);
      }
    }
  }

  for (const m of malloy.matchAll(aggregateInlineRe)) {
    // Check if this was already captured by the block regex
    const inline = m[1].trim();
    // Skip if it starts with newline (block form already handled)
    if (inline === "") continue;
    for (const token of inline.split(",")) {
      const trimmed = token.trim();
      const isMatch = trimmed.match(/^(\w+)\s+is\b/);
      if (isMatch) {
        names.push(isMatch[1]);
        continue;
      }
      const word = trimmed.match(/^(\w+)$/);
      if (word) names.push(word[1]);
    }
  }

  // Deduplicate
  return [...new Set(names)];
}

/**
 * Run all deterministic structural checks on query results.
 * Returns an array of check results (may be empty if all OK).
 */
export function runStructuralChecks(
  rows: Record<string, unknown>[],
  totalRows: number,
  aggregateColumns: string[],
): StructuralCheck[] {
  const checks: StructuralCheck[] = [];

  // ── (a) Empty result ──────────────────────────────────────────
  if (totalRows === 0) {
    checks.push({
      id: "empty_result",
      severity: "warning",
      message: "Query returned no rows. The filters or joins may not match any data.",
    });
    return checks; // no point running further checks on empty data
  }

  // Determine which columns are aggregate vs group_by
  // If we have parsed aggregate names, use those; otherwise fall back
  // to numeric-column heuristic.
  const allColumns = rows.length > 0 ? Object.keys(rows[0]) : [];
  let aggCols: string[];
  if (aggregateColumns.length > 0) {
    aggCols = allColumns.filter((c) => aggregateColumns.includes(c));
  } else {
    // Heuristic: numeric columns are likely aggregates
    aggCols = allColumns.filter((c) => {
      const first = rows.find((r) => r[c] !== null && r[c] !== undefined);
      return first && (typeof first[c] === "number" || typeof first[c] === "bigint");
    });
  }

  // ── (b) All-null aggregates ───────────────────────────────────
  if (aggCols.length > 0) {
    const allNull = aggCols.every((col) =>
      rows.every((row) => row[col] === null || row[col] === undefined),
    );
    if (allNull) {
      checks.push({
        id: "all_null_aggregates",
        severity: "warning",
        message:
          "Aggregated values are all null. The underlying column may have no non-null values for the filtered set.",
      });
    }
  }

  // ── (c) Suspicious zero ───────────────────────────────────────
  // Only flag for count/sum-like columns (names containing "count", "total", "sum", "row_count")
  const countSumPattern = /count|total|sum|row_count/i;
  const suspiciousZeroCols = aggCols.filter((col) => countSumPattern.test(col));
  if (suspiciousZeroCols.length > 0) {
    for (const col of suspiciousZeroCols) {
      const allZero = rows.every((row) => row[col] === 0);
      if (allZero) {
        checks.push({
          id: "suspicious_zero",
          severity: "info",
          message: `Column "${col}" is zero across all rows. Verify the filters and measures match your intent.`,
        });
      }
    }
  }

  // ── (d) Single-row count of zero ──────────────────────────────
  if (rows.length === 1 && aggCols.length > 0) {
    const singleZero = aggCols.some((col) => rows[0][col] === 0);
    if (singleZero && !checks.some((c) => c.id === "suspicious_zero")) {
      checks.push({
        id: "single_row_zero",
        severity: "info",
        message:
          "Result is a single row with a zero aggregate. Verify the filters and measures match your intent.",
      });
    }
  }

  // ── (e) NaN or Infinity ───────────────────────────────────────
  let hasNanInf = false;
  for (const row of rows) {
    for (const col of allColumns) {
      const val = row[col];
      if (typeof val === "number" && (!Number.isFinite(val) || Number.isNaN(val))) {
        hasNanInf = true;
        break;
      }
    }
    if (hasNanInf) break;
  }
  if (hasNanInf) {
    checks.push({
      id: "nan_or_infinity",
      severity: "warning",
      message:
        "Result contains NaN or infinite values, likely from division by zero or unbounded calculations.",
    });
  }

  // ── (f) Excessive numeric precision ───────────────────────────
  let hasExcessivePrecision = false;
  for (const row of rows) {
    for (const col of aggCols) {
      const val = row[col];
      if (typeof val === "number" && Number.isFinite(val)) {
        const str = String(val);
        const dotIndex = str.indexOf(".");
        if (dotIndex !== -1 && str.length - dotIndex - 1 > 6) {
          hasExcessivePrecision = true;
          break;
        }
      }
    }
    if (hasExcessivePrecision) break;
  }
  if (hasExcessivePrecision) {
    checks.push({
      id: "excessive_precision",
      severity: "info",
      message:
        "Numeric results shown at full precision. Consider rounding in the query for cleaner output.",
    });
  }

  return checks;
}
