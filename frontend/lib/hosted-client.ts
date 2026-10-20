import { validGoal } from "../../services/hosted-agents/src/goal-types";
import type { AgentCreation, AgentSettings, HostedAction, HostedAgent, HostedRun, HostedCatalogModel, HostedFinance, HostedCapabilities, HostedSponsorship, HostedAccounting } from "../../services/hosted-agents/src/types";
export type { AgentCreation, AgentSettings, HostedAction, HostedAgent, HostedRun, HostedCatalogModel, HostedFinance, HostedCapabilities, HostedSponsorship, HostedAccounting };
export interface HostedSnapshot { owner?: string; capabilities?: HostedCapabilities; sponsorship?: HostedSponsorship; agents: HostedAgent[]; runs: HostedRun[]; models: HostedCatalogModel[] }
export type { HostedActivity, HostedActivityInput, HostedActivityEvidence, HostedActivityState, HostedScene, HostedRequiredAction } from "../../services/hosted-agents/src/scene-types";
export interface RunInput { requestId: string; action: HostedAction; rewardKind?: "usdc" | "llm-credits"; amountRaw?: string; goal?: string }
export type PendingCommand = { owner: string; kind: "create"; input: AgentCreation & { requestId: string } } | { owner: string; kind: "run"; agentId: string; input: RunInput };
import { networkName } from "./networks";
export class HostedClientError extends Error {
  constructor(readonly code: string, readonly status: number) { super(code); }
}

/** Call only for a successful authenticated snapshot response. A local pending
 * command, wallet event or URL cannot establish the platform's current owner. */
export function authenticatedSnapshotOwner(snapshot: HostedSnapshot): string | null {
  const candidate = snapshot.owner === undefined ? snapshot.agents[0]?.owner : snapshot.owner;
  if (candidate === undefined) return null; // Legacy empty snapshot has no identity evidence.
  if (typeof candidate !== "string" || !/^0x[0-9a-f]{40}$/i.test(candidate)
    || snapshot.agents.some(agent => typeof agent.owner !== "string" || agent.owner.toLowerCase() !== candidate.toLowerCase())) {
    throw new HostedClientError("HOSTED_UNAVAILABLE", 503);
  }
  return candidate;
}

