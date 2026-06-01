import { useEffect, useRef, useState } from "react";
import {
  ArrowLeft,
  ArrowRight,
  Check,
  CornerDownLeft,
  Database,
  List,
  Loader2,
  Network,
  Sparkles,
  Table2,
  Trash2,
} from "lucide-react";

import { cn } from "@/lib/utils";
import { StagePill, type TimelineTone } from "@/components/stage-pill";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { MalloyBlock } from "@/components/malloy-block";
import { SemanticDiagram } from "@/components/semantic-diagram";
import { DeleteModelDialog } from "@/components/delete-model-dialog";
import {
  agentTurn,
  agentConfirm,
  fetchModelDetail,
  type AgentEvent,
  type AgentPending,
  type ModelDetail,
} from "@/lib/api";

/** Parse a comma/newline-separated aliases input into a clean list. */
function parseAliases(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

// ── The editor: a split-pane view of one model + a way to change it ──

export function ModelEditor({
  name,
  onBack,
  onDeleted,
}: {
  name: string;
  onBack: () => void;
  onDeleted: (name: string) => void;
}) {
  const [detail, setDetail] = useState<ModelDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);

  const reload = () => {
    fetchModelDetail(name)
      .then(setDetail)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  };

  useEffect(() => {
    setDetail(null);
    setError(null);
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [name]);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6 px-8 py-8">
      <button
        onClick={onBack}
        className="flex items-center gap-1.5 self-start text-sm text-muted-foreground transition-colors hover:text-foreground"
      >
        <ArrowLeft className="size-3.5" />
        Models
      </button>

      {!detail && !error && (
        <div className="flex items-center gap-2 py-8 text-sm text-muted-foreground">
          <Loader2 className="size-4 animate-spin" />
          Loading model…
        </div>
      )}
      {error && (
        <div className="rounded-md border border-border bg-muted/50 px-3.5 py-3 text-sm text-muted-foreground">
          {error}
        </div>
      )}

      {detail && (
        <>
          <header className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <div className="flex items-center gap-2">
                <h1 className="font-mono text-lg font-normal tracking-tight">{detail.name}</h1>
                {detail.connector && <Badge variant="outline">{detail.connector}</Badge>}
                {detail.datasource && (
                  <Badge variant="outline" className="gap-1">
                    <Database className="size-3" strokeWidth={1.75} />
                    {detail.datasource}
                  </Badge>
                )}
              </div>
              <p className="max-w-prose text-sm text-muted-foreground">{detail.purpose}</p>
            </div>
            <button
              onClick={() => setConfirmDelete(true)}
              className="flex shrink-0 items-center gap-1.5 text-sm text-destructive/80 transition-colors hover:text-destructive"
            >
              <Trash2 className="size-3.5" />
              Delete
            </button>
          </header>

          {/* Split pane: left ≈58% (the model), right ≈42% (change it), min 380px.
              minmax(0,…) stops the wide code block from blowing out the left track. */}
          <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1.4fr)_minmax(380px,1fr)]">
            <ModelStatePane detail={detail} />
            <ChatPane model={detail.name} onApplied={reload} />
          </div>

          <DeleteModelDialog
            name={confirmDelete ? detail.name : null}
            open={confirmDelete}
            onOpenChange={setConfirmDelete}
            onDeleted={(n) => {
              setConfirmDelete(false);
              onDeleted(n);
            }}
          />
        </>
      )}
    </div>
  );
}

// ── LEFT: the model as it currently exists (reads like documentation) ──

function ModelStatePane({ detail }: { detail: ModelDetail }) {
  // Concept fields are surfaced in their own section — keep them out of the
  // plain measures/dimensions lists so nothing is shown twice.
  const conceptFields = new Set(detail.concepts.map((c) => c.field));
  const plainMeasures = detail.measures.filter((m) => !conceptFields.has(m.name));
  const plainDimensions = detail.dimensions.filter((d) => !conceptFields.has(d.name));
  const [view, setView] = useState<"diagram" | "details">("diagram");

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <div className="flex items-center justify-between gap-3">
        <SectionLabel>The model</SectionLabel>
        <div className="inline-flex rounded-md border border-border p-0.5">
          <ViewToggle active={view === "diagram"} onClick={() => setView("diagram")} icon={<Network className="size-3.5" strokeWidth={1.75} />} label="Diagram" />
          <ViewToggle active={view === "details"} onClick={() => setView("details")} icon={<List className="size-3.5" strokeWidth={1.75} />} label="Details" />
        </div>
      </div>

      {view === "diagram" ? (
        <>
          <SemanticDiagram detail={detail} />
          <MalloyBlock code={detail.malloy} label="model.malloy" />
        </>
      ) : (
        <DetailsView detail={detail} plainMeasures={plainMeasures} plainDimensions={plainDimensions} />
      )}
    </div>
  );
}

