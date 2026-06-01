#!/usr/bin/env npx tsx
/**
 * Deterministic test of the agent loop + the confirm-gate, with a FAKE LLM and
 * a FAKE tool runtime (no API key / DB). Verifies the honesty contract:
 *  - clarify (underspecified) instead of guessing
 *  - propose → PAUSE (no write) → confirm → apply (one write, exactly once)
 *  - what-if is a read (never writes)
 *  - reject leaves the model unchanged
 *  - multi-turn continuity
 */

import {
  runAgentTurn,
  resumeAgentAfterWrite,
  type ToolRuntime,
  type AgentLLM,
} from "../src/web/agent.js";
import type { ChangePreview } from "../src/web/model-change.js";
import type { AnthropicMessage } from "../src/llm/anthropic.js";

let failures = 0;
function check(name: string, cond: boolean, detail?: string) {
  console.log(`  ${cond ? "✓" : "✗"} ${name}${cond ? "" : ` — ${detail ?? ""}`}`);
  if (!cond) failures++;
}

// ── Fake LLM: a queue of scripted assistant turns ────────────────
const textTurn = (text: string): AnthropicMessage =>
  ({ content: [{ type: "text", text }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } } as unknown as AnthropicMessage);
const toolTurn = (id: string, name: string, input: unknown, text?: string): AnthropicMessage =>
  ({
    content: [...(text ? [{ type: "text", text }] : []), { type: "tool_use", id, name, input }],
    stop_reason: "tool_use",
    usage: { input_tokens: 1, output_tokens: 1 },
  } as unknown as AnthropicMessage);

function queueLLM(turns: AnthropicMessage[]): AgentLLM {
  let i = 0;
  return async () => turns[i++] ?? textTurn("(no more scripted turns)");
}

// ── Fake runtime ─────────────────────────────────────────────────
const applied: { description: string; newMalloy: string }[] = [];
const base = (over: Partial<ChangePreview>): ChangePreview => ({
  feasible: false, noChange: false, needsClarification: false, clarificationQuestion: null,
  isDefinition: false, route: "error", routeLabel: "Can't apply",
  conceptField: null, conceptName: null, changeType: null, target: null, reasoning: null,
  addedItems: [], changedItems: [], removedItems: [],
  diffSummary: null, compileWarning: null, oldMalloy: "", newMalloy: null, classification: null, error: null,
  ...over,
});

const runtime: ToolRuntime = {
  async inspectModel() {
    return JSON.stringify({ sources: [{ name: "users_data", columns: ["email: text", "first_name: text"] }], measures: [], dimensions: [], concepts: [] });
  },
  async runQuery() {
    return `rowCount=3; sample=[{"domain":"airbook.io"},{"domain":"gmail.com"}]`;
  },
  async simulateWhatif() {
    return JSON.stringify({ feasible: true, summary: "~12% fewer active users", affectedCount: 3, deltas: [] });
  },
  async previewChange(description: string) {
    // Underspecified: "internal" without HOW → clarification.
    if (/internal/i.test(description) && !/(airbook|name|domain|@)/i.test(description)) {
      return base({
        needsClarification: true,
        clarificationQuestion: "How should I identify internal accounts — by email domain (e.g. @airbook.io) or by names?",
        route: "clarify", routeLabel: "One detail needed",
      });
    }
    // Fully specified → feasible, confirmable.
    return base({
      feasible: true, isDefinition: true, route: "definition", routeLabel: "Define a concept",
      conceptField: "is_internal_account", conceptName: "internal_accounts",
      reasoning: "Adds a boolean segment matching internal emails/names.",
      addedItems: [{ kind: "dimension", name: "is_internal_account", expr: "email ~ '%@airbook.io'" }],
      newMalloy: "source: m is postgres.table('public.events') extend {\n  dimension: is_internal_account is email ~ '%@airbook.io'\n}",
      classification: { change_type: "add_dimension", target: "is_internal_account", feasible: true, reasoning: "ok" },
    });
  },
  async applyChange(p) {
    applied.push({ description: p.description, newMalloy: p.newMalloy });
    return { summary: "is_internal_account (aka customers, accounts)" };
  },
};

const ctx = { modelName: "m", semanticModelsDir: "/tmp/none", runtime };

// ── 1. Clarify: propose underspecified → agent asks, no write ────
console.log("\n1. Underspecified → clarify (no write):");
{
  const llm = queueLLM([
    toolTurn("t1", "propose_model_change", { description: "exclude internal accounts" }),
    textTurn("How should I identify internal accounts — by email domain (e.g. @airbook.io) or by names?"),
  ]);
  const r = await runAgentTurn({ ...ctx, llm, messages: [], userText: "active users should exclude internal accounts" });
  check("no pending proposal", r.pending === null);
  check("applyChange NOT called", applied.length === 0);
  check("agent asks how to identify internal", r.events.some((e) => e.kind === "text" && /how should i identify/i.test(e.text ?? "")));
}

