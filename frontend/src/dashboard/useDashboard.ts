import { useCallback, useEffect, useRef, useState } from "react";
import type { Dashboard } from "@dailybrief/shared";
import { dashboardApi } from "./api";
import { errorMessage } from "@/lib/api";
export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const request = useRef<AbortController | null>(null);
  const refresh = useCallback(async () => {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setError("");
    try {
      const current = await dashboardApi.get(controller.signal);
      if (!controller.signal.aborted) setData(current);
    } catch (error) {
      if (!controller.signal.aborted) setError(errorMessage(error));
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
    return () => request.current?.abort();
  }, [refresh]);
  return { data, loading, error, refresh };
}
