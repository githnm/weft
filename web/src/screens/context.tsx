import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  ChevronDown,
  ChevronRight,
  CircleHelp,
  FlaskConical,
  GitBranch,
  Hash,
  LayoutGrid,
  Link2,
  List,
  Loader2,
  Sparkles,
  Tag,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { MalloyBlock } from "@/components/malloy-block";
import { VerificationCallout } from "@/components/verification-callout";
import {
  fetchContextGraph,
  fetchModels,
  fetchTraces,
  runWhatIf,
  type EntityGraph,
  type EntityKind,
  type GraphEntity,
  type ModelInfo,
  type Trace,
  type WhatIfReport,
} from "@/lib/api";

// Calm, muted palette keyed to decision type (used by timeline dots + graph).
const TYPE_COLORS: Record<string, string> = {
  ask: "hsl(153 60% 40%)",
  correction: "hsl(38 60% 45%)",
  term_define: "hsl(0 0% 62%)",
  model_refine: "hsl(0 0% 55%)",
  model_design: "hsl(0 0% 45%)",
  feasibility_refusal: "hsl(14 55% 52%)",
};
const TYPE_LABELS: Record<string, string> = {
  ask: "Ask",
  correction: "Correction",
  term_define: "Term define",
  model_refine: "Model refine",
  model_design: "Model design",
  feasibility_refusal: "Refusal",
};
const typeColor = (t: string) => TYPE_COLORS[t] ?? "hsl(0 0% 62%)";
const typeLabel = (t: string) => TYPE_LABELS[t] ?? t;

function statusVariant(s: string): "success" | "warn" | "default" {
  if (s === "verified" || s === "accepted") return "success";
  if (s === "reversed") return "warn";
  return "default";
}

