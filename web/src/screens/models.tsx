import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronDown,
  ChevronRight,
  Database,
  KeyRound,
  Loader2,
  MoreHorizontal,
  Plus,
  ScanSearch,
  Search,
  Sparkles,
  TriangleAlert,
  Trash2,
  X,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MalloyBlock } from "@/components/malloy-block";
import { McpConnect } from "@/components/mcp-connect";
import { VerificationCallout } from "@/components/verification-callout";
import { DeleteModelDialog } from "@/components/delete-model-dialog";
import { ModelEditor } from "./model-editor";
import {
  activateConnection,
  addDefinition,
  designBuild,
  designDecisions,
  designPlan,
  fetchConnections,
  fetchModels,
  runIntrospection,
  type BuildOutcome,
  type ConnectionMeta,
  type DefinitionOutcome,
  type DesignPlan,
  type IntrospectJobStatus,
  type JoinPlan,
  type ModelInfo,
} from "@/lib/api";

const INTROSPECT_STAGE_LABEL: Record<string, string> = {
  connecting: "Connecting",
  listing_tables: "Listing tables",
  reading_columns: "Reading columns",
  sampling: "Reading tables",
  writing: "Writing substrate",
  done: "Done",
};

/** Parse a comma/space-separated aliases input into a clean list. */
function parseAliases(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

type Mode = { kind: "view" } | { kind: "detail"; name: string } | { kind: "design" };

export function ModelsScreen() {
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    fetchModels()
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

  // Brief, auto-dismissing confirmation after a delete.
  const flash = (msg: string) => {
    setNotice(msg);
    window.setTimeout(() => setNotice((cur) => (cur === msg ? null : cur)), 4000);
  };

  if (mode.kind === "design") {
    return (
      <DesignWizard
        onCancel={() => setMode({ kind: "view" })}
        onBuilt={(name) => {
          refresh();
          setMode({ kind: "detail", name });
        }}
      />
    );
  }

  if (mode.kind === "detail") {
    return (
      <ModelEditor
        name={mode.name}
        onBack={() => setMode({ kind: "view" })}
        onDeleted={(name) => {
          setModels((prev) => prev.filter((m) => m.name !== name));
          flash(`Deleted “${name}”.`);
          setMode({ kind: "view" });
          refresh();
        }}
      />
    );
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-lg font-normal tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground">
            Purpose-built semantic models scoped over your warehouse.
          </p>
        </div>
        <Button size="sm" onClick={() => setMode({ kind: "design" })}>
          <Plus className="size-3.5" />
          Design new model
        </Button>
      </div>

      {notice && (
        <div className="flex items-center gap-2 rounded-md border border-border bg-muted/50 px-3.5 py-2.5 text-sm text-muted-foreground">
          <Check className="size-3.5 text-success" strokeWidth={2.5} />
          {notice}
        </div>
      )}

      {loading && <Loading label="Loading models…" />}
      {error && !loading && (
        <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Couldn’t load models.</span> {error}
        </div>
      )}

      {!loading && !error && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {models.map((m) => (
            <Card
              key={m.name}
              className="cursor-pointer transition-colors hover:border-foreground/20"
              onClick={() => setMode({ kind: "detail", name: m.name })}
            >
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2 font-mono">
                    <Boxes className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                    {m.name}
                  </CardTitle>
                  <div className="flex items-center gap-1.5">
                    {m.connector && <Badge variant="outline">{m.connector}</Badge>}
                    <CardActions name={m.name} onRequestDelete={() => setDeleteTarget(m.name)} />
                  </div>
                </div>
                <CardDescription>{m.purpose}</CardDescription>
              </CardHeader>
              <CardContent className="flex items-center justify-between">
                <span className="font-mono text-xs text-muted-foreground">
                  {m.measureCount} measures · {m.tableCount} tables
                </span>
                <span className="flex items-center gap-1 text-xs text-muted-foreground">
                  Open <ArrowUpRight className="size-3.5" />
                </span>
              </CardContent>
            </Card>
          ))}

          <button
            onClick={() => setMode({ kind: "design" })}
            className="flex min-h-[116px] flex-col items-center justify-center gap-1.5 rounded-lg border border-dashed border-border text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
          >
            <Plus className="size-4" strokeWidth={1.75} />
            <span className="text-sm">Design a new model</span>
          </button>
        </div>
      )}

      <DeleteModelDialog
        name={deleteTarget}
        open={deleteTarget !== null}
        onOpenChange={(o) => !o && setDeleteTarget(null)}
        onDeleted={(name) => {
          setDeleteTarget(null);
          setModels((prev) => prev.filter((m) => m.name !== name));
          flash(`Deleted “${name}”.`);
        }}
      />
    </div>
  );
}

// ── Delete affordances ───────────────────────────────────────────

