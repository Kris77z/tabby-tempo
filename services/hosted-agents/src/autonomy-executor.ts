import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { getAddress, Wallet, JsonRpcProvider, Contract, keccak256, toUtf8Bytes } from "ethers";
import { InferCredit, ACCOUNT_ABI, MANAGER_ABI, accountInterface, managerInterface, requestDigest, paymentId, canonical, type Inference, type Json, type PaymentHandle } from "@agentfuel/sdk";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { confirmPaidDelivery } from "@agentfuel/pi-loop/fixed-task";
import { createAutonomyDecisionPrompt, parseAutonomyDecision, runAutonomy, type AutonomyState, type AutonomyConfig, type AutonomyContext, type AutonomyLimits, type AutonomyDecisionRecovery } from "../../../packages/pi-loop/src/autonomy.js";
import { taskLoopbackUrl, taskPrivateFile } from "../../../packages/pi-loop/src/task-runner/config.js";
import { chainRpcProvider, type RpcTransport } from "../../../scripts/demo-rpc.js";
import type { HostedTaskExecutor, HostedTaskExecutorConfig } from "./task-executor.js";
import type { HostedGameExecutor } from "./game-executor.js";
import { HostedError, type HostedExecution, type HostedExecutor, type HostedResult, type HostedFinance } from "./types.js";

export interface HostedAutonomyConfig {
  maxTasks: number; maxDecisions: number; durationMs: number;
  plannerRelayUrl: string; plannerProvider: string; plannerPriceRaw: string; plannerService: string; plannerModel: string; plannerPhysicalModel: string; plannerResponseModel?: string;
  games?: { maxGames: number; maxSpendPerGameRaw: string; rewardKinds: ("usdc" | "llm-credits")[]; rewardTaskMinTokens: number };
}
export interface HostedAutonomyDependencies {
  provider?: JsonRpcProvider;
  /** Test/trusted transport override. Production uses the paid, cash-only SDK planner below. */
  planner?(context: AutonomyContext, decisionId: string, limits: AutonomyLimits, input: HostedExecution): Promise<{ decision: unknown; chargedRaw: string }>;
  cachedPlanner?(context: AutonomyContext, decisionId: string, limits: AutonomyLimits, input: HostedExecution): Promise<{ decision: unknown; chargedRaw: string }>;
  recoverPlanner?(context: AutonomyContext, decisionId: string, limits: AutonomyLimits, input: HostedExecution): Promise<AutonomyDecisionRecovery>;
  now?: () => number;
  shouldContinue?: (agentId: string) => Promise<boolean>;
  /** Same identity-bound real game executor used by the manual play path. */
  games?: Pick<HostedGameExecutor, "execute" | "rewardBalance">;
  /** Persist owner/global sponsor admission for each original game child before any model or chain call. */
  admitGame?(parent: HostedExecution, child: HostedExecution): Promise<void>;
}
interface Snapshot {
  version: 1; config: HostedAutonomyConfig; input: HostedExecution; controller: AutonomyConfig; children: Record<string, HostedExecution>;
}
interface PlannerState { version: 1; context: AutonomyContext; handle?: PaymentHandle; inference?: Inference; recovery?: AutonomyDecisionRecovery }
type TaskAdapter = Pick<HostedTaskExecutor, "config" | "finance" | "execute">;
const min = (...values: bigint[]) => values.reduce((a, b) => a < b ? a : b);
function invalid(code: string): never { throw new HostedError(code, 503); }
export function validateHostedAutonomyConfig(config: HostedAutonomyConfig): HostedAutonomyConfig {
  if (!config || Object.keys(config).some(key => !["maxTasks", "maxDecisions", "durationMs", "plannerRelayUrl", "plannerProvider", "plannerPriceRaw", "plannerService", "plannerModel", "plannerPhysicalModel", "plannerResponseModel", "games"].includes(key))
    || !Number.isSafeInteger(config.maxTasks) || config.maxTasks < 1 || config.maxTasks > 20
    || !Number.isSafeInteger(config.maxDecisions) || config.maxDecisions < 1 || config.maxDecisions > 40
    || !Number.isSafeInteger(config.durationMs) || config.durationMs < 1000 || config.durationMs > 3600000
    || !/^[1-9][0-9]{0,77}$/.test(config.plannerPriceRaw)
    || (config.plannerResponseModel !== undefined && (typeof config.plannerResponseModel !== "string" || !/^[a-zA-Z0-9_./:-]{1,120}$/.test(config.plannerResponseModel)))
    || [config.plannerService, config.plannerModel, config.plannerPhysicalModel].some(model => typeof model !== "string" || !/^[a-zA-Z0-9_./:-]{1,120}$/.test(model))) invalid("HOSTED_AUTONOMY_CONFIG_INVALID");
  taskLoopbackUrl(config.plannerRelayUrl); getAddress(config.plannerProvider);
  if (config.games) {
    const games = config.games;
    if (Object.keys(games).some(key => !["maxGames", "maxSpendPerGameRaw", "rewardKinds", "rewardTaskMinTokens"].includes(key))
      || !Number.isSafeInteger(games.maxGames) || games.maxGames < 1 || games.maxGames > 20
      || typeof games.maxSpendPerGameRaw !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(games.maxSpendPerGameRaw)
      || !Number.isSafeInteger(games.rewardTaskMinTokens) || games.rewardTaskMinTokens < 1 || games.rewardTaskMinTokens > 100000
      || !Array.isArray(games.rewardKinds) || !games.rewardKinds.length || games.rewardKinds.length > 2
      || games.rewardKinds.some(kind => !["usdc", "llm-credits"].includes(kind)) || new Set(games.rewardKinds).size !== games.rewardKinds.length) invalid("HOSTED_AUTONOMY_CONFIG_INVALID");
  }
  return structuredClone(config);
}

export function createHostedPlannerRequest(config: HostedAutonomyConfig, context: AutonomyContext) {
  return { service: config.plannerService, model: config.plannerModel, messages: createAutonomyDecisionPrompt(context) as unknown as Json[],
    max_completion_tokens: 512, thinking: { type: "disabled" } };
}

