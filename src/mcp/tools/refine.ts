import fs from "node:fs/promises";
import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { refineModel, saveRefinement, revertLastRefinement } from "../../interview/refine.js";
import { resolveSemanticModelsDir, loadManifest, resolveModelDir } from "../../models/manifest.js";
import { text } from "../format.js";

export function register(server: McpServer): void {
  // ── refine_model ──────────────────────────────────────────────
  server.tool(
    "refine_model",
    "Refine an existing semantic model by adding or changing measures, dimensions, views, filters, or joins via a natural-language request. Validates the change compiles before saving and shows a diff. Use when the user wants to adjust a model they already built (e.g. 'add a measure for X', 'change the active definition'). Do NOT use to build a new model (use propose_model_plan + build_semantic_model) or to fix a wrong query answer (use correct_answer).",
    {
      model_name: z.string().describe("Name of the semantic model to refine"),
      refinement: z.string().describe(
        "Natural-language description of the change (e.g. 'add a measure for total tool calls', " +
        "'change the active definition to require 5 events', 'drop the role join')",
      ),
      semantic_models_dir: z.string().optional().describe(
        "Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)",
      ),
      billing_project: z.string().optional().describe(
        "GCP billing project for Malloy compilation (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models.",
      ),
      confirm: z.boolean().optional().describe(
        "If true, apply the change immediately without waiting for confirmation. " +
        "If false or omitted, return the diff for review — call again with confirm: true to apply.",
      ),
    },
    async (args) => {
      try {
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));
        const billingProject = args.billing_project ?? process.env.BQ_PROJECT_ID;

        // Detect connector kind from the model's manifest — only BigQuery needs billing_project
        let connectorKind: string | undefined;
        try {
          const modelDir = resolveModelDir(semanticModelsDir, args.model_name);
          const manifest = await loadManifest(modelDir);
          connectorKind = manifest.connector_kind;
          if (!connectorKind) {
            const substrateDir = path.resolve(modelDir, manifest.substrate_dir);
            const raw = await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
            connectorKind = JSON.parse(raw).connector_kind;
          }
        } catch { /* will be caught by refineModel */ }

        if (connectorKind !== "postgres" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models (set via parameter or BQ_PROJECT_ID env var). " +
            "Postgres models do not need it.",
          );
        }

        const result = await refineModel({
          modelName: args.model_name,
          semanticModelsDir,
          refinement: args.refinement,
          billingProject,
        });

        if (!result.success) {
          const lines: string[] = [];
          lines.push(`## Refinement Not Applied\n`);
          lines.push(`**Change type:** ${result.classification.change_type}`);
          lines.push(`**Target:** ${result.classification.target}`);
          lines.push(`**Feasible:** ${result.classification.feasible ? "yes" : "no"}`);
          lines.push(`**Reason:** ${result.classification.reasoning}`);
          if (result.error) lines.push(`\n**Error:** ${result.error}`);
          if (result.classification.missing?.length) {
            lines.push(`\n**Missing:** ${result.classification.missing.join(", ")}`);
          }
          if (result.draft_malloy) {
            lines.push("\n**Draft Malloy (for debugging):**\n");
            lines.push("```malloy");
            lines.push(result.draft_malloy);
            lines.push("```");
          }
          lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);

          return { content: [text(lines.join("\n"))] };
        }

        // Already satisfied — model unchanged, no confirm prompt, no save
        if (result.new_malloy && result.old_malloy && result.new_malloy === result.old_malloy) {
          const lines: string[] = [];
          lines.push(`## No Change Needed: ${args.model_name}\n`);
          lines.push(`**Change type:** ${result.classification.change_type}`);
          lines.push(`**Target:** ${result.classification.target}`);
          if (result.diff_summary) {
            lines.push("");
            lines.push(result.diff_summary);
          }
          lines.push(`\nModel unchanged.`);
          lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);

          return { content: [text(lines.join("\n"))] };
        }

        // If confirm=true, apply immediately
        if (args.confirm) {
          await saveRefinement({
            modelName: args.model_name,
            semanticModelsDir,
            newMalloy: result.new_malloy!,
            refinement: args.refinement,
            classification: result.classification,
          });

          const lines: string[] = [];
          lines.push(`## Refinement Applied: ${args.model_name}\n`);
          lines.push(`**Change:** ${result.classification.change_type} — ${result.classification.target}`);
          lines.push("");
          lines.push("### Changes\n");
          lines.push(result.diff_summary!);
          if (result.compile_warning) {
            lines.push(`\n> **Warning:** ${result.compile_warning}`);
          }
          lines.push("");
          lines.push("_Backup saved as model.malloy.bak. Use `revert_model_refinement` to undo._");
          lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);

          return { content: [text(lines.join("\n"))] };
        }

        // Otherwise, return the diff for review
        const lines: string[] = [];
        lines.push(`## Proposed Refinement: ${args.model_name}\n`);
        lines.push(`**Change:** ${result.classification.change_type} — ${result.classification.target}`);
        lines.push(`**Reason:** ${result.classification.reasoning}`);
        lines.push("");
        lines.push("### Changes\n");
        lines.push(result.diff_summary!);
        lines.push("");
        lines.push("### Updated model.malloy\n");
        lines.push("```malloy");
        lines.push(result.new_malloy!);
        lines.push("```");
        if (result.compile_warning) {
          lines.push(`\n> **Warning:** ${result.compile_warning}`);
        }
        lines.push("");
        lines.push("To apply this change, call `refine_model` again with the same parameters and `confirm: true`.");
        lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[refine_model] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── revert_model_refinement ───────────────────────────────────
  server.tool(
    "revert_model_refinement",
    "Undo the most recent refinement to a semantic model, restoring its previous definition. One level of undo.",
    {
      model_name: z.string().describe("Name of the semantic model to revert"),
      semantic_models_dir: z.string().optional().describe(
        "Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)",
      ),
    },
    async (args) => {
      try {
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));

        const reverted = await revertLastRefinement({
          modelName: args.model_name,
          semanticModelsDir,
        });

        if (reverted) {
          return {
            content: [text(
              `## Refinement Reverted\n\n` +
              `Model "${args.model_name}" restored to its previous definition.\n` +
              `The last refinement has been removed from the history.`,
            )],
          };
        } else {
          throw new McpError(
            ErrorCode.InvalidParams,
            `No backup found for model "${args.model_name}". Nothing to revert. ` +
            "A backup is created each time a refinement is applied.",
          );
        }
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[revert_model_refinement] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
