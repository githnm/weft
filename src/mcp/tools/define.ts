import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { confirmTerm, defineTermManually, saveManualTerm, resolveSourceFilename } from "../../terms/define.js";
import { bakeDefinition } from "../../interview/definitions.js";
import { resolveModelsDir, resolveBillingProject, detectConnectorKind } from "../config.js";
import { resolveSemanticModelsDir, resolveModelDir } from "../../models/manifest.js";
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
      model_name: z.string().optional().describe("Named semantic model to attach the term to (e.g. 'product_usage'). Use this whenever the user is working with a semantic model — terms MUST be saved in the model's own directory so ask_question(model_name) can apply them."),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models). Used with model_name."),
      models_dir: z.string().optional().describe("Path to models/substrate directory (default: ./models or $DEFAULT_MODELS_DIR). Ignored when model_name is set."),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
    },
    async (args) => {
      try {
        // Resolve the target dir the SAME way ask_question does: a named
        // semantic model writes to its own dir (where ask reads terms from);
        // otherwise the substrate/models dir. (Bug fix: terms defined for a
        // semantic model previously landed in ./models and never applied.)
        const modelsDir = args.model_name
          ? path.resolve(resolveModelDir(resolveSemanticModelsDir(args.semantic_models_dir), args.model_name))
          : resolveModelsDir(args.models_dir);
        const connectorKind = await detectConnectorKind(modelsDir);
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind === "bigquery" && !billingProject) {
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

        // Resolve source file — prefer the semantic model's model.malloy.
        let sourceFilename = args.source;
        if (!sourceFilename) {
          sourceFilename = (await resolveSourceFilename(modelsDir)) ?? undefined;
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

  // ── add_definition ────────────────────────────────────────────
  // Bake a business concept (with EXPLICIT aliases) into model.malloy as a
  // reusable dimension/measure, recorded in the manifest — so a question that
  // uses the concept or any alias auto-applies it. Prefer this over define_term
  // for semantic models (define_term writes terms.json; this bakes into the model).
  server.tool(
    "add_definition",
    "Add a business definition to a semantic model, baked into model.malloy with EXPLICIT aliases. The concept becomes a reusable dimension/measure so any question using the concept name OR a listed alias applies the same filter. CRITICAL: only include aliases the user explicitly confirmed — never invent or guess synonyms (a wrong alias is a silent wrong answer). You MAY suggest likely aliases to the user, but pass only the ones they approve.",
    {
      model_name: z.string().describe("Name of the semantic model"),
      definition: z.string().describe("The concept in plain English (e.g. 'external_users = exclude internal accounts and test workspaces')"),
      aliases: z.array(z.string()).optional().describe("Other words for the SAME concept — explicit, user-confirmed only (e.g. ['users','customers','accounts']). Do NOT include unconfirmed guesses."),
      canonical_name: z.string().optional().describe("Optional canonical name for the concept; otherwise derived from the baked field."),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models)"),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres."),
    },
    async (args) => {
      try {
        const semanticModelsDir = resolveSemanticModelsDir(args.semantic_models_dir);
        const modelDir = path.resolve(resolveModelDir(semanticModelsDir, args.model_name));
        const connectorKind = await detectConnectorKind(modelDir);
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind === "bigquery" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it or set BQ_PROJECT_ID.",
          );
        }

        const result = await bakeDefinition({
          modelName: args.model_name,
          semanticModelsDir: path.resolve(semanticModelsDir),
          definition: args.definition,
          aliases: args.aliases ?? [],
          canonicalName: args.canonical_name,
          billingProject,
        });

        if (result.applied && result.concept) {
          const c = result.concept;
          const akas = c.aliases.length ? ` (aka ${c.aliases.join(", ")})` : "";
          return {
            content: [
              text(
                `Definition baked into the model: **${c.canonical_name}**${akas}\n\n` +
                  `- **Field:** \`${c.field}\` (${c.kind})\n` +
                  (c.filter ? `- **Expression:** \`${c.filter}\`\n` : "") +
                  `\nIt's in model.malloy (not terms.json) — questions using the concept or any listed alias now apply it automatically.`,
              ),
            ],
          };
        }
        return {
          content: [
            text(
              result.noChange
                ? `No change needed — the model already satisfies this.\n\n${result.reason ?? ""}`
                : `Definition not applied.\n\n${result.reason ?? result.error ?? ""}`,
            ),
          ],
          isError: !result.noChange,
        };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[add_definition] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
