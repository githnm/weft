#!/usr/bin/env npx tsx
/**
 * Prints a ready-to-paste MCP server config block, with the absolute path to
 * THIS clone's compiled server already filled in. No path-guessing, no
 * hand-written JSON.
 *
 *   pnpm mcp:config
 *
 * Copy the JSON into your IDE's MCP config, replace the API key, restart.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url)); // <repo>/scripts
const repoRoot = path.dirname(here);
const serverPath = path.join(repoRoot, "dist", "mcp", "server.js");

const built = fs.existsSync(serverPath);

// The env block: only ANTHROPIC_API_KEY is required. Datasource credentials
// come from the active connection saved in the web app (WEFT_HOME), so they
// do NOT belong here. WEFT_HOME is only emitted if you've customized it.
const env: Record<string, string> = { ANTHROPIC_API_KEY: "sk-ant-REPLACE_WITH_YOUR_KEY" };
if (process.env.WEFT_HOME) env.WEFT_HOME = path.resolve(process.env.WEFT_HOME);

const config = {
  mcpServers: {
    weft: {
      command: "node",
      args: [serverPath],
      env,
    },
  },
};

const claudeDesktopPath =
  process.platform === "darwin"
    ? "~/Library/Application Support/Claude/claude_desktop_config.json"
    : process.platform === "win32"
      ? "%APPDATA%\\Claude\\claude_desktop_config.json"
      : "~/.config/Claude/claude_desktop_config.json";

const out: string[] = [];
out.push("");
if (!built) {
  out.push("⚠  dist/mcp/server.js not found — run `pnpm build` first, then re-run `pnpm mcp:config`.");
  out.push("");
}
out.push("Add this to your MCP config, then replace the API key and fully restart the IDE.");
out.push(`  • Claude Desktop:  ${claudeDesktopPath}`);
out.push("  • Cursor:          ~/.cursor/mcp.json");
out.push("");
out.push("If the file already has an \"mcpServers\" object, add just the \"weft\" entry inside it.");
out.push("");
out.push(JSON.stringify(config, null, 2));
out.push("");
out.push("Models are auto-discovered (WEFT_HOME); build one in the web app (`pnpm web`) and the");
out.push("server will list it — no model path needed in the config.");
out.push("");

console.log(out.join("\n"));
