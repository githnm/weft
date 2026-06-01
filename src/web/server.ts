/**
 * Weft local web API (Fastify).
 *
 * Thin wrappers over the EXISTING engine functions the CLI/MCP call — so web
 * asks run the same instrumented pipeline (and write the same decision traces).
 * Reads env + substrates exactly like the CLI (via dotenv + the shared config
 * resolvers). Local only.
 *
 *   pnpm web        → tsc, build the client, serve client + API on :4000
 *   pnpm web:api    → tsc, run the API only (use with `pnpm --dir web dev` on :5173)
 *
 * EVERY response is passed through the shared normalizer (src/agent/normalize)
 * before it leaves the API, so BigInt / Date / decimal values from the
 * warehouse can never break JSON serialization (this already bit trace capture).
 */

import "dotenv/config";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import Fastify from "fastify";
import fastifyStatic from "@fastify/static";

import { ask } from "../agent/ask.js";
import type { AskResult } from "../agent/types.js";
import { normalizeValue } from "../agent/normalize.js";
import { estimateCost, formatCost } from "../llm/anthropic.js";
import { formatBytes } from "../mcp/format.js";
import { resolveModelsDir, resolveBillingProject, detectConnectorKind } from "../mcp/config.js";
import { resolveSemanticModelsDir, resolveModelDir, resolveSubstrateDir } from "../models/manifest.js";
import { repoRoot, weftHome } from "../config/home.js";
import { listModels, showModel } from "../models/registry.js";
import { parseModelItems } from "../interview/compile.js";
import { proposeTables, generateDecisionsForTables } from "../interview/plan.js";
import { buildModelWithClarification } from "../interview/build.js";
import { refineModel, saveRefinement } from "../interview/refine.js";
import { bakeDefinition } from "../interview/definitions.js";
import { previewChange, applyChange } from "./model-change.js";
import { buildEntityGraph } from "./context-graph.js";
import { runAgentTurn, resumeAgentAfterWrite, type AgentPending } from "./agent.js";
import type { ResolvedDecision, RelevantTable, RefinementClassification } from "../interview/types.js";
import type { InspectionResult } from "../introspect/types.js";
import { readTraces } from "../context/trace.js";
import { simulateChange } from "../context/simulate.js";
import { loadSession } from "../session/store.js";
import {
  listConnections,
  addConnection,
  deleteConnection,
  getConnection,
  setActiveConnection,
  toPostgresUrl,
  toMySQLUrl,
  connectionSubstrateDir,
} from "../connections/store.js";
import type { ConnectionRecord, AddInput } from "../connections/store.js";
import { testConnectionRecord, explainConnectionError } from "../connections/test.js";
import { syncActiveConnection } from "../connections/runtime.js";
import { createConnector } from "../connectors/factory.js";
import type { Connector } from "../connectors/types.js";
import { runIntrospect } from "../cli/commands/introspect.js";
import { classifyCorrection } from "../correct/classify.js";
import { prepareTermUpdate, applyTermUpdate } from "../correct/term-update.js";
import { prepareModelSuggestion, logModelSuggestion } from "../correct/model-suggest.js";

const PORT = Number(process.env.WEB_PORT ?? 4000);
const BQ_COST_PER_TB = 6.25;

// ── Introspection jobs (async, in-memory; one process serves the UI) ──
// A scan can take minutes on a large dataset, so it runs as a background job
// the UI polls for progress — never a blocking request that would time out.
interface IntrospectJob {
  id: string;
  connectionId: string;
  status: "running" | "done" | "error";
  stage: string;
  message: string;
  tablesTotal: number | null;
  tablesDone: number | null;
  result: {
    substrateDir: string;
    datasetProject: string;
    datasetName: string;
    billingProject: string;
    tableCount: number;
    skippedCount: number;
    bytesScanned: number;
    warnings: string[];
  } | null;
  error: string | null;
  startedAt: string;
  updatedAt: string;
}
const introspectJobs = new Map<string, IntrospectJob>();
const runningJobByConnection = new Map<string, string>();

const here = path.dirname(fileURLToPath(import.meta.url));
const clientDist = path.resolve(here, "../../web/dist");

// ── Directory resolution (mirrors the MCP ask tool) ──────────────

function semanticModelsDir(): string {
  return path.resolve(resolveSemanticModelsDir());
}

/** Resolve the models dir for an ask: a named model, else the substrate. */
function resolveAskDir(modelName?: string): string {
  if (modelName) return path.resolve(resolveModelDir(semanticModelsDir(), modelName));
  return path.resolve(resolveModelsDir());
}

/**
 * The configured substrate directory (no per-request override): $WEFT_HOME/
 * substrate. In normal use a substrate comes from the selected datasource (a
 * per-connection substrate under $WEFT_HOME/substrates/<id>), passed explicitly.
 */
function configuredSubstrateDir(): string {
  return path.resolve(resolveSubstrateDir());
}

/** Resolve the substrate for a design request: explicit body field, else config. */
function resolveSubstrate(explicit?: string): string {
  const e = explicit?.trim();
  return e ? path.resolve(e) : configuredSubstrateDir();
}

function hasInspection(dir: string): boolean {
  return fs.existsSync(path.join(dir, "inspection.json"));
}

/**
 * The model's sources in scope, with their data fields (columns), read from the
 * substrate's inspection.json. This is what the editor's left pane shows so the
 * user can see what's available to reference. Empty on any read failure.
 */
async function modelSources(
  modelDir: string,
  substrateRel: string,
  baseTables: string[],
): Promise<{ name: string; rowCount: number; columns: { name: string; type: string; jsonKeys: number }[] }[]> {
  try {
    const substrateDir = path.resolve(modelDir, substrateRel);
    const raw = await fsp.readFile(path.join(substrateDir, "inspection.json"), "utf-8");
    const inspection = JSON.parse(raw) as InspectionResult;
    const want = new Set(baseTables.map((t) => t.toLowerCase()));
    return inspection.tables
      .filter((t) => want.has(t.name.toLowerCase()))
      .map((t) => ({
        name: t.name,
        rowCount: t.row_count,
        columns: t.columns.map((c) => ({
          name: c.name,
          type: c.type,
          jsonKeys: c.json_keys?.length ?? 0,
        })),
      }));
  } catch {
    return [];
  }
}

function substrateNotFoundMessage(dir: string): string {
  return (
    `No substrate found at "${dir}" — inspection.json is missing there. ` +
    `Pick a datasource and introspect it first (Connections → Introspect), ` +
    `which writes its substrate under $WEFT_HOME. `
  );
}

// ── Map the engine AskResult → the shape the web client renders ──

