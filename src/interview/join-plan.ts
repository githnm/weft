/**
 * Deterministic join planning.
 *
 * Given the user's finalized table set, compute — WITHOUT the LLM — exactly
 * which tables join into the fact, on which keys, with which cardinality, and
 * which selected tables cannot be joined at all. This is the contract the user
 * reviews and confirms before the build; the compiled model is validated
 * against it so the output can't silently diverge.
 */

import type { InspectionResult, ColumnInspection } from "../introspect/types.js";

export interface PlannedJoin {
  /** The table being joined in. */
  table: string;
  /** The table it attaches to (the fact, or an already-joined table for a chain). */
  onto: string;
  /** one = lookup/dimension (join_one); many = one-to-many child (join_many). */
  cardinality: "one" | "many";
  /** Column on `onto` used in the ON clause. */
  ontoKey: string;
  /** Column on `table` used in the ON clause. */
  tableKey: string;
  /** Human explanation of how the cardinality/key was inferred. */
  inferredFrom: string;
}

export interface UnjoinableTable {
  table: string;
  reason: string;
}

export interface JoinPlan {
  /** The primary/fact source. */
  fact: string;
  /** Joins in dependency order (a join's `onto` always appears earlier or is the fact). */
  joins: PlannedJoin[];
  /** Selected tables with no foreign-key path to the fact. */
  unjoinable: UnjoinableTable[];
  /** True when the warehouse exposes no FK catalog (e.g. BigQuery) — joins can't be inferred deterministically. */
  noForeignKeys: boolean;
}

interface Edge {
  // FK is always source.sourceCol → target.targetCol (target is the unique/PK side)
  source: string;
  sourceCol: string;
  target: string;
  targetCol: string;
}

/** Effectively-unique columns per table (distinct ≥ rows), plus all FK-target columns. */
function keyColumns(inspection: InspectionResult, selected: Set<string>): Map<string, Set<string>> {
  const keys = new Map<string, Set<string>>();
  for (const t of inspection.tables) {
    if (!selected.has(t.name.toLowerCase())) continue;
    const s = new Set<string>();
    for (const c of t.columns) {
      if (t.row_count > 0 && c.distinct_count >= t.row_count) s.add(c.name.toLowerCase());
    }
    keys.set(t.name.toLowerCase(), s);
  }
  for (const fk of inspection.foreign_keys ?? []) {
    const tt = fk.target_table.toLowerCase();
    if (keys.has(tt)) keys.get(tt)!.add(fk.target_column.toLowerCase());
  }
  return keys;
}

/**
 * Compute the join plan. `factOverride` (a selected table) forces the fact;
 * otherwise the most-connected table (the hub) is chosen.
 */
