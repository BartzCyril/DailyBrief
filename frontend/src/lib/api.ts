export class ApiError extends Error { constructor(public status: number, message: string, public code?: string) { super(message); } }
export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { method: options.method ?? "GET", credentials: "include", signal: options.signal, ...(options.body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(options.body) } : {}) }); }
  catch (error) { if (error instanceof DOMException && error.name === "AbortError") throw error; throw new ApiError(0, "Connexion impossible. Vérifiez votre réseau puis réessayez."); }
  if (!response.ok) {
    const data = await response.json().catch(() => ({})) as { message?: string; code?: string };
    if (response.status === 401 && !path.startsWith("/auth/")) window.dispatchEvent(new Event("dailybrief:unauthenticated"));
    throw new ApiError(response.status, data.message ?? "La requête a échoué.", data.code);
  }
  return response.status === 204 ? undefined as T : await response.json() as T;
}
export function errorMessage(error: unknown): string { return error instanceof Error ? error.message : "Une erreur est survenue."; }
