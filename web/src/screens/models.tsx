import { useEffect, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  ArrowLeft,
  ArrowUpRight,
  Boxes,
  Check,
  ChevronRight,
  Loader2,
  Plus,
  Sparkles,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { MalloyBlock } from "@/components/malloy-block";
import { VerificationCallout } from "@/components/verification-callout";
import {
  designBuild,
  designPlan,
  fetchHealth,
  fetchModelDetail,
  fetchModels,
  type BuildOutcome,
  type DesignPlan,
  type ModelDetail,
  type ModelInfo,
} from "@/lib/api";

type Mode = { kind: "view" } | { kind: "detail"; name: string } | { kind: "design" };

export function ModelsScreen() {
  const [mode, setMode] = useState<Mode>({ kind: "view" });
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => {
    setLoading(true);
    fetchModels()
      .then(setModels)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setLoading(false));
  };

  useEffect(refresh, []);

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
    return <ModelDetailView name={mode.name} onBack={() => setMode({ kind: "view" })} />;
  }

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6 px-8 py-8">
      <div className="flex items-center justify-between">
        <div className="flex flex-col gap-1">
          <h1 className="text-base font-medium tracking-tight">Models</h1>
          <p className="text-sm text-muted-foreground">
            Purpose-built semantic models scoped over your warehouse.
          </p>
        </div>
        <Button size="sm" onClick={() => setMode({ kind: "design" })}>
          <Plus className="size-3.5" />
          Design new model
        </Button>
      </div>

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
                  {m.connector && <Badge variant="outline">{m.connector}</Badge>}
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
    </div>
  );
}

// ── Detail view ──────────────────────────────────────────────────

