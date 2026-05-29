import fs from "node:fs/promises";
import path from "node:path";
import type { CorrectionsStore, CorrectionRecord } from "./types.js";

const CORRECTIONS_FILE = "corrections.json";

export async function loadCorrections(modelsDir: string): Promise<CorrectionsStore> {
  const p = path.join(modelsDir, CORRECTIONS_FILE);
  try {
    const raw = await fs.readFile(p, "utf-8");
    return JSON.parse(raw) as CorrectionsStore;
  } catch {
    return {};
  }
}

export async function saveCorrections(modelsDir: string, store: CorrectionsStore): Promise<void> {
  const p = path.join(modelsDir, CORRECTIONS_FILE);
  await fs.writeFile(p, JSON.stringify(store, null, 2), "utf-8");
}

/**
 * Generate a correction ID from a target name and current timestamp.
 * Format: "<target>_<YYYYMMDD>_<HHmmss>"
 */
export function generateCorrectionId(target: string): string {
  const now = new Date();
  const date = now.toISOString().slice(0, 10).replace(/-/g, "");
  const time = now.toISOString().slice(11, 19).replace(/:/g, "");
  const safe = target.replace(/[^a-zA-Z0-9_]/g, "_").slice(0, 30);
  return `${safe}_${date}_${time}`;
}

export async function addCorrection(
  modelsDir: string,
  id: string,
  record: CorrectionRecord,
): Promise<void> {
  const store = await loadCorrections(modelsDir);
  store[id] = record;
  await saveCorrections(modelsDir, store);
}

export async function getCorrection(
  modelsDir: string,
  id: string,
): Promise<CorrectionRecord | null> {
  const store = await loadCorrections(modelsDir);
  return store[id] ?? null;
}
