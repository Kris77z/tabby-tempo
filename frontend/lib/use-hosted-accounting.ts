"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { hostedRequest, HostedClientError, type HostedAccounting, type HostedAgent } from "./hosted-client";
import { settlementSymbol } from "./networks";
import { projectHostedAccounting } from "./hosted-accounting";

type View = { key: string; value: HostedAccounting | null; stale: boolean; loading: boolean; error: string };
/** Mounted with the session so reads remain part of the login cookie barrier after the view closes. */
export function useHostedAccounting(agent: HostedAgent | null, enabled: boolean, revision: string, onUnauthorized: () => void) {
  const key = enabled && agent ? `${agent.owner.toLowerCase()}:${agent.id}:${agent.wallet.toLowerCase()}:${agent.binding?.chainId}:${agent.binding?.agentId}` : "";
  const [view, setView] = useState<View>({ key: "", value: null, stale: false, loading: false, error: "" });
  const current = useRef({ key, agent, revision }); current.current = { key, agent, revision };
  const generation = useRef(0);
  const inFlight = useRef(new Map<string, { revision: string; promise: Promise<HostedAccounting> }>());
  const activeReads = useRef(new Set<Promise<HostedAccounting>>());
  const refresh = useCallback(async (): Promise<void> => {
    const selected = current.current;
    if (!selected.key || !selected.agent) return;
    const lease = ++generation.current;
    setView(old => ({ key: selected.key, value: old.key === selected.key ? old.value : null, stale: old.key === selected.key && !!old.value, loading: true, error: "" }));
    let request = inFlight.current.get(selected.key);
    if (!request) {
      const promise = hostedRequest<HostedAccounting>(`/agents/${encodeURIComponent(selected.agent.id)}/accounting`);
      activeReads.current.add(promise);
      request = { revision: selected.revision, promise }; inFlight.current.set(selected.key, request);
      void promise.finally(() => {
        activeReads.current.delete(promise);
        if (inFlight.current.get(selected.key)?.promise === promise) inFlight.current.delete(selected.key);
      }).catch(() => undefined);
    }
    const activeRequest = request;
    try {
      const value = projectHostedAccounting(await activeRequest.promise);
      if (lease !== generation.current || current.current.key !== selected.key) return;
      if (value.agentId !== selected.agent.id || value.version !== 1 || (selected.agent.binding && value.currency !== settlementSymbol(selected.agent.binding.chainId)) || value.decimals !== 6 || !["complete", "partial"].includes(value.status)) throw new Error("ACCOUNTING_IDENTITY_MISMATCH");
      setView({ key: selected.key, value, stale: false, loading: false, error: "" });
    } catch (cause) {
      if (lease !== generation.current || current.current.key !== selected.key) return;
      if (cause instanceof HostedClientError && cause.status === 401) { onUnauthorized(); return; }
      setView(old => ({ key: selected.key, value: old.key === selected.key ? old.value : null, stale: old.key === selected.key && !!old.value, loading: false, error: "HOSTED_ACCOUNTING_UNAVAILABLE" }));
    } finally {
      // A changed execution may complete while the first accounting read is in flight.
      if (lease === generation.current && current.current.key === selected.key && current.current.revision !== activeRequest.revision) void refresh();
    }
  }, [onUnauthorized]);
  useEffect(() => {
    generation.current++;
    if (key) void refresh();
    return () => { generation.current++; };
  }, [key, revision, refresh]);
  const waitUntilIdle = useCallback(async () => {
    while (activeReads.current.size) await Promise.allSettled([...activeReads.current]);
  }, []);
  const visible = view.key === key && key ? view : { key, value: null, stale: false, loading: !!key, error: "" };
  return { ...visible, refresh, waitUntilIdle };
}