function toAskResult(r: AskResult, question: string) {
  const refusal = !!(r.feasibility && !r.feasibility.feasible);
  const rows = r.execution?.rows ?? [];
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];

  const semantic = r.verification?.semantic;
  const structuralWarnings = (r.verification?.structuralChecks ?? [])
    .filter((c) => c.severity === "warning")
    .map((c) => c.message);
  const caveats = [...(semantic?.caveats ?? []), ...structuralWarnings];

  const llmCost = estimateCost(r.totalUsage);
  const bytes = r.execution?.bytesScanned;
  const bqCost = bytes ? (bytes / 1024 ** 4) * BQ_COST_PER_TB : 0;

  const di = r.feasibility?.dataIssues;

  return {
    question,
    refusal,
    missingConcepts: refusal ? (r.feasibility?.missingConcepts ?? []) : undefined,
    refusalReason: refusal ? r.feasibility?.reasoning : undefined,
    dataIssues: di ?? undefined,
    source: {
      name: r.source?.sourceName ?? null,
      filename: r.source?.filename ?? null,
      reasoning: r.source?.reasoning ?? null,
    },
    columns,
    rows,
    malloy: r.query?.malloy ?? null,
    explanation: r.query?.explanation ?? null,
    verification: r.verification
      ? {
          intentMatch: semantic?.matchesIntent ?? null,
          confidence: semantic?.confidence ?? null,
          reasoning: semantic?.reasoning ?? null,
          caveats,
        }
      : null,
    meta: {
      rowCount: r.execution?.totalRows ?? rows.length,
      bytesScanned: bytes ?? null,
      bytesLabel: bytes !== undefined ? formatBytes(bytes) : null,
      llmCost,
      bqCost,
      cost: formatCost(llmCost + bqCost),
    },
  };
}

// ── Server ───────────────────────────────────────────────────────

