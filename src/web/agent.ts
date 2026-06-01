/**
 * Conversational model-building agent (server side).
 *
 * An MCP-style tool loop: an LLM with the engine's tools, conversation history,
 * and a system prompt enforcing the product's honesty —
 *   (a) GROUND before proposing (read tools first),
 *   (b) PROPOSE-then-CONFIRM before any write (never mutate autonomously),
 *   (c) REFUSE / ASK rather than fabricate.
 *
 * READ tools execute freely. The single WRITE tool (propose_model_change) does
 * NOT mutate: it computes a preview and PAUSES the loop, returning a confirmable
 * proposal. The model is only written when the user confirms (resumeAgentAfterWrite
 * → applyChange). Parallel tool use is disabled, so each turn has ≤1 tool call
 * and the pause is clean.
 *
 * The LLM call and the engine tool-runtime are both injectable, so the gating is
 * unit-testable without a live API key / database.
 */

import fs from "node:fs/promises";
import path from "node:path";
import {
  createToolMessage,
  type AnthropicMessageParam,
  type AnthropicMessage,
  type AnthropicTool,
  type LLMUsage,
} from "../llm/anthropic.js";
import { showModel } from "../models/registry.js";
import { parseModelItems } from "../interview/compile.js";
import { resolveModelDir } from "../models/manifest.js";
import { ask } from "../agent/ask.js";
import { simulateChange } from "../context/simulate.js";
import { previewChange, applyChange, type ChangePreview, type DiffAdded, type DiffChanged } from "./model-change.js";
import type { RefinementClassification } from "../interview/types.js";

// ── System prompt (the honesty contract) ─────────────────────────

const SYSTEM_PROMPT = `You are Weft's model-building assistant. You help the user evolve a semantic data model by conversing in plain language and calling tools. Be calm, concise, and concrete.

You have READ tools (use freely to ground yourself) and ONE WRITE tool (gated behind user confirmation):

READ (no confirmation needed):
- inspect_model: see the model's sources + columns, measures, dimensions, and baked concept definitions. ALWAYS ground a change in real fields before proposing.
- run_query: run a read-only question to check data or look at sample values (e.g. distinct email domains). Never changes the model.
- simulate_whatif: simulate the impact of a hypothetical change over history WITHOUT changing the model. Use this to answer "what would happen if ...". Do NOT propose a change for a what-if question — just report.

WRITE (ALWAYS requires explicit user confirmation):
- propose_model_change: propose a concrete change (define a concept, add/modify a measure or dimension, a correction). This does NOT apply the change. It shows the exact Malloy to the user, who must Confirm or Reject. You then receive a tool result telling you the outcome: APPLIED, REJECTED, NEEDS CLARIFICATION, or NOT FEASIBLE.

HARD RULES:
- NEVER claim the model was changed unless a propose_model_change tool result says the user CONFIRMED and it was applied. There are no silent edits.
- Before proposing, make sure the change is fully specified and grounded in real columns. If a request is underspecified (e.g. "exclude internal accounts" without saying HOW — by email domain? by names?), ASK a clarifying question first; do not guess. If the tool result says NEEDS CLARIFICATION, relay that question to the user.
- Do NOT fabricate fields, values, or capabilities. If something can't be grounded in the model's actual schema, say so.
- For a "what if" / "would it" question, use simulate_whatif and report — do not propose a write.
- Keep replies short. When you propose a change, a clear proposal card is shown to the user automatically; you don't need to repaste the Malloy.`;

// ── Tool definitions ─────────────────────────────────────────────

