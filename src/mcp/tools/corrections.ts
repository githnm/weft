import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { loadCorrections } from "../../correct/store.js";
import { rollbackTermUpdate } from "../../correct/term-update.js";
import { resolveModelsDir } from "../config.js";
import { text } from "../format.js";

export function register(server: McpServer): void {
  // ── list_corrections ───────────────────────────────────────
  server.tool(
    "list_corrections",
    "List all corrections applied to the model, with timestamps, types (term_update or model_suggestion), and descriptions. Use this when the user wants to see what corrections have been made or to find a correction ID for rollback.",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const store = await loadCorrections(modelsDir);
        const entries = Object.entries(store);

        if (entries.length === 0) {
          return { content: [text("No corrections recorded.")] };
        }

        // Sort by date descending
        entries.sort(([, a], [, b]) => b.appliedAt.localeCompare(a.appliedAt));

        const lines: string[] = [];
        lines.push(`## Corrections (${entries.length})\n`);
        lines.push("| ID | Date | Type | Target | Description |");
        lines.push("| --- | --- | --- | --- | --- |");

        for (const [id, record] of entries) {
          const date = record.appliedAt.slice(0, 10);
          const target = record.targetTerm ?? record.targetFile ?? "—";
          const type = record.type === "term_update" ? "term_update" : "model_suggestion";
          lines.push(`| \`${id}\` | ${date} | ${type} | ${target} | ${record.description} |`);
        }

        lines.push("");
        lines.push("_Use `rollback_correction` with a correction ID to undo a term_update._");

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[list_corrections] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── rollback_correction ────────────────────────────────────
  server.tool(
    "rollback_correction",
    "Reverse a previously applied term correction by restoring the prior filter. Requires the correction_id from list_corrections. Does NOT roll back model_suggestion type corrections (those are manual edits that must be undone manually).",
    {
      correction_id: z.string().describe("The correction ID to rollback (from list_corrections)"),
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const result = await rollbackTermUpdate({
          correctionId: args.correction_id,
          modelsDir,
        });

        return {
          content: [
            text(
              `Rolled back term **"${result.termName}"**.\n\n` +
                `Restored filter: \`${result.restoredFilter}\``,
            ),
          ],
        };
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[rollback_correction] ${message}`);
        // Distinguish "not found" from internal errors
        if (message.includes("not found") || message.includes("Cannot auto-rollback")) {
          throw new McpError(ErrorCode.InvalidParams, message);
        }
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
