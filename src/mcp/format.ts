/**
 * Shared output formatters for MCP tool responses.
 * All formatters produce markdown suitable for IDE chat rendering.
 */

/**
 * Format an array of row objects as a markdown table.
 * Numbers are right-aligned; strings are left-aligned.
 */
export function formatMarkdownTable(rows: Record<string, unknown>[] | undefined): string {
  if (!rows || rows.length === 0) return "_No rows returned._";

  const columns = Object.keys(rows[0]);

  // Header
  const header = "| " + columns.join(" | ") + " |";
  const separator =
    "| " +
    columns
      .map((col) => {
        // Right-align if first row value is numeric
        const val = rows[0][col];
        return typeof val === "number" || typeof val === "bigint"
          ? "---:"
          : "---";
      })
      .join(" | ") +
    " |";

  // Rows
  const body = rows.map((row) => {
    const cells = columns.map((col) => formatCell(row[col]));
    return "| " + cells.join(" | ") + " |";
  });

  return [header, separator, ...body].join("\n");
}

function formatCell(value: unknown): string {
  if (value === null || value === undefined) return "_null_";
  if (value instanceof Date)
    return value.toISOString().replace("T", " ").replace(/\.000Z$/, "");
  if (typeof value === "number") return value.toLocaleString();
  if (typeof value === "bigint") return value.toLocaleString();
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

/**
 * Format bytes into human-readable string.
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/**
 * Format a cost in USD.
 */
export function formatCost(usd: number): string {
  if (usd < 0.01) return `$${usd.toFixed(6)}`;
  if (usd < 1) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Build a text content block for MCP responses.
 */
export function text(content: string): { type: "text"; text: string } {
  return { type: "text" as const, text: content };
}