const TOOLS: AnthropicTool[] = [
  {
    name: "inspect_model",
    description:
      "Read the current model: sources and their columns, measures, dimensions, and baked concept definitions (with aliases). Ground proposals in real fields before proposing.",
    input_schema: { type: "object", properties: {}, required: [] },
  },
  {
    name: "run_query",
    description:
      "Run a read-only analytical question against the model to check data or look at sample values (e.g. 'distinct email domains'). Returns rows. Does NOT change the model.",
    input_schema: {
      type: "object",
      properties: { question: { type: "string", description: "a plain-language question" } },
      required: ["question"],
    },
  },
  {
    name: "simulate_whatif",
    description:
      "Simulate the impact of a hypothetical change over decision history WITHOUT changing the model. Use for 'what would happen if ...' questions.",
    input_schema: {
      type: "object",
      properties: { change_text: { type: "string", description: "the hypothetical change" } },
      required: ["change_text"],
    },
  },
  {
    name: "propose_model_change",
    description:
      "Propose a concrete change (define a concept, add/modify a measure or dimension, a correction). Does NOT apply: the exact change is shown to the user for Confirm/Reject. You receive a result saying APPLIED, REJECTED, NEEDS CLARIFICATION, or NOT FEASIBLE.",
    input_schema: {
      type: "object",
      properties: {
        description: {
          type: "string",
          description: "the change in plain language, FULLY specified (include the criteria, e.g. which email domains count as internal)",
        },
        is_definition: { type: "boolean", description: "true when defining a named business concept/segment" },
        canonical_name: { type: "string", description: "optional canonical name for the concept" },
        aliases: {
          type: "array",
          items: { type: "string" },
          description: "other words for the concept — ONLY ones the user explicitly approved; never invent synonyms",
        },
      },
      required: ["description"],
    },
  },
];

// ── Tool runtime (engine wiring; injectable for tests) ───────────

export interface ToolRuntime {
  inspectModel(): Promise<string>;
  runQuery(question: string): Promise<string>;
  simulateWhatif(changeText: string): Promise<string>;
  previewChange(description: string): Promise<ChangePreview>;
  applyChange(p: {
    description: string;
    newMalloy: string;
    classification: RefinementClassification;
    isDefinition: boolean;
    canonicalName?: string;
    aliases?: string[];
  }): Promise<{ summary: string }>;
}

export function makeDefaultRuntime(ctx: {
  modelName: string;
  semanticModelsDir: string;
  billingProject?: string;
}): ToolRuntime {
  const { modelName, semanticModelsDir, billingProject } = ctx;
  const modelDir = path.resolve(resolveModelDir(semanticModelsDir, modelName));

  return {
    async inspectModel() {
      const detail = await showModel(semanticModelsDir, modelName);
      const malloy = await fs.readFile(path.join(detail.dir, "model.malloy"), "utf-8").catch(() => "");
      const items = parseModelItems(malloy);
      let sources: { name: string; columns: string[] }[] = [];
      try {
        const insp = JSON.parse(
          await fs.readFile(path.resolve(detail.dir, detail.manifest.substrate_dir, "inspection.json"), "utf-8"),
        );
        const want = new Set(detail.manifest.base_tables.map((t: string) => t.toLowerCase()));
        sources = insp.tables
          .filter((t: { name: string }) => want.has(t.name.toLowerCase()))
          .map((t: { name: string; columns: { name: string; type: string }[] }) => ({
            name: t.name,
            columns: t.columns.map((c) => `${c.name}: ${c.type}`),
          }));
      } catch {
        /* substrate not readable */
      }
      return JSON.stringify({
        name: detail.name,
        purpose: detail.purpose,
        connector: detail.connector_kind ?? null,
        measures: items.filter((i) => i.kind === "measure").map((i) => ({ name: i.name, expr: i.expr })),
        dimensions: items.filter((i) => i.kind === "dimension").map((i) => ({ name: i.name, expr: i.expr })),
        concepts: (detail.manifest.concepts ?? []).map((c) => ({
          name: c.canonical_name, aliases: c.aliases, field: c.field, expr: c.filter ?? null,
        })),
        sources,
      });
    },

    async runQuery(question: string) {
      const r = await ask({ question, modelsDir: modelDir, billingProject });
      if (r.feasibility && !r.feasibility.feasible) {
        return `Refused (not feasible): ${r.feasibility.reasoning ?? ""}${
          r.feasibility.missingConcepts?.length ? ` Missing: ${r.feasibility.missingConcepts.join(", ")}` : ""
        }`;
      }
      const rows = r.execution?.rows ?? [];
      return `rowCount=${r.execution?.totalRows ?? rows.length}; sample=${JSON.stringify(rows.slice(0, 8))}`;
    },

    async simulateWhatif(changeText: string) {
      const report = await simulateChange({ modelName, semanticModelsDir, proposedChange: changeText, billingProject });
      return JSON.stringify({
        feasible: report.feasible,
        summary: report.summary,
        netSummary: report.netSummary ?? null,
        affectedCount: report.affectedCount,
        deltas: (report.deltas ?? []).slice(0, 6),
      });
    },

    previewChange(description: string) {
      return previewChange({ modelName, semanticModelsDir, billingProject, text: description });
    },

    applyChange(p) {
      return applyChange({
        modelName, semanticModelsDir,
        text: p.description, newMalloy: p.newMalloy, classification: p.classification,
        isDefinition: p.isDefinition, canonicalName: p.canonicalName, aliases: p.aliases,
      });
    },
  };
}