export function computeJoinPlan(
  inspection: InspectionResult,
  tableNames: string[],
  factOverride?: string,
): JoinPlan {
  const selected = new Set(tableNames.map((n) => n.toLowerCase()));
  const present = tableNames.filter((n) => selected.has(n.toLowerCase()));

  // Dedup FKs where both endpoints are selected.
  const seen = new Set<string>();
  const edges: Edge[] = [];
  for (const fk of inspection.foreign_keys ?? []) {
    if (!selected.has(fk.source_table.toLowerCase()) || !selected.has(fk.target_table.toLowerCase())) continue;
    if (fk.source_table.toLowerCase() === fk.target_table.toLowerCase()) continue; // skip self-FK
    const k = `${fk.source_table}.${fk.source_column}->${fk.target_table}.${fk.target_column}`.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    edges.push({
      source: fk.source_table,
      sourceCol: fk.source_column,
      target: fk.target_table,
      targetCol: fk.target_column,
    });
  }

  const noForeignKeys = (inspection.foreign_keys ?? []).length === 0;

  // Single table: it's the fact, nothing to join.
  if (present.length <= 1) {
    return { fact: present[0] ?? "", joins: [], unjoinable: [], noForeignKeys };
  }

  // No FK connections among the selected tables → can't plan joins deterministically.
  if (edges.length === 0) {
    const fact = factOverride && selected.has(factOverride.toLowerCase()) ? factOverride : present[0];
    return {
      fact,
      joins: [],
      unjoinable: present
        .filter((t) => t.toLowerCase() !== fact.toLowerCase())
        .map((t) => ({
          table: t,
          reason: noForeignKeys
            ? "no foreign-key catalog for this warehouse — specify a join key or exclude"
            : "no foreign key links it to the other selected tables",
        })),
      noForeignKeys,
    };
  }

  // Undirected adjacency (each edge usable in both directions for reachability).
  const adj = new Map<string, { neighbor: string; edge: Edge }[]>();
  const canon = new Map<string, string>(); // lower → original casing
  for (const t of present) canon.set(t.toLowerCase(), t);
  const add = (a: string, b: string, edge: Edge) => {
    const la = a.toLowerCase();
    if (!adj.has(la)) adj.set(la, []);
    adj.get(la)!.push({ neighbor: b, edge });
  };
  for (const e of edges) {
    add(e.source, e.target, e);
    add(e.target, e.source, e);
  }

  // Pick the fact: explicit override, else the most-connected table (hub).
  const degree = new Map<string, number>();
  for (const e of edges) {
    degree.set(e.source.toLowerCase(), (degree.get(e.source.toLowerCase()) ?? 0) + 1);
    degree.set(e.target.toLowerCase(), (degree.get(e.target.toLowerCase()) ?? 0) + 1);
  }
  let fact =
    factOverride && selected.has(factOverride.toLowerCase()) ? canon.get(factOverride.toLowerCase())! : present[0];
  if (!(factOverride && selected.has(factOverride.toLowerCase()))) {
    let best = -1;
    for (const t of present) {
      const d = degree.get(t.toLowerCase()) ?? 0;
      if (d > best) {
        best = d;
        fact = t;
      }
    }
  }

  // BFS from the fact; each reached table records the edge to its parent.
  const joins: PlannedJoin[] = [];
  const visited = new Set<string>([fact.toLowerCase()]);
  let frontier = [fact];
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const node of frontier) {
      for (const { neighbor, edge } of adj.get(node.toLowerCase()) ?? []) {
        if (visited.has(neighbor.toLowerCase())) continue;
        visited.add(neighbor.toLowerCase());
        next.push(neighbor);
        // `node` is the parent (closer to fact); `neighbor` is the table joined in.
        // Cardinality from the FK direction relative to the parent:
        //   FK neighbor.col → node.col  ⇒ many neighbor : one node ⇒ from node, join_many neighbor
        //   FK node.col → neighbor.col  ⇒ many node : one neighbor ⇒ from node, join_one neighbor
        const neighborIsSource = edge.source.toLowerCase() === neighbor.toLowerCase();
        if (neighborIsSource) {
          joins.push({
            table: neighbor,
            onto: node,
            cardinality: "many",
            ontoKey: edge.targetCol,
            tableKey: edge.sourceCol,
            inferredFrom: `foreign key ${edge.source}.${edge.sourceCol} → ${edge.target}.${edge.targetCol} (one ${node} → many ${neighbor})`,
          });
        } else {
          joins.push({
            table: neighbor,
            onto: node,
            cardinality: "one",
            ontoKey: edge.sourceCol,
            tableKey: edge.targetCol,
            inferredFrom: `foreign key ${edge.source}.${edge.sourceCol} → ${edge.target}.${edge.targetCol} (many ${node} → one ${neighbor})`,
          });
        }
      }
    }
    frontier = next;
  }

  const unjoinable = present
    .filter((t) => !visited.has(t.toLowerCase()))
    .map((t) => ({ table: t, reason: "no foreign-key path to the fact or any joined table" }));

  return { fact, joins, unjoinable, noForeignKeys };
}

/** Count `join_one`/`join_many` statements in a compiled model.malloy. */
export function countJoinsInMalloy(malloy: string): number {
  return (malloy.match(/\bjoin_(one|many|cross)\s*:/g) ?? []).length;
}

/** The join-relevant fields of a column, for the table-selection schema view. */
export function columnIsKey(col: ColumnInspection, rowCount: number, fkTargetCols: Set<string>): boolean {
  if (fkTargetCols.has(col.name.toLowerCase())) return true;
  return rowCount > 0 && col.distinct_count >= rowCount;
}
