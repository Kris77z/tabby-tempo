import { test, expect, type Page, type Route } from "@playwright/test";
import { Wallet, getBytes, toUtf8String, verifyMessage } from "ethers";
import type { AgentSettings, HostedAgent, HostedRun, HostedCapabilities, HostedSponsorship } from "../../../services/hosted-agents/src/types";

// Synthetic browser acceptance only. Every API path is intercepted before navigation;
// there is no route.continue/fetch, provider connection, or transaction broadcasting.
export const owner = new Wallet(`0x${"1".repeat(64)}`);
export const agentId = "hosted-synthetic-agent";
export const wallet = `0x${"2".repeat(40)}`;
export const time = "2026-10-10T00:00:00.000Z";
export const models = [{ id: "kimi-k2.6", label: "Kimi K2.6" }, { id: "synthetic-model", label: "Synthetic Model" }];
export const settings: AgentSettings = {
  name: "合成托管 Agent", modelId: "kimi-k2.6", strategy: "balanced",
  perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true,
};
export const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
export const makeAgent = (values: Partial<HostedAgent> = {}): HostedAgent => ({
  ...settings, id: agentId, owner: owner.address, wallet, createdAt: time, updatedAt: time,
  status: "Ready", spentRaw: "25000", reservedRaw: "0",
  binding: { chainId: "31337", agentId: "1999", wallet }, ...values,
});
export const makeRun = (values: Partial<HostedRun> = {}): HostedRun => ({
  requestId: "11111111-1111-4111-8111-111111111111", agentId, action: "task",
  status: "Succeeded", createdAt: time, updatedAt: time, reservedRaw: "0", chargedRaw: "25000",
  recoverable: false, result: { phase: "Complete", terminal: true, success: true, chargedRaw: "25000" }, ...values,
});
export type Command = { method: string; path: string; body: Record<string, unknown> };
export type RpcCall = { method: string; params?: unknown[] };
export type HarnessOptions = {
  origin?:string;sponsorship?:HostedSponsorship; chainId?: string; walletChainId?: string; capabilities?: HostedCapabilities; authenticated?: boolean; agents?: HostedAgent[]; runs?: HostedRun[];
  error?: { status: number; code: string }; firstRunFailure?: "abort" | "503"; logoutStatus?: 401;
  beforeWrite?: (command: Command) => Promise<void>;
  connectEvent?: boolean; firstCreateFailure?: "503"; createAtEnd?: boolean;
};
export const unexpectedByPage = new WeakMap<Page, string[]>();

