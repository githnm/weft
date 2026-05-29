/**
 * Warehouse result normalization (Defect 4).
 *
 * Connectors return values that are not JSON-safe: BigInt (broke trace
 * serialization), Date objects, byte buffers, decimal wrapper objects, etc.
 * This is the ONE place we convert raw warehouse values into JSON-safe ones,
 * applied where rows leave the execution layer. Every downstream consumer —
 * tracing, CLI display, the web graph, what-if — then receives normalized
 * values, so no serializer or display path has to special-case warehouse types.
 */

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

/**
 * Convert a single warehouse value to a JSON-safe form.
 * - bigint  → number when within safe-integer range, else string (precision-safe)
 * - Date    → ISO 8601 string
 * - bytes   → base64 string
 * - arrays/plain objects → recursively normalized
 * - exotic objects (Decimal, etc.) → their string form
 */
export function normalizeValue(v: unknown): unknown {
  if (v === null || v === undefined) return v;

  const t = typeof v;
  if (t === "number" || t === "string" || t === "boolean") return v;

  if (t === "bigint") {
    const n = v as bigint;
    return n <= MAX_SAFE && n >= MIN_SAFE ? Number(n) : n.toString();
  }

  if (v instanceof Date) {
    return Number.isNaN(v.getTime()) ? null : v.toISOString();
  }

  if (typeof Buffer !== "undefined" && Buffer.isBuffer(v)) {
    return (v as Buffer).toString("base64");
  }
  if (v instanceof Uint8Array) {
    return Buffer.from(v).toString("base64");
  }

  if (Array.isArray(v)) {
    return v.map(normalizeValue);
  }

  if (t === "object") {
    const proto = Object.getPrototypeOf(v);
    const isPlain = proto === Object.prototype || proto === null;
    if (!isPlain) {
      // Exotic wrapper (e.g. a Decimal/BigNumber) with no own enumerable
      // fields: prefer its string representation to preserve precision.
      const keys = Object.keys(v as object);
      if (keys.length === 0 && typeof (v as { toString?: unknown }).toString === "function") {
        return String(v);
      }
    }
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>)) {
      out[k] = normalizeValue((v as Record<string, unknown>)[k]);
    }
    return out;
  }

  // symbol, function, or anything else — stringify defensively
  return String(v);
}

/** Normalize one result row. */
export function normalizeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(row)) out[k] = normalizeValue(row[k]);
  return out;
}

/** Normalize an array of result rows (the execution-layer boundary). */
export function normalizeRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
  return rows.map(normalizeRow);
}
