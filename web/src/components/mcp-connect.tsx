import { useEffect, useState } from "react";
import { Check, ChevronDown, Copy, Plug, TriangleAlert } from "lucide-react";

import { cn } from "@/lib/utils";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { fetchMcpConfig, type McpConfig } from "@/lib/api";

/**
 * "Connect via MCP" — shows the exact config block to paste into
 * claude_desktop_config.json. The server computes the absolute paths; the user
 * copies, pastes inside their mcpServers, and adds their key. No path typing.
 */
export function McpConnect({ defaultOpen = true }: { defaultOpen?: boolean }) {
  const [cfg, setCfg] = useState<McpConfig | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState(defaultOpen);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    fetchMcpConfig()
      .then(setCfg)
      .catch((e) => setErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const copy = () => {
    if (!cfg) return;
    navigator.clipboard
      .writeText(cfg.blockText)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => {});
  };

  return (
    <Card>
      <CardHeader className="border-b border-border py-2.5">
        <button onClick={() => setOpen((o) => !o)} className="flex w-full items-center gap-2 text-left">
          <Plug className="size-3.5 text-muted-foreground" strokeWidth={1.75} />
          <CardTitle className="text-foreground">Connect via MCP</CardTitle>
          <span className="text-xs text-muted-foreground">Use this model in Claude Desktop</span>
          <ChevronDown
            className={cn("ml-auto size-4 text-muted-foreground transition-transform", open && "rotate-180")}
          />
        </button>
      </CardHeader>

      {open && (
        <CardContent className="flex flex-col gap-3 pt-3">
          {err && (
            <p className="rounded-md border border-border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
              {err}
            </p>
          )}

          {cfg && !cfg.serverExists && (
            <div className="flex items-start gap-2 rounded-md border border-warn/30 bg-warn/[0.06] px-3 py-2 text-xs text-foreground">
              <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warn" strokeWidth={2} />
              <span>
                The server isn’t built yet. Run <span className="font-mono">pnpm build</span>, then reopen this panel.
              </span>
            </div>
          )}

          {cfg && (
            <>
              {/* The block to merge — paths already filled in */}
              <div className="relative">
                <button
                  onClick={copy}
                  className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md border border-border bg-card px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                >
                  {copied ? <Check className="size-3 text-success" strokeWidth={2.5} /> : <Copy className="size-3" />}
                  {copied ? "Copied" : "Copy"}
                </button>
                <pre className="overflow-x-auto rounded-md border border-border bg-muted/40 p-3 pr-16 font-mono text-[12px] leading-relaxed text-foreground">
                  {cfg.blockText}
                </pre>
              </div>

              {/* Steps */}
              <ol className="flex flex-col gap-1.5 text-xs text-muted-foreground">
                <Step n={1}>
                  Add this <span className="font-medium text-foreground">inside</span> the{" "}
                  <span className="font-mono text-foreground">mcpServers</span> object in your config — don’t replace
                  the whole file.
                </Step>
                <Step n={2}>
                  Config file:{" "}
                  <span className="break-all font-mono text-foreground">{cfg.configPath}</span>
                </Step>
                <Step n={3}>
                  Replace <span className="font-mono text-foreground">{cfg.placeholderKey}</span> with your Anthropic
                  API key.
                </Step>
                <Step n={4}>
                  <span className="font-medium text-foreground">Fully quit and reopen</span> Claude Desktop after
                  editing (don’t just close the window).
                </Step>
              </ol>

              <p className="text-[11px] text-tertiary">
                Models are discovered automatically under{" "}
                <span className="font-mono">{cfg.weftHome}</span> — no model path to configure.
              </p>
            </>
          )}
        </CardContent>
      )}
    </Card>
  );
}

function Step({ n, children }: { n: number; children: React.ReactNode }) {
  return (
    <li className="flex items-start gap-2">
      <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center rounded-full bg-muted text-[10px] font-medium text-muted-foreground">
        {n}
      </span>
      <span>{children}</span>
    </li>
  );
}
