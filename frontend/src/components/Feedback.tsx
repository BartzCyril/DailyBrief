import { Alert, AlertDescription } from "./ui/alert";
export function Feedback({ message, error = false }: { message: string; error?: boolean }) { return message ? <Alert variant={error ? "destructive" : "default"} role={error ? "alert" : "status"}><AlertDescription>{message}</AlertDescription></Alert> : null; }
