import fs from "node:fs/promises";
import path from "node:path";
import { resolveModelDir, resolveSemanticModelsDir } from "../../models/manifest.js";
import { readTraces } from "../../context/trace.js";
import { renderContextGraphHtml } from "../../context/graph-html.js";

export interface ContextGraphOptions {
  model: string;
  semanticModelsDir?: string;
  out?: string;
}

/**
 * `context graph <model>` — render the model's decision traces as a
 * self-contained interactive HTML file.
 */
export async function runContextGraph(options: ContextGraphOptions): Promise<void> {
  const semanticModelsDir = path.resolve(resolveSemanticModelsDir(options.semanticModelsDir));
  const modelDir = resolveModelDir(semanticModelsDir, options.model);

  const traces = await readTraces(modelDir);
  const html = renderContextGraphHtml(options.model, traces);

  const outPath = path.resolve(options.out ?? "./context-graph.html");
  await fs.writeFile(outPath, html, "utf-8");

  if (traces.length === 0) {
    console.log(`\n  No traces found for model "${options.model}" in ${modelDir}.`);
    console.log(`  Wrote an empty-state graph to ${outPath} anyway. Run some asks/corrections, then regenerate.\n`);
    return;
  }

  console.log(`\n  Context graph written to ${outPath}`);
  console.log(`  ${traces.length} trace(s) rendered. Open it in a browser (double-click).\n`);
}
