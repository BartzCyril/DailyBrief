import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import type { User } from "@dailybrief/shared";
import { authApi } from "./api";
import { ApiError, errorMessage } from "@/lib/api";
type Auth = {
  user: User | null;
  loading: boolean;
  error: string;
  refresh: () => Promise<void>;
  login: (email: string, password: string) => Promise<void>;
  logout: () => Promise<void>;
};
const AuthContext = createContext<Auth | null>(null);
export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  async function refresh() {
    setLoading(true);
    setError("");
    try {
      setUser(await authApi.me());
    } catch (error) {
      setUser(null);
      if (!(error instanceof ApiError && error.status === 401)) setError(errorMessage(error));
    } finally {
      setLoading(false);
    }
  }
  useEffect(() => {
    void refresh();
    const expired = () => setUser(null);
    window.addEventListener("dailybrief:unauthenticated", expired);
    return () => window.removeEventListener("dailybrief:unauthenticated", expired);
  }, []);
  async function login(email: string, password: string) {
    setUser(await authApi.login(email, password));
  }
  async function logout() {
    await authApi.logout();
    setUser(null);
  }
  return (
    <AuthContext value={{ user, loading, error, refresh, login, logout }}>{children}</AuthContext>
  );
}
export function useAuth() {
  const auth = useContext(AuthContext);
  if (!auth) throw new Error("AuthProvider required");
  return auth;
}
