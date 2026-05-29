import fs from "node:fs/promises";
import path from "node:path";
import { chat, stripCodeFences, type LLMUsage } from "../llm/anthropic.js";
import { MALLOY_SYNTAX_RULES, MALLOY_SYNTAX_REFERENCE } from "../llm/malloy-syntax-ref.js";
import type { ConnectorKind } from "../connectors/types.js";
import type { InspectionResult } from "../introspect/types.js";
import { createModel } from "../models/create.js";
import { loadManifest, saveManifest } from "../models/manifest.js";
import type { ModelManifest } from "../models/manifest.js";
import { captureModelDesignTrace } from "../context/instrument.js";
import {
  buildTableCatalog,
  validateStructurally,
  compileModel,
  validateMeasuresIndividually,
  isFatalCompileError,
  addUsage,
  type MeasureValidationResult,
} from "./compile.js";
import type {
  ResolvedDecision,
  RelevantTable,
  BuildResult,
  DesignProvenance,
  ClarifyAnswer,
  ClarifyQuestion,
} from "./types.js";
import { triageBuildFailures, buildCorrectiveGuidance } from "./clarify.js";
import { probeMeasures, emptyProbes, conflictProbes, type MeasureProbe } from "./probe.js";
import type { DataWarning } from "./types.js";

// ── LLM prompt for model generation ──────────────────────────────

const BUILD_SYSTEM_PROMPT = `You are a senior analytics engineer who writes Malloy models. Given a PURPOSE, a TABLE CATALOG (columns, types, relationships), and RESOLVED MODELING DECISIONS, generate a single self-contained model.malloy file.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

MODEL GENERATION RULES:

SELF-CONTAINED MODEL — NO IMPORTS:
- Do NOT use import statements. The model must be entirely self-contained.
- Declare each table source directly using the connector table expression provided in the catalog (e.g. postgres.table('public.users_data') or bigquery.table('project.dataset.table')).
- Only define sources that you actually join or extend. Do not declare sources you don't use.

SINGLE SOURCE, MINIMAL JOINS:
- Define exactly ONE primary source using \`extend\`. This is the model's entry point.
- The source name should be the model name (concise, descriptive).
- HARD LIMIT: maximum 3 joins total. If the chosen measures need more tables, pick the 3 most important joins and add a comment noting what was omitted ("// Omitted: X join — add via correction if needed").
- HARD LIMIT: maximum 6 measures.
- Prefer join_one over join_many. A join_many to a fact table on a non-unique key multiplies rows and can cause stack overflow during compilation. Only use join_many when the grain genuinely requires it AND the join key is selective.
- Each joined table must be declared as its own source BEFORE the primary source, using the connector table expression directly.

MEASURES AND DIMENSIONS:
- Add 3-6 measures that directly serve the stated purpose and resolved decisions. Use real column names from the catalog.
- Add 2-4 dimensions that are derived or computed (e.g. date truncations, case expressions, bucketed ranges). Do NOT redeclare pass-through columns — they are already available from the source table.
- Add 1-2 starter views.

DECISION CONTRACT — the model MUST materialize every resolved decision (these are not optional; the build verifies them after compile):
- TIME ANCHOR: if a decision names a time/date/creation column or a time grain, you MUST add a time dimension exposing it so time-series group_by works — e.g. \`dimension: created_month is created_at.month\` (also add _day/_year if useful). Do not rely on the raw column alone.
- CONVERSION / RATE / RATIO metrics: if a decision calls for conversion rates, ratios, or per-X metrics, you MUST define them as MEASURES using the ratio pattern with a zero-guard: \`measure: x_rate is numerator_measure / nullif(denominator_measure, 0)\`. Define the numerator and denominator measures too. Do not leave ratios for the query layer to improvise.
- FUNNEL STAGES: if a decision defines funnel stages, add one count measure per stage (rows reaching that stage), so stage-to-stage conversion can be computed.
- GRAIN: if a decision sets the grain (e.g. per account, per user per day), the primary source must be at that grain.

EXPRESSION RULES:
- Null checks: use \`x is not null\` / \`x is null\`. NEVER use \`x != null\` or \`x == null\` — these are not valid Malloy.
- Avoid \`now\` for time comparisons. Use literal dates (@YYYY-MM-DD) or omit the time filter. Note time-based measures as caveats in comments.
- Boolean dimensions from comparisons are fine: \`dimension: is_paid is plan != 'free'\`. But null checks MUST use \`is not null\` / \`is null\`.
- Division measures must guard against zero denominators. Note the caveat in a comment.
- To filter by email domain, use a LIKE pattern: \`email ~ '%@domain.com'\`.
- Join syntax: always use an explicit ON clause. NEVER use "with primary_key" — it is not valid Malloy syntax.
- UUID columns: cast to ::string in aggregates (e.g. count(user_id::string)). Raw UUID in count() causes type errors.
- Name collisions: dimension and measure names must NOT match any source column name. Use suffixes (_label, _total, _derived, etc.) for derived fields.
- Measures must aggregate: everything under \`measure:\` must use an aggregate function (count, sum, avg, min, max). Scalar expressions go under \`dimension:\`.
- Row counting: count() is the row count (SQL: COUNT(*)). count(column) is the distinct count (SQL: COUNT(DISTINCT column)). Do NOT use count(distinct column) — it errors.
- String concatenation: NEVER use ||. Use concat(a, b, c). Example: \`dimension: full_name is concat(first_name, ' ', last_name)\`.
- Conditional: prefer pick/when/else (both pick/when and CASE/WHEN/END compile, but pick/when is idiomatic Malloy). Example: \`dimension: tier is pick 'high' when amount > 1000 else 'low'\`.
- Coalesce: use coalesce(x, default), NOT x ?? default.
- Null checks (repeat): \`is null\` / \`is not null\`. NEVER \`= null\` / \`!= null\` / \`<> null\`.

EXAMPLE STRUCTURE (Postgres):
\`\`\`malloy
source: orders_dim is postgres.table('public.orders') extend {
  primary_key: id
}

source: analytics is postgres.table('public.events') extend {
  join_one: order_info is orders_dim on order_id = order_info.id

  dimension: event_date is created_at::date
  measure: event_count is count()
  measure: unique_orders is count(order_id)

  view: daily_summary is {
    group_by: event_date
    aggregate: event_count, unique_orders
    order_by: event_date desc
    limit: 30
  }
}
\`\`\`

OUTPUT FORMAT:
Return a JSON object (no markdown fences, no commentary outside JSON):
{
  "model_malloy": "the complete model.malloy file content as a string",
  "summary": {
    "primary_table": "table_name",
    "measures_count": <number>,
    "dimensions_count": <number>,
    "named_filters_count": <number>,
    "views_count": <number>,
    "base_tables": ["table1", "table2"]
  }
}`;