// ── LLM injection ────────────────────────────────────────────────

export type AgentLLM = (opts: {
  system: string;
  messages: AnthropicMessageParam[];
  tools: AnthropicTool[];
}) => Promise<AnthropicMessage>;

const defaultLLM: AgentLLM = (o) => createToolMessage({ ...o, maxTokens: 2048 });

// ── Public result types ──────────────────────────────────────────

export interface AgentEvent {
  kind: "text" | "tool";
  /** assistant prose (kind=text) */
  text?: string;
  /** read/write tool name (kind=tool) */
  tool?: string;
  /** brief human summary of a tool call, shown quietly in the transcript */
  detail?: string;
}

/** A paused, confirmable write. The client renders this as a proposal card and
 *  echoes it back to /confirm; the model is untouched until then. */
export interface AgentPending {
  toolUseId: string;
  description: string;
  isDefinition: boolean;
  canonicalName: string | null;
  aliases: string[];
  route: string;
  routeLabel: string;
  reasoning: string | null;
  addedItems: DiffAdded[];
  changedItems: DiffChanged[];
  removedItems: { kind: string; name: string }[];
  conceptField: string | null;
  conceptName: string | null;
  newMalloy: string;
  classification: RefinementClassification;
}

export interface AgentResult {
  /** Opaque Anthropic message history — echo back unchanged on the next turn. */
  messages: AnthropicMessageParam[];
  events: AgentEvent[];
  pending: AgentPending | null;
  applied?: boolean;
  usage: LLMUsage;
}

// ── Loop ─────────────────────────────────────────────────────────

const MAX_STEPS = 8;

function toolResultMsg(toolUseId: string, content: string): AnthropicMessageParam {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: toolUseId, content }] };
}

function addUsage(a: LLMUsage, m: AnthropicMessage): LLMUsage {
  return {
    inputTokens: a.inputTokens + (m.usage?.input_tokens ?? 0),
    outputTokens: a.outputTokens + (m.usage?.output_tokens ?? 0),
  };
}

