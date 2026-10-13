"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { hostedRequest, HostedClientError, type HostedAgent, type HostedFinance } from "./hosted-client";

type View = { key: string; value: HostedFinance | null; previous?: Extract<HostedFinance, { status: "confirmed" }>; stale: boolean; error: string; loading: boolean };
/** Financial reads have their own lifecycle: ordinary list polling cannot scan the ledger. */
export function useHostedFinance(agent: HostedAgent | null, authenticated: boolean, revision: string, onUnauthorized: () => void) {
  const key = authenticated && agent ? `${agent.owner}:${agent.id}:${agent.binding?.chainId}:${agent.binding?.agentId}:${agent.wallet}` : "";
  const [view, setView] = useState<View>({ key: "", value: null, stale: false, error: "", loading: false });
  const current = useRef({ key, agent, revision }); current.current = { key, agent, revision };
  const inFlight = useRef(new Map<string, { revision: string; promise: Promise<HostedFinance> }>());
  // Keep transport completion separate from visible identity state. A late 401
  // can clear the HttpOnly cookie even when its React result is discarded.
  const activeReads = useRef(new Set<Promise<HostedFinance>>());
  const generation = useRef(0);
  const recovery = useRef<{ key: string; remaining: number; waiting: boolean; timer: ReturnType<typeof setTimeout> | null }>({ key: "", remaining: 1, waiting: false, timer: null });
  const cancelRecovery = useCallback(() => {
    if (recovery.current.timer !== null) clearTimeout(recovery.current.timer);
    recovery.current.timer = null; recovery.current.waiting = false;
  }, []);
  const refresh = useCallback(async (resetRecovery = true): Promise<void> => {
    const selected = current.current;
    if (!selected.key || !selected.agent) return;
    if (resetRecovery || recovery.current.key !== selected.key) {
      cancelRecovery(); recovery.current = { key: selected.key, remaining: 1, waiting: false, timer: null };
    }
    // Transport interruptions and the reader's explicit aggregate timeout share
    // one retry. Other unavailable results may be permanent and stay stopped.
    const scheduleRecovery = () => {
      const retry = recovery.current;
      if (retry.key !== selected.key || retry.remaining < 1) return;
      retry.waiting = true;
      retry.timer = setTimeout(() => {
        retry.timer = null;
        if (retry !== recovery.current || !retry.waiting || current.current.key !== retry.key ||
          document.visibilityState !== "visible" || navigator.onLine === false) return;
        retry.waiting = false; retry.remaining--; void refresh(false);
      }, 500);
    };
    const lease = ++generation.current;
    setView(old => ({ key: selected.key, value: old.key === selected.key ? old.value : null, previous: old.key === selected.key ? old.previous : undefined, stale: old.key === selected.key && old.value?.status === "confirmed", error: "", loading: true }));
    let request = inFlight.current.get(selected.key);
    if (!request) {
      const promise = hostedRequest<HostedFinance>(`/agents/${encodeURIComponent(selected.agent.id)}/finance`);
      activeReads.current.add(promise);
      request = { revision: selected.revision, promise }; inFlight.current.set(selected.key, request);
      void promise.finally(() => { activeReads.current.delete(promise); if (inFlight.current.get(selected.key)?.promise === promise) inFlight.current.delete(selected.key); }).catch(() => undefined);
    }
    const readRevision = request.revision;
    const activeRequest = request;
    return (async () => {
      try {
        const value = await activeRequest.promise;
        if (lease !== generation.current || current.current.key !== selected.key) return;
        if (value.status === "confirmed" && (value.agentId !== selected.agent!.binding?.agentId || value.chainId !== selected.agent!.binding?.chainId || value.wallet.toLowerCase() !== selected.agent!.wallet.toLowerCase())) throw new Error("FINANCE_BINDING_MISMATCH");
        setView(old => value.status === "unavailable" && old.key === selected.key && old.value?.status === "confirmed"
          ? { key: selected.key, value: old.value, stale: true, error: value.reason, loading: false }
          : { key: selected.key, value, previous: old.key === selected.key && old.value?.status === "confirmed" ? old.value : undefined, stale: false, error: value.status === "unavailable" ? value.reason : "", loading: false });
        if (value.status === "unavailable" && value.reason === "HOSTED_FINANCE_TIMEOUT") scheduleRecovery();
      } catch (error) {
        if (lease !== generation.current || current.current.key !== selected.key) return;
        if (error instanceof HostedClientError && error.status === 401) { onUnauthorized(); return; }
        setView(old => ({ key: selected.key, value: old.key === selected.key ? old.value : null, stale: old.key === selected.key && old.value?.status === "confirmed", error: "HOSTED_FINANCE_UNCONFIRMED", loading: false }));
        // A suspended browser socket has no HTTP response. Do not retry auth errors.
        if (error instanceof HostedClientError && error.status === 0) scheduleRecovery();
      } finally {
        // A task may finish while a slow read is in flight; read its latest state once.
        if (lease === generation.current && current.current.key === selected.key && current.current.revision !== readRevision) void refresh();
      }
    })();
  }, [onUnauthorized, cancelRecovery]);
  useEffect(() => {
    generation.current++;
    cancelRecovery();
    if (key) void refresh();
    else inFlight.current.clear();
    return () => { generation.current++; cancelRecovery(); };
  }, [key, refresh, cancelRecovery]);
  useEffect(() => { if (key) void refresh(); }, [key, revision, refresh]);
  useEffect(() => {
    const resume = () => {
      const retry = recovery.current;
      if (!retry.waiting || retry.remaining < 1 || !retry.key || current.current.key !== retry.key ||
        document.visibilityState !== "visible" || navigator.onLine === false) return;
      cancelRecovery(); retry.remaining--; void refresh(false);
    };
    window.addEventListener("online", resume); document.addEventListener("visibilitychange", resume);
    return () => { window.removeEventListener("online", resume); document.removeEventListener("visibilitychange", resume); };
  }, [refresh, cancelRecovery]);
  const waitUntilIdle = useCallback(async () => {
    // Login must also stop a queued reconnect: it could otherwise start after
    // this transport barrier and deliver an old 401 after the new cookie.
    cancelRecovery(); recovery.current.remaining = 0;
    while (activeReads.current.size) await Promise.allSettled([...activeReads.current]);
    cancelRecovery();
  }, [cancelRecovery]);
  const visible: View = view.key === key && key ? view : { key, value: null, stale: false, error: "", loading: !!key };
  return { ...visible, refresh, waitUntilIdle };
}