const RETRY_SYSTEM_PROMPT = `You are a senior analytics engineer fixing a Malloy model that failed to compile. Fix the syntax/reference errors while SIMPLIFYING the model.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

CRITICAL RULES:
- The model must be SELF-CONTAINED. No import statements. Declare each table source directly using the connector table expression (e.g. postgres.table('public.table_name')).
- Keep exactly ONE primary source.
- Maximum 2 joins (keep only the ones the top measures need). Remove the rest.
- Maximum 4 measures. Keep the most important ones.
- Remove join_many fan-outs — replace with simple aggregates on the primary table if possible.
- Null checks: use \`x is not null\` / \`x is null\`, NEVER \`x != null\`.
- Avoid \`now\` for time comparisons — use literal dates or omit.

Common fixes:
- Remove \`dimension: X is X\` redeclarations (columns from the source are already available)
- Fix undefined field references — check the catalog for actual column names
- Fix aggregation syntax: both sum(col) and col.sum() are valid; count(col) is distinct count
- Fix join references: joined fields use dot notation \`alias.field\`
- Remove \`extend\` blocks inside run: statements unless truly needed
- Remove any import statements — the model must be self-contained
- Remove "with primary_key" from joins — use explicit ON clauses with column references
- Cast UUID columns to ::string in aggregates: count(uuid_col::string)
- Rename dimensions/measures that collide with source column names (use _derived, _total suffixes)
- Ensure measures use aggregate functions (count, sum, avg, min, max) — scalar expressions go under dimension:
- count() is row count; count(column) is distinct count (SQL: COUNT(DISTINCT)). Never use count(distinct column) — it errors
- Replace || concatenation with concat(a, b, c) — Malloy does not support ||
- Prefer pick/when/else over CASE/WHEN/END (both compile, pick/when is idiomatic Malloy)
- Replace ?? with coalesce()
- Replace = null / != null with is null / is not null

Return JSON (no markdown fences):
{
  "model_malloy": "the fixed model.malloy content",
  "summary": {
    "primary_table": "table_name",
    "measures_count": <number>,
    "dimensions_count": <number>,
    "named_filters_count": <number>,
    "views_count": <number>,
    "base_tables": ["table1", "table2"]
  }
}`;

const SIMPLIFY_SYSTEM_PROMPT = `You are a senior analytics engineer SIMPLIFYING a Malloy model that failed during compilation (timeout or stack overflow). The model is too complex — aggressively reduce it.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

SIMPLIFICATION RULES:
- The model must be SELF-CONTAINED. No import statements. Declare each table source directly.
- Keep exactly ONE primary source definition.
- Maximum 2 joins total. Remove ALL join_many — replace with simple aggregates if needed.
- Keep at most 4 measures — the ones most critical for the purpose.
- Keep 1-2 dimensions. Remove the rest.
- Keep 1 view at most.
- Remove any \`now\`-based expressions.
- Null checks: use \`x is not null\` / \`x is null\`, NEVER \`x != null\`.
- The result must be minimal but correct. A working simple model beats a broken complex one.

Return JSON (no markdown fences):
{
  "model_malloy": "the simplified model.malloy content",
  "summary": {
    "primary_table": "table_name",
    "measures_count": <number>,
    "dimensions_count": <number>,
    "named_filters_count": <number>,
    "views_count": <number>,
    "base_tables": ["table1", "table2"]
  }
}`;

type ParsedModelResponse = {
  model_malloy: string;
  summary: {
    primary_table: string;
    measures_count: number;
    dimensions_count: number;
    named_filters_count: number;
    views_count: number;
    base_tables: string[];
  };
};

// ── Error-to-rule mapping for retry prompts ─────────────────────

/**
 * Map a compile or structural error to the most relevant syntax rules.
 * Appended to retry prompts so the LLM sees the specific rules it violated.
 */
