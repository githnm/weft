import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { loadSession, clearSession } from "../../session/store.js";
import { resolveModelsDir } from "../config.js";
import { text } from "../format.js";

export function register(server: McpServer): void {
  // ── show_session ───────────────────────────────────────────
  server.tool(
    "show_session",
    "Return the current session state: last question, source, filters, group-by, aggregates, time range, last result summary. Use this to understand what context the next ask_question will inherit. Returns null if no session exists.",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: $WEFT_HOME/substrate)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const session = await loadSession(modelsDir);

        if (!session) {
          return { content: [text("No active session. The next `ask_question` call will start fresh.")] };
        }

        const age = Math.round(
          (Date.now() - new Date(session.last_at).getTime()) / 60000,
        );

        const lines: string[] = [];
        lines.push("## Session State\n");
        lines.push(`| Field | Value |`);
        lines.push(`| --- | --- |`);
        lines.push(`| **Last question** | ${session.last_question} |`);
        lines.push(`| **Source** | ${session.last_source} |`);
        lines.push(`| **Timestamp** | ${session.last_at} |`);
        lines.push(`| **Age** | ${age} minute${age !== 1 ? "s" : ""} |`);

        if (session.last_filters.length > 0) {
          const filterStr = session.last_filters
            .map((f) => {
              const termNote = f.applied_term ? ` (term: ${f.applied_term})` : "";
              return `\`${f.expression}\`${termNote}`;
            })
            .join(", ");
          lines.push(`| **Filters** | ${filterStr} |`);
        } else {
          lines.push(`| **Filters** | _(none)_ |`);
        }

        lines.push(`| **Group by** | ${session.last_group_by.length > 0 ? session.last_group_by.join(", ") : "_(none)_"} |`);
        lines.push(`| **Aggregates** | ${session.last_aggregates.length > 0 ? session.last_aggregates.join(", ") : "_(none)_"} |`);

        if (session.last_time_range) {
          lines.push(`| **Time range** | ${session.last_time_range.column} [${session.last_time_range.start} .. ${session.last_time_range.end}] |`);
        } else {
          lines.push(`| **Time range** | _(none)_ |`);
        }

        if (session.last_result_summary) {
          lines.push(`| **Last result** | ${session.last_result_summary.row_count} rows |`);
        }

        lines.push("");
        lines.push("**Malloy:**");
        lines.push("```malloy");
        lines.push(session.last_malloy);
        lines.push("```");

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[show_session] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── clear_session ──────────────────────────────────────────
  server.tool(
    "clear_session",
    "Delete the current session state. Use this when the user wants to start a fresh conversation, switch topics, or before asking an unrelated question that shouldn't inherit prior context.",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: $WEFT_HOME/substrate)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const deleted = await clearSession(modelsDir);

        return {
          content: [
            text(deleted ? "Session cleared. The next `ask_question` will start fresh." : "No session to clear."),
          ],
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[clear_session] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