/** Local development discovers Anvil's chain; remote transports bind the configured testnet. */
export async function openHostedPlannerConnection(rpcUrl: string, chainId: string, transport: RpcTransport): Promise<{ provider: JsonRpcProvider; close(): void }> {
  if (chainId === "31337" && transport === "direct") {
    const provider = new JsonRpcProvider(rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100, batchMaxCount: 1 });
    return { provider, close: () => provider.destroy() };
  }
  if (chainId === "10143" || chainId === "42431") return chainRpcProvider(rpcUrl, chainId, transport);
  return invalid("HOSTED_PLANNER_NETWORK_INVALID");
}

/** Count executable catalog entries at the finance reader's canonical block.
 * A failed or inconsistent read throws; it can never establish an empty queue. */
export async function readHostedAvailableTasks(config: HostedTaskExecutorConfig, input: HostedExecution, finance: Extract<HostedFinance, { status: "confirmed" }>,
  provider: JsonRpcProvider, deadlineMs: number, nowMs: number): Promise<number> {
  const binding = input.agent.binding, plans = config.models.map(model => model.templates[input.agent.strategy]), first = plans[0];
  if (!binding || !first || finance.chainId !== binding.chainId || finance.agentId !== binding.agentId
    || getAddress(finance.wallet) !== getAddress(binding.wallet) || getAddress(input.agent.wallet) !== getAddress(binding.wallet)
    || plans.some(plan => plan.chainId !== binding.chainId || getAddress(plan.account) !== getAddress(first.account)
      || getAddress(plan.escrowAddress) !== getAddress(first.escrowAddress))) invalid("HOSTED_AUTONOMY_TASK_CATALOG_UNCONFIRMED");
  const block = await provider.getBlock(finance.block.number);
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(binding.chainId) || block?.hash !== finance.block.hash
    || block.timestamp !== finance.block.timestamp) invalid("HOSTED_AUTONOMY_TASK_CATALOG_UNCONFIRMED");
  const at = (contract: Contract, method: string, args: unknown[] = []) => contract.getFunction(method).staticCall(...args, { blockTag: block!.number });
  const account = new Contract(first.account, ACCOUNT_ABI, provider);
  const manager = new Contract(await at(account, "creditManager"), [...MANAGER_ABI, "function taskEscrow() view returns(address)"], provider);
  if (getAddress(await at(manager, "agentAccount")) !== getAddress(first.account)
    || getAddress(await at(manager, "taskEscrow")) !== getAddress(first.escrowAddress)) invalid("HOSTED_AUTONOMY_TASK_CATALOG_UNCONFIRMED");
  const escrow = new Contract(first.escrowAddress, ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], provider);
  const ids = [...new Set(plans.flatMap(plan => plan.tasks.map(task => task.taskId)))];
  let available = 0;
  for (const id of ids) {
    const [task, loan] = await Promise.all([at(escrow, "getTask", [id]), at(manager, "getLoan", [id])]);
    const entries = plans.flatMap(plan => plan.tasks.filter(entry => entry.taskId === id).map(entry => ({ plan, entry })));
    if (task.status < 0n || task.status > 5n || loan.status < 0n || loan.status > 4n
      || loan.status !== 0n && loan.agentId !== task.agentId || entries.some(({ entry }) => BigInt(entry.deadlineMs) !== task.deadline * 1000n)) invalid("HOSTED_AUTONOMY_TASK_CATALOG_UNCONFIRMED");
    const assigned = task.status === 1n && task.agentId === 0n || task.status === 2n && task.agentId === BigInt(binding.agentId);
    if (assigned && loan.status === 0n && task.reward > 0n && task.escrowBalance > 0n
      && entries.some(({ plan, entry }) => Math.min(entry.deadlineMs, plan.deadlineMs, deadlineMs) > Math.max(nowMs, block!.timestamp * 1000) + plan.minRemainingMs
        && plan.providers.some(provider => provider.routes.some(route => route.capabilities.includes("python3-json-stdio") && route.capabilities.includes(entry.problemId))))) available++;
  }
  if ((await provider.getBlock(block!.number))?.hash !== block!.hash || BigInt(await provider.send("eth_chainId", [])) !== BigInt(binding.chainId)) invalid("HOSTED_AUTONOMY_TASK_CATALOG_UNCONFIRMED");
  return available;
}

/** Read-only: canonical payment/refund evidence plus an explicit operator acceptance of unknown vendor cost.
 * Neither a 503 nor a refund alone establishes that an uncertain planner can be replaced. */
