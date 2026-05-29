/**
 * Helper functions for listing and summarizing Malloy sources.
 * Used internally by other MCP tools; not exposed as a standalone tool.
 */

import fs from "node:fs/promises";
import path from "node:path";
import { extractSourceSummary } from "../../agent/catalog.js";
import type { SourceSummary } from "../../agent/types.js";

/**
 * Read all .malloy files from a models directory and return their parsed summaries.
 */
export async function listSources(modelsDir: string): Promise<SourceSummary[]> {
  const entries = await fs.readdir(modelsDir);
  const malloyFiles = entries.filter((f) => f.endsWith(".malloy")).sort();

  const summaries: SourceSummary[] = [];
  for (const filename of malloyFiles) {
    const content = await fs.readFile(path.join(modelsDir, filename), "utf-8");
    const summary = extractSourceSummary(filename, content);
    if (summary) summaries.push(summary);
  }

  return summaries;
}

/**
 * Format a single source summary into a markdown section.
 */
export function formatSourceSummary(s: SourceSummary): string {
  const lines: string[] = [];
  lines.push(`### ${s.sourceName} (\`${s.filename}\`)`);
  if (s.primaryKey) lines.push(`- **Primary key:** ${s.primaryKey}`);
  if (s.joins.length > 0) lines.push(`- **Joins:** ${s.joins.join(", ")}`);
  lines.push(`- **Dimensions:** ${s.dimensions.length} (${s.dimensions.slice(0, 8).join(", ")}${s.dimensions.length > 8 ? ", ..." : ""})`);
  lines.push(`- **Measures:** ${s.measures.length} (${s.measures.slice(0, 8).join(", ")}${s.measures.length > 8 ? ", ..." : ""})`);
  lines.push(`- **Views:** ${s.views.length > 0 ? s.views.join(", ") : "none"}`);
  return lines.join("\n");
}
