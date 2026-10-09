import { useRef, useState, type ReactNode } from "react";
import { AlertDialog } from "radix-ui";
import { Button } from "./ui/button";
import { Feedback } from "./Feedback";
import { errorMessage } from "@/lib/api";
import { modalContent, modalOverlay, restoreFocusAfterRemoval } from "./Modal";

export function ConfirmDelete({
  trigger,
  itemType,
  description,
  onConfirm,
}: {
  trigger: ReactNode;
  itemType: string;
  description: string;
  onConfirm: () => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const returnFocus = useRef<HTMLElement | null>(null);
  async function remove() {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await onConfirm();
      setOpen(false);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <AlertDialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) returnFocus.current = document.activeElement as HTMLElement | null;
        setError("");
        setOpen(next);
      }}
    >
      <AlertDialog.Trigger asChild>{trigger}</AlertDialog.Trigger>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className={modalOverlay} />
        <AlertDialog.Content
          className={`${modalContent} space-y-5`}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => restoreFocusAfterRemoval(event, returnFocus.current)}
        >
          <AlertDialog.Title className="text-xl font-semibold">
            Confirmer la suppression
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="space-y-3 text-sm">
              <p>Êtes-vous sûr de vouloir supprimer {itemType} ?</p>
              <p className="break-words text-muted-foreground">{description}</p>
            </div>
          </AlertDialog.Description>
          <Feedback error message={error} />
          <div className="flex flex-wrap justify-end gap-3">
            <AlertDialog.Cancel asChild>
              <Button variant="outline" disabled={busy}>
                Annuler
              </Button>
            </AlertDialog.Cancel>
            <Button variant="destructive" disabled={busy} onClick={() => void remove()}>
              {busy ? "Suppression en cours…" : "Supprimer"}
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
