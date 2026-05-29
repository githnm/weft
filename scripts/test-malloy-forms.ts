#!/usr/bin/env npx tsx

/**
 * Empirical test: compile various Malloy aggregate forms against a real
 * connector and print the generated SQL for each.
 *
 * Discovers the canonical SQL each Malloy expression translates to,
 * per connector. Feeds the syntax reference and connector aggregate-safety.
 *
 * Usage:
 *   POSTGRES_URL=... npx tsx scripts/test-malloy-forms.ts --substrate ./substrate
 *   BQ_PROJECT_ID=... npx tsx scripts/test-malloy-forms.ts --substrate ./substrate --connector bigquery
 *
 * If --substrate is omitted, looks in ./substrate then ./models.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Runtime } from "@malloydata/malloy";
import { buildMalloyConnection } from "../src/connectors/malloy-connection.js";
import type { ConnectorKind } from "../src/connectors/types.js";

// ── CLI args ────────────────────────────────────────────────────

function parseArgs(): { substrateDir: string; connector: ConnectorKind } {
  const args = process.argv.slice(2);
  let substrateDir = "";
  let connector: ConnectorKind | undefined;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--substrate" && args[i + 1]) {
      substrateDir = args[++i];
    } else if (args[i] === "--connector" && args[i + 1]) {
      connector = args[++i] as ConnectorKind;
    }
  }

  // Auto-detect connector from inspection.json
  if (!connector) {
    try {
      const dir = substrateDir || "./substrate";
      const raw = JSON.parse(
        require("node:fs").readFileSync(path.join(dir, "inspection.json"), "utf-8"),
      );
      connector = raw.connector_kind ?? "bigquery";
    } catch {
      connector = process.env.POSTGRES_URL ? "postgres" : "bigquery";
    }
  }

  // Auto-detect substrate dir
  if (!substrateDir) {
    for (const d of ["./substrate", "./models"]) {
      try {
        require("node:fs").accessSync(path.join(d, "inspection.json"));
        substrateDir = d;
        break;
      } catch { /* continue */ }
    }
    if (!substrateDir) {
      console.error("No substrate directory found. Use --substrate <path>.");
      process.exit(1);
    }
  }

  return { substrateDir, connector };
}

// ── Types ───────────────────────────────────────────────────────

interface TestColumn {
  name: string;
  type: string;
  normalizedType: string;
}

interface TestTable {
  name: string;
  malloyTableSource: string;
  columns: TestColumn[];
}

interface TestCase {
  label: string;
  malloyExpr: string;
  /** true = this form may not compile; test it and report either way */
  mayFail?: boolean;
  /** Full query body (inside `-> { }`) for query-shape patterns (nest, time group, ratio). */
  viewBody?: string;
}

interface TestResult {
  label: string;
  malloyExpr: string;
  sql: string | null;
  error: string | null;
}

// ── Load inspection data ────────────────────────────────────────

async function loadTestTable(substrateDir: string): Promise<TestTable> {
  const raw = await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
  const inspection = JSON.parse(raw);

  // Pick the first table with a reasonable set of columns
  const tables = inspection.tables as Array<{
    name: string;
    malloy_table_source?: string;
    row_count: number;
    columns: Array<{
      name: string;
      type: string;
      normalized_type?: string;
    }>;
  }>;

  // Prefer a table with at least one string, one numeric, and one timestamp column
  const best = tables.find((t) => {
    const types = new Set(t.columns.map((c) => c.normalized_type ?? c.type.toLowerCase()));
    return types.has("string") && (types.has("integer") || types.has("float"));
  }) ?? tables[0];

  if (!best) {
    throw new Error("No tables found in inspection.json");
  }

  const malloyTableSource = best.malloy_table_source ??
    `bigquery.table('${inspection.dataset_project}.${inspection.dataset_name}.${best.name}')`;

  return {
    name: best.name,
    malloyTableSource,
    columns: best.columns.map((c) => ({
      name: c.name,
      type: c.type,
      normalizedType: c.normalized_type ?? c.type.toLowerCase(),
    })),
  };
}

// ── Find columns by type ────────────────────────────────────────

function findColumn(table: TestTable, ...types: string[]): TestColumn | undefined {
  return table.columns.find((c) => types.includes(c.normalizedType));
}

function findColumnByRawType(table: TestTable, rawType: string): TestColumn | undefined {
  return table.columns.find((c) => c.type.toLowerCase() === rawType.toLowerCase());
}

// ── Build test cases ────────────────────────────────────────────

