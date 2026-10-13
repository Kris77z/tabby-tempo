import { Contract, Interface, JsonRpcProvider, type Log, type TransactionReceipt } from "ethers";
import { ACCOUNT_ABI, ESCROW_ABI, MANAGER_ABI, TOKEN_ABI } from "./abi";
import { publicConfig } from "./config";
import { createServerRpc, frontendTransport } from "./server-transport";
import type { CreditSnapshot, Dashboard, Deployment, EvidenceRow, EventDetail, Profile, TaskRow } from "./types";

const accountInterface = new Interface(ACCOUNT_ABI), escrowInterface = new Interface(ESCROW_ABI), managerInterface = new Interface(MANAGER_ABI);
const LOG_PAGE_BLOCKS = 100, RECENT_LOG_BLOCKS = 2_000;
const RPC_CONCURRENCY = 8;
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const decimal = (v: unknown) => typeof v === "string" && /^(0|[1-9]\d*)$/.test(v);
type ReadStage = "transport" | "chain" | "credit" | "code" | "decimals" | "blocks" | "logs" | "wiring" | "profile.accounting" | "profile.tasks" | "evidence" | "provider";
const READ_METHODS = new Set(["adapter", "agentAccount", "taskEscrow", "settlementAsset", "cash", "getPolicy", "nextTaskId", "getTask", "getLoan", "payableEscrow", "feedbackSent", "pendingFeedback", "providerWhitelist"]);
const ERROR_CODES = new Set(["UNKNOWN_ERROR", "SERVER_ERROR", "NETWORK_ERROR", "TIMEOUT", "CANCELLED", "BAD_DATA", "INVALID_ARGUMENT", "CALL_EXCEPTION", "UNSUPPORTED_OPERATION", "ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "ETIMEDOUT", "UNDERWRITER_HTTP_ERROR"]);

function logReadFailure(stage: ReadStage, error: unknown, method?: string) {
  const e = (error && typeof error === "object" ? error : {}) as {
    name?: unknown; code?: unknown; httpStatus?: unknown; status?: unknown; cause?: { code?: unknown };
    response?: { statusCode?: unknown }; error?: { code?: unknown }; info?: { responseStatus?: unknown; error?: { code?: unknown } };
  };
  const errorClass = ["Error", "TypeError", "RangeError", "SyntaxError", "AbortError", "TimeoutError"].find(name => name === e.name) ?? "UnknownError";
  const code = [e.code, e.cause?.code].find((value): value is string => typeof value === "string" && ERROR_CODES.has(value)) ?? "UNCLASSIFIED";
  const status = [e.httpStatus, e.status, e.response?.statusCode, e.info?.responseStatus].map(value =>
    typeof value === "string" ? Number(value.match(/^([1-5]\d{2})(?:\s|$)/)?.[1]) : value).find(value => typeof value === "number" && Number.isInteger(value) && value >= 100 && value <= 599);
  const rpcCode = [e.error?.code, e.info?.error?.code, e.code].find(value => typeof value === "number" && Number.isSafeInteger(value));
  // Never serialize the error itself: its message, stack and RPC payload may contain credentials.
  console.error("FRONTEND_READ_FAILED", JSON.stringify({ stage, method: method && READ_METHODS.has(method) ? method : undefined, errorClass, code, httpStatus: status, rpcCode }));
}

async function mapBounded<T, R>(values: readonly T[], action: (value: T) => Promise<R>, concurrency = RPC_CONCURRENCY): Promise<R[]> {
  const result: R[] = [];
  for (let i = 0; i < values.length; i += concurrency) result.push(...await Promise.all(values.slice(i, i + concurrency).map(action)));
  return result;
}

export function validateCredit(value: unknown, config: Deployment, agentId: string): CreditSnapshot {
  const c = value as CreditSnapshot;
  if (!c || c.agentId !== agentId || !c.configuration || !c.addresses || !c.identity || !c.terms || !c.truth || !c.mirror ||
    c.configuration.chainId !== config.chainId || !same(c.configuration.settlementAsset, config.asset.address) ||
    c.configuration.assetDecimals !== String(config.asset.decimals) ||
    !["manager", "adapter", "account", "escrow"].every(key => same(c.addresses[key as keyof Deployment["contracts"]] || "", config.contracts[key as keyof Deployment["contracts"]]))) {
    throw new Error(`Agent #${agentId} 的 Underwriter 网络、资产或合约与部署清单不一致。`);
  }
  if (![c.tierCap, c.identity.version, c.truth.repayment, c.truth.default, c.mirror.repayment, c.mirror.success, c.mirror.default,
    c.terms.feeBps, c.terms.capUsdCents, c.configuration.ltvBps].every(decimal) || !/^-?\d+$/.test(c.terms.score) ||
    !["A", "B", "C"].includes(c.terms.tier) || !c.block || !Number.isSafeInteger(c.block.number) || !/^0x[\da-f]{64}$/i.test(c.block.hash) ||
    [c.eligible, c.identity.changed, c.managerFrozen, c.accountFrozen, c.drawPaused].some(v => typeof v !== "boolean")) {
    throw new Error(`Agent #${agentId} 的 Underwriter 响应不完整。`);
  }
  return c;
}

async function credit(config: Deployment, agentId: string, timeoutMs: number): Promise<CreditSnapshot> {
  const response = await fetch(`${config.underwriterUrl}/agents/${agentId}/credit`, { cache: "no-store", signal: AbortSignal.timeout(timeoutMs), redirect: "error" });
  if (!response.ok) throw Object.assign(new Error(`Underwriter 读取 Agent #${agentId} 失败（HTTP ${response.status}）。`), { code: "UNDERWRITER_HTTP_ERROR", httpStatus: response.status });
  return validateCredit(await response.json(), config, agentId);
}

async function logs(provider: JsonRpcProvider, addresses: string[], from: number, to: number, chainId: string): Promise<Log[]> {
  if (from > to) throw new Error("deploymentBlock 晚于读取区块。");
  const starts = Array.from({ length: Math.ceil((to - from + 1) / LOG_PAGE_BLOCKS) }, (_, index) => from + index * LOG_PAGE_BLOCKS);
  // Tempo's public endpoint rate-limits concurrent historical log scans.
  // Keep every 100-block page in the complete recent window, but scan serially.
  const result = (await mapBounded(starts, start => provider.getLogs({ address: addresses, fromBlock: start, toBlock: Math.min(start + LOG_PAGE_BLOCKS - 1, to) }), chainId === "42431" ? 1 : 4)).flat();
  return result.sort((a, b) => a.blockNumber - b.blockNumber || a.index - b.index);
}

function parseLog(log: Log | TransactionReceipt["logs"][number], config: Deployment): EventDetail | null {
  const entry = same(log.address, config.contracts.account) ? ["AgentAccount", accountInterface] as const :
    same(log.address, config.contracts.escrow) ? ["TaskEscrow", escrowInterface] as const :
    same(log.address, config.contracts.manager) ? ["CreditManager", managerInterface] as const : null;
  if (!entry) return null;
  try {
    const parsed = entry[1].parseLog(log);
    if (!parsed) return null;
    const values: Record<string, string> = {};
    parsed.fragment.inputs.forEach((input, index) => { values[input.name || String(index)] = String(parsed.args[index]); });
    return { contract: entry[0], name: parsed.name, values };
  } catch { return null; }
}

export async function readDashboard(config: Deployment, createRpc = createServerRpc): Promise<Dashboard> {
  let stage: ReadStage = "transport", failedMethod: string | undefined;
  let connection: Awaited<ReturnType<typeof createServerRpc>> | undefined;
  try {
    const creditTimeoutMs = config.chainId === "42431" ? Math.max(frontendTransport().creditTimeoutMs, 60_000) : frontendTransport().creditTimeoutMs;
    connection = await createRpc(config.rpcUrl, undefined, config.chainId);
    const { provider } = connection;
    stage = "chain";
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(config.chainId)) throw new Error("RPC chainId 与部署清单不一致。");
    // One credit request already fans out inside Underwriter; never multiply that across agents.
    const snapshots: CreditSnapshot[] = [];
    stage = "credit";
    for (const agent of config.agents) snapshots.push(await credit(config, agent.id, creditTimeoutMs));
    const toBlock = Math.max(...snapshots.map(c => c.block.number));
    const fromBlock = Math.max(config.deploymentBlock, toBlock - RECENT_LOG_BLOCKS + 1);
    stage = "code";
    const contractCodes = await mapBounded(Object.values(config.contracts), a => provider.getCode(a, toBlock));
    if (contractCodes.some(c => c === "0x")) throw new Error("部署地址没有合约代码。");
    stage = "decimals";
    const assetDecimals = config.asset.address === "0x0000000000000000000000000000000000000000" ? 18n :
      await new Contract(config.asset.address, TOKEN_ABI, provider).getFunction("decimals").staticCall({ blockTag: toBlock });
    if (Number(assetDecimals) !== config.asset.decimals) throw new Error("链上资产 decimals 与清单不一致。");
    stage = "blocks";
    const chainBlocks = await mapBounded(snapshots, c => provider.getBlock(c.block.number));
    if (chainBlocks.some((b, i) => b?.hash !== snapshots[i].block.hash)) throw new Error("Underwriter 快照区块已变化，请刷新重试。");
    stage = "logs";
    const eventLogs = await logs(provider, [config.contracts.account, config.contracts.manager, config.contracts.escrow], fromBlock, toBlock, config.chainId);
    const account = new Contract(config.contracts.account, ACCOUNT_ABI, provider);
    const escrow = new Contract(config.contracts.escrow, ESCROW_ABI, provider);
    const manager = new Contract(config.contracts.manager, MANAGER_ABI, provider);
    let activeReads = 0;
    const waitingReads: (() => void)[] = [];
    const read = async (contract: Contract, method: string, args: unknown[], block: number) => {
      if (activeReads >= RPC_CONCURRENCY) await new Promise<void>(resolve => waitingReads.push(resolve)); else activeReads++;
      try { return await contract.getFunction(method).staticCall(...args, { blockTag: block }); }
      catch (error) { failedMethod ??= method; throw error; }
      finally { const next = waitingReads.shift(); if (next) next(); else activeReads--; }
    };
    stage = "wiring";
    const wiring = await mapBounded(["adapter", "agentAccount", "taskEscrow", "settlementAsset"], m => read(manager, m, [], toBlock));
    if (![config.contracts.adapter, config.contracts.account, config.contracts.escrow, config.asset.address].every((a, i) => same(a, wiring[i]))) throw new Error("Manager 接线与部署清单不一致。");
    const parsedLogs = eventLogs.map(log => ({ log, event: parseLog(log, config) })).filter(e => e.event !== null);
    const receiptCache = new Map<string, Promise<EvidenceRow>>();
    const evidenceFor = (log: Log, event: EventDetail): Promise<EvidenceRow> => {
      let pending = receiptCache.get(log.transactionHash);
      if (!pending) {
        pending = (async () => {
          const [receipt, transaction] = await Promise.all([provider.getTransactionReceipt(log.transactionHash), provider.getTransaction(log.transactionHash)]);
          if (!receipt) throw new Error("RPC 未返回交易回执。");
          let evidenceHash: string | undefined;
          if (transaction && transaction.to && same(transaction.to, config.contracts.account)) {
            try { const parsed = accountInterface.parseTransaction({ data: transaction.data }); if (parsed?.name === "payProvider") evidenceHash = parsed.args.auth.evidenceHash; } catch { /* other call */ }
          }
          const events = receipt.logs.map(l => parseLog(l, config)).filter((v): v is EventDetail => v !== null);
          return { hash: log.transactionHash, block: log.blockNumber,
            kind: event.name === "ProviderPaid" ? "payment" : event.name === "TaskSettled" ? "settlement" : event.name === "LoanDefaulted" ? "default" : "task",
            taskId: event.values.taskId, paymentId: event.values.paymentId, provider: event.values.provider,
            fromCash: event.values.fromCash, fromCredit: event.values.fromCredit,
            passed: event.name === "TaskSettled" ? event.values.passed === "true" : undefined,
            evidenceHash, receiptStatus: receipt.status ?? 0, events };
        })();
        receiptCache.set(log.transactionHash, pending);
      }
      return pending;
    };
    type TaskHeader = Omit<TaskRow, "netEscrow" | "loan" | "feedback">;
    const taskHeadersByBlock = new Map<number, Promise<TaskHeader[]>>();
    const taskHeadersAt = (block: number): Promise<TaskHeader[]> => {
      let pending = taskHeadersByBlock.get(block);
      if (!pending) {
        pending = (async () => {
          const next = BigInt(await read(escrow, "nextTaskId", [], block));
          // Enumerate the complete ledger at this snapshot, regardless of the recent event window.
          if (next > 201n) throw new Error("部署任务超过前端 P0 的 200 项读取上限；当前不显示可能低估的债务。");
          const ids = Array.from({ length: Number(next - 1n) }, (_, i) => String(i + 1));
          return mapBounded(ids, async id => {
            const t = await read(escrow, "getTask", [id], block);
            return { id, poster: t.poster, reward: String(t.reward), escrowBalance: String(t.escrowBalance), agentId: String(t.agentId),
              deadline: String(t.deadline), protocolFeeBps: String(t.protocolFeeBps), status: Number(t.status) };
          });
        })();
        taskHeadersByBlock.set(block, pending);
      }
      return pending;
    };
    const taskDetails = new Map<string, Promise<TaskRow>>();
    const readTasks = async (headers: TaskHeader[], block: number): Promise<TaskRow[]> => {
      return mapBounded(headers, async header => {
        const key = `${block}:${header.id}`;
        let pending = taskDetails.get(key);
        if (!pending) {
          pending = (async () => {
            const id = header.id;
            const [loan, net, successSent, repaymentSent, successPending, repaymentPending, defaultPending] = await mapBounded([
              () => read(manager, "getLoan", [id], block), () => read(escrow, "payableEscrow", [id], block),
              () => read(escrow, "feedbackSent", [id, 1], block), () => read(escrow, "feedbackSent", [id, 2], block),
              () => read(escrow, "pendingFeedback", [id, 1], block), () => read(escrow, "pendingFeedback", [id, 2], block), () => read(escrow, "pendingFeedback", [id, 3], block),
            ], operation => operation());
            return { ...header, netEscrow: String(net),
              loan: { principal: String(loan.principal), fee: String(loan.fee), dueAt: String(loan.loanDueAt), status: Number(loan.status) },
              feedback: { successSent, repaymentSent, successPending, repaymentPending, defaultPending } };
          })();
          taskDetails.set(key, pending);
        }
        return pending;
      });
    };
    // Each profile's accounting uses exactly its Underwriter block; later events cannot enter its totals.
    const profiles: Profile[] = [];
    for (const [index, c] of snapshots.entries()) {
      const block = c.block.number;
      const visible = parsedLogs.filter(e => e.log.blockNumber <= block);
      stage = "profile.accounting";
      const [cash, policy] = await Promise.all([read(account, "cash", [c.agentId], block), read(account, "getPolicy", [c.agentId], block)]);
      stage = "profile.tasks";
      const headers = await taskHeadersAt(block);
      const tasks = await readTasks(headers.filter(t => t.agentId === c.agentId), block);
      const ownedIds = new Set(tasks.map(t => t.id));
      const payments = visible.filter(e => e.event!.name === "ProviderPaid" && e.event!.values.agentId === c.agentId);
      const recent = visible.filter(e => e.event!.name === "ProviderPaid" ? e.event!.values.agentId === c.agentId :
        ["TaskSettled", "TaskAccepted", "LoanDefaulted"].includes(e.event!.name) && ownedIds.has(e.event!.values.taskId)).reverse();
      const unique = [...new Map(recent.map(e => [e.log.transactionHash, e])).values()].slice(0, 12);
      // Each evidence item needs receipt + transaction; four items keep leaf RPCs within eight.
      stage = "evidence";
      const evidence = await mapBounded(unique, e => evidenceFor(e.log, e.event!), RPC_CONCURRENCY / 2);
      const debt = tasks.reduce((n, t) => n + (t.loan.status === 1 ? BigInt(t.loan.principal) + BigInt(t.loan.fee) : 0n), 0n);
      profiles.push({ agent: config.agents[index], credit: c, cash: String(cash), debt: String(debt),
        policy: { maxCashPerTx: String(policy.maxCashPerTx), maxDebtPerTx: String(policy.maxDebtPerTx), maxDebtPerDay: String(policy.maxDebtPerDay), ownerFrozen: Boolean(policy.ownerFrozen) },
        tasks: tasks.reverse(), evidence,
        counts: { payments: payments.length, draws: payments.filter(e => BigInt(e.event!.values.fromCredit) > 0n).length,
          defaults: visible.filter(e => e.event!.name === "LoanDefaulted" && ownedIds.has(e.event!.values.taskId)).length } });
    }
    stage = "profile.tasks";
    const openTasks = await readTasks((await taskHeadersAt(toBlock)).filter(t => t.status === 1), toBlock);
    stage = "provider";
    const providers = await mapBounded(config.providers, async p => ({ ...p, allowed: Boolean(await read(account, "providerWhitelist", [p.address], toBlock)) }));
    return { mode: "chain", configured: true, readStatus: "confirmed", config: { ...publicConfig(config), providers }, profiles,
      openTasks: openTasks.reverse(), updatedAt: new Date().toISOString(), history: { fromBlock, toBlock, recent: fromBlock > config.deploymentBlock } };
  } catch (error) { logReadFailure(stage, error, failedMethod); throw error; }
  finally { connection?.close(); }
}
