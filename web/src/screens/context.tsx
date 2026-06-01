import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ChevronDown,
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
  type GraphChange,
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
  const cById = useMemo(() => new Map(graph.changes.map((c) => [c.id, c])), [graph]);
  const gById = useMemo(() => new Map(graph.gaps.map((g) => [g.id, g])), [graph]);

  const active = graph.entities.filter((e) => e.usageCount > 0 || e.changeIds.length > 0);
  const dormant = graph.entities.filter((e) => e.usageCount === 0 && e.changeIds.length === 0);
  const otherQuestions = graph.unclusteredQuestionIds
    .map((id) => qById.get(id))
    .filter(Boolean) as EntityGraph["questions"];

  return (
    <div className="flex flex-col gap-4">
      {/* Summary — what the owner gets at a glance */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted-foreground">
        <span><span className="font-medium text-foreground">{graph.stats.questions}</span> questions</span>
        <span className="text-border-strong">·</span>
        <span><span className="font-medium text-foreground">{graph.entities.length}</span> measures &amp; definitions</span>
        <span className="text-border-strong">·</span>
        <span><span className="font-medium text-foreground">{graph.stats.changes}</span> changes</span>
        <span className="text-border-strong">·</span>
        <span><span className="font-medium text-foreground">{graph.gaps.length}</span> gaps</span>
      </div>

      {/* Entity clusters — questions grouped around what they used, most-used first */}
      {active.length > 0 ? (
        <div className="grid grid-cols-1 items-start gap-3 md:grid-cols-2">
          {active.map((e) => (
            <EntityCluster key={e.id} entity={e} qById={qById} cById={cById} onSelectTrace={onSelectTrace} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-border px-4 py-6 text-center text-sm text-muted-foreground">
          No questions have referenced a measure or definition yet.
        </p>
      )}

      {/* Gaps — clustered by the missing concept = what to add */}
      {graph.gaps.length > 0 && <GapsCluster graph={graph} gById={gById} onSelectTrace={onSelectTrace} />}

      {/* Questions that referenced no known entity */}
      {otherQuestions.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border py-2.5">
            <CardTitle className="text-muted-foreground">
              Other questions <span className="text-muted-foreground/60">({otherQuestions.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-0 p-0">
            {otherQuestions.map((q) => (
              <QuestionRow key={q.id} q={q} onSelect={onSelectTrace} />
            ))}
          </CardContent>
        </Card>
      )}

      {/* Building blocks no one has used yet */}
      {dormant.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-muted/40 px-3.5 py-3">
          <span className="text-xs text-muted-foreground">Not used yet:</span>
          {dormant.map((e) => (
            <span
              key={e.id}
              className="inline-flex items-center gap-1 rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
            >
              <KindIcon kind={e.kind} />
              {e.name}
            </span>
          ))}
        </div>
      )}
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

function EntityCluster({
  entity,
  qById,
  cById,
  onSelectTrace,
}: {
  entity: GraphEntity;
  qById: Map<string, EntityGraph["questions"][number]>;
  cById: Map<string, GraphChange>;
  onSelectTrace: (id: string) => void;
}) {
  const questions = entity.questionIds.map((id) => qById.get(id)).filter(Boolean) as EntityGraph["questions"];
  const changes = entity.changeIds.map((id) => cById.get(id)).filter(Boolean) as GraphChange[];

  return (
    <Card>
      <CardHeader className="gap-1.5 border-b border-border py-2.5">
        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 items-center gap-2">
            <KindIcon kind={entity.kind} />
            <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">
              {KIND_LABEL[entity.kind]}
            </span>
            <span className="truncate font-mono text-sm text-foreground">{entity.name}</span>
          </div>
          <Badge variant={entity.usageCount > 0 ? "default" : "outline"}>
            {entity.usageCount > 0 ? `used by ${entity.usageCount}` : "unused"}
          </Badge>
        </div>
        {entity.expr && <span className="truncate font-mono text-xs text-muted-foreground">{entity.expr}</span>}
        {entity.aliases.length > 0 && (
          <span className="flex flex-wrap items-center gap-1.5">
            <span className="text-xs text-muted-foreground">also called</span>
            {entity.aliases.map((a) => (
              <Badge key={a} variant="outline">{a}</Badge>
            ))}
          </span>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-0 p-0">
        {/* How its meaning evolved — changes that touched this entity */}
        {changes.map((c) => (
          <button
            key={c.id}
            onClick={() => onSelectTrace(c.id)}
            className="flex flex-col gap-0.5 border-b border-border-subtle px-4 py-2 text-left transition-colors hover:bg-muted/50"
          >
            <span className="flex items-center gap-1.5 text-xs">
              <Sparkles className="size-3 shrink-0 text-tertiary" strokeWidth={1.75} />
              <span className="font-medium text-foreground">{c.label}</span>
              {c.affectedQuestionIds.length > 0 && (
                <span className="text-muted-foreground">· affected {c.affectedQuestionIds.length}</span>
              )}
            </span>
            {c.detail && <span className="truncate pl-4 font-mono text-[11px] text-muted-foreground">{c.detail}</span>}
          </button>
        ))}

        {/* Questions clustered under this entity */}
        {questions.length > 0
          ? questions.map((q) => <QuestionRow key={q.id} q={q} onSelect={onSelectTrace} />)
          : changes.length === 0 && (
              <p className="px-4 py-3 text-xs text-muted-foreground">No questions have used this yet.</p>
            )}
      </CardContent>
    </Card>
  );
}

function GapsCluster({
  graph,
  gById,
  onSelectTrace,
}: {
  graph: EntityGraph;
  gById: Map<string, EntityGraph["gaps"][number]>;
  onSelectTrace: (id: string) => void;
}) {
  return (
    <Card>
      <CardHeader className="gap-1 border-b border-border py-2.5">
        <CardTitle className="flex items-center gap-2">
          <CircleHelp className="size-3.5 text-tertiary" strokeWidth={1.75} />
          Gaps — asked but unanswerable <span className="text-muted-foreground/60">({graph.gaps.length})</span>
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          What people asked that the model couldn’t answer — clustered by the missing concept. These are
          candidates to add.
        </p>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 p-0">
        {graph.gapConcepts.map((gc) => (
          <div key={gc.concept} className="flex flex-col gap-1.5 border-b border-border-subtle px-4 py-2.5 last:border-0">
            <div className="flex items-center gap-2">
              <Badge variant="warn">missing: {gc.concept}</Badge>
              <span className="text-xs text-muted-foreground">
                {gc.gapIds.length} question{gc.gapIds.length === 1 ? "" : "s"}
              </span>
            </div>
            <div className="flex flex-col">
              {gc.gapIds.map((id) => {
                const g = gById.get(id);
                if (!g) return null;
                return (
                  <button
                    key={id}
                    onClick={() => onSelectTrace(id)}
                    className="flex items-start gap-2 rounded-md px-1 py-1 text-left transition-colors hover:bg-muted/50"
                  >
                    <span className="mt-1.5 size-1.5 shrink-0 rounded-full bg-destructive/60" aria-hidden />
                    <span className="min-w-0 flex-1 truncate text-sm text-foreground">{g.text}</span>
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
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
