import fs from "node:fs/promises";
import path from "node:path";
import { executeQuery } from "../agent/execute.js";
import { loadMetadata, getSourceMetadata } from "../agent/metadata-loader.js";
import { extractGroupBy, extractAggregates } from "../session/parse-malloy.js";
import type { ConnectorKind } from "../connectors/types.js";
import type { NumericImpact, QueryShape, AggregateComparison } from "./types.js";
import type { Session } from "../session/types.js";

// ── Query shape detection ────────────────────────────────────

/**
 * Detect the query shape from a Malloy run block.
 *
 * - scalar_aggregate: has `aggregate:` but no `group_by:`
 * - grouped:          has `group_by:`
 * - detail:           neither (raw rows, no aggregation)
 *
 * Falls back to "grouped" if parsing is ambiguous (safer: compares row counts).
 */
export function detectQueryShape(malloy: string): QueryShape {
  const groupByFields = extractGroupBy(malloy);
  const aggregateFields = extractAggregates(malloy);

  if (groupByFields.length > 0) return "grouped";
  if (aggregateFields.length > 0) return "scalar_aggregate";
  return "detail";
}

// ── Impact computation ──────────────────────────────────────

/**
 * Compute numeric impact of a filter change by re-running the
 * last session query with both old and new filters.
 */
export async function computeImpact(options: {
  session: Session;
  termName: string;
  oldFilter: string;
  newFilter: string;
  modelsDir: string;
  billingProject?: string;
  /** The term's applies_to filename — used for metadata lookup in explainNoImpact */
  sourceFilename?: string;
  /** Connector kind for building the right Malloy connection */
  connectorKind?: ConnectorKind;
}): Promise<NumericImpact | null> {
  const { session, oldFilter, newFilter, modelsDir, billingProject, connectorKind } = options;

  const lastMalloy = session.last_malloy;
  const sourceFile = session.last_source;
  if (!lastMalloy || !sourceFile) return null;

  // Read all .malloy files
  const entries = await fs.readdir(modelsDir);
  const malloyFiles = new Map<string, string>();
  for (const f of entries.filter((e) => e.endsWith(".malloy"))) {
    const content = await fs.readFile(path.join(modelsDir, f), "utf-8");
    malloyFiles.set(f, content);
  }

  // Re-run the original query → "before"
  const beforeResult = await executeQuery({
    sourceFilename: sourceFile,
    runBlock: lastMalloy,
    modelsDir,
    malloyFiles,
    billingProject,
    connectorKind,
  });
  if (!beforeResult.ok) return null;

  // Substitute the new filter into the query → "after"
  const updatedMalloy = lastMalloy.replace(oldFilter, newFilter);
  if (updatedMalloy === lastMalloy) {
    // Filter text not found in the query — can't compute impact
    return null;
  }

  const afterResult = await executeQuery({
    sourceFilename: sourceFile,
    runBlock: updatedMalloy,
    modelsDir,
    malloyFiles,
    billingProject,
    connectorKind,
  });
  if (!afterResult.ok) return null;

  // ── Shape-aware comparison ─────────────────────────────────
  const shape = detectQueryShape(lastMalloy);
  const beforeRows = beforeResult.result.rows as Record<string, unknown>[];
  const afterRows = afterResult.result.rows as Record<string, unknown>[];

  const rowsBefore = beforeResult.result.totalRows;
  const rowsAfter = afterResult.result.totalRows;
  const rowsDeltaPct = pctChange(rowsBefore, rowsAfter);

  const aggregates: AggregateComparison[] = [];

  if (shape === "scalar_aggregate") {
    // Compare every aggregate column's value from the single result row
    const aggFields = extractAggregates(lastMalloy);
    const beforeRow = beforeRows[0];
    const afterRow = afterRows[0];

    if (beforeRow && afterRow) {
      const compared = new Set<string>();

      // Named aggregate fields first
      for (const field of aggFields) {
        if (field in beforeRow) {
          pushAgg(aggregates, field, beforeRow, afterRow);
          compared.add(field);
        }
      }

      // Then any remaining numeric columns not yet compared
      for (const [key, val] of Object.entries(beforeRow)) {
        if (compared.has(key)) continue;
        if (typeof val === "number" || typeof val === "bigint") {
          pushAgg(aggregates, key, beforeRow, afterRow);
        }
      }
    }
  } else if (shape === "grouped") {
    // Sum the first aggregate column across all rows as a secondary signal
    const aggFields = extractAggregates(lastMalloy);
    const col = resolveFirstAggColumn(aggFields, beforeRows);

    if (col) {
      const beforeSum = sumColumn(beforeRows, col);
      const afterSum = sumColumn(afterRows, col);
      aggregates.push({
        column: col,
        before: beforeSum,
        after: afterSum,
        deltaPct: pctChange(beforeSum, afterSum),
      });
    }
  }
  // DETAIL shape: no aggregates to compare — row count only

  // ── No-impact explanation ──────────────────────────────────
  let noImpactExplanation: string | undefined;
  const rowsSame = rowsBefore === rowsAfter;
  const allAggsSame = aggregates.every((a) => a.before === a.after);

  if (rowsSame && allAggsSame) {
    const explanation = await explainNoImpact(
      newFilter,
      options.sourceFilename ?? sourceFile,
      modelsDir,
    );
    if (explanation) noImpactExplanation = explanation;
  }

  return {
    mode: shape,
    rowsBefore,
    rowsAfter,
    rowsDeltaPct,
    aggregates,
    queryRun: updatedMalloy,
    noImpactExplanation,
  };
}

// ── Helpers ─────────────────────────────────────────────────

