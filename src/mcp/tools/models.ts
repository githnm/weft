import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { createModel } from "../../models/create.js";
import { listModels, showModel, deleteModel, listSubstrateTables } from "../../models/registry.js";
import { resolveSubstrateDir, resolveSemanticModelsDir } from "../../models/manifest.js";
import { text } from "../format.js";

export function register(server: McpServer): void {
  // ── create_model ───────────────────────────────────────────
  server.tool(
    "create_model",
    "Create a named semantic model from a subset of substrate tables. Use this when the user wants to build a purpose-scoped model (e.g. 'sales model' or 'marketing model') from the introspected dataset. The substrate must exist first (run introspect_warehouse). Do NOT use this for general questions (use ask_question).",
    {
      name: z.string().describe("Name for the model (becomes directory name, e.g. 'sales')"),
      purpose: z.string().describe("One-line purpose description (e.g. 'Sales team KPIs and pipeline analysis')"),
      tables: z.array(z.string()).describe("Table names to include (must exist in substrate)"),
      substrate_dir: z.string().optional().describe("Path to substrate directory (default: ./substrate or $DEFAULT_SUBSTRATE_DIR)"),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const substrateDir = path.resolve(resolveSubstrateDir(args.substrate_dir));
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));

        const modelDir = await createModel({
          name: args.name,
          purpose: args.purpose,
          substrateDir,
          semanticModelsDir,
          tables: args.tables,
        });

        const lines: string[] = [];
        lines.push(`## Model Created\n`);
        lines.push(`**Name:** ${args.name}`);
        lines.push(`**Purpose:** ${args.purpose}`);
        lines.push(`**Tables:** ${args.tables.join(", ")}`);
        lines.push(`**Directory:** \`${modelDir}\``);
        lines.push("");
        lines.push("Use `ask_question` with `model_name: \"" + args.name + "\"` to query this model.");

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[create_model] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── list_models ────────────────────────────────────────────
  server.tool(
    "list_models",
    "List all named semantic models. Use this when the user wants to see available models, or before suggesting which model to query.",
    {
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));
        const models = await listModels(semanticModelsDir);

        if (models.length === 0) {
          return {
            content: [text("No semantic models found. Use `create_model` to create one from the substrate.")],
          };
        }

        const lines: string[] = [];
        lines.push(`## Semantic Models (${models.length})\n`);
        lines.push("| Name | Purpose | Tables | Files | Terms | Corrections |");
        lines.push("| --- | --- | --- | --- | --- | --- |");
        for (const m of models) {
          lines.push(
            `| ${m.name} | ${m.purpose} | ${m.tables.join(", ")} | ${m.malloy_file_count} | ${m.has_terms ? "✓" : "—"} | ${m.has_corrections ? "✓" : "—"} |`,
          );
        }

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[list_models] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── show_model ─────────────────────────────────────────────
  server.tool(
    "show_model",
    "Show detailed information about a specific semantic model, including its tables, files, and configuration.",
    {
      name: z.string().describe("Name of the model to show"),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));
        const detail = await showModel(semanticModelsDir, args.name);

        const lines: string[] = [];
        lines.push(`## Model: ${detail.name}\n`);
        lines.push(`**Purpose:** ${detail.purpose}`);
        lines.push(`**Directory:** \`${detail.dir}\``);
        lines.push(`**Substrate:** \`${detail.substrate_dir}\``);
        if (detail.connector_kind) {
          lines.push(`**Connector:** ${detail.connector_kind}`);
        }
        lines.push(`**Created:** ${detail.created_at}`);
        lines.push("");

        lines.push(`### Base Tables (${detail.tables.length})`);
        for (const t of detail.tables) {
          lines.push(`- ${t}`);
        }
        lines.push("");

        lines.push(`### Files (${detail.malloy_files.length})`);
        for (const f of detail.malloy_files) {
          const isBase = detail.tables.includes(f.replace(".malloy", ""));
          lines.push(`- \`${f}\`${isBase ? "" : " (imported dependency)"}`);
        }
        lines.push("");

        lines.push(`**Terms:** ${detail.has_terms ? "yes" : "none"}`);
        lines.push(`**Corrections:** ${detail.has_corrections ? "yes" : "none"}`);

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[show_model] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── delete_model ───────────────────────────────────────────
  server.tool(
    "delete_model",
    "Delete a named semantic model. This removes the model directory and all its contents (terms, corrections, session). The substrate is not affected.",
    {
      name: z.string().describe("Name of the model to delete"),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));
        const deleted = await deleteModel(semanticModelsDir, args.name);

        if (deleted) {
          return { content: [text(`Model "${args.name}" deleted successfully.`)] };
        } else {
          throw new McpError(
            ErrorCode.InvalidParams,
            `Model "${args.name}" not found. Use list_models to see available models.`,
          );
        }
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[delete_model] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── list_substrate_tables ──────────────────────────────────
  server.tool(
    "list_substrate_tables",
    "Start here to check what's available. Lists all tables in the substrate directory by reading inspection.json from disk — does not connect to the database. Use this before propose_model_plan to confirm a substrate exists, or to discover which tables can be included when creating a semantic model. If no substrate is found, the user should run introspection via CLI (`pnpm cli introspect`) first.",
    {
      substrate_dir: z.string().optional().describe("Path to substrate directory (default: ./substrate or $DEFAULT_SUBSTRATE_DIR)"),
    },
    async (args) => {
      try {
        const substrateDir = path.resolve(resolveSubstrateDir(args.substrate_dir));
        const tables = await listSubstrateTables(substrateDir);

        if (tables.length === 0) {
          return {
            content: [text(`No tables found in substrate at \`${substrateDir}\`. Run \`introspect_warehouse\` first.`)],
          };
        }

        const lines: string[] = [];
        lines.push(`## Substrate Tables (${tables.length})\n`);
        lines.push(`**Directory:** \`${substrateDir}\`\n`);
        for (const t of tables) {
          lines.push(`- ${t}`);
        }

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[list_substrate_tables] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
