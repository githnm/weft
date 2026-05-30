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
import { listModels, showModel } from "../models/registry.js";
import { parseModelItems } from "../interview/compile.js";
import { proposeModelPlan } from "../interview/plan.js";
import { buildModelWithClarification } from "../interview/build.js";
import type { ResolvedDecision, RelevantTable } from "../interview/types.js";
import { readTraces } from "../context/trace.js";
import { simulateChange } from "../context/simulate.js";
import { loadSession } from "../session/store.js";
import { classifyCorrection } from "../correct/classify.js";
import { prepareTermUpdate, applyTermUpdate } from "../correct/term-update.js";
import { prepareModelSuggestion, logModelSuggestion } from "../correct/model-suggest.js";

const PORT = Number(process.env.WEB_PORT ?? 4000);
const BQ_COST_PER_TB = 6.25;

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
 * The configured substrate directory (no per-request override). Priority:
 *   WEFT_SUBSTRATE_DIR > DEFAULT_SUBSTRATE_DIR > DEFAULT_MODELS_DIR > ./substrate
 * A substrate can live anywhere (prod-models, posthog-substrate, …) — it is
 * never assumed to be ./substrate beyond the final fallback.
 */
function configuredSubstrateDir(): string {
  return path.resolve(process.env.WEFT_SUBSTRATE_DIR || resolveSubstrateDir());
}

/** Resolve the substrate for a design request: explicit body field, else config. */
function resolveSubstrate(explicit?: string): string {
  const e = explicit?.trim();
  return e ? path.resolve(e) : configuredSubstrateDir();
}

function hasInspection(dir: string): boolean {
  return fs.existsSync(path.join(dir, "inspection.json"));
}

function substrateNotFoundMessage(dir: string): string {
  return (
    `No substrate found at "${dir}" — inspection.json is missing there. ` +
    `Point at your introspected substrate via the "Substrate directory" field, ` +
    `or set the WEFT_SUBSTRATE_DIR env var (DEFAULT_SUBSTRATE_DIR / DEFAULT_MODELS_DIR also work). ` +
    `If you haven't introspected yet, run \`pnpm cli introspect\`.`
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
      return normalizeValue({
        name: detail.name,
        purpose: detail.purpose,
        connector: detail.connector_kind ?? null,
        measures: items.filter((i) => i.kind === "measure").map((i) => ({ name: i.name, expr: i.expr })),
        dimensions: items.filter((i) => i.kind === "dimension").map((i) => ({ name: i.name, expr: i.expr })),
        views,
        malloy,
        decisions: detail.manifest.design?.decisions ?? [],
      });
    } catch (err) {
      reply.code(404);
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
      if (connectorKind !== "postgres" && !billingProject) {
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

  // Design — step 1: propose a plan (relevant tables + decisions).
  // Thin wrapper over proposeModelPlan (the same function `model design` calls).
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
        const plan = await proposeModelPlan(purpose, substrateDir);

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

        return normalizeValue({
          name: req.body?.name ?? "",
          purpose,
          substrateDir,
          relevantTables: relevant,
          excludedCount: excluded,
          tableSelectionReasoning: plan.table_selection_reasoning,
          decisions: plan.decisions.map((d) => ({
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
      substrate_dir?: string;
      semantic_models_dir?: string;
      clarifications?: { question: string; answer: string }[];
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
      if (connectorKind !== "postgres" && !billingProject) {
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
        clarifications,
        surfaceQuestions: clarifications.length === 0,
        maxClarifyRounds: 2,
      });

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
        if (connectorKind !== "postgres" && !billingProject) {
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

buildServer()
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