/** Same-origin cookies are the only credentials. Never accept/store a bearer token. */
export async function hostedRequest<T>(path: string, method = "GET", body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/hosted${path}`, { method, credentials: "same-origin", cache: "no-store",
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      // Finance may require Tempo's complete fixed-block ledger; keep the
      // browser outside the 130s bridge deadline without changing actions.
      signal: AbortSignal.timeout(["finance", "strategy-advice", "operating-report"].some(route => path.endsWith("/" + route)) ? 140_000 : 15_000) });
  } catch { throw new HostedClientError("HOSTED_RESPONSE_UNCERTAIN", 0); }
  let payload: unknown;
  try { payload = await response.json(); } catch { throw new HostedClientError("HOSTED_RESPONSE_UNCERTAIN", 0); }
  if (!response.ok) {
    const code = payload && typeof payload === "object" && "error" in payload && typeof payload.error === "string" ? payload.error : "HOSTED_UNAVAILABLE";
    throw new HostedClientError(code, response.status);
  }
  return payload as T;
}

const messages: Record<string, string> = {
  ECONOMICS_NOT_WORTHWHILE: "按当前收益与费用上界，经营净回报不足，未接单。",
  ECONOMICS_REVENUE_UNKNOWN: "尚未核验任务收益，未接单。",
  ECONOMICS_ESCROW_UNFUNDED: "任务托管资金不足，未接单。",
  ECONOMICS_BORROWER_FEE_CHANGED: "借款费超过已核对上界，已暂停新付款。",
  ECONOMICS_EXECUTION_PRICE_CHANGED: "执行报价发生变化，已暂停新付款。",
  ECONOMICS_OBSERVATION_UNCONFIRMED: "收益观察区块尚未确认，已停止接单。",
  HOSTED_GOAL_MODEL_DOWNGRADED: "剩余预算不足，后续调用已切换到批准的低价模型。",
  GATEWAY_MODEL_DOWNGRADED: "本轮改用低价模型，原任务与已有结果已保留。",
  AUTONOMY_GAME_LIMIT: "已达到自动参赛次数上限，原任务和奖励记录已保留。",
  AUTONOMY_NO_AVAILABLE_TASKS: "目录中暂无可执行任务，本轮已停止新的规划与参赛。",
  AUTONOMY_OBSERVATION_UNAVAILABLE: "暂时无法核验任务与资金状态，原请求已暂停，未继续发起新的调用。",
  AUTONOMY_REWARD_RESOURCE_UNAVAILABLE: "没有符合当前预算与模型的可用奖励资源。",
  HOSTED_AUTONOMY_GAMES_NOT_READY: "自动参赛服务尚未配置完成。",
  HOSTED_EXTERNAL_SERVICE_UNAVAILABLE: "注册表中没有匹配能力的外部 Agent。",
  HOSTED_EXTERNAL_REPUTATION_REQUIRED: "当前候选 Agent 未达到信誉要求。",
  HOSTED_EXTERNAL_REGISTRY_UNAVAILABLE: "外部服务目录暂时不可用，可恢复原任务。",
  HOSTED_EXTERNAL_PROVENANCE_INVALID: "外部交付的服务或任务凭证不匹配，已保留付款记录并停止。",
  HOSTED_EXTERNAL_IDENTITY_INVALID: "外部 Agent 的注册身份与配置不匹配。",
  HOSTED_WALLET_GAS_REQUIRED: "Agent 钱包手续费余额不足；Tempo 使用测试 PathUSD，补足后恢复原开户请求。",
  HOSTED_GOAL_LOOKUP_NETWORK: "当前只查询 Agent 所在网络，请使用当前链的地址或交易哈希。",
  HOSTED_GOAL_LOOKUP_LIMIT: "单次最多查询两个地址或交易；资料过多时请缩小分析范围。",
  HOSTED_GOAL_INPUT_TOO_LARGE: "本次资料超过分析上限，请减少目标或拆分任务。",
  HOSTED_GOAL_LOOKUP_UNAVAILABLE: "链上读取暂时不可用，尚未发起模型付款；可以恢复原请求。",
  HOSTED_GOAL_LOOKUP_REORG: "读取期间区块发生变化，请恢复原请求重新核验。",
  HOSTED_GOAL_SPECIALIST_OUTPUT_INVALID: "专家输出不符合报告格式，已保留调用费用与凭证并停止。",
  HOSTED_GOAL_OUTPUT_INVALID: "模型返回内容无效，已计入确认费用并停止。",
  HOSTED_GOAL_MODEL_CHANGED: "模型响应与报价不一致，已保留付款凭证。",
  HOSTED_GOAL_UNDELIVERED_REFUNDED: "未交付的调用已确认退款，任务已终止。",
  HOSTED_GOAL_PAYMENT_VOIDED: "过期付款已确认作废，没有扣款；请新建任务。",
  HOSTED_GOAL_PAYMENT_REVERTED: "付款交易未成功，任务已停止。",
  HOSTED_GOAL_NOT_CONFIGURED: "目标执行服务尚未接通。",
  HOSTED_GOAL_INVALID: "请输入 1–12000 个字符的任务目标。",
  HOSTED_GOAL_NEEDS_INPUT: "需要补充信息，请查看任务回复。",
  HOSTED_GOAL_REVIEW_FAILED: "交付物未通过独立复核，请查看检查结果。",
  HOSTED_GOAL_BUDGET_REQUIRED: "本次预算已达到上限，已保留阶段产出。",
  HOSTED_GOAL_DEADLINE: "已达到本次执行时限，已保留产出。",
  HOSTED_GOAL_CANCELLED: "已停止后续执行，已发生费用保留。",
  HOSTED_GOAL_CALL_UNCERTAIN: "模型结果待核对，请恢复原请求。",
  HOSTED_GOAL_RECONCILIATION_REQUIRED: "原付款或调用仍需对账；已保留原请求与确认费用。",
  HOSTED_GOAL_PLAN_INVALID: "规划结果格式无效，已停止。",
  HOSTED_GOAL_REVIEW_INVALID: "复核结果格式无效，已保留交付物。",
  WORKFLOW_REFUNDED_TASK_TERMINATED: "推理服务异常，已补偿退款并终止任务。",
  GATEWAY_PERMANENTLY_SEALED: "原推理调用已封存，不能再次派发。",
  ALLOWANCE_COMPENSATED: "原推理额度包已补偿退款，不能继续使用。",
  INFERENCE_FUNDING_REQUIRED: "推理额度不足，原任务已保留。奖励模式可赢取额度后恢复；按量模式请核对额度包及授信状态。",
  AUTONOMY_TASK_LIMIT: "已达到本次连续运行的任务数上限。",
  AUTONOMY_MODEL_STOPPED: "模型决定停止，已保留本次决策记录。",
  AUTONOMY_BUDGET_LIMIT: "已达到本次预算边界，未再派发任务。",
  AUTONOMY_TASK_BUDGET_REQUIRED: "剩余预算不足以覆盖下一单及规划费。",
  AUTONOMY_PLANNER_CASH_REQUIRED: "规划费需要 Agent cash，当前现金不足。",
  AUTONOMY_DEADLINE: "已达到本次连续运行的时间上限。",
  AUTONOMY_DECISION_UNKNOWN: "规划调用结果未确认，已保留记录，需核对原调用。",
  ALLOWANCE_TOO_SMALL: "当前额度包不足以覆盖这一轮的用量上限，未购买新包。",
  ALLOWANCE_EXHAUSTED: "原任务额度包的剩余额度不足以继续，任务已保留。本演示每任务只购买一个包，充值不会重置已用额度。",
  ALLOWANCE_TASK_UNAVAILABLE: "任务已到期、身份变化或不再可执行，已停止新推理。",
  HOSTED_METERED_NOT_CONFIGURED: "按量推理服务尚未配置。",
  HOSTED_AUTONOMY_NOT_CONFIGURED: "连续运行尚未配置。",
  GATEWAY_OUTCOME_UNKNOWN: "模型调用结果未确认，已暂停扣费并保留原请求，需核对原调用。",
  HOSTED_REWARD_MODEL_UNSUPPORTED: "奖励额度目前仅支持 Kimi K2.6 的任务推理。",
  HOSTED_NOT_CONFIGURED: "托管服务尚未配置。当前无法登录、创建 Agent 或执行操作。",
  HOSTED_CONFIG_INVALID: "托管服务配置不可用，请稍后重试。",
  HOSTED_UNAVAILABLE: "托管服务暂时不可用，请稍后重试。",
  HOSTED_AUTH_REQUIRED: "请用钱包签名登录，查看和管理自己的 Agent。",
  HOSTED_AUTH_INVALID: "登录签名已过期或无效，请重新签名登录。",
  HOSTED_AUTH_RATE_LIMIT: "签名请求过于频繁，请稍后重试。",
  HOSTED_CONFIGURATION_REQUIRED: "请先设置模型、推理预算和借贷权限，再开始运行。",
  HOSTED_SETTINGS_INVALID: "设置未被接受，请检查模型、名称和预算是否在平台允许范围内。",
  HOSTED_AGENT_LIMIT: "已达到平台允许创建的 Agent 数量。",
  HOSTED_AGENT_PAUSED: "Agent 已暂停，请先继续 Agent。",
  HOSTED_RECOVER_ORIGINAL_REQUIRED: "有尚未结束的请求，请先查看或恢复原请求。",
  HOSTED_BUDGET_EXHAUSTED: "剩余推理预算不足，请调整累计预算后重试。",
  HOSTED_BUDGET_BELOW_SPENT: "累计预算不能低于已确认的推理支出。",
  HOSTED_SPONSOR_LIMIT: "免费比赛赞助名额已用完：每个登录钱包累计最多 3 局，平台最多 100 局。",
  HOSTED_RESPONSE_UNCERTAIN: "尚未确认服务器是否收到操作。已保留原请求，请用原 ID 继续确认。",
  HOSTED_REQUEST_CONFLICT: "原请求 ID 的参数不一致。请保留原参数，并联系平台核对。",
  HOSTED_INVALID_ORIGIN: "当前访问地址与托管服务配置不一致。",
  HOSTED_PROCESS_INTERRUPTED: "服务中断，原请求已保留；可以明确恢复原请求。",
  REWARD_INSUFFICIENT_AVAILABLE_TOKENS: "当前 Agent 的可用奖励额度不足。",
};
export function hostedError(error: unknown): string {
  if (error instanceof HostedClientError) return messages[error.code] ?? `操作未完成（${error.code}）。`;
  if (error instanceof Error && error.message.startsWith("钱包")) return error.message;
  return "操作未完成，请检查钱包或稍后重试。";
}
export function reasonLabel(code: string) { return messages[code] ?? code; }
export const actionLabel: Record<HostedAction, string> = { provision: "初始化 Agent", deposit: "现金入账", task: "运行任务", game: "免费德州", credits: "奖励额度消费", "reward-task": "奖励额度运行任务", "metered-task": "按量额度运行任务", autonomous: "Pi 连续运行" , goal: "目标任务" };
export const statusLabel: Record<string, string> = { Pending: "初始化中", Ready: "就绪", Paused: "已暂停", Queued: "排队中", Running: "运行中", Succeeded: "已完成", Failed: "失败" };
export const strategyLabel = { conservative: "保守", balanced: "均衡", aggressive: "积极" };
export function usdcRaw(value: string): string {
  const clean = value.trim();
  if (!/^\d+(?:\.\d{1,6})?$/.test(clean)) throw new Error("预算和入账金额须为最多六位小数的结算资产金额。");
  const [whole, fraction = ""] = clean.split(".");
  const raw = BigInt(whole) * 1_000_000n + BigInt(fraction.padEnd(6, "0"));
  if (raw < 1n) throw new Error("预算和入账金额必须大于零。");
  return raw.toString();
}
export function inputUsdc(raw: string): string {
  const value = BigInt(raw);
  const fraction = (value % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return `${value / 1_000_000n}${fraction ? `.${fraction}` : ""}`;
}
export function replayInput(run: HostedRun): RunInput {
  return { requestId: run.requestId, action: run.action, ...(run.rewardKind === undefined ? {} : { rewardKind: run.rewardKind }), ...(run.goal === undefined ? {} : { goal: run.goal }), ...(run.amountRaw === undefined ? {} : { amountRaw: run.amountRaw }) };
}

const pendingKey = (owner: string) => `agentfuel:hosted:pending:${owner.toLowerCase()}`;
/** Only public request parameters persist, so an interrupted POST can reuse its UUID. */
export function savePending(command: PendingCommand | null, owner: string) {
  if (command) localStorage.setItem(pendingKey(owner), JSON.stringify(command));
  else localStorage.removeItem(pendingKey(owner));
}
export function readPending(owner: string): PendingCommand | null {
  try {
    const value = JSON.parse(localStorage.getItem(pendingKey(owner)) ?? "null") as PendingCommand | null;
    if (!value || value.owner.toLowerCase() !== owner.toLowerCase() || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.input?.requestId)) return null;
    if (value.kind === "run" && /^[a-zA-Z0-9_-]{1,80}$/.test(value.agentId) && ["provision", "deposit", "task", "game", "credits", "reward-task", "metered-task", "autonomous", "goal"].includes(value.input.action)) {
      const input = value.input;
      if (input.action === "goal" ? !validGoal(input.goal) : input.goal !== undefined) return null;
      if (input.action === "game" && !["usdc", "llm-credits"].includes(input.rewardKind ?? "") || input.action === "deposit" && !/^[1-9]\d*$/.test(input.amountRaw ?? "")) return null;
      return { owner, kind: "run", agentId: value.agentId, input: { requestId: input.requestId, action: input.action,
        ...(input.action === "goal" ? { goal: input.goal } : {}), ...(input.action === "game" ? { rewardKind: input.rewardKind } : {}), ...(input.action === "deposit" ? { amountRaw: input.amountRaw } : {}) } };
    }
    if (value.kind === "create") {
      const input = value.input;
      if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name)) return null;
      if (Object.keys(input).every(key => ["name", "requestId"].includes(key))) return { owner, kind: "create", input: { name: input.name, requestId: input.requestId } };
      if (!("modelId" in input)) return null;
      if (typeof input.name !== "string" || typeof input.modelId !== "string" || !["conservative", "balanced", "aggressive"].includes(input.strategy) ||
        !/^[1-9]\d*$/.test(input.perRunBudgetRaw) || !/^[1-9]\d*$/.test(input.totalBudgetRaw) || typeof input.allowCredit !== "boolean") return null;
      return { owner, kind: "create", input: { requestId: input.requestId, name: input.name, modelId: input.modelId,
        strategy: input.strategy, perRunBudgetRaw: input.perRunBudgetRaw, totalBudgetRaw: input.totalBudgetRaw, allowCredit: input.allowCredit } };
    }
  } catch { /* An invalid local recovery hint is never an authenticated session. */ }
  return null;
}

type Injected = { request(args: { method: string; params?: unknown[] }): Promise<unknown>; on?: (event: string, listener: (...args: unknown[]) => void) => void; removeListener?: (event: string, listener: (...args: unknown[]) => void) => void };
export function injectedWallet(): Injected | undefined { return (window as Window & { ethereum?: Injected }).ethereum; }
export class HostedWalletNetworkError extends Error {
  constructor(readonly expectedChainId: "31337" | "10143" | "42431") {
    super(`钱包网络不匹配。请切换到 ${networkName(expectedChainId)}（${expectedChainId}） 后重新登录。`);
  }
}
/** Explicit user action only: switch to an already installed Tempo network.
 * We have no verified EIP-3085 nativeCurrency descriptor, so never invent one
 * or leak a private provider URL through wallet_addEthereumChain. */
export async function switchHostedWalletToTempo(injected = injectedWallet()): Promise<void> {
  if (!injected) throw new Error("钱包未检测到。请安装并启用 EIP-1193 钱包扩展。");
  try {
    await injected.request({ method: "wallet_switchEthereumChain", params: [{ chainId: "0xa5bf" }] });
    if (BigInt(String(await injected.request({ method: "eth_chainId" }))) !== 42431n)
      throw new Error("钱包尚未切换到 Tempo Moderato Testnet，请在钱包确认后重试。");
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("钱包")) throw cause;
    const code = Number((cause as { code?: unknown })?.code);
    throw new Error(code === 4902 ? "钱包尚未配置 Tempo Moderato Testnet，请先按官方信息手工添加网络，再点击切换。"
      : code === 4001 ? "钱包切换已取消。可以再次点击切换到 Tempo Moderato Testnet。"
      : code === -32002 ? "钱包已有待确认请求，请先在钱包处理后再试。"
      : "钱包未能切换到 Tempo Moderato Testnet。请在钱包确认网络后重新签名登录。");
  }
}
export async function signedLogin(options: { isCurrent?: () => boolean; onWalletReady?: () => void } = {}): Promise<string> {
  const assertCurrent = () => { if (options.isCurrent && !options.isCurrent()) throw new Error("钱包账号或网络已变化，请重新签名登录。"); };
  const injected = injectedWallet();
  if (!injected) throw new Error("钱包未检测到。请安装并启用 EIP-1193 钱包扩展。");
  const { BrowserProvider, getAddress } = await import("ethers");
  assertCurrent();
  await injected.request({ method: "eth_requestAccounts" });
  assertCurrent();
  const provider = new BrowserProvider(injected), signer = await provider.getSigner();
  const wallet = getAddress(await signer.getAddress()), chain = await injected.request({ method: "eth_chainId" });
  options.onWalletReady?.(); assertCurrent();
  const challenge = await hostedRequest<{ id: string; message: string; expiresAt: number }>("/auth/challenge", "POST", { wallet });
  assertCurrent();
  const chainMatch = /^Chain: (31337|10143|42431)$/m.exec(challenge.message);
  if (!chainMatch) throw new Error("钱包登录挑战与当前地址不一致，请刷新重试。");
  const expected = `AgentFuel hosted agent login\nOrigin: ${window.location.origin}\nWallet: ${wallet}\nChain: ${chainMatch[1]}\nNonce: ${challenge.id}\nExpires: ${new Date(challenge.expiresAt).toISOString()}\nThis signature authenticates your platform account. It authorizes no blockchain transaction.`;
  if (challenge.message !== expected || challenge.expiresAt <= Date.now() || challenge.expiresAt > Date.now() + 301_000) throw new Error("钱包登录挑战与当前地址不一致，请刷新重试。");
  if (BigInt(String(chain)) !== BigInt(chainMatch[1])) throw new HostedWalletNetworkError(chainMatch[1] as "31337" | "10143" | "42431");
  const signature = await signer.signMessage(challenge.message);
  assertCurrent();
  const accounts = await injected.request({ method: "eth_accounts" }) as string[];
  if (!accounts.some(address => address.toLowerCase() === wallet.toLowerCase()) || BigInt(String(await injected.request({ method: "eth_chainId" }))) !== BigInt(chainMatch[1])) throw new Error("钱包账号或网络已变化，请重新签名登录。");
  assertCurrent();
  await hostedRequest("/auth/login", "POST", { challengeId: challenge.id, signature });
  assertCurrent();
  return wallet;
}