function getRelevantRules(error: string): string {
  const rules: string[] = [];
  const e = error.toLowerCase();

  if (e.includes("with primary_key") || e.includes("with primary key")) {
    rules.push(
      "RULE 10: Join syntax requires an explicit ON clause. " +
      "'with primary_key' is not valid Malloy. " +
      "Use: join_one: alias is source on left_key = alias.right_key",
    );
  }
  if (e.includes("uuid") || (e.includes("type") && e.includes("count"))) {
    rules.push(
      "RULE 11: UUID columns need ::string cast for aggregation. " +
      "Use count(col::string), not count(col).",
    );
  }
  if (
    e.includes("already defined") ||
    e.includes("redefine") ||
    e.includes("shadows") ||
    e.includes("collides with")
  ) {
    rules.push(
      "RULE 12: Do NOT redefine source column names. " +
      "A dimension/measure must not share a name with an existing column. " +
      "Use suffixes like _derived, _label, _total.",
    );
  }
  if (
    e.includes("not an aggregate") ||
    e.includes("scalar") ||
    e.includes("must be aggregate") ||
    e.includes("aggregate expression")
  ) {
    rules.push(
      "RULE 13: Measures must use aggregate functions (count, sum, avg, min, max). " +
      "Scalar expressions are dimensions, not measures.",
    );
  }
  if (e.includes("||") || e.includes("no viable alternative") || e.includes("concatenat")) {
    rules.push(
      "RULE 15: String concatenation uses concat(), not ||. " +
      "Use concat(a, ' ', b) instead of a || ' ' || b.",
    );
  }
  if (e.includes("= null") || e.includes("!= null") || e.includes("<> null")) {
    rules.push(
      "RULE 16: Null checks use 'is null' / 'is not null'. " +
      "Never use '= null', '!= null', or '<> null'.",
    );
  }
  if (e.includes("case") || e.includes("case when")) {
    rules.push(
      "RULE 16: Prefer pick/when/else for conditionals (CASE/WHEN/END also compiles " +
      "but pick/when is idiomatic Malloy). Example: pick 'high' when amount > 1000 else 'low'.",
    );
  }
  if (e.includes("??") || e.includes("coalesce")) {
    rules.push(
      "RULE 16: Use coalesce(x, default) function. " +
      "Malloy does not support the ?? operator.",
    );
  }
  if (e.includes("import")) {
    rules.push(
      "RULE 7: No import statements. " +
      "Declare each table source directly using the connector table expression.",
    );
  }
  if (
    e.includes("join") &&
    (e.includes("not declared") || e.includes("not a source") || e.includes("does not exist"))
  ) {
    rules.push(
      "RULE 10: Each joined table must be declared as its own source " +
      "BEFORE the primary source. Joins require explicit ON clauses.",
    );
  }

  if (rules.length === 0) return "";
  return "\n\nRELEVANT RULES:\n" + rules.join("\n");
}

// ── Per-item auto-repair (Defect 1) ─────────────────────────────

const REPAIR_ITEM_PROMPT = `You are fixing ONE Malloy definition (a single measure or dimension) that failed to compile. Return the corrected definition only, preserving its NAME and INTENT — fix syntax, field references, types, casts, or aggregation level.

${MALLOY_SYNTAX_REFERENCE}

RULES:
- Keep the same name and the same analytical intent.
- Use only real columns / joined fields from the provided table catalog.
- A measure MUST aggregate (count/sum/avg/min/max, or a ratio of aggregates). A dimension MUST be scalar.
- If the intent genuinely needs a two-level aggregation that a single measure cannot express, return your closest single-level approximation and explain in "note".

Return JSON (no markdown fences):
{ "definition": "<measure|dimension>: <name> is <expression>", "note": "<what you changed>" }`;

/**
 * Replace one measure/dimension definition (possibly multi-line) in the model
 * with a corrected single-line definition, preserving indentation.
 */
function spliceDefinition(model: string, item: MeasureValidationResult, newDefinition: string): string | null {
  const lines = model.split("\n");
  const re = new RegExp(`^(\\s*)${item.kind}:\\s+${item.name}\\s+is\\b`);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(re);
    if (!m) continue;
    const indentLen = m[1].length;
    // Consume continuation lines (deeper-indented than the definition).
    let j = i + 1;
    while (j < lines.length) {
      const ln = lines[j];
      if (ln.trim() === "") break;
      const lnIndent = ln.length - ln.trimStart().length;
      if (lnIndent <= indentLen) break;
      j++;
    }
    const replacement = m[1] + newDefinition.replace(/^\s+/, "");
    lines.splice(i, j - i, replacement);
    return lines.join("\n");
  }
  return null;
}

/**
 * Attempt to automatically repair a measure/dimension that failed to compile:
 * re-prompt the LLM with the definition, the ACTUAL compiler error, and the
 * syntax reference, then re-compile the item in the full model context.
 */
async function repairItem(opts: {
  item: MeasureValidationResult;
  modelMalloy: string;
  tableCatalog: string;
  modelDir: string;
  connectorKind: ConnectorKind | undefined;
  billingProject?: string;
}): Promise<{ ok: boolean; newModel?: string; error?: string; usage: LLMUsage }> {
  const { item, modelMalloy, tableCatalog, modelDir, connectorKind, billingProject } = opts;

  const response = await chat({
    system: REPAIR_ITEM_PROMPT,
    userParts: [
      `TABLE CATALOG:\n\n${tableCatalog}`,
      `This ${item.kind} belongs to source "${item.owner}".`,
      `FAILING DEFINITION:\n${item.fullLine}`,
      `ACTUAL COMPILER ERROR:\n${item.error ?? "(no error captured)"}`,
      `Return the corrected single definition. JSON only.`,
    ],
    maxTokens: 700,
  });

  let definition: string;
  try {
    const parsed = JSON.parse(stripCodeFences(response.text));
    definition = String(parsed.definition ?? "").trim();
  } catch {
    return { ok: false, error: "Repair response was not valid JSON.", usage: response.usage };
  }
  if (!/^(measure|dimension):\s+\w+\s+is\s+/.test(definition)) {
    return { ok: false, error: "Repair did not return a valid measure/dimension definition.", usage: response.usage };
  }

  const newModel = spliceDefinition(modelMalloy, item, definition);
  if (!newModel) {
    return { ok: false, error: "Could not splice the repaired definition into the model.", usage: response.usage };
  }

  const runBlock =
    item.kind === "measure"
      ? `run: ${item.owner} -> { aggregate: ${item.name} }`
      : `run: ${item.owner} -> { group_by: ${item.name}; aggregate: _vc is count(); limit: 1 }`;
  const compiled = await compileModel(`${newModel}\n\n${runBlock}`, modelDir, connectorKind, billingProject);

  return compiled.ok
    ? { ok: true, newModel, usage: response.usage }
    : { ok: false, error: compiled.error, usage: response.usage };
}

