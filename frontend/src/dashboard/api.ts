import type { Dashboard, SettingsInput } from "@dailybrief/shared";
import { api } from "@/lib/api";
export const dashboardApi = {
  get: () => api<Dashboard>("/dashboard"),
  saveSettings: (body: SettingsInput) =>
    api<void>("/settings/dailybrief", { method: "PATCH", body }),
};
