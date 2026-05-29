import { ask, QueryError, type AskOptions } from "../../agent/ask.js";
import { estimateCost, formatCost } from "../../llm/anthropic.js";
import { runCorrect } from "./correct.js";

const BQ_COST_PER_TB = 6.25; // on-demand pricing USD

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function printTable(rows: Record<string, unknown>[] | undefined): void {
  if (!rows || rows.length === 0) {
    console.log("    (no rows)");
    return;
  }

  // Gather all column names
  const columns = Object.keys(rows[0]);

  // Compute column widths (min: header length, max: 40)
  const widths = new Map<string, number>();
  for (const col of columns) {
    widths.set(col, col.length);
  }
  for (const row of rows) {
    for (const col of columns) {
      const val = formatCell(row[col]);
      widths.set(col, Math.min(40, Math.max(widths.get(col)!, val.length)));
    }
  }

  // Header
  const header = columns.map((col) => col.padEnd(widths.get(col)!)).join("  ");
  const separator = columns.map((col) => "─".repeat(widths.get(col)!)).join("──");
  console.log(`    ${header}`);
  console.log(`    ${separator}`);

  // Rows
  for (const row of rows) {
    const line = columns
      .map((col) => {
        const val = formatCell(row[col]);
        const w = widths.get(col)!;
        // Right-align numbers
        if (typeof row[col] === "number" || typeof row[col] === "bigint") {
          return val.padStart(w);
        }
        return val.length > w ? val.slice(0, w - 1) + "…" : val.padEnd(w);
      })
      .join("  ");
    console.log(`    ${line}`);
  }
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (value instanceof Date) return value.toISOString().replace("T", " ").replace(/\.000Z$/, "");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export async function runAsk(options: AskOptions & { strict?: boolean; verbose?: boolean }): Promise<void> {
  console.log(`\n  Question: ${options.question}`);
  console.log("");

  let result;
  try {
    result = await ask(options);
  } catch (err: unknown) {
    if (err instanceof QueryError) {
      console.error(`\n  Error: ${err.message}`);
      console.error("");
      console.error("  Final Malloy attempted:");
      for (const line of err.malloy.split("\n")) {
        console.error(`    ${line}`);
      }
      console.error("");
      console.error("  Suggestions:");
      console.error("    - Try rephrasing the question");
      console.error("    - Use --source to specify a different source");
      console.error("    - Check if the dataset supports the requested operation");
      console.error("    - Use --show-malloy to inspect what the agent generated");
      console.error("");
      process.exit(1);
    }
    // Re-throw non-QueryError exceptions; the outer catch in index.ts handles them
    throw err;
  }

  // ── Inline correction detected ──────────────────────────────
  if (result.correctionDetected) {
    const cd = result.correctionDetected;
    console.log(`  Detected correction (${cd.type}, confidence: ${cd.confidence})`);
    console.log(`  Reasoning: ${cd.reasoning}`);
    console.log("");

    // Delegate to the correction flow
    await runCorrect({
      correctionText: options.question,
      modelsDir: options.modelsDir,
      billingProject: options.billingProject,
      source: result.source?.filename,
    });

    // Show LLM cost for the classification
    const llmCost = estimateCost(result.totalUsage);
    console.log(
      `  Tokens (in/out): ${result.totalUsage.inputTokens.toLocaleString()} / ${result.totalUsage.outputTokens.toLocaleString()}`,
    );
    console.log(`  LLM cost: ${formatCost(llmCost)}`);
    console.log("");
    return;
  }

  // ── Follow-up context ───────────────────────────────────────
  if (result.followUp && result.previousQuestion) {
    if (result.followUp.isFollowUp) {
      console.log(`  ↳ Follow-up to: "${result.previousQuestion}"`);
    } else {
      console.log(`  ↳ Previous question: "${result.previousQuestion}" (treated as new question)`);
    }
    console.log("");
  }

  // ── Source ──────────────────────────────────────────────────
  const sourceNote = result.followUp?.isFollowUp && result.followUp.inherit.source
    ? " (inherited from previous question)"
    : "";
  console.log(`  Source: ${result.source.sourceName} (${result.source.filename})${sourceNote}`);
  console.log(`  Reasoning: ${result.source.reasoning}`);
  console.log("");

  // ── Not feasible ───────────────────────────────────────────
  if (result.feasibility && !result.feasibility.feasible) {
    console.log("  Cannot answer this question with the current model.");
    console.log("");
    console.log(`  Reason: ${result.feasibility.reasoning}`);
    console.log("");
    if ((result.feasibility.missingConcepts ?? []).length > 0) {
      console.log("  Missing concepts:");
      for (const concept of result.feasibility.missingConcepts!) {
        console.log(`    - ${concept}`);
      }
      console.log("");
    }

    // Data-level issues from metadata
    const di = result.feasibility.dataIssues;
    if (di) {
      console.log("  Data issues:");
      if (di.timeOutOfRange) {
        console.log(`    ⏰ Time range mismatch: requested "${di.timeOutOfRange.requested}" but data covers ${di.timeOutOfRange.available}`);
      }
      if (di.unknownFilterValue) {
        const truncNote = di.unknownFilterValue.enumWasTruncated
          ? " (only top values captured — value may exist in long tail)"
          : "";
        console.log(`    🔍 Unknown value: "${di.unknownFilterValue.userTerm}" not found in ${di.unknownFilterValue.column}${truncNote}`);
        console.log(`       Did you mean one of: ${di.unknownFilterValue.knownValues.slice(0, 10).join(", ")}?`);
      }
      if (di.staleData) {
        console.log(`    📅 Stale data: latest data is from ${di.staleData.latest} (${di.staleData.daysOld} days ago)`);
      }
      console.log("");
    }

    console.log("  Suggestions:");
    if (di?.timeOutOfRange) {
      console.log("    - Try asking about a date range within the available data");
    }
    if (di?.unknownFilterValue) {
      console.log(`    - Use one of the known values for ${di.unknownFilterValue.column}`);
    }
    if (di?.staleData) {
      console.log("    - Re-run introspection to refresh the data, or rephrase without time references");
    }
    if (!di) {
      console.log("    - Check if the data is in a different dataset you haven't introspected");
      console.log("    - Check if the concept needs to be defined as a derived measure");
    }
    console.log("    - Rephrase the question to use available data");
    console.log("");
    console.log("  No query was executed. No BQ cost incurred.");

    // Still show LLM cost (source selection + feasibility check used tokens)
    const llmCost = estimateCost(result.totalUsage);
    console.log(
      `  Tokens (in/out): ${result.totalUsage.inputTokens.toLocaleString()} / ${result.totalUsage.outputTokens.toLocaleString()}`,
    );
    console.log(`  LLM cost: ${formatCost(llmCost)}`);
    console.log("");
    return;
  }

  // ── Plan ───────────────────────────────────────────────────
  console.log(`  Plan: ${result.query!.explanation}`);
  if (result.query!.wasRetried) {
    console.log(`  (query was fixed after an error on first attempt)`);
  }
  console.log("");

  // ── Malloy ─────────────────────────────────────────────────
  if (options.showMalloy || options.dryRun) {
    console.log("  Malloy:");
    for (const line of result.query!.malloy.split("\n")) {
      console.log(`    ${line}`);
    }
    console.log("");
  }

  // ── Results ────────────────────────────────────────────────
  if (options.dryRun) {
    console.log("  ✓ Compiled successfully (dry run — not executed)");
    console.log("");
  } else if (result.execution) {
    console.log("  Results:");
    printTable(result.execution.rows);
    console.log("");
    console.log(`  Rows: ${result.execution.totalRows}`);

    if (result.execution.bytesScanned !== undefined) {
      const bqCost = (result.execution.bytesScanned / (1024 ** 4)) * BQ_COST_PER_TB;
      console.log(`  Bytes scanned: ${formatBytes(result.execution.bytesScanned)}`);
      console.log(`  BQ cost: ${formatCost(bqCost)}`);
    }
    console.log("");
  }

  // ── Verification ────────────────────────────────────────────
  let strictFail = false;

  if (result.verification) {
    const structuralChecks = result.verification.structuralChecks ?? [];
    const semantic = result.verification.semantic;
    const caveats = semantic?.caveats ?? [];

    const warnings = structuralChecks.filter((c) => c.severity === "warning");
    const infos = structuralChecks.filter((c) => c.severity === "info");
    const hasIssues =
      warnings.length > 0 ||
      (semantic && semantic.matchesIntent !== "yes") ||
      caveats.length > 0;

    if (!hasIssues && (!semantic || semantic.matchesIntent === "yes")) {
      // Clean result — minimal one-liner
      console.log("  Verification: ✓ Results match the question. No issues detected.");
    } else {
      console.log("  Verification:");

      // Structural
      if (warnings.length === 0 && infos.length === 0) {
        console.log("    Structural: OK");
      } else {
        for (const check of warnings) {
          console.log(`    ⚠ ${check.message}`);
        }
        for (const check of infos) {
          console.log(`    ℹ ${check.message}`);
        }
      }

      // Semantic
      if (semantic) {
        console.log(
          `    Intent match: ${semantic.matchesIntent} (confidence: ${semantic.confidence})`,
        );
        console.log(`    Reasoning: ${semantic.reasoning}`);

        if (caveats.length > 0) {
          console.log("");
          console.log("    Caveats:");
          for (const caveat of caveats) {
            console.log(`      - ${caveat}`);
          }
        }
      }
    }
    console.log("");

    // Strict mode: exit code 1 if intent is "no" or any warning
    if (options.strict) {
      if (warnings.length > 0) strictFail = true;
      if (semantic && semantic.matchesIntent === "no") strictFail = true;
    }
  }

  // ── Proposed terms ──────────────────────────────────────
  if (result.proposedTerms && result.proposedTerms.length > 0) {
    for (const p of result.proposedTerms) {
      console.log(`  💡 Auto-proposed term: "${p.userTerm}" → ${p.filter}`);
      console.log(`     Confirm: pnpm cli define ${p.key} --confirm --models ${options.modelsDir}`);
    }
    console.log("");
  }

  // ── Cost summary ───────────────────────────────────────────
  const llmCost = estimateCost(result.totalUsage);
  const bqCost =
    result.execution?.bytesScanned !== undefined
      ? (result.execution.bytesScanned / (1024 ** 4)) * BQ_COST_PER_TB
      : 0;
  const totalCost = llmCost + bqCost;

  console.log(
    `  Tokens (in/out): ${result.totalUsage.inputTokens.toLocaleString()} / ${result.totalUsage.outputTokens.toLocaleString()}`,
  );
  console.log(`  LLM cost: ${formatCost(llmCost)}`);
  if (bqCost > 0) {
    console.log(`  Total cost: ${formatCost(totalCost)} (LLM + BQ)`);
  }
  console.log("");

  if (strictFail) {
    process.exit(1);
  }
}
