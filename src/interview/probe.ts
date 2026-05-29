/**
 * Post-build DATA validation (the general fix for "compiles but is semantically
 * wrong"). The build already validates that measures COMPILE; this validates
 * that they PRODUCE DATA.
 *
 * For each measure, run a cheap unfiltered aggregate (`run: owner -> { aggregate:
 * m }`) and inspect the result. A measure that returns all-zero / all-null /
 * empty is flagged as a build warning. When such a measure references a JOIN,
 * we additionally probe the join's real reach — how many rows in the joined
 * table actually carry the join key — which turns "this is zero" into a
 * data-grounded diagnosis ("430/630 sessions have no user_id, so they never
 * attach to an account"). That diagnosis is what grounds the coherence
 * clarification, instead of speculation.
 *
 * Connector-aware because it runs through executeQuery.
 */

import fs from "node:fs/promises";
import { executeQuery } from "../agent/execute.js";
import { parseModelItems } from "./compile.js";
import type { ConnectorKind } from "../connectors/types.js";

export interface JoinInfo {
  alias: string;
  table: string;
  leftKey: string;
  rightKey: string;
}

export interface JoinConflict {
  alias: string;
  table: string;
  leftKey: string;
  rightKey: string;
  /** Total rows in the joined table. */
  joinedTotal: number;
  /** Rows in the joined table where the join key is present (non-null). */
  joinedWithKey: number;
}

export interface MeasureProbe {
  name: string;
  owner: string;
  /** "ok" = produced data; otherwise the measure is empty in some way. */
  status: "ok" | "zero" | "null" | "empty" | "error";
  value: number | null;
  detail?: string;
  /** Present when an empty measure is traced to a join that attaches to little/nothing. */
  joinConflict?: JoinConflict;
}

interface ProbeContext {
  modelMalloy: string;
  modelsDir: string;
  connectorKind?: ConnectorKind;
  billingProject?: string;
  location?: string;
}

/** Parse join declarations to recover alias, joined table, and the join keys. */
export function parseJoins(modelMalloy: string): JoinInfo[] {
  const joins: JoinInfo[] = [];
  for (const m of modelMalloy.matchAll(/join_(?:one|many|cross):\s+(\w+)\s+is\s+(\w+)\s+on\s+([^\n]+)/g)) {
    const alias = m[1];
    const table = m[2];
    const on = m[3];
    const rk = on.match(new RegExp(`${alias}\\.(\\w+)`));
    const rightKey = rk ? rk[1] : "";
    let leftKey = "";
    const eq = on.split("=").map((s) => s.trim());
    if (eq.length === 2) {
      const left = eq[0].includes(`${alias}.`) ? eq[1] : eq[0];
      leftKey = left.replace(/[{};]/g, "").trim();
    }
    joins.push({ alias, table, leftKey, rightKey });
  }
  return joins;
}

function firstNumeric(row: Record<string, unknown>, preferKey?: string): number | null {
  if (preferKey && typeof row[preferKey] === "number") return row[preferKey] as number;
  for (const k of Object.keys(row)) {
    if (typeof row[k] === "number") return row[k] as number;
  }
  return null;
}

async function runAgg(
  ctx: ProbeContext,
  owner: string,
  body: string,
): Promise<{ ok: true; rows: Record<string, unknown>[] } | { ok: false; error: string }> {
  const malloyFiles = new Map<string, string>([["model.malloy", ctx.modelMalloy]]);
  const res = await executeQuery({
    sourceFilename: "model.malloy",
    runBlock: `run: ${owner} -> { ${body} }`,
    modelsDir: ctx.modelsDir,
    malloyFiles,
    billingProject: ctx.billingProject,
    location: ctx.location,
    connectorKind: ctx.connectorKind,
  });
  return res.ok ? { ok: true, rows: res.result.rows } : { ok: false, error: res.error };
}

/**
 * Probe every measure for empty/zero/null results, diagnosing join conflicts.
 * Best-effort: returns [] if the model can't be probed. Never throws.
 */
export async function probeMeasures(ctx: ProbeContext): Promise<MeasureProbe[]> {
  const probes: MeasureProbe[] = [];
  try {
    const measures = parseModelItems(ctx.modelMalloy).filter((i) => i.kind === "measure");
    if (measures.length === 0) return probes;

    const joins = parseJoins(ctx.modelMalloy);
    await fs.mkdir(ctx.modelsDir, { recursive: true }).catch(() => {});

    for (const it of measures) {
      const res = await runAgg(ctx, it.owner, `aggregate: ${it.name}`);
      if (!res.ok) {
        probes.push({ name: it.name, owner: it.owner, status: "error", value: null, detail: res.error.split("\n")[0] });
        continue;
      }
      if (res.rows.length === 0) {
        probes.push({ name: it.name, owner: it.owner, status: "empty", value: null });
        continue;
      }
      const value = firstNumeric(res.rows[0], it.name);
      let status: MeasureProbe["status"] = "ok";
      if (value === null) status = "null";
      else if (value === 0) status = "zero";

      const probe: MeasureProbe = { name: it.name, owner: it.owner, status, value };

      // Diagnose: an empty measure that references a join → probe the join's reach.
      if (status !== "ok") {
        const refJoin = joins.find((j) => j.alias && new RegExp(`\\b${j.alias}\\.`).test(it.expr));
        if (refJoin && refJoin.rightKey) {
          const jr = await runAgg(
            ctx,
            refJoin.table,
            `aggregate: _total is count(); _withkey is count() { where: ${refJoin.rightKey} is not null }`,
          );
          if (jr.ok && jr.rows.length > 0) {
            const total = firstNumeric(jr.rows[0], "_total") ?? 0;
            const withKey = firstNumeric({ _withkey: jr.rows[0]._withkey }, "_withkey") ?? 0;
            if (total > 0) {
              probe.joinConflict = {
                alias: refJoin.alias,
                table: refJoin.table,
                leftKey: refJoin.leftKey,
                rightKey: refJoin.rightKey,
                joinedTotal: total,
                joinedWithKey: withKey,
              };
            }
          }
        }
      }
      probes.push(probe);
    }

    await fs.rm(ctx.modelsDir, { recursive: true, force: true }).catch(() => {});
  } catch {
    // Probing is best-effort — never block the build on it.
  }
  return probes;
}

/** Measures that returned no data (the build-warning set). */
export function emptyProbes(probes: MeasureProbe[]): MeasureProbe[] {
  return probes.filter((p) => p.status === "zero" || p.status === "null" || p.status === "empty");
}

/** Empty measures whose emptiness is traced to a broken/low-coverage join. */
export function conflictProbes(probes: MeasureProbe[]): MeasureProbe[] {
  return emptyProbes(probes).filter((p) => p.joinConflict);
}
