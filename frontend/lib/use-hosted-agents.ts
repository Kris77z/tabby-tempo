"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { hostedRequest, HostedClientError, hostedError, signedLogin, injectedWallet, readPending, savePending, replayInput,
  type HostedSnapshot, type HostedAgent, type HostedRun, type AgentSettings, type PendingCommand, type RunInput } from "./hosted-client";
import { useHostedFinance } from "./use-hosted-finance";

// Mounted once in HostedAgentsProvider so auth queues and transport leases survive
// navigation between the terminal onboarding and dashboard.
export function useHostedAgentsController(enabled: boolean) {
  const enabledRef = useRef(enabled); enabledRef.current = enabled;
  const walletListening = useRef(enabled); if (enabled) walletListening.current = true;
  const listenForWallet = walletListening.current;
  const [snapshot, setSnapshot] = useState<HostedSnapshot | null>(null);
  const [access, setAccess] = useState<"loading" | "signed-out" | "authenticated" | "unavailable">("loading");
  const [owner, setOwner] = useState<string | null>(null), [selectedId, setSelectedId] = useState("");
  const [error, setError] = useState(""), [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false), [refreshing, setRefreshing] = useState(false);
  const [pending, setPending] = useState<PendingCommand | null>(null);
  const readInFlight = useRef(false), mutationInFlight = useRef(false), sessionEpoch = useRef(0), requireLogin = useRef(false);
  const readCompletion = useRef<Promise<void> | null>(null);
  const authCleanup = useRef<Promise<unknown> | null>(null), authLoginCompletion = useRef<Promise<void> | null>(null);
  const sessionActive = useRef(false), loginStage = useRef<"idle" | "connecting" | "signing">("idle");
  const walletVersion = useRef(0), mutationLease = useRef(0);
  function beginMutation() {
    const lease = ++mutationLease.current;
    mutationInFlight.current = true; setBusy(true); setError(""); setNotice("");
    return lease;
  }
  function finishMutation(lease: number) {
    // The transport lock spans invalidation so an old 401 response cannot clear
    // a newer login cookie. Only its owning operation may release this lock.
    if (lease !== mutationLease.current) return;
    mutationInFlight.current = false; setBusy(false);
  }

  const invalidate = useCallback(() => {
    requireLogin.current = true; sessionActive.current = false;
    sessionEpoch.current++; setSnapshot(null); setOwner(null); setSelectedId(""); setPending(null); setNotice(""); setAccess("signed-out");
  }, []);
  // A logout response can clear an HttpOnly cookie. It must follow any already
  // started login, and every later login must wait for this cleanup to settle.
  const queueLogout = useCallback(() => {
    const previous = authCleanup.current, login = authLoginCompletion.current;
    const cleanup = Promise.all([previous?.catch(() => undefined), login]).then(() => hostedRequest("/auth/logout", "POST", {}));
    authCleanup.current = cleanup;
    return cleanup;
  }, []);

  const refresh = useCallback(async () => {
    if (!enabledRef.current || requireLogin.current) return;
    if (readInFlight.current) { await readCompletion.current; return; }
    readInFlight.current = true; setRefreshing(true);
    let completeRead!: () => void;
    readCompletion.current = new Promise<void>(resolve => { completeRead = resolve; });
    const epoch = sessionEpoch.current;
    try {
      const next = await hostedRequest<HostedSnapshot>("/agents");
      if (epoch !== sessionEpoch.current) return;
      sessionActive.current = true; setSnapshot(next); setAccess("authenticated"); setError("");
      if (next.agents[0]) setOwner(next.agents[0].owner);
      setSelectedId(id => next.agents.some(agent => agent.id === id) ? id : next.agents[0]?.id ?? "");
    } catch (cause) {
      if (epoch !== sessionEpoch.current) return;
      if (cause instanceof HostedClientError && cause.status === 401) invalidate();
      else { setAccess(current => current === "authenticated" ? current : "unavailable"); setError(hostedError(cause)); }
    } finally { readInFlight.current = false; readCompletion.current = null; completeRead(); setRefreshing(false); }
  }, [invalidate]);
  useEffect(() => { if (enabled) void refresh(); }, [enabled, refresh]);
  useEffect(() => { setPending(owner ? readPending(owner) : null); }, [owner]);
  useEffect(() => {
    if (!enabled || access !== "authenticated") return;
    const active = snapshot?.agents.some(agent => !!agent.activeRequestId);
    const timer = setInterval(() => { if (!mutationInFlight.current && document.visibilityState === "visible") void refresh(); }, active ? 4_000 : 20_000);
    return () => clearInterval(timer);
  }, [enabled, access, snapshot?.agents, refresh]);

  const logout = useCallback(async () => {
    if (mutationInFlight.current) return;
    const lease = beginMutation(); invalidate();
    const epoch = sessionEpoch.current;
    try { await queueLogout(); }
    catch (cause) { if (epoch === sessionEpoch.current) setError(hostedError(cause)); }
    finally { finishMutation(lease); }
  }, [invalidate, queueLogout]);
  useEffect(() => {
    if (!listenForWallet) return;
    const wallet = injectedWallet();
    if (!wallet?.on) return;
    const changed = () => {
      // Connecting an initially signed-out wallet can itself emit accountsChanged.
      // Capture that selected wallet first; changes after capture invalidate login.
      if (!sessionActive.current && loginStage.current === "connecting") return;
      walletVersion.current++;
      invalidate(); setError("钱包账号或网络已变化，请重新签名登录。");
      const epoch = sessionEpoch.current;
      void queueLogout().catch(() => { if (epoch === sessionEpoch.current) setError("钱包已变化，退出会话尚未确认。请重新签名登录。"); });
    };
    wallet.on("accountsChanged", changed); wallet.on("chainChanged", changed);
    return () => { wallet.removeListener?.("accountsChanged", changed); wallet.removeListener?.("chainChanged", changed); };
  }, [listenForWallet, invalidate, queueLogout]);

  async function login() {
    if (mutationInFlight.current) return;
    const lease = beginMutation(), requestedWalletVersion = walletVersion.current;
    let epoch = sessionEpoch.current;
    const cleanupBeforeLogin = authCleanup.current;
    let completeLogin!: () => void;
    authLoginCompletion.current = new Promise<void>(resolve => { completeLogin = resolve; });
    try {
      await cleanupBeforeLogin?.catch(() => undefined);
      // An earlier 401 read can also clear cookies, so finish it before login.
      await Promise.all([readCompletion.current, finance.waitUntilIdle()]);
      if (requestedWalletVersion !== walletVersion.current) return;
      // Expiry of an earlier cookie is compatible with this explicit new login;
      // a wallet change while waiting is handled by walletVersion above.
      epoch = sessionEpoch.current;
      loginStage.current = "connecting";
      const address = await signedLogin({ isCurrent: () => epoch === sessionEpoch.current, onWalletReady: () => { loginStage.current = "signing"; } });
      if (epoch !== sessionEpoch.current) return;
      requireLogin.current = false; sessionActive.current = true; setSnapshot(null); setOwner(address); setAccess("authenticated");
      await refresh();
      if (epoch === sessionEpoch.current) setNotice("钱包签名登录成功。Agent 的独立钱包由平台托管。");
    } catch (cause) { if (epoch === sessionEpoch.current) setError(hostedError(cause)); }
    finally { loginStage.current = "idle"; authLoginCompletion.current = null; completeLogin(); finishMutation(lease); }
  }
  function persist(command: PendingCommand | null, address: string) {
    savePending(command, address); setPending(command);
  }
  async function command(command: PendingCommand): Promise<boolean> {
    if (mutationInFlight.current) return false;
    const lease = beginMutation();
    const epoch = sessionEpoch.current;
    try {
      persist(command, command.owner);
      const response = await hostedRequest<HostedAgent | HostedRun>(command.kind === "create" ? "/agents" : `/agents/${encodeURIComponent(command.agentId)}/runs`, "POST", command.input);
      // Keep the original owner's hint when a wallet change invalidated the UI.
      // Its accepted UUID is safe to confirm only after that owner signs in again.
      if (epoch !== sessionEpoch.current) return false;
      persist(null, command.owner);
      if (command.kind === "create") {
        const agent = response as HostedAgent;
        setSnapshot(current => current ? { ...current, agents: [...current.agents.filter(item => item.id !== agent.id), agent] } : current);
        setSelectedId(agent.id); setNotice("Agent 已创建，平台正在初始化独立钱包与链上身份。");
      } else {
        const run = response as HostedRun;
        setSnapshot(current => current ? { ...current, runs: [run, ...current.runs.filter(item => item.requestId !== run.requestId)],
          agents: current.agents.map(agent => agent.id === command.agentId ? { ...agent, ...(!["Succeeded", "Failed"].includes(run.status) ? { activeRequestId: run.requestId, reservedRaw: run.reservedRaw } : {}) } : agent) } : current);
        setNotice("请求已确认接收。下方记录会显示服务器返回的运行状态。");
      }
      await refresh(); return epoch === sessionEpoch.current;
    } catch (cause) {
      if (epoch !== sessionEpoch.current) return false;
      // 503/transport failure may hide an accepted POST. Keep the original body and UUID.
      if (cause instanceof HostedClientError && cause.status >= 400 && cause.status < 500 && ![408, 429].includes(cause.status)) persist(null, command.owner);
      setError(cause instanceof Error && !(cause instanceof HostedClientError) ? cause.message : hostedError(cause));
      if (cause instanceof HostedClientError && cause.status === 401) invalidate();
      return false;
    } finally { finishMutation(lease); }
  }
  async function create(settings: AgentSettings) {
    if (!owner || pending) return false;
    return command({ owner, kind: "create", input: { requestId: crypto.randomUUID(), ...settings } });
  }
  async function run(agent: HostedAgent, input: Omit<RunInput, "requestId">) {
    if (pending || busy) return false;
    return command({ owner: agent.owner, kind: "run", agentId: agent.id, input: { requestId: crypto.randomUUID(), ...input } });
  }
  async function recover(run: HostedRun) {
    const agent = snapshot?.agents.find(item => item.id === run.agentId);
    if (!agent || pending) return false;
    return command({ owner: agent.owner, kind: "run", agentId: run.agentId, input: replayInput(run) });
  }
  async function update(agent: HostedAgent, settings: AgentSettings) {
    return mutateAgent(agent, "PATCH", settings, "Agent 设置已保存。");
  }
  async function pause(agent: HostedAgent) {
    return mutateAgent(agent, "POST", { paused: agent.status !== "Paused" }, agent.status === "Paused" ? "Agent 已继续，可以发起新操作。" : "Agent 已暂停，新操作已停止；原请求仍可恢复。", "/pause");
  }
  async function mutateAgent(agent: HostedAgent, method: string, body: unknown, message: string, suffix = "") {
    if (mutationInFlight.current || pending) return false;
    const lease = beginMutation();
    const epoch = sessionEpoch.current;
    try {
      const next = await hostedRequest<HostedAgent>(`/agents/${encodeURIComponent(agent.id)}${suffix}`, method, body);
      if (epoch !== sessionEpoch.current) return false;
      setSnapshot(current => current ? { ...current, agents: current.agents.map(item => item.id === next.id ? next : item) } : current);
      setNotice(message); await refresh(); return epoch === sessionEpoch.current;
    } catch (cause) { if (epoch !== sessionEpoch.current) return false; setError(hostedError(cause)); if (cause instanceof HostedClientError && cause.status === 401) invalidate(); return false; }
    finally { finishMutation(lease); }
  }
  const selected = snapshot?.agents.find(agent => agent.id === selectedId) ?? null;
  const financeRevision = snapshot?.runs.filter(run => run.agentId === selectedId && !["Queued", "Running"].includes(run.status))
    .map(run => `${run.requestId}:${run.status}:${run.updatedAt}`).join("|") ?? "";
  const finance = useHostedFinance(selected, enabled && access === "authenticated", financeRevision, invalidate);
  return { snapshot, selected, selectedId, select: setSelectedId, access, owner, error, notice, busy, refreshing, pending,
    finance, refresh, login, logout, create, run, recover, update, pause, retryPending: () => pending ? command(pending) : Promise.resolve(false) };
}
