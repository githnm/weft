import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { ask, QueryError } from "../../agent/ask.js";
import { estimateCost, formatCost as formatLlmCost } from "../../llm/anthropic.js";
import { resolveModelsDir, resolveBillingProject, detectConnectorKind } from "../config.js";
import { resolveSemanticModelsDir } from "../../models/manifest.js";
import { text, formatMarkdownTable, formatBytes, formatCost } from "../format.js";
import { sendProgress } from "../progress.js";

const BQ_COST_PER_TB = 6.25;

export function register(server: McpServer): void {
  server.tool(
    "ask_question",
    "Answer a natural-language analytical question by generating and running a Malloy query against the introspected dataset. The engine selects a source, checks feasibility, generates Malloy, executes against BigQuery, and verifies the result. Use this as the default tool for any analytical question. When model_name is provided, only the tables in that semantic model are visible. Do NOT use for schema work (introspect_warehouse), corrections (correct_answer), or term definitions (define_term).",
    {
      question: z.string().describe("Natural-language analytical question"),
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR). Ignored when model_name is set."),
      model_name: z.string().optional().describe("Named semantic model to query (e.g. 'sales'). The agent only sees tables in this model."),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models). Used with model_name."),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
      source: z.string().optional().describe("Override automatic source selection with this source name or filename"),
      show_malloy: z.boolean().default(true).describe("Include the generated Malloy query in the output"),
      dry_run: z.boolean().default(false).describe("Generate and compile query but do not execute against BigQuery"),
      no_session: z.boolean().default(false).describe("Don't inherit context from previous questions"),
      location: z.string().default("US").describe("BigQuery dataset region"),
    },
    async (args) => {
      try {
        // Resolve models directory: semantic model takes precedence
        let modelsDir: string;
        if (args.model_name) {
          const semanticModelsDir = resolveSemanticModelsDir(args.semantic_models_dir);
          modelsDir = path.resolve(path.join(semanticModelsDir, args.model_name));
        } else {
          modelsDir = resolveModelsDir(args.models_dir);
        }
        // Detect connector kind to determine billing requirements
        const connectorKind = await detectConnectorKind(modelsDir);
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind !== "postgres" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it as a tool input or set the BQ_PROJECT_ID environment variable. Not needed for Postgres models.",
          );
        }

        await sendProgress("Selecting source...");

        let result;
        try {
          result = await ask({
            question: args.question,
            modelsDir,
            billingProject,
            location: args.location,
            sourceOverride: args.source,
            showMalloy: args.show_malloy,
            dryRun: args.dry_run,
            noSession: args.no_session,
          });
        } catch (err: unknown) {
          if (err instanceof QueryError) {
            const lines = [
              `## Query Error (${err.phase})\n`,
              err.message,
              "",
              "**Failed Malloy:**",
              "```malloy",
              err.malloy,
              "```",
              "",
              "**Suggestions:**",
              "- Try rephrasing the question",
              "- Use a different source",
              "- Check the model with `verify_models`",
            ];
            return { content: [text(lines.join("\n"))], isError: true };
          }
          throw err;
        }

        const content: { type: "text"; text: string }[] = [];

        // ── Correction detected ──────────────────────────────
        if (result.correctionDetected) {
          const cd = result.correctionDetected;
          const lines = [
            `## Correction Detected\n`,
            `The question looks like a correction to the previous query, not a new question.\n`,
            `- **Type:** ${cd.type}`,
            `- **Confidence:** ${cd.confidence}`,
            `- **Reasoning:** ${cd.reasoning}`,
            "",
            `Use \`correct_answer\` with the correction text to apply it.`,
          ];
          return { content: [text(lines.join("\n"))] };
        }

        // ── Block 1: Summary ─────────────────────────────────
        const summary: string[] = [];
        summary.push(`## ${args.question}\n`);

        if (result.followUp?.isFollowUp && result.previousQuestion) {
          summary.push(`_Follow-up to: "${result.previousQuestion}"_\n`);
        }

        summary.push(`**Source:** ${result.source.sourceName} (\`${result.source.filename}\`)`);
        summary.push(`**Reasoning:** ${result.source.reasoning}`);

        // Feasibility failure
        if (result.feasibility && !result.feasibility.feasible) {
          summary.push("");
          summary.push("### Not Feasible\n");
          summary.push(result.feasibility.reasoning);

          if ((result.feasibility.missingConcepts ?? []).length > 0) {
            summary.push("\n**Missing concepts:**");
            for (const c of result.feasibility.missingConcepts) {
              summary.push(`- ${c}`);
            }
          }

          const di = result.feasibility.dataIssues;
          if (di) {
            if (di.timeOutOfRange) {
              summary.push(`\n**Time range mismatch:** requested "${di.timeOutOfRange.requested}" but data covers ${di.timeOutOfRange.available}`);
            }
            if (di.unknownFilterValue) {
              summary.push(`\n**Unknown value:** "${di.unknownFilterValue.userTerm}" not found in ${di.unknownFilterValue.column}`);
              summary.push(`Did you mean: ${di.unknownFilterValue.knownValues.slice(0, 10).join(", ")}?`);
            }
            if (di.staleData) {
              summary.push(`\n**Stale data:** latest data is from ${di.staleData.latest} (${di.staleData.daysOld} days ago)`);
            }
          }

          summary.push("\nNo query was executed. No BigQuery cost incurred.");
          content.push(text(summary.join("\n")));
          return { content };
        }

        if (result.query) {
          summary.push(`**Plan:** ${result.query.explanation}`);
          if (result.query.wasRetried) {
            summary.push("_(query was fixed after an error on first attempt)_");
          }
        }

        content.push(text(summary.join("\n")));

        // ── Block 2: Malloy code ─────────────────────────────
        if (args.show_malloy && result.query) {
          content.push(text("```malloy\n" + result.query.malloy + "\n```"));
        }

        // ── Block 3: Results ─────────────────────────────────
        if (args.dry_run && result.query) {
          content.push(text("_Compiled successfully (dry run — not executed)._"));
        } else if (result.execution) {
          const tableText = formatMarkdownTable(result.execution.rows);
          const meta: string[] = [];
          meta.push(`**Rows:** ${result.execution.totalRows.toLocaleString()}`);
          if (result.execution.bytesScanned !== undefined) {
            const bqCost = (result.execution.bytesScanned / 1024 ** 4) * BQ_COST_PER_TB;
            meta.push(`**Bytes scanned:** ${formatBytes(result.execution.bytesScanned)}`);
            meta.push(`**BQ cost:** ${formatCost(bqCost)}`);
          }
          content.push(text(tableText + "\n\n" + meta.join(" | ")));
        }

        // ── Block 4: Verification + caveats ──────────────────
        if (result.verification) {
          const structuralChecks = result.verification.structuralChecks ?? [];
          const semantic = result.verification.semantic;
          const caveats = semantic?.caveats ?? [];
          const warnings = structuralChecks.filter((c) => c.severity === "warning");
          const hasIssues =
            warnings.length > 0 ||
            (semantic && semantic.matchesIntent !== "yes") ||
            caveats.length > 0;

          if (!hasIssues && (!semantic || semantic.matchesIntent === "yes")) {
            content.push(text("**Verification:** ✓ Results match the question. No issues detected."));
          } else {
            const vLines: string[] = ["### Verification\n"];

            for (const check of warnings) {
              vLines.push(`- ⚠ ${check.message}`);
            }

            if (semantic) {
              vLines.push(`\n**Intent match:** ${semantic.matchesIntent} (confidence: ${semantic.confidence})`);
              vLines.push(`**Reasoning:** ${semantic.reasoning}`);

              if (caveats.length > 0) {
                vLines.push("\n**Caveats:**");
                for (const caveat of caveats) {
                  vLines.push(`- ${caveat}`);
                }
              }
            }

            content.push(text(vLines.join("\n")));
          }
        }

        // ── Proposed terms ───────────────────────────────────
        if (result.proposedTerms && result.proposedTerms.length > 0) {
          const tLines: string[] = ["### Auto-proposed Terms\n"];
          for (const p of result.proposedTerms) {
            tLines.push(`- **"${p.userTerm}"** → \`${p.filter}\` — confirm with \`define_term("${p.key}", confirm=true)\``);
          }
          content.push(text(tLines.join("\n")));
        }

        // ── Cost footer ──────────────────────────────────────
        const llmCost = estimateCost(result.totalUsage);
        const bqCost = result.execution?.bytesScanned
          ? (result.execution.bytesScanned / 1024 ** 4) * BQ_COST_PER_TB
          : 0;
        const totalCost = llmCost + bqCost;

        const costLine =
          `_Tokens: ${result.totalUsage.inputTokens.toLocaleString()} in / ${result.totalUsage.outputTokens.toLocaleString()} out` +
          ` | LLM: ${formatCost(llmCost)}` +
          (bqCost > 0 ? ` | Total: ${formatCost(totalCost)}` : "") +
          `_`;
        content.push(text(costLine));

        return { content };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[ask_question] ${message}`);

        if (message.includes("ANTHROPIC_API_KEY")) {
          throw new McpError(ErrorCode.InternalError, `Missing ANTHROPIC_API_KEY environment variable.`);
        }
        if (message.includes("Could not load the default credentials")) {
          throw new McpError(ErrorCode.InternalError, `BigQuery auth error. Set GOOGLE_APPLICATION_CREDENTIALS or run \`gcloud auth application-default login\`.`);
        }
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