// Subtle per-card actions menu (•••). Stops click propagation so it never
// triggers the card's open-detail handler. One destructive item, muted red.
function CardActions({ name, onRequestDelete }: { name: string; onRequestDelete: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative" onClick={(e) => e.stopPropagation()}>
      <button
        aria-label={`Actions for ${name}`}
        onClick={(e) => {
          e.stopPropagation();
          setOpen((v) => !v);
        }}
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground/50 transition-colors hover:bg-muted hover:text-foreground"
      >
        <MoreHorizontal className="size-4" />
      </button>
      {open && (
        <>
          {/* Click-away backdrop */}
          <div
            className="fixed inset-0 z-10"
            onClick={(e) => {
              e.stopPropagation();
              setOpen(false);
            }}
          />
          <div className="absolute right-0 z-20 mt-1 w-36 overflow-hidden rounded-md border border-border bg-popover py-1 shadow-popover">
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen(false);
                onRequestDelete();
              }}
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm text-destructive transition-colors hover:bg-destructive-subtle"
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}

// ── Design wizard ────────────────────────────────────────────────

type Step = "datasource" | "form" | "plan" | "decisions" | "definitions" | "building" | "result";

function DesignWizard({
  onCancel,
  onBuilt,
}: {
  onCancel: () => void;
  onBuilt: (name: string) => void;
}) {
  const [step, setStep] = useState<Step>("datasource");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 0 — datasource selection. The chosen connection's substrate drives the
  // ENTIRE build (plan → decisions → build); no default/shared substrate is used.
  const [connections, setConnections] = useState<ConnectionMeta[] | null>(null);
  const [selectedConn, setSelectedConn] = useState<ConnectionMeta | null>(null);
  const [introspectingId, setIntrospectingId] = useState<string | null>(null);
  const [introspectProgress, setIntrospectProgress] = useState<IntrospectJobStatus | null>(null);

  // Step 1
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tablesInput, setTablesInput] = useState("");
  // Substrate dir is derived from the selected datasource — never free-typed.
  const [substrateDir, setSubstrateDir] = useState("");

  const loadConnections = () =>
    fetchConnections()
      .then(({ connections }) => {
        setConnections(connections);
        // If exactly one datasource is connected, pre-select it (still shown).
        if (connections.length === 1) setSelectedConn(connections[0]);
        return connections;
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        return [] as ConnectionMeta[];
      });

  useEffect(() => {
    loadConnections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Commit a chosen datasource: activate it (so creds/env follow this
  // connection) and pin its substrate for the whole build, then move on.
  const chooseDatasource = async (conn: ConnectionMeta) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await activateConnection(conn.id);
      setSelectedConn(conn);
      setSubstrateDir(conn.substrateDir ?? "");
      setStep("form");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Introspect a not-yet-ready datasource straight from the selector — runs as
  // a background job with live progress, then re-selects it as ready.
  const introspectDatasource = async (conn: ConnectionMeta) => {
    if (introspectingId) return;
    setIntrospectingId(conn.id);
    setIntrospectProgress(null);
    setError(null);
    try {
      await runIntrospection(conn.id, (s) => setIntrospectProgress(s));
      const fresh = await loadConnections();
      const updated = fresh.find((c) => c.id === conn.id);
      if (updated) setSelectedConn(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIntrospectingId(null);
      setIntrospectProgress(null);
    }
  };

  // Step 1–2
  const [plan, setPlan] = useState<DesignPlan | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [tableSearch, setTableSearch] = useState("");
  const [choices, setChoices] = useState<Record<string, string>>({});
  // Sorted-join key of the table set the current decisions were generated from.
  const [decisionsTablesKey, setDecisionsTablesKey] = useState("");
  // Deterministic join plan + the user's overrides (kept fact, dropped joins).
  const [joinPlan, setJoinPlan] = useState<JoinPlan | null>(null);
  const [factOverride, setFactOverride] = useState<string>("");
  const [droppedJoins, setDroppedJoins] = useState<Set<string>>(new Set()); // join.table names the user excluded
  const [expandedTable, setExpandedTable] = useState<string | null>(null); // tables-step schema expander

  // Step 2.5 — open custom definitions (baked into the model, with aliases)
  const [definitions, setDefinitions] = useState<{ text: string; aliases: string }[]>([]);
  const [defInput, setDefInput] = useState("");
  const [defAliasInput, setDefAliasInput] = useState("");
  const [bakedConcepts, setBakedConcepts] = useState<DefinitionOutcome[]>([]);

  // Step 3
  const [outcome, setOutcome] = useState<BuildOutcome | null>(null);
  const [clarifications, setClarifications] = useState<{ question: string; answer: string }[]>([]);
  const [clarifyChoices, setClarifyChoices] = useState<Record<string, string>>({});
  const [clarifyRound, setClarifyRound] = useState(0);

  const runPlan = () => {
    if (!purpose.trim() || busy) return;
    setBusy(true);
    setError(null);
    const tables = tablesInput
      .split(/[\s,]+/)
      .map((t) => t.trim())
      .filter(Boolean);
    designPlan({
      name: name.trim(),
      purpose: purpose.trim(),
      tables: tables.length ? tables : undefined,
      substrate_dir: substrateDir.trim() || undefined,
    })
      .then((p) => {
        setPlan(p);
        // Pin the resolved substrate path so the build step uses the SAME dir.
        setSubstrateDir(p.substrateDir);
        setSelectedTables(
          new Set(
            (p.allTables.length ? p.allTables.filter((t) => t.proposed) : p.relevantTables).map(
              (t) => t.name,
            ),
          ),
        );
        setTableSearch("");
        // Decisions are generated later (runDecisions), from the finalized
        // table set — not pre-generated against the AI's original proposal.
        setChoices({});
        setDecisionsTablesKey("");
        setStep("plan");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  // Generate decisions FROM the user's finalized table selection. Called on
  // Continue from the Tables step. Regenerates only when the selected set
  // differs from the set the current decisions were generated against, so
  // dropped tables can never linger in options and added tables are considered.
  const tablesKey = (s: Set<string>) => [...s].sort().join("|");
  // Fetch decisions + the deterministic join plan for the current selection.
  // `fact` lets the user re-root the plan around a different fact table.
  const runDecisions = async (fact?: string, force = false) => {
    if (!plan || busy) return;
    const key = tablesKey(selectedTables) + "|fact=" + (fact ?? "");
    if (!force && key === decisionsTablesKey && plan.decisions.length > 0) {
      setStep("decisions"); // unchanged — reuse
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await designDecisions({
        purpose: plan.purpose,
        substrate_dir: plan.substrateDir || undefined,
        tables: [...selectedTables],
        fact,
      });
      setPlan({ ...plan, decisions: res.decisions });
      setJoinPlan(res.joinPlan);
      setFactOverride(res.joinPlan.fact);
      setDroppedJoins(new Set());
      const initial: Record<string, string> = {};
      for (const d of res.decisions) {
        const rec = d.options.find((o) => o.recommended) ?? d.options[0];
        if (rec) initial[d.id] = rec.label;
      }
      setChoices(initial);
      setDecisionsTablesKey(key);
      setStep("decisions");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  // Re-root the join plan around a different fact (re-fetches the plan).
  const changeFact = (fact: string) => {
    if (busy || fact === factOverride) return;
    setFactOverride(fact);
    runDecisions(fact, true);
  };

  const runBuild = async (extraClarification?: { question: string; answer: string }[]) => {
    if (!plan) return;
    setStep("building");
    setError(null);
    const allClarifications = [...clarifications, ...(extraClarification ?? [])];
    const resolved = plan.decisions
      .filter((d) => choices[d.id])
      .map((d) => ({ decision_id: d.id, chosen: choices[d.id] }));
    const relevant = (
      plan.allTables.length
        ? plan.allTables.map((t) => ({ name: t.name, reason: t.reason }))
        : plan.relevantTables
    ).filter((t) => selectedTables.has(t.name));

    // The CONFIRMED join plan: kept joins (user-dropped ones move to unjoinable
    // so the build omits them). This is what the compiled model is validated to.
    const confirmedPlan: JoinPlan | undefined = joinPlan
      ? {
          ...joinPlan,
          joins: joinPlan.joins.filter((j) => !droppedJoins.has(j.table)),
          unjoinable: [
            ...joinPlan.unjoinable,
            ...joinPlan.joins
              .filter((j) => droppedJoins.has(j.table))
              .map((j) => ({ table: j.table, reason: "excluded by you in the preview" })),
          ],
        }
      : undefined;

    try {
      // Build the structural model first (decisions + tables).
      const res = await designBuild({
        name: name.trim(),
        purpose: purpose.trim(),
        resolved_decisions: resolved,
        relevant_tables: relevant,
        substrate_dir: substrateDir.trim() || undefined,
        clarifications: allClarifications.length ? allClarifications : undefined,
        datasource: selectedConn?.name,
        join_plan: confirmedPlan,
      });
      setClarifications(allClarifications);

      // Bake definitions only once we have a WRITTEN model (not a clarification
      // pause). Each is recorded as a concept with its explicit aliases.
      if (!res.clarificationsNeeded?.length && definitions.length > 0) {
        const applied: DefinitionOutcome[] = [];
        for (const d of definitions) {
          try {
            applied.push(await addDefinition(name.trim(), d.text, parseAliases(d.aliases)));
          } catch {
            /* best-effort — one bad definition shouldn't lose the rest */
          }
        }
        setBakedConcepts(applied);
      }

      setOutcome(res);
      setStep("result");
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setStep("result");
    }
  };

  const submitClarifications = () => {
    if (!outcome) return;
    const answers = outcome.clarificationsNeeded.map((q) => ({
      question: q.question,
      answer: clarifyChoices[q.id] ?? "(use your best judgment)",
    }));
    setClarifyChoices({});
    setClarifyRound((r) => r + 1);
    runBuild(answers);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <button
        onClick={onCancel}
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Models
      </button>

      <WizardHeader step={step} />

      {error && step !== "result" && (
        <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          {error}
        </div>
      )}

      {/* Step 0 — datasource selector. Drives the substrate for the whole build. */}
      {step === "datasource" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <h2 className="text-sm font-medium text-foreground">Which datasource?</h2>
            <p className="text-sm text-muted-foreground">
              The datasource you pick determines the schema this model is built from. Everything
              downstream — proposed tables, decisions, and the build — reads from its substrate.
            </p>
          </div>

          {connections === null && (
            <div className="flex items-center gap-2 py-6 text-sm text-muted-foreground">
              <Loader2 className="size-4 animate-spin" /> Loading datasources…
            </div>
          )}

          {connections && connections.length === 0 && (
            <div className="rounded-md border border-dashed border-border px-4 py-6 text-sm text-muted-foreground">
              No datasources connected. Add one on the <span className="font-medium text-foreground">Connections</span> screen, then introspect it.
            </div>
          )}

          {connections && connections.length > 0 && (
            <div className="flex flex-col gap-2">
              {connections.map((c) => {
                const on = selectedConn?.id === c.id;
                return (
                  <button
                    key={c.id}
                    onClick={() => setSelectedConn(c)}
                    className={cn(
                      "flex items-center gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                      on ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted",
                    )}
                  >
                    <Database className="size-4 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                    <span className="flex min-w-0 flex-col gap-0.5">
                      <span className="flex items-center gap-2">
                        <span className="font-mono text-sm text-foreground">{c.name}</span>
                        <Badge variant="outline">{c.type}</Badge>
                        {c.active && <Badge variant="success">active</Badge>}
                      </span>
                      <span className="font-mono text-[11px] text-muted-foreground">{c.masked}</span>
                    </span>
                    <span
                      className={cn(
                        "ml-auto shrink-0 rounded-full px-2 py-0.5 text-[11px] font-medium",
                        c.hasSubstrate ? "bg-success/10 text-success" : "bg-warn/10 text-warn",
                      )}
                    >
                      {c.hasSubstrate ? "ready" : "not introspected yet"}
                    </span>
                  </button>
                );
              })}

              {/* Not-introspected prompt — NEVER silently fall back to another substrate. */}
              {selectedConn && !selectedConn.hasSubstrate && (
                <div className="flex flex-col gap-2 rounded-md border border-warn/30 bg-warn/5 px-3.5 py-3">
                  <p className="text-sm text-foreground">
                    <span className="font-mono">{selectedConn.name}</span> hasn't been introspected yet —
                    introspect it first so there's a schema to build from.
                  </p>
                  <p className="text-xs text-muted-foreground">
                    This scans the warehouse and writes its substrate. It can take a few minutes for a large
                    dataset. You can also run it from the Connections screen.
                  </p>
                  {introspectingId === selectedConn.id ? (
                    <div className="flex flex-col gap-1.5 rounded-md border border-border bg-card px-3 py-2.5">
                      <div className="flex items-center gap-2">
                        <Loader2 className="size-3.5 shrink-0 animate-spin text-muted-foreground" />
                        <span className="text-xs font-medium text-foreground">
                          {INTROSPECT_STAGE_LABEL[introspectProgress?.stage ?? "connecting"] ?? "Working"}
                        </span>
                        {introspectProgress?.tablesTotal ? (
                          <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
                            {introspectProgress.tablesDone ?? 0} / {introspectProgress.tablesTotal} tables
                          </span>
                        ) : null}
                      </div>
                      <span className="font-mono text-[11px] text-muted-foreground">
                        {introspectProgress?.message ?? "Starting…"}
                      </span>
                      {introspectProgress?.tablesTotal ? (
                        <div className="h-1 w-full overflow-hidden rounded-full bg-border-subtle">
                          <div
                            className="h-full rounded-full bg-foreground/30 transition-all"
                            style={{
                              width: `${Math.round(((introspectProgress.tablesDone ?? 0) / introspectProgress.tablesTotal) * 100)}%`,
                            }}
                          />
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div>
                      <Button size="sm" variant="outline" onClick={() => introspectDatasource(selectedConn)}>
                        <ScanSearch className="size-3.5" />
                        Introspect now
                      </Button>
                    </div>
                  )}
                </div>
              )}

              <div className="flex justify-end pt-1">
                <Button
                  onClick={() => selectedConn && chooseDatasource(selectedConn)}
                  disabled={busy || !selectedConn || !selectedConn.hasSubstrate}
                >
                  {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                  Continue
                  <ChevronRight className="size-3.5" />
                </Button>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Step 1 — form */}
      {step === "form" && (
        <div className="flex flex-col gap-4">
          <Field label="Model name">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="product-usage"
              className="font-mono"
            />
          </Field>
          <Field label="Purpose" hint="What should this model help you analyze?">
            <Textarea
              value={purpose}
              onChange={(e) => setPurpose(e.target.value)}
              placeholder="Analyze how users engage with the product"
              className="min-h-[72px]"
            />
          </Field>
          {selectedConn && (
            <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3.5 py-2.5">
              <span className="flex items-center gap-2 text-sm text-muted-foreground">
                <Database className="size-3.5" strokeWidth={1.75} />
                Building on
                <span className="font-mono text-foreground">{selectedConn.name}</span>
                <Badge variant="outline">{selectedConn.type}</Badge>
              </span>
              <button
                onClick={() => setStep("datasource")}
                className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Change datasource
              </button>
            </div>
          )}
          <Field label="Limit to specific tables" hint="Optional — comma or space separated. Leave blank to let Weft choose.">
            <Input
              value={tablesInput}
              onChange={(e) => setTablesInput(e.target.value)}
              placeholder="ga_sessions, sf_opps, dim_accounts"
              className="font-mono"
            />
          </Field>
          <div className="flex justify-end">
            <Button onClick={runPlan} disabled={busy || !purpose.trim() || !name.trim()}>
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Sparkles className="size-3.5" />}
              {busy ? "Reading your schema…" : "Propose plan"}
            </Button>
          </div>
        </div>
      )}

      {/* Step 1 — plan / table selection */}
      {step === "plan" && plan && (() => {
        const all =
          plan.allTables.length > 0
            ? plan.allTables
            : plan.relevantTables.map((t) => ({
                name: t.name,
                rowCount: 0,
                columnCount: 0,
                proposed: true,
                reason: t.reason,
                columns: [],
              }));
        const toggle = (nameOf: string) =>
          setSelectedTables((prev) => {
            const next = new Set(prev);
            if (next.has(nameOf)) next.delete(nameOf);
            else next.add(nameOf);
            return next;
          });
        const selected = all.filter((t) => selectedTables.has(t.name));
        const other = all.filter((t) => !selectedTables.has(t.name));
        const q = tableSearch.trim().toLowerCase();
        const otherShown = q ? other.filter((t) => t.name.toLowerCase().includes(q)) : other;

        const Row = (t: (typeof all)[number]) => {
          const on = selectedTables.has(t.name);
          const open = expandedTable === t.name;
          const meta = `${t.rowCount.toLocaleString()} rows · ${t.columnCount} cols`;
          const keyCols = (t.columns ?? []).filter((c) => c.isKey).map((c) => c.name);
          return (
            <div
              key={t.name}
              className={cn(
                "rounded-md border transition-colors",
                on ? "border-foreground/40 bg-muted" : "border-border",
              )}
            >
              <div className="flex items-start gap-3 px-3 py-2.5">
                <button
                  onClick={() => toggle(t.name)}
                  className={cn(
                    "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                    on ? "border-foreground bg-foreground text-background" : "border-border",
                  )}
                >
                  {on && <Check className="size-3" strokeWidth={2.5} />}
                </button>
                <button onClick={() => toggle(t.name)} className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                  <span className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
                    <span className="font-mono text-sm text-foreground">{t.name}</span>
                    {t.rowCount > 0 || t.columnCount > 0 ? (
                      <span className="font-mono text-[11px] text-muted-foreground">{meta}</span>
                    ) : null}
                    {keyCols.length > 0 && (
                      <span className="text-[10px] text-tertiary">
                        key{keyCols.length > 1 ? "s" : ""}: {keyCols.slice(0, 3).join(", ")}
                        {keyCols.length > 3 ? "…" : ""}
                      </span>
                    )}
                  </span>
                  {t.reason && <span className="text-xs text-muted-foreground">{t.reason}</span>}
                </button>
                {(t.columns?.length ?? 0) > 0 && (
                  <button
                    onClick={() => setExpandedTable(open ? null : t.name)}
                    className="shrink-0 text-muted-foreground transition-colors hover:text-foreground"
                    title="Show fields"
                  >
                    <ChevronDown className={cn("size-4 transition-transform", open && "rotate-180")} />
                  </button>
                )}
              </div>
              {open && (t.columns?.length ?? 0) > 0 && (
                <div className="flex flex-col gap-0.5 border-t border-border px-3 py-2">
                  {t.columns.map((c) => (
                    <div key={c.name} className="flex items-baseline gap-2 text-[11px]">
                      {c.isKey ? (
                        <KeyRound className="size-3 shrink-0 text-tertiary" strokeWidth={1.75} />
                      ) : (
                        <span className="size-3 shrink-0" />
                      )}
                      <span className="font-mono text-foreground">{c.name}</span>
                      <span className="font-mono text-muted-foreground">
                        {c.type}
                        {c.nullable ? "" : " NOT NULL"}
                      </span>
                      <span className="text-tertiary">{c.distinct.toLocaleString()} distinct</span>
                      {c.sample != null && (
                        <span className="ml-auto min-w-0 truncate pl-2 font-mono text-muted-foreground">
                          e.g. {c.sample}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          );
        };

        return (
          <div className="flex flex-col gap-5">
            <div className="flex items-start justify-between gap-4">
              <p className="text-sm text-muted-foreground">{plan.tableSelectionReasoning}</p>
              <span className="shrink-0 whitespace-nowrap rounded-full border border-border px-2.5 py-1 text-xs text-muted-foreground">
                {selectedTables.size} selected
              </span>
            </div>

            {/* Section 1 — selected */}
            <div className="flex flex-col gap-2">
              <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Selected tables ({selected.length})
              </span>
              {selected.length > 0 ? (
                selected.map(Row)
              ) : (
                <p className="rounded-md border border-dashed border-border px-3 py-4 text-sm text-muted-foreground">
                  No tables selected. Pick at least one from below.
                </p>
              )}
            </div>

            {/* divider */}
            <div className="h-px bg-border" />

            {/* Section 2 — everything else */}
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between gap-3">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Other tables ({other.length})
                </span>
              </div>
              {other.length > 0 && (
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={tableSearch}
                    onChange={(e) => setTableSearch(e.target.value)}
                    placeholder="Filter tables by name…"
                    className="pl-8"
                  />
                </div>
              )}
              {otherShown.length > 0 ? (
                otherShown.map(Row)
              ) : (
                <p className="px-1 py-2 text-xs text-muted-foreground">
                  {other.length === 0 ? "All tables are selected." : `No tables match "${tableSearch}".`}
                </p>
              )}
            </div>

            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">{selectedTables.size} tables selected</span>
              <Button onClick={() => runDecisions()} disabled={selectedTables.size === 0 || busy}>
                {busy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {busy ? "Generating decisions…" : "Continue to decisions"}
                {busy ? null : <ChevronRight className="size-3.5" />}
              </Button>
            </div>
          </div>
        );
      })()}

      {/* Step 2 — decisions (the centerpiece) */}
      {step === "decisions" && plan && (
        <div className="flex flex-col gap-4">
          {joinPlan && (
            <JoinPlanPanel
              plan={joinPlan}
              dropped={droppedJoins}
              onToggleJoin={(table) =>
                setDroppedJoins((prev) => {
                  const next = new Set(prev);
                  if (next.has(table)) next.delete(table);
                  else next.add(table);
                  return next;
                })
              }
              fact={factOverride || joinPlan.fact}
              factOptions={[...selectedTables].sort()}
              onChangeFact={changeFact}
              busy={busy}
            />
          )}
          {plan.decisions.length > 0 && (
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Modeling decisions
            </span>
          )}
          {plan.decisions.map((d, i) => (
            <Card key={d.id}>
              <CardHeader className="gap-1.5">
                <CardTitle className="flex items-baseline gap-2 text-sm">
                  <span className="font-mono text-xs text-muted-foreground">{i + 1}</span>
                  {d.question}
                </CardTitle>
                <CardDescription>{d.explanation}</CardDescription>
              </CardHeader>
              <CardContent className="flex flex-col gap-2">
                {d.options.map((o) => {
                  const selected = choices[d.id] === o.label;
                  return (
                    <button
                      key={o.label}
                      onClick={() => setChoices((prev) => ({ ...prev, [d.id]: o.label }))}
                      className={cn(
                        "flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                        selected ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                          selected ? "border-foreground" : "border-border",
                        )}
                      >
                        {selected && <span className="size-2 rounded-full bg-foreground" />}
                      </span>
                      <span className="flex flex-1 flex-col gap-0.5">
                        <span className="flex items-center gap-2">
                          <span className="text-sm font-medium text-foreground">{o.label}</span>
                          {o.recommended && <Badge variant="success">recommended</Badge>}
                        </span>
                        <span className="text-xs text-muted-foreground">{o.description}</span>
                      </span>
                    </button>
                  );
                })}
              </CardContent>
            </Card>
          ))}
          <div className="flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => setStep("plan")}>
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
            <Button onClick={() => setStep("definitions")}>
              Continue
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 2.5 — open custom definitions (the unbounded business meaning) */}
      {step === "definitions" && (
        <div className="flex flex-col gap-4">
          <div className="flex flex-col gap-1">
            <p className="text-sm text-muted-foreground">
              Add business terms in your own words. Each is baked into the model — so a question that
              uses the term (or any alias you list) applies it automatically. Aliases are explicit:
              nothing is guessed. Optional; add as many as you like, or none.
            </p>
          </div>

          <div className="flex flex-col gap-2">
            {definitions.map((d, i) => (
              <div
                key={i}
                className="flex items-start gap-2 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm"
              >
                <Sparkles className="mt-0.5 size-3.5 shrink-0 text-tertiary" strokeWidth={1.75} />
                <span className="flex flex-1 flex-col gap-1">
                  <span>{d.text}</span>
                  {parseAliases(d.aliases).length > 0 && (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <span className="text-xs text-muted-foreground">aka</span>
                      {parseAliases(d.aliases).map((a) => (
                        <Badge key={a} variant="outline">
                          {a}
                        </Badge>
                      ))}
                    </span>
                  )}
                </span>
                <button
                  onClick={() => setDefinitions((prev) => prev.filter((_, j) => j !== i))}
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
          </div>

          <div className="flex flex-col gap-2 rounded-md border border-border p-2.5">
            <Input
              value={defInput}
              onChange={(e) => setDefInput(e.target.value)}
              placeholder="customers = exclude internal accounts and test workspaces"
            />
            <div className="flex items-center gap-2">
              <Input
                value={defAliasInput}
                onChange={(e) => setDefAliasInput(e.target.value)}
                placeholder="also called (optional, comma-separated): users, accounts"
                className="font-mono"
              />
              <Button
                variant="outline"
                size="sm"
                onClick={() => {
                  if (defInput.trim()) {
                    setDefinitions((prev) => [...prev, { text: defInput.trim(), aliases: defAliasInput.trim() }]);
                    setDefInput("");
                    setDefAliasInput("");
                  }
                }}
                disabled={!defInput.trim()}
              >
                <Plus className="size-3.5" />
                Add
              </Button>
            </div>
          </div>

          {/* Final preview before commit — what's about to be built. */}
          {joinPlan && (() => {
            const keptJoins = joinPlan.joins.filter((j) => !droppedJoins.has(j.table));
            const excluded = [
              ...joinPlan.unjoinable.map((u) => u.table),
              ...joinPlan.joins.filter((j) => droppedJoins.has(j.table)).map((j) => j.table),
            ];
            return (
              <div className="flex flex-col gap-1.5 rounded-md border border-border bg-muted/40 px-3.5 py-3 text-sm">
                <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">About to build</span>
                <span className="text-foreground">
                  Fact <span className="font-mono">{joinPlan.fact}</span> ·{" "}
                  <span className="font-medium">{keptJoins.length} join{keptJoins.length === 1 ? "" : "s"}</span> ·{" "}
                  {definitions.length} definition{definitions.length === 1 ? "" : "s"}
                </span>
                {excluded.length > 0 && (
                  <span className="text-xs text-muted-foreground">
                    Excluded (won't be joined): <span className="font-mono">{excluded.join(", ")}</span>
                  </span>
                )}
                <span className="text-[11px] text-tertiary">
                  The compiled model will have exactly these {keptJoins.length} joins — it's checked after build.
                </span>
              </div>
            );
          })()}

          <div className="flex items-center justify-between">
            <Button variant="ghost" size="sm" onClick={() => setStep("decisions")}>
              <ArrowLeft className="size-3.5" />
              Back
            </Button>
            <Button onClick={() => runBuild()}>
              Confirm &amp; build{definitions.length > 0 ? ` (+${definitions.length} definitions)` : ""}
            </Button>
          </div>
        </div>
      )}

      {/* Step 3 — building */}
      {step === "building" && (
        <Card>
          <CardContent className="flex items-center gap-3 py-5">
            <Loader2 className="size-4 animate-spin text-foreground" />
            <div className="flex flex-col">
              <span className="text-sm font-medium">Building “{name}”…</span>
              <span className="text-xs text-muted-foreground">
                Generating the model, compiling each measure, and checking it against your decisions.
                This can take a minute.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Step 3 — result */}
      {step === "result" && (
        <ResultView
          error={error}
          outcome={outcome}
          bakedConcepts={bakedConcepts}
          clarifyChoices={clarifyChoices}
          setClarifyChoices={setClarifyChoices}
          clarifyRound={clarifyRound}
          onSubmitClarifications={submitClarifications}
          onView={() => outcome && onBuilt(outcome.modelName)}
          onRetry={() => setStep("decisions")}
        />
      )}
    </div>
  );
}

function ResultView({
  error,
  outcome,
  bakedConcepts,
  clarifyChoices,
  setClarifyChoices,
  clarifyRound,
  onSubmitClarifications,
  onView,
  onRetry,
}: {
  error: string | null;
  outcome: BuildOutcome | null;
  bakedConcepts: DefinitionOutcome[];
  clarifyChoices: Record<string, string>;
  setClarifyChoices: Dispatch<SetStateAction<Record<string, string>>>;
  clarifyRound: number;
  onSubmitClarifications: () => void;
  onView: () => void;
  onRetry: () => void;
}) {
  if (error && !outcome) {
    return (
      <div className="flex flex-col gap-3">
        <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          <span className="font-medium text-foreground">Build failed.</span> {error}
        </div>
        <Button variant="outline" size="sm" className="self-start" onClick={onRetry}>
          <ArrowLeft className="size-3.5" />
          Back to decisions
        </Button>
      </div>
    );
  }
  if (!outcome) return null;

  // Clarification needed — render as more decision cards (capped at 2 rounds).
  if (outcome.clarificationsNeeded.length > 0 && clarifyRound < 2) {
    const allAnswered = outcome.clarificationsNeeded.every((q) => clarifyChoices[q.id]);
    return (
      <div className="flex flex-col gap-4">
        <VerificationCallout kind="caveat" title="A couple of decisions only you can make">
          The build fixed what it could on its own. These need your call.
        </VerificationCallout>
        {outcome.clarificationsNeeded.map((q) => (
          <Card key={q.id}>
            <CardHeader className="gap-1.5">
              <CardTitle className="text-sm">{q.question}</CardTitle>
              <CardDescription>{q.grounded_in}</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-2">
              {q.options.map((opt) => {
                const selected = clarifyChoices[q.id] === opt;
                return (
                  <button
                    key={opt}
                    onClick={() => setClarifyChoices((prev) => ({ ...prev, [q.id]: opt }))}
                    className={cn(
                      "flex items-start gap-3 rounded-md border px-3 py-2.5 text-left text-sm transition-colors",
                      selected ? "border-foreground/40 bg-muted" : "border-border hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-foreground" : "border-border",
                      )}
                    >
                      {selected && <span className="size-2 rounded-full bg-foreground" />}
                    </span>
                    {opt}
                  </button>
                );
              })}
            </CardContent>
          </Card>
        ))}
        <div className="flex justify-end">
          <Button onClick={onSubmitClarifications} disabled={!allAnswered}>
            Rebuild with these answers
          </Button>
        </div>
      </div>
    );
  }

  const clean = outcome.success && !outcome.incomplete;

  return (
    <div className="flex flex-col gap-4">
      {clean ? (
        <VerificationCallout kind="verified" title={`Model “${outcome.modelName}” built`}>
          {outcome.measuresCount} measures · {outcome.dimensionsCount} dimensions · {outcome.viewsCount} views.
        </VerificationCallout>
      ) : (
        <VerificationCallout kind="caveat" title={`Built “${outcome.modelName}”, with caveats`}>
          {outcome.measuresCount} measures · {outcome.dimensionsCount} dimensions. The model was saved
          but is incomplete — review below before relying on it.
        </VerificationCallout>
      )}

      {/* Join-plan match check — proves the build matched what you confirmed. */}
      {outcome.plannedJoins != null && (
        outcome.joinPlanMatches ? (
          <VerificationCallout kind="verified" title="Matches your confirmed plan">
            You confirmed {outcome.plannedJoins} join{outcome.plannedJoins === 1 ? "" : "s"}; the compiled
            model.malloy has exactly {outcome.actualJoins}.
          </VerificationCallout>
        ) : (
          <VerificationCallout kind="caveat" title="Diverged from your confirmed plan">
            You confirmed {outcome.plannedJoins} join{outcome.plannedJoins === 1 ? "" : "s"}, but the compiled
            model has {outcome.actualJoins}. Review the model.malloy below — some joins may have been dropped
            (e.g. a compile error) or added. Adjust the plan and rebuild.
          </VerificationCallout>
        )
      )}

      {bakedConcepts.some((c) => c.applied) && (
        <Card>
          <CardHeader className="border-b border-border py-2.5">
            <CardTitle className="text-muted-foreground">Definitions baked in</CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-0 p-0">
            {bakedConcepts
              .filter((c) => c.applied && c.concept)
              .map((c) => (
                <div key={c.concept!.canonical_name} className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-0">
                  <span className="font-mono text-sm text-foreground">{c.concept!.canonical_name}</span>
                  <span className="flex flex-wrap items-center gap-1.5">
                    <span className="font-mono text-xs text-muted-foreground">{c.concept!.field}</span>
                    {c.concept!.aliases.map((a) => (
                      <Badge key={a} variant="outline">
                        {a}
                      </Badge>
                    ))}
                  </span>
                </div>
              ))}
          </CardContent>
        </Card>
      )}

      {outcome.failedItems.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border py-2.5">
            <CardTitle className="text-muted-foreground">
              Measures that don’t compile ({outcome.failedItems.length})
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-0 p-0">
            {outcome.failedItems.map((f) => (
              <div key={f.name} className="flex flex-col gap-0.5 border-b border-border px-4 py-2.5 last:border-0">
                <span className="font-mono text-sm text-foreground">
                  {f.kind} {f.name}
                </span>
                <span className="font-mono text-xs text-warn">{f.error}</span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {outcome.dataWarnings.length > 0 && (
        <VerificationCallout kind="caveat" title="Measures that returned no data">
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {outcome.dataWarnings.map((w) => (
              <li key={w.measure}>
                <span className="font-mono">{w.measure}</span>: {w.detail}
              </li>
            ))}
          </ul>
        </VerificationCallout>
      )}

      {outcome.unmetDecisions.length > 0 && (
        <VerificationCallout kind="caveat" title="Decisions not yet reflected">
          <ul className="flex list-disc flex-col gap-1 pl-4">
            {outcome.unmetDecisions.map((u) => (
              <li key={u.decision_id}>
                <span className="font-mono">{u.decision_id}</span> ({u.chosen}): {u.expectation}
              </li>
            ))}
          </ul>
        </VerificationCallout>
      )}

      {outcome.modelMalloy && <MalloyBlock code={outcome.modelMalloy} label="model.malloy" />}

      {/* Built — offer to wire it into Claude Desktop right away. */}
      {outcome.success && <McpConnect defaultOpen />}

      <div className="flex justify-end gap-2">
        {!clean && (
          <Button variant="outline" size="sm" onClick={onRetry}>
            Adjust decisions
          </Button>
        )}
        <Button size="sm" onClick={onView}>
          View model
          <ArrowUpRight className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

// ── Small helpers ────────────────────────────────────────────────

// ── Join plan — visible, overridable proposal of how tables connect ──
function JoinPlanPanel({
  plan,
  dropped,
  onToggleJoin,
  fact,
  factOptions,
  onChangeFact,
  busy,
}: {
  plan: JoinPlan;
  dropped: Set<string>;
  onToggleJoin: (table: string) => void;
  fact: string;
  factOptions: string[];
  onChangeFact: (fact: string) => void;
  busy: boolean;
}) {
  const kept = plan.joins.filter((j) => !dropped.has(j.table));
  return (
    <Card>
      <CardHeader className="gap-1 border-b border-border py-2.5">
        <CardTitle className="flex items-center gap-2">
          Join plan
          <Badge variant="outline">
            {kept.length} join{kept.length === 1 ? "" : "s"}
          </Badge>
        </CardTitle>
        <CardDescription>
          How the selected tables connect — computed from foreign keys. Review and adjust; the compiled
          model is checked against this.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-3">
        <div className="flex items-center gap-2 text-sm">
          <span className="text-muted-foreground">Fact (primary table):</span>
          <select
            value={fact}
            disabled={busy}
            onChange={(e) => onChangeFact(e.target.value)}
            className="h-7 rounded-md border border-input bg-card px-2 font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            {factOptions.map((t) => (
              <option key={t} value={t}>
                {t}
              </option>
            ))}
          </select>
        </div>

        {plan.noForeignKeys && (
          <p className="rounded-md border border-warn/30 bg-warn/[0.06] px-3 py-2 text-xs text-foreground">
            This warehouse exposes no foreign-key catalog, so joins can't be inferred deterministically. The
            builder will match on column names — review the result carefully.
          </p>
        )}

        {plan.joins.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            {plan.joins.map((j) => {
              const off = dropped.has(j.table);
              return (
                <div
                  key={j.table}
                  className={cn(
                    "flex items-start gap-2 rounded-md border px-3 py-2",
                    off ? "border-border bg-muted/30 opacity-60" : "border-border",
                  )}
                >
                  <button
                    onClick={() => onToggleJoin(j.table)}
                    title={off ? "Include this join" : "Exclude this join"}
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      off ? "border-border" : "border-foreground bg-foreground text-background",
                    )}
                  >
                    {!off && <Check className="size-3" strokeWidth={2.5} />}
                  </button>
                  <div className="flex min-w-0 flex-col gap-0.5">
                    <span className="flex flex-wrap items-center gap-1.5">
                      <Badge variant={j.cardinality === "many" ? "warn" : "outline"}>join_{j.cardinality}</Badge>
                      <span className="font-mono text-sm text-foreground">{j.table}</span>
                      <span className="text-xs text-muted-foreground">
                        onto <span className="font-mono text-foreground">{j.onto}</span> on{" "}
                        <span className="font-mono">
                          {j.onto}.{j.ontoKey} = {j.table}.{j.tableKey}
                        </span>
                      </span>
                    </span>
                    <span className="text-[11px] text-tertiary">{j.inferredFrom}</span>
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="text-xs text-muted-foreground">No joins — the fact stands alone.</p>
        )}

        {plan.unjoinable.length > 0 && (
          <div className="flex flex-col gap-1.5 rounded-md border border-warn/30 bg-warn/[0.06] px-3 py-2.5">
            <span className="flex items-center gap-1.5 text-xs font-medium text-foreground">
              <TriangleAlert className="size-3.5 text-warn" strokeWidth={2} /> Can't join ({plan.unjoinable.length})
            </span>
            {plan.unjoinable.map((u) => (
              <span key={u.table} className="text-xs text-muted-foreground">
                <span className="font-mono text-foreground">{u.table}</span> — {u.reason}
              </span>
            ))}
            <span className="text-[11px] text-tertiary">
              Surfaced, not silently turned into orphaned sources. Remove them on the Tables step, or add a join
              key in your schema.
            </span>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function WizardHeader({ step }: { step: Step }) {
  const labels: { id: Step; label: string }[] = [
    { id: "datasource", label: "Datasource" },
    { id: "form", label: "Purpose" },
    { id: "plan", label: "Tables" },
    { id: "decisions", label: "Decisions" },
    { id: "definitions", label: "Definitions" },
    { id: "result", label: "Build" },
  ];
  const order: Step[] = ["datasource", "form", "plan", "decisions", "definitions", "building", "result"];
  const current = order.indexOf(step);
  return (
    <div className="flex items-center gap-2">
      {labels.map((l, i) => {
        const idx = order.indexOf(l.id);
        const active = step === l.id || (l.id === "result" && step === "building");
        const done = idx < current && !active;
        return (
          <div key={l.id} className="flex items-center gap-2">
            <span
              className={cn(
                "flex items-center gap-1.5 text-sm",
                active ? "font-medium text-foreground" : done ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <span
                className={cn(
                  "flex size-5 items-center justify-center rounded-full border text-xs",
                  active ? "border-foreground text-foreground" : done ? "border-foreground bg-foreground text-background" : "border-border text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3" strokeWidth={2.5} /> : i + 1}
              </span>
              {l.label}
            </span>
            {i < labels.length - 1 && <span className="h-px w-5 bg-border" />}
          </div>
        );
      })}
    </div>
  );
}

function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-sm font-medium">{label}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
      {children}
    </label>
  );
}

function Loading({ label }: { label: string }) {
  return (
    <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
      <Loader2 className="size-4 animate-spin" />
      {label}
    </div>
  );
}
