/**
 * JSON/JSONB key inference.
 *
 * Given a sample of raw values from a JSON column, discover the common
 * top-level keys (plus one level of object nesting) with their frequency
 * and dominant scalar type. Arrays and deeper nesting are detected and
 * recorded but never expanded into columns.
 *
 * This is connector-agnostic: it operates on already-decoded JS values
 * (node-postgres decodes json/jsonb to JS; BigQuery JSON arrives as a
 * string and is parsed here). Pure and deterministic — unit-tested offline.
 */

import type { JsonKeyInfo } from "./types.js";

/** Max key entries retained per JSON column (bounds inspection.json size). */
const MAX_KEYS = 60;

/** ISO-8601 date / datetime detector for best-effort timestamp typing. */
const ISO_TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;

type Family = "numeric" | "boolean" | "timestamp" | "string";

interface Accumulator {
  count: number;
  kindVotes: Map<JsonKeyInfo["kind"], number>;
  /** Scalar value families seen, with float-ness tracked for numerics. */
  families: Set<Family>;
  sawFloat: boolean;
}

function vote<K>(map: Map<K, number>, key: K): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function getAcc(map: Map<string, Accumulator>, path: string): Accumulator {
  let acc = map.get(path);
  if (!acc) {
    acc = { count: 0, kindVotes: new Map(), families: new Set(), sawFloat: false };
    map.set(path, acc);
  }
  return acc;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Classify a scalar's value family; records float-ness on the accumulator. */
function recordScalarFamily(acc: Accumulator, v: unknown): void {
  if (typeof v === "boolean") {
    acc.families.add("boolean");
  } else if (typeof v === "number") {
    acc.families.add("numeric");
    if (!Number.isInteger(v)) acc.sawFloat = true;
  } else if (typeof v === "string") {
    acc.families.add(ISO_TIMESTAMP_RE.test(v) ? "timestamp" : "string");
  } else {
    // bigint or other → treat as string for extraction
    acc.families.add("string");
  }
}

/** Resolve a scalar accumulator's dominant value type + mixed flag. */
function resolveScalarType(acc: Accumulator): { value_type: JsonKeyInfo["value_type"]; mixed: boolean } {
  const fams = acc.families;
  if (fams.size === 0) return { value_type: "string", mixed: false };
  if (fams.size > 1) return { value_type: "string", mixed: true };
  const only = [...fams][0];
  switch (only) {
    case "numeric": return { value_type: acc.sawFloat ? "float" : "int", mixed: false };
    case "boolean": return { value_type: "boolean", mixed: false };
    case "timestamp": return { value_type: "timestamp", mixed: false };
    default: return { value_type: "string", mixed: false };
  }
}

/** Parse one raw column value into a JSON document (or null if unusable). */
function parseDoc(value: unknown): unknown {
  if (value == null) return null;
  if (typeof value === "string") {
    const s = value.trim();
    if (!s) return null;
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  return value;
}

export interface JsonInferenceResult {
  keys: JsonKeyInfo[];
  /** Count of non-null JSON documents the inference was computed from. */
  sampledRows: number;
}

/**
 * Infer JSON keys from a sample of raw column values.
 *
 * Records, per key path: presence count, structural kind (scalar /
 * nested-object / array / deep), and — for scalars — the dominant value
 * type. Recurses exactly ONE level into object-valued keys; arrays and
 * deeper objects are flagged, not expanded.
 */
export function inferJsonKeys(values: unknown[]): JsonInferenceResult {
  const acc = new Map<string, Accumulator>();
  let sampledRows = 0;

  for (const raw of values) {
    const doc = parseDoc(raw);
    if (!isPlainObject(doc)) continue; // top-level must be an object to have keys
    sampledRows++;

    for (const key of Object.keys(doc)) {
      const a = getAcc(acc, key);
      a.count++;
      const v = doc[key];

      if (Array.isArray(v)) {
        vote(a.kindVotes, "array");
      } else if (isPlainObject(v)) {
        vote(a.kindVotes, "nested-object");
        // Recurse exactly one level.
        for (const subKey of Object.keys(v)) {
          const subPath = `${key}.${subKey}`;
          const sa = getAcc(acc, subPath);
          sa.count++;
          const sv = v[subKey];
          if (Array.isArray(sv)) {
            vote(sa.kindVotes, "array");
          } else if (isPlainObject(sv)) {
            vote(sa.kindVotes, "deep"); // object inside nested object — not expanded
          } else {
            vote(sa.kindVotes, "scalar");
            if (sv !== null) recordScalarFamily(sa, sv);
          }
        }
      } else {
        vote(a.kindVotes, "scalar");
        if (v !== null) recordScalarFamily(a, v);
      }
    }
  }

  if (sampledRows === 0) return { keys: [], sampledRows: 0 };

  const keys: JsonKeyInfo[] = [];
  for (const [path, a] of acc) {
    // Dominant structural kind by vote.
    let kind: JsonKeyInfo["kind"] = "scalar";
    let best = -1;
    for (const [k, n] of a.kindVotes) {
      if (n > best) { best = n; kind = k; }
    }
    const info: JsonKeyInfo = {
      path,
      frequency: a.count / sampledRows,
      kind,
    };
    if (kind === "scalar") {
      const { value_type, mixed } = resolveScalarType(a);
      info.value_type = value_type;
      if (mixed) info.mixed_types = true;
    }
    keys.push(info);
  }

  // Sort by frequency desc, then path asc; cap to bound size.
  keys.sort((x, y) => (y.frequency - x.frequency) || x.path.localeCompare(y.path));
  return { keys: keys.slice(0, MAX_KEYS), sampledRows };
}
