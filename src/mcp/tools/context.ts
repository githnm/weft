import path from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { queryTraces, readTraces, type DecisionType, type OutcomeStatus, type Trace } from "../../context/trace.js";
import { simulateChange } from "../../context/simulate.js";
import { renderContextGraphHtml } from "../../context/graph-html.js";
import { resolveSemanticModelsDir, resolveModelDir } from "../../models/manifest.js";
import { resolveModelsDir, resolveBillingProject, detectConnectorKind } from "../config.js";
import { text } from "../format.js";
import { sendProgress } from "../progress.js";

const DECISION_TYPES = [
  "ask",
  "term_define",
  "correction",
  "model_design",
  "model_refine",
  "feasibility_refusal",
] as const;

const OUTCOME_STATUSES = [
  "pending",
  "verified",
  "accepted",
  "rejected",
  "reversed",
  "failed",
] as const;

/** Resolve the trace-store directory for a model (or the substrate). */
function resolveTraceDir(args: { model_name?: string; semantic_models_dir?: string; models_dir?: string }): string {
  if (args.model_name) {
    const semanticModelsDir = resolveSemanticModelsDir(args.semantic_models_dir);
    return path.resolve(resolveModelDir(semanticModelsDir, args.model_name));
  }
  return path.resolve(resolveModelsDir(args.models_dir));
}

function fmtNum(n: number | null): string {
  return n === null || n === undefined ? "—" : n.toLocaleString();
}

