/**
 * Single source of truth for building Malloy connections.
 *
 * Every path that compiles, validates, or executes Malloy code
 * against a real database MUST use this builder. It ensures:
 * - Postgres: reads POSTGRES_URL from env (or explicit param).
 *   Throws a clear error if unset — never falls back to localhost.
 * - BigQuery: reads BQ_PROJECT_ID + optional location.
 * - SSL handling for cloud Postgres (Supabase, Neon, RDS).
 */

import path from "node:path";
import { BigQueryConnection } from "@malloydata/db-bigquery";
import { PostgresConnection } from "@malloydata/db-postgres";
import { DuckDBConnection } from "@malloydata/db-duckdb";
import { MySQLConnection } from "@malloydata/db-mysql";
import { SnowflakeConnection } from "@malloydata/db-snowflake";
import type { ConnectorKind } from "./types.js";

export interface SnowflakeConnOptions {
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema?: string;
  role?: string;
  password?: string;
  privateKeyPath?: string;
  privateKeyPassphrase?: string;
}

export interface MalloyConnectionOptions {
  connectorKind?: ConnectorKind;
  /** GCP billing project (BigQuery). Falls back to BQ_PROJECT_ID env. */
  billingProject?: string;
  /** BigQuery dataset region. Defaults to "US". */
  location?: string;
  /** Postgres connection string. Falls back to POSTGRES_URL env. */
  postgresUrl?: string;
  /** DuckDB file path. Falls back to DUCKDB_DATABASE env. */
  duckdbPath?: string;
  /** MySQL connection string. Falls back to MYSQL_URL env. */
  mysqlUrl?: string;
  /** Snowflake connection fields. Falls back to SNOWFLAKE_* env. */
  snowflake?: SnowflakeConnOptions;
}

/** Resolve Snowflake options from the param or SNOWFLAKE_* env vars. */
function resolveSnowflake(sf?: SnowflakeConnOptions): SnowflakeConnOptions | undefined {
  const account = sf?.account ?? process.env.SNOWFLAKE_ACCOUNT;
  const username = sf?.username ?? process.env.SNOWFLAKE_USER;
  const warehouse = sf?.warehouse ?? process.env.SNOWFLAKE_WAREHOUSE;
  const database = sf?.database ?? process.env.SNOWFLAKE_DATABASE;
  if (!account || !username || !warehouse || !database) return undefined;
  return {
    account, username, warehouse, database,
    schema: sf?.schema ?? process.env.SNOWFLAKE_SCHEMA ?? "PUBLIC",
    role: sf?.role ?? process.env.SNOWFLAKE_ROLE,
    password: sf?.password ?? process.env.SNOWFLAKE_PASSWORD,
    privateKeyPath: sf?.privateKeyPath ?? process.env.SNOWFLAKE_PRIVATE_KEY_PATH,
    privateKeyPassphrase: sf?.privateKeyPassphrase ?? process.env.SNOWFLAKE_PRIVATE_KEY_PASSPHRASE,
  };
}

/**
 * Build a connector-aware Malloy connection.
 *
 * For Postgres: requires POSTGRES_URL (env or explicit). Never falls
 * back to localhost defaults — a missing URL is an error.
 *
 * For BigQuery: requires a billing project (param or BQ_PROJECT_ID).
 */
export function buildMalloyConnection(
  options: MalloyConnectionOptions = {},
): BigQueryConnection | PostgresConnection | DuckDBConnection | MySQLConnection | SnowflakeConnection {
  const { connectorKind, billingProject, location, postgresUrl, duckdbPath, mysqlUrl } = options;

  if (connectorKind === "mysql") {
    const url = mysqlUrl ?? process.env.MYSQL_URL;
    if (!url) {
      throw new Error("MYSQL_URL not set; cannot compile MySQL model. Set MYSQL_URL to mysql://user:pass@host:3306/db.");
    }
    const parsed = new URL(url);
    return new MySQLConnection("mysql", {
      host: parsed.hostname,
      port: parseInt(parsed.port || "3306", 10),
      database: parsed.pathname.replace(/^\//, ""),
      user: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
    });
  }

  if (connectorKind === "snowflake") {
    const sf = resolveSnowflake(options.snowflake);
    if (!sf) {
      throw new Error(
        "Snowflake connection not configured; set SNOWFLAKE_ACCOUNT / SNOWFLAKE_USER / SNOWFLAKE_WAREHOUSE / SNOWFLAKE_DATABASE (and a password or key).",
      );
    }
    const connOptions: Record<string, unknown> = {
      account: sf.account,
      username: sf.username,
      warehouse: sf.warehouse,
      database: sf.database,
      schema: sf.schema ?? "PUBLIC",
      ...(sf.role ? { role: sf.role } : {}),
    };
    if (sf.privateKeyPath) {
      connOptions.authenticator = "SNOWFLAKE_JWT";
      connOptions.privateKeyPath = sf.privateKeyPath;
      if (sf.privateKeyPassphrase) connOptions.privateKeyPass = sf.privateKeyPassphrase;
    } else {
      connOptions.password = sf.password;
    }
    return new SnowflakeConnection("snowflake", {
      // database/schema live inside connOptions for snowflake-sdk.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      connOptions: connOptions as any,
    });
  }

  if (connectorKind === "duckdb") {
    const dbPath = duckdbPath ?? process.env.DUCKDB_DATABASE;
    if (!dbPath) {
      throw new Error(
        "DUCKDB_DATABASE not set; cannot compile DuckDB model. " +
        "Point at a .duckdb file or a Parquet/CSV file (set DUCKDB_DATABASE).",
      );
    }
    const ext = path.extname(dbPath).toLowerCase();
    const isDbFile = ext === ".duckdb" || ext === ".db" || dbPath === ":memory:";
    return new DuckDBConnection({
      name: "duckdb",
      // Data files are read from :memory: via `duckdb.table('<path>')`.
      databasePath: isDbFile ? dbPath : ":memory:",
      workingDirectory: process.cwd(),
    });
  }

  if (connectorKind === "postgres") {
    const connectionString = postgresUrl ?? process.env.POSTGRES_URL;

    if (!connectionString) {
      throw new Error(
        "POSTGRES_URL not set; cannot compile Postgres model. " +
        "Set the POSTGRES_URL environment variable to a valid connection string " +
        "(e.g. postgres://user:pass@host:5432/db?sslmode=require).",
      );
    }

    const parsed = new URL(connectionString);

    // Determine SSL from the connection string
    const lower = connectionString.toLowerCase();
    const needsSSL =
      lower.includes("sslmode=require") ||
      lower.includes("sslmode=verify") ||
      // Cloud PG providers (Supabase, Neon) need SSL by default
      !lower.includes("sslmode=disable");

    return new PostgresConnection({
      name: "postgres",
      host: parsed.hostname,
      port: parseInt(parsed.port || "5432", 10),
      databaseName: parsed.pathname.replace(/^\//, ""),
      username: decodeURIComponent(parsed.username),
      password: decodeURIComponent(parsed.password),
      ...(needsSSL ? { ssl: { rejectUnauthorized: false } } : {}),
    });
  }

  // Default: BigQuery
  const project = billingProject ?? process.env.BQ_PROJECT_ID;
  if (!project) {
    throw new Error(
      "BQ_PROJECT_ID not set; cannot compile BigQuery model. " +
      "Set the BQ_PROJECT_ID environment variable.",
    );
  }

  return new BigQueryConnection({
    name: "bigquery",
    projectId: project,
    location: location ?? "US",
  });
}
