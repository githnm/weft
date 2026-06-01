/**
 * Connectivity test — NOT introspection. Reuses the connector layer
 * (buildMalloyConnection) and the Malloy connection's own `test()` (a cheap
 * connect/probe). Returns the REAL underlying error (wrong port, SSL, host not
 * found, auth failed) so the UI can surface the exact setup problem.
 */

import fs from "node:fs/promises";
import { buildMalloyConnection } from "../connectors/malloy-connection.js";
import { createConnector } from "../connectors/factory.js";
import { recordToMalloyOptions, type ConnectionRecord } from "./store.js";

const TEST_TIMEOUT_MS = 12_000;

export interface TestResult {
  ok: boolean;
  error?: string;
}

/** Turn a raw driver error into a clear, specific message. Exported so the
 *  introspect job surfaces the same quality of error as Test connection. */
export function explainConnectionError(err: unknown): string {
  return explain(err);
}

/** Turn a raw driver error into a clear, specific message. */
function explain(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const lower = raw.toLowerCase();
  if (lower.includes("etimedout") || lower.includes("timed out")) {
    return `Connection timed out — host/port unreachable. For Supabase use the pooler host (aws-N-region.pooler.supabase.com) and session pooler port 5432, not the direct db.<ref>.supabase.co (often IPv6-only). (${raw})`;
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo")) {
    return `Host not found — check the hostname. For Supabase use the pooler host (aws-N-region.pooler.supabase.com). (${raw})`;
  }
  if (lower.includes("econnrefused")) {
    return `Connection refused — wrong port? For Supabase use the session pooler port 5432, not the transaction pooler 6543. (${raw})`;
  }
  if (lower.includes("password authentication") || lower.includes("auth")) {
    return `Authentication failed — check the user and password. (${raw})`;
  }
  if (lower.includes("ssl") || lower.includes("self-signed") || lower.includes("certificate")) {
    return `SSL problem — cloud Postgres (Supabase/Neon/RDS) needs sslmode=no-verify. (${raw})`;
  }
  if (lower.includes("does not exist") && lower.includes("database")) {
    return `Database not found — check the database name. (${raw})`;
  }
  if (lower.includes("could not load the default credentials") || lower.includes("application default")) {
    return `BigQuery auth failed — run \`gcloud auth application-default login\`, or set a key-file path. (${raw})`;
  }
  if (lower.includes("not found") && lower.includes("dataset")) {
    return `Dataset not found — check the Data project + Dataset. For public datasets the data project is the owner (e.g. bigquery-public-data), not your billing project. (${raw})`;
  }
  if (lower.includes("no such file") || lower.includes("enoent") || lower.includes("io error") || lower.includes("cannot open")) {
    return `File not found or unreadable — check the path. Point at a .duckdb file or a Parquet/CSV. (${raw})`;
  }
  return raw;
}

export async function testConnectionRecord(record: ConnectionRecord): Promise<TestResult> {
  // DuckDB is file-based: a real connectivity test means the FILE reads. We use
  // the connector itself (which opens the file and lists/describes it) — a
  // :memory: connection.test() would pass even for a bogus path.
  if (record.type === "duckdb") {
    if (record.file_path !== ":memory:") {
      try {
        await fs.access(record.file_path);
      } catch {
        return { ok: false, error: `File not found: ${record.file_path}. Point at a .duckdb file or a Parquet/CSV.` };
      }
    }
    const connector = createConnector({ kind: "duckdb", filePath: record.file_path });
    try {
      await Promise.race([
        connector.getColumns(), // opens the file + DESCRIBEs it — real error if unreadable
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out (12s)")), TEST_TIMEOUT_MS)),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: explain(err) };
    } finally {
      await connector.close().catch(() => {});
    }
  }

  // BigQuery with a dataset: verify the data-project + dataset + billing combo
  // end to end by listing the dataset's tables (INFORMATION_SCHEMA metadata —
  // cheap). This catches a wrong data project / unreachable dataset, which a
  // bare auth probe would miss.
  if (record.type === "bigquery" && record.dataset?.trim()) {
    const prevCreds = process.env.GOOGLE_APPLICATION_CREDENTIALS;
    if (record.key_file_path) process.env.GOOGLE_APPLICATION_CREDENTIALS = record.key_file_path;
    const connector = createConnector({
      kind: "bigquery",
      project: record.data_project?.trim() || record.project_id,
      dataset: record.dataset.trim(),
      billingProject: record.project_id,
      location: record.location,
    });
    try {
      await Promise.race([
        connector.listTables(),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error("Connection timed out (12s)")), TEST_TIMEOUT_MS)),
      ]);
      return { ok: true };
    } catch (err) {
      return { ok: false, error: explain(err) };
    } finally {
      await connector.close().catch(() => {});
      if (record.key_file_path) {
        if (prevCreds === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
        else process.env.GOOGLE_APPLICATION_CREDENTIALS = prevCreds;
      }
    }
  }

  const opts = recordToMalloyOptions(record);
  let connection: { test(): Promise<void>; close(): Promise<void> } | null = null;
  try {
    connection = buildMalloyConnection(opts) as unknown as { test(): Promise<void>; close(): Promise<void> };
    await Promise.race([
      connection.test(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("Connection timed out (12s)")), TEST_TIMEOUT_MS),
      ),
    ]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: explain(err) };
  } finally {
    await connection?.close?.().catch(() => {});
  }
}
