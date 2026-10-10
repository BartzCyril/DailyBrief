import { useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { Button } from "./ui/button";

export const modalOverlay = "fixed inset-0 z-40 bg-black/50";
export const modalContent =
  "fixed left-1/2 top-1/2 z-50 max-h-[calc(100dvh-2rem)] w-[calc(100%-2rem)] max-w-2xl -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-xl border bg-background p-5 shadow-xl sm:p-6";

export function restoreFocusAfterRemoval(event: Event, target: HTMLElement | null) {
  if (target && !target.isConnected) {
    event.preventDefault();
    document.querySelector<HTMLElement>("main h1")?.focus();
  }
}

export function Modal({
  open,
  onOpenChange,
  title,
  description,
  trigger,
  busy = false,
  children,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  trigger: ReactNode;
  busy?: boolean;
  children: ReactNode;
}) {
  const returnFocus = useRef<HTMLElement | null>(null);
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        if (next) returnFocus.current = document.activeElement as HTMLElement | null;
        onOpenChange(next);
      }}
    >
      <Dialog.Trigger asChild>{trigger}</Dialog.Trigger>
      <Dialog.Portal>
        <Dialog.Overlay className={modalOverlay} />
        <Dialog.Content
          className={modalContent}
          {...(!description ? { "aria-describedby": undefined } : {})}
          onEscapeKeyDown={(event) => {
            if (busy) event.preventDefault();
          }}
          onPointerDownOutside={(event) => {
            if (busy) event.preventDefault();
          }}
          onCloseAutoFocus={(event) => restoreFocusAfterRemoval(event, returnFocus.current)}
        >
          <div className="mb-6 space-y-2 pr-10">
            <Dialog.Title className="break-words text-xl font-semibold">{title}</Dialog.Title>
            {description && (
              <Dialog.Description className="text-sm text-muted-foreground">
                {description}
              </Dialog.Description>
            )}
          </div>
          {children}
          <Dialog.Close asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-sm"
              className="absolute right-4 top-4"
              disabled={busy}
              aria-label="Fermer la fenêtre"
            >
              <X aria-hidden="true" />
            </Button>
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
