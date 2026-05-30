import { Check, Loader2 } from "lucide-react";

import { cn } from "@/lib/utils";

export type StageState = "done" | "active" | "pending";

export interface Stage {
  label: string;
  state: StageState;
  detail?: string;
}

// A clean vertical list with small check icons; the active step is slightly
// emphasized. Muted throughout — the accent only marks completion.
export function ProgressStages({ stages }: { stages: Stage[] }) {
  return (
    <ol className="flex flex-col gap-2.5">
      {stages.map((stage, i) => (
        <li key={i} className="flex items-start gap-2.5">
          <span className="mt-0.5 flex size-4 shrink-0 items-center justify-center">
            {stage.state === "done" && <Check className="size-3.5 text-primary" strokeWidth={2.25} />}
            {stage.state === "active" && (
              <Loader2 className="size-3.5 animate-spin text-foreground" strokeWidth={2} />
            )}
            {stage.state === "pending" && (
              <span className="size-1.5 rounded-full bg-border" aria-hidden />
            )}
          </span>
          <div className="flex flex-col">
            <span
              className={cn(
                "text-sm leading-none",
                stage.state === "active"
                  ? "font-medium text-foreground"
                  : stage.state === "done"
                    ? "text-foreground"
                    : "text-muted-foreground",
              )}
            >
              {stage.label}
            </span>
            {stage.detail && (
              <span className="mt-1 text-xs text-muted-foreground">{stage.detail}</span>
            )}
          </div>
        </li>
      ))}
    </ol>
  );
}
