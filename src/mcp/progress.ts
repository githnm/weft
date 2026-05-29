/**
 * MCP progress notification helpers.
 *
 * Sends `notifications/message` (logging) to the connected IDE so
 * long-running tools show incremental status in chat.
 *
 * Always logs to stderr as a fallback — stderr is safe in MCP STDIO
 * mode and useful for debugging.
 */

import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

let serverRef: McpServer | null = null;

/**
 * Store a reference to the MCP server for sending notifications.
 * Called once at startup from server.ts.
 */
export function setServer(server: McpServer): void {
  serverRef = server;
}

/**
 * Send a progress message to the connected IDE.
 * Falls back to stderr if the server is not connected.
 */
export async function sendProgress(message: string): Promise<void> {
  console.error(`[progress] ${message}`);

  if (!serverRef) return;

  try {
    await serverRef.server.sendLoggingMessage({
      level: "info",
      logger: "agentic-analytics",
      data: message,
    });
  } catch {
    // Notification failed — already logged to stderr
  }
}
