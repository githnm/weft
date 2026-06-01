import { useEffect, useState } from "react";
import { Loader2, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  AlertDialog,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { deleteModel } from "@/lib/api";

/**
 * Hard-delete confirmation. Requires typing the exact model name to enable the
 * destructive button — an explicit, deliberate gate (not a one-click OK).
 * Shared by the models grid (•••) and the model editor (detail).
 */
export function DeleteModelDialog({
  name,
  open,
  onOpenChange,
  onDeleted,
}: {
  name: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onDeleted: (name: string) => void;
}) {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  // Reset whenever the dialog opens (or switches model).
  useEffect(() => {
    if (open) {
      setConfirmText("");
      setErr(null);
      setBusy(false);
    }
  }, [open, name]);

  if (!name) return null;
  const canDelete = confirmText.trim() === name && !busy;

  const doDelete = () => {
    if (!canDelete) return;
    setBusy(true);
    setErr(null);
    deleteModel(name)
      .then(() => onDeleted(name))
      .catch((e) => {
        setErr(e instanceof Error ? e.message : String(e));
        setBusy(false);
      });
  };

  return (
    <AlertDialog open={open} onOpenChange={onOpenChange} dismissable={!busy}>
      <AlertDialogHeader>
        <AlertDialogTitle className="flex items-center gap-2">
          <Trash2 className="size-4 text-destructive" />
          <span>
            Delete <span className="font-mono">{name}</span>?
          </span>
        </AlertDialogTitle>
        <AlertDialogDescription>
          This permanently deletes the model and everything it carries — its measures, dimensions,
          baked definitions, terms and corrections, and its full decision history / traces. It does
          not touch your warehouse or other models.{" "}
          <span className="text-foreground">This cannot be undone.</span>
        </AlertDialogDescription>
      </AlertDialogHeader>

      <div className="mt-4 flex flex-col gap-1.5">
        <label className="text-xs text-muted-foreground">
          Type <span className="font-mono text-foreground">{name}</span> to confirm.
        </label>
        <Input
          autoFocus
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && doDelete()}
          placeholder={name}
          className="font-mono"
          disabled={busy}
        />
        {err && <p className="text-xs text-destructive">Couldn’t delete: {err}</p>}
      </div>

      <AlertDialogFooter>
        <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)} disabled={busy}>
          Cancel
        </Button>
        <Button variant="destructive" size="sm" onClick={doDelete} disabled={!canDelete}>
          {busy ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
          {busy ? "Deleting…" : "Delete model"}
        </Button>
      </AlertDialogFooter>
    </AlertDialog>
  );
}
