import { createHash } from "node:crypto";
import { Contract, JsonRpcApiProvider, getAddress, type Signer } from "ethers";
import { problemCatalog, type ProblemId } from "@agentfuel/arena";
import { InferCredit, ACCOUNT_ABI, PaymentError, canonical, requestDigest, sameAddress, uint,
  type FetchOptions, type Inference, type Json, type PaymentHandle, type RoutingTier } from "@agentfuel/sdk";
import { SessionStore } from "./session.js";

const TASK_ABI = ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"];
const problems = problemCatalog(); // Public specifications only; hiddenTests is never invoked.
export type SelectionCapability = ProblemId | "python3-json-stdio";
export interface SelectionTask {
  taskId: string; problemId: ProblemId; deadlineMs: number; creditLimit: string;
}
export interface SelectionRoute {
  tier: RoutingTier; price: string; capabilities: SelectionCapability[];
}
export interface SelectionProvider {
  id: string; payTo: string; relayUrl: string; service: string; model: string; routes: SelectionRoute[];
}
/** Host-owned allowlists. Never construct this configuration from task text or model output. */
export interface SelectionConfig {
  agentId: string; chainId: string; account: string; asset: string; escrowAddress: string;
  tasks: SelectionTask[]; providers: SelectionProvider[];
  allowCredit: boolean; maxPrice: string; deadlineMs: number; minRemainingMs: number; maxCompletionTokens: number;
}
export interface SelectionSnapshot {
  atMs: number; cash: string; tasks: Array<SelectionTask & { assigned: boolean }>; creditEnabled: boolean;
}
export interface SelectionCandidate {
  taskId: string; problemId: ProblemId; deadlineMs: number; creditLimit: string;
  providerId: string; tier: RoutingTier; price: string; funding: "cash" | "task-credit";
  rejected: Array<"TASK_UNAVAILABLE" | "CAPABILITY" | "DEADLINE" | "PRICE_LIMIT" | "FUNDS">;
}
export interface SelectionDecision {
  snapshot: SelectionSnapshot; snapshotHash: string; candidates: SelectionCandidate[]; selected?: SelectionCandidate;
}
export interface SelectionSession {
  version: 1; config: SelectionConfig; configHash: string; decision: SelectionDecision;
  phase: "Selected" | "Quoted" | "Paused" | "Delivered" | "Stopped";
  reservedPrice: string; handle?: PaymentHandle; inference?: Inference; reason?: string;
}
export interface SelectionOptions {
  signer: Signer; underwriterUrl?: string; timeoutMs?: number; recoverLock?: boolean;
}
const hash = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
function fail(code: string): never { throw new PaymentError(code, code); }
function safeUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) fail("INVALID_SELECTOR_URL");
}
function keys(value: object, allowed: string[]) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) fail("INVALID_SELECTOR_CONFIG");
}
function time(value: number) { if (!Number.isSafeInteger(value) || value < 0) fail("INVALID_SELECTOR_TIME"); }
function validate(config: SelectionConfig) {
  keys(config, ["agentId", "chainId", "account", "asset", "escrowAddress", "tasks", "providers", "allowCredit", "maxPrice", "deadlineMs", "minRemainingMs", "maxCompletionTokens"]);
  if (typeof config.allowCredit !== "boolean") fail("INVALID_SELECTOR_CONFIG");
  for (const name of ["agentId", "chainId", "maxPrice"] as const) if (uint(config[name], name) === 0n) fail("INVALID_SELECTOR_CONFIG");
  for (const address of [config.account, config.asset, config.escrowAddress]) getAddress(address);
  time(config.deadlineMs); time(config.minRemainingMs);
  if (!Number.isSafeInteger(config.maxCompletionTokens) || config.maxCompletionTokens < 1 || config.maxCompletionTokens > 2048) fail("INVALID_SELECTOR_TOKEN_LIMIT");
  if (!Array.isArray(config.tasks) || !Array.isArray(config.providers) || config.tasks.length > 32 || config.providers.length > 16) fail("INVALID_SELECTOR_CONFIG");
  const tasks = new Set<string>(), providers = new Set<string>();
  for (const task of config.tasks) {
    keys(task, ["taskId", "problemId", "deadlineMs", "creditLimit"]);
    if (uint(task.taskId, "taskId") === 0n || tasks.has(task.taskId) || !problems.some(problem => problem.id === task.problemId)) fail("INVALID_SELECTOR_TASK");
    tasks.add(task.taskId); uint(task.creditLimit, "creditLimit"); time(task.deadlineMs);
  }
  for (const provider of config.providers) {
    keys(provider, ["id", "payTo", "relayUrl", "service", "model", "routes"]);
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(provider.id) || providers.has(provider.id) || typeof provider.service !== "string" || !provider.service || typeof provider.model !== "string" || !provider.model) fail("INVALID_SELECTOR_PROVIDER");
    providers.add(provider.id); getAddress(provider.payTo); safeUrl(provider.relayUrl);
    if (!Array.isArray(provider.routes) || provider.routes.length > 2) fail("INVALID_SELECTOR_ROUTE");
    const tiers = new Set<RoutingTier>();
    for (const route of provider.routes) {
      keys(route, ["tier", "price", "capabilities"]);
      if (!["cheap", "strong"].includes(route.tier) || tiers.has(route.tier) || uint(route.price, "price") === 0n || !Array.isArray(route.capabilities) ||
        route.capabilities.some(capability => capability !== "python3-json-stdio" && !problems.some(problem => problem.id === capability))) fail("INVALID_SELECTOR_ROUTE");
      tiers.add(route.tier);
    }
    const cheap = provider.routes.find(route => route.tier === "cheap"), strong = provider.routes.find(route => route.tier === "strong");
    if (cheap && strong && BigInt(cheap.price) >= BigInt(strong.price)) fail("INVALID_SELECTOR_PRICE_ORDER");
  }
}
function order(a: SelectionCandidate, b: SelectionCandidate) {
  const price = BigInt(a.price) - BigInt(b.price), task = BigInt(a.taskId) - BigInt(b.taskId);
  return price < 0n ? -1 : price > 0n ? 1 : a.deadlineMs - b.deadlineMs ||
    (task < 0n ? -1 : task > 0n ? 1 : 0) || (a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0) || (a.tier < b.tier ? -1 : a.tier > b.tier ? 1 : 0);
}
/** Price → nearest deadline → numeric task id → provider id → tier; no text classification. */
export function selectInference(config: SelectionConfig, snapshot: SelectionSnapshot): SelectionDecision {
  validate(config); time(snapshot.atMs); uint(snapshot.cash, "cash");
  if (snapshot.tasks.length !== config.tasks.length || typeof snapshot.creditEnabled !== "boolean") fail("INVALID_SELECTOR_SNAPSHOT");
  const candidates: SelectionCandidate[] = [];
  for (const task of config.tasks) {
    const observed = snapshot.tasks.find(value => value.taskId === task.taskId);
    if (!observed || typeof observed.assigned !== "boolean" || hash({ taskId: observed.taskId, problemId: observed.problemId, deadlineMs: observed.deadlineMs, creditLimit: observed.creditLimit }) !== hash(task)) fail("INVALID_SELECTOR_SNAPSHOT");
    for (const provider of config.providers) for (const route of provider.routes) {
      const rejected: SelectionCandidate["rejected"] = [], cash = BigInt(snapshot.cash), price = BigInt(route.price);
      if (!observed.assigned) rejected.push("TASK_UNAVAILABLE");
      if (!route.capabilities.includes("python3-json-stdio") || !route.capabilities.includes(task.problemId)) rejected.push("CAPABILITY");
      if (Math.min(task.deadlineMs, config.deadlineMs) - snapshot.atMs <= config.minRemainingMs) rejected.push("DEADLINE");
      if (price > BigInt(config.maxPrice)) rejected.push("PRICE_LIMIT");
      if (price > cash + (config.allowCredit && snapshot.creditEnabled ? BigInt(task.creditLimit) : 0n)) rejected.push("FUNDS");
      candidates.push({ ...task, providerId: provider.id, tier: route.tier, price: route.price, funding: price <= cash ? "cash" : "task-credit", rejected });
    }
  }
  candidates.sort(order);
  return { snapshot: structuredClone(snapshot), snapshotHash: hash({ configHash: hash(config), snapshot }), candidates, selected: candidates.find(candidate => candidate.rejected.length === 0) };
}
function body(config: SelectionConfig, selected: SelectionCandidate, provider: SelectionProvider): FetchOptions["body"] {
  return { service: provider.service, model: provider.model, tier: selected.tier, max_completion_tokens: config.maxCompletionTokens,
    messages: [{ role: "system", content: "Return Python 3.12 source code for the public programming specification. No tools or wallet actions." },
      { role: "user", content: problems.find(problem => problem.id === selected.problemId)!.prompt }] };
}

