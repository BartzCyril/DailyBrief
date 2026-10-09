import { useCallback, useEffect, useState } from "react";
import type { Dashboard, Source } from "@dailybrief/shared";
import { dashboardApi } from "./api";
import { sourcesApi } from "@/sources/api";
import { errorMessage } from "@/lib/api";
export function useDashboard() {
  const [data, setData] = useState<Dashboard | null>(null);
  const [sources, setSources] = useState<Source[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(async () => {
    setError("");
    try {
      const [dashboard, sources] = await Promise.all([dashboardApi.get(), sourcesApi.list()]);
      setData(dashboard);
      setSources(sources);
      setRevision((value) => value + 1);
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refresh();
  }, [refresh]);
  return { data, sources, loading, error, refresh, revision };
}
