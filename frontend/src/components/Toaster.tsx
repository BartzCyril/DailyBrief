import { Toaster as Sonner, toast } from "sonner";

export function Toaster() {
  return (
    <Sonner
      className="pointer-events-auto"
      theme="light"
      position="top-right"
      richColors
      closeButton
      visibleToasts={3}
      gap={12}
      duration={5000}
      containerAriaLabel="Notifications"
      customAriaLabel="Notifications (Alt + T)"
      mobileOffset={16}
      toastOptions={{
        closeButtonAriaLabel: "Fermer la notification",
        style: { fontFamily: "inherit", fontSize: "14px" },
      }}
    />
  );
}

export function notify(
  message: string,
  type: "success" | "error" | "info" = "success",
  id?: string | number,
) {
  return toast[type](<span role={type === "error" ? "alert" : "status"}>{message}</span>, {
    id,
    duration: type === "error" ? 10000 : 5000,
  });
}
