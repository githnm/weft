import { cn } from "@/lib/utils";

/**
 * AI action-stage pill — the Cursor "timeline" signature.
 *
 * SCOPED to AI action stages only (Ask streaming stages, model-builder agent
 * tool calls). Never use the pastel timeline palette as general UI/status color.
 * Style: 11px / 600 / uppercase / tracking, pill radius, 4×10 padding.
 */
export type TimelineTone = "thinking" | "grep" | "read" | "edit" | "done";

const TONE_FILL: Record<TimelineTone, string> = {
  thinking: "bg-timeline-thinking text-foreground", // peach
  grep: "bg-timeline-grep text-foreground", // mint
  read: "bg-timeline-read text-foreground", // blue
  edit: "bg-timeline-edit text-foreground", // lavender
  done: "bg-timeline-done text-white", // gold
};

const BASE =
  "inline-flex items-center gap-1.5 rounded-full px-[10px] py-[4px] text-[11px] font-semibold uppercase leading-none tracking-[0.08em]";

export function StagePill({
  tone,
  label,
  state = "done",
  className,
}: {
  tone: TimelineTone;
  label: string;
  state?: "done" | "active" | "pending";
  className?: string;
}) {
  if (state === "pending") {
    // Not reached yet — quiet hairline outline, no pastel fill.
    return <span className={cn(BASE, "border border-border text-tertiary", className)}>{label}</span>;
  }
  return (
    <span className={cn(BASE, TONE_FILL[tone], className)}>
      {state === "active" && <span className="size-1.5 animate-pulse rounded-full bg-current opacity-80" aria-hidden />}
      {label}
    </span>
  );
}