function renderTrace(t: Trace): string {
  const lines: string[] = [];
  lines.push(`### ${t.decision_type} · \`${t.outcome.status}\` · ${t.timestamp}`);
  lines.push(`- **id:** \`${t.id}\``);
  lines.push(`- **observation:** ${t.observation}`);
  if (t.reasoning) lines.push(`- **reasoning:** ${t.reasoning}`);
  if (t.outcome.detail) lines.push(`- **outcome:** ${t.outcome.detail}`);
  if (t.outcome.result_summary) {
    lines.push(`- **result:** \`${JSON.stringify(t.outcome.result_summary)}\``);
  }
  if (t.links.length > 0) lines.push(`- **links:** ${t.links.map((l) => `\`${l}\``).join(", ")}`);
  return lines.join("\n");
}

export function register(server: McpServer): void {
  // ── get_decision_history ──────────────────────────────────────
  server.tool(
    "get_decision_history",
    "Read the engine's decision trace — the 'event clock' of every decision (asks, corrections, term definitions, model design/refinement, feasibility refusals), with the reasoning, outcome, and links between them. Use to understand WHY past answers were given, what was corrected, and how decisions relate. Filter by decision type, outcome status, referenced entity (table/term/measure), or time. Read-only.",
    {
      model_name: z.string().optional().describe("Semantic model whose history to read. Omit to read substrate-level history."),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models). Used with model_name."),
      models_dir: z.string().optional().describe("Path to models/substrate directory (default: ./models). Used when model_name is omitted."),
      decision_type: z.enum(DECISION_TYPES).optional().describe("Filter to one decision type"),
      status: z.enum(OUTCOME_STATUSES).optional().describe("Filter to one outcome status"),
      entity: z.string().optional().describe("Substring match against observation/reasoning/action (e.g. a term, measure, or table name)"),
      limit: z.number().optional().describe("Keep only the most recent N (default 50)"),
    },
    async (args) => {
      try {
        const dir = resolveTraceDir(args);
        const traces = await queryTraces(dir, {
          decision_type: args.decision_type as DecisionType | undefined,
          status: args.status as OutcomeStatus | undefined,
          entity: args.entity,
          limit: args.limit ?? 50,
        });

        if (traces.length === 0) {
          return {
            content: [text(
              `## Decision History\n\nNo traces found${args.model_name ? ` for model "${args.model_name}"` : ""}` +
              `${args.decision_type ? ` of type ${args.decision_type}` : ""}` +
              `${args.entity ? ` referencing "${args.entity}"` : ""}.`,
            )],
          };
        }

        // Most recent first for readability.
        const ordered = [...traces].reverse();
        const header = `## Decision History${args.model_name ? `: ${args.model_name}` : " (substrate)"}\n\n_${traces.length} trace(s), most recent first._`;
        const body = ordered.map(renderTrace).join("\n\n");
        return { content: [text(`${header}\n\n${body}`)] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[get_decision_history] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── simulate_change ───────────────────────────────────────────
  server.tool(
    "simulate_change",
    "Simulate a proposed change to a semantic model across its WHOLE ask history and report the REAL recomputed impact — which past answers change (old → new), and which questions become unanswerable. Re-runs each affected historical query against a candidate model; numbers are recomputed, not estimated. Use for 'what if' questions like 'what if active_users required at least 2 events?' or 'what if I drop the workspaces join?'. Does NOT modify the model.",
    {
      model_name: z.string().describe("Name of the semantic model to simulate against"),
      proposed_change: z.string().describe("The change in plain English (e.g. 'active_users should require at least 2 events', 'drop the workspaces join')"),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models)"),
      billing_project: z.string().optional().describe("GCP billing project (BigQuery only, default: $BQ_PROJECT_ID). Not needed for Postgres models."),
      location: z.string().default("US").describe("BigQuery dataset region"),
    },
    async (args) => {
      try {
        const semanticModelsDir = path.resolve(resolveSemanticModelsDir(args.semantic_models_dir));
        const modelDir = resolveModelDir(semanticModelsDir, args.model_name);
        const connectorKind = await detectConnectorKind(modelDir);
        const billingProject = resolveBillingProject(args.billing_project);
        if (connectorKind === "bigquery" && !billingProject) {
          throw new McpError(
            ErrorCode.InvalidParams,
            "billing_project is required for BigQuery models. Provide it as a tool input or set the BQ_PROJECT_ID environment variable.",
          );
        }

        await sendProgress("Building candidate model and replaying history...");

        const report = await simulateChange({
          modelName: args.model_name,
          semanticModelsDir,
          proposedChange: args.proposed_change,
          billingProject,
          location: args.location,
        });

        const lines: string[] = [];
        lines.push(`## What if: "${args.proposed_change}"\n`);
        lines.push(`**Model:** ${report.modelName}`);
        lines.push("");

        if (report.error && !report.feasible) {
          lines.push(`**Cannot simulate:** ${report.summary}`);
          if (report.error !== report.summary) lines.push(`\n> ${report.error}`);
          if (report.suggestion) {
            lines.push("\n### Next step\n");
            lines.push(report.suggestion);
          }
          lines.push(`\n_LLM usage: ${report.usage.inputTokens} in / ${report.usage.outputTokens} out_`);
          return { content: [text(lines.join("\n"))] };
        }

        if (report.changedEntities.length > 0) {
          lines.push("### Changes to the model\n");
          for (const e of report.changedEntities) {
            const sign = e.action === "added" ? "+" : e.action === "removed" ? "−" : "~";
            lines.push(`- ${sign} ${e.type}: \`${e.name}\``);
          }
          lines.push("");
        }

        lines.push(`**${report.summary}**`);
        lines.push("");

        const changed = report.deltas.filter((d) => d.status === "changed");
        if (changed.length > 0) {
          lines.push("### Answers that change\n");
          lines.push("| Question | Metric | Before | After | Δ% | Rows |");
          lines.push("| --- | --- | ---: | ---: | ---: | --- |");
          for (const d of changed) {
            const q = d.question.length > 50 ? d.question.slice(0, 47) + "..." : d.question;
            const pct = d.deltaPct === null ? "—" : `${d.deltaPct >= 0 ? "+" : ""}${d.deltaPct.toFixed(2)}%`;
            lines.push(`| ${q} | ${d.metric ?? "—"} | ${fmtNum(d.before)} | ${fmtNum(d.after)} | ${pct} | ${fmtNum(d.rowsBefore)} → ${fmtNum(d.rowsAfter)} |`);
          }
          lines.push("");
        }

        if (report.unanswerable.length > 0) {
          lines.push("### Questions that become unanswerable\n");
          for (const u of report.unanswerable) {
            lines.push(`- ✗ ${u.question}`);
            lines.push(`  _${u.reason}_`);
          }
          lines.push("");
        }

        if (report.netSummary) {
          lines.push(`> ${report.netSummary}`);
          lines.push("");
        }

        lines.push(`_LLM usage: ${report.usage.inputTokens} in / ${report.usage.outputTokens} out_`);
        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[simulate_change] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── render_context_graph ──────────────────────────────────────
  server.tool(
    "render_context_graph",
    "Render a model's decision trace history as a self-contained interactive HTML graph (force-directed; nodes colored by decision type, bordered by outcome, with edges showing which decisions influenced which). Returns the full HTML — save it to a .html file and open it in a browser. Read-only.",
    {
      model_name: z.string().describe("Name of the semantic model whose traces to visualize"),
      semantic_models_dir: z.string().optional().describe("Path to semantic-models directory (default: ./semantic-models)"),
    },
    async (args) => {
      try {
        const semanticModelsDir = resolveSemanticModelsDir(args.semantic_models_dir);
        const modelDir = path.resolve(resolveModelDir(semanticModelsDir, args.model_name));
        const traces = await readTraces(modelDir);
        const html = renderContextGraphHtml(args.model_name, traces);
        return { content: [text(html)] };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[render_context_graph] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
