import fs from "node:fs/promises";
import path from "node:path";
import type { ConnectorKind } from "../connectors/types.js";

/**
 * Detect connector kind from inspection.json in the models directory.
 * Returns undefined if the file doesn't exist or can't be read.
 */
export async function detectConnectorKind(modelsDir: string): Promise<ConnectorKind | undefined> {
  try {
    const raw = await fs.readFile(path.join(modelsDir, "inspection.json"), "utf-8");
    const inspection = JSON.parse(raw);
    return inspection.connector_kind;
  } catch {
    return undefined;
  }
}
