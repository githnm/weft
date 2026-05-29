/**
 * Refine an existing semantic model by applying a natural-language
 * change to its model.malloy. Validates the change compiles before
 * saving, shows a diff, and records provenance.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { chat, stripCodeFences, type LLMUsage } from "../llm/anthropic.js";
import { MALLOY_SYNTAX_RULES, MALLOY_SYNTAX_REFERENCE } from "../llm/malloy-syntax-ref.js";
import type { ConnectorKind } from "../connectors/types.js";
import type { InspectionResult } from "../introspect/types.js";
import type { DatasetMetadata } from "../introspect/metadata.js";
import { loadManifest, saveManifest, resolveModelDir } from "../models/manifest.js";
import type { ModelManifest } from "../models/manifest.js";
import {
  buildTableCatalog,
  validateStructurally,
  compileModel,
  isFatalCompileError,
  addUsage,
} from "./compile.js";
import { computeModelDiff, formatDiffMarkdown } from "./diff.js";
import { captureModelRefineTrace } from "../context/instrument.js";
import {
  isIdentical,
  verifyModelEdit,
  extractMeasureSQL,
  checkAlreadySatisfied,
  extractMeasures,
} from "./verify-llm-output.js";
import type {
  RefinementClassification,
  RefinementResult,
  RefinementRecord,
} from "./types.js";

// ── LLM prompts ─────────────────────────────────────────────────

const CLASSIFY_SYSTEM_PROMPT = `You are a senior analytics engineer. Given a Malloy model and a user's refinement request, classify the change and determine if it's feasible with the available schema.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

CRITICAL AGGREGATE RULES (applies to classification):
- count(col) compiles to COUNT(DISTINCT col) — it is ALREADY a distinct count. NEVER propose count(distinct col); it is deprecated and errors.
- count() is the row count (SQL: COUNT(*)).
- If a user asks for "unique" or "distinct" counts and the measure already uses count(col), the model ALREADY satisfies the request. Classify accordingly: note that the measure is already a distinct count.

Return JSON only (no markdown fences, no commentary):
{
  "change_type": "add_measure" | "add_dimension" | "add_view" | "modify_measure" | "modify_filter" | "add_join" | "remove_join" | "change_grain" | "other",
  "target": "short description of what's being changed",
  "feasible": true/false,
  "reasoning": "2-3 sentences explaining the classification and feasibility",
  "missing": ["list of missing columns/tables if not feasible"]
}

RULES:
- A refinement is feasible ONLY if the columns/tables it references exist in the model's current scope (its base tables and their columns).
- If the user asks for a column that doesn't exist in any base table, mark NOT feasible and list what's missing.
- change_grain is ALWAYS not feasible — it requires rebuilding the model. Return: "Changing grain requires rebuilding the model. Use the design flow to create a new model with the desired grain."
- For add_join: the target table must exist in the substrate. If it does, it's feasible. Note the 3-join cap.
- Be precise about what column/table names are needed.`;

const REFINE_SYSTEM_PROMPT = `You are a senior analytics engineer editing an existing Malloy model. Given the CURRENT model.malloy, a TABLE CATALOG, and a REFINEMENT REQUEST, produce the FULL updated model.malloy.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

EDITING RULES:
- Return the COMPLETE updated model.malloy — not a diff, the full file.
- Preserve ALL existing definitions unless the refinement specifically asks to change or remove them.
- The model must remain SELF-CONTAINED. No import statements. Keep existing connector table expressions.
- HARD LIMIT: maximum 3 joins total. If adding a join would exceed 3, warn in a comment but do not add it.
- HARD LIMIT: maximum 6 measures total. If adding a measure would exceed 6, warn in a comment but do not add it.
- Null checks: use \`x is not null\` / \`x is null\`. NEVER \`x != null\`.
- Avoid \`now\` for time comparisons. Use literal dates or note as a comment caveat.
- Do NOT redeclare pass-through columns that already exist on the source table.
- Prefer join_one over join_many. join_many on non-unique keys multiplies rows.

OUTPUT FORMAT:
Return a JSON object (no markdown fences, no commentary outside JSON):
{
  "model_malloy": "the complete updated model.malloy file content",
  "changes_summary": "1-2 sentence summary of what changed"
}`;

const RETRY_REFINE_PROMPT = `You are a senior analytics engineer fixing a Malloy model edit that failed to compile. Fix the syntax errors without changing the intent of the edit.

${MALLOY_SYNTAX_RULES}

${MALLOY_SYNTAX_REFERENCE}

RULES:
- The model must be SELF-CONTAINED. No import statements.
- Null checks: use \`x is not null\` / \`x is null\`, NEVER \`x != null\`.
- Avoid \`now\` — use literal dates or omit.
- Do not redeclare existing source columns.

Return JSON (no markdown fences):
{
  "model_malloy": "the fixed model.malloy content",
  "changes_summary": "what was fixed"
}`;

// ── Main: refineModel ───────────────────────────────────────────

export interface RefineModelOptions {
  modelName: string;
  semanticModelsDir: string;
  refinement: string;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
}

export async function refineModel(options: RefineModelOptions): Promise<RefinementResult> {
  const { modelName, semanticModelsDir, refinement, billingProject } = options;

  const modelDir = resolveModelDir(semanticModelsDir, modelName);

  // ── Step A: Load the current model ──
  let manifest: ModelManifest;
  try {
    manifest = await loadManifest(modelDir);
  } catch {
    throw new Error(`Model "${modelName}" not found in ${semanticModelsDir}.`);
  }

  let currentMalloy: string;
  const modelMalloyPath = path.join(modelDir, "model.malloy");
  try {
    currentMalloy = await fs.readFile(modelMalloyPath, "utf-8");
  } catch {
    throw new Error(`model.malloy not found for model "${modelName}".`);
  }

  // Load inspection.json from the substrate (for structural validation + catalog)
  const substrateDir = path.resolve(modelDir, manifest.substrate_dir);
  let inspection: InspectionResult;
  try {
    const raw = await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
    inspection = JSON.parse(raw);
  } catch {
    throw new Error(`Cannot read inspection.json from substrate: ${substrateDir}`);
  }

  const connectorKind = (manifest.connector_kind ?? inspection.connector_kind) as ConnectorKind | undefined;

  // BigQuery needs a billing project for schema resolution; Postgres does not.
  if (connectorKind !== "postgres" && !billingProject && !process.env.BQ_PROJECT_ID) {
    throw new Error(
      "billing_project is required for BigQuery models. " +
      "Set via parameter or BQ_PROJECT_ID env var.",
    );
  }

  const tableCatalog = buildTableCatalog(inspection, manifest.base_tables);

  let totalUsage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  // ── Step B: Classify the refinement ──
  const classifyResponse = await chat({
    system: CLASSIFY_SYSTEM_PROMPT,
    userParts: [
      `CURRENT model.malloy:\n\`\`\`malloy\n${currentMalloy}\n\`\`\``,
      `TABLE CATALOG (available columns):\n${tableCatalog}`,
      `REFINEMENT REQUEST: ${refinement}\n\nClassify this change. Return JSON only.`,
    ],
    maxTokens: 1024,
  });

  totalUsage = classifyResponse.usage;

  let classification: RefinementClassification;
  try {
    classification = JSON.parse(stripCodeFences(classifyResponse.text));
  } catch {
    return {
      success: false,
      classification: {
        change_type: "other",
        target: refinement,
        feasible: false,
        reasoning: "Failed to classify the refinement.",
      },
      error: `Failed to parse classification:\n${classifyResponse.text.slice(0, 300)}`,
      usage: totalUsage,
    };
  }

  // Not feasible — return early with explanation
  if (!classification.feasible) {
    return {
      success: false,
      classification,
      error: classification.reasoning +
        (classification.missing?.length
          ? `\nMissing: ${classification.missing.join(", ")}`
          : ""),
      usage: totalUsage,
    };
  }

  // ── Step B½: Check if the request is already satisfied ──
  // Before invoking the LLM, detect if the current model already satisfies
  // the semantic intent (e.g., count(col) IS the distinct count — no change needed).
  // This prevents the LLM from returning identical content → identity check failure.
  {
    // Try to extract the target measure name from the classification
    const targetName = extractTargetMeasureName(classification.target, currentMalloy);

    const alreadySatisfied = checkAlreadySatisfied(
      refinement,
      currentMalloy,
      targetName ?? undefined,
    );

    if (alreadySatisfied?.satisfied) {
      return {
        success: true,
        classification,
        new_malloy: currentMalloy,
        old_malloy: currentMalloy,
        diff_summary: `**Already satisfied** — ${alreadySatisfied.reason}`,
        usage: totalUsage,
      };
    }
  }

  // ── Step C: Generate the edited model.malloy ──
  const refineResponse = await chat({
    system: REFINE_SYSTEM_PROMPT,
    userParts: [
      `CURRENT model.malloy:\n\`\`\`malloy\n${currentMalloy}\n\`\`\``,
      `TABLE CATALOG:\n${tableCatalog}`,
      `REFINEMENT: ${refinement}\n\nProduce the FULL updated model.malloy. Return JSON only.`,
    ],
    maxTokens: 4096,
  });

  totalUsage = addUsage(totalUsage, refineResponse.usage);

  let newMalloy: string;
  let changesSummary: string | undefined;
  try {
    const parsed = JSON.parse(stripCodeFences(refineResponse.text));
    newMalloy = parsed.model_malloy;
    changesSummary = parsed.changes_summary;
    if (!newMalloy) throw new Error("missing model_malloy");
  } catch {
    return {
      success: false,
      classification,
      error: `Failed to parse refinement response:\n${refineResponse.text.slice(0, 300)}`,
      usage: totalUsage,
    };
  }

  // ── Step C½: Identity check — did the LLM actually change anything? ──
  if (isIdentical(newMalloy, currentMalloy)) {
    console.log("  ⚠ LLM returned identical model. Retrying with explicit instructions...");

    // Build a targeted retry prompt that quotes the exact line(s) to change
    const retryIdentityResponse = await chat({
      system: REFINE_SYSTEM_PROMPT,
      userParts: [
        `CURRENT model.malloy:\n\`\`\`malloy\n${currentMalloy}\n\`\`\``,
        `TABLE CATALOG:\n${tableCatalog}`,
        `REFINEMENT: ${refinement}`,
        `IMPORTANT: Your previous attempt returned the model UNCHANGED. The model MUST be different from the input.\n` +
        `The user is asking you to modify this model. You MUST edit it — do not return the same content.\n` +
        `If the refinement asks to change a specific measure/dimension/join, find the relevant line and rewrite it.\n` +
        `If the refinement asks to add something new, insert the new definition in the appropriate section.\n\n` +
        `Classification: ${classification.change_type} — ${classification.target}\n` +
        `Reasoning: ${classification.reasoning}\n\n` +
        `Produce the FULL updated model.malloy with the change applied. Return JSON only.`,
      ],
      maxTokens: 4096,
    });

    totalUsage = addUsage(totalUsage, retryIdentityResponse.usage);

    try {
      const retryParsed = JSON.parse(stripCodeFences(retryIdentityResponse.text));
      if (retryParsed.model_malloy) {
        newMalloy = retryParsed.model_malloy;
        changesSummary = retryParsed.changes_summary;
      }
    } catch {
      // Fall through — will be caught by the second identity check below
    }

    // Second identity check after retry
    if (isIdentical(newMalloy, currentMalloy)) {
      return {
        success: false,
        classification,
        error:
          `The model was not changed. After two attempts, the LLM returned content identical to the current model.\n\n` +
          `Refinement: "${refinement}"\n` +
          `Classification: ${classification.change_type} — ${classification.target}\n\n` +
          `This can happen when:\n` +
          `- The requested change is already present in the model\n` +
          `- The LLM doesn't understand how to apply the change\n` +
          `- The change conflicts with existing definitions\n\n` +
          `Try rephrasing the refinement with more specific instructions (e.g. "change the active_users measure from count(email) to count(email::string)").`,
        usage: totalUsage,
      };
    }
  }

  // ── Step D: Structural pre-check then compile ──
  const structural = validateStructurally(newMalloy, inspection);

  if (structural.errors.length > 0) {
    // Try to fix structural issues
    console.log("  ⚠ Structural validation failed. Retrying...");

    const retryResponse = await chat({
      system: RETRY_REFINE_PROMPT,
      userParts: [
        `TABLE CATALOG:\n${tableCatalog}`,
        `FAILED model.malloy:\n\`\`\`malloy\n${newMalloy}\n\`\`\`\n\nSTRUCTURAL ERRORS:\n${structural.errors.join("\n")}`,
        `Fix the model. Return JSON only.`,
      ],
      maxTokens: 4096,
    });

    totalUsage = addUsage(totalUsage, retryResponse.usage);

    try {
      const retryParsed = JSON.parse(stripCodeFences(retryResponse.text));
      if (retryParsed.model_malloy) {
        newMalloy = retryParsed.model_malloy;
      }
    } catch {
      // Keep the structurally invalid version; compile will catch it
    }
  }

  // Full compile
  const tempDir = path.join(semanticModelsDir, `_temp_refine_${modelName}_${Date.now()}`);
  await fs.mkdir(tempDir, { recursive: true });

  let compileResult = await compileModel(newMalloy, tempDir, connectorKind, billingProject);

  // Retry once on compile error
  if (!compileResult.ok) {
    console.log("  ⚠ Compile failed. Retrying with error feedback...");

    const retryResponse = await chat({
      system: RETRY_REFINE_PROMPT,
      userParts: [
        `TABLE CATALOG:\n${tableCatalog}`,
        `FAILED model.malloy:\n\`\`\`malloy\n${newMalloy}\n\`\`\`\n\nCOMPILE ERROR:\n${compileResult.error}`,
        `Fix the model. Return JSON only.`,
      ],
      maxTokens: 4096,
    });

    totalUsage = addUsage(totalUsage, retryResponse.usage);

    try {
      const retryParsed = JSON.parse(stripCodeFences(retryResponse.text));
      if (retryParsed.model_malloy) {
        newMalloy = retryParsed.model_malloy;
        compileResult = await compileModel(newMalloy, tempDir, connectorKind, billingProject);
      }
    } catch {
      // Keep original error
    }
  }

  await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});

  if (!compileResult.ok) {
    return {
      success: false,
      classification,
      error: `Refined model failed to compile:\n${compileResult.error}`,
      draft_malloy: newMalloy,
      usage: totalUsage,
    };
  }

  // ── Step E: Verify the change is real (identity + structural + semantic) ──

  // Try semantic verification: extract SQL for changed measures and check intents
  let sql: string | undefined;
  const diff = computeModelDiff(currentMalloy, newMalloy);
  const addedOrChangedMeasures = diff.entries.filter(
    (e) => e.type === "measure" && (e.action === "added" || e.action === "changed"),
  );

  if (addedOrChangedMeasures.length > 0) {
    // Extract source name for SQL extraction
    const sourceNameMatch = newMalloy.match(/^source:\s+(\w+)\s+is\s+/m);
    if (sourceNameMatch) {
      for (const m of addedOrChangedMeasures) {
        const measureSql = await extractMeasureSQL({
          modelMalloy: newMalloy,
          sourceName: sourceNameMatch[1],
          measureName: m.name,
          modelDir: path.join(semanticModelsDir, `_temp_verify_${modelName}_${Date.now()}`),
          connectorKind,
          billingProject,
        });
        if (measureSql) {
          sql = (sql ?? "") + measureSql + "\n";
        }
      }
    }
  }

  const verification = verifyModelEdit({
    before: currentMalloy,
    after: newMalloy,
    request: refinement,
    sql,
  });

  if (!verification.changed) {
    return {
      success: false,
      classification,
      error:
        verification.issues.join("\n") + "\n\n" +
        `Refinement: "${refinement}"\n` +
        `Try rephrasing with more specific instructions (e.g. exact line-level edits).`,
      draft_malloy: newMalloy,
      usage: totalUsage,
    };
  }

  // Report semantic mismatches as warnings, not hard failures
  const diffSummary = formatDiffMarkdown(verification.diff);
  let compileWarning: string | undefined;
  if (verification.semanticMismatches.length > 0) {
    compileWarning = "Semantic check: " +
      verification.semanticMismatches.map((m) => m.detail).join("; ");
  }

  return {
    success: true,
    classification,
    new_malloy: newMalloy,
    old_malloy: currentMalloy,
    diff_summary: diffSummary,
    compile_warning: compileWarning,
    usage: totalUsage,
  };
}

// ── Helpers ─────────────────────────────────────────────────────

/**
 * Try to extract a measure name from a classification target string
 * by matching against actual measures in the model.
 *
 * E.g., target = "active_users measure" + model has measure: active_users
 *       → returns "active_users"
 */
