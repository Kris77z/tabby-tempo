import { createHash } from "node:crypto";
import { canonical, type Json } from "../../packages/sdk/src/protocol.js";
import type { StrategyHistoryEntry } from "../../services/hosted-agents/src/strategy-types.js";

/** Local-only deterministic controller. These types are never accepted by a hosted API. */
export interface LocalPolicy {
  version: 1; id: string; chainId: "31337"; maxTasks: number;
  totalSpendRaw: string; maxPaymentRaw: string; reserveCashRaw: string; minProfitRaw: string; minMarginBps: string;
  coldStartCushionRaw: string; coldStartMaxPriceRaw: string; maxObservationAgeMs: number;
  startedAtMs: number; deadlineMs: number; allowedProviderIds: string[];
}
export interface LocalCandidate {
  source: "local-chain-and-provider-quote"; taskId: string; problemId: string; providerId: string; tier: "cheap";
  routeBinding: string; rewardRaw: string; escrowBalanceRaw: string; protocolFeeBps: string; taskStatus: string;
  deadlineMs: number; observedAtMs: number; blockNumber: number; blockHash: string;
  quote: { priceRaw: string; paymentId: string; requestDigest: string; expiresAtMs: number };
}
export interface LocalDecisionInput {
  policy: Readonly<LocalPolicy>; nowMs: number; cashRaw: string; debtRaw: string; spentRaw: string;
  completedTasks: number; unresolved: boolean; candidates: LocalCandidate[]; history: StrategyHistoryEntry[];
}
export interface LocalAssessment {
  taskId: string; providerId: string; routeBinding: string; status: "eligible" | "rejected";
  reasons: string[]; gaps: string[]; comparableCount: number; failedComparableCount: number;
  coldStart: boolean; quotedCostRaw: string; costBufferRaw: string; failureCushionRaw: string;
  coldStartCushionRaw: string; netRevenueRaw: string; completionProfitRaw: string; requiredProfitRaw: string; surplusRaw: string;
}
export interface LocalDecision {
  policyHash: string; status: "selected" | "stopped"; stopReason?: string;
  selectedTaskId?: string; selectedCandidateHash?: string; candidates: LocalAssessment[];
}
const raw = (n: unknown): n is string => typeof n === "string" && /^(0|[1-9][0-9]{0,77})$/.test(n) && BigInt(n) < 1n << 256n;
const integer = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
const hex = (n: unknown, prefix = false) => typeof n === "string" && (prefix ? /^0x[a-f0-9]{64}$/i : /^[a-f0-9]{64}$/).test(n);
const object = (n: unknown, keys: string[]) => !!n && typeof n === "object" && !Array.isArray(n) && Object.keys(n).length === keys.length && Object.keys(n).every(k => keys.includes(k));
const max = (a: bigint, b: bigint) => a > b ? a : b;
const digest = (n: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(n)) as Json)).digest("hex");
const invalid = (): never => { throw Error("LOCAL_CONTROLLER_INPUT_INVALID"); };

export function freezePolicy(input: LocalPolicy): Readonly<LocalPolicy> {
  if (!object(input, ["version", "id", "chainId", "maxTasks", "totalSpendRaw", "maxPaymentRaw", "reserveCashRaw", "minProfitRaw", "minMarginBps", "coldStartCushionRaw", "coldStartMaxPriceRaw", "maxObservationAgeMs", "startedAtMs", "deadlineMs", "allowedProviderIds"]) ||
    input.version !== 1 || input.chainId !== "31337" || !/^[a-z0-9-]{1,64}$/.test(input.id) ||
    ![input.totalSpendRaw, input.maxPaymentRaw, input.reserveCashRaw, input.minProfitRaw, input.minMarginBps, input.coldStartCushionRaw, input.coldStartMaxPriceRaw].every(raw) ||
    BigInt(input.maxPaymentRaw) === 0n || BigInt(input.maxPaymentRaw) > BigInt(input.totalSpendRaw) || BigInt(input.coldStartMaxPriceRaw) > BigInt(input.maxPaymentRaw) ||
    BigInt(input.minMarginBps) > 10000n || !integer(input.maxTasks) || input.maxTasks < 1 || input.maxTasks > 32 ||
    !integer(input.startedAtMs) || !integer(input.deadlineMs) || input.deadlineMs <= input.startedAtMs || input.deadlineMs - input.startedAtMs > 300000 ||
    !integer(input.maxObservationAgeMs) || input.maxObservationAgeMs < 1 || input.maxObservationAgeMs > 30000 ||
    !Array.isArray(input.allowedProviderIds) || !input.allowedProviderIds.length || input.allowedProviderIds.length > 8 ||
    input.allowedProviderIds.some(id => typeof id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(id)) || new Set(input.allowedProviderIds).size !== input.allowedProviderIds.length) invalid();
  const policy = structuredClone(input); Object.freeze(policy.allowedProviderIds); return Object.freeze(policy);
}
export function policyHash(policy: Readonly<LocalPolicy>) { return digest(freezePolicy(policy as LocalPolicy)); }
export function candidateHash(candidate: LocalCandidate) {
  // Observation time/block may advance; the original task, route and quote stay bound.
  const { observedAtMs: _at, blockNumber: _number, blockHash: _hash, ...bound } = candidate;
  return digest(bound);
}

