import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { generateSuggestions } from "../../suggest/suggest.js";
import { validateSuggestions } from "../../suggest/validate.js";
import { resolveModelsDir, resolveBillingProject } from "../config.js";
import { text, formatCost } from "../format.js";
import { sendProgress } from "../progress.js";

export function register(server: McpServer): void {
  server.tool(
    "suggest_metrics",
    "Use an LLM to suggest additional measures, views, and named filters for the introspected models. Each suggestion is validated against the model. Returns a list of compiling and failing suggestions with reasoning. Use this when the user wants ideas for what to measure, or when starting fresh on a new dataset. Do NOT use this to answer specific questions (use ask_question).",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: $WEFT_HOME/substrate)"),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
      max_suggestions: z.number().default(15).describe("Maximum number of suggestions to generate"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);

        const inspectionPath = path.join(modelsDir, "inspection.json");
        let inspectionRaw: string;
        try {
          inspectionRaw = await fs.readFile(inspectionPath, "utf-8");
        } catch {
          throw new McpError(
            ErrorCode.InvalidParams,
            `inspection.json not found at ${inspectionPath}. Run introspect_warehouse first.`,
          );
        }

        const inspectionParsed = JSON.parse(inspectionRaw);
        const connectorKind = inspectionParsed.connector_kind;

        // Resolve billing project — only required for BigQuery
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind === "bigquery" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it as a tool input or set the BQ_PROJECT_ID environment variable.",
          );
        }
        const inspectionCompact = JSON.stringify(inspectionParsed);

        const entries = await fs.readdir(modelsDir);
        const malloyFileNames = entries.filter((f) => f.endsWith(".malloy")).sort();
        if (malloyFileNames.length === 0) {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No .malloy files found in ${modelsDir}. Run introspect_warehouse first.`,
          );
        }

        const malloyFiles = new Map<string, string>();
        for (const name of malloyFileNames) {
          const content = await fs.readFile(path.join(modelsDir, name), "utf-8");
          malloyFiles.set(name, content);
        }

        await sendProgress(`Generating up to ${args.max_suggestions} suggestions...`);

        const result = await generateSuggestions(
          inspectionCompact,
          malloyFiles,
          args.max_suggestions,
        );

        await sendProgress(`Validating ${result.response.suggestions.length} suggestions...`);

        await validateSuggestions(
          result.response.suggestions,
          malloyFiles,
          modelsDir,
          billingProject,
          connectorKind,
        );

        const passing = result.response.suggestions.filter(
          (s) => s.validation?.status === "pass",
        );
        const failing = result.response.suggestions.filter(
          (s) => s.validation?.status !== "pass",
        );

        // Cost
        const inputCost = (result.inputTokens / 1_000_000) * 3;
        const outputCost = (result.outputTokens / 1_000_000) * 15;
        const totalCost = inputCost + outputCost;

        const lines: string[] = [];
        lines.push(`## Metric Suggestions\n`);
        lines.push(`**Domain:** ${result.response.domain}`);
        lines.push(`**Total:** ${result.response.suggestions.length} | **Compiling:** ${passing.length} | **Failing:** ${failing.length}`);
        lines.push(`**Cost:** ${formatCost(totalCost)} (${result.inputTokens.toLocaleString()} in / ${result.outputTokens.toLocaleString()} out)`);
        lines.push("");

        const sorted = [...passing, ...failing];
        for (const s of sorted) {
          const icon = s.validation?.status === "pass" ? "✓" : "✗";
          lines.push(`### ${icon} ${s.title} (${s.confidence})`);
          lines.push("");
          lines.push(`**Target:** \`${s.target_source}\``);
          lines.push("");
          lines.push(s.reasoning);
          lines.push("");
          lines.push("```malloy");
          lines.push(s.malloy_code);
          lines.push("```");

          if (s.validation?.status !== "pass" && s.validation?.error) {
            lines.push("");
            lines.push(`**Compile error:** ${s.validation.error.split("\n")[0]}`);
          }
          lines.push("");
          lines.push("---");
          lines.push("");
        }

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[suggest_metrics] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