export async function syntheticHosted(page: Page, options: HarnessOptions = {}) {
  const origin=options.origin??String(test.info().project.use.baseURL??"http://127.0.0.1:3014");
  const chainId = options.chainId ?? "31337", walletChainId = options.walletChainId ?? chainId;
  let activeOwner = owner, authenticatedOwner = owner.address;
  const commands: Command[] = [], rpcCalls: RpcCall[] = [], signed: { wallet: string; message: string }[] = [];
  const unexpected: string[] = [];
  unexpectedByPage.set(page, unexpected);
  let authenticated = options.authenticated ?? true;
  let agents = options.agents ?? [makeAgent()];
  let runAttempts = 0;
  const runs = [...(options.runs ?? [])];
  const creations = new Map<string, HostedAgent>();
  const challengeId = "synthetic-auth-challenge", expiresAt = Date.now() + 300_000;
  const challenge = {
    id: challengeId,
    message: `AgentFuel hosted agent login\nOrigin: ${origin}\nWallet: ${owner.address}\nChain: ${chainId}\nNonce: ${challengeId}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature authenticates your platform account. It authorizes no blockchain transaction.`,
    expiresAt,
  };
  await page.exposeFunction("__hostedSyntheticWallet", async (call: RpcCall) => {
    rpcCalls.push(call);
    if (["eth_requestAccounts", "eth_accounts"].includes(call.method)) return [activeOwner.address];
    if (call.method === "eth_chainId") return `0x${BigInt(walletChainId).toString(16)}`;
    if (call.method === "personal_sign") {
      const [encoded, address] = call.params ?? [];
      expect(typeof encoded).toBe("string");
      expect(String(address).toLowerCase()).toBe(activeOwner.address.toLowerCase());
      const message = String(encoded).startsWith("0x") ? toUtf8String(getBytes(String(encoded))) : String(encoded);
      signed.push({ wallet: String(address), message });
      return activeOwner.signMessage(message);
    }
    unexpected.push(`wallet RPC: ${call.method}`);
    throw new Error(`Synthetic wallet rejects ${call.method}; no transactions are permitted.`);
  });
  await page.addInitScript(({ connectEvent }) => {
    const scope = window as unknown as Window & {
      __hostedSyntheticWallet: (call: { method: string; params?: unknown[] }) => Promise<unknown>;
    };
    const listeners = new Map<string, Set<(...args: unknown[]) => void>>();
    const events: { event: string; payload: unknown }[] = [];
    const emit = (event: string, payload: unknown) => {
      events.push({ event, payload });
      for (const listener of [...(listeners.get(event) ?? [])]) listener(payload);
    };
    let announced = false;
    Object.defineProperty(window, "ethereum", {
      configurable: true,
      value: {
        isMetaMask: true,
        request: async (call: { method: string; params?: unknown[] }) => {
          const result = await scope.__hostedSyntheticWallet(call);
          if (connectEvent && !announced && call.method === "eth_requestAccounts") {
            announced = true; emit("accountsChanged", result);
          }
          return result;
        },
        on: (event: string, listener: (...args: unknown[]) => void) => {
          const registered = listeners.get(event) ?? new Set();
          registered.add(listener); listeners.set(event, registered);
        },
        removeListener: (event: string, listener: (...args: unknown[]) => void) => {
          listeners.get(event)?.delete(listener);
        },
        __emit: emit,
        __events: events,
      },
    });
  }, { connectEvent: options.connectEvent ?? false });
  const fulfill = (route: Route, json: unknown, status = 200) => route.fulfill({ status, json, headers: { "cache-control": "private, no-store" } });
  await page.route("**/api/**", async route => {
    const request = route.request(), url = new URL(request.url());
    const method = request.method(), path = url.pathname;
    const body = request.postData() ? request.postDataJSON() as Record<string, unknown> : {};
    commands.push({ method, path, body });
    expect(url.origin).toBe(origin);
    expect(url.search).toBe("");
    expect(request.headers()["authorization"]).toBeUndefined();
    if(path==="/api/arena/play"&&method==="GET"&&!url.search)return fulfill(route,{matches:[],history:[],bot:{name:"Synthetic Bot",description:"Controlled local practice only"},storage:"synthetic"});
    if (!path.startsWith("/api/hosted/")) {
      unexpected.push(`${method} ${path}`);
      return fulfill(route, { error: "SYNTHETIC_API_BLOCKED" }, 503);
    }
    if (options.error) return fulfill(route, { error: options.error.code }, options.error.status);
    const publicAuth = ["/api/hosted/auth/challenge", "/api/hosted/auth/login"].includes(path);
    // Authenticate at admission. An already-accepted write can finish after logout;
    // delaying its response must not turn it into a synthetic 401 instead.
    if (!publicAuth && !authenticated) return fulfill(route, { error: "HOSTED_AUTH_REQUIRED" }, 401);
    if (method !== "GET") await options.beforeWrite?.({ method, path, body });
    if (path === "/api/hosted/auth/challenge" && method === "POST") {
      challenge.message = challenge.message.replace(/^Wallet: .*$/m, `Wallet: ${activeOwner.address}`);
      return fulfill(route, challenge);
    }
    if (path === "/api/hosted/auth/login" && method === "POST") {
      expect(body.challengeId).toBe(challenge.id);
      expect(verifyMessage(challenge.message, String(body.signature))).toBe(activeOwner.address);
      authenticated = true; authenticatedOwner = activeOwner.address;
      return fulfill(route, { authenticated: true, expiresAt: challenge.expiresAt });
    }
    if (path === "/api/hosted/auth/logout" && method === "POST") {
      authenticated = false;
      if (options.logoutStatus) return fulfill(route, { error: "HOSTED_AUTH_REQUIRED" }, options.logoutStatus);
      return fulfill(route, { authenticated: false });
    }
    if (path === "/api/hosted/agents" && method === "GET") return fulfill(route, { sponsorship:options.sponsorship??{used:0,limit:3,remaining:3,globalLimit:100}, agents: agents.filter(agent => agent.owner === authenticatedOwner), runs, models, ...(options.capabilities ? { capabilities: options.capabilities } : {}) });
    if (/^\/api\/hosted\/agents\/[a-zA-Z0-9_-]+\/finance$/.test(path) && method === "GET") return fulfill(route, { status: "unavailable", observedAt: time, reason: "HOSTED_FINANCE_NOT_CONFIGURED" });
    if (path === "/api/hosted/agents" && method === "POST") {
      const previous = creations.get(String(body.requestId));
      if (previous) return fulfill(route, previous, 202);
      const { requestId, ...publicSettings } = body;
      const deferred=Object.keys(publicSettings).length===1;
      const agent = makeAgent({ ...publicSettings, ...(deferred?{configurationRequired:true,modelId:"",perRunBudgetRaw:"0",totalBudgetRaw:"0",allowCredit:false}:{}), owner: authenticatedOwner, binding: { chainId, agentId: "1999", wallet } } as unknown as Partial<HostedAgent>);
      creations.set(String(requestId), agent);
      agents = options.createAtEnd ? [...agents, agent] : [agent, ...agents];
      if (options.firstCreateFailure) return fulfill(route, { error: "HOSTED_UNAVAILABLE" }, 503);
      return fulfill(route, agent, 202);
    }
    const targetMatch = /^\/api\/hosted\/agents\/([a-zA-Z0-9_-]+)(?:\/(pause|runs|cancel))?$/.exec(path);
    const target = agents.find(agent => agent.id === targetMatch?.[1]);
    if (target && !targetMatch?.[2] && method === "PATCH") {
      const agent = makeAgent({ ...target, ...body, ...(target.configurationRequired ? { configurationRequired: false } : {}) });
      agents = agents.map(value => value.id === target.id ? agent : value);
      return fulfill(route, agent);
    }
    if (target && targetMatch?.[2] === "pause" && method === "POST") {
      const agent = makeAgent({ ...target, status: body.paused ? "Paused" : "Ready" });
      agents = agents.map(value => value.id === target.id ? agent : value);
      return fulfill(route, agent);
    }
    if (target && targetMatch?.[2] === "cancel" && method === "POST") {
      const index = runs.findIndex(run => run.agentId === target.id && run.requestId === body.requestId && run.action === "goal");
      if (index < 0) return fulfill(route, { error: "HOSTED_GOAL_NOT_FOUND" }, 404);
      const current = runs[index], mission = { ...(current.mission ?? { phases: [], calls: [] }), stage: "cancelled" as const };
      const run: HostedRun = { ...current, stopRequested: true, status: "Failed", recoverable: false, reason: "HOSTED_GOAL_CANCELLED", mission,
        result: { phase: "Cancelled", terminal: true, success: false, chargedRaw: current.chargedRaw, mission } };
      runs[index] = run; agents = agents.map(agent => agent.id === target.id ? { ...agent, activeRequestId: undefined, reservedRaw: "0" } : agent);
      return fulfill(route, run, 202);
    }
    if (target && targetMatch?.[2] === "runs" && method === "POST") {
      runAttempts++;
      if (runAttempts === 1 && options.firstRunFailure === "abort") return route.abort("failed");
      if (runAttempts === 1 && options.firstRunFailure === "503") return fulfill(route, { error: "HOSTED_UNAVAILABLE" }, 503);
      const previous = runs.find(run => run.requestId === body.requestId);
      const chargedRaw = ["game", "deposit", "credits"].includes(String(body.action)) ? "0" : "25000";
      const mission = body.action === "goal" ? { stage: "completed" as const, phases: [{ name: "合成测试阶段", taskType: "writer", goal: String(body.goal), output: "Synthetic test artifact — no real inference." }],
        answer: "Synthetic test artifact — no real inference.", review: { passed: true, summary: "Synthetic review", checks: ["Fixture only"] }, calls: [] } : undefined;
      const run = makeRun({ ...previous, ...body, agentId: target.id, status: "Succeeded", recoverable: false, chargedRaw, reason: undefined, ...(mission ? { mission } : {}),
        result: { phase: "Complete", terminal: true, success: true, chargedRaw, ...(mission ? { mission } : {}),
          ...(body.action === "task" ? { taskId: `synthetic-task-${target.id}` } : {}),
          ...(body.action === "game" ? { matchId: `synthetic-match-${target.id}`, ...(body.rewardKind === "llm-credits" ? { creditsGranted: 4096 } : { rewardRaw: "50000" }) } : {}),
          ...(body.action === "credits" ? { creditsUsed: 512 } : {}),
          ...(body.action === "deposit" ? { cashRaw: String(body.amountRaw) } : {}),
        } } as Partial<HostedRun>);
      const index = runs.findIndex(value => value.requestId === run.requestId);
      if (index < 0) runs.unshift(run); else runs[index] = run;
      return fulfill(route, run, 202);
    }
    unexpected.push(`${method} ${path}`);
    return fulfill(route, { error: "SYNTHETIC_API_BLOCKED" }, 503);
  });
  return { commands, rpcCalls, signed, challenge, useOwner: (value: Wallet) => { activeOwner = value; }, expireSession: () => { authenticated = false; } };
}