function extractTargetMeasureName(
  classificationTarget: string,
  malloy: string,
): string | null {
  const measures = extractMeasures(malloy);
  const targetLower = classificationTarget.toLowerCase();

  for (const name of measures.keys()) {
    if (targetLower.includes(name.toLowerCase())) {
      return name;
    }
  }

  return null;
}

// ── Save a confirmed refinement ─────────────────────────────────

export interface SaveRefinementOptions {
  modelName: string;
  semanticModelsDir: string;
  newMalloy: string;
  refinement: string;
  classification: RefinementClassification;
}

export async function saveRefinement(options: SaveRefinementOptions): Promise<void> {
  const { modelName, semanticModelsDir, newMalloy, refinement, classification } = options;
  const modelDir = resolveModelDir(semanticModelsDir, modelName);
  const modelMalloyPath = path.join(modelDir, "model.malloy");
  const backupPath = path.join(modelDir, "model.malloy.bak");

  // Capture the prior content for the refinement trace's structural diff.
  const previousMalloy = await fs.readFile(modelMalloyPath, "utf-8").catch(() => undefined);

  // Back up the current model.malloy (one-level backup)
  try {
    await fs.copyFile(modelMalloyPath, backupPath);
  } catch {
    // No existing file to back up — fine
  }

  // Write the new model.malloy
  await fs.writeFile(modelMalloyPath, newMalloy + "\n", "utf-8");

  // Append to refinement history in manifest
  const manifest = await loadManifest(modelDir);
  const record: RefinementRecord = {
    refined_at: new Date().toISOString(),
    refinement,
    change_type: classification.change_type,
    target: classification.target,
  };
  const history = manifest.refinement_history ?? [];
  history.push(record);
  const updated: ModelManifest = { ...manifest, refinement_history: history };
  await saveManifest(modelDir, updated);

  // Capture a model_refine trace (never throws).
  await captureModelRefineTrace({
    modelDir,
    modelName,
    refinement,
    reasoning: classification.reasoning,
    changeType: classification.change_type,
    target: classification.target,
    oldMalloy: previousMalloy,
    newMalloy,
  });
}

// ── Revert the last refinement ──────────────────────────────────

export interface RevertOptions {
  modelName: string;
  semanticModelsDir: string;
}

export async function revertLastRefinement(options: RevertOptions): Promise<boolean> {
  const { modelName, semanticModelsDir } = options;
  const modelDir = resolveModelDir(semanticModelsDir, modelName);
  const modelMalloyPath = path.join(modelDir, "model.malloy");
  const backupPath = path.join(modelDir, "model.malloy.bak");

  // Check backup exists
  try {
    await fs.access(backupPath);
  } catch {
    return false; // No backup to revert to
  }

  // Restore backup
  await fs.copyFile(backupPath, modelMalloyPath);
  await fs.rm(backupPath, { force: true });

  // Remove last entry from refinement history
  try {
    const manifest = await loadManifest(modelDir);
    if (manifest.refinement_history && manifest.refinement_history.length > 0) {
      manifest.refinement_history.pop();
      await saveManifest(modelDir, manifest);
    }
  } catch {
    // Manifest update failed — backup was still restored
  }

  return true;
}