// ── Decision contract (Defect 5) ────────────────────────────────

interface UnmetDecision {
  decision_id: string;
  chosen: string;
  expectation: string;
}

/**
 * Verify the assembled model materializes every resolved interview decision.
 * Derives required model features from each decision's text and checks the
 * model exhibits them. Unmet expectations make the build incomplete.
 * General across datasets: keyed on decision semantics, not specific columns.
 */
function checkDecisionContract(decisions: ResolvedDecision[], modelMalloy: string): UnmetDecision[] {
  const text = modelMalloy;
  const hasTimeDimension =
    /\bdimension:\s+\w+\s+is\s+[^\n]*?(\.(year|quarter|month|week|day|hour)\b|::date\b|::timestamp\b)/i.test(text);
  const hasRatioMeasure = /\bmeasure:\s+\w+\s+is\s+[^\n]*\/[^\n]*/i.test(text);

  const unmet: UnmetDecision[] = [];
  for (const d of decisions) {
    const hay = `${d.decision_id} ${d.chosen}`.toLowerCase();
    if (
      /\b(time|date|created|timestamp|recency|cohort|trend|period|monthly|daily|weekly)\b/.test(hay) &&
      !hasTimeDimension
    ) {
      unmet.push({
        decision_id: d.decision_id,
        chosen: d.chosen,
        expectation: "expose a time dimension usable in group_by (e.g. `dimension: created_month is <time_col>.month`)",
      });
    }
    if (/\b(conversion|rate|ratio|percent|funnel|drop[- ]?off)\b/.test(hay) && !hasRatioMeasure) {
      unmet.push({
        decision_id: d.decision_id,
        chosen: d.chosen,
        expectation: "define the conversion/ratio metric AS A MEASURE (e.g. `measure: x_rate is numerator / nullif(denominator, 0)`)",
      });
    }
  }
  // De-dup by expectation (several time decisions → one entry).
  const seen = new Set<string>();
  return unmet.filter((u) => (seen.has(u.expectation) ? false : (seen.add(u.expectation), true)));
}

// ── Main: build_semantic_model ───────────────────────────────────

export interface BuildModelOptions {
  name: string;
  purpose: string;
  substrateDir: string;
  semanticModelsDir: string;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
  decisions: ResolvedDecision[];
  relevantTables: RelevantTable[];
  /** Corrective guidance appended to the generate prompt (auto-fix loop). */
  corrective?: string;
  /** Authoritative user answers to clarification questions (rebuild input). */
  clarifications?: ClarifyAnswer[];
}

// Internal context shared across generate rounds (computed once).
interface BuildContext {
  name: string;
  purpose: string;
  substrateDir: string;
  semanticModelsDir: string;
  billingProject?: string;
  decisions: ResolvedDecision[];
  relevantTables: RelevantTable[];
  inspection: InspectionResult;
  connectorKind: ConnectorKind | undefined;
  tableCatalog: string;
  decisionsText: string;
  tableNames: string[];
}

type GenResult =
  | {
      ok: true;
      modelMalloy: string;
      parsed: ParsedModelResponse;
      failed: MeasureValidationResult[];
      unmetDecisions: { decision_id: string; chosen: string; expectation: string }[];
      probes: MeasureProbe[];
      usage: LLMUsage;
      compileWarning?: string;
    }
  | { ok: false; error: string; draft_malloy?: string; usage: LLMUsage };

function toFailedItems(failed: MeasureValidationResult[]): { name: string; kind: string; error: string }[] {
  return failed.map((f) => ({
    name: f.name,
    kind: f.kind as string,
    error: (f.error ?? "").split("\n").slice(0, 3).join(" ").slice(0, 300),
  }));
}

/** Convert empty-measure probes into reportable data warnings with likely cause. */
function toDataWarnings(probes: MeasureProbe[]): DataWarning[] {
  return emptyProbes(probes).map((p) => {
    let detail: string;
    if (p.joinConflict) {
      const jc = p.joinConflict;
      const missing = Math.max(0, jc.joinedTotal - jc.joinedWithKey);
      detail =
        `returns ${p.status} for every row — likely the "${jc.alias}" join: ` +
        `${missing}/${jc.joinedTotal} ${jc.table} rows lack ${jc.rightKey} ` +
        `(joined via \`${jc.leftKey} = ${jc.alias}.${jc.rightKey}\`), so they never attach.`;
    } else if (p.status === "error") {
      detail = `probe failed: ${p.detail ?? "unknown error"}`;
    } else {
      detail = `returns ${p.status} on an unfiltered probe — verify the measure has matching data.`;
    }
    return { measure: p.name, status: p.status as DataWarning["status"], detail };
  });
}

