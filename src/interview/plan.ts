import fs from "node:fs/promises";
import path from "node:path";
import { chat, stripCodeFences, type LLMUsage } from "../llm/anthropic.js";
import { classifyDataset } from "../introspect/classify.js";
import type { InspectionResult } from "../introspect/types.js";
import type { DatasetMetadata } from "../introspect/metadata.js";
import type { ModelPlan, RelevantTable, Decision } from "./types.js";

// ── Schema digest ────────────────────────────────────────────────

/**
 * Build a compact schema digest from inspection data for LLM prompts.
 * Keeps total size manageable even for 60+ table schemas.
 */
function buildSchemaDigest(
  inspection: InspectionResult,
  metadata?: DatasetMetadata,
): string {
  const classification = classifyDataset(inspection);
  const lines: string[] = [];

  lines.push(`Database: ${inspection.dataset_project}.${inspection.dataset_name}`);
  if (inspection.connector_kind) {
    lines.push(`Connector: ${inspection.connector_kind}`);
  }
  lines.push(`Tables: ${classification.tables.length} inspected, ${classification.skipped_tables.length} skipped`);
  lines.push("");

  for (const table of classification.tables) {
    const rowStr = table.row_count > 1000
      ? `${(table.row_count / 1000).toFixed(0)}k`
      : String(table.row_count);
    lines.push(`TABLE: ${table.name} (${rowStr} rows)`);

    // Group columns by role for compact display
    const byRole = new Map<string, string[]>();
    for (const col of table.columns) {
      const role = col.role;
      if (!byRole.has(role)) byRole.set(role, []);

      let desc = col.name;
      // Add type hint for non-obvious types
      if (col.role === "measure" && col.default_aggregation) {
        desc += ` (${col.default_aggregation})`;
      }
      byRole.get(role)!.push(desc);
    }

    // Output by role in a compact format
    const pk = byRole.get("primary_key");
    if (pk) lines.push(`  pk: ${pk.join(", ")}`);

    const fk = byRole.get("foreign_key");
    if (fk) lines.push(`  fk: ${fk.join(", ")}`);

    const dims = byRole.get("dimension");
    if (dims) lines.push(`  dimensions: ${dims.join(", ")}`);

    const attrs = byRole.get("attribute");
    if (attrs) lines.push(`  attributes: ${attrs.join(", ")}`);

    const time = byRole.get("time_dimension");
    if (time) lines.push(`  time: ${time.join(", ")}`);

    const measures = byRole.get("measure");
    if (measures) lines.push(`  measures: ${measures.join(", ")}`);

    // Enums — just column names with value counts, not full value lists
    if (metadata?.sources[table.name]) {
      const src = metadata.sources[table.name];
      const enumCols = Object.entries(src.enums);
      if (enumCols.length > 0) {
        const enumDescs = enumCols.map(([col, info]) => {
          const vals = info.values.slice(0, 5).map((v) => `'${v}'`).join(", ");
          const suffix = info.values.length > 5 ? `, ...+${info.values.length - 5}` : "";
          return `${col}=[${vals}${suffix}]`;
        });
        lines.push(`  enums: ${enumDescs.join("; ")}`);
      }

      // Time bounds
      const timeBounds = Object.entries(src.time_bounds);
      if (timeBounds.length > 0) {
        const tbDescs = timeBounds.map(([col, tb]) =>
          `${col}: ${tb.min.split("T")[0]}..${tb.max.split("T")[0]}`
        );
        lines.push(`  time_range: ${tbDescs.join("; ")}`);
      }
    }

    lines.push("");
  }

  // FK relationships
  if (classification.inferred_joins.length > 0) {
    lines.push("FK RELATIONSHIPS:");
    for (const j of classification.inferred_joins) {
      const conf = j.confidence === "high" ? "catalog" : "inferred";
      lines.push(`  ${j.source_table}.${j.source_column} → ${j.target_table}.${j.target_column} (${conf})`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Step B: Select candidate tables ──────────────────────────────

const TABLE_SELECTION_PROMPT = `You are a data architect. Given a stated PURPOSE and a database SCHEMA, select which tables are relevant for building a focused analytical model.

Return JSON only (no markdown fences, no commentary):
{
  "relevant_tables": [
    { "name": "table_name", "reason": "one sentence why this table is needed" }
  ],
  "excluded_tables_count": <number>,
  "reasoning": "2-3 sentences explaining the selection strategy"
}

RULES:
- Select 2-8 tables. A focused model is better than a sprawling one.
- Include tables that directly serve the purpose PLUS the dimension/lookup tables they join to.
- Exclude configuration tables, system tables, audit logs, and tables unrelated to the purpose.
- Consider FK relationships: if you include an activity table, include the dimension tables it joins to (users, workspaces, etc).
- Every selected table must have a clear role: fact table, dimension table, or bridge table.`;

async function selectTables(
  purpose: string,
  schemaDigest: string,
): Promise<{ tables: RelevantTable[]; excludedCount: number; reasoning: string; usage: LLMUsage }> {
  const response = await chat({
    system: TABLE_SELECTION_PROMPT,
    userParts: [
      `SCHEMA:\n${schemaDigest}`,
      `PURPOSE: ${purpose}\n\nSelect the relevant tables. Return JSON only.`,
    ],
    maxTokens: 1024,
  });

  const raw = stripCodeFences(response.text);
  let parsed: {
    relevant_tables: RelevantTable[];
    excluded_tables_count: number;
    reasoning: string;
  };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse table selection response:\n${raw.slice(0, 500)}`);
  }

  if (!parsed.relevant_tables || !Array.isArray(parsed.relevant_tables)) {
    throw new Error("Table selection response missing relevant_tables array.");
  }

  return {
    tables: parsed.relevant_tables,
    excludedCount: parsed.excluded_tables_count ?? 0,
    reasoning: parsed.reasoning ?? "",
    usage: response.usage,
  };
}

// ── Step C: Identify decisions ───────────────────────────────────

const DECISIONS_PROMPT = `You are a senior analytics engineer designing a semantic model. Given a PURPOSE and a set of RELEVANT TABLES with their columns, types, and FK relationships, identify the key MODELING DECISIONS that must be resolved.

Return JSON only (no markdown fences, no commentary):
{
  "decisions": [
    {
      "id": "snake_case_identifier",
      "question": "Human-readable question",
      "why_it_matters": "One sentence on why this matters for the model",
      "options": [
        {
          "label": "Short label",
          "detail": "What this means, referencing REAL columns/tables",
          "malloy_hint": "How this translates to Malloy (e.g. 'join_one: user is users_data on user_id = user.id')",
          "recommended": true
        }
      ],
      "allow_custom": false
    }
  ]
}

RULES:
- Maximum 6 decisions. Rank by impact. Drop low-impact decisions.
- EVERY option must reference ACTUAL columns, tables, or enum values from the schema. No generic options. If the schema has no session table, don't offer "session duration".
- Mark exactly one option per decision as recommended, based on what the schema best supports.
- Use the FK graph and column overlap to surface real ambiguities.
- Common decision types (include ONLY those that apply to THIS schema and purpose):
  * grain: What is one row in the primary view? (e.g. per event, per user per day)
  * user_identity / entity_identity: How to identify the primary entity (especially when multiple join paths exist)
  * active_definition: What counts as "active"? (only if the purpose involves activity/engagement)
  * time_column: Which time column to use as the primary time axis (when multiple exist)
  * key_measures: Which aggregations matter most for this purpose
  * key_dimensions: Which grouping dimensions are most useful
  * primary_table: Which table anchors the model (when ambiguous)
  * json_dimensions: If a table lists "JSON keys in <col>", which of those keys to expose as dimensions (reference the ACTUAL keys and their frequencies; never offer array or unlisted keys)
- 2-4 options per decision is ideal. Never exceed 5.
- If a decision has an obvious answer for this schema, still include it but mark the obvious choice as recommended.`;

async function identifyDecisions(
  purpose: string,
  tablesDigest: string,
): Promise<{ decisions: Decision[]; usage: LLMUsage }> {
  const response = await chat({
    system: DECISIONS_PROMPT,
    userParts: [
      `RELEVANT TABLES AND SCHEMA:\n${tablesDigest}`,
      `PURPOSE: ${purpose}\n\nIdentify the modeling decisions. Return JSON only.`,
    ],
    maxTokens: 4096,
  });

  const raw = stripCodeFences(response.text);
  let parsed: { decisions: Decision[] };

  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Failed to parse decisions response:\n${raw.slice(0, 500)}`);
  }

  if (!parsed.decisions || !Array.isArray(parsed.decisions)) {
    throw new Error("Decisions response missing decisions array.");
  }

  // Enforce max 6 decisions
  const decisions = parsed.decisions.slice(0, 6);

  return { decisions, usage: response.usage };
}

// ── Build focused schema digest for selected tables ──────────────

function buildFocusedDigest(
  inspection: InspectionResult,
  metadata: DatasetMetadata | undefined,
  selectedTableNames: string[],
): string {
  const classification = classifyDataset(inspection);
  const selectedSet = new Set(selectedTableNames.map((n) => n.toLowerCase()));
  const lines: string[] = [];

  if (inspection.connector_kind) {
    lines.push(`Connector: ${inspection.connector_kind}`);
    lines.push("");
  }

  for (const table of classification.tables) {
    if (!selectedSet.has(table.name.toLowerCase())) continue;

    lines.push(`TABLE: ${table.name} (${table.row_count.toLocaleString()} rows)`);

    for (const col of table.columns) {
      let desc = `  ${col.name}: ${col.type} [${col.role}]`;
      if (col.role === "measure" && col.default_aggregation) {
        desc += ` (default: ${col.default_aggregation})`;
      }
      if (col.distinct_count > 0) {
        desc += ` (${col.distinct_count} distinct)`;
      }
      lines.push(desc);

      // JSON columns: list the proposable keys so a decision can offer them.
      if (col.json_keys && col.json_keys.length > 0) {
        const proposable = col.json_keys.filter((k) => k.kind === "scalar" && k.frequency >= 0.05);
        if (proposable.length > 0) {
          const keyList = proposable
            .slice(0, 12)
            .map((k) => `${k.path} (${k.value_type ?? "string"}, ${Math.round(k.frequency * 100)}%)`)
            .join(", ");
          lines.push(`    JSON keys in ${col.name}: ${keyList}`);
        }
        const arrays = col.json_keys.filter((k) => k.kind === "array").map((k) => k.path);
        if (arrays.length > 0) {
          lines.push(`    JSON arrays in ${col.name} (not auto-exposed): ${arrays.slice(0, 8).join(", ")}`);
        }
      }
    }

    // Enums with values
    if (metadata?.sources[table.name]) {
      const src = metadata.sources[table.name];
      for (const [col, info] of Object.entries(src.enums)) {
        const vals = info.values.map((v) => `'${v}'`).join(", ");
        lines.push(`  ${col} values: [${vals}]${info.truncated ? " (truncated)" : ""}`);
      }
      for (const [col, tb] of Object.entries(src.time_bounds)) {
        lines.push(`  ${col} range: ${tb.min} to ${tb.max}`);
      }
    }

    lines.push("");
  }

  // FK relationships between selected tables
  const relevantJoins = classification.inferred_joins.filter(
    (j) => selectedSet.has(j.source_table.toLowerCase()) && selectedSet.has(j.target_table.toLowerCase()),
  );
  if (relevantJoins.length > 0) {
    lines.push("FK RELATIONSHIPS (between selected tables):");
    for (const j of relevantJoins) {
      const conf = j.confidence === "high" ? "catalog" : "inferred";
      lines.push(`  ${j.source_table}.${j.source_column} → ${j.target_table}.${j.target_column} (${conf})`);
    }
    lines.push("");
  }

  // Also note FKs to tables outside the selection (useful context)
  const externalJoins = classification.inferred_joins.filter(
    (j) =>
      (selectedSet.has(j.source_table.toLowerCase()) && !selectedSet.has(j.target_table.toLowerCase())) ||
      (!selectedSet.has(j.source_table.toLowerCase()) && selectedSet.has(j.target_table.toLowerCase())),
  );
  if (externalJoins.length > 0) {
    lines.push("FK RELATIONSHIPS (to excluded tables):");
    for (const j of externalJoins) {
      lines.push(`  ${j.source_table}.${j.source_column} → ${j.target_table}.${j.target_column}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

// ── Main: propose_model_plan ─────────────────────────────────────

export async function proposeModelPlan(
  purpose: string,
  substrateDir: string,
): Promise<ModelPlan> {
  // Step A: Read the substrate
  const inspectionPath = path.join(substrateDir, "inspection.json");
  let inspectionRaw: string;
  try {
    inspectionRaw = await fs.readFile(inspectionPath, "utf-8");
  } catch {
    throw new Error(
      `inspection.json not found at ${inspectionPath}.\n` +
        "Run introspect first to create the substrate.",
    );
  }
  const inspection: InspectionResult = JSON.parse(inspectionRaw);

  let metadata: DatasetMetadata | undefined;
  try {
    const metaRaw = await fs.readFile(path.join(substrateDir, "metadata.json"), "utf-8");
    metadata = JSON.parse(metaRaw);
  } catch {
    // metadata is optional
  }

  const schemaDigest = buildSchemaDigest(inspection, metadata);

  // Step B: Select candidate tables
  const tableSelection = await selectTables(purpose, schemaDigest);

  let totalUsage: LLMUsage = tableSelection.usage;

  // Step C: Identify decisions
  const selectedNames = tableSelection.tables.map((t) => t.name);
  const focusedDigest = buildFocusedDigest(inspection, metadata, selectedNames);

  const decisionsResult = await identifyDecisions(purpose, focusedDigest);
  totalUsage = {
    inputTokens: totalUsage.inputTokens + decisionsResult.usage.inputTokens,
    outputTokens: totalUsage.outputTokens + decisionsResult.usage.outputTokens,
  };

  return {
    purpose,
    relevant_tables: tableSelection.tables,
    excluded_tables_count: tableSelection.excludedCount,
    table_selection_reasoning: tableSelection.reasoning,
    decisions: decisionsResult.decisions,
    substrate_dir: substrateDir,
    usage: totalUsage,
  };
}

// ── Format plan as markdown ──────────────────────────────────────

export function formatPlanMarkdown(plan: ModelPlan): string {
  const lines: string[] = [];
  lines.push("## Model Plan\n");
  lines.push(`**Purpose:** ${plan.purpose}\n`);

  lines.push("### Relevant Tables\n");
  lines.push(`${plan.table_selection_reasoning}\n`);
  for (const t of plan.relevant_tables) {
    lines.push(`- **${t.name}** — ${t.reason}`);
  }
  if (plan.excluded_tables_count > 0) {
    lines.push(`\n_${plan.excluded_tables_count} tables excluded as not relevant._`);
  }
  lines.push("");

  lines.push("### Modeling Decisions\n");
  for (let i = 0; i < plan.decisions.length; i++) {
    const d = plan.decisions[i];
    lines.push(`#### ${i + 1}. ${d.question}\n`);
    lines.push(`_${d.why_it_matters}_\n`);
    for (let j = 0; j < d.options.length; j++) {
      const o = d.options[j];
      const rec = o.recommended ? " **(recommended)**" : "";
      lines.push(`${j + 1}. **${o.label}**${rec} — ${o.detail}`);
    }
    if (d.allow_custom) {
      lines.push(`\n_Custom answer allowed._`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
