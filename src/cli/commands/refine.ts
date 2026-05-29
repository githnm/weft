import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { refineModel, saveRefinement, revertLastRefinement } from "../../interview/refine.js";
import { resolveSemanticModelsDir } from "../../models/manifest.js";
import { formatDiffCli, computeModelDiff } from "../../interview/diff.js";

// ── model refine ────────────────────────────────────────────────

export interface ModelRefineOptions {
  name: string;
  refinement: string;
  semanticModelsDir?: string;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
  /** Skip confirmation prompt (for scripting) */
  yes?: boolean;
}

export async function runModelRefine(options: ModelRefineOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));

  console.log(`\n  Refining model "${options.name}"...`);
  console.log(`  Request: ${options.refinement}`);
  console.log("");

  const result = await refineModel({
    modelName: options.name,
    semanticModelsDir,
    refinement: options.refinement,
    billingProject: options.billingProject,
  });

  // Show classification
  console.log(`  Change type: ${result.classification.change_type}`);
  console.log(`  Target: ${result.classification.target}`);
  console.log(`  Feasible: ${result.classification.feasible}`);
  console.log(`  ${result.classification.reasoning}`);
  console.log("");

  if (!result.success) {
    console.error(`  ✗ ${result.error}`);
    if (result.draft_malloy) {
      console.error("\n  Draft Malloy (for debugging):\n");
      console.error(result.draft_malloy.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    console.error(`\n  (LLM usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out)\n`);
    process.exit(1);
  }

  // Already satisfied — model unchanged, no confirm prompt, no save
  if (result.new_malloy && result.old_malloy && result.new_malloy === result.old_malloy) {
    console.log("  No change needed — model already satisfies the request.");
    if (result.diff_summary) {
      console.log(`  ${result.diff_summary}`);
    }
    console.log(`\n  (LLM usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out)`);
    console.log("  Model unchanged.\n");
    return;
  }

  // Show diff
  console.log("  Changes:\n");
  const diff = computeModelDiff(result.old_malloy!, result.new_malloy!);
  console.log(formatDiffCli(diff));
  console.log("");
  console.log(`  (LLM usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out)`);

  if (result.compile_warning) {
    console.log(`\n  ⚠ ${result.compile_warning}`);
  }

  // Confirm
  let confirmed = false;
  if (options.yes) {
    confirmed = true;
  } else {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question("\n  Apply this change? [y/N]: ");
      confirmed = answer.trim().toLowerCase() === "y";
    } finally {
      rl.close();
    }
  }

  if (!confirmed) {
    console.log("\n  Discarded.\n");
    return;
  }

  // Save
  await saveRefinement({
    modelName: options.name,
    semanticModelsDir,
    newMalloy: result.new_malloy!,
    refinement: options.refinement,
    classification: result.classification,
  });

  console.log(`\n  ✓ Refinement applied to "${options.name}".`);
  console.log("  (model.malloy.bak saved for undo with 'model revert')");
  console.log("");
}

// ── model revert ────────────────────────────────────────────────

export interface ModelRevertOptions {
  name: string;
  semanticModelsDir?: string;
}

export async function runModelRevert(options: ModelRevertOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));

  const reverted = await revertLastRefinement({
    modelName: options.name,
    semanticModelsDir,
  });

  if (reverted) {
    console.log(`\n  ✓ Reverted last refinement on "${options.name}".`);
    console.log("  model.malloy restored from backup.\n");
  } else {
    console.error(`\n  No backup found for "${options.name}". Nothing to revert.\n`);
    process.exit(1);
  }
}
