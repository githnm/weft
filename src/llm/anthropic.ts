import Anthropic from "@anthropic-ai/sdk";

// ── pricing (USD per million tokens) ──────────────────────────────
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5-20250929": { input: 3, output: 15 },
  "claude-sonnet-4-20250514": { input: 3, output: 15 },
  "claude-haiku-3-5-20241022": { input: 0.8, output: 4 },
};
const DEFAULT_PRICING = { input: 3, output: 15 };

export interface LLMUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LLMResponse {
  text: string;
  usage: LLMUsage;
  model: string;
}

let _client: Anthropic | undefined;

function getClient(): Anthropic {
  if (!_client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error(
        "ANTHROPIC_API_KEY is not set.\n" +
          "Get an API key from https://console.anthropic.com/settings/keys\n" +
          "Then: export ANTHROPIC_API_KEY=sk-ant-..."
      );
    }
    _client = new Anthropic();
  }
  return _client;
}

export function getModel(): string {
  return process.env.CLAUDE_MODEL ?? "claude-sonnet-4-5-20250929";
}

export function estimateCost(usage: LLMUsage, model?: string): number {
  const p = PRICING[model ?? getModel()] ?? DEFAULT_PRICING;
  return (usage.inputTokens / 1_000_000) * p.input + (usage.outputTokens / 1_000_000) * p.output;
}

export function formatCost(dollars: number): string {
  return `$${dollars.toFixed(4)}`;
}

/**
 * Send a message to the Anthropic API and return the text response.
 * Throws on missing API key, empty response, or API errors.
 */
export async function chat(options: {
  system: string;
  userParts: string[];
  maxTokens?: number;
}): Promise<LLMResponse> {
  const client = getClient();
  const model = getModel();

  const message = await client.messages.create({
    model,
    max_tokens: options.maxTokens ?? 4096,
    system: options.system,
    messages: [
      {
        role: "user",
        content: options.userParts.map((text) => ({ type: "text" as const, text })),
      },
    ],
  });

  const textBlock = message.content.find((b) => b.type === "text");
  if (!textBlock || textBlock.type !== "text") {
    throw new Error("No text content in API response");
  }

  return {
    text: textBlock.text.trim(),
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
    },
    model,
  };
}

// ── Tool-use (agent) turn ─────────────────────────────────────────

export type AnthropicMessageParam = Anthropic.MessageParam;
export type AnthropicTool = Anthropic.Tool;
export type AnthropicMessage = Anthropic.Message;

/**
 * One tool-use turn: send the full conversation + tool definitions and return
 * the raw assistant Message (content blocks + stop_reason + usage). Parallel
 * tool use is DISABLED so each assistant turn has at most one tool_use — this
 * keeps the confirm-gate simple (we can pause cleanly on a single write tool).
 */
export async function createToolMessage(opts: {
  system: string;
  messages: Anthropic.MessageParam[];
  tools: Anthropic.Tool[];
  maxTokens?: number;
}): Promise<Anthropic.Message> {
  const client = getClient();
  const model = getModel();
  return client.messages.create({
    model,
    max_tokens: opts.maxTokens ?? 2048,
    system: opts.system,
    messages: opts.messages,
    tools: opts.tools,
    tool_choice: { type: "auto", disable_parallel_tool_use: true },
  });
}

/**
 * Strip markdown code fences the model sometimes wraps JSON in.
 */
export function stripCodeFences(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("```")) {
    s = s.replace(/^```(?:json|malloy)?\s*\n?/, "").replace(/\n?```\s*$/, "");
  }
  return s;
}
