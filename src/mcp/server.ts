#!/usr/bin/env node

/**
 * MCP server for the Agentic Analytics engine.
 *
 * STDIO transport only. Runs as a subprocess of MCP-capable IDEs
 * (Cursor, Claude Desktop, Claude Code, Cline, Windsurf, Zed).
 *
 * IMPORTANT: console.log is monkey-patched to console.error at startup.
 * MCP STDIO uses stdout for protocol messages — any non-MCP output on
 * stdout corrupts the channel. All engine code that calls console.log
 * (introspection progress, query plans, etc.) is safely redirected to
 * stderr. The CLI is unaffected (it has its own entry point).
 *
 * Environment variables:
 *   ANTHROPIC_API_KEY              Required for LLM calls
 *   WEFT_HOME                      Optional. Where Weft keeps models/substrates
 *                                  (default: <repo>/.weft, resolved from this
 *                                  file's location — no need to set it).
 *   BQ_PROJECT_ID                  Default billing project (BigQuery)
 *   GOOGLE_APPLICATION_CREDENTIALS BigQuery authentication
 *   POSTGRES_URL                   Postgres connection string (required for Postgres)
 *   CLAUDE_MODEL                   Override default LLM model
 *
 * Models are auto-discovered under WEFT_HOME — connect a datasource and build a
 * model in the web app, and this server finds it with NO path configuration.
 *
 * IDE Configuration: generate the exact, valid block with `pnpm mcp:config`
 * and paste it into your IDE's MCP config (Claude Desktop:
 * claude_desktop_config.json; Cursor: ~/.cursor/mcp.json). It looks like:
 *
 *   {
 *     "mcpServers": {
 *       "weft": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/weft/dist/mcp/server.js"],
 *         "env": { "ANTHROPIC_API_KEY": "sk-ant-..." }
 *       }
 *     }
 *   }
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { setServer } from "./progress.js";
import { syncActiveConnection } from "../connections/runtime.js";

// ── Redirect console.log → stderr ────────────────────────────
// Engine functions use console.log freely for progress and debugging.
// In MCP STDIO mode, stdout is the protocol channel. Anything written
// to stdout that isn't a valid JSON-RPC message corrupts the transport.
// This one-line patch ensures all engine logging goes to stderr.
console.log = console.error;

// ── Create server ────────────────────────────────────────────
const server = new McpServer({
  name: "weft",
  version: "0.1.0",
});

// Wire up progress notifications
setServer(server);

// Register all 25 tools
registerAllTools(server);

// Adopt the active datasource saved in the web app (WEFT_HOME/connections.json):
// overlays its credentials onto the env so queries work with NO extra config.
// No-op if nothing is configured — explicit env vars still take effect.
await syncActiveConnection().catch(() => {});

// ── Connect via STDIO ────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[weft] MCP server started on stdio");
