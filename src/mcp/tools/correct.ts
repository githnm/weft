import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { loadSession } from "../../session/store.js";
import { classifyCorrection } from "../../correct/classify.js";
import { prepareTermUpdate, applyTermUpdate } from "../../correct/term-update.js";
import { prepareModelSuggestion, logModelSuggestion } from "../../correct/model-suggest.js";
import { resolveModelsDir, resolveBillingProject, detectConnectorKind } from "../config.js";
import { text } from "../format.js";
import { sendProgress } from "../progress.js";

export function register(server: McpServer): void {
  server.tool(
    "correct_answer",
    "Apply a user correction to the most recent query result. Updates terms.json for filter corrections, or surfaces a suggested .malloy edit for model-level corrections. Shows before/after with numeric impact. Use this when the user says an answer is wrong, should exclude/include something, or expresses disagreement with the agent's interpretation. Requires a prior ask_question to correct against.",
    {
      correction_text: z.string().describe("The correction (e.g. 'students should exclude trips under 2 min')"),
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
      source: z.string().optional().describe("Target source file (auto-detected from session if omitted)"),
      no_impact: z.boolean().default(false).describe("Skip numeric impact calculation (faster)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const connectorKind = await detectConnectorKind(modelsDir);
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind === "bigquery" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it as a tool input or set the BQ_PROJECT_ID environment variable.",
          );
        }

        const session = await loadSession(modelsDir);
        if (!session) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "No active session. Use ask_question first, then correct_answer to fix the result.",
          );
        }

        await sendProgress("Classifying correction...");

        const classification = await classifyCorrection(
          args.correction_text,
          modelsDir,
          session,
        );

        if (classification.confidence === "low" || classification.type === "unclear") {
          return {
            content: [
              text(
                "## Could not classify correction\n\n" +
                  "The correction is unclear. Try:\n" +
                  '- Being specific about which term to update: "students should also..."\n' +
                  "- Using `define_term` to create a new term\n" +
                  "- Specifying the source file for model edits",
              ),
            ],
          };
        }

        // ── Term update ──────────────────────────────────────
        if (classification.type === "term_update") {
          const termName = classification.target.termName;
          if (!termName) {
            return {
              content: [
                text(
                  `Could not determine which term to update.\n\n**Reasoning:** ${classification.reasoning}`,
                ),
              ],
            };
          }

          await sendProgress(`Preparing term update for "${termName}"...`);

          const result = await prepareTermUpdate({
            termName,
            correctionText: args.correction_text,
            proposedNewFilter: classification.proposedChange.new,
            modelsDir,
            billingProject,
            session,
            skipImpact: args.no_impact,
          });

          // Apply the change
          await applyTermUpdate({
            result,
            correctionText: args.correction_text,
            modelsDir,
            session,
            reasoning: classification.reasoning,
          });

          const lines: string[] = [];
          lines.push(`## Term Updated: "${result.termName}"\n`);
          lines.push("| | Filter |");
          lines.push("| --- | --- |");
          lines.push(`| **Before** | \`${result.oldFilter}\` |`);
          lines.push(`| **After** | \`${result.newFilter}\` |`);
          lines.push("");

          if (result.impact) {
            const ni = result.impact;
            lines.push("### Numeric Impact\n");

            if (ni.mode === "scalar_aggregate") {
              lines.push("| Aggregate | Before | After | Change |");
              lines.push("| --- | ---: | ---: | ---: |");
              for (const agg of ni.aggregates) {
                const delta = agg.after - agg.before;
                const change = delta === 0
                  ? "no change"
                  : `${delta >= 0 ? "+" : ""}${delta.toLocaleString()} (${agg.deltaPct >= 0 ? "+" : ""}${agg.deltaPct.toFixed(2)}%)`;
                lines.push(
                  `| ${agg.column} | ${agg.before.toLocaleString()} | ${agg.after.toLocaleString()} | ${change} |`,
                );
              }
            } else {
              const rowDelta = ni.rowsAfter - ni.rowsBefore;
              const rowChange = rowDelta === 0
                ? "no change"
                : `${rowDelta >= 0 ? "+" : ""}${rowDelta.toLocaleString()} (${ni.rowsDeltaPct >= 0 ? "+" : ""}${ni.rowsDeltaPct.toFixed(2)}%)`;
              lines.push(`**Rows:** ${ni.rowsBefore.toLocaleString()} → ${ni.rowsAfter.toLocaleString()} (${rowChange})`);

              for (const agg of ni.aggregates) {
                const delta = agg.after - agg.before;
                const change = delta === 0
                  ? "no change"
                  : `${delta >= 0 ? "+" : ""}${delta.toLocaleString()} (${agg.deltaPct >= 0 ? "+" : ""}${agg.deltaPct.toFixed(2)}%)`;
                lines.push(
                  `**Sum of ${agg.column}:** ${agg.before.toLocaleString()} → ${agg.after.toLocaleString()} (${change})`,
                );
              }
            }

            // Zero-impact warning
            const rowsSame = ni.rowsBefore === ni.rowsAfter;
            const allAggsSame = ni.aggregates.every((a) => a.before === a.after);
            if (rowsSame && allAggsSame) {
              lines.push("");
              lines.push(
                "> ⚠ **Zero impact.** The correction excludes zero rows from the result. " +
                  "Either the filter doesn't match any data, or the data doesn't contain values your filter excludes.",
              );
              if (ni.noImpactExplanation) {
                lines.push(`>\n> ${ni.noImpactExplanation}`);
              }
            }
            lines.push("");
          }

          lines.push(`✓ Term updated in terms.json`);
          lines.push(`✓ Correction logged (ID: \`${result.correctionId}\`)`);
          lines.push("");
          lines.push(`_Rollback: \`rollback_correction("${result.correctionId}")\`_`);

          return { content: [text(lines.join("\n"))] };
        }

        // ── Model suggestion ─────────────────────────────────
        if (classification.type === "model_suggestion") {
          const targetFile =
            classification.target.file ?? args.source ?? session.last_source;
          if (!targetFile) {
            throw new McpError(
              ErrorCode.InvalidParams,
              "Could not determine which .malloy file to edit. Specify the source parameter.",
            );
          }

          await sendProgress(`Generating model edit suggestion for ${targetFile}...`);

          const result = await prepareModelSuggestion({
            correctionText: args.correction_text,
            targetFile,
            modelsDir,
            billingProject,
            session,
          });

          await logModelSuggestion({
            result,
            correctionText: args.correction_text,
            modelsDir,
            session,
            reasoning: classification.reasoning,
          });

          const lines: string[] = [];
          lines.push(`## Model Edit Suggestion\n`);
          lines.push(`**File:** \`${result.targetFile}\``);
          lines.push(`**Compile check:** ${result.compileOk ? "✓ passes" : "⚠ may not compile"}`);
          lines.push("");
          lines.push("**Find this line:**");
          lines.push("```malloy");
          lines.push(result.findLine);
          lines.push("```");
          lines.push("");
          lines.push("**Replace with:**");
          lines.push("```malloy");
          lines.push(result.replaceLine);
          lines.push("```");
          lines.push("");
          lines.push("**After editing:**");
          lines.push("1. Save the file");
          lines.push("2. Run `verify_models` to confirm it compiles");
          lines.push("");
          lines.push(`✓ Suggestion logged (ID: \`${result.correctionId}\`)`);

          return { content: [text(lines.join("\n"))] };
        }

        // ── New term ─────────────────────────────────────────
        if (classification.type === "new_term") {
          const name = classification.target.newTermName ?? "my_term";
          return {
            content: [
              text(
                `This looks like a new term definition.\n\n` +
                  `Use \`define_term("${name}", description="${args.correction_text}")\` to create it.`,
              ),
            ],
          };
        }

        return {
          content: [
            text(`Unhandled correction type: ${classification.type}`),
          ],
          isError: true,
        };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[correct_answer] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
