/**
 * Compute a human-readable diff between old and new model.malloy files.
 * Extracts structured elements (measures, dimensions, joins, views)
 * and reports what was added, changed, or removed.
 */

// ── Element extraction ──────────────────────────────────────────

interface ModelElements {
  measures: Map<string, string>;     // name → full line
  dimensions: Map<string, string>;   // name → full line
  joins: Map<string, string>;        // alias → full line
  views: Map<string, string>;        // name → full block (simplified to first line)
  sources: string[];                 // source names
  filters: Map<string, string>;      // name → expression (source-level where:)
}

function extractElements(malloy: string): ModelElements {
  const measures = new Map<string, string>();
  const dimensions = new Map<string, string>();
  const joins = new Map<string, string>();
  const views = new Map<string, string>();
  const sources: string[] = [];
  const filters = new Map<string, string>();

  for (const line of malloy.split("\n")) {
    const trimmed = line.trim();

    // measure: name is expression
    const measureMatch = trimmed.match(/^measure:\s+(\w+)\s+is\s+(.+)/);
    if (measureMatch) {
      measures.set(measureMatch[1], trimmed);
      continue;
    }

    // dimension: name is expression
    const dimMatch = trimmed.match(/^dimension:\s+(\w+)\s+is\s+(.+)/);
    if (dimMatch) {
      dimensions.set(dimMatch[1], trimmed);
      continue;
    }

    // join_one: alias is source on ...
    const joinMatch = trimmed.match(/^join_(?:one|many|cross):\s+(\w+)\s+is\s+(.+)/);
    if (joinMatch) {
      joins.set(joinMatch[1], trimmed);
      continue;
    }

    // view: name is { ... (just capture the first line as identifier)
    const viewMatch = trimmed.match(/^view:\s+(\w+)\s+is\s+\{/);
    if (viewMatch) {
      views.set(viewMatch[1], trimmed);
      continue;
    }

    // source: name is ...
    const sourceMatch = trimmed.match(/^source:\s+(\w+)\s+is\s+/);
    if (sourceMatch) {
      sources.push(sourceMatch[1]);
      continue;
    }

    // where: expression (source-level, non-named)
    const filterMatch = trimmed.match(/^where:\s+(.+)/);
    if (filterMatch && !trimmed.includes(" is ")) {
      filters.set(filterMatch[1], trimmed);
    }
  }

  return { measures, dimensions, joins, views, sources, filters };
}

// ── Diff computation ────────────────────────────────────────────

export interface ModelDiffEntry {
  type: "measure" | "dimension" | "join" | "view" | "filter";
  action: "added" | "removed" | "changed";
  name: string;
  /** Old definition (for changed/removed) */
  old?: string;
  /** New definition (for changed/added) */
  new?: string;
}

export interface ModelDiff {
  entries: ModelDiffEntry[];
  sources_changed: boolean;
}

export function computeModelDiff(oldMalloy: string, newMalloy: string): ModelDiff {
  const oldElements = extractElements(oldMalloy);
  const newElements = extractElements(newMalloy);
  const entries: ModelDiffEntry[] = [];

  // Compare each element type
  function diffMap(
    type: ModelDiffEntry["type"],
    oldMap: Map<string, string>,
    newMap: Map<string, string>,
  ) {
    // Added
    for (const [name, def] of newMap) {
      if (!oldMap.has(name)) {
        entries.push({ type, action: "added", name, new: def });
      }
    }
    // Removed
    for (const [name, def] of oldMap) {
      if (!newMap.has(name)) {
        entries.push({ type, action: "removed", name, old: def });
      }
    }
    // Changed
    for (const [name, newDef] of newMap) {
      const oldDef = oldMap.get(name);
      if (oldDef && oldDef !== newDef) {
        entries.push({ type, action: "changed", name, old: oldDef, new: newDef });
      }
    }
  }

  diffMap("measure", oldElements.measures, newElements.measures);
  diffMap("dimension", oldElements.dimensions, newElements.dimensions);
  diffMap("join", oldElements.joins, newElements.joins);
  diffMap("view", oldElements.views, newElements.views);
  diffMap("filter", oldElements.filters, newElements.filters);

  const sources_changed =
    oldElements.sources.length !== newElements.sources.length ||
    oldElements.sources.some((s, i) => s !== newElements.sources[i]);

  return { entries, sources_changed };
}

// ── Formatting ──────────────────────────────────────────────────

export function formatDiffMarkdown(diff: ModelDiff): string {
  if (diff.entries.length === 0 && !diff.sources_changed) {
    return "_No structural changes detected._";
  }

  const lines: string[] = [];

  if (diff.sources_changed) {
    lines.push("- **Sources** changed");
  }

  const grouped: Record<string, ModelDiffEntry[]> = {};
  for (const entry of diff.entries) {
    const key = entry.action;
    if (!grouped[key]) grouped[key] = [];
    grouped[key].push(entry);
  }

  if (grouped.added) {
    lines.push("");
    lines.push("**Added:**");
    for (const e of grouped.added) {
      lines.push(`- ${e.type}: \`${e.name}\``);
      if (e.new) lines.push(`  \`${e.new}\``);
    }
  }

  if (grouped.changed) {
    lines.push("");
    lines.push("**Changed:**");
    for (const e of grouped.changed) {
      lines.push(`- ${e.type}: \`${e.name}\``);
      if (e.old) lines.push(`  was: \`${e.old}\``);
      if (e.new) lines.push(`  now: \`${e.new}\``);
    }
  }

  if (grouped.removed) {
    lines.push("");
    lines.push("**Removed:**");
    for (const e of grouped.removed) {
      lines.push(`- ${e.type}: \`${e.name}\``);
    }
  }

  return lines.join("\n");
}

export function formatDiffCli(diff: ModelDiff): string {
  if (diff.entries.length === 0 && !diff.sources_changed) {
    return "  No structural changes detected.";
  }

  const lines: string[] = [];

  if (diff.sources_changed) {
    lines.push("  ~ Sources changed");
  }

  for (const e of diff.entries) {
    const prefix = e.action === "added" ? "+" : e.action === "removed" ? "-" : "~";
    lines.push(`  ${prefix} ${e.type}: ${e.name}`);
    if (e.action === "changed") {
      if (e.old) lines.push(`    was: ${e.old}`);
      if (e.new) lines.push(`    now: ${e.new}`);
    } else if (e.action === "added" && e.new) {
      lines.push(`    ${e.new}`);
    }
  }

  return lines.join("\n");
}
