import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { pathToFileURL, fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { Runtime } from "@malloydata/malloy";
import type { ConnectorKind } from "../../connectors/types.js";
import { buildMalloyConnection } from "../../connectors/malloy-connection.js";
import { generateMetadata } from "../../introspect/metadata.js";
import { resolveModelsDir, resolveBillingProject } from "../config.js";
import { text } from "../format.js";
import { sendProgress } from "../progress.js";

export function register(server: McpServer): void {
  // ── verify_models ──────────────────────────────────────────
  server.tool(
    "verify_models",
    "Compile every .malloy file in the models directory and report pass/fail per file. Use this after manually editing a .malloy file, or to debug introspection problems. Do NOT use this to answer questions; it does not execute queries against BigQuery.",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);

        // Detect connector kind from inspection.json
        let connectorKind: ConnectorKind | undefined;
        try {
          const raw = await fs.readFile(path.join(modelsDir, "inspection.json"), "utf-8");
          connectorKind = JSON.parse(raw).connector_kind;
        } catch { /* default to bigquery */ }

        // Resolve billing project — only required for BigQuery
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind !== "postgres" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it as a tool input or set the BQ_PROJECT_ID environment variable.",
          );
        }

        const connection = buildMalloyConnection({ connectorKind, billingProject });

        const urlReader = {
          readURL: async (url: URL) => fs.readFile(fileURLToPath(url), "utf-8"),
        };

        const runtime = new Runtime({ urlReader, connection });

        const entries = await fs.readdir(modelsDir);
        const malloyFiles = entries.filter((f) => f.endsWith(".malloy")).sort();

        if (malloyFiles.length === 0) {
          return { content: [text(`No .malloy files found in \`${modelsDir}\`.`)] };
        }

        await sendProgress(`Verifying ${malloyFiles.length} .malloy files...`);

        const results: { file: string; status: string; detail: string }[] = [];
        let passed = 0;
        let failed = 0;

        for (const file of malloyFiles) {
          const filePath = path.resolve(modelsDir, file);
          const fileUrl = pathToFileURL(filePath);

          try {
            const model = await runtime.getModel(fileUrl);
            const sourceCount = model.explores.length;
            const content = await fs.readFile(filePath, "utf-8");
            const viewCount = (content.match(/^\s*view:/gm) ?? []).length;

            results.push({
              file,
              status: "OK",
              detail: `${sourceCount} source${sourceCount !== 1 ? "s" : ""}, ${viewCount} view${viewCount !== 1 ? "s" : ""}`,
            });
            passed++;
          } catch (err: unknown) {
            const message = err instanceof Error ? err.message : String(err);
            results.push({ file, status: "FAIL", detail: message.split("\n")[0] });
            failed++;
          }
        }

        const lines: string[] = [];
        lines.push(`## Verification Results\n`);
        lines.push("| File | Status | Detail |");
        lines.push("| --- | --- | --- |");
        for (const r of results) {
          const icon = r.status === "OK" ? "✓" : "✗";
          lines.push(`| ${r.file} | ${icon} ${r.status} | ${r.detail} |`);
        }
        lines.push("");
        lines.push(`**${passed} passed, ${failed} failed** out of ${malloyFiles.length} files.`);

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[verify_models] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── refresh_metadata ───────────────────────────────────────
  server.tool(
    "refresh_metadata",
    "Regenerate models/metadata.json from the existing inspection.json without re-querying BigQuery. Use this when inspection.json has been edited manually, or to apply changes to the metadata schema. Cheap, no BigQuery cost.",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const inspectionPath = path.join(modelsDir, "inspection.json");
        const metadataPath = path.join(modelsDir, "metadata.json");

        let raw: string;
        try {
          raw = await fs.readFile(inspectionPath, "utf-8");
        } catch {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Cannot read ${inspectionPath}. Run introspect_warehouse first.`,
          );
        }

        const inspection = JSON.parse(raw);
        generateMetadata(inspection, metadataPath);

        return {
          content: [text(`Metadata regenerated at \`${metadataPath}\`.`)],
        };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[refresh_metadata] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
