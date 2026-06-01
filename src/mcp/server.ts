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
 *   BQ_PROJECT_ID                  Default billing project (BigQuery)
 *   GOOGLE_APPLICATION_CREDENTIALS BigQuery authentication
 *   POSTGRES_URL                   Postgres connection string (required for Postgres)
 *   CLAUDE_MODEL                   Override default LLM model
 *   DEFAULT_MODELS_DIR             Default models / substrate directory
 *   DEFAULT_SUBSTRATE_DIR          Override substrate directory specifically
 *   DEFAULT_SEMANTIC_MODELS_DIR    Override semantic-models directory
 *
 * IDE Configuration:
 *
 * For Cursor (~/.cursor/mcp.json) or Claude Desktop (claude_desktop_config.json):
 *
 *   {
 *     "mcpServers": {
 *       "agentic-analytics": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/dist/mcp/server.js"],
 *         "env": {
 *           "ANTHROPIC_API_KEY": "sk-ant-...",
 *           "BQ_PROJECT_ID": "my-gcp-project",
 *           "GOOGLE_APPLICATION_CREDENTIALS": "/path/to/key.json",
 *           "POSTGRES_URL": "postgres://user:pass@host:5432/db?sslmode=require",
 *           "DEFAULT_MODELS_DIR": "/path/to/substrate"
 *         }
 *       }
 *     }
 *   }
 *
 * Or after npm publish:
 *
 *   {
 *     "mcpServers": {
 *       "agentic-analytics": {
 *         "command": "npx",
 *         "args": ["-y", "agentic-analytics-mcp"],
 *         "env": { ... }
 *       }
 *     }
 *   }
 */

import "dotenv/config";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { registerAllTools } from "./tools/index.js";
import { setServer } from "./progress.js";

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

// ── Connect via STDIO ────────────────────────────────────────
const transport = new StdioServerTransport();
await server.connect(transport);

console.error("[agentic-analytics] MCP server started on stdio");
