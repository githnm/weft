/**
 * Shared configuration resolution for MCP tools.
 *
 * All directories resolve through WEFT_HOME (see ../config/home.ts); tool
 * inputs override. No per-tool path is needed for the common case.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { weftSubstrateDir } from "../config/home.js";

/** Raw-substrate dir for an ask without a named model. */
export function resolveModelsDir(input?: string): string {
  return input || weftSubstrateDir();
}

/**
 * Resolve the GCP billing project.
 * Returns undefined if neither input nor BQ_PROJECT_ID is set.
 * The caller decides whether to throw based on connector kind —
 * BigQuery needs it, Postgres does not.
 */
export function resolveBillingProject(input?: string): string | undefined {
  return input || process.env.BQ_PROJECT_ID || undefined;
}

/**
 * Detect the connector kind from a models / semantic-model directory.
 * Checks model.json first (semantic model), then inspection.json (substrate).
 * Returns undefined if neither is found (callers should default to bigquery).
 */
export async function detectConnectorKind(dir: string): Promise<string | undefined> {
  // Semantic model directory → model.json
  try {
    const raw = await fs.readFile(path.join(dir, "model.json"), "utf-8");
    const manifest = JSON.parse(raw);
    if (manifest.connector_kind) return manifest.connector_kind;
    // Follow substrate_dir link if present
    if (manifest.substrate_dir) {
      const substrateDir = path.resolve(dir, manifest.substrate_dir);
      const subRaw = await fs.readFile(
        path.join(substrateDir, "inspection.json"),
        "utf-8",
      );
      return JSON.parse(subRaw).connector_kind;
    }
  } catch {
    /* not a semantic model dir or no manifest */
  }

  // Substrate / models directory → inspection.json
  try {
    const raw = await fs.readFile(path.join(dir, "inspection.json"), "utf-8");
    return JSON.parse(raw).connector_kind;
  } catch {
    /* no inspection either */
  }

  return undefined;
}
