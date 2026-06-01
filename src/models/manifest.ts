import fs from "node:fs/promises";
import path from "node:path";
import type { DesignProvenance, RefinementRecord } from "../interview/types.js";

// ── Types ────────────────────────────────────────────────────────

/**
 * A business concept baked into model.malloy, with explicit aliases.
 *
 * The filter/measure lives ONCE in model.malloy as `field`; this records the
 * concept's vocabulary so the ask pipeline can apply it when a question uses
 * the canonical name OR any owner-confirmed alias. No alias is ever added
 * without explicit confirmation — a wrong alias is a silent wrong answer.
 */
export interface ConceptDefinition {
  /** Primary name, e.g. "external_users". */
  canonical_name: string;
  /** Words that also refer to this concept — explicit, owner-confirmed only. */
  aliases: string[];
  /** The baked field in model.malloy this concept resolves to. */
  field: string;
  /** "dimension" → filter `where: <field>`; "measure" → aggregate `<field>`. */
  kind: "dimension" | "measure";
  /** Human-readable expression, for provenance + the generator prompt. */
  filter?: string;
}

export interface ModelManifest {
  /** Human-readable model name (also the directory name) */
  name: string;
  /** One-line purpose / audience description */
  purpose: string;
  /** Absolute or relative path to the substrate directory */
  substrate_dir: string;
  /** Table names included in this model (must exist in substrate) */
  base_tables: string[];
  /** ISO 8601 timestamp */
  created_at: string;
  /** Connector that produced the substrate (bigquery | postgres) */
  connector_kind?: string;
  /** Design provenance from the model interview (stage 2) */
  design?: DesignProvenance;
  /** History of refinements applied to this model */
  refinement_history?: RefinementRecord[];
  /** Baked business concepts + their explicit aliases (definition provenance). */
  concepts?: ConceptDefinition[];
}

const MANIFEST_FILE = "model.json";

// ── Read / Write ─────────────────────────────────────────────────

/**
 * Load model.json from a semantic model directory.
 * Throws if the file doesn't exist or is malformed.
 */
export async function loadManifest(modelDir: string): Promise<ModelManifest> {
  const p = path.join(modelDir, MANIFEST_FILE);
  const raw = await fs.readFile(p, "utf-8");
  const manifest = JSON.parse(raw) as ModelManifest;

  // Minimal validation
  if (!manifest.name || !manifest.base_tables || !Array.isArray(manifest.base_tables)) {
    throw new Error(`Invalid model.json at ${p}: missing name or base_tables`);
  }

  return manifest;
}

/**
 * Save model.json to a semantic model directory.
 */
export async function saveManifest(modelDir: string, manifest: ModelManifest): Promise<void> {
  await fs.mkdir(modelDir, { recursive: true });
  const p = path.join(modelDir, MANIFEST_FILE);
  await fs.writeFile(p, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
}

// ── Resolve helpers ──────────────────────────────────────────────

/**
 * Resolve the directory for a named semantic model.
 */
export function resolveModelDir(semanticModelsDir: string, modelName: string): string {
  return path.join(semanticModelsDir, modelName);
}

/**
 * Resolve the substrate directory, applying defaults.
 * Priority: explicit arg > DEFAULT_SUBSTRATE_DIR > DEFAULT_MODELS_DIR > ./substrate
 *
 * Falls back to DEFAULT_MODELS_DIR because MCP server configurations
 * often set DEFAULT_MODELS_DIR as a catch-all for the working directory.
 * This prevents the agent from defaulting to an empty ./substrate and
 * triggering unnecessary introspection when a substrate already exists.
 */
export function resolveSubstrateDir(explicit?: string): string {
  return explicit ?? process.env.DEFAULT_SUBSTRATE_DIR ?? process.env.DEFAULT_MODELS_DIR ?? "./substrate";
}

/**
 * Resolve the semantic models directory, applying defaults.
 * Priority: explicit arg > env var > ./semantic-models
 */
export function resolveSemanticModelsDir(explicit?: string): string {
  return explicit ?? process.env.DEFAULT_SEMANTIC_MODELS_DIR ?? "./semantic-models";
}
