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

import { BigQueryConnection } from "@malloydata/db-bigquery";
import { PostgresConnection } from "@malloydata/db-postgres";
import type { ConnectorKind } from "./types.js";

export interface MalloyConnectionOptions {
  connectorKind?: ConnectorKind;
  /** GCP billing project (BigQuery). Falls back to BQ_PROJECT_ID env. */
  billingProject?: string;
  /** BigQuery dataset region. Defaults to "US". */
  location?: string;
  /** Postgres connection string. Falls back to POSTGRES_URL env. */
  postgresUrl?: string;
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
): BigQueryConnection | PostgresConnection {
  const { connectorKind, billingProject, location, postgresUrl } = options;

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
