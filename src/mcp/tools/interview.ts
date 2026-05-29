import fs from "node:fs/promises";
import { z } from "zod";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { proposeModelPlan, formatPlanMarkdown } from "../../interview/plan.js";
import { buildModelWithClarification } from "../../interview/build.js";
import { resolveSubstrateDir, resolveSemanticModelsDir } from "../../models/manifest.js";
import { text } from "../format.js";

export function register(server: McpServer): void {
  // ── propose_model_plan ────────────────────────────────────────
  server.tool(
    "propose_model_plan",
    "Start here to design a new semantic model. Reads the existing substrate from disk (inspection.json) — does not connect to the database. Analyzes the schema and proposes a model plan: which tables to include and what modeling decisions need to be made. Returns a structured plan with schema-grounded decisions for the user to resolve. This is step 1 of a two-step model design flow. After the user resolves the decisions, call build_semantic_model with the resolved choices.",
    {
      purpose: z.string().describe(
        "One-line description of what the model is for (e.g. 'Analyze bikeshare trip patterns and station utilization')",
      ),
      substrate_dir: z.string().optional().describe(
        "Path to substrate directory (default: ./substrate or $DEFAULT_SUBSTRATE_DIR). Must contain inspection.json from introspect_warehouse.",
      ),
    },
    async (args) => {
      try {
        const substrateDir = path.resolve(resolveSubstrateDir(args.substrate_dir));

        const plan = await proposeModelPlan(args.purpose, substrateDir);

        // Build structured response for the IDE agent
        const lines: string[] = [];
        lines.push(formatPlanMarkdown(plan));
        lines.push("");
        lines.push("---");
        lines.push("");
        lines.push("### Next Step");
        lines.push("");
        lines.push("Present these decisions to the user. Once they choose options (or accept the recommended defaults), call `build_semantic_model` with:");
        lines.push("- `name`: a short model name");
        lines.push("- `purpose`: the same purpose string");
        lines.push("- `decisions`: array of `{ decision_id, chosen }` objects");
        lines.push("- `relevant_tables`: the table list from this plan");
        lines.push("");

        // Also include machine-readable data for the IDE agent
        lines.push("### Plan Data (for build_semantic_model)\n");
        lines.push("```json");
        lines.push(JSON.stringify({
          relevant_tables: plan.relevant_tables,
          decisions: plan.decisions.map((d) => ({
            id: d.id,
            question: d.question,
            options: d.options.map((o) => ({
              label: o.label,
              recommended: o.recommended,
            })),
            allow_custom: d.allow_custom,
          })),
          substrate_dir: substrateDir,
        }, null, 2));
        lines.push("```");

        lines.push(`\n_LLM usage: ${plan.usage.inputTokens} input / ${plan.usage.outputTokens} output tokens_`);

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[propose_model_plan] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── build_semantic_model ──────────────────────────────────────
  server.tool(
    "build_semantic_model",
    "Build a validated semantic model from resolved decisions. This is step 2 of the model design flow — call propose_model_plan first to get the decisions. The LLM generates a model.malloy file, compiles it for validation (retrying once on failure), and assembles the full model directory.",
    {
      name: z.string().describe("Name for the model (becomes directory name, e.g. 'bikeshare')"),
      purpose: z.string().describe("One-line purpose description (same as used in propose_model_plan)"),
      decisions: z.array(z.object({
        decision_id: z.string().describe("Matches the id from the plan's decisions"),
        chosen: z.string().describe("The chosen option label, or free text if allow_custom was true"),
      })).describe("Resolved modeling decisions from the plan"),
      relevant_tables: z.array(z.object({
        name: z.string().describe("Table name"),
        reason: z.string().describe("Why this table is included"),
      })).describe("Tables to include (from propose_model_plan output)"),
      substrate_dir: z.string().optional().describe(
        "Path to substrate directory (default: ./substrate or $DEFAULT_SUBSTRATE_DIR)",
      ),
      semantic_models_dir: z.string().optional().describe(
        "Path to semantic-models directory (default: ./semantic-models or $DEFAULT_SEMANTIC_MODELS_DIR)",
      ),
      billing_project: z.string().optional().describe(
        "GCP billing project for Malloy compilation (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres substrates.",
      ),
      clarifications: z.array(z.object({
        question: z.string().describe("The clarification question that was asked"),
        answer: z.string().describe("The user's decision for that question"),
      })).optional().describe(
        "Answers to clarification questions surfaced by a previous build_semantic_model call. " +
        "When the build pauses with 'clarifications_needed', collect the user's answers and re-invoke with the SAME inputs plus these answers.",
      ),
    },
    async (args) => {
      try {
        const substrateDir = path.resolve(resolveSubstrateDir(args.substrate_dir));
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));
        const billingProject = args.billing_project ?? process.env.BQ_PROJECT_ID;

        // Detect connector kind from the substrate — only BigQuery needs billing_project
        let connectorKind: string | undefined;
        try {
          const raw = await fs.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
          connectorKind = JSON.parse(raw).connector_kind;
        } catch { /* will be caught by buildModelWithClarification */ }

        if (connectorKind !== "postgres" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery substrates (set via parameter or BQ_PROJECT_ID env var). " +
            "Postgres substrates do not need it.",
          );
        }

        // The build self-fixes its own bugs (type A) across internal rounds.
        // Genuine ambiguities (type B) are surfaced as clarifications_needed for
        // the user to answer and re-invoke with (MCP is single request/response).
        const result = await buildModelWithClarification({
          name: args.name,
          purpose: args.purpose,
          substrateDir,
          semanticModelsDir,
          billingProject,
          decisions: args.decisions,
          relevantTables: args.relevant_tables,
          clarifications: args.clarifications,
          surfaceQuestions: !(args.clarifications && args.clarifications.length > 0),
          maxClarifyRounds: 2,
        });

        // Build paused for genuine, user-only decisions — surface the batch.
        if (result.clarifications_needed && result.clarifications_needed.length > 0) {
          const lines: string[] = [];
          lines.push(`## Clarification Needed: ${args.name}\n`);
          lines.push(
            "The build fixed its own issues but needs decisions only you can make. " +
            "Answer these and call `build_semantic_model` again with the SAME inputs plus a `clarifications` array.\n",
          );
          result.clarifications_needed.forEach((q, i) => {
            lines.push(`### ${i + 1}. ${q.question}`);
            if (q.grounded_in) lines.push(`_From build diagnostic: ${q.grounded_in}_`);
            if (q.options.length) {
              lines.push("");
              for (const o of q.options) lines.push(`- ${o}`);
            }
            lines.push("");
          });
          lines.push("**Example re-invocation:**");
          lines.push("```json");
          lines.push(JSON.stringify({
            name: args.name,
            clarifications: result.clarifications_needed.map((q) => ({ question: q.question, answer: "<your choice>" })),
          }, null, 2));
          lines.push("```");
          lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);
          return { content: [text(lines.join("\n"))] };
        }

        if (!result.success) {
          const lines: string[] = [];
          lines.push(`## Model Build Failed\n`);
          lines.push(`**Error:** ${result.error}`);
          if (result.draft_malloy) {
            lines.push("\n**Draft Malloy (for debugging):**\n");
            lines.push("```malloy");
            lines.push(result.draft_malloy);
            lines.push("```");
          }
          lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);

          return { content: [text(lines.join("\n"))] };
        }

        const incomplete = result.incomplete === true;
        const hasDataWarnings = (result.data_warnings?.length ?? 0) > 0;
        const lines: string[] = [];
        lines.push(
          incomplete
            ? `## Model Built (INCOMPLETE): ${args.name}\n`
            : hasDataWarnings
              ? `## Model Built (data warnings): ${args.name}\n`
              : `## Model Created: ${args.name}\n`,
        );
        lines.push(`**Purpose:** ${args.purpose}`);
        lines.push(`**Directory:** \`${result.model_dir}\``);
        lines.push(`**Measures:** ${result.measures_count}`);
        lines.push(`**Dimensions:** ${result.dimensions_count}`);
        lines.push(`**Named filters:** ${result.named_filters_count}`);
        lines.push(`**Views:** ${result.views_count}`);
        lines.push("");
        lines.push("**model.malloy:**\n");
        lines.push("```malloy");
        lines.push(result.model_malloy!);
        lines.push("```");
        if (result.compile_warning) {
          lines.push("");
          lines.push(`> **Warning:** ${result.compile_warning}`);
        }

        // Data warnings — measures that compiled but return no data (caught
        // here, before the user hits them at query time).
        if (hasDataWarnings) {
          lines.push("");
          lines.push(`### Data warnings — measures that compiled but returned NO DATA (${result.data_warnings!.length})\n`);
          for (const w of result.data_warnings!) {
            lines.push(`- **${w.measure}** (${w.status}): ${w.detail}`);
          }
        }

        // Build contract not met — report honestly; this is NOT a clean success.
        if (incomplete) {
          if (result.failed_items?.length) {
            lines.push("");
            lines.push(`### Measures/dimensions that do NOT compile (${result.failed_items.length})\n`);
            for (const f of result.failed_items) {
              lines.push(`- **${f.kind} ${f.name}**: ${f.error}`);
            }
          }
          if (result.unmet_decisions?.length) {
            lines.push("");
            lines.push(`### Interview decisions not reflected (${result.unmet_decisions.length})\n`);
            for (const u of result.unmet_decisions) {
              lines.push(`- **${u.decision_id}** ("${u.chosen}"): ${u.expectation}`);
            }
          }
          lines.push("");
          lines.push(`> The model was saved but is **incomplete**. Refine it with \`refine_model\` (model_name: "${args.name}") or re-run the design before relying on it.`);
        } else {
          lines.push("");
          lines.push(`Use \`ask_question\` with \`model_name: "${args.name}"\` to query this model.`);
        }
        lines.push(`\n_LLM usage: ${result.usage.inputTokens} input / ${result.usage.outputTokens} output tokens_`);

        return { content: [text(lines.join("\n"))], isError: incomplete || hasDataWarnings };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[build_semantic_model] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
