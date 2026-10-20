import type { HostedAccounting, HostedAccountingEntry } from "../../services/hosted-agents/src/types.js";

const moneyFields = ["taskRevenueRaw", "inferenceCostRaw", "borrowingFeeRaw", "refundsRaw", "gameSubsidyRaw", "ownerCapitalRaw", "startupCapitalRaw", "loanPrincipalRaw"] as const;
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HOSTED_ACCOUNTING_INVALID");
  return value as Record<string, unknown>;
}
function text(value: unknown, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) throw new Error("HOSTED_ACCOUNTING_INVALID");
  return value;
}
function count(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error("HOSTED_ACCOUNTING_INVALID");
  return value;
}
function timestamp(value: unknown): string {
  const result = text(value, /^.{1,40}$/);
  if (!Number.isFinite(Date.parse(result))) throw new Error("HOSTED_ACCOUNTING_INVALID");
  return result;
}
function reasons(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > 40) throw new Error("HOSTED_ACCOUNTING_INVALID");
  return value.map(item => text(item, /^ACCOUNTING_[A-Z_]{1,80}$/));
}
function amounts(value: Record<string, unknown>) {
  return Object.fromEntries(moneyFields.map(key => [key, text(value[key], /^(0|[1-9][0-9]{0,77})$/)])) as Pick<HostedAccountingEntry, typeof moneyFields[number]>;
}
/** Validate and project every nested field; arbitrary adapter state never reaches the browser. */
export function projectHostedAccounting(value: unknown): HostedAccounting {
  const input = record(value), totals = record(input.totals), coverage = record(input.coverage);
  if (input.version !== 1 || !["USDC", "PathUSD"].includes(String(input.currency)) || input.decimals !== 6 || !["complete", "partial"].includes(String(input.status)) || coverage.scope !== "retained-hosted-history" || !Array.isArray(input.entries) || input.entries.length > 200 || typeof coverage.entriesTruncated !== "boolean") throw new Error("HOSTED_ACCOUNTING_INVALID");
  if (input.costScope !== undefined && input.costScope !== "settlement-asset-only" || input.chainFeesRaw !== undefined && input.chainFeesRaw !== null || input.actualProfitRaw !== undefined && input.actualProfitRaw !== null) throw new Error("HOSTED_ACCOUNTING_INVALID");
  const netOperatingRaw = totals.netOperatingRaw === null ? null : text(totals.netOperatingRaw, /^-?(0|[1-9][0-9]{0,77})$/);
  if (input.status === "partial" && netOperatingRaw !== null) throw new Error("HOSTED_ACCOUNTING_INVALID");
  const entryCount = count(coverage.entryCount), pendingCount = count(coverage.pendingCount), incompleteCount = count(coverage.incompleteCount), returnedEntryCount = count(coverage.returnedEntryCount);
  const uncoveredSpentRaw = text(coverage.uncoveredSpentRaw, /^(0|[1-9][0-9]{0,77})$/), coverageReasons = reasons(coverage.reasons);
  if (pendingCount + incompleteCount > entryCount || returnedEntryCount !== input.entries.length || returnedEntryCount > entryCount || coverage.entriesTruncated !== (returnedEntryCount < entryCount) || input.status === "complete" && (pendingCount > 0 || incompleteCount > 0 || BigInt(uncoveredSpentRaw) > 0n || coverageReasons.length > 0)) throw new Error("HOSTED_ACCOUNTING_INVALID");
  const entries = input.entries.map(value => {
    const entry = record(value);
    const action = text(entry.action, /^(provision|deposit|task|metered-task|reward-task|game|credits|goal|autonomous|planning)$/) as HostedAccountingEntry["action"];
    const status = text(entry.status, /^(confirmed|pending|incomplete)$/) as HostedAccountingEntry["status"];
    return { id: text(entry.id, /^[\w:.-]{1,200}$/), requestId: text(entry.requestId, /^[\w-]{1,100}$/),
      ...(entry.parentRequestId === undefined ? {} : { parentRequestId: text(entry.parentRequestId, /^[\w-]{1,100}$/) }), action, status, at: timestamp(entry.at),
      ...amounts(entry), creditsGranted: count(entry.creditsGranted), creditsUsed: count(entry.creditsUsed), reasons: reasons(entry.reasons),
      ...(entry.taskId === undefined ? {} : { taskId: text(entry.taskId, /^[0-9]{1,78}$/) }),
      ...(entry.paymentId === undefined ? {} : { paymentId: text(entry.paymentId, /^0x[0-9a-f]{64}$/i) }),
      ...(entry.txHash === undefined ? {} : { txHash: text(entry.txHash, /^0x[0-9a-f]{64}$/i) }) };
  });
  return { version: 1, observedAt: timestamp(input.observedAt), agentId: text(input.agentId, /^[\w-]{1,80}$/), currency: input.currency as HostedAccounting["currency"], decimals: 6, costScope: "settlement-asset-only", chainFeesRaw: null, actualProfitRaw: null,
    status: input.status as HostedAccounting["status"], totals: { ...amounts(totals), creditsGranted: count(totals.creditsGranted), creditsUsed: count(totals.creditsUsed), netOperatingRaw },
    coverage: { scope: "retained-hosted-history", since: coverage.since === null ? null : timestamp(coverage.since), runCount: count(coverage.runCount), entryCount, pendingCount, incompleteCount, returnedEntryCount, entriesTruncated: coverage.entriesTruncated, uncoveredSpentRaw, reasons: coverageReasons }, entries };
}

export const accountingReason: Record<string, string> = {
  ACCOUNTING_PENDING: "仍有请求处理中", ACCOUNTING_HISTORY_MISSING: "部分历史记录缺失", ACCOUNTING_HISTORY_INVALID: "部分历史记录无法核验",
  ACCOUNTING_HISTORY_LIMIT: "历史记录超过读取上限", ACCOUNTING_BINDING_MISMATCH: "部分记录的 Agent 身份不匹配",
  ACCOUNTING_SETTLEMENT_MISSING: "任务结算证据待核对", ACCOUNTING_PAYMENT_UNRESOLVED: "部分付款结果待确认", ACCOUNTING_BORROWING_FEE_UNKNOWN: "部分借款费待确认",
  ACCOUNTING_COST_MISMATCH: "部分费用记录不一致", ACCOUNTING_CAPITAL_UNKNOWN: "部分启动资金待确认", ACCOUNTING_DUPLICATE_PAYMENT: "存在重复付款记录", ACCOUNTING_DUPLICATE_TASK: "存在重复任务记录",
  ACCOUNTING_SUBSIDY_UNKNOWN: "部分游戏补贴数量待确认", ACCOUNTING_TOKEN_USAGE_UNKNOWN: "部分推理 token 用量未记录",
};