/** Load substrate + build the catalog/decisions context once. */
async function buildContext(options: BuildModelOptions): Promise<BuildContext> {
  const { name, purpose, substrateDir, semanticModelsDir, billingProject, decisions, relevantTables } = options;

  let inspection: InspectionResult;
  try {
    inspection = JSON.parse(await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8"));
  } catch {
    throw new Error(`Cannot read inspection.json from ${substrateDir}`);
  }

  const connectorKind = inspection.connector_kind as ConnectorKind | undefined;
  if (connectorKind !== "postgres" && !billingProject && !process.env.BQ_PROJECT_ID) {
    throw new Error(
      "billing_project is required for BigQuery models. Set via parameter or BQ_PROJECT_ID env var.",
    );
  }

  const tableNames = relevantTables.map((t) => t.name);
  const tableCatalog = buildTableCatalog(inspection, tableNames);
  const decisionsText = decisions.map((d) => `- ${d.decision_id}: ${d.chosen}`).join("\n");

  return {
    name, purpose, substrateDir, semanticModelsDir, billingProject,
    decisions, relevantTables, inspection, connectorKind, tableCatalog, decisionsText, tableNames,
  };
}

/**
 * Generate, compile-fix, per-item-validate+repair, and contract-check a model —
 * WITHOUT writing it to disk. Returns the validated model plus the residual
 * failures and unmet decisions. The clarification loop calls this repeatedly
 * with corrective guidance; assembly happens once, by the caller.
 */
async function generateValidatedModel(
  ctx: BuildContext,
  corrective?: string,
  clarifications?: ClarifyAnswer[],
): Promise<GenResult> {
  const { connectorKind, billingProject, tableCatalog, semanticModelsDir, name } = ctx;
  let totalUsage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  // ── Step A+B: Generate model.malloy via LLM (with optional corrective guidance) ──
  const genParts: string[] = [`TABLE CATALOG:\n\n${tableCatalog}`];
  if (corrective) genParts.push(corrective);
  if (clarifications && clarifications.length > 0) {
    genParts.push(
      "USER CLARIFICATIONS (authoritative — implement exactly):\n" +
        clarifications.map((c) => `Q: ${c.question}\nA: ${c.answer}`).join("\n\n"),
    );
  }
  genParts.push(
    `PURPOSE: ${ctx.purpose}\n\nRESOLVED DECISIONS:\n${ctx.decisionsText}\n\nGenerate a self-contained model.malloy with NO import statements. Return JSON only.`,
  );

  const response = await chat({ system: BUILD_SYSTEM_PROMPT, userParts: genParts, maxTokens: 4096 });
  totalUsage = response.usage;

  const raw = stripCodeFences(response.text);
  let parsed: ParsedModelResponse;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: `Failed to parse model generation response:\n${raw.slice(0, 500)}`, draft_malloy: raw, usage: totalUsage };
  }
  if (!parsed.model_malloy) {
    return { ok: false, error: "Model generation response missing model_malloy field.", usage: totalUsage };
  }

  // ── Step C: Validate ──
  let modelMalloy = parsed.model_malloy;

  // C.1: Structural pre-check (fast, no network)
  const structural = validateStructurally(modelMalloy, ctx.inspection);
  if (structural.fixedMalloy) {
    modelMalloy = structural.fixedMalloy;
    for (const fix of structural.autoFixes ?? []) console.log(`  ✓ Auto-fixed: ${fix}`);
  }
  if (structural.errors.length > 0) {
    console.log("  ⚠ Structural validation failed. Retrying with error feedback...");
    const structuralErrorText = structural.errors.join("\n");
    const relevantRules = getRelevantRules(structuralErrorText);
    const retryResponse = await chat({
      system: RETRY_SYSTEM_PROMPT,
      userParts: [
        `TABLE CATALOG:\n\n${tableCatalog}`,
        `PURPOSE: ${ctx.purpose}`,
        `FAILED model.malloy:\n\`\`\`malloy\n${modelMalloy}\n\`\`\`\n\nSTRUCTURAL ERRORS:\n${structuralErrorText}${relevantRules}`,
        `Fix the model. It must be self-contained (no imports). Use the table refs from the catalog. Return JSON only.`,
      ],
      maxTokens: 4096,
    });
    totalUsage = addUsage(totalUsage, retryResponse.usage);
    try {
      const retryParsed = JSON.parse(stripCodeFences(retryResponse.text));
      if (retryParsed.model_malloy) {
        modelMalloy = retryParsed.model_malloy;
        parsed = retryParsed;
      }
    } catch {
      // Retry parse failed — full compile will catch it.
    }
  }

  // C.2: Full compile (network — uses the 60s timeout)
  const tempModelDir = path.join(semanticModelsDir, `_temp_${name}_${Date.now()}`);
  await fs.mkdir(tempModelDir, { recursive: true });

  let compileResult = await compileModel(modelMalloy, tempModelDir, connectorKind, billingProject);

  if (!compileResult.ok) {
    if (isFatalCompileError(compileResult)) {
      const errorType = compileResult.error.includes("call stack")
        ? "stack overflow (circular joins or too many join fan-outs)"
        : "timeout (too many tables to resolve)";
      console.log(`  ⚠ Compile failed: ${errorType}. Simplifying model and retrying...`);
      const simplifyResponse = await chat({
        system: SIMPLIFY_SYSTEM_PROMPT,
        userParts: [
          `TABLE CATALOG:\n\n${tableCatalog}`,
          `PURPOSE: ${ctx.purpose}`,
          `FAILED model.malloy:\n\`\`\`malloy\n${modelMalloy}\n\`\`\``,
          `This model caused ${errorType} during compilation. Aggressively simplify: 1 source, max 2 joins (NO join_many), max 4 measures. No import statements — use table refs from the catalog. Return JSON only.`,
        ],
        maxTokens: 4096,
      });
      totalUsage = addUsage(totalUsage, simplifyResponse.usage);
      try {
        const simplifyParsed = JSON.parse(stripCodeFences(simplifyResponse.text));
        if (simplifyParsed.model_malloy) {
          modelMalloy = simplifyParsed.model_malloy;
          parsed = simplifyParsed;
          compileResult = await compileModel(modelMalloy, tempModelDir, connectorKind, billingProject);
        }
      } catch {
        // Simplify parse failed — keep original error.
      }
    } else {
      console.log("  ⚠ First compile failed. Retrying with error feedback...");
      const compileRelevantRules = getRelevantRules(compileResult.error);
      const retryResponse = await chat({
        system: RETRY_SYSTEM_PROMPT,
        userParts: [
          `TABLE CATALOG:\n\n${tableCatalog}`,
          `PURPOSE: ${ctx.purpose}`,
          `FAILED model.malloy:\n\`\`\`malloy\n${modelMalloy}\n\`\`\`\n\nCOMPILE ERROR:\n${compileResult.error}${compileRelevantRules}`,
          `Fix the model. It must be self-contained (no imports). Return JSON only.`,
        ],
        maxTokens: 4096,
      });
      totalUsage = addUsage(totalUsage, retryResponse.usage);
      try {
        const retryParsed = JSON.parse(stripCodeFences(retryResponse.text));
        if (retryParsed.model_malloy) {
          modelMalloy = retryParsed.model_malloy;
          parsed = retryParsed;
          compileResult = await compileModel(modelMalloy, tempModelDir, connectorKind, billingProject);
        }
      } catch {
        // Retry parse failed — keep original error.
      }
    }
  }

  // ── Handle final compile result ──
  if (!compileResult.ok) {
    if (isFatalCompileError(compileResult)) {
      // Still failing after simplification — return as a draft with a warning.
      await fs.rm(tempModelDir, { recursive: true, force: true }).catch(() => {});
      const unmetDecisions = checkDecisionContract(ctx.decisions, modelMalloy);
      return {
        ok: true,
        modelMalloy,
        parsed,
        failed: [],
        unmetDecisions,
        probes: [],
        usage: totalUsage,
        compileWarning:
          "Model generated but compile verification failed " +
          `(${compileResult.error.includes("call stack") ? "stack overflow" : "timeout"}). ` +
          "Run 'pnpm cli verify' manually to check for errors.",
      };
    }
    await fs.rm(tempModelDir, { recursive: true, force: true }).catch(() => {});
    return { ok: false, error: `Model failed to compile after retry:\n${compileResult.error}`, draft_malloy: modelMalloy, usage: totalUsage };
  }

  // ── Step C.3: Per-item validation + auto-repair (build contract) ──
  let measureResults: MeasureValidationResult[] = [];
  try {
    measureResults = await validateMeasuresIndividually(modelMalloy, tempModelDir, connectorKind, billingProject);
  } catch {
    measureResults = [];
  }

  let failed = measureResults.filter((r) => !r.ok);
  if (failed.length > 0) {
    console.log(`  ⚠ ${failed.length} item(s) failed individual validation. Attempting repair...`);
    for (const item of failed) {
      try {
        const repaired = await repairItem({ item, modelMalloy, tableCatalog, modelDir: tempModelDir, connectorKind, billingProject });
        totalUsage = addUsage(totalUsage, repaired.usage);
        if (repaired.ok && repaired.newModel) {
          modelMalloy = repaired.newModel;
          console.log(`    ✓ Repaired ${item.kind} "${item.name}"`);
        } else {
          console.log(`    ✗ Could not repair ${item.kind} "${item.name}": ${(repaired.error ?? item.error ?? "").split("\n")[0]}`);
        }
      } catch {
        // Repair is best-effort; the re-validation below records the true state.
      }
    }
    try {
      measureResults = await validateMeasuresIndividually(modelMalloy, tempModelDir, connectorKind, billingProject);
      failed = measureResults.filter((r) => !r.ok);
    } catch {
      // Keep the prior `failed` set.
    }
  }

  // ── Step C.4: Decision contract (Defect 5) ──
  const unmetDecisions = checkDecisionContract(ctx.decisions, modelMalloy);

  await fs.rm(tempModelDir, { recursive: true, force: true }).catch(() => {});

  // ── Step C.5: Post-build DATA probe ──
  // The compile contract is met; now verify measures PRODUCE DATA, not just
  // compile. Only probe a clean candidate (no per-item failures). Best-effort.
  let probes: MeasureProbe[] = [];
  if (failed.length === 0) {
    probes = await probeMeasures({
      modelMalloy,
      modelsDir: path.join(semanticModelsDir, `_probe_${name}_${Date.now()}`),
      connectorKind,
      billingProject,
    });
    const empties = emptyProbes(probes);
    if (empties.length > 0) {
      console.log(`  ⚠ ${empties.length} measure(s) returned NO DATA on an unfiltered probe:`);
      for (const e of empties) {
        const cause = e.joinConflict
          ? ` (join "${e.joinConflict.alias}": ${e.joinConflict.joinedWithKey}/${e.joinConflict.joinedTotal} ${e.joinConflict.table} rows carry ${e.joinConflict.rightKey})`
          : "";
        console.log(`    - ${e.name}: ${e.status}${cause}`);
      }
    }
  }

  return { ok: true, modelMalloy, parsed, failed, unmetDecisions, probes, usage: totalUsage };
}

