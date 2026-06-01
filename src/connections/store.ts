/**
 * Local connection store — credentials live on the user's machine ONLY.
 *
 * Written to a project-local `.weft/connections.json` (gitignored), with
 * owner-only file permissions. The browser never stores or receives the
 * secret: the API returns metadata only (see toMeta). The engine reads the
 * full record server-side to connect.
 *
 * Reuses the existing connector layer for the actual connection (the URL we
 * assemble here is consumed by buildMalloyConnection / the connector classes).
 */

import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { ConnectorKind } from "../connectors/types.js";

// ── Records (stored on disk; include secrets) ────────────────────

interface BaseRecord {
  id: string;
  name: string;
  type: ConnectorKind;
  created_at: string;
}

export interface PostgresRecord extends BaseRecord {
  type: "postgres";
  host: string;
  port: number;
  database: string;
  user: string;
  /** SECRET — never returned to the client after save. */
  password: string;
  /** e.g. "no-verify" | "require" | "disable". Default "no-verify". */
  sslmode: string;
}

export interface BigQueryRecord extends BaseRecord {
  type: "bigquery";
  /** BILLING/compute project — who pays for and runs the query. */
  project_id: string;
  location: string;
  /**
   * DATA project — where the dataset physically lives. For your own data this
   * equals the billing project; for PUBLIC datasets it differs (e.g.
   * "bigquery-public-data"). Defaults to project_id when blank.
   */
  data_project?: string;
  /** The dataset to introspect (e.g. "google_analytics_sample"). */
  dataset?: string;
  /**
   * Optional PATH to a service-account key file (NOT the key contents).
   * When omitted, auth uses gcloud Application Default Credentials.
   */
  key_file_path?: string;
}

export interface DuckDBRecord extends BaseRecord {
  type: "duckdb";
  /** File path — a .duckdb file OR a Parquet/CSV/JSON data file. No secrets. */
  file_path: string;
}

export interface MySQLRecord extends BaseRecord {
  type: "mysql";
  host: string;
  port: number;
  database: string;
  user: string;
  /** SECRET. */
  password: string;
  ssl: boolean;
}

export interface SnowflakeRecord extends BaseRecord {
  type: "snowflake";
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema: string;
  role?: string;
  /** SECRET (password auth). */
  password?: string;
  /** Key-pair auth: PATH to a private key PEM (not the contents). */
  private_key_path?: string;
  /** SECRET (key passphrase, if the PEM is encrypted). */
  private_key_passphrase?: string;
}

export type ConnectionRecord =
  | PostgresRecord
  | BigQueryRecord
  | DuckDBRecord
  | MySQLRecord
  | SnowflakeRecord;

interface StoreFile {
  active_id: string | null;
  connections: ConnectionRecord[];
}

// ── Metadata (safe to send to the browser — NO secrets) ──────────

export interface ConnectionMeta {
  id: string;
  name: string;
  type: ConnectorKind;
  /** Masked, human-readable hint — never the password. */
  masked: string;
  active: boolean;
  created_at: string;
  // Type-specific non-secret fields, for display + form re-population.
  host?: string;
  port?: number;
  database?: string;
  user?: string;
  sslmode?: string;
  ssl?: boolean;
  project_id?: string;
  location?: string;
  /** BigQuery data project (where the dataset lives; may differ from billing). */
  data_project?: string;
  /** BigQuery dataset to introspect. */
  dataset?: string;
  /** Whether a key-file path is configured (the path itself is shown, not a secret). */
  key_file_path?: string;
  // duckdb
  file_path?: string;
  // snowflake
  account?: string;
  username?: string;
  warehouse?: string;
  schema?: string;
  role?: string;
  auth?: "password" | "key-pair";
}

// ── Storage location ─────────────────────────────────────────────

/** Project-local .weft dir (gitignored). Override with WEFT_CONFIG_DIR. */
function configDir(): string {
  return process.env.WEFT_CONFIG_DIR
    ? path.resolve(process.env.WEFT_CONFIG_DIR)
    : path.resolve(process.cwd(), ".weft");
}

function storePath(): string {
  return path.join(configDir(), "connections.json");
}

/**
 * Each connection owns its OWN substrate (introspection output), so building a
 * model from a datasource reads exactly that datasource's schema — never a
 * different connection's. Deterministic from the connection id.
 */
export function connectionSubstrateDir(id: string): string {
  return path.join(configDir(), "substrates", id);
}

async function readStore(): Promise<StoreFile> {
  try {
    const raw = await fs.readFile(storePath(), "utf-8");
    const parsed = JSON.parse(raw) as StoreFile;
    return {
      active_id: parsed.active_id ?? null,
      connections: Array.isArray(parsed.connections) ? parsed.connections : [],
    };
  } catch {
    return { active_id: null, connections: [] };
  }
}

