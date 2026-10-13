import { HostedError, type HostedAgent, type HostedFinance } from "./types.js";

const fail = (): never => { throw new HostedError("HOSTED_FINANCE_UNCONFIRMED", 503); };
function object(v: unknown, keys: string[]): asserts v is Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(key => !keys.includes(key))) fail();
}
const decimal = (v: unknown) => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const integer = (v: unknown) => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
export function validateHostedFinance(value: unknown, agent: HostedAgent, chainId: string): HostedFinance {
  object(value, ["status", "observedAt", "reason", "chainId", "agentId", "wallet", "block", "cashRaw", "debtRaw", "scannedTaskCount", "ownedTaskCount", "credit", "policy", "counts"]);
  if (typeof value.observedAt !== "string" || !Number.isFinite(Date.parse(value.observedAt))) fail();
  if (value.status === "unavailable") {
    if (typeof value.reason !== "string" || !/^HOSTED_[A-Z0-9_]{1,80}$/.test(value.reason)) fail();
    return { status: "unavailable", observedAt: value.observedAt, reason: value.reason };
  }
  if (value.status !== "confirmed" || value.chainId !== chainId || value.agentId !== agent.binding?.agentId || value.wallet !== agent.wallet) fail();
  object(value.block, ["number", "hash", "timestamp"]); object(value.credit, ["score", "tier", "tierCapRaw", "feeBps", "eligible", "rejection"]);
  object(value.policy, ["maxCashPerTxRaw", "maxDebtPerTxRaw", "maxDebtPerDayRaw", "ownerFrozen"]);
  object(value.counts, ["repayments", "defaults", "mirrorRepayments", "successes", "mirrorDefaults"]);
  if (![value.cashRaw, value.debtRaw, value.credit.tierCapRaw, value.credit.feeBps, value.counts.repayments, value.counts.defaults,
    value.counts.mirrorRepayments, value.counts.successes, value.counts.mirrorDefaults,
    value.policy.maxCashPerTxRaw, value.policy.maxDebtPerTxRaw, value.policy.maxDebtPerDayRaw].every(decimal) ||
    typeof value.credit.score !== "string" || !/^-?\d+$/.test(value.credit.score) || !["A", "B", "C"].includes(value.credit.tier) ||
    typeof value.credit.eligible !== "boolean" || typeof value.policy.ownerFrozen !== "boolean" ||
    !(value.credit.rejection === null || typeof value.credit.rejection === "string" && /^[A-Z][A-Z0-9_]{0,80}$/.test(value.credit.rejection)) ||
    ![value.block.number, value.block.timestamp, value.scannedTaskCount, value.ownedTaskCount].every(integer) ||
    typeof value.block.hash !== "string" || !/^0x[0-9a-f]{64}$/i.test(value.block.hash) || value.ownedTaskCount > value.scannedTaskCount) fail();
  return structuredClone(value) as HostedFinance;
}
