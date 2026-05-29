import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Runtime } from "@malloydata/malloy";
import type { ConnectorKind } from "../connectors/types.js";
import { buildMalloyConnection } from "../connectors/malloy-connection.js";
import type { Suggestion, ValidationResult } from "./types.js";

const COMPILE_TIMEOUT_MS = 5_000;

/**
 * Splice malloy_code into a source file just before the final closing `}`.
 * Returns the modified source string, or null if the closing brace isn't found.
 */
function spliceIntoSource(original: string, code: string): string | null {
  // Find the last `}` that closes the `source: ... extend { ... }` block.
  const lastBrace = original.lastIndexOf("}");
  if (lastBrace === -1) return null;

  const before = original.slice(0, lastBrace);
  const after = original.slice(lastBrace);

  // Ensure a blank line separates existing content from the splice
  const sep = before.trimEnd().endsWith("\n") ? "\n" : "\n\n";
  const indented = code
    .split("\n")
    .map((line) => (line.trim() === "" ? "" : `  ${line}`))
    .join("\n");

  return before.trimEnd() + sep + indented + "\n" + after;
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout after ${ms}ms: ${label}`)), ms);
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); },
    );
  });
}

// Connection builder is now imported from connectors/malloy-connection.ts

export async function validateSuggestions(
  suggestions: Suggestion[],
  baselineFiles: Map<string, string>,
  modelsDir: string,
  billingProject: string | undefined,
  connectorKind?: ConnectorKind,
): Promise<void> {
  const connection = buildMalloyConnection({ connectorKind, billingProject });

  for (let i = 0; i < suggestions.length; i++) {
    const s = suggestions[i];
    const label = `[${i + 1}/${suggestions.length}] ${s.title}`;
    process.stdout.write(`  Validating ${label}...`);

    // Check target file exists
    const baseline = baselineFiles.get(s.target_source);
    if (baseline === undefined) {
      s.validation = { status: "fail", error: `target file not found: ${s.target_source}` };
      console.log(" FAIL (target not found)");
      continue;
    }

    // Splice suggestion into the target source
    const spliced = spliceIntoSource(baseline, s.malloy_code);
    if (spliced === null) {
      s.validation = { status: "fail", error: "could not find closing } in target source" };
      console.log(" FAIL (parse error)");
      continue;
    }

    // Build an in-memory URL reader: spliced content for the target,
    // original content for everything else, disk fallback for imports
    // that reference files outside the baseline map.
    const targetAbsPath = path.resolve(modelsDir, s.target_source);
    const targetUrl = pathToFileURL(targetAbsPath).href;

    const urlReader = {
      readURL: async (url: URL): Promise<string> => {
        if (url.href === targetUrl) return spliced;

        // Check if this URL maps to a known baseline file
        const urlPath = fileURLToPath(url);
        const basename = path.basename(urlPath);
        const fromBaseline = baselineFiles.get(basename);
        if (fromBaseline !== undefined) return fromBaseline;

        // Fallback: read from disk (for files not in baseline)
        return fs.readFile(urlPath, "utf-8");
      },
    };

    const runtime = new Runtime({ urlReader, connection });
    const fileUrl = pathToFileURL(targetAbsPath);

    try {
      await withTimeout(runtime.getModel(fileUrl), COMPILE_TIMEOUT_MS, s.title);
      s.validation = { status: "pass" };
      console.log(" OK");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      // Trim verbose multi-line compiler output to the first meaningful lines
      const trimmed = message.split("\n").slice(0, 8).join("\n");
      s.validation = { status: "fail", error: trimmed };
      console.log(" FAIL");
    }
  }
}
