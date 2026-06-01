#!/usr/bin/env npx tsx

/**
 * Deterministic unit tests for JSON/JSONB key inference and the
 * connector-aware extraction expressions. No network, no LLM.
 *
 *   npx tsx scripts/test-json-keys.ts
 */

import { inferJsonKeys } from "../src/introspect/json-keys.js";
import { getJsonExtractExpression } from "../src/connectors/types.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string): void {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

// ── Build a synthetic amp_events.event_props (jsonb) sample ──────
// 100 docs: browser 100%, country 90%, plan 40%, mixed_type "score",
// tags (array), geo.country nested 80%, geo.coords deeply nested,
// rare key in 3% of docs.
const docs: Record<string, unknown>[] = [];
for (let i = 0; i < 100; i++) {
  const d: Record<string, unknown> = {
    browser: i % 2 === 0 ? "chrome" : "safari",
    tags: ["a", "b"],
  };
  if (i < 90) d.country = "US";
  if (i < 40) d.plan = "pro";
  // mixed scalar type: half numbers, half strings
  d.score = i % 2 === 0 ? 42 : "n/a";
  if (i < 80) d.geo = { country: "US", coords: { lat: 1.5, lng: 2.5 } };
  if (i < 3) d.experimental_flag = true;
  // a pure float key
  d.amount = 9.99;
  docs.push(d);
}

const { keys, sampledRows } = inferJsonKeys(docs);
const byPath = new Map(keys.map((k) => [k.path, k]));

console.log("\nJSON key inference:");
check("sampledRows = 100", sampledRows === 100, String(sampledRows));
check("browser detected as scalar string ~100%",
  byPath.get("browser")?.kind === "scalar" && byPath.get("browser")?.value_type === "string"
  && Math.round((byPath.get("browser")?.frequency ?? 0) * 100) === 100);
check("country ~90%", Math.round((byPath.get("country")?.frequency ?? 0) * 100) === 90);
check("plan ~40%", Math.round((byPath.get("plan")?.frequency ?? 0) * 100) === 40);
check("amount typed as float", byPath.get("amount")?.value_type === "float");
check("score is mixed → string", byPath.get("score")?.value_type === "string" && byPath.get("score")?.mixed_types === true);
check("tags detected as array (not scalar)", byPath.get("tags")?.kind === "array");
check("geo detected as nested-object", byPath.get("geo")?.kind === "nested-object");
check("geo.country expanded one level, scalar ~80%",
  byPath.get("geo.country")?.kind === "scalar" && Math.round((byPath.get("geo.country")?.frequency ?? 0) * 100) === 80);
check("geo.coords flagged deep (not expanded past one level)", byPath.get("geo.coords")?.kind === "deep");
check("geo.coords.lat NOT present (no two-level expansion)", !byPath.has("geo.coords.lat"));
check("rare experimental_flag present but ~3% (below threshold)",
  byPath.get("experimental_flag")?.kind === "scalar" && Math.round((byPath.get("experimental_flag")?.frequency ?? 0) * 100) === 3);

// Empty / non-object inputs
check("empty sample → no keys", inferJsonKeys([null, undefined, ""]).keys.length === 0);
check("top-level arrays yield no keys", inferJsonKeys([[1, 2], [3]]).keys.length === 0);
check("JSON strings are parsed", inferJsonKeys(['{"x":1}', '{"x":2}']).keys.find((k) => k.path === "x")?.value_type === "int");

// ── Extraction expressions (Malloy-valid raw-SQL function form) ──
console.log("\nPostgres extraction:");
check("jsonb scalar string", getJsonExtractExpression("postgres", "event_props", ["browser"], "string", "jsonb") === "jsonb_extract_path_text!(event_props, 'browser')",
  getJsonExtractExpression("postgres", "event_props", ["browser"], "string", "jsonb"));
check("jsonb scalar int → ::number", getJsonExtractExpression("postgres", "event_props", ["age"], "int", "jsonb") === "jsonb_extract_path_text!(event_props, 'age')::number",
  getJsonExtractExpression("postgres", "event_props", ["age"], "int", "jsonb"));
check("jsonb scalar timestamp → ::timestamp", getJsonExtractExpression("postgres", "event_props", ["ts"], "timestamp", "jsonb") === "jsonb_extract_path_text!(event_props, 'ts')::timestamp");
check("jsonb nested string", getJsonExtractExpression("postgres", "event_props", ["geo", "country"], "string", "jsonb") === "jsonb_extract_path_text!(event_props, 'geo', 'country')",
  getJsonExtractExpression("postgres", "event_props", ["geo", "country"], "string", "jsonb"));
check("jsonb nested float → ::number", getJsonExtractExpression("postgres", "event_props", ["geo", "lat"], "float", "jsonb") === "jsonb_extract_path_text!(event_props, 'geo', 'lat')::number");
check("json (not jsonb) uses json_extract_path_text", getJsonExtractExpression("postgres", "spec", ["data", "name"], "string", "json") === "json_extract_path_text!(spec, 'data', 'name')",
  getJsonExtractExpression("postgres", "spec", ["data", "name"], "string", "json"));
check("default (no nativeType) → jsonb accessor", getJsonExtractExpression("postgres", "props", ["k"], "string") === "jsonb_extract_path_text!(props, 'k')");

console.log("\nBigQuery extraction:");
check("scalar string JSON_VALUE!", getJsonExtractExpression("bigquery", "event_props", ["browser"], "string") === "JSON_VALUE!(event_props, '$.browser')",
  getJsonExtractExpression("bigquery", "event_props", ["browser"], "string"));
check("scalar int → ::number", getJsonExtractExpression("bigquery", "event_props", ["age"], "int") === "JSON_VALUE!(event_props, '$.age')::number",
  getJsonExtractExpression("bigquery", "event_props", ["age"], "int"));
check("nested path", getJsonExtractExpression("bigquery", "event_props", ["geo", "country"], "string") === "JSON_VALUE!(event_props, '$.geo.country')",
  getJsonExtractExpression("bigquery", "event_props", ["geo", "country"], "string"));
check("nested timestamp → ::timestamp", getJsonExtractExpression("bigquery", "event_props", ["geo", "ts"], "timestamp") === "JSON_VALUE!(event_props, '$.geo.ts')::timestamp");

console.log("");
if (failures > 0) {
  console.error(`✗ ${failures} test(s) failed.`);
  process.exit(1);
}
console.log("✓ All JSON key tests passed.");
