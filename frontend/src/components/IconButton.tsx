import type { ComponentProps } from "react";
import { Tooltip } from "radix-ui";
import { Button } from "./ui/button";
import { cn } from "@/lib/utils";

export function IconButton({
  tooltip,
  className,
  children,
  ...props
}: ComponentProps<typeof Button> & { tooltip: string }) {
  return (
    <Tooltip.Provider delayDuration={250}>
      <Tooltip.Root>
        <Tooltip.Trigger asChild>
          <Button
            type="button"
            variant="outline"
            size="icon-sm"
            className={cn("cursor-pointer", className)}
            {...props}
          >
            {children}
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Portal>
          <Tooltip.Content
            sideOffset={6}
            className="z-50 max-w-64 rounded-md bg-foreground px-3 py-2 text-xs text-background shadow-md"
          >
            {tooltip}
            <Tooltip.Arrow className="fill-foreground" />
          </Tooltip.Content>
        </Tooltip.Portal>
      </Tooltip.Root>
    </Tooltip.Provider>
  );
}
