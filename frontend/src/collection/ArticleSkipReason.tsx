import { useState } from "react";
import { Tooltip } from "radix-ui";
import { Info } from "lucide-react";

export function ArticleSkipReason({ reason }: { reason: string }) {
  const [open, setOpen] = useState(false);
  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root open={open} onOpenChange={setOpen}>
        <Tooltip.Trigger asChild>
          <button
            type="button"
            className="inline-flex cursor-pointer items-center gap-2 whitespace-nowrap rounded-md text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring"
            onClick={(event) => {
              // A tap also opens the explanation on touch screens.
              event.preventDefault();
              setOpen(true);
            }}
          >
            <span aria-hidden="true" className="size-2 shrink-0 rounded-full bg-slate-400" />
            Ignoré
            <Info className="size-4" aria-hidden="true" />
          </button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-50 max-h-[calc(100dvh-4rem)] max-w-[min(24rem,calc(100vw-2rem))] overflow-y-auto whitespace-pre-line rounded-lg bg-foreground px-4 py-3 text-sm leading-relaxed text-background shadow-md"
          >
            {reason}
            <Tooltip.Arrow className="fill-foreground" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
