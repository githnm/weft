import { useMemo } from "react";
import {
  ReactFlow,
  Background,
  BackgroundVariant,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { KeyRound, Ruler, Sigma, Sparkles, Table2 } from "lucide-react";

import { cn } from "@/lib/utils";
import {
  parseSemanticModel,
  layoutDiagram,
  type DiagramNode,
} from "@/lib/parse-semantic-model";
import type { ModelDetail } from "@/lib/api";

// ── Custom node: a source rendered as a Cursor card ──────────────────
// Structural layer (table + key fields) at top; the semantic layer
// (measures, dimensions, defined concepts) built visibly on top of it.

function SourceCard({ data: raw }: NodeProps) {
  const data = raw as unknown as DiagramNode;
  const cap = <T,>(arr: T[], n: number) => ({ head: arr.slice(0, n), extra: Math.max(0, arr.length - n) });
  const m = cap(data.measures, 6);
  const d = cap(data.dimensions, 6);

  return (
    <div
      className={cn(
        "w-[260px] overflow-hidden rounded-xl border bg-card text-left",
        data.isHub ? "border-primary/40" : "border-border",
      )}
    >
      {/* invisible connection points — edges anchor here */}
      <Handle type="target" position={Position.Left} className="!h-2 !w-2 !border-0 !bg-transparent" />
      <Handle type="source" position={Position.Right} className="!h-2 !w-2 !border-0 !bg-transparent" />

      {/* header: source name + underlying table */}
      <div className="flex items-center gap-2 border-b border-border px-3 py-2">
        <Table2 className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
        <span className="truncate font-mono text-[13px] text-foreground">{data.id}</span>
        {data.isHub && (
          <span className="ml-auto rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
            fact
          </span>
        )}
      </div>
      {data.table && data.table !== data.id && (
        <div className="border-b border-border-subtle px-3 py-1">
          <span className="font-mono text-[11px] text-tertiary">{data.table}</span>
        </div>
      )}

      {/* structural layer — key fields */}
      {data.keyFields.length > 0 && (
        <div className="flex flex-col gap-0.5 px-3 py-2">
          {data.keyFields.map((f) => (
            <div key={f.name} className="flex items-center gap-1.5">
              {f.isKey ? (
                <KeyRound className="size-3 shrink-0 text-tertiary" strokeWidth={1.75} />
              ) : (
                <span className="size-3 shrink-0" />
              )}
              <span className="truncate font-mono text-[11px] text-muted-foreground">{f.name}</span>
            </div>
          ))}
        </div>
      )}

      {/* semantic layer — measures / dimensions / concepts on a tinted ground */}
      {(m.head.length > 0 || d.head.length > 0 || data.concepts.length > 0) && (
        <div className="flex flex-col gap-2 border-t border-border bg-muted/40 px-3 py-2">
          {m.head.length > 0 && (
            <Section icon={<Sigma className="size-3 text-foreground/70" strokeWidth={2} />} label="measures">
              {m.head.map((it) => (
                <span key={it.name} className="font-mono text-[11px] text-foreground">
                  {it.name}
                </span>
              ))}
              {m.extra > 0 && <span className="text-[10px] text-tertiary">+{m.extra} more</span>}
            </Section>
          )}
          {d.head.length > 0 && (
            <Section icon={<Ruler className="size-3 text-foreground/70" strokeWidth={2} />} label="dimensions">
              {d.head.map((it) => (
                <span key={it.name} className="font-mono text-[11px] text-muted-foreground">
                  {it.name}
                </span>
              ))}
              {d.extra > 0 && <span className="text-[10px] text-tertiary">+{d.extra} more</span>}
            </Section>
          )}
          {data.concepts.length > 0 && (
            <Section
              icon={<Sparkles className="size-3 text-tertiary" strokeWidth={1.75} />}
              label="defined concepts"
            >
              {data.concepts.map((c) => (
                <span
                  key={c.name}
                  className="inline-flex items-center gap-1 rounded-full border border-border-strong bg-card px-1.5 py-0.5"
                >
                  <span className="font-mono text-[11px] text-foreground">{c.name}</span>
                  {c.aliases.length > 0 && (
                    <span className="text-[10px] text-tertiary">≈ {c.aliases.join(", ")}</span>
                  )}
                </span>
              ))}
            </Section>
          )}
        </div>
      )}
    </div>
  );
}

function Section({ icon, label, children }: { icon: React.ReactNode; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {icon}
        <span className="text-[10px] font-medium uppercase tracking-wide text-tertiary">{label}</span>
      </div>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 pl-4">{children}</div>
    </div>
  );
}

const nodeTypes = { source: SourceCard };

// ── The diagram ──────────────────────────────────────────────────────

export function SemanticDiagram({ detail }: { detail: ModelDetail }) {
  const { nodes, edges } = useMemo(() => {
    const diagram = parseSemanticModel(detail);
    const pos = layoutDiagram(diagram);

    const rfNodes: Node[] = diagram.nodes.map((n) => ({
      id: n.id,
      type: "source",
      position: pos[n.id] ?? { x: 0, y: 0 },
      data: n as unknown as Record<string, unknown>,
      draggable: true,
      selectable: false,
    }));

    const rfEdges: Edge[] = diagram.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      label: `${e.label} · ${e.cardinality}`,
      labelShowBg: true,
      labelBgPadding: [6, 2] as [number, number],
      labelBgStyle: { fill: "rgb(247 247 244)", stroke: "rgb(230 229 224)" },
      labelBgBorderRadius: 4,
      labelStyle: { fill: "rgb(90 88 82)", fontSize: 10, fontFamily: "JetBrains Mono, monospace" },
      style: { stroke: "rgb(207 205 196)", strokeWidth: 1 },
      markerEnd: { type: MarkerType.ArrowClosed, color: "rgb(207 205 196)", width: 14, height: 14 },
    }));

    return { nodes: rfNodes, edges: rfEdges };
  }, [detail]);

  if (nodes.length === 0) {
    return (
      <div className="flex h-[200px] items-center justify-center text-sm text-muted-foreground">
        No sources to diagram.
      </div>
    );
  }

  return (
    <div className="relative h-[560px] w-full overflow-hidden rounded-xl border border-border bg-background">
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18, maxZoom: 1 }}
        minZoom={0.3}
        maxZoom={1.6}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        className="bg-background"
      >
        <Background variant={BackgroundVariant.Dots} gap={22} size={1} color="rgb(230 229 224)" />
        <Controls showInteractive={false} className="!border-border !shadow-none" />
      </ReactFlow>

      {/* legend */}
      <div className="pointer-events-none absolute bottom-2 right-3 flex flex-wrap items-center gap-x-3 gap-y-1 rounded-md border border-border bg-card/90 px-2.5 py-1.5 text-[10px] text-muted-foreground backdrop-blur-sm">
        <span className="flex items-center gap-1">
          <KeyRound className="size-3 text-tertiary" strokeWidth={1.75} /> key field
        </span>
        <span className="flex items-center gap-1">
          <Sigma className="size-3 text-foreground/70" strokeWidth={2} /> measure
        </span>
        <span className="flex items-center gap-1">
          <Ruler className="size-3 text-foreground/70" strokeWidth={2} /> dimension
        </span>
        <span className="flex items-center gap-1">
          <Sparkles className="size-3 text-tertiary" strokeWidth={1.75} /> concept
        </span>
      </div>
    </div>
  );
}
