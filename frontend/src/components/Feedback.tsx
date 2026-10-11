import { useEffect, useId, useRef } from "react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "./ui/alert";
import { notify } from "./Toaster";

export function Feedback({
  message,
  error = false,
  inline = false,
}: {
  message: string;
  error?: boolean;
  inline?: boolean;
}) {
  const id = useId();
  const activeToast = useRef<string | undefined>(undefined);
  const sequence = useRef(0);
  useEffect(() => {
    if (inline || !message) {
      if (activeToast.current) toast.dismiss(activeToast.current);
      activeToast.current = undefined;
      return;
    }
    // A dismissed toast is still animating out; a retry needs its own identity.
    activeToast.current ??= `${id}:${++sequence.current}`;
    notify(message, error ? "error" : "success", activeToast.current);
  }, [message, error, inline, id]);
  return inline && message ? (
    <Alert variant={error ? "destructive" : "default"} role={error ? "alert" : "status"}>
      <AlertDescription>{message}</AlertDescription>
    </Alert>
  ) : null;
}
