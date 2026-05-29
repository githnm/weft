import { parseAggregateNames, runStructuralChecks } from "./verify-structural.js";
import { checkSemantic } from "./verify-semantic.js";
import type { VerificationResult } from "./types.js";
import type { LLMUsage } from "../llm/anthropic.js";

export interface VerifyOptions {
  question: string;
  malloy: string;
  rows: Record<string, unknown>[];
  totalRows: number;
  /** Skip layer 2 (LLM semantic check) */
  skipLlmVerify?: boolean;
}

/**
 * Run both verification layers on a query result.
 *
 * Layer 1: deterministic structural checks (free, always runs).
 * Layer 2: LLM semantic check (~$0.005, optional).
 */
export async function verifyResult(options: VerifyOptions): Promise<VerificationResult> {
  const { question, malloy, rows, totalRows, skipLlmVerify } = options;

  // Parse aggregate column names from the Malloy query
  const aggregateColumns = parseAggregateNames(malloy);

  // ── Layer 1: structural checks ────────────────────────────────
  const structuralChecks = runStructuralChecks(rows, totalRows, aggregateColumns);

  let usage: LLMUsage = { inputTokens: 0, outputTokens: 0 };

  // ── Layer 2: semantic check ───────────────────────────────────
  let semantic;
  if (!skipLlmVerify) {
    semantic = await checkSemantic({
      question,
      malloy,
      rows,
      totalRows,
      aggregateColumns,
    });
    usage = semantic.usage;
  }

  return {
    structuralChecks,
    semantic,
    usage,
  };
}
