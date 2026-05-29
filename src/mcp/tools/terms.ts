import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { loadTerms, loadProposedTerms, removeTerm } from "../../terms/store.js";
import { resolveModelsDir } from "../config.js";
import { text } from "../format.js";

export function register(server: McpServer): void {
  // ── list_terms ─────────────────────────────────────────────
  server.tool(
    "list_terms",
    "List all confirmed business terms with their filters and usage counts. Use this when the user asks what terms are defined, or to inspect the current vocabulary. Returns structured data.",
    {
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const terms = await loadTerms(modelsDir);
        const proposals = await loadProposedTerms(modelsDir);

        const termKeys = Object.keys(terms);
        const proposalKeys = Object.keys(proposals);

        if (termKeys.length === 0 && proposalKeys.length === 0) {
          return {
            content: [text("No terms or proposals found. Use `define_term` to create one, or ask a question to auto-propose terms.")],
          };
        }

        const lines: string[] = [];

        // Confirmed terms
        if (termKeys.length > 0) {
          const sorted = termKeys.sort(
            (a, b) => terms[b].matched_count - terms[a].matched_count,
          );

          lines.push(`## Confirmed Terms (${termKeys.length})\n`);
          lines.push("| Term | Filter | Source | Used | Created |");
          lines.push("| --- | --- | --- | ---: | --- |");

          for (const key of sorted) {
            const t = terms[key];
            const filter = t.filter.length > 50 ? t.filter.slice(0, 47) + "..." : t.filter;
            lines.push(
              `| ${key} | \`${filter}\` | ${t.applies_to} | ${t.matched_count} | ${t.created_at.slice(0, 10)} |`,
            );
          }
          lines.push("");
        }

        // Pending proposals
        if (proposalKeys.length > 0) {
          lines.push(`## Pending Proposals (${proposalKeys.length})\n`);
          lines.push("| Term | Filter | Source | Context |");
          lines.push("| --- | --- | --- | --- |");

          for (const key of proposalKeys.sort()) {
            const p = proposals[key];
            lines.push(
              `| ${key} | \`${p.filter}\` | ${p.applies_to} | ${p.question_context.slice(0, 40)} |`,
            );
          }
          lines.push("");
          lines.push(
            "_Use `define_term` with `confirm: true` to confirm a proposal._",
          );
        }

        return { content: [text(lines.join("\n"))] };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[list_terms] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );

  // ── delete_term ────────────────────────────────────────────
  server.tool(
    "delete_term",
    "Remove a confirmed business term from terms.json. Use this when the user explicitly wants to remove a term. Asks for confirmation via the response, not interactively.",
    {
      term: z.string().describe("The term key to delete"),
      models_dir: z.string().optional().describe("Path to models directory (default: ./models or $DEFAULT_MODELS_DIR)"),
    },
    async (args) => {
      try {
        const modelsDir = resolveModelsDir(args.models_dir);
        const removed = await removeTerm(modelsDir, args.term);

        if (removed) {
          return {
            content: [text(`Term **"${args.term}"** deleted from terms.json.`)],
          };
        }

        // Not found — show available terms
        const terms = await loadTerms(modelsDir);
        const keys = Object.keys(terms);
        const available = keys.length > 0
          ? `Available terms: ${keys.sort().join(", ")}`
          : "No terms are currently defined.";

        throw new McpError(
          ErrorCode.InvalidParams,
          `Term "${args.term}" not found. ${available}`,
        );
      } catch (err: unknown) {
        if (err instanceof McpError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        console.error(`[delete_term] ${message}`);
        throw new McpError(ErrorCode.InternalError, message);
      }
    },
  );
}
