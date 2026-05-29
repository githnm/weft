import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { proposeModelPlan, formatPlanMarkdown } from "../../interview/plan.js";
import { buildModelWithClarification } from "../../interview/build.js";
import { resolveSubstrateDir, resolveSemanticModelsDir } from "../../models/manifest.js";
import type { Decision, ResolvedDecision, ClarifyQuestion, ClarifyAnswer } from "../../interview/types.js";

// ── model design ────────────────────────────────────────────────

export interface ModelDesignOptions {
  name: string;
  purpose: string;
  substrateDir?: string;
  semanticModelsDir?: string;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
  /** Accept all recommended defaults without prompting */
  acceptDefaults?: boolean;
}

export async function runModelDesign(options: ModelDesignOptions): Promise<void> {
  const substrateDir = path.resolve(resolveSubstrateDir(options.substrateDir));
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));

  console.log(`\n  Designing model "${options.name}"...`);
  console.log(`  Purpose: ${options.purpose}`);
  console.log(`  Substrate: ${substrateDir}`);
  console.log("");

  // ── Step 1: Propose plan ──
  console.log("  Step 1/2: Analyzing schema and proposing model plan...\n");

  const plan = await proposeModelPlan(options.purpose, substrateDir);

  console.log(formatPlanMarkdown(plan));
  console.log(`  (LLM usage: ${plan.usage.inputTokens} in / ${plan.usage.outputTokens} out)\n`);

  // ── Step 2: Resolve decisions ──
  let resolvedDecisions: ResolvedDecision[];

  if (options.acceptDefaults) {
    // Auto-resolve all decisions to the recommended option
    resolvedDecisions = plan.decisions.map((d) => {
      const recommended = d.options.find((o) => o.recommended) ?? d.options[0];
      return { decision_id: d.id, chosen: recommended.label };
    });
    console.log("  Using recommended defaults for all decisions.\n");
  } else {
    // Interactive resolution
    resolvedDecisions = await promptDecisions(plan.decisions);
    console.log("");
  }

  // Show resolved decisions
  console.log("  Resolved decisions:");
  for (const rd of resolvedDecisions) {
    console.log(`    ${rd.decision_id}: ${rd.chosen}`);
  }
  console.log("");

  // ── Step 3: Build model ──
  console.log("  Step 2/2: Building semantic model...\n");

  const result = await buildModelWithClarification({
    name: options.name,
    purpose: options.purpose,
    substrateDir,
    semanticModelsDir,
    billingProject: options.billingProject,
    decisions: resolvedDecisions,
    relevantTables: plan.relevant_tables,
    // The build self-fixes its own bugs (type A). For genuine ambiguities
    // (type B) it asks the user — unless --accept-defaults, where we let it
    // finalize with its best attempt rather than block on a prompt.
    askUser: options.acceptDefaults ? undefined : promptClarifications,
    maxClarifyRounds: 2,
  });

  if (!result.success) {
    console.error(`\n  ✗ Model build failed: ${result.error}`);
    if (result.draft_malloy) {
      console.error("\n  Draft Malloy (for debugging):\n");
      console.error(result.draft_malloy.split("\n").map((l) => `    ${l}`).join("\n"));
    }
    console.error(`\n  (LLM usage: ${result.usage.inputTokens} in / ${result.usage.outputTokens} out)\n`);
    process.exit(1);
  }

  const incomplete = result.incomplete === true;
  const hasDataWarnings = (result.data_warnings?.length ?? 0) > 0;
  const marker = incomplete ? "⚠ INCOMPLETE —" : hasDataWarnings ? "⚠ BUILT (data warnings) —" : "✓";
  console.log(`  ${marker} Model "${options.name}" written to ${result.model_dir}`);
  console.log(`    Measures:      ${result.measures_count}`);
  console.log(`    Dimensions:    ${result.dimensions_count}`);
  console.log(`    Named filters: ${result.named_filters_count}`);
  console.log(`    Views:         ${result.views_count}`);
  console.log(`    LLM usage:     ${result.usage.inputTokens} in / ${result.usage.outputTokens} out`);
  if (result.compile_warning) {
    console.log("");
    console.log(`  ⚠ ${result.compile_warning}`);
  }

  // Data warnings — measures that compiled but produce no data (caught before
  // the user hits them at query time).
  if (hasDataWarnings) {
    console.log("");
    console.log(`  Data warnings — measures that compiled but returned NO DATA (${result.data_warnings!.length}):`);
    for (const w of result.data_warnings!) {
      console.log(`    - ${w.measure}: ${w.detail}`);
    }
  }

  // Build contract not met — report honestly; do NOT present a clean success.
  if (incomplete) {
    if (result.failed_items?.length) {
      console.log("");
      console.log(`  Measures/dimensions that do NOT compile (${result.failed_items.length}):`);
      for (const f of result.failed_items) {
        console.log(`    - ${f.kind} ${f.name}: ${f.error}`);
      }
    }
    if (result.unmet_decisions?.length) {
      console.log("");
      console.log(`  Interview decisions not reflected in the model (${result.unmet_decisions.length}):`);
      for (const u of result.unmet_decisions) {
        console.log(`    - ${u.decision_id} ("${u.chosen}"): ${u.expectation}`);
      }
    }
    console.log("");
    console.log("  The model was saved but is INCOMPLETE. Refine it (pnpm cli model refine ...) or re-run design.");
    console.log("");
    process.exit(1);
  }

  console.log("");
  console.log("  Next steps:");
  console.log(`    - Ask questions: pnpm cli ask "..." --model ${options.name}`);
  console.log(`    - View model:    pnpm cli model show ${options.name}`);
  console.log("");
}

