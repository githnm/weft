import { useState } from "react";
import { Check, Copy } from "lucide-react";

import { Button } from "@/components/ui/button";

// Generated Malloy shown in monospace inside a bordered panel (no shadow).
export function MalloyBlock({ code, label = "Generated Malloy" }: { code: string; label?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = () => {
    void navigator.clipboard?.writeText(code).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  // Code surface: white card, warm ink, JetBrains Mono 13px, hairline only.
  return (
    <div className="overflow-hidden rounded-lg border border-code-border bg-code">
      <div className="flex items-center justify-between border-b border-border-subtle px-3 py-1.5">
        <span className="text-[11px] font-semibold uppercase tracking-[0.08em] text-tertiary">{label}</span>
        <Button
          variant="ghost"
          size="sm"
          className="h-6 gap-1.5 px-1.5 text-muted-foreground hover:bg-muted hover:text-foreground"
          onClick={copy}
        >
          {copied ? <Check className="size-3" /> : <Copy className="size-3" />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
      <pre className="overflow-x-auto bg-code px-4 py-3 font-mono text-[13px] leading-relaxed text-code-foreground">
        <code>{code}</code>
      </pre>
    </div>
  );
}