async function buildServer() {
  const app = Fastify({ logger: false });

  // MCP connect — server-computed config block for claude_desktop_config.json.
  // Paths are absolute and correct for THIS install (resolved from the server's
  // own location). Returns just the "weft" server ENTRY to merge into the
  // user's existing mcpServers — never a whole file to clobber. The API key is
  // a placeholder; the real key is never embedded.
  app.get("/api/mcp-config", async () => {
    const serverPath = path.join(repoRoot(), "dist", "mcp", "server.js");
    const placeholderKey = "<your-key-here>";
    const entry = {
      command: "node",
      args: [serverPath],
      env: { ANTHROPIC_API_KEY: placeholderKey },
    };
    // The exact fragment to nest INSIDE the user's "mcpServers": { ... }.
    const blockText = `"weft": ${JSON.stringify(entry, null, 2)}`;
    const configPath =
      process.platform === "darwin"
        ? "~/Library/Application Support/Claude/claude_desktop_config.json"
        : process.platform === "win32"
          ? "%APPDATA%\\Claude\\claude_desktop_config.json"
          : "~/.config/Claude/claude_desktop_config.json";
    return normalizeValue({
      serverName: "weft",
      serverPath,
      serverExists: fs.existsSync(serverPath),
      modelsDir: resolveSemanticModelsDir(),
      weftHome: weftHome(),
      configPath,
      placeholderKey,
      blockText,
    });
  });

  // Health
  app.get("/api/health", async () => {
    const modelsDir = resolveAskDir();
    const substrateDir = configuredSubstrateDir();
    const connector = await detectConnectorKind(modelsDir).catch(() => undefined);
    return normalizeValue({
      ok: true,
      connector: connector ?? null,
      modelsDir,
      substrateDir,
      hasSubstrate: hasInspection(substrateDir),
    });
  });

  // ── Connections — add/manage DB connections from the UI, stored LOCALLY ──
  //
  // Credentials live in a local, gitignored config file and in this server
  // process only. The browser never stores or receives the secret: list/add
  // return METADATA ONLY. Test/use go through the existing connector layer.

  type ConnBody = {
    type?: string;
    name?: string;
    // postgres / mysql
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    sslmode?: string;
    ssl?: boolean;
    // bigquery
    project_id?: string;
    location?: string;
    data_project?: string;
    dataset?: string;
    key_file_path?: string;
    // duckdb
    file_path?: string;
    // snowflake
    account?: string;
    username?: string;
    warehouse?: string;
    schema?: string;
    role?: string;
    private_key_path?: string;
    private_key_passphrase?: string;
  };

  /** Validate a request body into an AddInput (no persistence). */
  function parseConnBody(b: ConnBody): { ok: true; input: AddInput } | { ok: false; error: string } {
    const name = (b.name ?? "").trim();
    if (!name) return { ok: false, error: "name is required" };

    if (b.type === "postgres" || b.type === "mysql") {
      const host = (b.host ?? "").trim();
      const database = (b.database ?? "").trim();
      const user = (b.user ?? "").trim();
      const password = b.password ?? "";
      if (!host) return { ok: false, error: "host is required" };
      if (!database) return { ok: false, error: "database is required" };
      if (!user) return { ok: false, error: "user is required" };
      if (!password) return { ok: false, error: "password is required" };
      if (b.type === "postgres") {
        return { ok: true, input: { type: "postgres", name, host, port: Number(b.port) || 5432, database, user, password, sslmode: (b.sslmode ?? "no-verify").trim() || "no-verify" } };
      }
      return { ok: true, input: { type: "mysql", name, host, port: Number(b.port) || 3306, database, user, password, ssl: !!b.ssl } };
    }

    if (b.type === "bigquery") {
      const project_id = (b.project_id ?? "").trim();
      if (!project_id) return { ok: false, error: "project_id is required" };
      return {
        ok: true,
        input: {
          type: "bigquery", name, project_id,
          location: (b.location ?? "US").trim() || "US",
          data_project: b.data_project?.trim() || undefined,
          dataset: b.dataset?.trim() || undefined,
          key_file_path: b.key_file_path?.trim() || undefined,
        },
      };
    }

    if (b.type === "duckdb") {
      const file_path = (b.file_path ?? "").trim();
      if (!file_path) return { ok: false, error: "file_path is required (point at a .duckdb file or a Parquet/CSV)" };
      return { ok: true, input: { type: "duckdb", name, file_path } };
    }

    if (b.type === "snowflake") {
      const account = (b.account ?? "").trim();
      const username = (b.username ?? "").trim();
      const warehouse = (b.warehouse ?? "").trim();
      const database = (b.database ?? "").trim();
      if (!account) return { ok: false, error: "account is required" };
      if (!username) return { ok: false, error: "username is required" };
      if (!warehouse) return { ok: false, error: "warehouse is required" };
      if (!database) return { ok: false, error: "database is required" };
      if (!b.password && !b.private_key_path?.trim()) {
        return { ok: false, error: "provide a password OR a private key path (key-pair auth)" };
      }
      return {
        ok: true,
        input: {
          type: "snowflake", name, account, username, warehouse, database,
          schema: (b.schema ?? "PUBLIC").trim() || "PUBLIC",
          role: b.role?.trim() || undefined,
          password: b.password || undefined,
          private_key_path: b.private_key_path?.trim() || undefined,
          private_key_passphrase: b.private_key_passphrase || undefined,
        },
      };
    }

    return { ok: false, error: "type must be one of: postgres, mysql, bigquery, duckdb, snowflake" };
  }

  /** Build a transient (unsaved) ConnectionRecord from an AddInput, for /test. */
  function candidateRecord(input: AddInput): ConnectionRecord {
    const base = { id: "_candidate", created_at: "" };
    switch (input.type) {
      case "postgres":
        return { ...base, name: input.name, type: "postgres", host: input.host, port: input.port ?? 5432, database: input.database, user: input.user, password: input.password, sslmode: input.sslmode || "no-verify" };
      case "mysql":
        return { ...base, name: input.name, type: "mysql", host: input.host, port: input.port ?? 3306, database: input.database, user: input.user, password: input.password, ssl: input.ssl ?? false };
      case "bigquery":
        return { ...base, name: input.name, type: "bigquery", project_id: input.project_id, location: input.location || "US", data_project: input.data_project, dataset: input.dataset, key_file_path: input.key_file_path };
      case "duckdb":
        return { ...base, name: input.name, type: "duckdb", file_path: input.file_path };
      case "snowflake":
        return { ...base, name: input.name, type: "snowflake", account: input.account, username: input.username, warehouse: input.warehouse, database: input.database, schema: input.schema || "PUBLIC", role: input.role, password: input.password, private_key_path: input.private_key_path, private_key_passphrase: input.private_key_passphrase };
    }
  }

  // GET — metadata ONLY (never the password). Enriched with each connection's
  // own substrate dir + whether it's been introspected (has inspection.json),
  // so the model builder can show a datasource selector with ready/not state.
  app.get("/api/connections", async () => {
    const { active_id, metas } = await listConnections();
    const enriched = await Promise.all(
      metas.map(async (m) => {
        const dir = connectionSubstrateDir(m.id);
        let hasSubstrate = false;
        try {
          await fsp.access(path.join(dir, "inspection.json"));
          hasSubstrate = true;
        } catch {
          /* not introspected yet */
        }
        return { ...m, substrateDir: dir, hasSubstrate };
      }),
    );
    return normalizeValue({ activeId: active_id, connections: enriched });
  });

  // POST — add a connection; persists locally, returns metadata only.
  app.post<{ Body: ConnBody }>("/api/connections", async (req, reply) => {
    const parsed = parseConnBody(req.body ?? {});
    if (!parsed.ok) {
      reply.code(400);
      return { error: parsed.error };
    }
    const meta = await addConnection(parsed.input);
    await syncActiveConnection(); // make it usable by the rest of the app
    return normalizeValue(meta);
  });

  // POST /test — test an UNSAVED candidate (the form's "Test connection").
  app.post<{ Body: ConnBody }>("/api/connections/test", async (req, reply) => {
    const parsed = parseConnBody(req.body ?? {});
    if (!parsed.ok) {
      reply.code(400);
      return { error: parsed.error };
    }
    return normalizeValue(await testConnectionRecord(candidateRecord(parsed.input)));
  });

  // POST /:id/test — test a SAVED connection (the card's "Test").
  app.post<{ Params: { id: string } }>("/api/connections/:id/test", async (req, reply) => {
    const record = await getConnection(req.params.id);
    if (!record) {
      reply.code(404);
      return { error: "Connection not found." };
    }
    return normalizeValue(await testConnectionRecord(record));
  });

  // POST /:id/activate — make this the active connection for the app.
  app.post<{ Params: { id: string } }>("/api/connections/:id/activate", async (req, reply) => {
    const ok = await setActiveConnection(req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "Connection not found." };
    }
    await syncActiveConnection();
    return normalizeValue({ activated: req.params.id });
  });

  // POST /:id/introspect — START a background introspection job for this
  // connection and return immediately with a job id. The actual scan can take
  // minutes; the client polls /api/introspect/:jobId/status for live progress.
  // For BigQuery this uses the THREE-project split: data project (where the
  // dataset lives) + dataset for the SOURCE, billing project for COMPUTE.
  app.post<{ Params: { id: string }; Body: { sample_rows?: number } }>(
    "/api/connections/:id/introspect",
    async (req, reply) => {
      const record = await getConnection(req.params.id);
      if (!record) {
        reply.code(404);
        return { error: "Connection not found." };
      }
      if (record.type === "bigquery" && !record.dataset?.trim()) {
        reply.code(400);
        return { error: "This BigQuery connection has no dataset. Edit it and set the Dataset to introspect." };
      }

      // Coalesce double-clicks: if a scan is already running, return its id.
      const existingId = runningJobByConnection.get(record.id);
      if (existingId && introspectJobs.get(existingId)?.status === "running") {
        return normalizeValue({ jobId: existingId });
      }

      const jobId = `job_${randomUUID().slice(0, 8)}`;
      const now = new Date().toISOString();
      const job: IntrospectJob = {
        id: jobId,
        connectionId: record.id,
        status: "running",
        stage: "connecting",
        message: "Connecting to the warehouse…",
        tablesTotal: null,
        tablesDone: null,
        result: null,
        error: null,
        startedAt: now,
        updatedAt: now,
      };
      introspectJobs.set(jobId, job);
      runningJobByConnection.set(record.id, jobId);

      const outputDir = connectionSubstrateDir(record.id);
      const sampleRows = Number(req.body?.sample_rows) || 1000;

      const onProgress = (p: { stage: string; message: string; tablesTotal?: number; tablesDone?: number }) => {
        const j = introspectJobs.get(jobId);
        if (!j) return;
        j.stage = p.stage;
        j.message = p.message;
        if (p.tablesTotal !== undefined) j.tablesTotal = p.tablesTotal;
        if (p.tablesDone !== undefined) j.tablesDone = p.tablesDone;
        j.updatedAt = new Date().toISOString();
      };

      // Run in the background — do NOT await. The request returns right away.
      void (async () => {
        let connector: Connector | undefined;
        let restoreCreds: (() => void) | null = null;
        try {
          if (record.type === "bigquery") {
            if (record.key_file_path) {
              const prev = process.env.GOOGLE_APPLICATION_CREDENTIALS;
              process.env.GOOGLE_APPLICATION_CREDENTIALS = record.key_file_path;
              restoreCreds = () => {
                if (prev === undefined) delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
                else process.env.GOOGLE_APPLICATION_CREDENTIALS = prev;
              };
            }
            connector = createConnector({
              kind: "bigquery",
              project: record.data_project?.trim() || record.project_id, // DATA project (source)
              dataset: record.dataset!.trim(),
              billingProject: record.project_id, // BILLING project (compute)
              location: record.location,
            });
          } else if (record.type === "postgres") {
            connector = createConnector({ kind: "postgres", connectionString: toPostgresUrl(record), schema: "public" });
          } else if (record.type === "mysql") {
            connector = createConnector({ kind: "mysql", connectionString: toMySQLUrl(record) });
          } else if (record.type === "duckdb") {
            connector = createConnector({ kind: "duckdb", filePath: record.file_path });
          } else {
            connector = createConnector({
              kind: "snowflake",
              account: record.account, username: record.username, warehouse: record.warehouse,
              database: record.database, schema: record.schema, role: record.role,
              password: record.password, privateKeyPath: record.private_key_path,
              privateKeyPassphrase: record.private_key_passphrase,
            });
          }

          await runIntrospect(connector, outputDir, { sampleRows, onProgress });
          await connector.close().catch(() => {});

          const insp = JSON.parse(await fsp.readFile(path.join(outputDir, "inspection.json"), "utf-8")) as InspectionResult;
          const j = introspectJobs.get(jobId);
          if (j) {
            j.status = "done";
            j.stage = "done";
            j.message = `Ready — ${insp.tables.length} table${insp.tables.length === 1 ? "" : "s"} introspected.`;
            j.tablesDone = j.tablesTotal ?? insp.tables.length;
            j.result = {
              substrateDir: outputDir,
              datasetProject: insp.dataset_project,
              datasetName: insp.dataset_name,
              billingProject: insp.billing_project,
              tableCount: insp.tables.length,
              skippedCount: insp.skipped_tables.length,
              bytesScanned: insp.bytes_scanned,
              warnings: insp.warnings ?? [],
            };
            j.updatedAt = new Date().toISOString();
          }
        } catch (err) {
          await connector?.close?.().catch(() => {});
          const j = introspectJobs.get(jobId);
          if (j) {
            j.status = "error";
            j.error = explainConnectionError(err);
            j.message = "Introspection failed.";
            j.updatedAt = new Date().toISOString();
          }
        } finally {
          restoreCreds?.();
          if (runningJobByConnection.get(record.id) === jobId) runningJobByConnection.delete(record.id);
        }
      })();

      reply.code(202);
      return normalizeValue({ jobId });
    },
  );

  // GET /api/introspect/:jobId/status — poll an introspection job's progress.
  app.get<{ Params: { jobId: string } }>("/api/introspect/:jobId/status", async (req, reply) => {
    const job = introspectJobs.get(req.params.jobId);
    if (!job) {
      reply.code(404);
      return { error: "Job not found." };
    }
    return normalizeValue({
      id: job.id,
      connectionId: job.connectionId,
      status: job.status,
      stage: job.stage,
      message: job.message,
      tablesTotal: job.tablesTotal,
      tablesDone: job.tablesDone,
      result: job.result,
      error: job.error,
    });
  });

  // DELETE — remove from the local config file.
  app.delete<{ Params: { id: string } }>("/api/connections/:id", async (req, reply) => {
    const ok = await deleteConnection(req.params.id);
    if (!ok) {
      reply.code(404);
      return { error: "Connection not found." };
    }
    await syncActiveConnection();
    return normalizeValue({ deleted: req.params.id });
  });

  // List models
  app.get("/api/models", async (_req, reply) => {
    try {
      const dir = semanticModelsDir();
      const models = await listModels(dir);
      const out = await Promise.all(
        models.map(async (m) => {
          let measureCount = 0;
          try {
            const malloy = await fsp.readFile(path.join(dir, m.name, "model.malloy"), "utf-8");
            measureCount = parseModelItems(malloy).filter((i) => i.kind === "measure").length;
          } catch {
            /* model.malloy may not exist */
          }
          return {
            name: m.name,
            purpose: m.purpose,
            tableCount: m.tables.length,
            measureCount,
            connector: m.connector_kind ?? null,
          };
        }),
      );
      return normalizeValue(out);
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Model detail
  app.get<{ Params: { name: string } }>("/api/models/:name", async (req, reply) => {
    try {
      const dir = semanticModelsDir();
      const detail = await showModel(dir, req.params.name);
      const malloy = await fsp.readFile(path.join(detail.dir, "model.malloy"), "utf-8").catch(() => "");
      const items = parseModelItems(malloy);
      const views = [...malloy.matchAll(/^\s*view:\s+(\w+)\s+is\s+\{/gm)].map((m) => m[1]);
      const sources = await modelSources(detail.dir, detail.manifest.substrate_dir, detail.manifest.base_tables);
      return normalizeValue({
        name: detail.name,
        purpose: detail.purpose,
        connector: detail.connector_kind ?? null,
        datasource: detail.manifest.datasource ?? null,
        measures: items.filter((i) => i.kind === "measure").map((i) => ({ name: i.name, expr: i.expr })),
        dimensions: items.filter((i) => i.kind === "dimension").map((i) => ({ name: i.name, expr: i.expr })),
        views,
        malloy,
        decisions: detail.manifest.design?.decisions ?? [],
        // Baked business definitions (concepts + their explicit aliases) — the
        // meaningful, queryable vocabulary, shown distinctly in the left pane.
        concepts: (detail.manifest.concepts ?? []).map((c) => ({
          canonical_name: c.canonical_name,
          aliases: c.aliases,
          field: c.field,
          kind: c.kind,
          filter: c.filter ?? null,
        })),
        // Sources in scope + their fields, so the user sees what's referenceable.
        sources,
      });
    } catch (err) {
      reply.code(404);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Delete a model — HARD delete, local only. Destructive and irreversible, so
  // the path-safety checks are strict: we only ever remove a directory that is
  // a DIRECT child of the semantic-models dir (no "..", no separators, no
  // absolute escape, no symlink traversal) AND is actually a model (has
  // model.json / model.malloy). Never touches the substrate or anything else.
  app.delete<{ Params: { name: string } }>("/api/models/:name", async (req, reply) => {
    const name = req.params.name;
    try {
      // Resolve the SAME way GET /api/models/:name does: under the configured
      // semantic-models dir via resolveModelDir, then absolutize.
      const baseDir = path.resolve(semanticModelsDir());
      const resolved = path.resolve(resolveModelDir(baseDir, name));

      // ── Path safety (defense in depth) ──
      // 1. The raw name must not carry traversal or path separators.
      if (
        !name ||
        name.includes("/") ||
        name.includes("\\") ||
        name.split(/[\\/]/).includes("..") ||
        name === "." ||
        name === ".." ||
        path.isAbsolute(name)
      ) {
        reply.code(400);
        return { error: `Refused: invalid model name "${name}".` };
      }

      // 2. The resolved path must be a DIRECT child of the semantic-models dir
      //    (exactly one level deep — no nesting, no escape).
      const rel = path.relative(baseDir, resolved);
      const isDirectChild =
        rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel) && !rel.includes(path.sep);
      if (!isDirectChild) {
        reply.code(400);
        return {
          error: `Refused: "${name}" does not resolve to a model directly inside the semantic-models directory.`,
        };
      }

      // 3. No symlink traversal: the REAL path must still be a direct child of
      //    the real semantic-models dir. (A model dir that is a symlink to
      //    somewhere outside resolves out and is refused — we never rm it.)
      let realPath: string;
      try {
        realPath = await fsp.realpath(resolved);
      } catch {
        reply.code(404);
        return { error: `Model "${name}" not found.` };
      }
      const realBase = await fsp.realpath(baseDir).catch(() => baseDir);
      const realRel = path.relative(realBase, realPath);
      if (
        realRel === "" ||
        realRel.startsWith("..") ||
        path.isAbsolute(realRel) ||
        realRel.includes(path.sep)
      ) {
        reply.code(400);
        return {
          error: `Refused: "${name}" resolves outside the semantic-models directory (symlink?).`,
        };
      }

      // 4. Confirm it's actually a model directory before removing anything, so
      //    a bad name can't delete an unrelated dir.
      const stat = await fsp.stat(realPath).catch(() => null);
      if (!stat?.isDirectory()) {
        reply.code(404);
        return { error: `Model "${name}" not found.` };
      }
      const isModel =
        fs.existsSync(path.join(realPath, "model.json")) ||
        fs.existsSync(path.join(realPath, "model.malloy"));
      if (!isModel) {
        reply.code(400);
        return {
          error: `Refused: "${name}" is not a model directory (no model.json / model.malloy).`,
        };
      }

      // ── Remove exactly this one model directory (model.malloy, manifest,
      //    metadata, terms/corrections, traces.jsonl). Substrate untouched. ──
      await fsp.rm(realPath, { recursive: true, force: true });
      return normalizeValue({ deleted: name });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Ask — SSE stream of stage events + a final `done` event with the AskResult.
  // A refusal is a normal `done` (refusal:true), never an error. Only real
  // failures emit an `error` event. The server never crashes on a bad query.
  app.post<{ Body: { question?: string; model_name?: string } }>("/api/ask", async (req, reply) => {
    const question = (req.body?.question ?? "").trim();
    const modelName = req.body?.model_name;

    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    const send = (event: string, data: unknown) => {
      res.write(`event: ${event}\n`);
      res.write(`data: ${JSON.stringify(normalizeValue(data))}\n\n`);
    };

    try {
      if (!question) {
        send("error", { error: "question is required" });
        return;
      }
      const modelsDir = resolveAskDir(modelName);
      const connectorKind = await detectConnectorKind(modelsDir).catch(() => undefined);
      const billingProject = resolveBillingProject();
      if (connectorKind === "bigquery" && !billingProject) {
        send("error", {
          error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID.",
        });
        return;
      }

      const result = await ask({
        question,
        modelsDir,
        billingProject,
        onStage: (e) => send("stage", e),
      });
      send("done", toAskResult(result, question));
    } catch (err) {
      // Real failure (e.g. query failed to compile/execute after retry).
      send("error", { error: err instanceof Error ? err.message : String(err) });
    } finally {
      res.end();
    }
  });

  // Correct — reuses the instrumented correction flow (writes a correction trace).
  app.post<{ Body: { correction_text?: string; model_name?: string } }>(
    "/api/correct",
    async (req, reply) => {
      const correctionText = (req.body?.correction_text ?? "").trim();
      const modelName = req.body?.model_name;
      if (!correctionText) {
        reply.code(400);
        return { error: "correction_text is required" };
      }
      try {
        const modelsDir = resolveAskDir(modelName);
        const billingProject = resolveBillingProject();
        const session = await loadSession(modelsDir);
        const classification = await classifyCorrection(correctionText, modelsDir, session);

        if (classification.confidence === "low" || classification.type === "unclear") {
          return normalizeValue({ type: "unclear", reasoning: classification.reasoning });
        }

        if (classification.type === "term_update") {
          const termName = classification.target.termName;
          if (!termName) {
            return normalizeValue({ type: "unclear", reasoning: classification.reasoning });
          }
          const result = await prepareTermUpdate({
            termName,
            correctionText,
            proposedNewFilter: classification.proposedChange.new,
            modelsDir,
            billingProject,
            session,
          });
          await applyTermUpdate({
            result,
            correctionText,
            modelsDir,
            session,
            reasoning: classification.reasoning,
          });
          return normalizeValue({
            type: "term_update",
            termName: result.termName,
            oldFilter: result.oldFilter,
            newFilter: result.newFilter,
            impact: result.impact,
            correctionId: result.correctionId,
            reasoning: classification.reasoning,
          });
        }

        if (classification.type === "model_suggestion") {
          const targetFile = classification.target.file ?? session?.last_source;
          if (!targetFile) {
            return normalizeValue({
              type: "unclear",
              reasoning: "Could not determine which file to edit.",
            });
          }
          const result = await prepareModelSuggestion({
            correctionText,
            targetFile,
            modelsDir,
            billingProject,
            session,
          });
          await logModelSuggestion({ result, correctionText, modelsDir, session, reasoning: classification.reasoning });
          return normalizeValue({
            type: "model_suggestion",
            targetFile: result.targetFile,
            findLine: result.findLine,
            replaceLine: result.replaceLine,
            compileOk: result.compileOk,
            correctionId: result.correctionId,
            reasoning: classification.reasoning,
          });
        }

        if (classification.type === "new_term") {
          return normalizeValue({
            type: "new_term",
            name: classification.target.newTermName ?? null,
            reasoning: classification.reasoning,
          });
        }

        return normalizeValue({ type: classification.type, reasoning: classification.reasoning });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Design — step 1: propose TABLES only (relevant + excluded).
  // Decisions are intentionally NOT generated here. They are generated in step
  // 1.5 (/decisions) from the user's FINALIZED table set, so they never
  // reference a dropped table or miss an added one.
  app.post<{ Body: { name?: string; purpose?: string; substrate_dir?: string; tables?: string[] } }>(
    "/api/models/design/plan",
    async (req, reply) => {
      const purpose = (req.body?.purpose ?? "").trim();
      if (!purpose) {
        reply.code(400);
        return { error: "purpose is required" };
      }
      try {
        const substrateDir = resolveSubstrate(req.body?.substrate_dir);
        if (!hasInspection(substrateDir)) {
          reply.code(400);
          return { error: substrateNotFoundMessage(substrateDir) };
        }
        const plan = await proposeTables(purpose, substrateDir);

        // Optional constraint: "use only these tables".
        let relevant = plan.relevant_tables;
        let excluded = plan.excluded_tables_count;
        const tables = req.body?.tables;
        if (Array.isArray(tables) && tables.length > 0) {
          const allow = new Set(tables.map((t) => t.toLowerCase()));
          const kept = relevant.filter((t) => allow.has(t.name.toLowerCase()));
          if (kept.length > 0) {
            excluded += relevant.length - kept.length;
            relevant = kept;
          }
        }

        // FULL table list — every table in the substrate, flagged proposed/not,
        // with row+column counts. The UI shows ALL of them (selected + excluded)
        // so the user can override the AI's recommendation.
        let allTables: { name: string; rowCount: number; columnCount: number; proposed: boolean; reason: string }[] = [];
        try {
          const insp = JSON.parse(await fsp.readFile(path.join(substrateDir, "inspection.json"), "utf-8")) as InspectionResult;
          const proposedReason = new Map(relevant.map((t) => [t.name.toLowerCase(), t.reason ?? ""]));
          allTables = insp.tables
            .map((t) => ({
              name: t.name,
              rowCount: t.row_count,
              columnCount: t.columns.length,
              proposed: proposedReason.has(t.name.toLowerCase()),
              reason: proposedReason.get(t.name.toLowerCase()) ?? "",
            }))
            // Proposed first, then alphabetical — stable, scannable order.
            .sort((a, b) => Number(b.proposed) - Number(a.proposed) || a.name.localeCompare(b.name));
        } catch {
          /* fall back to relevantTables only if inspection is unreadable */
        }

        return normalizeValue({
          name: req.body?.name ?? "",
          purpose,
          substrateDir,
          relevantTables: relevant,
          excludedCount: excluded,
          allTables,
          tableSelectionReasoning: plan.table_selection_reasoning,
          // Decisions are generated later, from the finalized table set.
          decisions: [],
        });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Design — step 1.5: generate decisions FROM the user's finalized table set.
  // Called when the user clicks Continue on the Tables step. The decisions are
  // built from EXACTLY the tables passed in (proposed minus dropped plus added),
  // so dropped tables can never appear in an option and added tables are
  // considered. Regenerated whenever the finalized set changes.
  app.post<{ Body: { purpose?: string; substrate_dir?: string; tables?: string[] } }>(
    "/api/models/design/decisions",
    async (req, reply) => {
      const purpose = (req.body?.purpose ?? "").trim();
      if (!purpose) {
        reply.code(400);
        return { error: "purpose is required" };
      }
      const tables = (req.body?.tables ?? []).map((t) => `${t}`.trim()).filter(Boolean);
      if (tables.length === 0) {
        reply.code(400);
        return { error: "at least one table must be selected" };
      }
      try {
        const substrateDir = resolveSubstrate(req.body?.substrate_dir);
        if (!hasInspection(substrateDir)) {
          reply.code(400);
          return { error: substrateNotFoundMessage(substrateDir) };
        }
        const { decisions } = await generateDecisionsForTables(purpose, substrateDir, tables);
        return normalizeValue({
          decisions: decisions.map((d) => ({
            id: d.id,
            question: d.question,
            explanation: d.why_it_matters,
            allowCustom: d.allow_custom,
            options: d.options.map((o) => ({
              label: o.label,
              description: o.detail,
              recommended: o.recommended,
            })),
          })),
        });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Design — step 2: build with the user's resolved decisions. Runs the build
  // contract + post-build clarification loop (capped at 2 rounds). Surfaces
  // failures honestly; a refusal/incomplete is a normal 200, not an error.
  app.post<{
    Body: {
      name?: string;
      purpose?: string;
      resolved_decisions?: { decision_id?: string; id?: string; chosen: string }[];
      relevant_tables?: { name: string; reason?: string }[];
      tables?: string[];
      definitions?: string[];
      substrate_dir?: string;
      semantic_models_dir?: string;
      clarifications?: { question: string; answer: string }[];
      /** Human label of the datasource (connection) this model is built from. */
      datasource?: string;
    };
  }>("/api/models/design/build", async (req, reply) => {
    const name = (req.body?.name ?? "").trim();
    const purpose = (req.body?.purpose ?? "").trim();
    if (!name || !purpose) {
      reply.code(400);
      return { error: "name and purpose are required" };
    }
    try {
      const substrateDir = resolveSubstrate(req.body?.substrate_dir);
      if (!hasInspection(substrateDir)) {
        reply.code(400);
        return { error: substrateNotFoundMessage(substrateDir) };
      }
      const semDir = path.resolve(req.body?.semantic_models_dir ?? resolveSemanticModelsDir());
      const connectorKind = await detectConnectorKind(substrateDir).catch(() => undefined);
      const billingProject = resolveBillingProject();
      if (connectorKind === "bigquery" && !billingProject) {
        reply.code(400);
        return { error: "billing_project is required for BigQuery substrates. Set BQ_PROJECT_ID." };
      }

      const relevantTables: RelevantTable[] =
        req.body?.relevant_tables?.map((t) => ({ name: t.name, reason: t.reason ?? "" })) ??
        req.body?.tables?.map((t) => ({ name: t, reason: "" })) ??
        [];
      const decisions: ResolvedDecision[] = (req.body?.resolved_decisions ?? []).map((d) => ({
        decision_id: d.decision_id ?? d.id ?? "",
        chosen: d.chosen,
      }));
      const clarifications = req.body?.clarifications ?? [];

      const result = await buildModelWithClarification({
        name,
        purpose,
        substrateDir,
        semanticModelsDir: semDir,
        billingProject,
        decisions,
        relevantTables,
        definitions: req.body?.definitions ?? [],
        clarifications,
        surfaceQuestions: clarifications.length === 0,
        maxClarifyRounds: 2,
      });

      // Record which datasource this model was built from (provenance). Patched
      // directly onto the manifest so we don't thread it through the whole build.
      const datasource = req.body?.datasource?.trim();
      if (datasource && result.model_dir) {
        try {
          const manifestPath = path.join(result.model_dir, "model.json");
          const manifest = JSON.parse(await fsp.readFile(manifestPath, "utf-8"));
          manifest.datasource = datasource;
          await fsp.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf-8");
        } catch {
          /* provenance is best-effort — never fail the build over it */
        }
      }

      return normalizeValue({
        success: result.success,
        incomplete: !!result.incomplete,
        modelName: name,
        modelDir: result.model_dir ?? null,
        measuresCount: result.measures_count ?? 0,
        dimensionsCount: result.dimensions_count ?? 0,
        viewsCount: result.views_count ?? 0,
        failedItems: result.failed_items ?? [],
        unmetDecisions: result.unmet_decisions ?? [],
        dataWarnings: result.data_warnings ?? [],
        clarificationsNeeded: result.clarifications_needed ?? [],
        compileWarning: result.compile_warning ?? null,
        modelMalloy: result.model_malloy ?? null,
        error: result.error ?? null,
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Refine / add-a-definition — bake a plain-English change into model.malloy.
  // Used by the Models screen ("add definition") and by promoting a correction
  // to a permanent definition. Thin wrapper over refineModel + saveRefinement.
  app.post<{ Params: { model: string }; Body: { change?: string; semantic_models_dir?: string } }>(
    "/api/models/:model/refine",
    async (req, reply) => {
      const change = (req.body?.change ?? "").trim();
      if (!change) {
        reply.code(400);
        return { error: "change is required" };
      }
      try {
        const semDir = path.resolve(req.body?.semantic_models_dir ?? resolveSemanticModelsDir());
        const modelDir = path.resolve(resolveModelDir(semDir, req.params.model));
        const connectorKind = await detectConnectorKind(modelDir).catch(() => undefined);
        const billingProject = resolveBillingProject();
        if (connectorKind === "bigquery" && !billingProject) {
          reply.code(400);
          return { error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID." };
        }

        const result = await refineModel({
          modelName: req.params.model,
          semanticModelsDir: semDir,
          refinement: change,
          billingProject,
        });

        if (!result.success) {
          return normalizeValue({
            applied: false,
            changeType: result.classification?.change_type ?? null,
            target: result.classification?.target ?? null,
            reason: result.classification?.reasoning ?? null,
            error: result.error ?? null,
            draftMalloy: result.draft_malloy ?? null,
          });
        }

        // "Already satisfied" — refine returns success with identical content.
        const noChange =
          !!result.new_malloy && !!result.old_malloy && result.new_malloy === result.old_malloy;
        if (noChange) {
          return normalizeValue({
            applied: false,
            noChange: true,
            changeType: result.classification.change_type,
            target: result.classification.target,
            reason: result.diff_summary ?? result.classification.reasoning,
          });
        }

        await saveRefinement({
          modelName: req.params.model,
          semanticModelsDir: semDir,
          newMalloy: result.new_malloy!,
          refinement: change,
          classification: result.classification,
        });

        return normalizeValue({
          applied: true,
          changeType: result.classification.change_type,
          target: result.classification.target,
          diffSummary: result.diff_summary ?? null,
          compileWarning: result.compile_warning ?? null,
          modelMalloy: result.new_malloy ?? null,
        });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Add a definition (concept + explicit aliases) — baked into model.malloy and
  // recorded in the manifest. Used by the Definitions step, the "Add a
  // definition" card, and promoting a correction to a permanent definition.
  app.post<{
    Params: { model: string };
    Body: { definition?: string; aliases?: string[]; canonical_name?: string; semantic_models_dir?: string };
  }>("/api/models/:model/definition", async (req, reply) => {
    const definition = (req.body?.definition ?? "").trim();
    if (!definition) {
      reply.code(400);
      return { error: "definition is required" };
    }
    try {
      const semDir = path.resolve(req.body?.semantic_models_dir ?? resolveSemanticModelsDir());
      const modelDir = path.resolve(resolveModelDir(semDir, req.params.model));
      const connectorKind = await detectConnectorKind(modelDir).catch(() => undefined);
      const billingProject = resolveBillingProject();
      if (connectorKind === "bigquery" && !billingProject) {
        reply.code(400);
        return { error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID." };
      }
      // Only owner-confirmed aliases reach here; the server never invents any.
      const aliases = Array.isArray(req.body?.aliases)
        ? req.body!.aliases.map((a) => String(a).trim()).filter(Boolean)
        : [];

      const result = await bakeDefinition({
        modelName: req.params.model,
        semanticModelsDir: semDir,
        definition,
        aliases,
        canonicalName: req.body?.canonical_name,
        billingProject,
      });

      return normalizeValue({
        applied: result.applied,
        noChange: !!result.noChange,
        concept: result.concept ?? null,
        changeType: result.changeType ?? null,
        target: result.target ?? null,
        diffSummary: result.diffSummary ?? null,
        compileWarning: result.compileWarning ?? null,
        modelMalloy: result.modelMalloy ?? null,
        reason: result.reason ?? null,
        error: result.error ?? null,
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── One conversational surface: propose → confirm → apply ────────
  //
  // The editor's right pane sends ONE plain-language string. The system ROUTES
  // it (define / add-measure / refine / correct) via the existing refine
  // classifier — the user never picks a function. `propose` previews the change
  // (the proposed Malloy + structured diff, grounded against the schema) WITHOUT
  // writing. `apply` commits exactly what was previewed (no second LLM round),
  // baking it into model.malloy via saveRefinement and recording the concept +
  // aliases when it's a definition. Everything goes through the build contract
  // (refineModel compile-checks; a failure is reported, the model untouched).

  app.post<{ Params: { model: string }; Body: { text?: string } }>(
    "/api/models/:model/propose",
    async (req, reply) => {
      const text = (req.body?.text ?? "").trim();
      if (!text) {
        reply.code(400);
        return { error: "text is required" };
      }
      try {
        const semDir = semanticModelsDir();
        const modelDir = path.resolve(resolveModelDir(semDir, req.params.model));
        const connectorKind = await detectConnectorKind(modelDir).catch(() => undefined);
        const billingProject = resolveBillingProject();
        if (connectorKind === "bigquery" && !billingProject) {
          reply.code(400);
          return { error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID." };
        }
        const preview = await previewChange({ modelName: req.params.model, semanticModelsDir: semDir, billingProject, text });
        return normalizeValue(preview);
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{
    Params: { model: string };
    Body: {
      text?: string;
      new_malloy?: string;
      classification?: RefinementClassification;
      is_definition?: boolean;
      canonical_name?: string;
      aliases?: string[];
    };
  }>("/api/models/:model/apply", async (req, reply) => {
    const text = (req.body?.text ?? "").trim();
    const newMalloy = req.body?.new_malloy;
    const classification = req.body?.classification;
    if (!text || !newMalloy || !classification) {
      reply.code(400);
      return { error: "text, new_malloy and classification are required" };
    }
    try {
      const semDir = semanticModelsDir();
      const result = await applyChange({
        modelName: req.params.model,
        semanticModelsDir: semDir,
        text,
        newMalloy,
        classification,
        isDefinition: req.body?.is_definition,
        canonicalName: req.body?.canonical_name,
        aliases: req.body?.aliases,
      });
      return normalizeValue({ applied: true, concept: result.concept });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // ── Conversational model-building agent ──────────────────────────
  //
  // A tool-using LLM with the engine's tools + the honesty contract: READ
  // tools run freely; the WRITE tool PAUSES the loop and returns a confirmable
  // proposal (`pending`) — the model is NOT mutated until the user confirms via
  // /agent/confirm. Conversation history is opaque + held client-side (echoed
  // back each turn), keeping the server stateless.

  async function agentBillingGuard(model: string, reply: import("fastify").FastifyReply): Promise<string | undefined | null> {
    const modelDir = path.resolve(resolveModelDir(semanticModelsDir(), model));
    const connectorKind = await detectConnectorKind(modelDir).catch(() => undefined);
    const billingProject = resolveBillingProject();
    if (connectorKind === "bigquery" && !billingProject) {
      reply.code(400);
      return null; // signal: blocked
    }
    return billingProject;
  }

  app.post<{ Params: { model: string }; Body: { messages?: unknown[]; userText?: string } }>(
    "/api/models/:model/agent",
    async (req, reply) => {
      const userText = (req.body?.userText ?? "").trim();
      if (!userText) {
        reply.code(400);
        return { error: "userText is required" };
      }
      const billingProject = await agentBillingGuard(req.params.model, reply);
      if (billingProject === null) return { error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID." };
      try {
        const result = await runAgentTurn({
          modelName: req.params.model,
          semanticModelsDir: semanticModelsDir(),
          billingProject: billingProject ?? undefined,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          messages: (req.body?.messages ?? []) as any,
          userText,
        });
        return normalizeValue({
          messages: result.messages,
          events: result.events,
          pending: result.pending,
        });
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  app.post<{
    Params: { model: string };
    Body: {
      messages?: unknown[];
      toolUseId?: string;
      decision?: "confirm" | "reject";
      apply?: AgentPending; // the previewed proposal, echoed back on confirm
    };
  }>("/api/models/:model/agent/confirm", async (req, reply) => {
    const toolUseId = req.body?.toolUseId;
    const decision = req.body?.decision;
    if (!toolUseId || (decision !== "confirm" && decision !== "reject")) {
      reply.code(400);
      return { error: "toolUseId and decision ('confirm' | 'reject') are required" };
    }
    if (decision === "confirm" && !req.body?.apply) {
      reply.code(400);
      return { error: "apply payload is required to confirm" };
    }
    const billingProject = await agentBillingGuard(req.params.model, reply);
    if (billingProject === null) return { error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID." };
    try {
      const p = req.body?.apply;
      const result = await resumeAgentAfterWrite({
        modelName: req.params.model,
        semanticModelsDir: semanticModelsDir(),
        billingProject: billingProject ?? undefined,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        messages: (req.body?.messages ?? []) as any,
        toolUseId,
        decision,
        apply:
          decision === "confirm" && p
            ? {
                description: p.description,
                newMalloy: p.newMalloy,
                classification: p.classification,
                isDefinition: p.isDefinition,
                canonicalName: p.canonicalName ?? undefined,
                aliases: p.aliases,
              }
            : undefined,
      });
      return normalizeValue({
        messages: result.messages,
        events: result.events,
        pending: result.pending,
        applied: result.applied ?? false,
      });
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Context — decision traces for a model (the append-only event clock).
  app.get<{ Params: { model: string } }>("/api/context/:model/traces", async (req, reply) => {
    try {
      const modelDir = path.resolve(resolveModelDir(semanticModelsDir(), req.params.model));
      const traces = await readTraces(modelDir); // [] if none yet
      return normalizeValue(traces);
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Context — ENTITY-CENTRIC graph: the same traces reorganized around the
  // measures/definitions/questions/gaps the owner reasons about (which measures
  // are most used, how a definition evolved + what it touched, where the gaps
  // are). Pure aggregation over the traces — no new capture.
  app.get<{ Params: { model: string } }>("/api/context/:model/graph", async (req, reply) => {
    try {
      const graph = await buildEntityGraph({ semanticModelsDir: semanticModelsDir(), modelName: req.params.model });
      return normalizeValue(graph);
    } catch (err) {
      reply.code(500);
      return { error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Context — what-if simulation over trace history. Never touches the real
  // model. A "cannot simulate" verdict is a normal 200 (feasible:false), not an
  // error; only true failures (e.g. missing key) return { error }.
  app.post<{ Params: { model: string }; Body: { change_text?: string } }>(
    "/api/context/:model/whatif",
    async (req, reply) => {
      const change = (req.body?.change_text ?? "").trim();
      if (!change) {
        reply.code(400);
        return { error: "change_text is required" };
      }
      try {
        const semDir = semanticModelsDir();
        const modelDir = path.resolve(resolveModelDir(semDir, req.params.model));
        const connectorKind = await detectConnectorKind(modelDir).catch(() => undefined);
        const billingProject = resolveBillingProject();
        if (connectorKind === "bigquery" && !billingProject) {
          reply.code(400);
          return { error: "billing_project is required for BigQuery models. Set BQ_PROJECT_ID." };
        }
        const report = await simulateChange({
          modelName: req.params.model,
          semanticModelsDir: semDir,
          proposedChange: change,
          billingProject,
        });
        return normalizeValue(report);
      } catch (err) {
        reply.code(500);
        return { error: err instanceof Error ? err.message : String(err) };
      }
    },
  );

  // Serve the built client (production). In dev, Vite serves on :5173 and
  // proxies /api here, so the client bundle may be absent — that's fine.
  if (fs.existsSync(clientDist)) {
    await app.register(fastifyStatic, { root: clientDist, prefix: "/" });
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply.sendFile("index.html");
    });
  } else {
    app.setNotFoundHandler((req, reply) => {
      if (req.raw.url?.startsWith("/api")) {
        reply.code(404).send({ error: "Not found" });
        return;
      }
      reply
        .code(200)
        .type("text/plain")
        .send("Weft API is running. Client not built — run `pnpm --dir web dev` (Vite :5173) for development.");
    });
  }

  return app;
}

// Overlay the active saved connection onto the environment at startup, so the
// whole engine can use it (env vars remain the fallback when none is saved).
syncActiveConnection()
  .catch(() => {})
  .then(buildServer)
  .then((app) => app.listen({ port: PORT, host: "127.0.0.1" }))
  .then((address) => {
    // eslint-disable-next-line no-console
    console.log(`Weft web API listening on ${address}`);
    if (!fs.existsSync(clientDist)) {
      console.log("Client bundle not found — dev mode: run `pnpm --dir web dev` and open http://localhost:5173");
    } else {
      console.log(`Open ${address}`);
    }
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