/**
 * Single-shot build: generate + validate + assemble once. Preserved for callers
 * that don't want the clarification loop. Reports incompleteness honestly.
 */
export async function buildSemanticModel(options: BuildModelOptions): Promise<BuildResult> {
  const ctx = await buildContext(options);
  const gen = await generateValidatedModel(ctx, options.corrective, options.clarifications);
  if (!gen.ok) {
    return { success: false, error: gen.error, draft_malloy: gen.draft_malloy, usage: gen.usage };
  }
  return assembleModel({
    name: ctx.name,
    purpose: ctx.purpose,
    substrateDir: ctx.substrateDir,
    semanticModelsDir: ctx.semanticModelsDir,
    modelMalloy: gen.modelMalloy,
    parsed: gen.parsed,
    tableNames: ctx.tableNames,
    decisions: ctx.decisions,
    relevantTables: ctx.relevantTables,
    totalUsage: gen.usage,
    failedItems: toFailedItems(gen.failed),
    unmetDecisions: gen.unmetDecisions,
    dataWarnings: toDataWarnings(gen.probes),
    compileWarning: gen.compileWarning,
  });
}

// ── Clarification loop (triage → auto-fix type A, ask type B) ────

export interface BuildWithClarificationOptions extends BuildModelOptions {
  /** Authoritative answers already collected (e.g. an MCP re-invocation). */
  clarifications?: ClarifyAnswer[];
  /** Interactive resolver for genuine ambiguities (CLI). If absent, see surfaceQuestions. */
  askUser?: (questions: ClarifyQuestion[]) => Promise<ClarifyAnswer[]>;
  /** When true and no askUser (MCP first call): surface questions instead of finalizing. */
  surfaceQuestions?: boolean;
  maxAutoFixRounds?: number;
  maxClarifyRounds?: number;
}