function relTime(iso: string): string {
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return "";
  const s = Math.max(0, (Date.now() - t) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  const m = s / 60;
  if (m < 60) return `${Math.floor(m)}m ago`;
  const h = m / 60;
  if (h < 24) return `${Math.floor(h)}h ago`;
  const d = h / 24;
  if (d < 30) return `${Math.floor(d)}d ago`;
  return new Date(iso).toLocaleDateString();
}

const truncate = (s: string, n: number) => (s && s.length > n ? s.slice(0, n - 1) + "…" : s || "");

export function ContextScreen() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>("");
  const [traces, setTraces] = useState<Trace[]>([]);
  const [graph, setGraph] = useState<EntityGraph | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Default to the entity-centric MAP; the raw timeline is the alternate view.
  const [view, setView] = useState<"map" | "timeline">("map");
  const [selected, setSelected] = useState<Trace | null>(null);

  useEffect(() => {
    fetchModels()
      .then((ms) => {
        setModels(ms);
        if (ms.length > 0) {
          const pref = ms.find((m) => m.name === "product_usage") ?? ms[0];
          setModel(pref.name);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    if (!model) return;
    setLoading(true);
    setError(null);
    setSelected(null);
    // Traces power the timeline + the detail drawer; the graph is the same
    // traces reorganized around entities for the map.
    Promise.all([fetchTraces(model), fetchContextGraph(model)])
      .then(([t, g]) => {
        setTraces(t);
        setGraph(g);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [model]);

  // Open the detail drawer for a trace id (questions / changes / gaps are traces).
  const openTrace = (id: string) => {
    const t = traces.find((x) => x.id === id);
    if (t) setSelected(t);
  };

  // Newest first for the timeline / detail lookups.
  const ordered = useMemo(
    () => [...traces].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [traces],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-normal tracking-tight">Context</h1>
          <p className="text-sm text-muted-foreground">
            How this model is used and how its meaning evolved — questions clustered around the
            measures and definitions they rely on, plus the gaps no one could answer.
          </p>
        </div>
        <ModelSelect models={models} value={model} onChange={setModel} />
      </div>

      <WhatIfPanel model={model} />

      <Separator />

      {/* View toggle — entity map (default) or raw timeline */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {view === "map" ? "Model map" : `Decision history${traces.length > 0 ? ` · ${traces.length}` : ""}`}
        </span>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <ToggleButton active={view === "map"} onClick={() => setView("map")}>
            <LayoutGrid className="size-3.5" /> Map
          </ToggleButton>
          <ToggleButton active={view === "timeline"} onClick={() => setView("timeline")}>
            <List className="size-3.5" /> Timeline
          </ToggleButton>
        </div>
      </div>

      {loading && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" /> Loading traces…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          {error}
        </div>
      )}

      {!loading && !error && traces.length === 0 && (
        <div className="flex flex-col items-center gap-1.5 rounded-lg border border-dashed border-border py-12 text-center">
          <GitBranch className="size-5 text-muted-foreground" strokeWidth={1.5} />
          <p className="text-sm font-medium">No decisions recorded yet.</p>
          <p className="text-sm text-muted-foreground">Ask questions to build history.</p>
        </div>
      )}

      {!loading && !error && traces.length > 0 && (
        <>
          {view === "map" && graph ? (
            <EntityMap graph={graph} onSelectTrace={openTrace} />
          ) : (
            <Timeline traces={ordered} onSelect={setSelected} />
          )}
        </>
      )}

      {selected && (
        <TraceDetail
          trace={selected}
          all={traces}
          onClose={() => setSelected(null)}
          onNavigate={setSelected}
        />
      )}
    </div>
  );
}

// ── Timeline ─────────────────────────────────────────────────────

function Timeline({ traces, onSelect }: { traces: Trace[]; onSelect: (t: Trace) => void }) {
  return (
    <ol className="relative flex flex-col">
      {/* vertical rail */}
      <span className="absolute bottom-3 left-[5px] top-3 w-px bg-border" aria-hidden />
      {traces.map((t) => (
        <li key={t.id}>
          <button
            onClick={() => onSelect(t)}
            className="group relative flex w-full items-start gap-3 rounded-md py-2.5 pl-0 pr-2 text-left transition-colors hover:bg-muted/50"
          >
            <span
              className="relative z-10 mt-1 size-2.5 shrink-0 rounded-full ring-2 ring-background"
              style={{ backgroundColor: typeColor(t.decision_type) }}
            />
            <span className="flex min-w-0 flex-1 flex-col gap-1">
              <span className="flex items-center gap-2">
                <span className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {typeLabel(t.decision_type)}
                </span>
                <Badge variant={statusVariant(t.outcome.status)}>{t.outcome.status}</Badge>
                <span className="ml-auto pl-2 text-xs text-muted-foreground">{relTime(t.timestamp)}</span>
              </span>
              <span className="truncate text-sm text-foreground">{t.observation}</span>
              {t.links.length > 0 && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  <Link2 className="size-3" /> {t.links.length} linked
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ol>
  );
}


// ── Entity-centric map (the default view) ───────────────────────

const KIND_LABEL: Record<EntityKind, string> = {
  measure: "Measure",
  dimension: "Dimension",
  definition: "Definition",
  view: "View",
};

function KindIcon({ kind }: { kind: EntityKind }) {
  const cls = "size-3.5 text-tertiary";
  if (kind === "definition") return <Sparkles className={cls} strokeWidth={1.75} />;
  if (kind === "dimension") return <Tag className={cls} strokeWidth={1.75} />;
  if (kind === "view") return <LayoutGrid className={cls} strokeWidth={1.75} />;
  return <Hash className={cls} strokeWidth={1.75} />;
}

function statusDotClass(s: string): string {
  if (s === "verified" || s === "accepted") return "bg-success";
  if (s === "reversed" || s === "rejected" || s === "failed") return "bg-destructive";
  return "bg-border-strong";
}

function EntityMap({ graph, onSelectTrace }: { graph: EntityGraph; onSelectTrace: (id: string) => void }) {
  const qById = useMemo(() => new Map(graph.questions.map((q) => [q.id, q])), [graph]);
  const gById = useMemo(() => new Map(graph.gaps.map((g) => [g.id, g])), [graph]);

  // The live core: everything people actually query, ranked by how often. Used
  // definitions rank here too (return_rate etc.) so "what's asked most" is one
  // glance; the Definitions section below re-lists them as the meaning catalog.
  const mostUsed = useMemo(
    () =>
      graph.entities
        .filter((e) => e.usageCount > 0)
        .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name)),
    [graph],
  );
  // The meaning layer: defined concepts (curated vocabulary), used or not.
  const definitions = useMemo(
    () =>
      graph.entities
        .filter((e) => e.kind === "definition")
        .sort((a, b) => b.usageCount - a.usageCount || a.name.localeCompare(b.name)),
    [graph],
  );
  // Cruft: measures/dimensions never queried and never edited.
  const unused = useMemo(
    () =>
      graph.entities
        .filter((e) => e.usageCount === 0 && e.changeIds.length === 0 && e.kind !== "definition")
        .sort((a, b) => a.name.localeCompare(b.name)),
    [graph],
  );
  const maxUsage = useMemo(
    () => Math.max(1, ...graph.entities.map((e) => e.usageCount)),
    [graph],
  );
  const otherQuestions = graph.unclusteredQuestionIds
    .map((id) => qById.get(id))
    .filter(Boolean) as EntityGraph["questions"];

  const gapsRef = useRef<HTMLDivElement>(null);

  return (
    <div className="flex flex-col gap-5">
      {/* TOP — actionable summary; gaps is the loud, clickable chip */}
      <SummaryBar
        stats={graph.stats}
        entityCount={graph.entities.length}
        gaps={graph.gaps.length}
        onGapsClick={() => gapsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })}
      />

      {/* 1 — GAPS: the #1 thing to act on. Can't-miss, amber, top. */}
      <div ref={gapsRef}>
        <GapsSection graph={graph} gById={gById} onSelectTrace={onSelectTrace} />
      </div>

      {/* 2 — MOST USED: ranked by usage, weight proportional to use. */}
      {mostUsed.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHeading
            title="Most used"
            hint="The measures and dimensions people actually query — ranked by use."
          />
          <div className="flex flex-col gap-2">
            {mostUsed.map((e, i) => (
              <UsedEntityRow
                key={e.id}
                entity={e}
                rank={i}
                maxUsage={maxUsage}
                qById={qById}
                onSelectTrace={onSelectTrace}
              />
            ))}
          </div>
        </section>
      )}

      {/* 3 — DEFINITIONS: the curated meaning layer, visually distinct. */}
      {definitions.length > 0 && (
        <section className="flex flex-col gap-2.5">
          <SectionHeading
            icon={<Sparkles className="size-3.5 text-tertiary" strokeWidth={1.75} />}
            title="Definitions"
            hint="The curated meaning layer — concepts and the words that resolve to them."
          />
          <div className="grid grid-cols-1 gap-2 md:grid-cols-2">
            {definitions.map((e) => (
              <DefinitionCard key={e.id} entity={e} />
            ))}
          </div>
        </section>
      )}

      {/* Questions that referenced no tracked measure — minor, collapsed. */}
      {otherQuestions.length > 0 && (
        <CollapsibleSection
          summary={
            <>
              <span className="font-medium text-foreground">{otherQuestions.length}</span> other question
              {otherQuestions.length === 1 ? "" : "s"} — referenced no tracked measure
            </>
          }
        >
          <div className="flex flex-col">
            {otherQuestions.map((q) => (
              <QuestionRow key={q.id} q={q} onSelect={onSelectTrace} />
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* 4 — UNUSED / CRUFT: de-emphasized, collapsed, muted. */}
      {unused.length > 0 && (
        <CollapsibleSection
          muted
          summary={
            <>
              <span className="font-medium text-foreground">{unused.length}</span> unused measure
              {unused.length === 1 ? "" : "s"} / dimensions — never queried
            </>
          }
          aside="candidates to remove"
        >
          <div className="flex flex-wrap gap-1.5">
            {unused.map((e) => (
              <span
                key={e.id}
                className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
              >
                <KindIcon kind={e.kind} />
                {e.name}
              </span>
            ))}
          </div>
        </CollapsibleSection>
      )}
    </div>
  );
}

// ── Summary bar — counts, with gaps as the loud actionable chip ──

function SummaryBar({
  stats,
  entityCount,
  gaps,
  onGapsClick,
}: {
  stats: EntityGraph["stats"];
  entityCount: number;
  gaps: number;
  onGapsClick: () => void;
}) {
  const Stat = ({ n, label }: { n: number; label: string }) => (
    <span className="text-muted-foreground">
      <span className="font-semibold text-foreground">{n}</span> {label}
    </span>
  );
  const Dot = () => <span className="text-border-strong">·</span>;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Stat n={stats.questions} label="questions" />
      <Dot />
      <Stat n={entityCount} label="measures & definitions" />
      <Dot />
      <Stat n={stats.changes} label="changes" />
      <button
        onClick={gaps > 0 ? onGapsClick : undefined}
        className={cn(
          "ml-1 inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold transition-colors",
          gaps > 0
            ? "cursor-pointer bg-warn/10 text-warn hover:bg-warn/20"
            : "cursor-default bg-muted text-muted-foreground",
        )}
      >
        <CircleHelp className="size-3.5" strokeWidth={2} />
        {gaps > 0 ? `${gaps} gap${gaps === 1 ? "" : "s"}` : "no gaps"}
      </button>
    </div>
  );
}

// ── Gaps — top of page, amber, can't-miss ───────────────────────

function GapsSection({
  graph,
  gById,
  onSelectTrace,
}: {
  graph: EntityGraph;
  gById: Map<string, EntityGraph["gaps"][number]>;
  onSelectTrace: (id: string) => void;
}) {
  if (graph.gaps.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border px-3.5 py-2.5 text-xs text-muted-foreground">
        No gaps — every question asked so far was answerable.
      </p>
    );
  }
  const covered = new Set(graph.gapConcepts.flatMap((gc) => gc.gapIds));
  const leftover = graph.gaps.filter((g) => !covered.has(g.id));

  const gapLine = (g: EntityGraph["gaps"][number]) => (
    <button
      key={g.id}
      onClick={() => onSelectTrace(g.id)}
      className="flex items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-warn/5"
    >
      <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-warn/70" aria-hidden />
      <span className="min-w-0 flex-1 text-sm text-foreground">{g.text}</span>
    </button>
  );

  return (
    <section className="flex flex-col gap-2.5 rounded-lg border border-warn/30 bg-warn/[0.06] p-4">
      <div className="flex flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <CircleHelp className="size-4 text-warn" strokeWidth={2} />
          <h2 className="text-sm font-semibold text-foreground">Gaps — asked but unanswerable</h2>
          <span className="rounded-full bg-warn/15 px-1.5 py-0.5 text-[11px] font-semibold text-warn">
            {graph.gaps.length}
          </span>
        </div>
        <p className="text-xs text-muted-foreground">
          What people asked that this model can’t answer — the top thing to add.
        </p>
      </div>
      <div className="flex flex-col gap-2.5">
        {graph.gapConcepts.map((gc) => (
          <div key={gc.concept} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant="warn">missing: {gc.concept}</Badge>
              <span className="text-xs text-muted-foreground">
                {gc.gapIds.length} question{gc.gapIds.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex flex-col">
              {gc.gapIds.map((id) => {
                const g = gById.get(id);
                return g ? gapLine(g) : null;
              })}
            </div>
          </div>
        ))}
        {leftover.length > 0 && <div className="flex flex-col">{leftover.map(gapLine)}</div>}
      </div>
    </section>
  );
}

// ── Most-used row — usage bar gives visual weight; #1 is biggest ──

function UsedEntityRow({
  entity,
  rank,
  maxUsage,
  qById,
  onSelectTrace,
}: {
  entity: GraphEntity;
  rank: number;
  maxUsage: number;
  qById: Map<string, EntityGraph["questions"][number]>;
  onSelectTrace: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const questions = (entity.questionIds.map((id) => qById.get(id)).filter(Boolean) as EntityGraph["questions"])
    .slice()
    .sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1));
  const shown = expanded ? questions : questions.slice(0, 3);
  const more = questions.length - shown.length;
  const pct = Math.max(8, Math.round((entity.usageCount / maxUsage) * 100));
  const top = rank === 0;

  return (
    <div className={cn("rounded-lg border bg-card", top ? "border-border-strong" : "border-border")}>
      <div className="flex flex-col gap-2 px-4 py-3">
        <div className="flex items-center gap-2">
          <KindIcon kind={entity.kind} />
          <span className="text-[10px] font-semibold uppercase tracking-[0.08em] text-tertiary">
            {KIND_LABEL[entity.kind]}
          </span>
          <span className={cn("min-w-0 truncate font-mono text-foreground", top ? "text-[15px]" : "text-sm")}>
            {entity.name}
          </span>
          {entity.changeIds.length > 0 && (
            <span className="flex shrink-0 items-center gap-1 text-[11px] text-tertiary">
              <Sparkles className="size-3" strokeWidth={1.75} /> edited {entity.changeIds.length}×
            </span>
          )}
          <span className="ml-auto shrink-0 text-xs font-medium tabular-nums text-muted-foreground">
            used by {entity.usageCount}
          </span>
        </div>
        {/* usage bar — width ∝ usage, so the biggest is obvious at a glance */}
        <div className="h-1.5 w-full overflow-hidden rounded-full bg-border-subtle">
          <div
            className={cn("h-full rounded-full", top ? "bg-foreground/45" : "bg-foreground/25")}
            style={{ width: `${pct}%` }}
          />
        </div>
        {entity.expr && (
          <span className="truncate font-mono text-[11px] text-muted-foreground">{entity.expr}</span>
        )}
        {shown.length > 0 && (
          <div className="flex flex-col gap-0.5 pt-0.5">
            {shown.map((q) => (
              <QuestionLine key={q.id} q={q} onSelect={onSelectTrace} />
            ))}
            {(more > 0 || expanded) && questions.length > 3 && (
              <button
                onClick={() => setExpanded((v) => !v)}
                className="self-start px-1 py-0.5 text-xs text-muted-foreground transition-colors hover:text-foreground"
              >
                {expanded ? "show less" : `+${more} more`}
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// Compact question line used inside an entity row (no card chrome).
function QuestionLine({
  q,
  onSelect,
}: {
  q: { id: string; text: string; status: string; timestamp: string };
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(q.id)}
      className="flex items-center gap-2 rounded px-1 py-1 text-left transition-colors hover:bg-muted/50"
    >
      <span className={cn("size-1.5 shrink-0 rounded-full", statusDotClass(q.status))} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{q.text}</span>
      <span className="shrink-0 text-xs text-muted-foreground">{relTime(q.timestamp)}</span>
    </button>
  );
}

// ── Definition card — the meaning layer, distinct from raw measures ──

function DefinitionCard({ entity }: { entity: GraphEntity }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-tertiary/30 bg-muted/40 px-3.5 py-2.5">
      <div className="flex items-center gap-2">
        <Sparkles className="size-3.5 shrink-0 text-tertiary" strokeWidth={1.75} />
        <span className="min-w-0 truncate font-mono text-sm text-foreground">{entity.name}</span>
        <span className="ml-auto shrink-0 text-[11px] text-muted-foreground">
          {entity.usageCount > 0 ? `used by ${entity.usageCount}` : "unused"}
        </span>
      </div>
      {entity.aliases.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="text-xs text-muted-foreground">also called</span>
          {entity.aliases.map((a) => (
            <Badge key={a} variant="outline">
              {a}
            </Badge>
          ))}
        </div>
      )}
      {entity.expr && (
        <span className="truncate font-mono text-[11px] text-muted-foreground">{entity.expr}</span>
      )}
    </div>
  );
}

// ── Collapsible section — for de-emphasized groups (unused, other) ──

function CollapsibleSection({
  summary,
  aside,
  muted,
  children,
}: {
  summary: ReactNode;
  aside?: string;
  muted?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className={cn("rounded-lg border border-border", muted && "bg-muted/30")}>
      <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 px-3.5 py-2.5 text-left">
        <ChevronRight
          className={cn("size-3.5 shrink-0 text-muted-foreground transition-transform", open && "rotate-90")}
        />
        <span className="text-sm text-muted-foreground">{summary}</span>
        {aside && <span className="ml-auto shrink-0 text-xs text-tertiary">{aside}</span>}
      </button>
      {open && <div className="border-t border-border px-3.5 py-3">{children}</div>}
    </section>
  );
}

function SectionHeading({ icon, title, hint }: { icon?: ReactNode; title: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <div className="flex items-center gap-2">
        {icon}
        <h2 className="text-sm font-semibold text-foreground">{title}</h2>
      </div>
      {hint && <p className="text-xs text-muted-foreground">{hint}</p>}
    </div>
  );
}

function QuestionRow({
  q,
  onSelect,
}: {
  q: { id: string; text: string; status: string; timestamp: string };
  onSelect: (id: string) => void;
}) {
  return (
    <button
      onClick={() => onSelect(q.id)}
      className="flex items-start gap-2 border-b border-border-subtle px-4 py-2 text-left transition-colors last:border-0 hover:bg-muted/50"
    >
      <span className={cn("mt-1.5 size-1.5 shrink-0 rounded-full", statusDotClass(q.status))} aria-hidden />
      <span className="min-w-0 flex-1 truncate text-sm text-foreground">{q.text}</span>
      <span className="shrink-0 pl-2 text-xs text-muted-foreground">{relTime(q.timestamp)}</span>
    </button>
  );
}

// ── Shared detail drawer ─────────────────────────────────────────

function TraceDetail({
  trace,
  all,
  onClose,
  onNavigate,
}: {
  trace: Trace;
  all: Trace[];
  onClose: () => void;
  onNavigate: (t: Trace) => void;
}) {
  const a = trace.action ?? {};
  const malloy = (a.malloy ?? a.model_malloy) as string | undefined;
  const linked = trace.links.map((id) => all.find((t) => t.id === id)).filter((t): t is Trace => !!t);

  return (
    <div className="fixed inset-0 z-40">
      <div className="absolute inset-0 bg-foreground/5" onClick={onClose} />
      <aside className="absolute right-0 top-0 flex h-full w-[440px] flex-col overflow-y-auto border-l border-border bg-card">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-card px-5 py-3">
          <div className="flex items-center gap-2">
            <span className="size-2.5 rounded-full" style={{ backgroundColor: typeColor(trace.decision_type) }} />
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              {typeLabel(trace.decision_type)}
            </span>
            <Badge variant={statusVariant(trace.outcome.status)}>{trace.outcome.status}</Badge>
          </div>
          <button onClick={onClose} className="text-muted-foreground transition-colors hover:text-foreground">
            <X className="size-4" />
          </button>
        </div>

        <div className="flex flex-col gap-4 px-5 py-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm font-medium leading-snug">{trace.observation}</p>
            <p className="text-xs text-muted-foreground">{new Date(trace.timestamp).toLocaleString()}</p>
          </div>

          {trace.reasoning && (
            <Section title="Reasoning">
              <p className="text-sm leading-relaxed text-muted-foreground">{trace.reasoning}</p>
            </Section>
          )}

          {(malloy || hasActionDetail(a)) && (
            <Section title="Action">
              {malloy && <MalloyBlock code={malloy} label="action" />}
              <ActionFields action={a} />
            </Section>
          )}

          <Section title="Outcome">
            <div className="flex flex-col gap-1.5 text-sm">
              <span>
                <span className="text-muted-foreground">status: </span>
                {trace.outcome.status}
              </span>
              {trace.outcome.detail && (
                <p className="leading-relaxed text-muted-foreground">{trace.outcome.detail}</p>
              )}
              {trace.outcome.result_summary && (
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 px-3 py-2 font-mono text-xs">
                  {JSON.stringify(trace.outcome.result_summary, null, 2)}
                </pre>
              )}
            </div>
          </Section>

          {linked.length > 0 && (
            <Section title={`Links (${linked.length})`}>
              <div className="flex flex-col gap-1.5">
                {linked.map((lt) => (
                  <button
                    key={lt.id}
                    onClick={() => onNavigate(lt)}
                    className="flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-left text-sm transition-colors hover:bg-muted"
                  >
                    <span className="size-2 shrink-0 rounded-full" style={{ backgroundColor: typeColor(lt.decision_type) }} />
                    <span className="truncate">{truncate(lt.observation, 44)}</span>
                    <span className="ml-auto pl-2 text-xs text-muted-foreground">{typeLabel(lt.decision_type)}</span>
                  </button>
                ))}
              </div>
            </Section>
          )}
        </div>
      </aside>
    </div>
  );
}

function hasActionDetail(a: Record<string, unknown>): boolean {
  return Boolean(a.old_filter || a.filter || a.find_line || a.missing_concepts || a.matched_terms || a.target);
}

function ActionFields({ action }: { action: Record<string, unknown> }) {
  const a = action;
  const arr = (v: unknown) => (Array.isArray(v) ? (v as unknown[]).map(String) : []);
  return (
    <div className="flex flex-col gap-2.5">
      {typeof a.old_filter === "string" && (
        <div className="flex flex-col gap-1 font-mono text-xs">
          <span className="text-muted-foreground">before: {a.old_filter as string}</span>
          <span className="text-foreground">after:&nbsp; {String(a.new_filter ?? "")}</span>
        </div>
      )}
      {typeof a.filter === "string" && (
        <KV label="filter" mono value={a.filter as string} />
      )}
      {typeof a.find_line === "string" && (
        <div className="flex flex-col gap-1 font-mono text-xs">
          <span className="text-muted-foreground">find:&nbsp;&nbsp;&nbsp;{a.find_line as string}</span>
          <span className="text-foreground">replace: {String(a.replace_line ?? "")}</span>
        </div>
      )}
      {typeof a.target === "string" && <KV label="target" value={a.target as string} />}
      {arr(a.missing_concepts).length > 0 && <Badges label="missing" items={arr(a.missing_concepts)} />}
      {arr(a.matched_terms).length > 0 && <Badges label="terms" items={arr(a.matched_terms)} />}
    </div>
  );
}

function KV({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={cn("text-sm", mono && "font-mono text-xs")}>{value}</span>
    </div>
  );
}

function Badges({ label, items }: { label: string; items: string[] }) {
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}:</span>
      {items.map((i) => (
        <Badge key={i} variant="outline">
          {i}
        </Badge>
      ))}
    </div>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{title}</span>
      {children}
    </div>
  );
}

// ── What-if ──────────────────────────────────────────────────────

function WhatIfPanel({ model }: { model: string }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<WhatIfReport | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const run = () => {
    if (!text.trim() || busy || !model) return;
    setBusy(true);
    setErr(null);
    setReport(null);
    runWhatIf(model, text.trim())
      .then(setReport)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const changed = report?.deltas.filter((d) => d.status === "changed") ?? [];
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString());

  return (
    <Card>
      <CardHeader className="gap-1 border-b border-border py-3">
        <CardTitle className="flex items-center gap-2">
          <FlaskConical className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          What-if simulation
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Re-runs past questions against a proposed change. The real model is never touched.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-3">
        <div className="flex items-center gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="active_users should require at least 2 events"
            onKeyDown={(e) => e.key === "Enter" && run()}
            disabled={!model}
          />
          <Button size="sm" variant="outline" onClick={run} disabled={busy || !text.trim() || !model}>
            {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
            {busy ? "Simulating…" : "Simulate"}
          </Button>
        </div>

        {err && (
          <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
            <span className="font-medium text-foreground">Couldn’t run simulation.</span> {err}
          </div>
        )}

        {report && !report.feasible && (
          <VerificationCallout kind="refusal" title="Can’t simulate this change">
            <div className="flex flex-col gap-2">
              <p>{report.summary}</p>
              {report.suggestion && <p className="text-xs">{report.suggestion}</p>}
              <p className="text-xs text-muted-foreground">The model is unchanged.</p>
            </div>
          </VerificationCallout>
        )}

        {report && report.feasible && (
          <div className="flex flex-col gap-3">
            <p className="text-sm">{report.summary}</p>

            {changed.length > 0 && (
              <div className="overflow-hidden rounded-lg border border-border">
                <Table>
                  <TableHeader>
                    <TableRow className="hover:bg-transparent">
                      <TableHead>Past question</TableHead>
                      <TableHead className="text-right">Before</TableHead>
                      <TableHead className="text-right">After</TableHead>
                      <TableHead className="text-right">Δ</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {changed.map((d) => (
                      <TableRow key={d.traceId}>
                        <TableCell>{truncate(d.question, 42)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{fmt(d.before)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">{fmt(d.after)}</TableCell>
                        <TableCell className="text-right font-mono tabular-nums">
                          {d.deltaPct === null ? "—" : `${d.deltaPct >= 0 ? "+" : ""}${d.deltaPct.toFixed(1)}%`}
                        </TableCell>
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              </div>
            )}

            {report.unanswerable.length > 0 && (
              <VerificationCallout kind="caveat" title={`Blast radius — ${report.unanswerable.length} become unanswerable`}>
                <ul className="flex list-disc flex-col gap-1 pl-4">
                  {report.unanswerable.map((u, i) => (
                    <li key={i}>
                      {truncate(u.question, 60)} <span className="text-muted-foreground">— {u.reason}</span>
                    </li>
                  ))}
                </ul>
              </VerificationCallout>
            )}

            {report.netSummary && <p className="text-sm text-muted-foreground">{report.netSummary}</p>}
            <p className="text-xs text-muted-foreground">Simulation only — the real model is unchanged.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ── Small UI bits ────────────────────────────────────────────────

function ToggleButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded-[5px] px-2 py-1 text-xs transition-colors",
        active ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {children}
    </button>
  );
}

function ModelSelect({
  models,
  value,
  onChange,
}: {
  models: ModelInfo[];
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={models.length === 0}
        className="h-8 appearance-none rounded-md border border-input bg-card py-0 pl-2.5 pr-7 font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
      >
        {models.length === 0 && <option value="">no models</option>}
        {models.map((m) => (
          <option key={m.name} value={m.name}>
            {m.name}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
    </div>
  );
}