async function writeStore(store: StoreFile): Promise<void> {
  const dir = configDir();
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  // Owner read/write only — these are credentials.
  await fs.writeFile(storePath(), JSON.stringify(store, null, 2) + "\n", { encoding: "utf-8", mode: 0o600 });
  await fs.chmod(storePath(), 0o600).catch(() => {});
}

// ── Masking + connection-string assembly ─────────────────────────

function maskOf(r: ConnectionRecord): string {
  switch (r.type) {
    case "postgres":
    case "mysql":
      return `${r.user}@${r.host}:${r.port}/${r.database}`;
    case "bigquery": {
      const data = r.data_project && r.data_project !== r.project_id ? `${r.data_project}.` : "";
      const ds = r.dataset ? `${data}${r.dataset}` : r.project_id;
      return `${ds}${r.location ? ` (${r.location})` : ""}`;
    }
    case "duckdb":
      return r.file_path;
    case "snowflake":
      return `${r.username}@${r.account}/${r.database}.${r.schema} (${r.warehouse})`;
  }
}

export function toMeta(r: ConnectionRecord, activeId: string | null): ConnectionMeta {
  const base: ConnectionMeta = {
    id: r.id,
    name: r.name,
    type: r.type,
    masked: maskOf(r),
    active: r.id === activeId,
    created_at: r.created_at,
  };
  switch (r.type) {
    case "postgres":
      return { ...base, host: r.host, port: r.port, database: r.database, user: r.user, sslmode: r.sslmode };
    case "mysql":
      return { ...base, host: r.host, port: r.port, database: r.database, user: r.user, ssl: r.ssl };
    case "bigquery":
      return { ...base, project_id: r.project_id, location: r.location, data_project: r.data_project, dataset: r.dataset, key_file_path: r.key_file_path };
    case "duckdb":
      return { ...base, file_path: r.file_path };
    case "snowflake":
      return {
        ...base, account: r.account, username: r.username, warehouse: r.warehouse,
        database: r.database, schema: r.schema, role: r.role,
        auth: r.private_key_path ? "key-pair" : "password",
        key_file_path: r.private_key_path,
      };
  }
}

/**
 * Assemble the Postgres connection string from parts, URL-encoding the
 * user/password so '@', '!', ':' etc. don't have to be escaped by the user.
 * Consumed by buildMalloyConnection, which decodes them back.
 */
export function toPostgresUrl(r: PostgresRecord): string {
  const user = encodeURIComponent(r.user);
  const pass = encodeURIComponent(r.password);
  const db = encodeURIComponent(r.database);
  const sslmode = r.sslmode || "no-verify";
  return `postgresql://${user}:${pass}@${r.host}:${r.port}/${db}?sslmode=${sslmode}`;
}

// ── CRUD ─────────────────────────────────────────────────────────

export async function listConnections(): Promise<{ active_id: string | null; metas: ConnectionMeta[] }> {
  const store = await readStore();
  const effectiveActive = resolveActiveId(store);
  return { active_id: effectiveActive, metas: store.connections.map((c) => toMeta(c, effectiveActive)) };
}

export async function getConnection(id: string): Promise<ConnectionRecord | undefined> {
  const store = await readStore();
  return store.connections.find((c) => c.id === id);
}

/** The active connection: explicit active_id, else the first saved (default). */
function resolveActiveId(store: StoreFile): string | null {
  if (store.active_id && store.connections.some((c) => c.id === store.active_id)) return store.active_id;
  return store.connections[0]?.id ?? null;
}

export async function getActiveConnection(): Promise<ConnectionRecord | undefined> {
  const store = await readStore();
  const id = resolveActiveId(store);
  return store.connections.find((c) => c.id === id);
}

export interface AddPostgresInput {
  name: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  sslmode?: string;
}

export interface AddBigQueryInput {
  name: string;
  project_id: string;
  location?: string;
  data_project?: string;
  dataset?: string;
  key_file_path?: string;
}

export interface AddDuckDBInput {
  name: string;
  file_path: string;
}

export interface AddMySQLInput {
  name: string;
  host: string;
  port?: number;
  database: string;
  user: string;
  password: string;
  ssl?: boolean;
}

export interface AddSnowflakeInput {
  name: string;
  account: string;
  username: string;
  warehouse: string;
  database: string;
  schema?: string;
  role?: string;
  password?: string;
  private_key_path?: string;
  private_key_passphrase?: string;
}

export type AddInput =
  | ({ type: "postgres" } & AddPostgresInput)
  | ({ type: "bigquery" } & AddBigQueryInput)
  | ({ type: "duckdb" } & AddDuckDBInput)
  | ({ type: "mysql" } & AddMySQLInput)
  | ({ type: "snowflake" } & AddSnowflakeInput);

