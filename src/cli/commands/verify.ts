import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { Runtime } from "@malloydata/malloy";
import type { ConnectorKind } from "../../connectors/types.js";
import { buildMalloyConnection } from "../../connectors/malloy-connection.js";

const urlReader = {
  readURL: async (url: URL) => fs.readFile(fileURLToPath(url), "utf-8"),
};

/**
 * Detect connector kind from inspection.json in the models directory.
 * Returns undefined if the file doesn't exist or can't be read.
 */
async function detectConnectorKind(modelsDir: string): Promise<ConnectorKind | undefined> {
  try {
    const raw = await fs.readFile(path.join(modelsDir, "inspection.json"), "utf-8");
    const inspection = JSON.parse(raw);
    return inspection.connector_kind;
  } catch {
    return undefined;
  }
}

// Connection builder is now imported from connectors/malloy-connection.ts

export async function runVerify(options: { modelsDir: string; billingProject: string }): Promise<void> {
  const connectorKind = await detectConnectorKind(options.modelsDir);
  const connection = buildMalloyConnection({ connectorKind, billingProject: options.billingProject });

  const runtime = new Runtime({ urlReader, connection });

  const entries = await fs.readdir(options.modelsDir);
  const malloyFiles = entries.filter((f) => f.endsWith(".malloy")).sort();

  if (malloyFiles.length === 0) {
    console.log(`\n  No .malloy files found in ${options.modelsDir}\n`);
    return;
  }

  const connectorLabel = connectorKind === "postgres" ? " (Postgres)" : " (BigQuery)";
  console.log(`\n  Verifying ${malloyFiles.length} .malloy files in ${options.modelsDir}${connectorLabel}...\n`);

  let passed = 0;
  let failed = 0;

  for (const file of malloyFiles) {
    const filePath = path.resolve(options.modelsDir, file);
    const fileUrl = pathToFileURL(filePath);

    try {
      const model = await runtime.getModel(fileUrl);
      const sourceCount = model.explores.length;
      const content = await fs.readFile(filePath, "utf-8");
      const viewCount = (content.match(/^\s*view:/gm) ?? []).length;

      console.log(
        `  OK:   ${file} (${sourceCount} source${sourceCount !== 1 ? "s" : ""}, ${viewCount} view${viewCount !== 1 ? "s" : ""})`
      );
      passed++;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.log(`  FAIL: ${file}`);
      for (const line of message.split("\n")) {
        console.log(`    ${line}`);
      }
      failed++;
    }
  }

  console.log(`\n  Files checked: ${malloyFiles.length}`);
  console.log(`  Passed:        ${passed}`);
  console.log(`  Failed:        ${failed}`);

  if (failed > 0) process.exit(1);
}