/**
 * Build a model with a triage-driven clarification loop:
 *  - BUILD-INTERNAL failures (undefined refs, syntax, unreflected decisions) are
 *    fixed by the build itself via corrective regeneration — the user is NOT asked.
 *  - GENUINE AMBIGUITIES are asked of the user in ONE batch (CLI: askUser;
 *    MCP: surfaced via clarifications_needed for re-invocation).
 * Caps auto-fix and clarification rounds; assembles exactly once at a terminal
 * state (complete OR graceful-incomplete). Never writes mid-loop.
 */
export async function buildModelWithClarification(options: BuildWithClarificationOptions): Promise<BuildResult> {
  const ctx = await buildContext(options);
  const maxAutoFix = options.maxAutoFixRounds ?? 2;
  const maxClarify = options.maxClarifyRounds ?? 2;

  let clarifications: ClarifyAnswer[] = [...(options.clarifications ?? [])];
  let corrective: string | undefined =
    clarifications.length > 0 ? buildCorrectiveGuidance([], clarifications) : options.corrective;
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };
  let autoFixRounds = 0;
  let clarifyRounds = 0;
  let compileFailRetries = 0;
  let last: Extract<GenResult, { ok: true }> | null = null;
  // Conflicts already put to the user — don't re-ask (e.g. the user chose "accept").
  const answeredConflicts = new Set<string>();

  for (let iter = 0; iter < 8; iter++) {
    const gen = await generateValidatedModel(ctx, corrective, clarifications);
    usage = addUsage(usage, gen.usage);

    if (!gen.ok) {
      // A whole-model compile failure is the build's own bug → corrective-retry.
      if (compileFailRetries < maxAutoFix) {
        compileFailRetries++;
        corrective = buildCorrectiveGuidance(
          [{ target: "model", instruction: `The model failed to compile. Fix it. Compiler error: ${gen.error.split("\n").slice(0, 4).join(" ")}` }],
          clarifications,
        );
        continue;
      }
      return { success: false, error: gen.error, draft_malloy: gen.draft_malloy, usage };
    }

    last = gen;
    // Data conflicts (empty measure ← broken join) not yet put to the user.
    const conflicts = conflictProbes(gen.probes).filter((p) => !answeredConflicts.has(p.name));
    const incomplete = gen.failed.length > 0 || gen.unmetDecisions.length > 0 || conflicts.length > 0;
    if (!incomplete) break; // complete → assemble below

    const triage = await triageBuildFailures({
      modelMalloy: gen.modelMalloy,
      failed: gen.failed,
      unmetDecisions: gen.unmetDecisions,
      decisions: ctx.decisions,
      tableCatalog: ctx.tableCatalog,
      dataConflicts: conflicts,
    });
    usage = addUsage(usage, triage.usage);

    // Type A: auto-fix without asking the user (compile/structure/decision bugs).
    if (triage.autoFixes.length > 0 && autoFixRounds < maxAutoFix) {
      autoFixRounds++;
      corrective = buildCorrectiveGuidance(triage.autoFixes, clarifications);
      continue;
    }

    // Type B: genuine ambiguities remain (incl. data-coherence conflicts).
    if (triage.questions.length > 0) {
      if (options.askUser && clarifyRounds < maxClarify) {
        const answers = await options.askUser(triage.questions);
        clarifications = [...clarifications, ...answers];
        conflicts.forEach((c) => answeredConflicts.add(c.name)); // don't re-ask
        corrective = buildCorrectiveGuidance(triage.autoFixes, clarifications);
        clarifyRounds++;
        continue;
      }
      if (options.surfaceQuestions && !options.askUser) {
        // MCP first call: surface the batch WITHOUT writing to disk.
        return {
          success: false,
          model_malloy: gen.modelMalloy,
          draft_malloy: gen.modelMalloy,
          measures_count: gen.parsed.summary.measures_count ?? 0,
          dimensions_count: gen.parsed.summary.dimensions_count ?? 0,
          named_filters_count: gen.parsed.summary.named_filters_count ?? 0,
          views_count: gen.parsed.summary.views_count ?? 0,
          incomplete: true,
          failed_items: toFailedItems(gen.failed),
          unmet_decisions: gen.unmetDecisions,
          data_warnings: toDataWarnings(gen.probes),
          clarifications_needed: triage.questions,
          usage,
        };
      }
    }
    // Capped, or nothing left we can fix/ask → finalize incomplete (graceful exit).
    break;
  }

  if (!last) {
    return { success: false, error: "Build produced no model.", usage };
  }

  // Terminal: assemble exactly once (complete OR graceful-incomplete).
  return assembleModel({
    name: ctx.name,
    purpose: ctx.purpose,
    substrateDir: ctx.substrateDir,
    semanticModelsDir: ctx.semanticModelsDir,
    modelMalloy: last.modelMalloy,
    parsed: last.parsed,
    tableNames: ctx.tableNames,
    decisions: ctx.decisions,
    relevantTables: ctx.relevantTables,
    dataWarnings: toDataWarnings(last.probes),
    totalUsage: usage,
    failedItems: toFailedItems(last.failed),
    unmetDecisions: last.unmetDecisions,
    compileWarning: last.compileWarning,
  });
}

