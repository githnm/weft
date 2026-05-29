import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { confirmTerm, defineTermManually, saveManualTerm } from "../../terms/define.js";
import { extractSourceSummary } from "../../agent/catalog.js";
import { resolveModelsDir, resolveBillingProject, detectConnectorKind } from "../config.js";
import { text } from "../format.js";
import { sendProgress } from "../progress.js";

export function register(server: McpServer): void {
  server.tool(
    "define_term",
    "Define a new business term that maps a natural-language phrase to a Malloy filter expression. Use this when the user wants to teach the system new vocabulary ('when I say X, I mean ...'). Two modes: confirm a previously auto-proposed term, or define a new term from a description. Do NOT use for filter corrections to existing terms (use correct_answer).",
    {
      term: z.string().describe("The term to define (e.g. 'students')"),
      description: z.string().optional().describe("Description of the term. Required for new terms; not needed with confirm=true."),
      source: z.string().optional().describe("Source .malloy filename to attach the term to (auto-detected if omitted)"),
      confirm: z.boolean().default(false).describe("If true, confirm a pending auto-proposed term instead of creating a new one"),
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const connectorKind = await detectConnectorKind(modelsDir);
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind !== "postgres" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it as a tool input or set the BQ_PROJECT_ID environment variable.",
          );
        }

        if (args.confirm) {
          // Confirm an auto-proposed term
          await sendProgress(`Confirming proposed term "${args.term}"...`);

          const result = await confirmTerm({
            term: args.term,
            modelsDir,
            billingProject,
          });

          return {
            content: [
              text(
                `Term **"${result.key}"** confirmed and saved.\n\n` +
                  `- **Filter:** \`${result.filter}\`\n` +
                  `- **Source:** ${result.sourceName} (\`${result.sourceFilename}\`)`,
              ),
            ],
          };
        }

        // Manual definition
        if (!args.description) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "description is required for new term definitions. Set confirm=true to confirm a pending proposal instead.",
          );
        }

        // Resolve source file
        let sourceFilename = args.source;
        if (!sourceFilename) {
          const entries = await fs.readdir(modelsDir);
          const malloyFiles = entries.filter((f) => f.endsWith(".malloy")).sort();
          for (const f of malloyFiles) {
            const content = await fs.readFile(path.join(modelsDir, f), "utf-8");
            if (extractSourceSummary(f, content)) {
              sourceFilename = f;
              break;
            }
          }
          if (!sourceFilename) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "No .malloy source files found. Specify source explicitly.",
            );
          }
        }

        await sendProgress(`Generating filter for "${args.term}"...`);

        const result = await defineTermManually({
          term: args.term,
          description: args.description,
          sourceFilename,
          modelsDir,
          billingProject,
        });

        await saveManualTerm({
          key: result.key,
          filter: result.filter,
          description: args.description,
          sourceFilename: result.sourceFilename,
          modelsDir,
        });

        return {
          content: [
            text(
              `Term **"${result.key}"** defined and saved.\n\n` +
                `- **Filter:** \`${result.filter}\`\n` +
                `- **Reasoning:** ${result.reasoning}\n` +
                `- **Confidence:** ${result.confidence}\n` +
                `- **Source:** ${result.sourceName} (\`${result.sourceFilename}\`)`,
            ),
          ],
        };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[define_term] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
