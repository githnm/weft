import { ShieldCheck, Info, Ban } from "lucide-react";

import { cn } from "@/lib/utils";

export type VerificationKind = "verified" | "caveat" | "refusal";

interface VerificationCalloutProps {
  kind: VerificationKind;
  title: string;
  children?: React.ReactNode;
}

// Calm, bordered callouts. Verified = subtle green left border. Caveats = soft
// amber (informative, not alarming). Refusals = neutral, NOT an error color.
const STYLES: Record<
  VerificationKind,
  { wrap: string; icon: typeof Info; iconClass: string; titleClass: string }
> = {
  verified: {
    wrap: "border-l-2 border-l-success border-y border-r border-success-border bg-success-subtle/60",
    icon: ShieldCheck,
    iconClass: "text-success",
    titleClass: "text-foreground",
  },
  caveat: {
    wrap: "border-l-2 border-l-warn border-y border-r border-warn-border bg-warn-subtle/60",
    icon: Info,
    iconClass: "text-warn",
    titleClass: "text-foreground",
  },
  refusal: {
    wrap: "border border-border bg-muted/50",
    icon: Ban,
    iconClass: "text-muted-foreground",
    titleClass: "text-foreground",
  },
};

export function VerificationCallout({ kind, title, children }: VerificationCalloutProps) {
  const s = STYLES[kind];
  const Icon = s.icon;
  return (
    <div className={cn("rounded-lg px-3.5 py-3", s.wrap)}>
      <div className="flex items-start gap-2.5">
        <Icon className={cn("mt-px size-4 shrink-0", s.iconClass)} strokeWidth={1.75} />
        <div className="flex flex-col gap-1">
          <span className={cn("text-sm font-medium leading-none", s.titleClass)}>{title}</span>
          {children && <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>}
        </div>
      </div>
    </div>
  );
}