function validateCandidate(c: LocalCandidate) {
  if (!object(c, ["source", "taskId", "problemId", "providerId", "tier", "routeBinding", "rewardRaw", "escrowBalanceRaw", "protocolFeeBps", "taskStatus", "deadlineMs", "observedAtMs", "blockNumber", "blockHash", "quote"]) ||
    c.source !== "local-chain-and-provider-quote" || !raw(c.taskId) || c.taskId === "0" || !/^[a-z][a-z0-9-]{0,63}$/.test(c.problemId) || !/^[A-Za-z0-9._-]{1,64}$/.test(c.providerId) || c.tier !== "cheap" || !hex(c.routeBinding) ||
    ![c.rewardRaw, c.escrowBalanceRaw, c.protocolFeeBps, c.taskStatus].every(raw) || BigInt(c.protocolFeeBps) > 10000n ||
    ![c.deadlineMs, c.observedAtMs, c.blockNumber].every(integer) || !hex(c.blockHash, true) ||
    !object(c.quote, ["priceRaw", "paymentId", "requestDigest", "expiresAtMs"]) || !raw(c.quote.priceRaw) || c.quote.priceRaw === "0" ||
    !hex(c.quote.paymentId, true) || !hex(c.quote.requestDigest, true) || !integer(c.quote.expiresAtMs)) invalid();
}

