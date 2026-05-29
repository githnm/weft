import fs from "node:fs/promises";
import path from "node:path";
import type { ModelManifest } from "./manifest.js";
import { saveManifest } from "./manifest.js";
import type { DatasetMetadata, SourceMetadata } from "../introspect/metadata.js";

export interface CreateModelOptions {
  /** Name for the new model (becomes directory name) */
  name: string;
  /** One-line purpose description */
  purpose: string;
  /** Absolute path to substrate directory */
  substrateDir: string;
  /** Absolute path to semantic-models parent directory */
  semanticModelsDir: string;
  /** Table names to include (must exist as .malloy files in substrate) */
  tables: string[];
}

/**
 * Create a new semantic model.
 *
 * Steps:
 *  1. Validate inputs — tables must exist in substrate
 *  2. Create model directory
 *  3. Copy selected .malloy files + any imported .malloy files
 *  4. Scope metadata.json to only the selected tables
 *  5. Copy inspection.json (needed for connector detection)
 *  6. Write model.json manifest
 *  7. Init empty terms.json and corrections.json
 *
 * Returns the path to the created model directory.
 */
export async function createModel(options: CreateModelOptions): Promise<string> {
  const { name, purpose, substrateDir, semanticModelsDir, tables } = options;

  // ── Validate substrate exists ──
  try {
    await fs.access(substrateDir);
  } catch {
    throw new Error(
      `Substrate directory not found: ${substrateDir}\n` +
        "Run 'introspect' first to create the substrate.",
    );
  }

  // ── List available tables from substrate ──
  const substrateEntries = await fs.readdir(substrateDir);
  const availableMalloy = substrateEntries.filter((f) => f.endsWith(".malloy"));
  const availableTableNames = availableMalloy.map((f) => f.replace(".malloy", ""));

  // ── Validate requested tables exist ──
  const missing = tables.filter((t) => !availableTableNames.includes(t));
  if (missing.length > 0) {
    throw new Error(
      `Tables not found in substrate: ${missing.join(", ")}\n` +
        `Available tables: ${availableTableNames.join(", ")}`,
    );
  }

  // ── Check model doesn't already exist ──
  const modelDir = path.join(semanticModelsDir, name);
  try {
    await fs.access(modelDir);
    throw new Error(
      `Model "${name}" already exists at ${modelDir}.\n` +
        "Delete it first with 'model delete' or choose a different name.",
    );
  } catch (err: unknown) {
    // ENOENT is expected — model doesn't exist yet
    if (err instanceof Error && !err.message.includes("ENOENT") && !err.message.includes("already exists")) {
      throw err;
    }
    if (err instanceof Error && err.message.includes("already exists")) {
      throw err;
    }
  }

  // ── Create model directory ──
  await fs.mkdir(modelDir, { recursive: true });

  // ── Copy .malloy files (selected tables + their imports) ──
  const filesToCopy = new Set<string>();
  for (const table of tables) {
    filesToCopy.add(`${table}.malloy`);
  }

  // Resolve imports recursively
  const resolved = new Set<string>();
  const queue = [...filesToCopy];
  while (queue.length > 0) {
    const file = queue.pop()!;
    if (resolved.has(file)) continue;
    resolved.add(file);

    const filePath = path.join(substrateDir, file);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      // Find import statements: import "other_table.malloy"
      for (const match of content.matchAll(/^\s*import\s+"([^"]+)"/gm)) {
        const importName = match[1];
        if (!resolved.has(importName) && availableMalloy.includes(importName)) {
          queue.push(importName);
          filesToCopy.add(importName);
        }
      }
    } catch {
      // If a file can't be read, skip import resolution for it
    }
  }

  for (const file of filesToCopy) {
    const srcPath = path.join(substrateDir, file);
    const dstPath = path.join(modelDir, file);
    await fs.copyFile(srcPath, dstPath);
  }

  // ── Scope metadata.json ──
  try {
    const metadataRaw = await fs.readFile(path.join(substrateDir, "metadata.json"), "utf-8");
    const fullMetadata = JSON.parse(metadataRaw) as DatasetMetadata;

    const scopedSources: Record<string, SourceMetadata> = {};
    for (const table of tables) {
      if (fullMetadata.sources[table]) {
        scopedSources[table] = fullMetadata.sources[table];
      }
    }

    // Also include imported tables that aren't in the primary selection
    for (const file of filesToCopy) {
      const tableName = file.replace(".malloy", "");
      if (!scopedSources[tableName] && fullMetadata.sources[tableName]) {
        scopedSources[tableName] = fullMetadata.sources[tableName];
      }
    }

    const scopedMetadata: DatasetMetadata = {
      generated_at: fullMetadata.generated_at,
      dataset: fullMetadata.dataset,
      sources: scopedSources,
    };

    await fs.writeFile(
      path.join(modelDir, "metadata.json"),
      JSON.stringify(scopedMetadata, null, 2) + "\n",
      "utf-8",
    );
  } catch {
    // metadata.json may not exist in substrate — that's OK
  }

  // ── Copy inspection.json (needed for connector detection) ──
  try {
    await fs.copyFile(
      path.join(substrateDir, "inspection.json"),
      path.join(modelDir, "inspection.json"),
    );
  } catch {
    // inspection.json may not exist — that's OK
  }

  // ── Detect connector kind ──
  let connectorKind: string | undefined;
  try {
    const inspectionRaw = await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
    connectorKind = JSON.parse(inspectionRaw).connector_kind;
  } catch {
    // best-effort
  }

  // ── Write model.json ──
  const manifest: ModelManifest = {
    name,
    purpose,
    substrate_dir: path.relative(modelDir, substrateDir) || substrateDir,
    base_tables: tables,
    created_at: new Date().toISOString(),
    connector_kind: connectorKind,
  };
  await saveManifest(modelDir, manifest);

  // ── Init empty terms.json and corrections.json ──
  await fs.writeFile(path.join(modelDir, "terms.json"), "{}\n", "utf-8");
  await fs.writeFile(path.join(modelDir, "corrections.json"), "[]\n", "utf-8");

  return modelDir;
}
