import type { User } from "@dailybrief/shared";
import { api } from "@/lib/api";
export const authApi = {
  me: () => api<User>("/auth/me"),
  login: (email: string, password: string) => api<User>("/auth/login", { method: "POST", body: { email, password } }),
  register: (email: string, password: string) => api<User>("/auth/register", { method: "POST", body: { email, password } }),
  logout: () => api<void>("/auth/logout", { method: "POST", body: {} }),
};
