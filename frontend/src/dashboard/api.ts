import type { Dashboard, SettingsInput } from "@dailybrief/shared";
import { api } from "@/lib/api";
import { browserTimezone } from "@/lib/timezone";
export const dashboardApi = {
  get: async (signal?: AbortSignal) => {
    const current = await api<Dashboard>("/dashboard", { signal });
    signal?.throwIfAborted();
    const timezone = browserTimezone();
    if (!timezone || timezone === current.collection.timezone) return current;
    await api<void>("/settings/dailybrief", { method: "PATCH", body: { timezone }, signal });
    return api<Dashboard>("/dashboard", { signal });
  },
  saveSettings: (body: SettingsInput) =>
    api<void>("/settings/dailybrief", { method: "PATCH", body }),
};
