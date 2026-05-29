import path from "node:path";
import { createModel } from "../../models/create.js";
import { listModels, showModel, deleteModel, listSubstrateTables } from "../../models/registry.js";
import { resolveSubstrateDir, resolveSemanticModelsDir } from "../../models/manifest.js";

// ── model create ─────────────────────────────────────────────────

export interface ModelCreateOptions {
  name: string;
  purpose: string;
  tables: string[];
  substrateDir?: string;
  semanticModelsDir?: string;
}

export async function runModelCreate(options: ModelCreateOptions): Promise<void> {
  const substrateDir = path.resolve(resolveSubstrateDir(options.substrateDir));
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));

  console.log(`\n  Creating model "${options.name}"...`);
  console.log(`  Substrate: ${substrateDir}`);
  console.log(`  Tables: ${options.tables.join(", ")}`);
  console.log("");

  const modelDir = await createModel({
    name: options.name,
    purpose: options.purpose,
    substrateDir,
    semanticModelsDir,
    tables: options.tables,
  });

  console.log(`  ✓ Model created at ${modelDir}`);
  console.log("");
  console.log("  Next steps:");
  console.log(`    - Ask questions: pnpm cli ask "..." --model ${options.name}`);
  console.log(`    - Define terms:  pnpm cli define <term> --description "..." --models ${modelDir}`);
  console.log(`    - View model:    pnpm cli model show ${options.name}`);
  console.log("");
}

// ── model list ───────────────────────────────────────────────────

export interface ModelListOptions {
  semanticModelsDir?: string;
}

export async function runModelList(options: ModelListOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));
  const models = await listModels(semanticModelsDir);

  if (models.length === 0) {
    console.log("\n  No semantic models found.");
    console.log(`  Create one: pnpm cli model create --name <name> --purpose "..." --tables <t1> <t2>`);
    console.log("");
    return;
  }

  console.log(`\n  Semantic models (${models.length}):\n`);

  for (const m of models) {
    const extras: string[] = [];
    if (m.has_terms) extras.push("has terms");
    if (m.has_corrections) extras.push("has corrections");
    const extrasStr = extras.length > 0 ? ` [${extras.join(", ")}]` : "";

    console.log(`  ${m.name}`);
    console.log(`    Purpose:   ${m.purpose}`);
    console.log(`    Tables:    ${m.tables.join(", ")}`);
    console.log(`    Files:     ${m.malloy_file_count} .malloy`);
    if (m.connector_kind) {
      console.log(`    Connector: ${m.connector_kind}`);
    }
    console.log(`    Created:   ${m.created_at}${extrasStr}`);
    console.log("");
  }
}

// ── model show ───────────────────────────────────────────────────

export interface ModelShowOptions {
  name: string;
  semanticModelsDir?: string;
}

export async function runModelShow(options: ModelShowOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));
  const detail = await showModel(semanticModelsDir, options.name);

  console.log(`\n  Model: ${detail.name}`);
  console.log(`  Purpose: ${detail.purpose}`);
  console.log(`  Directory: ${detail.dir}`);
  console.log(`  Substrate: ${detail.substrate_dir}`);
  if (detail.connector_kind) {
    console.log(`  Connector: ${detail.connector_kind}`);
  }
  console.log(`  Created: ${detail.created_at}`);
  console.log("");
  console.log(`  Base tables (${detail.tables.length}):`);
  for (const t of detail.tables) {
    console.log(`    - ${t}`);
  }
  console.log("");
  console.log(`  .malloy files (${detail.malloy_files.length}):`);
  for (const f of detail.malloy_files) {
    const isBase = detail.tables.includes(f.replace(".malloy", ""));
    console.log(`    - ${f}${isBase ? "" : " (imported)"}`);
  }
  console.log("");
  console.log(`  Terms: ${detail.has_terms ? "yes" : "none"}`);
  console.log(`  Corrections: ${detail.has_corrections ? "yes" : "none"}`);
  console.log("");
}

// ── model delete ─────────────────────────────────────────────────

export interface ModelDeleteOptions {
  name: string;
  semanticModelsDir?: string;
}

export async function runModelDelete(options: ModelDeleteOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));
  const deleted = await deleteModel(semanticModelsDir, options.name);

  if (deleted) {
    console.log(`\n  ✓ Model "${options.name}" deleted.\n`);
  } else {
    console.error(`\n  Model "${options.name}" not found.\n`);
    process.exit(1);
  }
}

// ── model tables (list available substrate tables) ───────────────

export interface ModelTablesOptions {
  substrateDir?: string;
}

export async function runModelTables(options: ModelTablesOptions): Promise<void> {
  const substrateDir = path.resolve(resolveSubstrateDir(options.substrateDir));
  const tables = await listSubstrateTables(substrateDir);

  if (tables.length === 0) {
    console.log(`\n  No tables found in substrate: ${substrateDir}`);
    console.log("  Run 'pnpm cli introspect' first.\n");
    return;
  }

  console.log(`\n  Available tables in substrate (${tables.length}):\n`);
  for (const t of tables) {
    console.log(`    ${t}`);
  }
  console.log("");
}
