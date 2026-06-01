/**
 * Shared Malloy compilation helpers used by both the build step
 * (new model creation) and the refine step (model editing).
 *
 * Extracted here so the compile-with-retry pattern, structural
 * validation, connection building, and table catalog generation
 * stay in sync across both flows.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Runtime } from "@malloydata/malloy";
import type { ConnectorKind } from "../connectors/types.js";
import { getAggregateSafeExpression, getJsonExtractExpression } from "../connectors/types.js";
import { buildMalloyConnection } from "../connectors/malloy-connection.js";
import type { InspectionResult, JsonKeyInfo } from "../introspect/types.js";
import type { LLMUsage } from "../llm/anthropic.js";

// ── Compile timeout ─────────────────────────────────────────────

/**
 * Malloy compilation timeout in milliseconds.
 * Postgres schema resolution over a network is significantly slower
 * than BigQuery, and multi-table models with joins need time for each
 * table's schema to be fetched. 60s accommodates multi-table models
 * over typical cloud Postgres latencies.
 */
export const COMPILE_TIMEOUT_MS = 60_000;

// ── JSON key rendering for the table catalog ────────────────────

/** Only JSON keys present in ≥ this fraction of sampled docs are proposable. */
const JSON_KEY_THRESHOLD = 0.05;

/** Suggest a Malloy dimension name from a JSON key path ("geo.country" → "geo_country"). */
function jsonDimName(path: string): string {
  return path.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "").toLowerCase();
}

/**
 * Render a JSON/JSONB column's discovered keys as catalog guidance: the
 * proposable scalar keys (≥ threshold) each with a ready-to-use, connector-aware
 * extraction expression, and the remaining keys flagged as available but not
 * auto-exposed (arrays need unnest; deep nesting / rare keys aren't proposed).
 */
function renderJsonKeys(
  connectorKind: ConnectorKind | undefined,
  columnName: string,
  nativeType: string,
  keys: JsonKeyInfo[],
  sampledRows: number | undefined,
): string[] {
  const lines: string[] = [];
  const pct = (f: number) => `${Math.round(f * 100)}%`;

  const proposable = keys.filter((k) => k.kind === "scalar" && k.frequency >= JSON_KEY_THRESHOLD);
  const notExposed = keys.filter((k) => !(k.kind === "scalar" && k.frequency >= JSON_KEY_THRESHOLD));

  const sampleNote = sampledRows ? `${sampledRows} docs sampled` : "sampled";
  lines.push(`      ↳ JSON column (${sampleNote}). Discovered keys:`);

  if (proposable.length > 0) {
    lines.push(`        proposable dimensions (≥${Math.round(JSON_KEY_THRESHOLD * 100)}% of docs) — use the exact extraction expression:`);
    for (const k of proposable.slice(0, 20)) {
      const vt = k.value_type ?? "string";
      const expr = getJsonExtractExpression(connectorKind, columnName, k.path.split("."), vt, nativeType);
      const mixed = k.mixed_types ? ", mixed→string" : "";
      lines.push(`          • ${k.path} (${vt}${mixed}, ${pct(k.frequency)}) → dimension: ${jsonDimName(k.path)} is ${expr}`);
    }
  } else {
    lines.push(`        (no scalar key reached the ${Math.round(JSON_KEY_THRESHOLD * 100)}% threshold — do not invent dimensions for this column)`);
  }

  if (notExposed.length > 0) {
    const notes = notExposed.slice(0, 12).map((k) => {
      if (k.kind === "array") return `${k.path} (array — needs unnest)`;
      if (k.kind === "deep") return `${k.path} (deeply nested)`;
      if (k.kind === "nested-object") return `${k.path} (object — scalar sub-keys listed individually)`;
      return `${k.path} (${pct(k.frequency)} — below threshold)`;
    });
    lines.push(`        available but NOT auto-exposed: ${notes.join("; ")}`);
  }

  return lines;
}

// ── Table catalog builder ───────────────────────────────────────