export async function addConnection(input: AddInput): Promise<ConnectionMeta> {
  const store = await readStore();
  const id = `conn_${randomUUID().slice(0, 8)}`;
  const created_at = new Date().toISOString();

  let record: ConnectionRecord;
  if (input.type === "postgres") {
    record = {
      id, name: input.name, type: "postgres", created_at,
      host: input.host.trim(),
      port: input.port ?? 5432,
      database: input.database.trim(),
      user: input.user.trim(),
      password: input.password,
      sslmode: (input.sslmode || "no-verify").trim(),
    };
  } else if (input.type === "bigquery") {
    record = {
      id, name: input.name, type: "bigquery", created_at,
      project_id: input.project_id.trim(),
      location: (input.location || "US").trim(),
      ...(input.data_project?.trim() ? { data_project: input.data_project.trim() } : {}),
      ...(input.dataset?.trim() ? { dataset: input.dataset.trim() } : {}),
      ...(input.key_file_path?.trim() ? { key_file_path: input.key_file_path.trim() } : {}),
    };
  } else if (input.type === "duckdb") {
    record = { id, name: input.name, type: "duckdb", created_at, file_path: input.file_path.trim() };
  } else if (input.type === "mysql") {
    record = {
      id, name: input.name, type: "mysql", created_at,
      host: input.host.trim(),
      port: input.port ?? 3306,
      database: input.database.trim(),
      user: input.user.trim(),
      password: input.password,
      ssl: input.ssl ?? false,
    };
  } else {
    record = {
      id, name: input.name, type: "snowflake", created_at,
      account: input.account.trim(),
      username: input.username.trim(),
      warehouse: input.warehouse.trim(),
      database: input.database.trim(),
      schema: (input.schema || "PUBLIC").trim(),
      ...(input.role?.trim() ? { role: input.role.trim() } : {}),
      ...(input.password ? { password: input.password } : {}),
      ...(input.private_key_path?.trim() ? { private_key_path: input.private_key_path.trim() } : {}),
      ...(input.private_key_passphrase ? { private_key_passphrase: input.private_key_passphrase } : {}),
    };
  }

  store.connections.push(record);
  // First connection becomes active automatically.
  if (!store.active_id) store.active_id = record.id;
  await writeStore(store);
  return toMeta(record, resolveActiveId(store));
}

export async function deleteConnection(id: string): Promise<boolean> {
  const store = await readStore();
  const idx = store.connections.findIndex((c) => c.id === id);
  if (idx === -1) return false;
  store.connections.splice(idx, 1);
  if (store.active_id === id) store.active_id = store.connections[0]?.id ?? null;
  await writeStore(store);
  return true;
}

export async function setActiveConnection(id: string): Promise<boolean> {
  const store = await readStore();
  if (!store.connections.some((c) => c.id === id)) return false;
  store.active_id = id;
  await writeStore(store);
  return true;
}

/** Assemble a MySQL connection string from parts (URL-encoded). */
export function toMySQLUrl(r: MySQLRecord): string {
  const user = encodeURIComponent(r.user);
  const pass = encodeURIComponent(r.password);
  const db = encodeURIComponent(r.database);
  const ssl = r.ssl ? "?ssl=true" : "";
  return `mysql://${user}:${pass}@${r.host}:${r.port}/${db}${ssl}`;
}

export interface ResolvedSnowflakeOptions {
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

export interface ResolvedMalloyOptions {
  connectorKind: ConnectorKind;
  postgresUrl?: string;
  /** BigQuery billing/compute project. */
  billingProject?: string;
  /** BigQuery data project (where the dataset lives; defaults to billing). */
  dataProject?: string;
  /** BigQuery dataset. */
  dataset?: string;
  location?: string;
  duckdbPath?: string;
  mysqlUrl?: string;
  snowflake?: ResolvedSnowflakeOptions;
}

/** Build the buildMalloyConnection options for a record (used by test + sync). */
export function recordToMalloyOptions(r: ConnectionRecord): ResolvedMalloyOptions {
  switch (r.type) {
    case "postgres":
      return { connectorKind: "postgres", postgresUrl: toPostgresUrl(r) };
    case "bigquery":
      return {
        connectorKind: "bigquery",
        billingProject: r.project_id,
        dataProject: r.data_project || r.project_id,
        dataset: r.dataset,
        location: r.location,
      };
    case "duckdb":
      return { connectorKind: "duckdb", duckdbPath: r.file_path };
    case "mysql":
      return { connectorKind: "mysql", mysqlUrl: toMySQLUrl(r) };
    case "snowflake":
      return {
        connectorKind: "snowflake",
        snowflake: {
          account: r.account, username: r.username, warehouse: r.warehouse,
          database: r.database, schema: r.schema, role: r.role,
          password: r.password, privateKeyPath: r.private_key_path,
          privateKeyPassphrase: r.private_key_passphrase,
        },
      };
  }
}

export { storePath, configDir };
