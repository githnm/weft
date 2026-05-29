/**
 * LLM output verification — never trust LLM self-report.
 *
 * After any LLM edit to a Malloy artifact, this module verifies:
 * 1. Identity: the artifact actually changed
 * 2. Structural: the change matches the requested intent
 * 3. Semantic: the generated SQL reflects the requested semantics
 *
 * Used by build, refine, correct, and any future LLM-editing flow.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Runtime } from "@malloydata/malloy";
import type { ConnectorKind } from "../connectors/types.js";
import { buildMalloyConnection } from "../connectors/malloy-connection.js";
import { computeModelDiff, type ModelDiff } from "./diff.js";

// ── 1. Identity verification ─────────────────────────────────────

/**
 * Normalize whitespace for identity comparison.
 * Collapses all whitespace to single spaces so trivial reformatting
 * doesn't fool the check.
 */
export function normalizeWhitespace(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

/**
 * Check if two Malloy files are semantically identical
 * (ignoring whitespace differences).
 */
export function isIdentical(before: string, after: string): boolean {
  return normalizeWhitespace(before) === normalizeWhitespace(after);
}

/**
 * Check if a structured diff shows any real changes.
 */
export function hasStructuralChanges(diff: ModelDiff): boolean {
  return diff.entries.length > 0 || diff.sources_changed;
}

// ── 2. Semantic intent matching ──────────────────────────────────

/**
 * Semantic intents that can be verified against generated SQL.
 * Each intent has a name and SQL patterns to look for.
 */
interface SemanticIntent {
  name: string;
  /** Words in the user's request that trigger this intent */
  triggerWords: string[];
  /** SQL patterns that MUST appear if this intent is active */
  requiredSqlPatterns: RegExp[];
  /** Human-readable description of what to check */
  description: string;
}

const SEMANTIC_INTENTS: SemanticIntent[] = [
  {
    // In Malloy, count(col) already produces COUNT(DISTINCT col) in SQL.
    // This intent verifies the SQL contains COUNT(DISTINCT ...).
    // Note: if the measure is already count(col), the SQL WILL match —
    // use checkAlreadySatisfied() BEFORE the LLM call to detect this.
    name: "distinct_count",
    triggerWords: ["distinct", "unique", "deduplicated", "dedupe"],
    requiredSqlPatterns: [/COUNT\s*\(\s*DISTINCT\b/i],
    description: "distinct/unique count should produce COUNT(DISTINCT ...)",
  },
  {
    name: "sum",
    triggerWords: ["total", "sum"],
    requiredSqlPatterns: [/\bSUM\s*\(/i],
    description: "total/sum should produce SUM(...)",
  },
  {
    name: "average",
    triggerWords: ["average", "avg", "mean"],
    requiredSqlPatterns: [/\bAVG\s*\(/i],
    description: "average should produce AVG(...)",
  },
  {
    name: "minimum",
    triggerWords: ["minimum", "min", "lowest", "earliest", "first"],
    requiredSqlPatterns: [/\bMIN\s*\(/i],
    description: "minimum should produce MIN(...)",
  },
  {
    name: "maximum",
    triggerWords: ["maximum", "max", "highest", "latest", "last"],
    requiredSqlPatterns: [/\bMAX\s*\(/i],
    description: "maximum should produce MAX(...)",
  },
];

export interface SemanticCheckResult {
  intent: string;
  expected: string;
  found: boolean;
  detail: string;
}

/**
 * Extract semantic intents from a natural-language request and check
 * them against the generated SQL.
 *
 * Returns only the intents that were detected AND failed verification.
 * Empty array = no semantic mismatches detected.
 */
export function checkSemanticIntents(
  request: string,
  sql: string,
): SemanticCheckResult[] {
  const requestLower = request.toLowerCase();
  const failures: SemanticCheckResult[] = [];

  for (const intent of SEMANTIC_INTENTS) {
    // Check if the request triggers this intent
    const triggered = intent.triggerWords.some((w) => requestLower.includes(w));
    if (!triggered) continue;

    // Check if the SQL satisfies the intent
    const satisfied = intent.requiredSqlPatterns.some((p) => p.test(sql));
    if (!satisfied) {
      failures.push({
        intent: intent.name,
        expected: intent.description,
        found: false,
        detail: `Request mentions "${intent.triggerWords.find((w) => requestLower.includes(w))}" but generated SQL does not contain the expected pattern`,
      });
    }
  }

  return failures;
}

// ── 2b. "Already satisfied" detection ───────────────────────────
//
// Before invoking the LLM, check if the current model already satisfies the
// semantic intent of a refinement request. Prevents useless LLM round-trips
// and the "identical output → failure" trap.
//
// Key case: count(col) IS the distinct count in Malloy (SQL: COUNT(DISTINCT col)).
// If the user asks for "distinct" and the measure already uses count(col),
// the request is already satisfied — do not send to the LLM.

/**
 * Extract all measure definitions from a Malloy model.
 * Returns a map of measure_name → expression.
 */
export function extractMeasures(malloy: string): Map<string, string> {
  const measures = new Map<string, string>();
  const regex = /\bmeasure:\s+(\w+)\s+is\s+(.+)/g;
  let match;
  while ((match = regex.exec(malloy)) !== null) {
    measures.set(match[1], match[2].trim());
  }
  return measures;
}

/**
 * Check if the current model already satisfies the semantic intent
 * of a refinement request — before invoking the LLM.
 *
 * Returns null if no "already satisfied" condition detected, otherwise
 * returns { satisfied: true, reason: string }.
 *
 * Currently handles:
 * - distinct_count: count(col) already IS the distinct count
 */
export function checkAlreadySatisfied(
  request: string,
  currentMalloy: string,
  targetMeasureName?: string,
): { satisfied: boolean; reason: string } | null {
  const requestLower = request.toLowerCase();

  // ─ Distinct count intent ─
  const distinctTriggered = ["distinct", "unique", "deduplicated", "dedupe"]
    .some((w) => requestLower.includes(w));

  if (!distinctTriggered) return null;

  const measures = extractMeasures(currentMalloy);

  // If a specific measure is targeted, check just that one
  if (targetMeasureName) {
    const expr = measures.get(targetMeasureName);
    if (expr && /\bcount\s*\([^)]+\)/.test(expr)) {
      return {
        satisfied: true,
        reason: `The measure "${targetMeasureName}" already uses count(column), which produces ` +
          `COUNT(DISTINCT column) in SQL. In Malloy, count(col) IS the distinct count. ` +
          `No change needed.`,
      };
    }
    return null;
  }

  // No specific target — check if ANY count(col) measure exists whose name
  // appears in the request (e.g., "make active_users distinct")
  for (const [name, expr] of measures) {
    if (/\bcount\s*\([^)]+\)/.test(expr)) {
      if (requestLower.includes(name.toLowerCase())) {
        return {
          satisfied: true,
          reason: `The measure "${name}" already uses count(column), which produces ` +
            `COUNT(DISTINCT column) in SQL. In Malloy, count(col) IS the distinct count. ` +
            `No change needed.`,
        };
      }
    }
  }

  return null;
}

// ── 3. SQL extraction from Malloy model ──────────────────────────

/**
 * Compile a model.malloy and extract the SQL for a specific measure.
 * Returns the SQL string, or null if compilation/extraction fails.
 *
 * This is the bridge between Malloy expressions and the actual SQL
 * the connector will execute — the source of truth for semantic verification.
 */
export async function extractMeasureSQL(options: {
  modelMalloy: string;
  sourceName: string;
  measureName: string;
  modelDir: string;
  connectorKind?: ConnectorKind;
  billingProject?: string;
}): Promise<string | null> {
  const { modelMalloy, sourceName, measureName, modelDir, connectorKind, billingProject } = options;

  const runBlock = `run: ${sourceName} -> { aggregate: ${measureName} }`;
  const fullMalloy = `${modelMalloy}\n\n${runBlock}`;

  const tmpDir = path.join(modelDir, `_tmp_sql_${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const tmpFile = path.join(tmpDir, "model.malloy");
  await fs.writeFile(tmpFile, fullMalloy, "utf-8");

  try {
    const connection = buildMalloyConnection({ connectorKind, billingProject });
    const urlReader = {
      readURL: async (url: URL) => fs.readFile(fileURLToPath(url), "utf-8"),
    };

    const runtime = new Runtime({ urlReader, connection });
    const sql = await Promise.race([
      runtime.loadModel(pathToFileURL(tmpFile)).loadFinalQuery().getSQL(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("SQL extraction timed out")), 30_000),
      ),
    ]);

    return sql;
  } catch {
    return null;
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
  }
}

// ── 4. Combined verification ─────────────────────────────────────

export interface VerificationResult {
  /** The artifact changed in a meaningful way */
  changed: boolean;
  /** Semantic intent mismatches (empty = no mismatches) */
  semanticMismatches: SemanticCheckResult[];
  /** Structured diff */
  diff: ModelDiff;
  /** Human-readable summary of issues */
  issues: string[];
}

/**
 * Full verification of an LLM-edited Malloy model.
 *
 * Checks identity, structural changes, and optionally semantic intents
 * (if the request and SQL are provided).
 */
export function verifyModelEdit(options: {
  before: string;
  after: string;
  request?: string;
  sql?: string;
}): VerificationResult {
  const { before, after, request, sql } = options;

  const identical = isIdentical(before, after);
  const diff = computeModelDiff(before, after);
  const structurallyChanged = hasStructuralChanges(diff);
  const issues: string[] = [];

  if (identical) {
    issues.push("The model was not changed — LLM returned identical content.");
  } else if (!structurallyChanged) {
    issues.push(
      "The model text changed but no structural differences detected " +
      "(measures, dimensions, joins, views, filters are all the same). " +
      "Changes may be cosmetic only.",
    );
  }

  let semanticMismatches: SemanticCheckResult[] = [];
  if (request && sql) {
    semanticMismatches = checkSemanticIntents(request, sql);
    for (const m of semanticMismatches) {
      issues.push(`Semantic mismatch: ${m.detail}`);
    }
  }

  return {
    changed: !identical && structurallyChanged,
    semanticMismatches,
    diff,
    issues,
  };
}