// ── 2. Specified → propose PAUSES (no write) → confirm → apply ───
console.log("\n2. Propose pauses, confirm applies (exactly one write):");
let afterPropose;
{
  const llm = queueLLM([
    toolTurn("t2", "propose_model_change", { description: "internal = email @airbook.io and names X", is_definition: true }, "Here's the change I propose:"),
  ]);
  const r = await runAgentTurn({ ...ctx, llm, messages: [], userText: "internal = emails @airbook.io and names X" });
  check("pending proposal returned", r.pending !== null);
  check("pending shows the dimension", !!r.pending && r.pending.addedItems.some((i) => i.name === "is_internal_account"));
  check("model NOT written yet (no apply)", applied.length === 0);
  afterPropose = r;
}
{
  const llm = queueLLM([textTurn("Done — I've added the internal_accounts concept.")]);
  const p = afterPropose!.pending!;
  const r = await resumeAgentAfterWrite({
    ...ctx, llm, messages: afterPropose!.messages, toolUseId: p.toolUseId, decision: "confirm",
    apply: { description: p.description, newMalloy: p.newMalloy, classification: p.classification, isDefinition: p.isDefinition, canonicalName: p.canonicalName ?? undefined, aliases: p.aliases },
  });
  check("applyChange called exactly once", applied.length === 1, `got ${applied.length}`);
  check("applied flag true", r.applied === true);
  check("applied the previewed Malloy", applied[0]?.newMalloy.includes("is_internal_account"));
  check("agent confirms done", r.events.some((e) => e.kind === "text" && /added|done/i.test(e.text ?? "")));
}

// ── 3. What-if is a READ — never writes ──────────────────────────
console.log("\n3. What-if (read only, no write):");
{
  applied.length = 0;
  const llm = queueLLM([
    toolTurn("t3", "simulate_whatif", { change_text: "active requires 2 events" }),
    textTurn("It would reduce active users by ~12%, with no change to the model."),
  ]);
  const r = await runAgentTurn({ ...ctx, llm, messages: [], userText: "what would happen if I changed active to require 2 events?" });
  check("no pending proposal", r.pending === null);
  check("applyChange NOT called", applied.length === 0);
  check("reports the simulated impact", r.events.some((e) => e.kind === "text" && /12%/.test(e.text ?? "")));
  check("shows the read tool ran", r.events.some((e) => e.kind === "tool" && e.tool === "simulate_whatif"));
}

// ── 4. Reject leaves the model unchanged ─────────────────────────
console.log("\n4. Reject → no write:");
{
  applied.length = 0;
  const proposeLLM = queueLLM([toolTurn("t4", "propose_model_change", { description: "internal = @airbook.io" })]);
  const r1 = await runAgentTurn({ ...ctx, llm: proposeLLM, messages: [], userText: "define internal as @airbook.io" });
  const llm = queueLLM([textTurn("No problem — left it unchanged. What would you like instead?")]);
  const r2 = await resumeAgentAfterWrite({ ...ctx, llm, messages: r1.messages, toolUseId: r1.pending!.toolUseId, decision: "reject" });
  check("applyChange NOT called on reject", applied.length === 0);
  check("applied flag false", r2.applied === false);
}

// ── 5. Multi-turn: a follow-up reuses the conversation ───────────
console.log("\n5. Multi-turn follow-up:");
{
  applied.length = 0;
  // Round 1: confirm a change.
  const r1 = await runAgentTurn({ ...ctx, llm: queueLLM([toolTurn("a", "propose_model_change", { description: "internal = @airbook.io" })]), messages: [], userText: "define internal" });
  const r2 = await resumeAgentAfterWrite({ ...ctx, llm: queueLLM([textTurn("Added.")]), messages: r1.messages, toolUseId: r1.pending!.toolUseId, decision: "confirm", apply: { description: r1.pending!.description, newMalloy: r1.pending!.newMalloy, classification: r1.pending!.classification, isDefinition: true, aliases: [] } });
  // Round 2: follow-up on the SAME message history.
  const r3 = await runAgentTurn({ ...ctx, llm: queueLLM([toolTurn("b", "propose_model_change", { description: "add aliases customers, accounts", is_definition: true, aliases: ["customers", "accounts"] })]), messages: r2.messages, userText: "also add aliases customers, accounts" });
  check("history carried across turns (grows)", r3.messages.length > r2.messages.length);
  check("follow-up produces a new pending proposal", r3.pending !== null);
  check("follow-up still gated (not yet applied)", applied.length === 1, `applies so far: ${applied.length}`);
}

console.log("");
if (failures > 0) { console.error(`✗ ${failures} check(s) failed.`); process.exit(1); }
console.log("✓ All agent-loop checks passed.");
