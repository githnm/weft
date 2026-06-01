import { MessageSquareText, Boxes, GitBranch, Plug } from "lucide-react";

import { cn } from "@/lib/utils";

export type View = "ask" | "models" | "context" | "connections";

// Ordered to match the workflow: connect a source → build a model →
// ask questions → review context/usage.
const NAV: { id: View; label: string; icon: typeof MessageSquareText; hint: string }[] = [
  { id: "connections", label: "Connections", icon: Plug, hint: "Databases" },
  { id: "models", label: "Models", icon: Boxes, hint: "Semantic models" },
  { id: "ask", label: "Ask", icon: MessageSquareText, hint: "Query a model" },
  { id: "context", label: "Context", icon: GitBranch, hint: "Decision graph" },
];

export function AppSidebar({ view, onNavigate }: { view: View; onNavigate: (v: View) => void }) {
  return (
    <aside className="flex w-60 shrink-0 flex-col border-r border-border bg-muted/40">
      {/* Brand */}
      <div className="flex h-14 items-center gap-2 border-b border-border px-4">
        <div className="flex h-6 w-6 items-center justify-center rounded-md border border-border bg-card">
          <span className="h-2 w-2 rounded-[2px] bg-primary" />
        </div>
        <span className="text-sm font-medium tracking-tight">Weft</span>
      </div>

      {/* Nav */}
      <nav className="flex flex-col gap-0.5 p-2">
        {NAV.map((item) => {
          const active = view === item.id;
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={cn(
                "group relative flex items-center gap-2.5 rounded-md px-2.5 py-1.5 text-sm transition-colors",
                active
                  ? "bg-secondary font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground",
              )}
            >
              {/* Active marker: a quiet ink left bar (orange stays CTA-only). */}
              <span
                className={cn(
                  "absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-foreground transition-opacity",
                  active ? "opacity-100" : "opacity-0",
                )}
              />
              <Icon
                className={cn("size-4 shrink-0", active ? "text-foreground" : "text-muted-foreground")}
                strokeWidth={1.75}
              />
              {item.label}
            </button>
          );
        })}
      </nav>

      <div className="mt-auto border-t border-border p-3">
        <p className="text-xs leading-relaxed text-muted-foreground">
          Read-only. Verified queries. <br /> Refuses to fabricate.
        </p>
      </div>
    </aside>
  );
}
