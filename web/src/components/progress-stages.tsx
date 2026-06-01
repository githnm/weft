import { StagePill, type TimelineTone } from "./stage-pill";

export type StageState = "done" | "active" | "pending";

export interface Stage {
  label: string;
  state: StageState;
  /** AI-timeline pastel for this stage (Cursor signature). */
  tone: TimelineTone;
  detail?: string;
}

// The streaming pipeline rendered as Cursor's AI-timeline pills: each stage is
// a pastel pill (done = filled, active = filled + pulse, pending = hairline).
export function ProgressStages({ stages }: { stages: Stage[] }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      {stages.map((stage, i) => (
        <StagePill key={i} tone={stage.tone} label={stage.label} state={stage.state} />
      ))}
    </div>
  );
}