export async function reconcileHostedPlannerPayment(handle: PaymentHandle, expected: {
  config: HostedAutonomyConfig; context: AutonomyContext; chainId: string; account: string; asset: string; agentId: string; wallet: string;
}, provider: JsonRpcProvider, readStatus: typeof fetch = fetch): Promise<AutonomyDecisionRecovery> {
  const quote = handle.quote, config = expected.config, same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
  const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/.test(v);
  if (handle.version !== 1 || handle.relayUrl !== config.plannerRelayUrl || quote.chainId !== expected.chainId || !same(quote.account, expected.account)
    || !same(quote.asset, expected.asset) || !same(quote.payTo, config.plannerProvider) || quote.agentId !== expected.agentId || quote.taskId !== "0"
    || quote.service !== config.plannerService || quote.model !== config.plannerModel || quote.price !== config.plannerPriceRaw
    || quote.requestDigest !== requestDigest(handle.input) || quote.paymentId !== paymentId("0", quote.requestDigest, quote.serverNonce)
    || !isDeepStrictEqual(handle.input, { ...createHostedPlannerRequest(config, expected.context), agentId: expected.agentId, taskId: "0" })) invalid("HOSTED_PLANNER_BINDING_CHANGED");
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(expected.chainId)) invalid("HOSTED_PLANNER_NETWORK_INVALID");
  if (!handle.submission?.txHash) return { status: "unknown", chargedRaw: "0", refundedRaw: "0" };
  const account = new Contract(expected.account, ACCOUNT_ABI, provider), txHash = handle.submission.txHash;
  const block = await provider.getBlock("latest"); if (!block?.hash) invalid("HOSTED_PLANNER_PAYMENT_UNCONFIRMED");
  const [payment, transaction, receipt] = await Promise.all([account.getFunction("getPayment").staticCall(quote.paymentId, { blockTag: block.number }),
    provider.getTransaction(txHash), provider.getTransactionReceipt(txHash)]);
  if (!receipt || receipt.status !== 1) return { status: "unknown", chargedRaw: "0", refundedRaw: "0" };
  const paidBlock = await provider.getBlock(receipt.blockNumber), call = transaction && accountInterface.parseTransaction({ data: transaction.data, value: transaction.value });
  const events = receipt.logs.filter(log => same(log.address, expected.account)).flatMap(log => { try { const event = accountInterface.parseLog(log); return event?.name === "ProviderPaid" ? [event] : []; } catch { return []; } });
  if (!transaction?.to || !same(transaction.to, expected.account) || !same(transaction.from, expected.wallet) || transaction.nonce !== handle.submission.nonce
    || !same(handle.submission.from, expected.wallet) || receipt.hash !== txHash || paidBlock?.hash !== receipt.blockHash || receipt.blockNumber > block.number
    || payment.agentId !== BigInt(expected.agentId) || payment.taskId !== 0n || payment.fromCash !== BigInt(quote.price) || payment.fromCredit !== 0n || payment.refundedAmount > payment.fromCash
    || !call || call.name !== "payProvider" || call.args[0] !== BigInt(expected.agentId) || !same(call.args[1], config.plannerProvider) || call.args[2] !== BigInt(quote.price) || call.args[3] !== quote.paymentId
    || events.length !== 1 || events[0].args.paymentId !== quote.paymentId || events[0].args.agentId !== BigInt(expected.agentId) || !same(events[0].args.provider, config.plannerProvider)
    || events[0].args.fromCash !== payment.fromCash || events[0].args.fromCredit !== 0n) invalid("HOSTED_PLANNER_PAYMENT_UNCONFIRMED");
  const paid: AutonomyDecisionRecovery = { status: "unknown", chargedRaw: quote.price, refundedRaw: "0" };
  if ((await provider.getBlock(block.number))?.hash !== block.hash) invalid("HOSTED_PLANNER_PAYMENT_UNCONFIRMED");
  // Account for the known charge even if the relay is temporarily unavailable.
  try {
    const url = new URL(handle.relayUrl); url.pathname = `/payments/${quote.paymentId}`;
    url.search = new URLSearchParams({ agentId: expected.agentId, requestDigest: quote.requestDigest }).toString();
    const response = await readStatus(url.href, { method: "GET", signal: AbortSignal.timeout(10000) });
    if (!response.ok) return paid;
    const view = await response.json() as { state?: string; paymentId?: string; refundedAmount?: string; result?: unknown; receipt?: unknown;
      upstreamAttempts?: { state: string }[]; operatorResolution?: { version: number; paymentId: string; resolutionId: string; expectedAttemptsDigest: string; evidenceDigest: string; reason: string; resolvedAt: number };
      confirmedRefunds?: { refundId: string; amount: string; txHash: string }[] };
    const resolution = view.operatorResolution, refunds = view.confirmedRefunds;
    if (view.state !== "Refunded" || view.paymentId !== quote.paymentId || view.refundedAmount !== quote.price || payment.refundedAmount !== BigInt(quote.price)
      || view.result !== undefined || view.receipt !== undefined || !resolution || resolution.version !== 1 || resolution.paymentId !== quote.paymentId
      || resolution.reason !== "operator-accepted-nondelivery-cost" || !Number.isSafeInteger(resolution.resolvedAt) || resolution.resolvedAt <= 0
      || !(hash(resolution.resolutionId) || /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(resolution.resolutionId)) || !hash(resolution.evidenceDigest)
      || !view.upstreamAttempts?.some(attempt => attempt.state === "Unknown") || view.upstreamAttempts.some(attempt => !["Unknown", "Rejected"].includes(attempt.state))
      || resolution.expectedAttemptsDigest !== keccak256(toUtf8Bytes(canonical(view.upstreamAttempts as unknown as Json)))
      || !refunds || refunds.length !== 1 || !hash(refunds[0].refundId) || !hash(refunds[0].txHash) || refunds[0].amount !== quote.price) return paid;
    const manager = await account.getFunction("creditManager").staticCall({ blockTag: block.number });
    const refund = refunds[0], refundReceipt = await provider.getTransactionReceipt(refund.txHash);
    if (!refundReceipt || refundReceipt.status !== 1 || refundReceipt.hash !== refund.txHash || refundReceipt.blockNumber > block.number
      || (await provider.getBlock(refundReceipt.blockNumber))?.hash !== refundReceipt.blockHash) return paid;
    const refundEvents = refundReceipt.logs.filter(log => same(log.address, manager)).flatMap(log => { try { const event = managerInterface.parseLog(log); return event?.name === "RefundProcessed" ? [event] : []; } catch { return []; } });
    if (refundEvents.length !== 1 || refundEvents[0].args.paymentId !== quote.paymentId || refundEvents[0].args.refundId !== refund.refundId
      || refundEvents[0].args.amount !== BigInt(quote.price) || refundEvents[0].args.debtReduced !== 0n || refundEvents[0].args.toCash !== BigInt(quote.price)
      || (await provider.getBlock(block.number))?.hash !== block.hash) return paid;
    return { status: "refunded-undelivered", chargedRaw: "0", refundedRaw: quote.price,
      evidence: { paymentId: quote.paymentId, resolutionId: resolution.resolutionId, evidenceDigest: resolution.evidenceDigest } };
  } catch { return paid; }
}