function ViewToggle({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "flex items-center gap-1.5 rounded px-2.5 py-1 text-xs transition-colors",
        active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
      )}
    >
      {icon}
      {label}
    </button>
  );
}

function DetailsView({
  detail,
  plainMeasures,
  plainDimensions,
}: {
  detail: ModelDetail;
  plainMeasures: { name: string; expr: string }[];
  plainDimensions: { name: string; expr: string }[];
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      {/* Sources + their fields */}
      <Card>
        <CardHeader className="border-b border-border py-2.5">
          <CardTitle className="flex items-center gap-2 text-muted-foreground">
            <Database className="size-3.5" strokeWidth={1.75} />
            Sources in scope
          </CardTitle>
        </CardHeader>
        <CardContent className="flex flex-col gap-0 p-0">
          {detail.sources.length === 0 && (
            <p className="px-4 py-3 text-sm text-muted-foreground">
              No source fields available (substrate not readable).
            </p>
          )}
          {detail.sources.map((s) => (
            <div key={s.name} className="flex flex-col gap-1.5 border-b border-border px-4 py-3 last:border-0">
              <div className="flex items-center gap-2">
                <Table2 className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
                <span className="font-mono text-sm text-foreground">{s.name}</span>
                <span className="text-xs text-muted-foreground">{s.rowCount.toLocaleString()} rows</span>
              </div>
              <div className="flex flex-wrap gap-1">
                {s.columns.map((c) => (
                  <span
                    key={c.name}
                    title={`${c.type}${c.jsonKeys ? ` · ${c.jsonKeys} JSON keys` : ""}`}
                    className="rounded border border-border bg-muted/40 px-1.5 py-0.5 font-mono text-[11px] text-muted-foreground"
                  >
                    {c.name}
                    {c.jsonKeys > 0 && <span className="text-tertiary"> {`{}`}</span>}
                  </span>
                ))}
              </div>
            </div>
          ))}
        </CardContent>
      </Card>

      {/* Defined concepts — the meaningful, aliased vocabulary */}
      {detail.concepts.length > 0 && (
        <Card>
          <CardHeader className="border-b border-border py-2.5">
            <CardTitle className="flex items-center gap-2 text-muted-foreground">
              <Sparkles className="size-3.5 text-tertiary" strokeWidth={1.75} />
              Defined concepts <span className="text-muted-foreground/60">({detail.concepts.length})</span>
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-0 p-0">
            {detail.concepts.map((c) => (
              <div key={c.canonical_name} className="flex flex-col gap-1 border-b border-border px-4 py-2.5 last:border-0">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium text-foreground">{c.canonical_name}</span>
                  <Badge variant="outline">{c.kind}</Badge>
                  {c.aliases.length > 0 && (
                    <>
                      <span className="text-xs text-muted-foreground">also called</span>
                      {c.aliases.map((a) => (
                        <Badge key={a} variant="outline">
                          {a}
                        </Badge>
                      ))}
                    </>
                  )}
                </div>
                <span className="font-mono text-xs text-muted-foreground">
                  {c.field}
                  {c.filter ? ` is ${c.filter}` : ""}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      <FieldList title="Measures" items={plainMeasures} />
      <FieldList title="Dimensions" items={plainDimensions} />

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

      <MalloyBlock code={detail.malloy} label="model.malloy" />
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


// ── RIGHT: a conversational agent that changes the model ──
//
// The agent converses, calls READ tools freely, and PROPOSES writes the user
// must confirm. Conversation state (`messages`) is opaque and echoed back each
// turn. A proposal renders inline as a Confirm/Reject card; nothing is written
// until Confirm.

const HINTS = [
  "define customers as accounts with a paid invoice",
  "active users should exclude internal accounts",
  "what would happen if active required 2 events?",
];

type Row =
  | { kind: "user"; text: string }
  | { kind: "agent"; text: string }
  | { kind: "tool"; tool: string; detail: string }
  | { kind: "proposal"; pending: AgentPending; status: "open" | "confirmed" | "rejected" };

// Agent tool calls → AI-timeline pastels (Cursor signature, scoped to actions).
const TOOL_TONE: Record<string, TimelineTone> = {
  inspect_model: "read", // reading the model
  run_query: "grep", // grepping the data
  simulate_whatif: "thinking", // reasoning about a what-if
};
const TOOL_LABEL: Record<string, string> = {
  inspect_model: "Reading",
  run_query: "Querying",
  simulate_whatif: "Simulating",
};

function eventsToRows(events: AgentEvent[]): Row[] {
  const rows: Row[] = [];
  for (const e of events) {
    if (e.kind === "text" && e.text) rows.push({ kind: "agent", text: e.text });
    else if (e.kind === "tool" && e.tool && e.tool !== "propose_model_change" && e.detail)
      rows.push({ kind: "tool", tool: e.tool, detail: e.detail });
  }
  return rows;
}

function ChatPane({ model, onApplied }: { model: string; onApplied: () => void }) {
  const [messages, setMessages] = useState<unknown[]>([]);
  const [rows, setRows] = useState<Row[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scroller = useRef<HTMLDivElement>(null);

  useEffect(() => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: "smooth" });
  }, [rows, busy]);

  const send = (textOverride?: string) => {
    const text = (textOverride ?? input).trim();
    if (!text || busy) return;
    setBusy(true);
    setError(null);
    setRows((r) => [...r, { kind: "user", text }]);
    setInput("");
    agentTurn(model, messages, text)
      .then((res) => {
        setMessages(res.messages);
        const newRows = eventsToRows(res.events);
        if (res.pending) newRows.push({ kind: "proposal", pending: res.pending, status: "open" });
        setRows((r) => [...r, ...newRows]);
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  const decide = (
    rowIndex: number,
    pending: AgentPending,
    decision: "confirm" | "reject",
    aliases?: string[],
    canonical?: string,
  ) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    const applyPayload: AgentPending | undefined =
      decision === "confirm"
        ? { ...pending, aliases: aliases ?? pending.aliases, canonicalName: canonical ?? pending.canonicalName }
        : undefined;
    agentConfirm(model, messages, pending.toolUseId, decision, applyPayload)
      .then((res) => {
        setMessages(res.messages);
        setRows((r) => {
          const next = [...r];
          const pr = next[rowIndex];
          if (pr && pr.kind === "proposal")
            next[rowIndex] = { ...pr, status: decision === "confirm" ? "confirmed" : "rejected" };
          return [...next, ...eventsToRows(res.events)];
        });
        if (res.applied) onApplied(); // left pane reflects the confirmed change
      })
      .catch((e) => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false));
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <SectionLabel>Build with the assistant</SectionLabel>

      <Card className="flex min-h-[420px] flex-col">
        <div ref={scroller} className="flex flex-1 flex-col gap-3 overflow-y-auto p-4" style={{ maxHeight: "60vh" }}>
          {rows.length === 0 && (
            <div className="flex flex-col gap-3 py-6 text-sm text-muted-foreground">
              <p>
                Tell me how to evolve the model. I’ll check the schema, ask if I need a detail, and
                propose the exact change for you to confirm — I never edit without your OK.
              </p>
              <div className="flex flex-col gap-1.5">
                <span className="text-xs text-tertiary">Try:</span>
                {HINTS.map((h) => (
                  <button
                    key={h}
                    onClick={() => send(h)}
                    className="self-start rounded-md border border-border px-2.5 py-1 text-left text-xs text-muted-foreground transition-colors hover:border-foreground/20 hover:text-foreground"
                  >
                    {h}
                  </button>
                ))}
              </div>
            </div>
          )}

          {rows.map((row, i) => (
            <MessageRow
              key={i}
              row={row}
              busy={busy}
              onDecide={(decision, aliases, canonical) =>
                row.kind === "proposal" && decide(i, row.pending, decision, aliases, canonical)
              }
            />
          ))}

          {busy && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" /> thinking…
            </div>
          )}
          {error && <p className="text-xs text-destructive">Agent error: {error}</p>}
        </div>

        <div className="flex items-end gap-2 border-t border-border p-3">
          <Textarea
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
            placeholder="Describe a change, or ask a question…"
            className="min-h-[40px] flex-1 resize-none"
            disabled={busy}
          />
          <Button size="sm" onClick={() => send()} disabled={busy || !input.trim()}>
            <ArrowRight className="size-3.5" />
          </Button>
        </div>
      </Card>
      <p className="flex items-center gap-1 text-[11px] text-muted-foreground">
        <CornerDownLeft className="size-3 shrink-0" /> Enter to send · Shift+Enter for a newline. Writes are
        always proposed and confirmed — never automatic.
      </p>
    </div>
  );
}

function MessageRow({
  row,
  busy,
  onDecide,
}: {
  row: Row;
  busy: boolean;
  onDecide: (decision: "confirm" | "reject", aliases?: string[], canonical?: string) => void;
}) {
  if (row.kind === "user") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">You</span>
        <p className="text-sm text-foreground">{row.text}</p>
      </div>
    );
  }
  if (row.kind === "tool") {
    return (
      <div className="flex items-center gap-2 text-xs text-tertiary">
        <StagePill tone={TOOL_TONE[row.tool] ?? "thinking"} label={TOOL_LABEL[row.tool] ?? "Working"} />
        {row.detail}
      </div>
    );
  }
  if (row.kind === "agent") {
    return (
      <div className="flex flex-col gap-0.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-tertiary">Weft</span>
        <p className="whitespace-pre-wrap text-sm text-foreground">{row.text}</p>
      </div>
    );
  }
  return <ProposalRow pending={row.pending} status={row.status} busy={busy} onDecide={onDecide} />;
}

function ProposalRow({
  pending,
  status,
  busy,
  onDecide,
}: {
  pending: AgentPending;
  status: "open" | "confirmed" | "rejected";
  busy: boolean;
  onDecide: (decision: "confirm" | "reject", aliases?: string[], canonical?: string) => void;
}) {
  const [aliasesText, setAliasesText] = useState(pending.aliases.join(", "));
  const [canonical, setCanonical] = useState(pending.conceptName ?? "");
  const [showMalloy, setShowMalloy] = useState(false);

  return (
    <Card className="border-border-strong">
      <CardHeader className="gap-1 border-b border-border py-2.5">
        <CardTitle className="flex flex-wrap items-center gap-2">
          <Badge variant="success">{pending.routeLabel}</Badge>
          {status === "confirmed" && <span className="text-xs font-normal text-success">applied ✓</span>}
          {status === "rejected" && (
            <span className="text-xs font-normal text-muted-foreground">rejected — model unchanged</span>
          )}
          {status === "open" && (
            <span className="text-xs font-normal text-muted-foreground">awaiting your confirmation</span>
          )}
        </CardTitle>
        {pending.reasoning && <p className="text-xs text-muted-foreground">{pending.reasoning}</p>}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-3">
        <div className="flex flex-col gap-1.5">
          {pending.addedItems.map((it) => (
            <div key={`a-${it.name}`} className="flex flex-col gap-0.5">
              <span className="font-mono text-xs">
                <span className="text-success">+ {it.kind}</span> <span className="text-foreground">{it.name}</span>
              </span>
              {it.expr && <span className="pl-3 font-mono text-xs text-muted-foreground">{it.expr}</span>}
            </div>
          ))}
          {pending.changedItems.map((it) => (
            <div key={`c-${it.name}`} className="flex flex-col gap-0.5">
              <span className="font-mono text-xs">
                <span className="text-warn">~ {it.kind}</span> <span className="text-foreground">{it.name}</span>
              </span>
              <span className="pl-3 font-mono text-xs text-muted-foreground line-through">{it.before}</span>
              <span className="pl-3 font-mono text-xs text-foreground">{it.after}</span>
            </div>
          ))}
        </div>

        {pending.isDefinition && status === "open" && (
          <div className="flex flex-col gap-2 rounded-md border border-border bg-muted/30 p-2.5">
            <span className="text-xs text-muted-foreground">Concept name + aliases (optional)</span>
            <Input
              value={canonical}
              onChange={(e) => setCanonical(e.target.value)}
              placeholder={pending.conceptName ?? "concept"}
              className="font-mono"
              disabled={busy}
            />
            <Input
              value={aliasesText}
              onChange={(e) => setAliasesText(e.target.value)}
              placeholder="also called: customers, accounts"
              className="font-mono"
              disabled={busy}
            />
            <p className="text-[11px] text-muted-foreground">
              Aliases are explicit — only words you approve; nothing is guessed.
            </p>
          </div>
        )}

        {pending.newMalloy && (
          <div className="flex flex-col gap-2">
            <button
              onClick={() => setShowMalloy((v) => !v)}
              className="self-start text-xs text-muted-foreground underline-offset-4 hover:underline"
            >
              {showMalloy ? "Hide" : "Show"} proposed model.malloy
            </button>
            {showMalloy && <MalloyBlock code={pending.newMalloy} label="proposed model.malloy" />}
          </div>
        )}

        {status === "open" && (
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => onDecide("reject")}>
              Reject
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() => onDecide("confirm", parseAliases(aliasesText), canonical.trim() || undefined)}
            >
              {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Check className="size-3.5" />}
              Confirm change
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <span className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</span>
  );
}
