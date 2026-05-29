import fs from "node:fs/promises";
import path from "node:path";
import { generateSuggestions } from "../../suggest/suggest.js";
import { validateSuggestions } from "../../suggest/validate.js";
import type { SuggestOptions, SuggestResult, Suggestion } from "../../suggest/types.js";

function formatSuggestionsMd(result: SuggestResult): string {
  const { response, model } = result;
  const lines: string[] = [];

  const passing = response.suggestions.filter((s) => s.validation?.status === "pass");
  const failing = response.suggestions.filter((s) => s.validation?.status !== "pass");
  const sorted = [...passing, ...failing];

  lines.push("# Metric Suggestions");
  lines.push("");
  lines.push(`**Inferred domain:** ${response.domain}`);
  lines.push(`**Generated:** ${new Date().toISOString()}`);
  lines.push(`**Model:** ${model}`);
  lines.push("");

  lines.push("## Validation summary");
  lines.push("");
  lines.push(`- Total: ${response.suggestions.length}`);
  lines.push(`- Compiling: ${passing.length}`);
  lines.push(`- Failing: ${failing.length}`);
  lines.push("");
  lines.push("Compiling suggestions are copy-paste safe. Failing ones may");
  lines.push("still be useful as starting points after manual fixing.");
  lines.push("");

  lines.push("## How to use");
  lines.push("");
  lines.push("Each suggestion is independent. Copy any block into the target");
  lines.push("`.malloy` file, inside the `source: ... extend { }` block. Run");
  lines.push("`pnpm cli verify` after editing to confirm it compiles.");
  lines.push("");
  lines.push("---");

  for (const s of sorted) {
    lines.push("");
    lines.push(`## ${s.title} (confidence: ${s.confidence})`);
    lines.push("");

    if (s.validation?.status === "pass") {
      lines.push("**Status:** ✓ Compiles");
    } else {
      lines.push("**Status:** ✗ Does not compile");
      if (s.validation?.error) {
        lines.push("");
        lines.push("**Error:**");
        lines.push("```");
        lines.push(s.validation.error);
        lines.push("```");
      }
    }
    lines.push("");

    lines.push(`**Target:** \`${s.target_source}\``);
    lines.push("");
    lines.push(s.reasoning);
    lines.push("");
    lines.push("```malloy");
    lines.push(s.malloy_code);
    lines.push("```");
    lines.push("");
    lines.push("---");
  }

  return lines.join("\n");
}

export async function runSuggest(options: SuggestOptions & { billingProject: string }): Promise<void> {
  const inspectionPath = path.join(options.modelsDir, "inspection.json");

  let inspectionRaw: string;
  try {
    inspectionRaw = await fs.readFile(inspectionPath, "utf-8");
  } catch {
    throw new Error(
      `inspection.json not found at ${inspectionPath}\n` +
        "Run 'pnpm cli introspect' first to generate it."
    );
  }

  // Compact the JSON to save tokens
  const inspectionParsed = JSON.parse(inspectionRaw);
  const connectorKind = inspectionParsed.connector_kind;
  const inspectionCompact = JSON.stringify(inspectionParsed);

  const entries = await fs.readdir(options.modelsDir);
  const malloyFileNames = entries.filter((f) => f.endsWith(".malloy")).sort();

  if (malloyFileNames.length === 0) {
    throw new Error(
      `No .malloy files found in ${options.modelsDir}\n` +
        "Run 'pnpm cli generate' first."
    );
  }

  const malloyFiles = new Map<string, string>();
  for (const name of malloyFileNames) {
    const content = await fs.readFile(path.join(options.modelsDir, name), "utf-8");
    malloyFiles.set(name, content);
  }

  console.log(`\n  Reading ${malloyFileNames.length} .malloy files + inspection.json...`);
  console.log(`  Requesting up to ${options.maxSuggestions} suggestions...\n`);

  const result = await generateSuggestions(inspectionCompact, malloyFiles, options.maxSuggestions);

  // Validate each suggestion by compiling against the Malloy runtime
  console.log(`\n  Validating ${result.response.suggestions.length} suggestions...\n`);
  await validateSuggestions(
    result.response.suggestions,
    malloyFiles,
    options.modelsDir,
    options.billingProject,
    connectorKind,
  );

  const md = formatSuggestionsMd(result);
  const outPath = path.join(options.modelsDir, "suggestions.md");
  await fs.writeFile(outPath, md, "utf-8");
  console.log(`\n  Wrote ${outPath}`);

  const inputCost = (result.inputTokens / 1_000_000) * 3;
  const outputCost = (result.outputTokens / 1_000_000) * 15;
  const totalCost = inputCost + outputCost;

  const passing = result.response.suggestions.filter((s) => s.validation?.status === "pass");
  const failing = result.response.suggestions.filter((s) => s.validation?.status !== "pass");

  console.log("");
  console.log(`  Domain:            ${result.response.domain}`);
  console.log(`  Suggestions:       ${result.response.suggestions.length}`);
  console.log(`  Compiling:         ${passing.length} / ${result.response.suggestions.length}`);
  console.log(`  Failing:           ${failing.length} / ${result.response.suggestions.length}`);
  if (failing.length > 0) {
    for (const s of failing) {
      console.log(`    - ${s.title}`);
    }
  }
  console.log(`  Tokens (in/out):   ${result.inputTokens.toLocaleString()} / ${result.outputTokens.toLocaleString()}`);
  console.log(`  Estimated cost:    $${totalCost.toFixed(4)}`);
  console.log("");
}