/** One actual SDK purchase selected before payment; never accepts tasks, executes code or settles. */
export async function runSelectedInference(directory: string, config: SelectionConfig, options: SelectionOptions): Promise<SelectionSession> {
  config = structuredClone(config); // Caller mutations cannot change an in-flight trusted decision.
  validate(config);
  const rpc = options.signer.provider;
  if (!(rpc instanceof JsonRpcApiProvider)) fail("SELECTOR_RPC_SIGNER_REQUIRED");
  const store = new SessionStore<SelectionSession>(directory);
  const account = new Contract(config.account, ACCOUNT_ABI, rpc), escrow = new Contract(config.escrowAddress, TASK_ABI, rpc);
  await store.start(options.recoverLock);
  let infer: InferCredit | undefined;
  try {
    let session = await store.read();
    if (session) {
      if (session.version !== 1 || session.configHash !== hash(config) || hash(session.config) !== session.configHash ||
        hash(selectInference(config, session.decision.snapshot)) !== hash(session.decision)) fail("SELECTION_BINDING_CHANGED");
      if (session.phase === "Delivered" || session.phase === "Stopped") return session;
    } else {
      if (BigInt(await rpc.send("eth_chainId", [])) !== BigInt(config.chainId)) fail("NETWORK_MISMATCH");
      const [cash, tasks] = await Promise.all([account.getFunction("cash").staticCall(config.agentId), Promise.all(config.tasks.map(async task => {
        const current = await escrow.getFunction("getTask").staticCall(task.taskId);
        return { ...task, assigned: current.status === 2n && current.agentId === BigInt(config.agentId) && current.deadline * 1000n === BigInt(task.deadlineMs) };
      }))]);
      const snapshot: SelectionSnapshot = { atMs: Date.now(), cash: String(cash), tasks, creditEnabled: Boolean(options.underwriterUrl) };
      const decision = selectInference(config, snapshot);
      session = { version: 1, config: structuredClone(config), configHash: hash(config), decision, phase: decision.selected ? "Selected" : "Stopped", reservedPrice: "0",
        ...(!decision.selected ? { reason: "NO_FEASIBLE_CANDIDATE" } : {}) };
      await store.write(session); // No quote or payment can occur before this decision is durable.
    }
    const selected = session.decision.selected;
    if (!selected) return session;
    const provider = config.providers.find(value => value.id === selected.providerId)!;
    const input = body(config, selected, provider), paymentTaskId = selected.funding === "cash" ? "0" : selected.taskId;
    const checkHandle = (handle: PaymentHandle) => {
      if (handle.relayUrl !== provider.relayUrl || handle.quote.price !== selected.price ||
        handle.quote.taskId !== paymentTaskId || handle.input.taskId !== paymentTaskId || handle.quote.tier !== selected.tier ||
        requestDigest(handle.input) !== requestDigest({ ...input, taskId: paymentTaskId, agentId: config.agentId }) ||
        (session!.handle && (handle.quote.paymentId !== session!.handle.quote.paymentId || handle.creditNonce !== session!.handle.creditNonce))) fail("SELECTION_QUOTE_CHANGED");
    };
    const guard = async (handle: PaymentHandle) => {
      checkHandle(handle);
      if (Date.now() + config.minRemainingMs >= Math.min(config.deadlineMs, selected.deadlineMs)) fail("SELECTION_DEADLINE");
      const [cash, task] = await Promise.all([account.getFunction("cash").staticCall(config.agentId), escrow.getFunction("getTask").staticCall(selected.taskId)]);
      if (task.status !== 2n || task.agentId !== BigInt(config.agentId) || task.deadline * 1000n !== BigInt(selected.deadlineMs)) fail("SELECTION_TASK_CHANGED");
      if (BigInt(selected.price) > cash + (selected.funding === "task-credit" ? BigInt(selected.creditLimit) : 0n)) fail("SELECTION_FUNDS_CHANGED");
      if (Date.now() + config.minRemainingMs >= Math.min(config.deadlineMs, selected.deadlineMs)) fail("SELECTION_DEADLINE");
    };
    if (session.handle) checkHandle(session.handle);
    // Expired sessions may return a saved result, but cannot authorize a dispatch or signed replay.
    if (Date.now() + config.minRemainingMs >= Math.min(config.deadlineMs, selected.deadlineMs)) {
      session.phase = session.handle ? "Paused" : "Stopped"; session.reason = "SELECTION_DEADLINE"; await store.write(session); return session;
    }
    infer = new InferCredit({ agentId: config.agentId, chainId: BigInt(config.chainId), account: config.account, asset: config.asset,
      provider: provider.payTo, signer: options.signer, maxPrice: BigInt(selected.price),
      underwriterUrl: selected.funding === "task-credit" ? options.underwriterUrl : undefined, timeoutMs: options.timeoutMs,
      onHandle: async handle => { checkHandle(handle); session!.handle = handle; session!.reservedPrice = selected.price; session!.phase = "Quoted"; await store.write(session!); },
      beforePayment: guard });
    try {
      const inference = session.handle ? await infer.resume(session.handle) : selected.funding === "cash" ?
        await infer.fetch(provider.relayUrl, { body: input }) : await infer.forTask(selected.taskId).fetch(provider.relayUrl, { body: input });
      checkHandle(inference.handle);
      const receipt = inference.receipt, quote = inference.handle.quote;
      if (receipt.paymentId !== quote.paymentId || receipt.requestDigest !== quote.requestDigest || receipt.price !== selected.price || receipt.tier !== selected.tier ||
        receipt.taskId !== paymentTaskId || receipt.agentId !== config.agentId || receipt.chainId !== config.chainId || receipt.service !== provider.service ||
        !sameAddress(receipt.payTo, provider.payTo) || !sameAddress(receipt.account, config.account) || !sameAddress(receipt.asset, config.asset) ||
        uint(receipt.fromCash, "fromCash") + uint(receipt.fromCredit, "fromCredit") !== BigInt(selected.price) ||
        BigInt(receipt.fromCredit) > (selected.funding === "task-credit" ? BigInt(selected.creditLimit) : 0n)) fail("SELECTION_RECEIPT_MISMATCH");
      session.inference = inference; session.handle = inference.handle; session.phase = "Delivered"; delete session.reason; await store.write(session);
    } catch (error) {
      if (error instanceof PaymentError && error.handle) { checkHandle(error.handle as PaymentHandle); session.handle = error.handle as PaymentHandle; }
      session.reason = error instanceof PaymentError ? error.code : "SELECTION_STORAGE_OR_TRANSPORT_ERROR";
      const terminal = ["SELECTION_QUOTE_CHANGED", "SELECTION_FUNDS_CHANGED", "SELECTION_TASK_CHANGED", "PAYMENT_REVERTED", "REFUNDED", "UNTRUSTED_QUOTE", "SELECTION_RECEIPT_MISMATCH"];
      session.phase = terminal.includes(session.reason) ? "Stopped" : session.handle ? "Paused" : "Stopped";
      await store.write(session);
    }
    return session;
  } finally { infer?.close(); await store.close(); }
}
