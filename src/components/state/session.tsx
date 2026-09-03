"use client";

/**
 * One session, shared by all three surfaces.
 *
 * Every mutation returns the whole session rather than a patch, because a
 * verdict moves the budget, the ledger and the chain head at once, and a
 * surface holding a stale meter next to a fresh refusal would be lying about
 * which of the two caused the other.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import type { SessionView } from "@/app/_shared/view";

export type LifecycleAction = "draft" | "sign" | "anchor" | "tamper" | "restore" | "revoke";

interface SessionState {
  session: SessionView | null;
  loading: boolean;
  /** Which action is in flight, so a button can say what it is doing. */
  pending: string | null;
  error: string | null;
  selectedActId: string | null;
  select: (id: string | null) => void;
  refresh: () => Promise<void>;
  lifecycle: (action: LifecycleAction) => Promise<void>;
  runAct: (presetId: string) => Promise<string | null>;
  setStep: (step: number) => Promise<void>;
  reset: () => Promise<void>;
}

const Context = createContext<SessionState | null>(null);

async function readJson(response: Response): Promise<Record<string, unknown>> {
  const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
  if (!response.ok) {
    throw new Error(typeof body.error === "string" ? body.error : `Request failed (${response.status})`);
  }
  return body;
}

export function SessionProvider({ children }: { children: React.ReactNode }) {
  const [session, setSession] = useState<SessionView | null>(null);
  const [loading, setLoading] = useState(true);
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedActId, setSelectedActId] = useState<string | null>(null);
  const started = useRef(false);

  const refresh = useCallback(async () => {
    try {
      const body = await readJson(await fetch("/api/session", { cache: "no-store" }));
      setSession(body as unknown as SessionView);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void refresh();
  }, [refresh]);

  const lifecycle = useCallback(async (action: LifecycleAction) => {
    setPending(action);
    setError(null);
    try {
      const body = await readJson(
        await fetch("/api/writ", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action }),
        }),
      );
      setSession(body as unknown as SessionView);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setPending(null);
    }
  }, []);

  const runAct = useCallback(async (presetId: string) => {
    setPending(presetId);
    setError(null);
    try {
      const body = await readJson(
        await fetch("/api/act", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ presetId }),
        }),
      );
      setSession(body as unknown as SessionView);
      const id = typeof body.act === "string" ? body.act : null;
      setSelectedActId(id);
      return id;
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      return null;
    } finally {
      setPending(null);
    }
  }, []);

  const setStep = useCallback(async (step: number) => {
    try {
      const body = await readJson(
        await fetch("/api/writ", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ action: "step", step }),
        }),
      );
      setSession(body as unknown as SessionView);
    } catch {
      // The step marker is a bookmark, not state the gate reads. Losing it is
      // not worth interrupting a walkthrough for.
    }
  }, []);

  const reset = useCallback(async () => {
    setPending("reset");
    try {
      await fetch("/api/session", { method: "DELETE" });
      setSelectedActId(null);
      await refresh();
    } finally {
      setPending(null);
    }
  }, [refresh]);

  const value = useMemo<SessionState>(
    () => ({
      session,
      loading,
      pending,
      error,
      selectedActId,
      select: setSelectedActId,
      refresh,
      lifecycle,
      runAct,
      setStep,
      reset,
    }),
    [session, loading, pending, error, selectedActId, refresh, lifecycle, runAct, setStep, reset],
  );

  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useSession(): SessionState {
  const value = useContext(Context);
  if (value === null) throw new Error("useSession must be used inside SessionProvider");
  return value;
}

/** The act a surface is currently showing, or the most recent one. */
export function useSelectedAct() {
  const { session, selectedActId } = useSession();
  if (session === null || session.acts.length === 0) return null;
  return (
    session.acts.find((act) => act.id === selectedActId) ?? session.acts[session.acts.length - 1]
  );
}
