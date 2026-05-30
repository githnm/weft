import { useEffect, useState } from "react";
import { ChevronDown, CornerDownLeft, Database, Wrench, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { ProgressStages, type Stage } from "@/components/progress-stages";
import { VerificationCallout } from "@/components/verification-callout";
import { MalloyBlock } from "@/components/malloy-block";
import { ResultsTable } from "@/components/results-table";
import {
  askStream,
  correct,
  fetchModels,
  type AskResult,
  type CorrectResult,
  type ModelInfo,
  type StageEvent,
} from "@/lib/api";

const STAGE_LABELS = [
  "Selecting source",
  "Checking feasibility",
  "Generating Malloy",
  "Executing query",
  "Verifying result",
];

// Each stage event means the engine FINISHED that step; advance to the next.
const NEXT_ACTIVE: Record<StageEvent["stage"], number> = {
  source_selected: 1,
  feasibility: 2,
  generating: 3,
  executing: 4,
  verifying: 4,
};

const EXAMPLES = [
  "which workspaces have the most active users?",
  "how many active users last month?",
  "what is the average revenue per user?",
];

type Status = "idle" | "running" | "done" | "error";

export function AskScreen() {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [model, setModel] = useState<string>("");
  const [question, setQuestion] = useState("");
  const [status, setStatus] = useState<Status>("idle");
  const [stageIndex, setStageIndex] = useState(0);
  const [result, setResult] = useState<AskResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [answered, setAnswered] = useState("");

  useEffect(() => {
    fetchModels()
      .then((ms) => {
        setModels(ms);
        if (ms.length > 0) {
          const preferred =
            ms.find((m) => m.name === "product_usage") ??
            ms.find((m) => m.name === "product-usage") ??
            ms[0];
          setModel(preferred.name);
        }
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const runAsk = () => {
    const q = question.trim();
    if (!q || status === "running") return;
    setAnswered(q);
    setStatus("running");
    setStageIndex(0);
    setResult(null);
    setError(null);

    void askStream(
      { question: q, model_name: model || undefined },
      {
        onStage: (e) => setStageIndex((cur) => Math.max(cur, NEXT_ACTIVE[e.stage] ?? cur)),
        onDone: (r) => {
          setResult(r);
          setStatus("done");
        },
        onError: (msg) => {
          setError(msg);
          setStatus("error");
        },
      },
    );
  };

  const stages: Stage[] = STAGE_LABELS.map((label, i) => ({
    label,
    state: i < stageIndex ? "done" : i === stageIndex ? "active" : "pending",
  }));

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6 px-8 py-8">
      {/* Composer */}
      <div className="flex flex-col gap-3">
        <div className="flex items-center justify-between">
          <h1 className="text-base font-medium tracking-tight">Ask</h1>
          <ModelPicker models={models} value={model} onChange={setModel} />
        </div>

        <div className="flex flex-col gap-2 rounded-lg border border-border bg-card p-2">
          <Textarea
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder="Ask a question in plain English…"
            className="min-h-[64px] resize-none border-0 px-2 py-1.5 focus-visible:ring-0 focus-visible:ring-offset-0"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) runAsk();
            }}
          />
          <div className="flex items-center justify-between px-1">
            <span className="text-xs text-muted-foreground">
              Querying{" "}
              <span className="font-mono text-foreground">{model || "—"}</span>
            </span>
            <Button size="sm" onClick={runAsk} disabled={status === "running" || !question.trim()}>
              Ask
              <CornerDownLeft className="size-3.5" />
            </Button>
          </div>
        </div>

        {status === "idle" && (
          <div className="flex flex-wrap gap-2">
            {EXAMPLES.map((ex) => (
              <button
                key={ex}
                onClick={() => setQuestion(ex)}
                className="rounded-md border border-border bg-muted/40 px-2.5 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              >
                {ex}
              </button>
            ))}
          </div>
        )}
      </div>

      {status !== "idle" && (
        <>
          <Separator />

          {/* Question echo */}
          <div className="flex flex-col gap-1">
            <p className="text-base font-medium tracking-tight">{answered}</p>
            {result?.source.name && (
              <p className="text-sm text-muted-foreground">
                Source <span className="font-mono text-foreground">{result.source.name}</span>
                {result.source.reasoning ? ` · ${result.source.reasoning}` : ""}
              </p>
            )}
          </div>

          {status === "running" && (
            <Card>
              <CardContent className="py-4">
                <ProgressStages stages={stages} />
              </CardContent>
            </Card>
          )}

          {status === "error" && (
            <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
              <span className="font-medium text-foreground">Something went wrong.</span> {error}
            </div>
          )}

          {status === "done" && result && (
            <ResultView result={result} model={model} />
          )}
        </>
      )}
    </div>
  );
}

function ResultView({ result, model }: { result: AskResult; model: string }) {
  // Refusal — a calm, neutral panel. Not an error.
  if (result.refusal) {
    return (
      <VerificationCallout kind="refusal" title="This can't be answered from the model">
        <div className="flex flex-col gap-2">
          {result.refusalReason && <p>{result.refusalReason}</p>}
          {result.missingConcepts && result.missingConcepts.length > 0 && (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="text-xs text-muted-foreground">Missing:</span>
              {result.missingConcepts.map((c) => (
                <Badge key={c} variant="outline">
                  {c}
                </Badge>
              ))}
            </div>
          )}
          {result.dataIssues?.unknownFilterValue && (
            <p className="text-xs">
              “{result.dataIssues.unknownFilterValue.userTerm}” is not a known value of{" "}
              <span className="font-mono">{result.dataIssues.unknownFilterValue.column}</span>.
            </p>
          )}
          <p className="text-xs text-muted-foreground">No query was run.</p>
        </div>
      </VerificationCallout>
    );
  }

  const v = result.verification;
  const intentOk = v?.intentMatch === "yes";

  return (
    <div className="flex flex-col gap-5">
      {result.malloy && <MalloyBlock code={result.malloy} />}

      <Card>
        <CardHeader className="flex-row items-center justify-between border-b border-border py-2.5">
          <CardTitle className="flex items-center gap-2 text-muted-foreground">
            <Database className="size-3.5" strokeWidth={1.75} />
            Result
          </CardTitle>
          <span className="font-mono text-xs text-muted-foreground">
            {result.meta.rowCount.toLocaleString()} rows
            {result.meta.bytesLabel ? ` · ${result.meta.bytesLabel} scanned` : ""} · {result.meta.cost}
          </span>
        </CardHeader>
        <CardContent className="p-0">
          {result.rows.length > 0 ? (
            <ResultsTable columns={result.columns} rows={result.rows} />
          ) : (
            <p className="px-4 py-6 text-center text-sm text-muted-foreground">No rows returned.</p>
          )}
        </CardContent>
      </Card>

      {v && (
        <div className="flex flex-col gap-2.5">
          {intentOk ? (
            <VerificationCallout kind="verified" title="Results match the question">
              {v.reasoning}
              {v.confidence ? ` (confidence: ${v.confidence})` : ""}
            </VerificationCallout>
          ) : (
            <VerificationCallout kind="caveat" title={`Intent match: ${v.intentMatch ?? "unknown"}`}>
              {v.reasoning}
            </VerificationCallout>
          )}
          {v.caveats.length > 0 && (
            <VerificationCallout kind="caveat" title="Worth noting">
              <ul className="flex list-disc flex-col gap-1 pl-4">
                {v.caveats.map((c, i) => (
                  <li key={i}>{c}</li>
                ))}
              </ul>
            </VerificationCallout>
          )}
        </div>
      )}

      <CorrectionBox model={model} />
    </div>
  );
}

function CorrectionBox({ model }: { model: string }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<CorrectResult | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const apply = () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    setErr(null);
    setOutcome(null);
    correct(text.trim(), model)
      .then((r) => setOutcome(r))
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  if (!open) {
    return (
      <button
        onClick={() => setOpen(true)}
        className="flex items-center gap-1.5 self-start text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        <Wrench className="size-3.5" strokeWidth={1.75} />
        Doesn’t look right?
      </button>
    );
  }

  return (
    <div className="flex flex-col gap-2.5 rounded-lg border border-border bg-muted/30 p-3">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">Correct this</span>
        <button
          onClick={() => setOpen(false)}
          className="text-muted-foreground transition-colors hover:text-foreground"
        >
          <X className="size-3.5" />
        </button>
      </div>
      <div className="flex items-center gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="e.g. active users should exclude internal accounts"
          onKeyDown={(e) => e.key === "Enter" && apply()}
        />
        <Button size="sm" variant="outline" onClick={apply} disabled={busy || !text.trim()}>
          {busy ? "Applying…" : "Apply"}
        </Button>
      </div>

      {err && <p className="text-xs text-muted-foreground">Could not apply: {err}</p>}

      {outcome && outcome.type === "term_update" && (
        <VerificationCallout kind="verified" title={`Updated term “${outcome.termName}”`}>
          <div className="flex flex-col gap-1.5 font-mono text-xs">
            <span className="text-muted-foreground">before: {outcome.oldFilter}</span>
            <span className="text-foreground">after:&nbsp; {outcome.newFilter}</span>
          </div>
          {outcome.impact && (
            <p className="mt-1.5 text-xs">
              Impact: {outcome.impact.rowsBefore?.toLocaleString()} →{" "}
              {outcome.impact.rowsAfter?.toLocaleString()} rows
            </p>
          )}
        </VerificationCallout>
      )}
      {outcome && outcome.type === "model_suggestion" && (
        <VerificationCallout kind="caveat" title="Suggested model edit (manual)">
          <div className="flex flex-col gap-1 font-mono text-xs">
            <span className="text-muted-foreground">find:&nbsp;&nbsp;&nbsp;{outcome.findLine}</span>
            <span className="text-foreground">replace: {outcome.replaceLine}</span>
          </div>
        </VerificationCallout>
      )}
      {outcome && (outcome.type === "unclear" || outcome.type === "new_term") && (
        <VerificationCallout kind="refusal" title="No change applied">
          {outcome.reasoning}
        </VerificationCallout>
      )}
    </div>
  );
}

function ModelPicker({
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
