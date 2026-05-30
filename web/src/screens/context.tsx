import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type SimulationNodeDatum,
} from "d3-force";
import {
  ChevronDown,
  FlaskConical,
  GitBranch,
  Link2,
  List,
  Loader2,
  Network,
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
  fetchModels,
  fetchTraces,
  runWhatIf,
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
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "graph">("list");
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
    fetchTraces(model)
      .then(setTraces)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  }, [model]);

  // Newest first for the timeline / detail lookups.
  const ordered = useMemo(
    () => [...traces].sort((a, b) => (a.timestamp < b.timestamp ? 1 : -1)),
    [traces],
  );

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-medium tracking-tight">Context</h1>
          <p className="text-sm text-muted-foreground">
            The append-only trace of every decision — asks, corrections, refusals — with reasoning,
            outcome, and links.
          </p>
        </div>
        <ModelSelect models={models} value={model} onChange={setModel} />
      </div>

      <WhatIfPanel model={model} />

      <Separator />

      {/* History header + view toggle */}
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Decision history{traces.length > 0 ? ` · ${traces.length}` : ""}
        </span>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <ToggleButton active={view === "list"} onClick={() => setView("list")}>
            <List className="size-3.5" /> List
          </ToggleButton>
          <ToggleButton active={view === "graph"} onClick={() => setView("graph")}>
            <Network className="size-3.5" /> Graph
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
          {view === "list" ? (
            <Timeline traces={ordered} onSelect={setSelected} />
          ) : (
            <GraphView traces={ordered} onSelect={setSelected} />
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

// ── Graph (d3-force, static layout, SVG) ─────────────────────────

interface GNode extends SimulationNodeDatum {
  id: string;
  type: string;
  label: string;
}
interface GLink {
  source: string | GNode;
  target: string | GNode;
}

function GraphView({ traces, onSelect }: { traces: Trace[]; onSelect: (t: Trace) => void }) {
  const W = 720;
  const H = 440;

  const { nodes, links } = useMemo(() => {
    const idset = new Set(traces.map((t) => t.id));
    const nodes: GNode[] = traces.map((t) => ({ id: t.id, type: t.decision_type, label: t.observation }));
    const links: GLink[] = [];
    for (const t of traces) {
      for (const to of t.links ?? []) {
        if (idset.has(to)) links.push({ source: t.id, target: to });
      }
    }
    const sim = forceSimulation(nodes)
      .force("charge", forceManyBody().strength(-180))
      .force("link", forceLink<GNode, GLink>(links).id((d) => d.id).distance(72))
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide(22))
      .stop();
    for (let i = 0; i < 300; i++) sim.tick();
    return { nodes, links };
  }, [traces]);

  const xs = nodes.map((n) => n.x ?? 0);
  const ys = nodes.map((n) => n.y ?? 0);
  const pad = 40;
  const minX = Math.min(W, ...xs) - pad;
  const maxX = Math.max(0, ...xs) + pad;
  const minY = Math.min(H, ...ys) - pad;
  const maxY = Math.max(0, ...ys) + pad;
  const showLabels = nodes.length <= 30;
  const byId = (id: string) => traces.find((t) => t.id === id);

  return (
    <div className="overflow-hidden rounded-lg border border-border bg-card">
      <svg
        width="100%"
        height={460}
        viewBox={`${minX} ${minY} ${maxX - minX} ${maxY - minY}`}
        preserveAspectRatio="xMidYMid meet"
      >
        <defs>
          <marker
            id="ctx-arrow"
            viewBox="0 0 10 10"
            refX="17"
            refY="5"
            markerWidth="5"
            markerHeight="5"
            orient="auto-start-reverse"
          >
            <path d="M0,0 L10,5 L0,10 z" fill="hsl(0 0% 78%)" />
          </marker>
        </defs>
        {links.map((l, i) => {
          const s = l.source as GNode;
          const t = l.target as GNode;
          return (
            <line
              key={i}
              x1={s.x}
              y1={s.y}
              x2={t.x}
              y2={t.y}
              stroke="hsl(0 0% 82%)"
              strokeWidth={1}
              markerEnd="url(#ctx-arrow)"
            />
          );
        })}
        {nodes.map((n) => (
          <g
            key={n.id}
            transform={`translate(${n.x ?? 0},${n.y ?? 0})`}
            className="cursor-pointer"
            onClick={() => {
              const t = byId(n.id);
              if (t) onSelect(t);
            }}
          >
            <circle r={7} fill={typeColor(n.type)} stroke="white" strokeWidth={1.5} />
            {showLabels && (
              <text x={11} y={3.5} fontSize={10} fill="hsl(0 0% 38%)">
                {truncate(n.label, 22)}
              </text>
            )}
          </g>
        ))}
      </svg>
      <div className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-border px-3 py-2">
        {Object.keys(TYPE_LABELS).map((t) => (
          <span key={t} className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <span className="size-2 rounded-full" style={{ backgroundColor: typeColor(t) }} />
            {typeLabel(t)}
          </span>
        ))}
      </div>
    </div>
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
      <aside className="absolute right-0 top-0 flex h-full w-[440px] flex-col overflow-y-auto border-l border-border bg-background">
        <div className="sticky top-0 flex items-center justify-between border-b border-border bg-background px-5 py-3">
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
        active ? "bg-primary/5 font-medium text-foreground" : "text-muted-foreground hover:text-foreground",
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
        className="h-8 appearance-none rounded-md border border-input bg-background py-0 pl-2.5 pr-7 font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:opacity-50"
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