/** A hosted parent run owns the total budget; each sequential child owns one normal metered task journal. */
export class HostedAutonomyExecutor implements HostedExecutor {
  readonly config: HostedAutonomyConfig;
  constructor(private task: TaskAdapter, config: HostedAutonomyConfig, private deps: HostedAutonomyDependencies = {}) { this.config = validateHostedAutonomyConfig(config); }
  /** New game defaults never grant an old paid session more games, decisions, spending or time. */
  private async legacyExecutor(input: HostedExecution): Promise<HostedAutonomyExecutor | undefined> {
    try {
      const saved: Snapshot = JSON.parse(await readFile(join(input.directory, "autonomy-host", "session.json"), "utf8"));
      const old = validateHostedAutonomyConfig(saved.config);
      if (old.games !== undefined || this.config.games === undefined || old.maxDecisions > this.config.maxDecisions
        || !isDeepStrictEqual({ ...old, maxDecisions: this.config.maxDecisions, games: this.config.games }, this.config)) return undefined;
      return new HostedAutonomyExecutor(this.task, old, this.deps);
    } catch { return undefined; }
  }
  /** Read only a known resource pause. Unknown payment/entry/dispatch is never a funding admission. */
  async resolveFundingTarget(input: HostedExecution): Promise<{ childId: string; modelId: string; funding: "cash" | "reward-tokens" } | undefined> {
    const legacy = await this.legacyExecutor(input); if (legacy) return legacy.resolveFundingTarget(input);
    try {
      if (input.run.action !== "autonomous" || input.run.status !== "Paused" || !["INFERENCE_FUNDING_REQUIRED", "AUTONOMY_GAME_LIMIT"].includes(input.run.reason ?? "")) return undefined;
      const host: Snapshot = JSON.parse(await readFile(join(input.directory, "autonomy-host", "session.json"), "utf8"));
      const loop: AutonomyState = JSON.parse(await readFile(join(input.directory, "autonomy-loop", "session.json"), "utf8"));
      if (!isDeepStrictEqual(host.config, this.config) || !isDeepStrictEqual(host.controller, loop.config) || loop.phase !== "Paused" || loop.resumingTaskChildId
        || loop.config.deadlineMs <= (this.deps.now ?? Date.now)()
        || host.input.agent.id !== input.agent.id || host.input.agent.owner !== input.agent.owner || host.input.agent.wallet !== input.agent.wallet
        || !isDeepStrictEqual(host.input.agent.binding, input.agent.binding) || host.input.keyFile !== input.keyFile
        || host.input.run.requestId !== input.run.requestId || host.input.run.reservedRaw !== input.run.reservedRaw) return undefined;
      const step = loop.pendingTaskChildId ? loop.steps.find(step => step.childId === loop.pendingTaskChildId) : loop.steps.at(-1);
      if (!step?.childId || step.decision?.action !== "run-task" || step.outcome?.terminal || step.outcome?.reason !== "INFERENCE_FUNDING_REQUIRED"
        || loop.steps.some(other => other.childId && other.childId !== step.childId && !other.outcome?.terminal)) return undefined;
      const child = host.children[step.childId];
      if (!child || !["reward-task", "metered-task"].includes(child.run.action) || (child.run.action === "reward-task") !== (step.decision.funding === "reward-tokens") || child.run.requestId !== step.childId
        || child.run.agentId !== input.agent.id || child.agent.id !== input.agent.id || child.agent.owner !== input.agent.owner || child.agent.wallet !== input.agent.wallet
        || !isDeepStrictEqual(child.agent.binding, input.agent.binding) || child.keyFile !== input.keyFile
        || child.directory !== join(input.directory, "children", step.childId) || child.agent.modelId !== step.decision.modelId) return undefined;
      return { childId: step.childId, modelId: child.agent.modelId, funding: child.run.action === "reward-task" ? "reward-tokens" : "cash" };
    } catch { return undefined; }
  }
  async canRecoverTerminal(input: HostedExecution): Promise<boolean> {
    const legacy = await this.legacyExecutor(input); if (legacy) return legacy.canRecoverTerminal(input);
    let owned: Awaited<ReturnType<typeof openHostedPlannerConnection>> | undefined;
    try {
      const snapshot: Snapshot = JSON.parse(await readFile(join(input.directory, "autonomy-host", "session.json"), "utf8"));
      const loop: AutonomyState = JSON.parse(await readFile(join(input.directory, "autonomy-loop", "session.json"), "utf8"));
      if (input.run.action !== "autonomous" || input.run.status !== "Failed" || input.run.reason !== "AUTONOMY_INVALID_DECISION"
        || !isDeepStrictEqual(snapshot.config, this.config) || !isDeepStrictEqual(snapshot.controller, loop.config)
        || snapshot.input.agent.id !== input.agent.id || snapshot.input.agent.owner !== input.agent.owner || snapshot.input.agent.wallet !== input.agent.wallet
        || !isDeepStrictEqual(snapshot.input.agent.binding, input.agent.binding) || snapshot.input.keyFile !== input.keyFile
        || snapshot.input.run.requestId !== input.run.requestId || snapshot.input.run.reservedRaw !== input.run.reservedRaw
        || ["modelId", "strategy", "perRunBudgetRaw", "totalBudgetRaw", "allowCredit"].some(key => (snapshot.input.agent as any)[key] !== (input.agent as any)[key])
        || BigInt(input.agent.spentRaw) !== BigInt(snapshot.input.agent.spentRaw) + BigInt(input.run.chargedRaw)
        || Object.keys(snapshot.children).length || loop.phase !== "Stopped" || loop.reason !== "AUTONOMY_INVALID_DECISION"
        || loop.steps.length !== 1 || loop.startedTasks !== 0 || loop.completedTasks !== 0 || loop.steps[0].childId || loop.steps[0].decision
        || loop.chargedRaw !== input.run.chargedRaw || loop.chargedRaw !== loop.steps[0].decisionChargedRaw
        || loop.config.deadlineMs <= (this.deps.now ?? Date.now)()) return false;
      const step = loop.steps[0], limits = { maxSpendRaw: loop.config.decisionReserveRaw!, deadlineMs: loop.config.deadlineMs };
      const cached = this.deps.cachedPlanner ? await this.deps.cachedPlanner(step.context, step.decisionId, limits, snapshot.input)
        : await this.cachedPlan(snapshot.input, step.context, step.decisionId, this.deps.provider ?? (owned = await openHostedPlannerConnection((await taskPrivateFile(this.task.config.rpcUrlFile)).trim(), input.agent.binding!.chainId, this.task.config.rpcTransport)).provider);
      parseAutonomyDecision(cached.decision, loop.config);
      return cached.chargedRaw === loop.chargedRaw && BigInt(cached.chargedRaw) <= BigInt(limits.maxSpendRaw)
        && loop.config.deadlineMs > (this.deps.now ?? Date.now)();
    } catch { return false; } finally { owned?.close(); }
  }
  async execute(input: HostedExecution): Promise<HostedResult> {
    if (input.recover) { const legacy = await this.legacyExecutor(input); if (legacy) return legacy.execute(input); }
    if (String(input.run.action) !== "autonomous" || !input.agent.binding || !this.task.config.metered) invalid("HOSTED_AUTONOMY_NOT_READY");
    if (this.config.games && !this.deps.games) invalid("HOSTED_AUTONOMY_GAMES_NOT_READY");
    const store = new SessionStore<Snapshot>(join(input.directory, "autonomy-host")); await store.start(input.recover);
    let ownedTransport: Awaited<ReturnType<typeof openHostedPlannerConnection>> | undefined;
    try {
      let snapshot = await store.read();
      if (snapshot && (!isDeepStrictEqual(snapshot.config, this.config) || snapshot.input.agent.id !== input.agent.id || snapshot.input.agent.owner !== input.agent.owner
        || snapshot.input.agent.wallet !== input.agent.wallet || !isDeepStrictEqual(snapshot.input.agent.binding, input.agent.binding)
        || snapshot.input.run.requestId !== input.run.requestId || snapshot.input.run.reservedRaw !== input.run.reservedRaw || snapshot.input.keyFile !== input.keyFile)) invalid("HOSTED_AUTONOMY_BINDING_CHANGED");
      if (!snapshot) {
        const models = this.task.config.models.map(model => model.id);
        if (!models.length || !/^[1-9][0-9]{0,77}$/.test(input.run.reservedRaw) || BigInt(input.run.reservedRaw) > BigInt(input.agent.totalBudgetRaw) - BigInt(input.agent.spentRaw)) invalid("HOSTED_AUTONOMY_BUDGET_INVALID");
        const controller: AutonomyConfig = { version: 1, sessionId: input.run.requestId, maxTasks: this.config.maxTasks, maxDecisions: this.config.maxDecisions,
          maxSpendRaw: input.run.reservedRaw, deadlineMs: (this.deps.now ?? Date.now)() + this.config.durationMs, models,
          funding: [...(input.agent.allowCredit ? ["cash", "credit"] as const : ["cash"] as const),
            ...(this.config.games?.rewardKinds.includes("llm-credits") && models.includes("kimi-k2.6") ? ["reward-tokens" as const] : [])], decisionReserveRaw: this.config.plannerPriceRaw,
          ...(this.config.games ? { games: { maxGames: this.config.games.maxGames, maxSpendPerGameRaw: this.config.games.maxSpendPerGameRaw, rewardKinds: [...this.config.games.rewardKinds] } } : {}) };
        const {activity:_activity,progress:_progress,...persistedInput}=input;
        snapshot = { version: 1, config: this.config, input: structuredClone(persistedInput), controller, children: {} }; await store.write(snapshot);
      }
      const state = snapshot, parent = state.input;
      const executeChild = async (child: HostedExecution, recover: boolean) => {
        if (child.run.action === "game" && this.deps.admitGame) {
          try { await this.deps.admitGame(parent, child); }
          catch (error) {
            if (error instanceof HostedError && ["HOSTED_SPONSOR_LIMIT", "HOSTED_AGENT_PAUSED", "HOSTED_AUTONOMY_GAME_ADMISSION_INVALID"].includes(error.code))
              return { terminal: true, success: false, chargedRaw: "0", reason: error.code };
            return { terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_AUTONOMY_GAME_ADMISSION_UNCERTAIN" };
          }
        }
        const adapter = child.run.action === "game" ? this.deps.games : this.task;
        if (!adapter) invalid("HOSTED_AUTONOMY_GAMES_NOT_READY");
        const result = await adapter.execute({ ...structuredClone(child), recover, activity:input.activity });
        return { terminal: result.terminal, success: result.success, chargedRaw: result.chargedRaw, ...(result.refundedRaw !== undefined ? { refundedRaw: result.refundedRaw } : {}), ...(result.reason ? { reason: result.reason } : {}) };
      };
      let observedFinance: Extract<HostedFinance, { status: "confirmed" }> | undefined;
      const result = await runAutonomy(join(input.directory, "autonomy-loop"), state.controller, {
        now: this.deps.now,
        onProgress:async progress=>{const decision=progress.decision;await input.activity?.({scene:progress.phase==="Paused"?"interruption":decision?.action==="run-game"?"game":"decision",state:progress.phase==="Deciding"?"started":progress.phase==="Executing"?"selected":progress.phase==="Paused"?/UNKNOWN|UNCERTAIN|UNCONFIRMED/.test(progress.reason??"")?"reconciling":"paused":progress.phase==="Stopped"||progress.phase==="Completed"?"completed":"waiting",...(progress.decisionId?{phaseId:progress.decisionId}:{}),...(decision&&decision.action!=="stop"?{subject:{id:decision.modelId,name:decision.modelId,kind:"model" as const}}:{}),...(progress.reason&&/^[A-Z][A-Z0-9_]{0,100}$/.test(progress.reason)?{reason:progress.reason}:{}),evidence:{chargedRaw:progress.chargedRaw,completedTasks:progress.completedTasks}});},
        observe: async () => {
          await input.activity?.({scene:"funding",state:"started"});
          const finance = await this.task.finance(parent.agent); if (finance.status !== "confirmed") throw new Error(finance.reason);
          observedFinance = finance;
          await input.activity?.({scene:"funding",state:"confirmed",evidence:{cashRaw:finance.cashRaw,debtRaw:finance.debtRaw,chainId:finance.chainId,blockNumber:finance.block.number,blockHash:finance.block.hash}});
          const credit = finance.credit.eligible && !finance.policy.ownerFrozen
            ? min(BigInt(finance.credit.tierCapRaw), BigInt(finance.policy.maxDebtPerTxRaw), BigInt(finance.policy.maxDebtPerDayRaw)) : 0n;
          const metered = this.task.config.metered!;
          const plans = this.task.config.models.map(model => ({ modelId: model.id, workflow: model.templates[parent.agent.strategy] }));
          const limits = plans.flatMap(plan => plan.workflow.tasks.map(task => BigInt(task.creditLimit)));
          const rewards = this.config.games && this.deps.games ? await this.deps.games.rewardBalance(parent.agent) : undefined;
          return { cashRaw: finance.cashRaw, debtRaw: finance.debtRaw, creditAvailableRaw: (credit > BigInt(finance.debtRaw) ? credit - BigInt(finance.debtRaw) : 0n).toString(), inferenceCreditsAvailable: "0",
            ...(rewards ? { rewardTokens: { modelId: rewards.modelId, availableTokens: String(rewards.availableTokens), minTaskTokens: String(this.config.games!.rewardTaskMinTokens), blocked: rewards.blocked } } : {}),
            executionCosts: { planningCashRaw: this.config.plannerPriceRaw, taskPackagePriceRaw: metered.priceRaw, taskPackageCreditsRaw: metered.creditsRaw,
              taskPerRunLimitRaw: parent.agent.perRunBudgetRaw, taskCreditLimitRaw: limits.length ? min(...limits).toString() : "0", borrowerFeeBps: finance.credit.feeBps,
              modelTiers: plans.map(plan => ({ modelId: plan.modelId, tiers: [...new Set(plan.workflow.providers.flatMap(provider => provider.routes.flatMap(route => route.solve.tiers)))] })),
              tokenRates: metered.catalog.map((model, index) => ({ tier: index === 0 ? "cheap" : "strong", inputMicroCreditsPerToken: model.inputMicroCreditsPerToken, outputMicroCreditsPerToken: model.outputMicroCreditsPerToken })) } };

        },
        ...(this.config.games ? {
          runtimeDecision: async (context: AutonomyContext) => {
            if (this.deps.shouldContinue && !await this.deps.shouldContinue(parent.agent.id)) return { action: "stop" as const, reason: "HOSTED_AGENT_PAUSED" };
            if (context.completedTasks > 0 && !context.pendingTask) {
              if (!observedFinance) invalid("HOSTED_AUTONOMY_TASK_CATALOG_UNCONFIRMED");
              const provider = this.deps.provider ?? (ownedTransport ??= await openHostedPlannerConnection((await taskPrivateFile(this.task.config.rpcUrlFile)).trim(), parent.agent.binding!.chainId, this.task.config.rpcTransport)).provider;
              context.observation.availableTasks = await readHostedAvailableTasks(this.task.config, parent, observedFinance, provider, context.deadlineMs, (this.deps.now ?? Date.now)());
              if (context.observation.availableTasks === 0) return { action: "stop" as const, reason: "AUTONOMY_NO_AVAILABLE_TASKS" };
            }
            const rewards = context.observation.rewardTokens;
            const rewardReady = rewards && !rewards.blocked && context.models.includes(rewards.modelId) && context.funding.includes("reward-tokens")
              && BigInt(rewards.availableTokens) >= BigInt(rewards.minTaskTokens);
            const feasiblePaidTask = context.fundingQuote?.options.some(option => option.feasible);
            if (!context.pendingTask && feasiblePaidTask) return null;
            if (!context.pendingTask && rewardReady) return { action: "run-task" as const, modelId: rewards.modelId, funding: "reward-tokens" as const };
            if (rewards?.blocked) return { action: "stop" as const, reason: "REWARD_ACCOUNT_BLOCKED_BY_USAGE_OVERRUN" };
            if ((context.remainingGames ?? 0) < 1) return { action: "stop" as const, reason: "AUTONOMY_GAME_LIMIT" };
            const kind = context.pendingTask ? "llm-credits" : BigInt(context.observation.cashRaw) < BigInt(this.config.plannerPriceRaw) && this.config.games!.rewardKinds.includes("usdc") ? "usdc" : this.config.games!.rewardKinds.includes("llm-credits") ? "llm-credits" : "usdc";
            if (!this.config.games!.rewardKinds.includes(kind) || !rewards || !context.models.includes(rewards.modelId)) return { action: "stop" as const, reason: "AUTONOMY_REWARD_RESOURCE_UNAVAILABLE" };
            return { action: "run-game" as const, modelId: rewards.modelId, funding: "cash" as const, rewardKind: kind };
          },
          canResumeTask: async (context: AutonomyContext) => {
            if (this.deps.shouldContinue && !await this.deps.shouldContinue(parent.agent.id)) return false;
            const rewards = context.observation.rewardTokens, pending = context.pendingTask;
            return !!(pending && rewards && !rewards.blocked && rewards.modelId === pending.modelId
              && BigInt(rewards.availableTokens) >= BigInt(rewards.minTaskTokens) && BigInt(rewards.availableTokens) > BigInt(pending.lastResumeTokens ?? "0"));
          },
        } : {}),
        decide: async (context, decisionId, limits) => {
          if (this.deps.shouldContinue && !await this.deps.shouldContinue(parent.agent.id)) return { decision: { action: "stop", reason: "HOSTED_AGENT_PAUSED" }, chargedRaw: "0",source:"runtime" as const };
          if (BigInt(context.observation.cashRaw) < BigInt(this.config.plannerPriceRaw)) return { decision: { action: "stop", reason: "AUTONOMY_PLANNER_CASH_REQUIRED" }, chargedRaw: "0",source:"runtime" as const };
          if (BigInt(context.remainingSpendRaw) < BigInt(this.config.plannerPriceRaw) + BigInt(this.task.config.metered!.priceRaw))
            return { decision: { action: "stop", reason: "AUTONOMY_TASK_BUDGET_REQUIRED" }, chargedRaw: "0",source:"runtime" as const };
          if (this.deps.planner) return this.deps.planner(context, decisionId, limits, parent);
          const provider = this.deps.provider ?? (ownedTransport ??= await openHostedPlannerConnection((await taskPrivateFile(this.task.config.rpcUrlFile)).trim(), parent.agent.binding!.chainId, this.task.config.rpcTransport)).provider;
          return this.plan({...parent,activity:input.activity}, context, decisionId, limits, provider);
        },
        recoverCachedDecision: async (context, decisionId, limits) => {
          if (this.deps.cachedPlanner) return this.deps.cachedPlanner(context, decisionId, limits, parent);
          const provider = this.deps.provider ?? (ownedTransport ??= await openHostedPlannerConnection((await taskPrivateFile(this.task.config.rpcUrlFile)).trim(), parent.agent.binding!.chainId, this.task.config.rpcTransport)).provider;
          return this.cachedPlan(parent, context, decisionId, provider);
        },
        recoverDecision: async (context, decisionId, limits) => {
          if (this.deps.recoverPlanner) return this.deps.recoverPlanner(context, decisionId, limits, parent);
          if (this.deps.planner) return { status: "unknown", chargedRaw: "0", refundedRaw: "0" };
          const provider = this.deps.provider ?? (ownedTransport ??= await openHostedPlannerConnection((await taskPrivateFile(this.task.config.rpcUrlFile)).trim(), parent.agent.binding!.chainId, this.task.config.rpcTransport)).provider;
          return this.recoverPlan(parent, context, decisionId, provider);
        },
        execute: async (decision, childId, limits) => {
          if (this.deps.shouldContinue && !await this.deps.shouldContinue(parent.agent.id)) return { terminal: true, success: false, chargedRaw: "0", reason: "HOSTED_AGENT_PAUSED" };
          const budget = min(BigInt(parent.agent.perRunBudgetRaw), BigInt(limits.maxSpendRaw)).toString();
          if (decision.funding !== "reward-tokens" && BigInt(budget) < BigInt(this.task.config.metered!.priceRaw)) return { terminal: true, success: false, chargedRaw: "0", reason: "AUTONOMY_TASK_BUDGET_REQUIRED" };
          const timestamp = new Date((this.deps.now ?? Date.now)()).toISOString();
          const child: HostedExecution = { agent: { ...structuredClone(parent.agent), modelId: decision.modelId, allowCredit: decision.funding === "credit",
            perRunBudgetRaw: decision.funding === "reward-tokens" ? parent.agent.perRunBudgetRaw : budget, totalBudgetRaw: parent.agent.totalBudgetRaw,
            spentRaw: (BigInt(parent.agent.spentRaw) + BigInt(parent.run.reservedRaw) - BigInt(limits.maxSpendRaw)).toString(), reservedRaw: decision.funding === "reward-tokens" ? "0" : budget, activeRequestId: childId },
            run: { requestId: childId, agentId: parent.agent.id, action: decision.funding === "reward-tokens" ? "reward-task" : "metered-task", status: "Running", createdAt: timestamp, updatedAt: timestamp,
              reservedRaw: decision.funding === "reward-tokens" ? "0" : budget, chargedRaw: "0", recoverable: true }, directory: join(parent.directory, "children", childId), keyFile: parent.keyFile, recover: false, deadlineMs: limits.deadlineMs };
          state.children[childId] = child; await store.write(state);
          return executeChild(child, false);
        },
        executeGame: async (decision, childId, limits, fundingFor) => {
          if (this.deps.shouldContinue && !await this.deps.shouldContinue(parent.agent.id)) return { terminal: true, success: false, chargedRaw: "0", reason: "HOSTED_AGENT_PAUSED" };
          if (!this.deps.games) return { terminal: true, success: false, chargedRaw: "0", reason: "HOSTED_AUTONOMY_GAMES_NOT_READY" };
          const timestamp = new Date((this.deps.now ?? Date.now)()).toISOString();
          const child: HostedExecution = { agent: { ...structuredClone(parent.agent), modelId: decision.modelId, allowCredit: false,
              reservedRaw: limits.maxSpendRaw, activeRequestId: childId },
            run: { requestId: childId, agentId: parent.agent.id, action: "game", rewardKind: decision.rewardKind,
              ...(fundingFor ? { fundingFor } : {}), status: "Running", createdAt: timestamp, updatedAt: timestamp,
              reservedRaw: limits.maxSpendRaw, chargedRaw: "0", recoverable: true },
            directory: join(parent.directory, "children", childId), keyFile: parent.keyFile, recover: false, deadlineMs: limits.deadlineMs };
          state.children[childId] = child; await store.write(state); return executeChild(child, false);
        },
        recover: async (childId) => {
          const child = state.children[childId]; if (!child) return { terminal: false, success: false, chargedRaw: "0", reason: "AUTONOMY_CHILD_SNAPSHOT_MISSING" };
          return executeChild(child, true);
        },
      }, input.recover);
      const terminal = result.phase === "Stopped" || result.phase === "Completed";
      const childFailed = result.steps.some(step => step.outcome?.terminal && !step.outcome.success);
      const modelStopped = result.steps.at(-1)?.decision?.action === "stop";
      const admissionStops = ["AUTONOMY_PLANNER_CASH_REQUIRED", "AUTONOMY_TASK_BUDGET_REQUIRED", "HOSTED_AGENT_PAUSED"];
      const reason = modelStopped && result.steps.at(-1)?.decisionSource!=="runtime" && !admissionStops.includes(result.reason ?? "") ? "AUTONOMY_MODEL_STOPPED"
        : result.reason && /^[A-Z][A-Z0-9_]{0,100}$/.test(result.reason) ? result.reason : "AUTONOMY_EXECUTION_STOPPED";
      return Object.assign({ phase: result.phase, terminal, success: terminal && !childFailed && (result.phase === "Completed" || result.steps.at(-1)?.decision?.action === "stop"),
        chargedRaw: result.chargedRaw, refundedRaw: result.steps.reduce((sum, step) => sum + BigInt(step.decisionRefundedRaw ?? "0") + BigInt(step.outcome?.refundedRaw ?? "0"), 0n).toString(), reason }, { autonomousTasks: result.completedTasks,
          ...(this.config.games ? { autonomousGames: result.completedGames ?? 0 } : {}) });
    } finally { ownedTransport?.close(); await store.close(); }
  }
  private async cachedPlan(input: HostedExecution, context: AutonomyContext, decisionId: string, provider: JsonRpcProvider) {
    const state: PlannerState = JSON.parse(await readFile(join(input.directory, "planner", decisionId, "session.json"), "utf8"));
    if (!state.handle || !state.inference || !isDeepStrictEqual(state.context, context)
      || !isDeepStrictEqual(state.handle.input, { ...createHostedPlannerRequest(this.config, context), agentId: input.agent.binding!.agentId, taskId: "0" })
      || state.handle.relayUrl !== this.config.plannerRelayUrl || state.handle.quote.price !== this.config.plannerPriceRaw) invalid("HOSTED_PLANNER_CACHE_INVALID");
    const template = this.task.config.models[0].templates[input.agent.strategy], wallet = new Wallet((await taskPrivateFile(input.keyFile)).trim(), provider);
    if (wallet.address.toLowerCase() !== input.agent.wallet.toLowerCase()) invalid("HOSTED_PLANNER_WALLET_CHANGED");
    const receipt = state.inference.receipt, quote = state.handle.quote;
    const same = (a: string, b: string) => getAddress(a) === getAddress(b);
    if (state.handle.version !== 1 || quote.requestDigest !== requestDigest(state.handle.input) || quote.paymentId !== paymentId("0", quote.requestDigest, quote.serverNonce)
      || quote.agentId !== input.agent.binding!.agentId || quote.taskId !== "0" || quote.chainId !== template.chainId
      || quote.service !== this.config.plannerService || quote.model !== this.config.plannerModel || quote.tier !== undefined
      || !same(quote.account, template.account) || !same(quote.asset, template.asset) || !same(quote.payTo, this.config.plannerProvider)
      || receipt.agentId !== quote.agentId || receipt.taskId !== quote.taskId || receipt.chainId !== quote.chainId || receipt.service !== quote.service
      || !same(receipt.account, quote.account) || !same(receipt.asset, quote.asset) || !same(receipt.payTo, quote.payTo)) invalid("HOSTED_PLANNER_BINDING_CHANGED");
    if (receipt.fromCredit !== "0" || receipt.fromCash !== quote.price || receipt.paymentId !== quote.paymentId || receipt.requestDigest !== quote.requestDigest
      || receipt.price !== quote.price || receipt.model !== this.config.plannerPhysicalModel) invalid("HOSTED_PLANNER_RECEIPT_INVALID");
    await confirmPaidDelivery(state, { chainId: template.chainId, account: template.account, agentId: input.agent.binding!.agentId, provider: this.config.plannerProvider, taskId: "0" }, provider, wallet);
    const response = state.inference.result as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
    if (response?.model !== (this.config.plannerResponseModel ?? this.config.plannerPhysicalModel)) invalid("HOSTED_PLANNER_MODEL_CHANGED");
    return { decision: response?.choices?.[0]?.message?.content, chargedRaw: receipt.fromCash };
  }
  private async recoverPlan(input: HostedExecution, context: AutonomyContext, decisionId: string, provider: JsonRpcProvider): Promise<AutonomyDecisionRecovery> {
    const store = new SessionStore<PlannerState>(join(input.directory, "planner", decisionId)); await store.start(true);
    try {
      const state = await store.read();
      if (!state?.handle) return { status: "unknown", chargedRaw: "0", refundedRaw: "0" };
      if (!isDeepStrictEqual(state.context, context) || state.inference) invalid("HOSTED_PLANNER_RECOVERY_INVALID");
      const template = this.task.config.models[0].templates[input.agent.strategy];
      const result = await reconcileHostedPlannerPayment(state.handle, { config: this.config, context, chainId: template.chainId, account: template.account,
        asset: template.asset, agentId: input.agent.binding!.agentId, wallet: input.agent.wallet }, provider);
      state.recovery = result; await store.write(state); return result;
    } finally { await store.close(); }
  }
  private async plan(input: HostedExecution, context: AutonomyContext, decisionId: string, limits: AutonomyLimits, provider: JsonRpcProvider) {
    await input.activity?.({scene:"model",state:"selected",phaseId:decisionId,subject:{id:this.config.plannerModel,name:this.config.plannerModel,kind:"model"},evidence:{priceRaw:this.config.plannerPriceRaw}});
    const store = new SessionStore<PlannerState>(join(input.directory, "planner", decisionId)); await store.start(input.recover);
    let infer: InferCredit | undefined;
    try {
      let state = await store.read(); if (state && !isDeepStrictEqual(state.context, context)) invalid("HOSTED_PLANNER_BINDING_CHANGED");
      state ??= { version: 1, context }; await store.write(state); const journal = state;
      const template = this.task.config.models[0].templates[input.agent.strategy], wallet = new Wallet((await taskPrivateFile(input.keyFile)).trim(), provider);
      if (wallet.address.toLowerCase() !== input.agent.wallet.toLowerCase()) invalid("HOSTED_PLANNER_WALLET_CHANGED");
      infer = new InferCredit({ agentId: input.agent.binding!.agentId, signer: wallet, chainId: BigInt(template.chainId), account: template.account, asset: template.asset,
        provider: this.config.plannerProvider, maxPrice: BigInt(limits.maxSpendRaw), timeoutMs: Math.min(this.task.config.timeoutMs ?? 10000, Math.max(1, limits.deadlineMs - Date.now())),
        onHandle: async handle => { if (handle.input.taskId !== "0" || journal.handle && handle.quote.paymentId !== journal.handle.quote.paymentId) invalid("HOSTED_PLANNER_HANDLE_CHANGED"); journal.handle = structuredClone(handle); await store.write(journal);await input.activity?.({scene:"model",state:"waiting",phaseId:decisionId,evidence:{paymentId:handle.quote.paymentId,priceRaw:handle.quote.price,...(handle.submission?{txHash:handle.submission.txHash}:{})}}); },
        beforePayment: async () => { if (Date.now() >= limits.deadlineMs) invalid("AUTONOMY_DEADLINE"); },
      });
      if (!journal.inference) {
        if (journal.handle) invalid("HOSTED_PLANNER_RECONCILIATION_REQUIRED");
        journal.inference = await infer.fetch(this.config.plannerRelayUrl, { body: createHostedPlannerRequest(this.config, context) }); await store.write(journal);
      }
      const receipt = journal.inference.receipt, quote = journal.handle!.quote;
      if (receipt.fromCredit !== "0" || receipt.paymentId !== quote.paymentId || receipt.requestDigest !== quote.requestDigest || receipt.price !== quote.price || receipt.model !== this.config.plannerPhysicalModel) invalid("HOSTED_PLANNER_RECEIPT_INVALID");
      await confirmPaidDelivery(journal, { chainId: template.chainId, account: template.account, agentId: input.agent.binding!.agentId, provider: this.config.plannerProvider, taskId: "0" }, provider, wallet);
      const response = journal.inference.result as { model?: unknown; choices?: { message?: { content?: unknown } }[] };
      if (response?.model !== (this.config.plannerResponseModel ?? this.config.plannerPhysicalModel)) invalid("HOSTED_PLANNER_MODEL_CHANGED");
      await input.activity?.({scene:"model",state:"completed",phaseId:decisionId,evidence:{paymentId:receipt.paymentId,txHash:receipt.txHash,chargedRaw:receipt.fromCash}});
      return { decision: response?.choices?.[0]?.message?.content, chargedRaw: receipt.fromCash };
    } finally { infer?.close(); await store.close(); }
  }
}
