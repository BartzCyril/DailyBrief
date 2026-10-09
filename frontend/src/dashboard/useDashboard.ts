import { useCallback, useEffect, useState } from "react";
import type { Dashboard } from "@dailybrief/shared";
import { dashboardApi } from "./api";
import { errorMessage } from "@/lib/api";
export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const refresh = useCallback(async () => {
    setError("");
    try {
      setData(await dashboardApi.get());
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, loading, error, refresh };
}
