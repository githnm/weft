/**
 * Make the active saved connection usable by the WHOLE engine without
 * threading params through every layer.
 *
 * The engine resolves Postgres/BigQuery via env (POSTGRES_URL / BQ_PROJECT_ID,
 * read inside buildMalloyConnection). So we overlay the ACTIVE saved
 * connection onto process.env server-side. Precedence: a saved active
 * connection wins; if none exists, the ORIGINAL environment is restored — so
 * env-var config keeps working as a fallback.
 *
 * Credentials only ever live in this server process + the local config file;
 * they are never sent to the browser.
 */

import { getActiveConnection, recordToMalloyOptions } from "./store.js";
import type { ConnectorKind } from "../connectors/types.js";

// Snapshot the original environment ONCE at process start, so we can restore
// it whenever there is no active saved connection.
const ENV_KEYS = [
  "POSTGRES_URL",
  "BQ_PROJECT_ID",
  "GOOGLE_APPLICATION_CREDENTIALS",
  "DUCKDB_DATABASE",
  "MYSQL_URL",
  "SNOWFLAKE_ACCOUNT",
  "SNOWFLAKE_USER",
  "SNOWFLAKE_WAREHOUSE",
  "SNOWFLAKE_DATABASE",
  "SNOWFLAKE_SCHEMA",
  "SNOWFLAKE_ROLE",
  "SNOWFLAKE_PASSWORD",
  "SNOWFLAKE_PRIVATE_KEY_PATH",
  "SNOWFLAKE_PRIVATE_KEY_PASSPHRASE",
];
const ORIGINAL: Record<string, string | undefined> = Object.fromEntries(
  ENV_KEYS.map((k) => [k, process.env[k]]),
);

function setEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

function restoreOriginal(): void {
  for (const [k, v] of Object.entries(ORIGINAL)) setEnv(k, v);
}

/**
 * Re-resolve the active connection and overlay it onto process.env.
 * Call at server startup and after any mutation (add / delete / activate).
 * Returns the active connector kind, or null if falling back to env.
 */
export async function syncActiveConnection(): Promise<ConnectorKind | null> {
  restoreOriginal();
  const active = await getActiveConnection();
  if (!active) return null;

  const opts = recordToMalloyOptions(active);
  switch (opts.connectorKind) {
    case "postgres":
      setEnv("POSTGRES_URL", opts.postgresUrl);
      break;
    case "bigquery":
      setEnv("BQ_PROJECT_ID", opts.billingProject);
      if (active.type === "bigquery" && active.key_file_path) {
        setEnv("GOOGLE_APPLICATION_CREDENTIALS", active.key_file_path);
      }
      break;
    case "duckdb":
      setEnv("DUCKDB_DATABASE", opts.duckdbPath);
      break;
    case "mysql":
      setEnv("MYSQL_URL", opts.mysqlUrl);
      break;
    case "snowflake":
      if (active.type === "snowflake") {
        setEnv("SNOWFLAKE_ACCOUNT", active.account);
        setEnv("SNOWFLAKE_USER", active.username);
        setEnv("SNOWFLAKE_WAREHOUSE", active.warehouse);
        setEnv("SNOWFLAKE_DATABASE", active.database);
        setEnv("SNOWFLAKE_SCHEMA", active.schema);
        setEnv("SNOWFLAKE_ROLE", active.role);
        setEnv("SNOWFLAKE_PASSWORD", active.password);
        setEnv("SNOWFLAKE_PRIVATE_KEY_PATH", active.private_key_path);
        setEnv("SNOWFLAKE_PRIVATE_KEY_PASSPHRASE", active.private_key_passphrase);
      }
      break;
  }
  return opts.connectorKind;
}
