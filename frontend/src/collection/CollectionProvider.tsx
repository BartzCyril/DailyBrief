import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import type { CollectionRunSnapshot } from "@dailybrief/shared";
import { api, errorMessage } from "@/lib/api";

type CollectionContext = {
  run: CollectionRunSnapshot | null;
  busy: boolean;
  error: string;
  start: () => Promise<void>;
  refresh: () => Promise<void>;
};
const Context = createContext<CollectionContext | null>(null);
export function CollectionProvider({ children }: { children: ReactNode }) {
  const [run, setRun] = useState<CollectionRunSnapshot | null>(null);
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState("");
  const mounted = useRef(true);
  const startingRef = useRef(false);
  const generation = useRef(0);
  const requestSequence = useRef(0);
  const refresh = useCallback(async () => {
    const version = generation.current;
    const requestId = ++requestSequence.current;
    try {
      const current = await api<CollectionRunSnapshot | null>("/collection/current");
      if (
        mounted.current &&
        version === generation.current &&
        requestId === requestSequence.current
      ) {
        setRun(current?.id ? current : null);
        setError("");
      }
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    }
  }, []);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (document.visibilityState !== "hidden") await refresh();
      if (!stopped) timer = setTimeout(() => void tick(), run?.active ? 1500 : 10000);
    };
    void tick();
    const focus = () => {
      void refresh();
    };
    window.addEventListener("focus", focus);
    document.addEventListener("visibilitychange", focus);
    return () => {
      stopped = true;
      clearTimeout(timer);
      window.removeEventListener("focus", focus);
      document.removeEventListener("visibilitychange", focus);
    };
  }, [run?.active, refresh]);
  async function start() {
    if (startingRef.current || run?.active) return;
    startingRef.current = true;
    generation.current++;
    setStarting(true);
    setError("");
    try {
      const current = await api<CollectionRunSnapshot>("/collection/run", {
        method: "POST",
        body: {},
      });
      generation.current++;
      if (mounted.current) setRun(current);
    } catch (error) {
      if (mounted.current) setError(errorMessage(error));
    } finally {
      startingRef.current = false;
      if (mounted.current) setStarting(false);
    }
  }
  return (
    <Context.Provider
      value={{ run, busy: starting || Boolean(run?.active), error, start, refresh }}
    >
      {children}
    </Context.Provider>
  );
}
export function useCollection() {
  const value = useContext(Context);
  if (!value) throw new Error("CollectionProvider missing");
  return value;
}