function ModelDetailView({ name, onBack }: { name: string; onBack: () => void }) {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setDetail(null);
    setError(null);
    fetchModelDetail(name)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [name]);

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Models
      </button>

      {!detail && !error && <Loading label="Loading model…" />}
      {error && (
        <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          {error}
        </div>
      )}

      {detail && (
        <>
          <div className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <h1 className="font-mono text-base font-medium tracking-tight">{detail.name}</h1>
              {detail.connector && <Badge variant="outline">{detail.connector}</Badge>}
            </div>
            <p className="text-sm text-muted-foreground">{detail.purpose}</p>
          </div>

          <FieldList title="Measures" items={detail.measures} />
          <FieldList title="Dimensions" items={detail.dimensions} />

          {detail.views.length > 0 && (
            <Card>
              <CardHeader className="border-b border-border py-2.5">
                <CardTitle className="text-muted-foreground">Views</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-wrap gap-2 pt-3">
                {detail.views.map((v) => (
                  <Badge key={v} variant="default" className="font-mono">
                    {v}
                  </Badge>
                ))}
              </CardContent>
            </Card>
          )}

          {detail.decisions.length > 0 && (
            <Card>
              <CardHeader className="border-b border-border py-2.5">
                <CardTitle className="text-muted-foreground">Decisions that built this</CardTitle>
              </CardHeader>
              <CardContent className="flex flex-col gap-0 p-0">
                {detail.decisions.map((d) => (
                  <div
                    key={d.decision_id}
                    className="flex items-center justify-between border-b border-border px-4 py-2 text-sm last:border-0"
                  >
                    <span className="font-mono text-xs text-muted-foreground">{d.decision_id}</span>
                    <span className="text-foreground">{d.chosen}</span>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}

          <MalloyBlock code={detail.malloy} label="model.malloy" />
        </>
      )}
    </div>
  );
}

function FieldList({ title, items }: { title: string; items: { name: string; expr: string }[] }) {
  if (items.length === 0) return null;
  return (
    <Card>
      <CardHeader className="border-b border-border py-2.5">
        <CardTitle className="text-muted-foreground">
          {title} <span className="text-muted-foreground/60">({items.length})</span>
        </CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-0 p-0">
        {items.map((it) => (
          <div key={it.name} className="flex flex-col gap-0.5 border-b border-border px-4 py-2.5 last:border-0">
            <span className="font-mono text-sm text-foreground">{it.name}</span>
            <span className="font-mono text-xs text-muted-foreground">{it.expr}</span>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

// ── Design wizard ────────────────────────────────────────────────

type Step = "form" | "plan" | "decisions" | "building" | "result";

function DesignWizard({
  onCancel,
  onBuilt,
}: {
  onCancel: () => void;
  onBuilt: (name: string) => void;
}) {
  const [step, setStep] = useState<Step>("form");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Step 0
  const [name, setName] = useState("");
  const [purpose, setPurpose] = useState("");
  const [tablesInput, setTablesInput] = useState("");
  const [substrateDir, setSubstrateDir] = useState("");

  // Prefill the substrate directory from the server's configured default.
  useEffect(() => {
    fetchHealth()
      .then((h) => setSubstrateDir((cur) => cur || h.substrateDir))
      .catch(() => {});
  }, []);

  // Step 1–2
  const [plan, setPlan] = useState<DesignPlan | null>(null);
  const [selectedTables, setSelectedTables] = useState<Set<string>>(new Set());
  const [choices, setChoices] = useState<Record<string, string>>({});

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
        setSelectedTables(new Set(p.relevantTables.map((t) => t.name)));
        const initial: Record<string, string> = {};
        for (const d of p.decisions) {
          const rec = d.options.find((o) => o.recommended) ?? d.options[0];
          if (rec) initial[d.id] = rec.label;
        }
        setChoices(initial);
        setStep("plan");
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const runBuild = (extraClarification?: { question: string; answer: string }[]) => {
    if (!plan) return;
    setStep("building");
    setError(null);
    const allClarifications = [...clarifications, ...(extraClarification ?? [])];
    const resolved = plan.decisions
      .filter((d) => choices[d.id])
      .map((d) => ({ decision_id: d.id, chosen: choices[d.id] }));
    const relevant = plan.relevantTables.filter((t) => selectedTables.has(t.name));

    designBuild({
      name: name.trim(),
      purpose: purpose.trim(),
      resolved_decisions: resolved,
      relevant_tables: relevant,
      substrate_dir: substrateDir.trim() || undefined,
      clarifications: allClarifications.length ? allClarifications : undefined,
    })
      .then((res) => {
        setOutcome(res);
        setClarifications(allClarifications);
        setStep("result");
      })
      .catch((e) => {
        setError(e instanceof Error ? e.message : String(e));
        setStep("result");
      });
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

      {/* Step 0 — form */}
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
          <Field
            label="Substrate directory"
            hint="Where your introspected substrate lives (defaults to the server's configured WEFT_SUBSTRATE_DIR)."
          >
            <Input
              value={substrateDir}
              onChange={(e) => setSubstrateDir(e.target.value)}
              placeholder="./substrate"
              className="font-mono"
            />
          </Field>
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
      {step === "plan" && plan && (
        <div className="flex flex-col gap-4">
          <p className="text-sm text-muted-foreground">{plan.tableSelectionReasoning}</p>
          <div className="flex flex-col gap-2">
            <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Relevant tables · {plan.excludedCount} others excluded
            </span>
            {plan.relevantTables.map((t) => {
              const on = selectedTables.has(t.name);
              return (
                <button
                  key={t.name}
                  onClick={() =>
                    setSelectedTables((prev) => {
                      const next = new Set(prev);
                      next.has(t.name) ? next.delete(t.name) : next.add(t.name);
                      return next;
                    })
                  }
                  className={cn(
                    "flex items-start gap-3 rounded-md border px-3 py-2.5 text-left transition-colors",
                    on ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                  )}
                >
                  <span
                    className={cn(
                      "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-[4px] border",
                      on ? "border-primary bg-primary text-primary-foreground" : "border-border",
                    )}
                  >
                    {on && <Check className="size-3" strokeWidth={2.5} />}
                  </span>
                  <span className="flex flex-col gap-0.5">
                    <span className="font-mono text-sm text-foreground">{t.name}</span>
                    <span className="text-xs text-muted-foreground">{t.reason}</span>
                  </span>
                </button>
              );
            })}
          </div>
          <div className="flex justify-end">
            <Button onClick={() => setStep("decisions")} disabled={selectedTables.size === 0}>
              Continue to decisions
              <ChevronRight className="size-3.5" />
            </Button>
          </div>
        </div>
      )}

      {/* Step 2 — decisions (the centerpiece) */}
      {step === "decisions" && plan && (
        <div className="flex flex-col gap-4">
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
                        selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                      )}
                    >
                      <span
                        className={cn(
                          "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                          selected ? "border-primary" : "border-border",
                        )}
                      >
                        {selected && <span className="size-2 rounded-full bg-primary" />}
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
            <Button onClick={() => runBuild()}>Build model</Button>
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
  clarifyChoices,
  setClarifyChoices,
  clarifyRound,
  onSubmitClarifications,
  onView,
  onRetry,
}: {
  error: string | null;
  outcome: BuildOutcome | null;
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
                      selected ? "border-primary bg-primary/5" : "border-border hover:bg-muted",
                    )}
                  >
                    <span
                      className={cn(
                        "mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full border",
                        selected ? "border-primary" : "border-border",
                      )}
                    >
                      {selected && <span className="size-2 rounded-full bg-primary" />}
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

function WizardHeader({ step }: { step: Step }) {
  const labels: { id: Step; label: string }[] = [
    { id: "form", label: "Purpose" },
    { id: "plan", label: "Tables" },
    { id: "decisions", label: "Decisions" },
    { id: "result", label: "Build" },
  ];
  const order: Step[] = ["form", "plan", "decisions", "building", "result"];
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
                  active ? "border-primary text-primary" : done ? "border-primary bg-primary text-primary-foreground" : "border-border text-muted-foreground",
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
