import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import fs from "node:fs/promises";
import { Runtime } from "@malloydata/malloy";
import type { ConnectorKind } from "../connectors/types.js";
import { buildMalloyConnection } from "../connectors/malloy-connection.js";
import { formatMalloyError, formatProblems } from "../interview/compile.js";
import { normalizeRow } from "./normalize.js";
import type { ExecutionResult } from "./types.js";

export interface ExecuteSuccess {
  ok: true;
  result: ExecutionResult;
}

export interface ExecuteFailure {
  ok: false;
  error: string;
  /** "compile" if Malloy compilation failed, "execute" if BQ rejected the SQL */
  phase: "compile" | "execute";
}

const COMPILE_TIMEOUT_MS = 10_000;
const QUERY_TIMEOUT_MS = 60_000;

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

/**
 * Build the full Malloy document: import the target source file,
 * then the LLM-generated `run:` block.
 */
function buildQueryDocument(sourceFilename: string, runBlock: string): string {
  return `import "${sourceFilename}"\n\n${runBlock}\n`;
}

interface CompileAndRunOptions {
  sourceFilename: string;
  runBlock: string;
  modelsDir: string;
  malloyFiles: Map<string, string>;
  /** GCP billing project — required for BigQuery, ignored for Postgres. */
  billingProject?: string;
  /** BigQuery region (default "US"). Must match the dataset's region. */
  location?: string;
  dryRun?: boolean;
  /** Connector kind — determines which Malloy connection to build.
   *  Detected from inspection.json; defaults to "bigquery" for backward compat. */
  connectorKind?: ConnectorKind;
}

/**
 * Compile a generated query. Returns the compile error string on failure,
 * or null on success. Does NOT execute.
 */
export async function compileQuery(options: CompileAndRunOptions): Promise<string | null> {
  const { sourceFilename, runBlock, modelsDir, malloyFiles, billingProject, location, connectorKind } = options;

  const queryDoc = buildQueryDocument(sourceFilename, runBlock);

  // The query document lives in the models directory (virtually)
  const queryAbsPath = path.resolve(modelsDir, "__query__.malloy");
  const queryUrl = pathToFileURL(queryAbsPath).href;

  const connection = buildMalloyConnection({ connectorKind, billingProject, location: location ?? "US" });

  const urlReader = {
    readURL: async (url: URL): Promise<string> => {
      if (url.href === queryUrl) return queryDoc;

      const urlPath = fileURLToPath(url);
      const basename = path.basename(urlPath);
      const fromMap = malloyFiles.get(basename);
      if (fromMap !== undefined) return fromMap;

      return fs.readFile(urlPath, "utf-8");
    },
  };

  const runtime = new Runtime({ urlReader, connection });
  const fileUrl = pathToFileURL(queryAbsPath);

  try {
    await withTimeout(runtime.getModel(fileUrl), COMPILE_TIMEOUT_MS, "compile");
    return null; // success
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return message.split("\n").slice(0, 10).join("\n");
  }
}

/**
 * Compile and execute a generated query against BigQuery.
 *
 * Returns a discriminated union: { ok: true, result } on success,
 * { ok: false, error, phase } on failure. The caller can use the
 * phase to decide how to retry.
 */
export async function executeQuery(
  options: CompileAndRunOptions,
): Promise<ExecuteSuccess | ExecuteFailure> {
  const { sourceFilename, runBlock, modelsDir, malloyFiles, billingProject, location, dryRun, connectorKind } = options;

  const queryDoc = buildQueryDocument(sourceFilename, runBlock);

  const queryAbsPath = path.resolve(modelsDir, "__query__.malloy");
  const queryUrl = pathToFileURL(queryAbsPath).href;

  const connection = buildMalloyConnection({ connectorKind, billingProject, location: location ?? "US" });

  const urlReader = {
    readURL: async (url: URL): Promise<string> => {
      if (url.href === queryUrl) return queryDoc;

      const urlPath = fileURLToPath(url);
      const basename = path.basename(urlPath);
      const fromMap = malloyFiles.get(basename);
      if (fromMap !== undefined) return fromMap;

      return fs.readFile(urlPath, "utf-8");
    },
  };

  const runtime = new Runtime({ urlReader, connection });
  const fileUrl = pathToFileURL(queryAbsPath);

  // loadQueryByIndex materializes the query lazily — compilation
  // happens when we call validate() or run().
  const queryMaterializer = runtime.loadQueryByIndex(fileUrl, 0);

  if (dryRun) {
    // Just compile — validate() returns problems, empty = OK
    try {
      const problems = await withTimeout(queryMaterializer.validate(), COMPILE_TIMEOUT_MS, "validate");
      if (problems.length > 0) {
        return { ok: false, error: formatProblems(problems), phase: "compile" };
      }
      return { ok: true, result: { rows: [], totalRows: 0 } };
    } catch (err: unknown) {
      return { ok: false, error: formatMalloyError(err), phase: "compile" };
    }
  }

  // Execute — run() does both compile and execute.
  // We catch errors and classify them.
  try {
    const result = await withTimeout(queryMaterializer.run(), QUERY_TIMEOUT_MS, "execute");

    // Normalize once at the execution boundary so every downstream consumer
    // (tracing, CLI, web, what-if) gets JSON-safe values (Defect 4).
    const rows: Record<string, unknown>[] = [];
    for (const record of result.data) {
      rows.push(normalizeRow(record.toObject() as Record<string, unknown>));
    }

    return {
      ok: true,
      result: {
        rows,
        totalRows: result.totalRows,
        bytesScanned: result.runStats?.queryCostBytes,
      },
    };
  } catch (err: unknown) {
    // Surface the FULL underlying error (Malloy compile diagnostics live in
    // .problems; warehouse SQL errors are on .message). No swallowing.
    const message = formatMalloyError(err);

    // Heuristic to classify: Malloy compile errors typically contain
    // "at line" or "Expected" or come from the translator; BQ/Postgres
    // execution errors contain project IDs, SQL keywords, or status codes.
    const isCompile =
      /at line \d+/i.test(message) ||
      /\(line \d+/i.test(message) ||
      message.includes("Expected") ||
      message.includes("is not defined") ||
      message.includes("Cannot redefine");

    return {
      ok: false,
      error: message,
      phase: isCompile ? "compile" : "execute",
    };
  }
}