// ── Model assembly helpers ──────────────────────────────────────

interface AssembleOptions {
  name: string;
  purpose: string;
  substrateDir: string;
  semanticModelsDir: string;
  modelMalloy: string;
  parsed: ParsedModelResponse;
  tableNames: string[];
  decisions: ResolvedDecision[];
  relevantTables: RelevantTable[];
  totalUsage: LLMUsage;
  /** Measures/dimensions still failing after repair (build contract). */
  failedItems?: { name: string; kind: string; error: string }[];
  /** Interview decisions not reflected in the model (build contract). */
  unmetDecisions?: { decision_id: string; chosen: string; expectation: string }[];
  /** Measures that compiled but returned no data on probe (data contract). */
  dataWarnings?: DataWarning[];
  /** Draft/compile warning (e.g. saved despite a compile timeout). */
  compileWarning?: string;
}

async function assembleModel(opts: AssembleOptions): Promise<BuildResult> {
  const allBaseTables = opts.parsed.summary.base_tables ?? opts.tableNames;
  const modelDir = await createModel({
    name: opts.name,
    purpose: opts.purpose,
    substrateDir: opts.substrateDir,
    semanticModelsDir: opts.semanticModelsDir,
    tables: allBaseTables,
  });

  await fs.writeFile(path.join(modelDir, "model.malloy"), opts.modelMalloy + "\n", "utf-8");

  const manifest = await loadManifest(modelDir);
  const updatedManifest: ModelManifest = {
    ...manifest,
    design: {
      planned_at: new Date().toISOString(),
      decisions: opts.decisions,
      relevant_tables: opts.relevantTables,
    },
  };
  await saveManifest(modelDir, updatedManifest);

  const failedItems = opts.failedItems ?? [];
  const unmetDecisions = opts.unmetDecisions ?? [];
  const dataWarnings = opts.dataWarnings ?? [];
  const incomplete = failedItems.length > 0 || unmetDecisions.length > 0;
  const warningParts: string[] = [];
  if (incomplete) warningParts.push(`${failedItems.length} item(s) failed compile, ${unmetDecisions.length} decision(s) unmet`);
  if (dataWarnings.length > 0) warningParts.push(`${dataWarnings.length} measure(s) returned no data`);
  const warning = opts.compileWarning ?? (warningParts.length > 0 ? `Incomplete: ${warningParts.join("; ")}` : undefined);

  // Capture a model_design trace (never throws). Reflect incompleteness.
  await captureModelDesignTrace({
    modelDir,
    name: opts.name,
    purpose: opts.purpose,
    decisions: opts.decisions,
    relevantTables: opts.relevantTables,
    modelMalloy: opts.modelMalloy,
    counts: {
      measures: opts.parsed.summary.measures_count ?? 0,
      dimensions: opts.parsed.summary.dimensions_count ?? 0,
      named_filters: opts.parsed.summary.named_filters_count ?? 0,
      views: opts.parsed.summary.views_count ?? 0,
    },
    compileWarning: warning,
  });

  return {
    success: true,
    model_dir: modelDir,
    model_malloy: opts.modelMalloy,
    measures_count: opts.parsed.summary.measures_count ?? 0,
    dimensions_count: opts.parsed.summary.dimensions_count ?? 0,
    named_filters_count: opts.parsed.summary.named_filters_count ?? 0,
    views_count: opts.parsed.summary.views_count ?? 0,
    incomplete: incomplete || undefined,
    failed_items: failedItems.length ? failedItems : undefined,
    unmet_decisions: unmetDecisions.length ? unmetDecisions : undefined,
    data_warnings: dataWarnings.length ? dataWarnings : undefined,
    compile_warning: warning,
    usage: opts.totalUsage,
  };
}