/** Percentage change, rounded to 2 decimal places. */
function pctChange(before: number, after: number): number {
  if (before === 0) return 0;
  return Math.round(((after - before) / before) * 10000) / 100;
}

function pushAgg(
  out: AggregateComparison[],
  col: string,
  beforeRow: Record<string, unknown>,
  afterRow: Record<string, unknown>,
): void {
  const bv = Number(beforeRow[col] ?? 0);
  const av = Number(afterRow[col] ?? 0);
  out.push({ column: col, before: bv, after: av, deltaPct: pctChange(bv, av) });
}

function sumColumn(rows: Record<string, unknown>[], col: string): number {
  let total = 0;
  for (const row of rows) {
    const v = row[col];
    if (typeof v === "number") total += v;
    else if (typeof v === "bigint") total += Number(v);
  }
  return total;
}

/**
 * Find the actual column name for the first aggregate field in the result rows.
 * Falls back to the first numeric column if the parsed name doesn't match.
 */
function resolveFirstAggColumn(
  aggFields: string[],
  rows: Record<string, unknown>[],
): string | undefined {
  if (rows.length === 0) return undefined;
  const firstRow = rows[0];

  // Exact match on parsed aggregate name
  for (const field of aggFields) {
    if (field in firstRow) return field;
  }

  // Fallback: first numeric column
  for (const [key, val] of Object.entries(firstRow)) {
    if (typeof val === "number" || typeof val === "bigint") return key;
  }

  return undefined;
}

// ── No-impact explanation ───────────────────────────────────

interface NumericComparison {
  column: string;
  op: ">=" | ">" | "<=" | "<";
  value: number;
}

/**
 * Extract numeric comparisons from a Malloy filter expression.
 *
 * E.g. "duration_minutes >= 2 and trip_count < 1000"
 *   → [{ column: "duration_minutes", op: ">=", value: 2 },
 *      { column: "trip_count", op: "<", value: 1000 }]
 */
function parseNumericComparisons(filter: string): NumericComparison[] {
  const results: NumericComparison[] = [];
  const regex = /(\w[\w.]*)\s*(>=|>|<=|<)\s*(-?\d+(?:\.\d+)?)/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(filter)) !== null) {
    results.push({
      column: match[1],
      op: match[2] as NumericComparison["op"],
      value: parseFloat(match[3]),
    });
  }
  return results;
}

/**
 * Try to explain why a filter correction had no numeric impact,
 * using the column bounds and enum values from metadata.json.
 *
 * Returns a human-readable explanation, or null if the cause
 * cannot be determined from metadata alone.
 */
export async function explainNoImpact(
  filter: string,
  sourceFilename: string,
  modelsDir: string,
): Promise<string | null> {
  const metadata = await loadMetadata(modelsDir);
  if (!metadata) return null;

  const sourceName = sourceFilename.replace(".malloy", "");
  const sourceMeta = getSourceMetadata(metadata, sourceName);
  if (!sourceMeta) return null;

  const explanations: string[] = [];

  // ── Numeric bounds ─────────────────────────────────────────
  const comparisons = parseNumericComparisons(filter);

  for (const cmp of comparisons) {
    const range = sourceMeta.numeric_ranges[cmp.column];
    if (!range) continue;

    switch (cmp.op) {
      case ">=":
        // Filter keeps col >= N. If data min >= N, nothing excluded.
        if (range.min >= cmp.value) {
          explanations.push(
            `${cmp.column} >= ${cmp.value} excluded nothing because ` +
              `the minimum ${cmp.column} in the data is already ${range.min}`,
          );
        }
        break;
      case ">":
        // Filter keeps col > N. If data min > N, nothing excluded.
        if (range.min > cmp.value) {
          explanations.push(
            `${cmp.column} > ${cmp.value} excluded nothing because ` +
              `the minimum ${cmp.column} in the data is ${range.min} (above the threshold)`,
          );
        }
        break;
      case "<=":
        // Filter keeps col <= N. If data max <= N, nothing excluded.
        if (range.max <= cmp.value) {
          explanations.push(
            `${cmp.column} <= ${cmp.value} excluded nothing because ` +
              `the maximum ${cmp.column} in the data is already ${range.max}`,
          );
        }
        break;
      case "<":
        // Filter keeps col < N. If data max < N, nothing excluded.
        if (range.max < cmp.value) {
          explanations.push(
            `${cmp.column} < ${cmp.value} excluded nothing because ` +
              `the maximum ${cmp.column} in the data is ${range.max} (below the threshold)`,
          );
        }
        break;
    }
  }

  // ── String enum coverage ───────────────────────────────────
  // Check if a string filter includes ALL known enum values.
  const enumRegex = /(\w[\w.]*)\s*=\s*('[^']*'(?:\s*\|\s*'[^']*')*)/g;
  let enumMatch: RegExpExecArray | null;
  while ((enumMatch = enumRegex.exec(filter)) !== null) {
    const col = enumMatch[1];
    const valuesStr = enumMatch[2];
    const enumInfo = sourceMeta.enums[col];

    // Only explain with confidence when all values are captured (not truncated)
    if (!enumInfo || enumInfo.truncated) continue;

    const filterValues = [...valuesStr.matchAll(/'([^']*)'/g)].map((m) => m[1]);
    const allKnown = enumInfo.values;

    if (filterValues.length >= allKnown.length) {
      const filterSet = new Set(filterValues);
      if (allKnown.every((v) => filterSet.has(v))) {
        explanations.push(
          `${col} filter includes all ${allKnown.length} known values — nothing is excluded`,
        );
      }
    }
  }

  if (explanations.length === 0) return null;
  return explanations.join("; ");
}