function buildTestCases(table: TestTable): TestCase[] {
  const cases: TestCase[] = [];

  const stringCol = findColumn(table, "string");
  const numericCol = findColumn(table, "integer", "float");
  const timeCol = findColumn(table, "timestamp", "datetime", "date");
  const uuidCol = findColumnByRawType(table, "uuid");

  // Always test: count() — row count
  cases.push({
    label: "count() — row count",
    malloyExpr: "measure: test_m is count()",
  });

  // Aggregate forms on string column
  if (stringCol) {
    cases.push({
      label: `count(${stringCol.name}) — distinct count of string column`,
      malloyExpr: `measure: test_m is count(${stringCol.name})`,
    });
    cases.push({
      label: `${stringCol.name}.count() — method-style count on string`,
      malloyExpr: `measure: test_m is ${stringCol.name}.count()`,
      mayFail: true,
    });
    cases.push({
      label: `count(distinct ${stringCol.name}) — SQL-style (should fail)`,
      malloyExpr: `measure: test_m is count(distinct ${stringCol.name})`,
      mayFail: true,
    });
    // Filtered count
    cases.push({
      label: `count() {where: ${stringCol.name} is not null} — filtered count`,
      malloyExpr: `measure: test_m is count() { where: ${stringCol.name} is not null }`,
    });
  }

  // Aggregate forms on numeric column
  if (numericCol) {
    cases.push({
      label: `count(${numericCol.name}) — distinct count of numeric column`,
      malloyExpr: `measure: test_m is count(${numericCol.name})`,
    });
    cases.push({
      label: `sum(${numericCol.name}) — sum`,
      malloyExpr: `measure: test_m is sum(${numericCol.name})`,
      mayFail: true,
    });
    cases.push({
      label: `${numericCol.name}.sum() — method-style sum`,
      malloyExpr: `measure: test_m is ${numericCol.name}.sum()`,
    });
    cases.push({
      label: `${numericCol.name}.avg() — method-style avg`,
      malloyExpr: `measure: test_m is ${numericCol.name}.avg()`,
    });
    cases.push({
      label: `avg(${numericCol.name}) — function-style avg (should fail)`,
      malloyExpr: `measure: test_m is avg(${numericCol.name})`,
      mayFail: true,
    });
    cases.push({
      label: `${numericCol.name}.min() — method-style min`,
      malloyExpr: `measure: test_m is ${numericCol.name}.min()`,
    });
    cases.push({
      label: `${numericCol.name}.max() — method-style max`,
      malloyExpr: `measure: test_m is ${numericCol.name}.max()`,
    });
  }

  // UUID-specific tests
  if (uuidCol) {
    cases.push({
      label: `count(${uuidCol.name}) — distinct count of UUID (may fail)`,
      malloyExpr: `measure: test_m is count(${uuidCol.name})`,
      mayFail: true,
    });
    cases.push({
      label: `count(${uuidCol.name}::string) — UUID cast to string`,
      malloyExpr: `measure: test_m is count(${uuidCol.name}::string)`,
    });
  }

  // Time truncation tests
  if (timeCol) {
    cases.push({
      label: `${timeCol.name}.year — time truncation to year`,
      malloyExpr: `dimension: test_d is ${timeCol.name}.year`,
    });
    cases.push({
      label: `${timeCol.name}.month — time truncation to month`,
      malloyExpr: `dimension: test_d is ${timeCol.name}.month`,
    });
    cases.push({
      label: `${timeCol.name}.day — time truncation to day`,
      malloyExpr: `dimension: test_d is ${timeCol.name}.day`,
    });
    cases.push({
      label: `${timeCol.name}::date — cast to date`,
      malloyExpr: `dimension: test_d is ${timeCol.name}::date`,
      mayFail: true,
    });
  }

  // String operations
  if (stringCol) {
    cases.push({
      label: `concat(${stringCol.name}, '_suffix') — concat function`,
      malloyExpr: `dimension: test_d is concat(${stringCol.name}, '_suffix')`,
    });
    cases.push({
      label: `${stringCol.name} || '_suffix' — SQL concat (should fail)`,
      malloyExpr: `dimension: test_d is ${stringCol.name} || '_suffix'`,
      mayFail: true,
    });
    cases.push({
      label: `upper(${stringCol.name}) — upper function`,
      malloyExpr: `dimension: test_d is upper(${stringCol.name})`,
    });
    cases.push({
      label: `length(${stringCol.name}) — length function`,
      malloyExpr: `dimension: test_d is length(${stringCol.name})`,
    });
  }

  // Null handling
  if (stringCol) {
    cases.push({
      label: `${stringCol.name} is null — Malloy null check`,
      malloyExpr: `dimension: test_d is ${stringCol.name} is null`,
      mayFail: true,
    });
    cases.push({
      label: `${stringCol.name} is not null — Malloy not-null check`,
      malloyExpr: `dimension: test_d is ${stringCol.name} is not null`,
      mayFail: true,
    });
    cases.push({
      label: `coalesce(${stringCol.name}, 'default') — coalesce function`,
      malloyExpr: `dimension: test_d is coalesce(${stringCol.name}, 'default')`,
    });
  }

  // Pick/when/else (conditional)
  if (numericCol) {
    cases.push({
      label: `pick 'high' when ${numericCol.name} > 100 else 'low' — conditional`,
      malloyExpr: `dimension: test_d is pick 'high' when ${numericCol.name} > 100 else 'low'`,
    });
    cases.push({
      label: `CASE WHEN (should fail)`,
      malloyExpr: `dimension: test_d is CASE WHEN ${numericCol.name} > 100 THEN 'high' ELSE 'low' END`,
      mayFail: true,
    });
  }

  // ── Complex query-shape patterns (Defect 3a) — verify, don't assume ──
  const stringCol2 = table.columns.filter((c) => c.normalizedType === "string")[1];

  // Ratio of two aggregates (as a measure) with a zero-guard.
  if (stringCol) {
    cases.push({
      label: `ratio measure: count() / nullif(count(col), 0)`,
      malloyExpr: `measure: test_m is count() / nullif(count(${stringCol.name}), 0)`,
    });
  }

  // Time grouping in a query body: group_by <time>.month
  if (timeCol) {
    cases.push({
      label: `query: group_by ${timeCol.name}.month — time grouping`,
      malloyExpr: `(time grouping)`,
      viewBody: `group_by: ${timeCol.name}.month\n  aggregate: n is count()\n  order_by: n desc\n  limit: 12`,
    });
  }

  // Nesting: nest goes INSIDE the query block.
  if (stringCol) {
    const inner = stringCol2 ? stringCol2.name : (timeCol ? `${timeCol.name}.month` : stringCol.name);
    cases.push({
      label: `query: nest a sub-aggregation INSIDE -> { }`,
      malloyExpr: `(nest)`,
      viewBody: `group_by: ${stringCol.name}\n  aggregate: total is count()\n  nest: breakdown is {\n    group_by: ${inner}\n    aggregate: n is count()\n    limit: 3\n  }\n  limit: 5`,
    });
  }

  // Ratio inside a query body referencing two aggregates.
  if (stringCol) {
    cases.push({
      label: `query: ratio of two aggregates in the body`,
      malloyExpr: `(ratio in body)`,
      viewBody: `aggregate:\n    rows_total is count()\n    distinct_vals is count(${stringCol.name})\n    ratio is count() / nullif(count(${stringCol.name}), 0)`,
    });
  }

  return cases;
}

