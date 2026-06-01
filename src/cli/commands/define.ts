import { confirmTerm, defineTermManually, saveManualTerm, resolveSourceFilename } from "../../terms/define.js";

/**
 * CLI: pnpm cli define <term> --confirm --models <dir>
 *
 * Confirms an auto-proposed term from proposed-terms.json.
 */
export async function runDefineConfirm(options: {
  term: string;
  modelsDir: string;
  billingProject?: string;
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
  billingProject?: string;
}): Promise<void> {
  const { term, description, modelsDir, billingProject } = options;

  // Resolve source file — prefer the semantic model's model.malloy.
  let sourceFilename = options.source;
  if (!sourceFilename) {
    sourceFilename = (await resolveSourceFilename(modelsDir)) ?? undefined;
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
