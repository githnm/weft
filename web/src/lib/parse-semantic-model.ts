// Parse a semantic model (model.malloy + manifest detail) into a node-graph:
// SOURCES are nodes, join_one/join_many lines are edges. Everything is derived
// from the data the detail view already loads — no extra backend call.

import type { ModelDetail } from "./api";

export interface DiagramConcept {
  name: string;
  kind: string;
  aliases: string[];
}

export interface DiagramNode {
  /** Malloy source name (the alias used in the model). */
  id: string;
  /** Underlying table (last dotted segment of the table() ref), if any. */
  table: string | null;
  /** The hub/fact source — the one others join into. */
  isHub: boolean;
  /** Primary key, join keys, and referenced columns — kept legible, not every column. */
  keyFields: { name: string; isKey: boolean }[];
  measures: { name: string; expr: string }[];
  dimensions: { name: string; expr: string }[];
  concepts: DiagramConcept[];
}

export interface DiagramEdge {
  id: string;
  /** The source that DECLARES the join (the hub side). */
  source: string;
  /** The joined source (the dimension side). */
  target: string;
  cardinality: "one" | "many" | "cross";
  /** Compact join key, e.g. "user_id = id". */
  label: string;
}

export interface SemanticDiagram {
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/** "public.orders" / "proj.ds.orders" / "orders" → "orders". */
function lastSegment(ref: string): string {
  const parts = ref.replace(/['"`]/g, "").split(".");
  return parts[parts.length - 1];
}

interface RawSource {
  name: string;
  table: string | null;
  pk: string | null;
  joins: { alias: string; targetSource: string; cardinality: "one" | "many" | "cross"; on: string }[];
  measures: { name: string; expr: string }[];
  dimensions: { name: string; expr: string }[];
  /** Structural keys: primary key + join-clause fields. */
  keyFields: Set<string>;
  /** Columns referenced by measures/dimensions (shown, but not keys). */
  refFields: Set<string>;
}

export function parseSemanticModel(detail: ModelDetail): SemanticDiagram {
  const malloy = detail.malloy ?? "";
  const lines = malloy.split("\n");

  // Known columns per underlying table (to keep field lists meaningful).
  const columnsByTable = new Map<string, Set<string>>();
  for (const s of detail.sources) {
    columnsByTable.set(s.name.toLowerCase(), new Set(s.columns.map((c) => c.name)));
  }

  const sourceRe = /^\s*source:\s+([A-Za-z_]\w*)\s+is\s+(.+?)(?:\s+extend\b|\s*\{|\s*$)/;
  const tableRefRe = /\.table\(\s*['"`]([^'"`]+)['"`]\s*\)/;
  const joinRe = /^\s*join_(one|many|cross):\s+([A-Za-z_]\w*)\s+is\s+([A-Za-z_]\w*)\s+on\s+(.+?)\s*$/;
  const pkRe = /^\s*primary_key:\s+([A-Za-z_]\w*)/;
  const itemRe = /^\s+(measure|dimension):\s+([A-Za-z_]\w*)\s+is\s+(.+?)\s*$/;

  const order: string[] = [];
  const byName = new Map<string, RawSource>();
  let cur: RawSource | null = null;

  for (const line of lines) {
    const s = line.match(sourceRe);
    if (s) {
      const tref = s[2].match(tableRefRe);
      cur = {
        name: s[1],
        table: tref ? lastSegment(tref[1]) : null,
        pk: null,
        joins: [],
        measures: [],
        dimensions: [],
        keyFields: new Set(),
        refFields: new Set(),
      };
      byName.set(cur.name, cur);
      order.push(cur.name);
      continue;
    }
    if (!cur) continue;

    const j = line.match(joinRe);
    if (j) {
      cur.joins.push({
        cardinality: j[1] as "one" | "many" | "cross",
        alias: j[2],
        targetSource: j[3],
        on: j[4].trim(),
      });
      continue;
    }
    const pk = line.match(pkRe);
    if (pk) {
      cur.pk = pk[1];
      cur.keyFields.add(pk[1]);
      continue;
    }
    const it = line.match(itemRe);
    if (it) {
      const entry = { name: it[2], expr: it[3].trim() };
      if (it[1] === "measure") cur.measures.push(entry);
      else cur.dimensions.push(entry);
    }
  }

  // Resolve join-key fields onto the correct sources, using each source's
  // alias→target map. "user_id = u.id" → user_id on this source, id on u's source.
  for (const r of byName.values()) {
    const aliasToSource = new Map<string, string>();
    for (const jn of r.joins) aliasToSource.set(jn.alias, jn.targetSource);
    for (const jn of r.joins) {
      const tokenRe = /([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)|([A-Za-z_]\w*)/g;
      for (const m of jn.on.matchAll(tokenRe)) {
        if (m[1] && m[2]) {
          const src = aliasToSource.get(m[1]) ?? (m[1] === r.name ? r.name : undefined);
          if (src && byName.has(src)) byName.get(src)!.keyFields.add(m[2]);
        } else if (m[3]) {
          r.keyFields.add(m[3]);
        }
      }
    }
  }

  // Add a few columns referenced by measures/dimensions (only ones that are real
  // columns of the source's table) so each node shows its meaningful fields.
  for (const r of byName.values()) {
    const cols = (r.table && columnsByTable.get(r.table.toLowerCase())) || new Set<string>();
    if (cols.size === 0) continue;
    for (const item of [...r.measures, ...r.dimensions]) {
      for (const m of item.expr.matchAll(/[A-Za-z_]\w*/g)) {
        if (cols.has(m[0]) && !r.keyFields.has(m[0])) r.refFields.add(m[0]);
        if (r.keyFields.size + r.refFields.size >= 8) break;
      }
      if (r.keyFields.size + r.refFields.size >= 8) break;
    }
  }

  // Concepts: attach each to the source that owns its baked field.
  const conceptFieldOwners = new Map<string, RawSource>();
  for (const r of byName.values()) {
    for (const it of [...r.measures, ...r.dimensions]) conceptFieldOwners.set(it.name, r);
  }
  const conceptsByOwner = new Map<string, DiagramConcept[]>();
  const conceptFields = new Set<string>();
  for (const c of detail.concepts) {
    conceptFields.add(c.field);
    const owner = conceptFieldOwners.get(c.field);
    const ownerName = owner?.name ?? order[order.length - 1];
    if (!ownerName) continue;
    if (!conceptsByOwner.has(ownerName)) conceptsByOwner.set(ownerName, []);
    conceptsByOwner.get(ownerName)!.push({ name: c.canonical_name, kind: c.kind, aliases: c.aliases });
  }

  // Hub = most outgoing joins; ties broken by most measures; else last source.
  let hub = "";
  let best = -1;
  for (const name of order) {
    const r = byName.get(name)!;
    const score = r.joins.length * 100 + r.measures.length;
    if (score > best) {
      best = score;
      hub = name;
    }
  }

  // Fallback: a model with no parsed sources — synthesize from base tables.
  if (order.length === 0) {
    const nodes: DiagramNode[] = detail.sources.map((s, i) => ({
      id: s.name,
      table: s.name,
      isHub: i === 0,
      keyFields: s.columns.slice(0, 6).map((c) => ({ name: c.name, isKey: false })),
      measures: [],
      dimensions: [],
      concepts: [],
    }));
    return { nodes, edges: [] };
  }

  const nodes: DiagramNode[] = order.map((name) => {
    const r = byName.get(name)!;
    const fields = [
      ...[...r.keyFields].map((f) => ({ name: f, isKey: true })),
      ...[...r.refFields].map((f) => ({ name: f, isKey: false })),
    ];
    return {
      id: name,
      table: r.table,
      isHub: name === hub,
      keyFields: fields,
      measures: r.measures.filter((m) => !conceptFields.has(m.name)),
      dimensions: r.dimensions.filter((d) => !conceptFields.has(d.name)),
      concepts: conceptsByOwner.get(name) ?? [],
    };
  });

  const edges: DiagramEdge[] = [];
  for (const r of byName.values()) {
    for (const jn of r.joins) {
      if (!byName.has(jn.targetSource)) continue;
      // Compact label: drop alias qualifiers from the on-clause for legibility.
      const label = jn.on.replace(/[A-Za-z_]\w*\s*\.\s*/g, "").replace(/\s+/g, " ").trim();
      edges.push({
        id: `${r.name}->${jn.targetSource}-${jn.alias}`,
        source: r.name,
        target: jn.targetSource,
        cardinality: jn.cardinality,
        label,
      });
    }
  }

  return { nodes, edges };
}

/** Layered left→right layout: hub(s) on the left, their join targets to the
 *  right, isolated sources in a trailing lane. Returns x/y per node id. */
export function layoutDiagram(
  diagram: SemanticDiagram,
): Record<string, { x: number; y: number }> {
  const { nodes, edges } = diagram;
  const incoming = new Map<string, number>();
  for (const n of nodes) incoming.set(n.id, 0);
  for (const e of edges) incoming.set(e.target, (incoming.get(e.target) ?? 0) + 1);

  // depth via BFS from roots (no incoming edges).
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const n of nodes) {
    if ((incoming.get(n.id) ?? 0) === 0) {
      depth.set(n.id, 0);
      queue.push(n.id);
    }
  }
  const outBySource = new Map<string, string[]>();
  for (const e of edges) {
    if (!outBySource.has(e.source)) outBySource.set(e.source, []);
    outBySource.get(e.source)!.push(e.target);
  }
  while (queue.length) {
    const id = queue.shift()!;
    const d = depth.get(id) ?? 0;
    for (const t of outBySource.get(id) ?? []) {
      if (!depth.has(t) || (depth.get(t) ?? 0) < d + 1) {
        depth.set(t, d + 1);
        queue.push(t);
      }
    }
  }
  // Any node not reached (cycle / orphan) → depth 0.
  for (const n of nodes) if (!depth.has(n.id)) depth.set(n.id, 0);

  // Isolated sources (no joins at all) clutter the hub column — move them to a
  // trailing lane so the connected star/hub reads clearly.
  const connected = new Set<string>();
  for (const e of edges) {
    connected.add(e.source);
    connected.add(e.target);
  }
  let maxDepth = 0;
  for (const n of nodes) if (connected.has(n.id)) maxDepth = Math.max(maxDepth, depth.get(n.id) ?? 0);
  for (const n of nodes) if (!connected.has(n.id)) depth.set(n.id, maxDepth + 1);

  const COL_W = 320;
  const ROW_H = 240;
  const byDepth = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depth.get(n.id) ?? 0;
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(n.id);
  }
  const pos: Record<string, { x: number; y: number }> = {};
  for (const [d, ids] of byDepth) {
    ids.forEach((id, i) => {
      pos[id] = { x: d * COL_W, y: i * ROW_H };
    });
  }
  return pos;
}