export function decideLocal(input: LocalDecisionInput): LocalDecision {
  const p = freezePolicy(input.policy as LocalPolicy);
  if (![input.cashRaw, input.debtRaw, input.spentRaw].every(raw) || !integer(input.nowMs) || !integer(input.completedTasks) || typeof input.unresolved !== "boolean" ||
    !Array.isArray(input.candidates) || input.candidates.length > 32 || !Array.isArray(input.history) || input.history.length > 200) invalid();
  input.candidates.forEach(validateCandidate);
  for (const h of input.history) {
    if (!h || !["succeeded", "failed", "pending", "unknown"].includes(h.outcome) || !Number.isFinite(Date.parse(h.at)) || Date.parse(h.at) < 0 ||
      !h.realized || !["confirmed", "pending", "incomplete"].includes(h.realized.status) || !raw(h.realized.executionCostRaw) ||
      h.realized.failureLossRaw !== null && !raw(h.realized.failureLossRaw) ||
      h.executionCostDeviationRaw !== null && (typeof h.executionCostDeviationRaw !== "string" || !/^-?(0|[1-9][0-9]{0,77})$/.test(h.executionCostDeviationRaw)) ||
      h.prediction && (h.prediction.source !== "original-workflow-admission" || !integer(h.prediction.atMs) || !hex(h.prediction.routeBinding) ||
        !raw(h.prediction.executionCostRaw) || !raw(h.prediction.planningCostRaw) || !["cash", "task-credit", "reward-tokens", "inference-allowance"].includes(h.prediction.funding))) invalid();
  }
  const keys = input.candidates.map(c => `${c.taskId}:${c.providerId}:${c.tier}`); if (new Set(keys).size !== keys.length) invalid();
  let stopReason = input.unresolved || input.history.some(h => h.outcome === "pending" || h.outcome === "unknown" || h.realized.status !== "confirmed") ? "UNRESOLVED_PAYMENT_OR_HISTORY"
    : input.nowMs < p.startedAtMs || input.nowMs >= p.deadlineMs ? "TIME_LIMIT"
    : input.completedTasks >= p.maxTasks ? "TASK_LIMIT"
    : BigInt(input.spentRaw) >= BigInt(p.totalSpendRaw) ? "TOTAL_SPEND_LIMIT"
    : BigInt(input.debtRaw) > 0n ? "OUTSTANDING_DEBT" : undefined;
  const candidates: LocalAssessment[] = input.candidates.map(c => {
    const history = input.history.filter(h => h.prediction && h.prediction.routeBinding === c.routeBinding && h.prediction.problemId === c.problemId && h.prediction.providerId === c.providerId && h.prediction.tier === c.tier && h.prediction.funding === "cash" &&
      h.realized.status === "confirmed" && h.executionCostDeviationRaw !== null && Number.isFinite(Date.parse(h.at)) && Date.parse(h.at) <= input.nowMs && h.prediction.atMs <= Date.parse(h.at));
    const failures = history.filter(h => h.outcome === "failed");
    const costBuffer = history.reduce((v, h) => max(v, BigInt(h.executionCostDeviationRaw!)), 0n);
    const failureCushion = failures.reduce((v, h) => max(v, BigInt(h.realized.failureLossRaw ?? "0")), 0n);
    const coldStart = history.length === 0, cold = coldStart ? BigInt(p.coldStartCushionRaw) : 0n;
    const netRevenue = BigInt(c.rewardRaw) - BigInt(c.rewardRaw) * BigInt(c.protocolFeeBps) / 10000n;
    const profit = netRevenue - BigInt(c.quote.priceRaw) - costBuffer;
    const required = max(BigInt(p.minProfitRaw), (netRevenue * BigInt(p.minMarginBps) + 9999n) / 10000n) + failureCushion + cold;
    const reasons: string[] = [], gaps: string[] = [];
    if (!p.allowedProviderIds.includes(c.providerId)) reasons.push("PROVIDER_NOT_ALLOWED");
    if (c.taskStatus !== "1") reasons.push("TASK_NOT_OPEN");
    if (BigInt(c.escrowBalanceRaw) < BigInt(c.rewardRaw) || c.rewardRaw === "0") reasons.push("TASK_NOT_FUNDED");
    if (c.observedAtMs > input.nowMs || input.nowMs - c.observedAtMs > p.maxObservationAgeMs) reasons.push("OBSERVATION_STALE");
    if (input.nowMs >= c.deadlineMs || input.nowMs >= c.quote.expiresAtMs) reasons.push("QUOTE_OR_TASK_EXPIRED");
    if (BigInt(c.quote.priceRaw) + costBuffer > BigInt(p.maxPaymentRaw)) reasons.push("PAYMENT_LIMIT");
    if (BigInt(input.spentRaw) + BigInt(c.quote.priceRaw) + costBuffer > BigInt(p.totalSpendRaw)) reasons.push("TOTAL_SPEND_LIMIT");
    if (BigInt(input.cashRaw) - BigInt(input.debtRaw) - BigInt(c.quote.priceRaw) - costBuffer < BigInt(p.reserveCashRaw)) reasons.push("CASH_RESERVE");
    if (coldStart) { gaps.push("NO_COMPARABLE_HISTORY_CONSERVATIVE_COLD_START"); if (BigInt(c.quote.priceRaw) > BigInt(p.coldStartMaxPriceRaw)) reasons.push("COLD_START_PRICE_LIMIT"); }
    if (failures.some(h => h.realized.failureLossRaw === null)) reasons.push("FAILURE_LOSS_UNKNOWN");
    if (profit < required) reasons.push("MINIMUM_PROFIT");
    if (stopReason) reasons.push(stopReason);
    return { taskId: c.taskId, providerId: c.providerId, routeBinding: c.routeBinding, status: reasons.length ? "rejected" : "eligible", reasons: [...new Set(reasons)].sort(), gaps,
      comparableCount: history.length, failedComparableCount: failures.length, coldStart, quotedCostRaw: c.quote.priceRaw, costBufferRaw: String(costBuffer), failureCushionRaw: String(failureCushion), coldStartCushionRaw: String(cold),
      netRevenueRaw: String(netRevenue), completionProfitRaw: String(profit), requiredProfitRaw: String(required), surplusRaw: String(profit - required) };
  });
  const eligible = candidates.filter(c => c.status === "eligible").sort((a, b) => {
    const delta = BigInt(b.surplusRaw) - BigInt(a.surplusRaw); return delta > 0n ? 1 : delta < 0n ? -1 : BigInt(a.taskId) < BigInt(b.taskId) ? -1 : BigInt(a.taskId) > BigInt(b.taskId) ? 1 : a.providerId.localeCompare(b.providerId);
  });
  const selected = eligible[0];
  if (!selected && !stopReason) stopReason = candidates.some(c => c.reasons.includes("CASH_RESERVE")) ? "CASH_RESERVE" : "NO_ELIGIBLE_CANDIDATE";
  return { policyHash: policyHash(p), status: selected ? "selected" : "stopped", ...(stopReason ? { stopReason } : {}),
    ...(selected ? { selectedTaskId: selected.taskId, selectedCandidateHash: candidateHash(input.candidates.find(c => c.taskId === selected.taskId && c.providerId === selected.providerId)!) } : {}), candidates };
}

/** Before any new execution, all limits and the exact original task/route/quote must still hold. */
export function preflightLocal(input: LocalDecisionInput & { decision: LocalDecision }): LocalCandidate {
  if (input.decision.policyHash !== policyHash(input.policy)) throw Error("POLICY_CHANGED");
  if (input.decision.status !== "selected") throw Error("DECISION_NOT_EXECUTABLE");
  const candidate = input.candidates.find(c => c.taskId === input.decision.selectedTaskId && candidateHash(c) === input.decision.selectedCandidateHash);
  if (!candidate) throw Error("SELECTED_BINDING_CHANGED");
  const fresh = decideLocal(input);
  if (fresh.status !== "selected" || fresh.selectedCandidateHash !== input.decision.selectedCandidateHash) throw Error("PREFLIGHT_CONSTRAINT_CHANGED");
  return structuredClone(candidate);
}