async function drive(messages: AnthropicMessageParam[], runtime: ToolRuntime, llm: AgentLLM): Promise<AgentResult> {
  const events: AgentEvent[] = [];
  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  for (let step = 0; step < MAX_STEPS; step++) {
    const resp = await llm({ system: SYSTEM_PROMPT, messages, tools: TOOLS });
    usage = addUsage(usage, resp);

    for (const b of resp.content) {
      if (b.type === "text" && b.text.trim()) events.push({ kind: "text", text: b.text.trim() });
    }
    // Record the assistant turn verbatim (so tool_use ids resolve later).
    messages.push({ role: "assistant", content: resp.content as unknown as AnthropicMessageParam["content"] });

    const tu = resp.content.find((b) => b.type === "tool_use");
    if (!tu || tu.type !== "tool_use" || resp.stop_reason !== "tool_use") {
      return { messages, events, pending: null, usage };
    }
    const input = (tu.input ?? {}) as Record<string, unknown>;

    if (tu.name === "propose_model_change") {
      const description = String(input.description ?? "").trim();
      const preview = await runtime.previewChange(description);

      // Only a feasible, compiled change is confirmable → PAUSE here. The
      // model is NOT written; we return the proposal for the user to confirm.
      if (preview.feasible && !preview.noChange && preview.newMalloy && preview.classification) {
        events.push({ kind: "tool", tool: "propose_model_change", detail: "proposed a change for your confirmation" });
        const pending: AgentPending = {
          toolUseId: tu.id,
          description,
          isDefinition: Boolean(input.is_definition) || preview.isDefinition,
          canonicalName: (input.canonical_name as string | undefined) ?? preview.conceptName ?? null,
          aliases: Array.isArray(input.aliases) ? (input.aliases as string[]).map(String) : [],
          route: preview.route,
          routeLabel: preview.routeLabel,
          reasoning: preview.reasoning,
          addedItems: preview.addedItems,
          changedItems: preview.changedItems,
          removedItems: preview.removedItems,
          conceptField: preview.conceptField,
          conceptName: preview.conceptName,
          newMalloy: preview.newMalloy,
          classification: preview.classification,
        };
        return { messages, events, pending, usage };
      }

      // Not confirmable — feed the reason back so the agent asks / refuses.
      const result = preview.needsClarification
        ? `NEEDS CLARIFICATION. Ask the user this and do NOT propose until answered: ${preview.clarificationQuestion}`
        : preview.noChange
          ? `NOT NEEDED — the model already satisfies this: ${preview.reasoning ?? ""}`
          : `NOT FEASIBLE: ${preview.error ?? preview.reasoning ?? "no relevant field"}. Tell the user honestly; do not fabricate.`;
      messages.push(toolResultMsg(tu.id, result));
      continue;
    }

    // READ tools — execute freely, feed result back, continue.
    let result: string;
    try {
      if (tu.name === "inspect_model") {
        result = await runtime.inspectModel();
        events.push({ kind: "tool", tool: "inspect_model", detail: "checked the model's fields" });
      } else if (tu.name === "run_query") {
        const q = String(input.question ?? "");
        result = await runtime.runQuery(q);
        events.push({ kind: "tool", tool: "run_query", detail: `ran a query: “${q}”` });
      } else if (tu.name === "simulate_whatif") {
        const c = String(input.change_text ?? "");
        result = await runtime.simulateWhatif(c);
        events.push({ kind: "tool", tool: "simulate_whatif", detail: `simulated: “${c}”` });
      } else {
        result = `Unknown tool: ${tu.name}`;
      }
    } catch (err) {
      result = `Tool ${tu.name} failed: ${err instanceof Error ? err.message : String(err)}`;
    }
    messages.push(toolResultMsg(tu.id, result));
  }

  events.push({ kind: "text", text: "(I’ve taken several steps without resolving this — could you rephrase?)" });
  return { messages, events, pending: null, usage };
}

// ── Entry points ─────────────────────────────────────────────────

export interface AgentContext {
  modelName: string;
  semanticModelsDir: string;
  billingProject?: string;
  runtime?: ToolRuntime;
  llm?: AgentLLM;
}

/** A user message → run the loop until a final reply or a confirmable proposal. */
export async function runAgentTurn(
  ctx: AgentContext & { messages: AnthropicMessageParam[]; userText: string },
): Promise<AgentResult> {
  const runtime = ctx.runtime ?? makeDefaultRuntime(ctx);
  const llm = ctx.llm ?? defaultLLM;
  const messages: AnthropicMessageParam[] = [...ctx.messages, { role: "user", content: ctx.userText }];
  return drive(messages, runtime, llm);
}

/** Resume after the user confirms/rejects a proposal. ONLY here is a write
 *  executed (on confirm). On reject the model is left untouched. */
export async function resumeAgentAfterWrite(
  ctx: AgentContext & {
    messages: AnthropicMessageParam[];
    toolUseId: string;
    decision: "confirm" | "reject";
    apply?: {
      description: string;
      newMalloy: string;
      classification: RefinementClassification;
      isDefinition: boolean;
      canonicalName?: string;
      aliases?: string[];
    };
  },
): Promise<AgentResult> {
  const runtime = ctx.runtime ?? makeDefaultRuntime(ctx);
  const llm = ctx.llm ?? defaultLLM;

  let resultText: string;
  let applied = false;
  if (ctx.decision === "confirm" && ctx.apply) {
    const r = await runtime.applyChange({
      description: ctx.apply.description,
      newMalloy: ctx.apply.newMalloy,
      classification: ctx.apply.classification,
      isDefinition: ctx.apply.isDefinition,
      canonicalName: ctx.apply.canonicalName,
      aliases: ctx.apply.aliases,
    });
    applied = true;
    resultText = `User CONFIRMED. Applied to the model: ${r.summary}. The change is now live.`;
  } else {
    resultText = "User REJECTED the proposal. The model was NOT changed. Acknowledge briefly and ask what they'd like instead.";
  }

  const messages: AnthropicMessageParam[] = [...ctx.messages, toolResultMsg(ctx.toolUseId, resultText)];
  const out = await drive(messages, runtime, llm);
  return { ...out, applied };
}
