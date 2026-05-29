import fs from "node:fs/promises";
import path from "node:path";
import type { ModelManifest } from "./manifest.js";
import { loadManifest } from "./manifest.js";

// ── Types ────────────────────────────────────────────────────────

export interface ModelSummary {
  name: string;
  purpose: string;
  tables: string[];
  created_at: string;
  connector_kind?: string;
  /** Number of .malloy files in the model directory */
  malloy_file_count: number;
  /** Whether terms.json has any entries */
  has_terms: boolean;
  /** Whether corrections.json has any entries */
  has_corrections: boolean;
}

export interface ModelDetail extends ModelSummary {
  dir: string;
  substrate_dir: string;
  malloy_files: string[];
  manifest: ModelManifest;
}

// ── List ──────────────────────────────────────────────────────────

/**
 * List all semantic models in the semantic-models directory.
 * Each subdirectory with a model.json is a model.
 */
export async function listModels(semanticModelsDir: string): Promise<ModelSummary[]> {
  let entries: string[];
  try {
    entries = await fs.readdir(semanticModelsDir);
  } catch {
    return []; // directory doesn't exist yet
  }

  const models: ModelSummary[] = [];

  for (const entry of entries.sort()) {
    const modelDir = path.join(semanticModelsDir, entry);
    const stat = await fs.stat(modelDir).catch(() => null);
    if (!stat?.isDirectory()) continue;

    try {
      const manifest = await loadManifest(modelDir);
      const dirEntries = await fs.readdir(modelDir);
      const malloyFiles = dirEntries.filter((f) => f.endsWith(".malloy"));

      let hasTerms = false;
      try {
        const termsRaw = await fs.readFile(path.join(modelDir, "terms.json"), "utf-8");
        hasTerms = Object.keys(JSON.parse(termsRaw)).length > 0;
      } catch { /* no terms file */ }

      let hasCorrections = false;
      try {
        const correctionsRaw = await fs.readFile(path.join(modelDir, "corrections.json"), "utf-8");
        const corrections = JSON.parse(correctionsRaw);
        hasCorrections = Array.isArray(corrections) ? corrections.length > 0 : Object.keys(corrections).length > 0;
      } catch { /* no corrections file */ }

      models.push({
        name: manifest.name,
        purpose: manifest.purpose,
        tables: manifest.base_tables,
        created_at: manifest.created_at,
        connector_kind: manifest.connector_kind,
        malloy_file_count: malloyFiles.length,
        has_terms: hasTerms,
        has_corrections: hasCorrections,
      });
    } catch {
      // Skip directories without valid model.json
    }
  }

  return models;
}

// ── Show ──────────────────────────────────────────────────────────

/**
 * Show detailed information about a specific semantic model.
 */
export async function showModel(
  semanticModelsDir: string,
  modelName: string,
): Promise<ModelDetail> {
  const modelDir = path.join(semanticModelsDir, modelName);

  let manifest: ModelManifest;
  try {
    manifest = await loadManifest(modelDir);
  } catch {
    throw new Error(
      `Model "${modelName}" not found at ${modelDir}.\n` +
        "Use 'model list' to see available models.",
    );
  }

  const dirEntries = await fs.readdir(modelDir);
  const malloyFiles = dirEntries.filter((f) => f.endsWith(".malloy")).sort();

  let hasTerms = false;
  try {
    const termsRaw = await fs.readFile(path.join(modelDir, "terms.json"), "utf-8");
    hasTerms = Object.keys(JSON.parse(termsRaw)).length > 0;
  } catch { /* no terms file */ }

  let hasCorrections = false;
  try {
    const correctionsRaw = await fs.readFile(path.join(modelDir, "corrections.json"), "utf-8");
    const corrections = JSON.parse(correctionsRaw);
    hasCorrections = Array.isArray(corrections) ? corrections.length > 0 : Object.keys(corrections).length > 0;
  } catch { /* no corrections file */ }

  return {
    name: manifest.name,
    purpose: manifest.purpose,
    tables: manifest.base_tables,
    created_at: manifest.created_at,
    connector_kind: manifest.connector_kind,
    malloy_file_count: malloyFiles.length,
    has_terms: hasTerms,
    has_corrections: hasCorrections,
    dir: modelDir,
    substrate_dir: manifest.substrate_dir,
    malloy_files: malloyFiles,
    manifest,
  };
}

// ── Delete ────────────────────────────────────────────────────────

/**
 * Delete a semantic model directory entirely.
 * Returns true if the model was deleted, false if it didn't exist.
 */
export async function deleteModel(
  semanticModelsDir: string,
  modelName: string,
): Promise<boolean> {
  const modelDir = path.join(semanticModelsDir, modelName);

  try {
    // Verify it's actually a model (has model.json)
    await loadManifest(modelDir);
  } catch {
    return false;
  }

  await fs.rm(modelDir, { recursive: true, force: true });
  return true;
}

// ── Available tables ─────────────────────────────────────────────

/**
 * List tables available in a substrate directory.
 */
export async function listSubstrateTables(substrateDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(substrateDir);
    return entries
      .filter((f) => f.endsWith(".malloy") && f !== "model.malloy")
      .map((f) => f.replace(".malloy", ""))
      .sort();
  } catch {
    return [];
  }
}