/**
 * Build a table catalog from inspection.json for LLM prompts.
 * Shows a clean catalog of tables with their columns, types, and
 * the connector table expression needed to reference each table
 * directly (prevents circular references from substrate .malloy files).
 */
export function buildTableCatalog(
  inspection: InspectionResult,
  tableNames: string[],
): string {
  const selectedSet = new Set(tableNames.map((n) => n.toLowerCase()));
  const lines: string[] = [];

  for (const table of inspection.tables) {
    if (!selectedSet.has(table.name.toLowerCase())) continue;

    const tableRef = table.malloy_table_source ??
      `bigquery.table('${inspection.dataset_project}.${inspection.dataset_name}.${table.name}')`;

    lines.push(`TABLE: ${table.name}`);
    lines.push(`  Malloy table ref: ${tableRef}`);
    lines.push(`  Rows: ${table.row_count.toLocaleString()}`);
    lines.push(`  Columns:`);

    const connKind = inspection.connector_kind as ConnectorKind | undefined;
    for (const col of table.columns) {
      let desc = `    ${col.name}: ${col.type}`;
      if (col.nullable === false) desc += " NOT NULL";
      if (col.distinct_count > 0) desc += ` (${col.distinct_count} distinct)`;
      // Annotate columns that need casting for aggregation
      const safeExpr = getAggregateSafeExpression(connKind, col.name, col.type);
      if (safeExpr && safeExpr !== col.name) {
        desc += ` [aggregate as: ${safeExpr}]`;
      } else if (safeExpr === null && !(col.json_keys && col.json_keys.length > 0)) {
        desc += ` [not aggregatable]`;
      }
      lines.push(desc);

      // JSON/JSONB column: surface discovered keys + extraction expressions so
      // the model can expose them as connector-aware dimensions.
      if (col.json_keys && col.json_keys.length > 0) {
        for (const l of renderJsonKeys(connKind, col.name, col.type, col.json_keys, col.json_sampled_rows)) {
          lines.push(l);
        }
      }
    }

    lines.push("");
  }

  // Add FK relationships between selected tables
  if (inspection.foreign_keys && inspection.foreign_keys.length > 0) {
    const relevantFKs = inspection.foreign_keys.filter(
      (fk) =>
        selectedSet.has(fk.source_table.toLowerCase()) &&
        selectedSet.has(fk.target_table.toLowerCase()),
    );
    if (relevantFKs.length > 0) {
      lines.push("FK RELATIONSHIPS:");
      for (const fk of relevantFKs) {
        lines.push(`  ${fk.source_table}.${fk.source_column} → ${fk.target_table}.${fk.target_column}`);
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

// ── Structural pre-compile validation ───────────────────────────

export interface StructuralCheckResult {
  errors: string[];
  warnings: string[];
  /** Model text after auto-fixes (present only if fixes were applied). */
  fixedMalloy?: string;
  /** Descriptions of auto-fixes that were applied. */
  autoFixes?: string[];
}

/**
 * Validate a model.malloy structurally before the expensive network
 * compile. Checks:
 * 1. No import statements (model must be self-contained)
 * 2. Join targets reference known tables
 * 3. Join columns exist on the referenced tables
 * 4. No cycles in the join graph
 * 5. No "with primary_key" in joins (Rule 10)
 * 6. UUID columns cast to ::string in aggregates (Rule 11, auto-fixed)
 * 7. || concatenation replaced with concat() (Rule 15, auto-fixed)
 * 8. Dimension/measure names that shadow source columns (Rule 12, warning)
 */
export function validateStructurally(
  modelMalloy: string,
  inspection: InspectionResult,
): StructuralCheckResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check for import statements (should not exist)
  if (/^\s*import\s+"/m.test(modelMalloy)) {
    errors.push(
      "Model contains import statements. The model must be self-contained — " +
      "declare each table source directly using the connector table expression.",
    );
  }

  // Build column lookup from inspection
  const knownColumns = new Map<string, Set<string>>();
  for (const table of inspection.tables) {
    const colSet = new Set<string>();
    for (const col of table.columns) {
      colSet.add(col.name.toLowerCase());
    }
    knownColumns.set(table.name.toLowerCase(), colSet);
  }

  // Parse inline source declarations to map source names → table names
  const sourceToTable = new Map<string, string>();
  const inlineSourcePattern =
    /^\s*source:\s+(\w+)\s+is\s+\w+\.table\(['"](?:[^'"]*\.)?([^'"]+)['"]\)/gm;
  for (const m of modelMalloy.matchAll(inlineSourcePattern)) {
    sourceToTable.set(m[1].toLowerCase(), m[2].toLowerCase());
  }

  // Parse join declarations
  const joinPattern = /join_(?:one|many|cross):\s+(\w+)\s+is\s+(\w+)\s+on\s+(.+)/g;

  for (const match of modelMalloy.matchAll(joinPattern)) {
    const alias = match[1].toLowerCase();
    const targetSource = match[2].toLowerCase();
    const onClause = match[3];

    // Resolve target to table name
    const targetTable = sourceToTable.get(targetSource);
    if (!targetTable) {
      if (!knownColumns.has(targetSource)) {
        errors.push(
          `Join "${match[1]}": target "${match[2]}" is not declared as a source and doesn't match any known table.`,
        );
      }
      continue;
    }

    if (!knownColumns.has(targetTable)) {
      errors.push(
        `Join "${match[1]}": target source "${match[2]}" references table "${targetTable}" which does not exist in the substrate.`,
      );
      continue;
    }

    // Check columns in ON clause
    const colRefPattern = new RegExp(`${alias}\\.(\\w+)`, "gi");
    const targetCols = knownColumns.get(targetTable)!;
    for (const colMatch of onClause.matchAll(colRefPattern)) {
      const remoteCol = colMatch[1].toLowerCase();
      if (!targetCols.has(remoteCol)) {
        errors.push(
          `Join "${match[1]}": column "${colMatch[1]}" does not exist on table "${targetTable}". ` +
          `Available columns: ${[...targetCols].slice(0, 10).join(", ")}${targetCols.size > 10 ? ", ..." : ""}`,
        );
      }
    }
  }

  // Cycle detection via DFS
  const sourceJoins = new Map<string, string[]>();
  const sourceBlocks = modelMalloy.split(/(?=^\s*source:)/m);
  for (const block of sourceBlocks) {
    const nameMatch = block.match(/^\s*source:\s+(\w+)/);
    if (!nameMatch) continue;
    const sourceName = nameMatch[1].toLowerCase();
    const targets: string[] = [];
    for (const jm of block.matchAll(/join_(?:one|many|cross):\s+\w+\s+is\s+(\w+)/g)) {
      targets.push(jm[1].toLowerCase());
    }
    if (targets.length > 0) {
      sourceJoins.set(sourceName, targets);
    }
  }

  const visited = new Set<string>();
  const inStack = new Set<string>();

  function hasCycle(node: string, pathSoFar: string[]): string[] | null {
    if (inStack.has(node)) return [...pathSoFar, node];
    if (visited.has(node)) return null;

    visited.add(node);
    inStack.add(node);
    pathSoFar.push(node);

    for (const neighbor of sourceJoins.get(node) ?? []) {
      const cycle = hasCycle(neighbor, [...pathSoFar]);
      if (cycle) return cycle;
    }

    inStack.delete(node);
    return null;
  }

  for (const node of sourceJoins.keys()) {
    if (!visited.has(node)) {
      const cycle = hasCycle(node, []);
      if (cycle) {
        errors.push(
          `Join cycle detected: ${cycle.join(" → ")}. ` +
          "Remove one of the joins to break the cycle.",
        );
        break;
      }
    }
  }

  // ── Rule 10: Check for "with primary_key" in join declarations ──
  const withPKPattern = /join_(?:one|many|cross):\s+(\w+)\s+is\s+(\w+)\s+with\s+primary_key/gi;
  for (const m of modelMalloy.matchAll(withPKPattern)) {
    errors.push(
      `Join "${m[1]}": uses "with primary_key" which is not valid Malloy syntax (Rule 10). ` +
      `Use an explicit ON clause: join_one: ${m[1]} is ${m[2]} on <left_key> = ${m[1]}.<right_key>.`,
    );
  }

  // ── Connector-driven aggregate safety (replaces hardcoded UUID check) ──
  // Build a map of columns that need casting for aggregation, driven by
  // the connector kind from inspection.json. This generalizes across all
  // connectors — not just Postgres UUID, but any future type/connector combo.
  const connectorKind = inspection.connector_kind as ConnectorKind | undefined;
  const aggregateCasts = new Map<string, string>(); // colName → safe expression
  for (const table of inspection.tables) {
    for (const col of table.columns) {
      const safe = getAggregateSafeExpression(connectorKind, col.name, col.type);
      if (safe && safe !== col.name) {
        aggregateCasts.set(col.name.toLowerCase(), safe);
      }
    }
  }

  let fixedMalloy = modelMalloy;
  const autoFixes: string[] = [];

  if (aggregateCasts.size > 0) {
    for (const m of modelMalloy.matchAll(/\b(count|sum|avg|min|max)\((\w+)\)/gi)) {
      const colLower = m[2].toLowerCase();
      const safeExpr = aggregateCasts.get(colLower);
      if (safeExpr) {
        const original = `${m[1]}(${m[2]})`;
        const replacement = `${m[1]}(${safeExpr})`;
        fixedMalloy = fixedMalloy.split(original).join(replacement);
        autoFixes.push(
          `Auto-cast "${m[2]}" for safe aggregation: ${original} → ${replacement}`,
        );
      }
    }
  }

  // ── Rule 15: String concatenation — || is not valid Malloy ──
  // Auto-fix dimension/measure definition lines; flag remaining as errors.
  const fixedLines = fixedMalloy.split("\n");
  let concatFixed = false;

  for (let i = 0; i < fixedLines.length; i++) {
    const line = fixedLines[i];
    const trimmed = line.trim();

    // Skip comments and lines without ||
    if (trimmed.startsWith("//") || !line.includes("||")) continue;

    // Auto-fix: dimension/measure definition lines with chained ||
    const defMatch = line.match(
      /^(\s*(?:dimension|measure):\s+\w+\s+is\s+)(.+)$/,
    );
    if (defMatch) {
      const prefix = defMatch[1];
      const expr = defMatch[2];
      const parts = expr.split("||").map((p) => p.trim());
      if (parts.length >= 2) {
        const newExpr = `concat(${parts.join(", ")})`;
        fixedLines[i] = prefix + newExpr;
        autoFixes.push(
          `Replaced || with concat() (Rule 15): ${expr.trim()} → ${newExpr}`,
        );
        concatFixed = true;
      }
    }
  }

  if (concatFixed) {
    fixedMalloy = fixedLines.join("\n");
  }

  // Check if any || remains on non-comment lines (complex cases auto-fix missed)
  for (const line of fixedMalloy.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//")) continue;
    if (!line.includes("||")) continue;

    // Simple heuristic: || is outside string literal if quote count before it is even
    const idx = line.indexOf("||");
    const before = line.substring(0, idx);
    const quoteCount = (before.match(/'/g) || []).length;
    if (quoteCount % 2 === 0) {
      errors.push(
        `String concatenation uses "||" which is not valid Malloy (Rule 15). ` +
        `Use concat(a, b, c) instead of a || b || c.`,
      );
      break;
    }
  }

  // ── Rule 12: Dimension/measure names colliding with source columns ──
  const allSourceColumns = new Set<string>();
  for (const [, tableName] of sourceToTable) {
    const cols = knownColumns.get(tableName);
    if (cols) {
      for (const c of cols) allSourceColumns.add(c);
    }
  }

  if (allSourceColumns.size > 0) {
    for (const m of modelMalloy.matchAll(/\bdimension:\s+(\w+)\s+is\s+/g)) {
      if (allSourceColumns.has(m[1].toLowerCase())) {
        warnings.push(
          `Dimension "${m[1]}" has the same name as a source column (Rule 12). ` +
          `This shadows the original column. Rename to "${m[1]}_derived" or similar.`,
        );
      }
    }
    for (const m of modelMalloy.matchAll(/\bmeasure:\s+(\w+)\s+is\s+/g)) {
      if (allSourceColumns.has(m[1].toLowerCase())) {
        warnings.push(
          `Measure "${m[1]}" has the same name as a source column (Rule 12). ` +
          `This shadows the original column. Rename to "${m[1]}_total" or similar.`,
        );
      }
    }
  }

  const result: StructuralCheckResult = { errors, warnings };
  if (autoFixes.length > 0) {
    result.fixedMalloy = fixedMalloy;
    result.autoFixes = autoFixes;
  }
  return result;
}

// ── Malloy error surfacing (Defect 2: no swallowed errors) ──────
//
// Malloy throws compile errors whose `.message` is often just the generic
// header "Error(s) compiling model:" while the REAL diagnostics — the problem
// text, the line, the offending expression — live in `.problems` (or `.log`).
// Catching `.message` alone yields blank errors that the system can't
// diagnose, surface, or auto-repair. These helpers extract everything.

interface MalloyProblemLike {
  message?: string;
  error?: string;
  severity?: string;
  at?: { url?: string; range?: { start?: { line?: number; character?: number } } };
}

/** Format one Malloy problem/log entry with its source location, if any. */
function formatProblem(p: MalloyProblemLike | string): string {
  if (typeof p === "string") return p;
  const msg = p.message ?? p.error ?? JSON.stringify(p);
  const start = p.at?.range?.start;
  const loc =
    start && typeof start.line === "number"
      ? ` (line ${start.line + 1}${typeof start.character === "number" ? `, col ${start.character + 1}` : ""})`
      : "";
  return `${msg}${loc}`;
}

/** Format an array of Malloy problems/log messages (e.g. from validate()). */
export function formatProblems(problems: Array<MalloyProblemLike | string>): string {
  return problems.map(formatProblem).join("\n");
}

/**
 * Surface the FULL underlying Malloy compiler error from a thrown error.
 * Prefers `.problems` / `.log` (the real diagnostics) over the generic
 * `.message` header. Never returns an empty string.
 */
export function formatMalloyError(err: unknown): string {
  if (err == null) return "Unknown compilation error.";
  const anyErr = err as { message?: string; problems?: unknown; log?: unknown };

  const problems = Array.isArray(anyErr.problems)
    ? (anyErr.problems as Array<MalloyProblemLike | string>)
    : Array.isArray(anyErr.log)
      ? (anyErr.log as Array<MalloyProblemLike | string>)
      : null;

  if (problems && problems.length > 0) {
    const detail = formatProblems(problems);
    const hasGenericHeader =
      typeof anyErr.message === "string" && /^error\(s\) compiling/i.test(anyErr.message.trim());
    const header =
      typeof anyErr.message === "string" && anyErr.message.trim() && !hasGenericHeader
        ? anyErr.message.trim() + "\n"
        : "";
    const out = (header + detail).trim();
    if (out) return out;
  }

  const message = err instanceof Error ? err.message : String(err);
  return message && message.trim()
    ? message.trim()
    : "Unknown compilation error (the error object carried no message or problems).";
}

// ── Compile model.malloy ─────────────────────────────────────────

export type CompileResult =
  | { ok: true }
  | { ok: false; error: string; timedOut?: boolean };

export async function compileModel(
  modelMalloyContent: string,
  modelDir: string,
  connectorKind: ConnectorKind | undefined,
  billingProject?: string,
): Promise<CompileResult> {
  const modelFileName = "model.malloy";

  const allFiles = new Map<string, string>();
  allFiles.set(modelFileName, modelMalloyContent);

  const urlReader = {
    readURL: async (url: URL) => {
      const filePath = fileURLToPath(url);
      const name = path.basename(filePath);
      if (allFiles.has(name)) {
        return allFiles.get(name)!;
      }
      return fs.readFile(filePath, "utf-8");
    },
  };

  const connection = buildMalloyConnection({ connectorKind, billingProject });
  const runtime = new Runtime({ urlReader, connection });
  const fileUrl = pathToFileURL(path.resolve(modelDir, modelFileName));

  try {
    await Promise.race([
      runtime.getModel(fileUrl),
      new Promise((_, reject) =>
        setTimeout(
          () => reject(new Error(`Compilation timed out after ${COMPILE_TIMEOUT_MS / 1000}s`)),
          COMPILE_TIMEOUT_MS,
        ),
      ),
    ]);
    return { ok: true };
  } catch (err: unknown) {
    const rawMessage = err instanceof Error ? err.message : String(err);
    const timedOut = rawMessage.includes("timed out");
    // Surface the FULL compiler diagnostics, not just the generic header.
    return { ok: false, error: formatMalloyError(err), timedOut };
  }
}

// ── Per-measure compile validation ──────────────────────────────

export interface MeasureValidationResult {
  name: string;
  kind: "measure" | "dimension";
  expression: string;
  /** The full (possibly multi-line collapsed) definition line as written. */
  fullLine: string;
  /** The source that owns this item (multi-source models). */
  owner: string;
  ok: boolean;
  error?: string;
}

export interface ModelItem {
  kind: "measure" | "dimension";
  name: string;
  expr: string;
  fullLine: string;
  owner: string;
}

/**
 * Parse every measure:/dimension: item and the source that owns it.
 *
 * Owner = the most recent top-level `source: NAME is ...` declaration. This is
 * multi-source safe: a model can declare several sources and define items on a
 * later one (the old logic always picked the FIRST source and mis-validated).
 */
export function parseModelItems(modelMalloy: string): ModelItem[] {
  const items: ModelItem[] = [];
  let currentSource: string | null = null;

  for (const line of modelMalloy.split("\n")) {
    const src = line.match(/^source:\s+(\w+)\s+is\b/);
    if (src) {
      currentSource = src[1];
      continue;
    }
    const im = line.match(/^\s+(measure|dimension):\s+(\w+)\s+is\s+(.+?)\s*$/);
    if (im && currentSource) {
      items.push({
        kind: im[1] as "measure" | "dimension",
        name: im[2],
        expr: im[3].trim(),
        fullLine: im[0].trim(),
        owner: currentSource,
      });
    }
  }
  return items;
}

/**
 * Compile each measure/dimension against the connector, IN THE FULL MODEL
 * CONTEXT, targeting the source that actually owns it. Catches individual
 * errors (wrong types, unknown functions, bad casts, broken joins) regardless
 * of WHICH SQL idiom was wrong — the general defense.
 *
 * This is a MECHANISM, not a rule: it catches ANY bad expression, including
 * idioms we haven't enumerated in the syntax reference.
 */
export async function validateMeasuresIndividually(
  modelMalloy: string,
  modelDir: string,
  connectorKind: ConnectorKind | undefined,
  billingProject?: string,
): Promise<MeasureValidationResult[]> {
  const items = parseModelItems(modelMalloy);
  const results: MeasureValidationResult[] = [];

  for (const item of items) {
    const runBlock =
      item.kind === "measure"
        ? `run: ${item.owner} -> { aggregate: ${item.name} }`
        : `run: ${item.owner} -> { group_by: ${item.name}; aggregate: _vc is count(); limit: 1 }`;

    // Compile the WHOLE model plus a run block that exercises this one item.
    const result = await compileModel(
      `${modelMalloy}\n\n${runBlock}`,
      modelDir,
      connectorKind,
      billingProject,
    );
    results.push({
      name: item.name,
      kind: item.kind,
      expression: item.expr,
      fullLine: item.fullLine,
      owner: item.owner,
      ok: result.ok,
      error: result.ok ? undefined : result.error,
    });
  }

  return results;
}

// ── Helpers ─────────────────────────────────────────────────────

export function isFatalCompileError(
  result: { ok: false; error: string; timedOut?: boolean },
): boolean {
  return (
    result.timedOut === true ||
    result.error.includes("call stack") ||
    result.error.includes("Maximum call stack size")
  );
}

export function addUsage(a: LLMUsage, b: LLMUsage): LLMUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}
