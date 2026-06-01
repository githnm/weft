import * as React from "react";

import { cn } from "@/lib/utils";

/**
 * Lightweight, controlled AlertDialog in the shadcn "new-york" idiom — built
 * without Radix to keep the client dependency-free (the rest of the UI hand-
 * rolls its primitives too). Modal: blocks the page, closes on Escape or
 * backdrop click, restores body scroll on unmount.
 *
 * Used for destructive confirmations (hard model delete). The actual confirm
 * gating (type-the-name) lives in the consumer.
 */
interface AlertDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  children: React.ReactNode;
  /** When true, Escape / backdrop click won't close (e.g. an in-flight delete). */
  dismissable?: boolean;
}

export function AlertDialog({ open, onOpenChange, children, dismissable = true }: AlertDialogProps) {
  React.useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && dismissable) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
    };
  }, [open, dismissable, onOpenChange]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4">
      <div
        aria-hidden
        className="absolute inset-0 bg-foreground/20"
        onClick={() => dismissable && onOpenChange(false)}
      />
      <div
        role="alertdialog"
        aria-modal="true"
        className="relative z-10 w-full max-w-md rounded-xl border border-border bg-card p-5"
      >
        {children}
      </div>
    </div>
  );
}

export function AlertDialogHeader({ children }: { children: React.ReactNode }) {
  return <div className="flex flex-col gap-1.5">{children}</div>;
}

export function AlertDialogTitle({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <h2 className={cn("text-sm font-medium tracking-tight text-foreground", className)}>{children}</h2>
  );
}

export function AlertDialogDescription({ children }: { children: React.ReactNode }) {
  return <div className="text-sm leading-relaxed text-muted-foreground">{children}</div>;
}

export function AlertDialogFooter({ children }: { children: React.ReactNode }) {
  return <div className="mt-5 flex items-center justify-end gap-2">{children}</div>;
}
