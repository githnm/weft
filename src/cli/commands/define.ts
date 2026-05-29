import fs from "node:fs/promises";
import path from "node:path";
import { confirmTerm, defineTermManually, saveManualTerm } from "../../terms/define.js";
import { extractSourceSummary } from "../../agent/catalog.js";

/**
 * CLI: pnpm cli define <term> --confirm --models <dir>
 *
 * Confirms an auto-proposed term from proposed-terms.json.
 */
export async function runDefineConfirm(options: {
  term: string;
  modelsDir: string;
  billingProject: string;
}): Promise<void> {
  const { term, modelsDir, billingProject } = options;

  console.log(`\n  Confirming proposed term: "${term}"...`);
  console.log("");

  try {
    const result = await confirmTerm({ term, modelsDir, billingProject });
    console.log(`  ✓ Term confirmed and saved to terms.json`);
    console.log(`    Key:    ${result.key}`);
    console.log(`    Filter: ${result.filter}`);
    console.log(`    Source: ${result.sourceName} (${result.sourceFilename})`);
    console.log("");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  Error: ${message}`);
    console.error("");
    process.exit(1);
  }
}

/**
 * CLI: pnpm cli define <term> --description "..." --source <file> --models <dir>
 *
 * Manually defines a term using the LLM to generate a filter expression.
 */
export async function runDefineManual(options: {
  term: string;
  description: string;
  source?: string;
  modelsDir: string;
  billingProject: string;
}): Promise<void> {
  const { term, description, modelsDir, billingProject } = options;

  // Resolve source file
  let sourceFilename = options.source;
  if (!sourceFilename) {
    // Auto-detect: use the first .malloy file that has a parseable source
    const entries = await fs.readdir(modelsDir);
    const malloyFiles = entries.filter((f) => f.endsWith(".malloy")).sort();
    for (const f of malloyFiles) {
      const content = await fs.readFile(path.join(modelsDir, f), "utf-8");
      if (extractSourceSummary(f, content)) {
        sourceFilename = f;
        break;
      }
    }
    if (!sourceFilename) {
      console.error("\n  Error: No .malloy source files found. Specify --source explicitly.");
      process.exit(1);
    }
  }

  console.log(`\n  Defining term: "${term}"`);
  console.log(`  Description: ${description}`);
  console.log(`  Source: ${sourceFilename}`);
  console.log("");

  try {
    const result = await defineTermManually({
      term,
      description,
      sourceFilename,
      modelsDir,
      billingProject,
    });

    console.log(`  LLM generated filter:`);
    console.log(`    Filter:     ${result.filter}`);
    console.log(`    Reasoning:  ${result.reasoning}`);
    console.log(`    Confidence: ${result.confidence}`);
    console.log(`    Source:     ${result.sourceName} (${result.sourceFilename})`);
    console.log("");

    // Save to terms.json
    await saveManualTerm({
      key: result.key,
      filter: result.filter,
      description,
      sourceFilename: result.sourceFilename,
      modelsDir,
    });

    console.log(`  ✓ Term "${result.key}" saved to terms.json`);
    console.log("");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`\n  Error: ${message}`);
    console.error("");
    process.exit(1);
  }
}