// ── Interactive clarification prompting (type-B build ambiguities) ──

async function promptClarifications(questions: ClarifyQuestion[]): Promise<ClarifyAnswer[]> {
  const rl = readline.createInterface({ input, output });
  const answers: ClarifyAnswer[] = [];
  try {
    console.log("");
    console.log(`  The build needs ${questions.length} decision(s) only you can make:`);
    console.log("");
    for (let i = 0; i < questions.length; i++) {
      const q = questions[i];
      console.log(`  Question ${i + 1}/${questions.length}: ${q.question}`);
      if (q.grounded_in) console.log(`  (from: ${q.grounded_in})`);
      q.options.forEach((o, j) => console.log(`    ${j + 1}. ${o}`));
      console.log("");
      const raw = (await rl.question("  Your choice (number or free text): ")).trim();
      const idx = Number.parseInt(raw, 10);
      const answer =
        Number.isInteger(idx) && idx >= 1 && idx <= q.options.length ? q.options[idx - 1] : raw;
      answers.push({ question: q.question, answer: answer || "(no preference — use your best judgment)" });
      console.log("");
    }
  } finally {
    rl.close();
  }
  return answers;
}

// ── Interactive decision prompting ──────────────────────────────

async function promptDecisions(decisions: Decision[]): Promise<ResolvedDecision[]> {
  const rl = readline.createInterface({ input, output });
  const resolved: ResolvedDecision[] = [];

  try {
    for (let i = 0; i < decisions.length; i++) {
      const d = decisions[i];
      console.log(`  Decision ${i + 1}/${decisions.length}: ${d.question}`);
      console.log(`  ${d.why_it_matters}\n`);

      for (let j = 0; j < d.options.length; j++) {
        const o = d.options[j];
        const rec = o.recommended ? " (recommended)" : "";
        console.log(`    ${j + 1}. ${o.label}${rec} — ${o.detail}`);
      }
      if (d.allow_custom) {
        console.log(`    ${d.options.length + 1}. Custom (type your own answer)`);
      }

      const defaultIdx = d.options.findIndex((o) => o.recommended);
      const defaultLabel = defaultIdx >= 0 ? ` [${defaultIdx + 1}]` : "";

      const answer = await rl.question(`\n  Choose${defaultLabel}: `);
      const trimmed = answer.trim();

      if (trimmed === "" && defaultIdx >= 0) {
        // Accept recommended
        resolved.push({ decision_id: d.id, chosen: d.options[defaultIdx].label });
      } else {
        const num = parseInt(trimmed, 10);
        if (!isNaN(num) && num >= 1 && num <= d.options.length) {
          resolved.push({ decision_id: d.id, chosen: d.options[num - 1].label });
        } else if (d.allow_custom && (!isNaN(num) && num === d.options.length + 1)) {
          const custom = await rl.question("  Custom answer: ");
          resolved.push({ decision_id: d.id, chosen: custom.trim() });
        } else if (d.allow_custom && trimmed.length > 0) {
          // Treat free text as custom answer
          resolved.push({ decision_id: d.id, chosen: trimmed });
        } else if (defaultIdx >= 0) {
          // Invalid input — fall back to recommended
          console.log(`  → Using recommended: ${d.options[defaultIdx].label}`);
          resolved.push({ decision_id: d.id, chosen: d.options[defaultIdx].label });
        } else {
          // No recommended, pick first option
          console.log(`  → Using first option: ${d.options[0].label}`);
          resolved.push({ decision_id: d.id, chosen: d.options[0].label });
        }
      }

      console.log("");
    }
  } finally {
    rl.close();
  }

  return resolved;
}