// ── Compile and extract SQL ─────────────────────────────────────

async function testForm(
  connector: ConnectorKind,
  table: TestTable,
  testCase: TestCase,
  billingProject?: string,
): Promise<TestResult> {
  // Build a minimal model with the test expression, then a run block
  const isMeasure = testCase.malloyExpr.startsWith("measure:");
  const isDimension = testCase.malloyExpr.startsWith("dimension:");

  let model: string;
  let runBlock: string;
  if (testCase.viewBody) {
    // Query-shape pattern: test the body directly inside a run block.
    model = `source: _test is ${table.malloyTableSource} extend {\n}`;
    runBlock = `run: _test -> {\n  ${testCase.viewBody}\n}`;
  } else {
    model = `source: _test is ${table.malloyTableSource} extend {\n  ${testCase.malloyExpr}\n}`;
    if (isMeasure) {
      runBlock = `run: _test -> { aggregate: test_m }`;
    } else if (isDimension) {
      runBlock = `run: _test -> { group_by: test_d; aggregate: _n is count(); limit: 1 }`;
    } else {
      runBlock = `run: _test -> { aggregate: _n is count() }`;
    }
  }

  const fullMalloy = `${model}\n\n${runBlock}`;

  // Write to a temp file, compile, extract SQL
  const tmpDir = path.join(process.cwd(), `_tmp_test_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "test.malloy");
  await fs.writeFile(tmpFile, fullMalloy, "utf-8");

  try {
    const connection = buildMalloyConnection({
      connectorKind: connector,
      billingProject,
    });

    const urlReader = {
      readURL: async (url: URL) => fs.readFile(fileURLToPath(url), "utf-8"),
    };

    const runtime = new Runtime({ urlReader, connection });
    const modelMaterializer = runtime.loadModel(pathToFileURL(tmpFile));

    // getSQL() on the final query (the run: block)
    const sql = await Promise.race([
      modelMaterializer.loadFinalQuery().getSQL(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Compilation timed out after 30s")), 30_000),
      ),
    ]);

    return { label: testCase.label, malloyExpr: testCase.malloyExpr, sql, error: null };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      label: testCase.label,
      malloyExpr: testCase.malloyExpr,
      sql: null,
      error: message.split("\n")[0],
    };
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── Main ────────────────────────────────────────────────────────

async function main() {
  const { substrateDir, connector } = parseArgs();
  const billingProject = process.env.BQ_PROJECT_ID;

  console.log(`\n═══ Malloy Aggregate Forms Test ═══`);
  console.log(`Connector: ${connector}`);
  console.log(`Substrate: ${substrateDir}\n`);

  const table = await loadTestTable(substrateDir);
  console.log(`Table: ${table.name}`);
  console.log(`Columns: ${table.columns.map((c) => `${c.name}:${c.type}`).join(", ")}\n`);

  const cases = buildTestCases(table);
  console.log(`Running ${cases.length} test cases...\n`);

  const results: TestResult[] = [];

  for (const tc of cases) {
    process.stdout.write(`  ${tc.label}... `);
    const result = await testForm(connector, table, tc, billingProject);
    results.push(result);

    if (result.sql) {
      console.log("✓ COMPILED");
    } else {
      console.log(`✗ ${tc.mayFail ? "(expected)" : "UNEXPECTED"} ${result.error}`);
    }
  }

  // ── Summary ──────────────────────────────────────────────────

  console.log("\n═══ Results ═══\n");

  const compiled = results.filter((r) => r.sql);
  const failed = results.filter((r) => !r.sql);

  console.log(`Compiled: ${compiled.length}/${results.length}`);
  console.log(`Failed:   ${failed.length}/${results.length}\n`);

  // Print SQL for compiled forms
  console.log("── Generated SQL per form ──\n");
  for (const r of compiled) {
    console.log(`▸ ${r.label}`);
    console.log(`  Malloy: ${r.malloyExpr}`);
    // Extract just the interesting parts of the SQL
    const sql = r.sql!;
    // Find DISTINCT, COUNT, SUM etc. in the SQL
    const selectMatch = sql.match(/SELECT\s+([\s\S]*?)(?:\s+FROM\s+)/i);
    if (selectMatch) {
      console.log(`  SQL SELECT: ${selectMatch[1].trim()}`);
    } else {
      console.log(`  SQL: ${sql.slice(0, 200)}`);
    }
    console.log();
  }

  // Print errors for failed forms
  if (failed.length > 0) {
    console.log("── Failed forms ──\n");
    for (const r of failed) {
      console.log(`✗ ${r.label}`);
      console.log(`  Malloy: ${r.malloyExpr}`);
      console.log(`  Error:  ${r.error}`);
      console.log();
    }
  }

  // ── Key findings summary ──────────────────────────────────────

  console.log("── Key findings ──\n");

  // Check: does count(col) produce DISTINCT?
  const countColResult = compiled.find((r) => r.label.includes("distinct count of string"));
  if (countColResult?.sql) {
    const hasDistinct = countColResult.sql.toUpperCase().includes("DISTINCT");
    console.log(`count(col) produces DISTINCT: ${hasDistinct}`);
    if (hasDistinct) {
      console.log(`  → count(col) IS the Malloy distinct count form`);
    } else {
      console.log(`  → count(col) does NOT produce DISTINCT — this is a BUG or different semantics`);
    }
  }

  // Check: does method-style .sum() work?
  const sumMethodResult = compiled.find((r) => r.label.includes("method-style sum"));
  const sumFuncResult = results.find((r) => r.label.includes("sum(") && !r.label.includes("method"));
  if (sumMethodResult) {
    console.log(`col.sum() compiles: YES`);
  }
  if (sumFuncResult) {
    console.log(`sum(col) compiles: ${sumFuncResult.sql ? "YES" : "NO — " + sumFuncResult.error}`);
  }

  // Check UUID
  const uuidRawResult = results.find((r) => r.label.includes("UUID (may fail)"));
  const uuidCastResult = results.find((r) => r.label.includes("UUID cast to string"));
  if (uuidRawResult) {
    console.log(`count(uuid_col) compiles: ${uuidRawResult.sql ? "YES" : "NO"}`);
  }
  if (uuidCastResult) {
    console.log(`count(uuid_col::string) compiles: ${uuidCastResult.sql ? "YES" : "NO"}`);
  }

  // Check || vs concat
  const concatResult = results.find((r) => r.label.includes("concat function"));
  const pipeResult = results.find((r) => r.label.includes("SQL concat"));
  console.log(`concat() compiles: ${concatResult?.sql ? "YES" : "NO"}`);
  console.log(`|| compiles: ${pipeResult?.sql ? "YES" : "NO"}`);

  // Check CASE vs pick
  const pickResult = results.find((r) => r.label.includes("conditional"));
  const caseResult = results.find((r) => r.label.includes("CASE WHEN"));
  console.log(`pick/when/else compiles: ${pickResult?.sql ? "YES" : "NO"}`);
  console.log(`CASE/WHEN/END compiles: ${caseResult?.sql ? "YES" : "NO"}`);

  console.log();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
