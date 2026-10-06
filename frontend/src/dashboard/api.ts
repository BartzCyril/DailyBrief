import type { Dashboard, SettingsInput, RunResult } from "@dailybrief/shared";
import { api } from "@/lib/api";
export const dashboardApi = {
  get: () => api<Dashboard>("/dashboard"),
  saveSettings: (body: SettingsInput) =>
    api<void>("/settings/dailybrief", { method: "PATCH", body }),
  run: () => api<RunResult>("/collection/run", { method: "POST", body: {} }),
};
