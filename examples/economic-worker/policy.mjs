import { createHash } from 'node:crypto';
import { canonical } from '@agentfuel/sdk/protocol';
export const hash = value => createHash('sha256').update(canonical(value)).digest('hex');
const max = (a, b) => a > b ? a : b;
const raw = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
export function freezePolicy(input) {
  const keys = ['version', 'id', 'chainId', 'maxTasks', 'totalSpendRaw', 'maxPaymentRaw', 'reserveCashRaw', 'minProfitRaw', 'coldStartCushionRaw', 'startedAtMs', 'deadlineMs'];
  if (!input || Object.keys(input).length !== keys.length || Object.keys(input).some(k => !keys.includes(k)) || !/^[a-z0-9-]{1,64}$/.test(input.id) || input?.version !== 1 || input.chainId !== '31337' || !Number.isSafeInteger(input.maxTasks) || input.maxTasks < 1 || input.maxTasks > 32 || !['totalSpendRaw', 'maxPaymentRaw', 'reserveCashRaw', 'minProfitRaw', 'coldStartCushionRaw'].every(k => raw(input[k])) || BigInt(input.maxPaymentRaw) <= 0n || BigInt(input.maxPaymentRaw) > BigInt(input.totalSpendRaw) || !Number.isSafeInteger(input.startedAtMs) || !Number.isSafeInteger(input.deadlineMs) || input.deadlineMs <= input.startedAtMs || input.deadlineMs - input.startedAtMs > 300000) throw Error('INVALID_POLICY');
  return Object.freeze(structuredClone(input));
}
export function decide(policy, input) {
  freezePolicy(policy);
  if (!['cashRaw', 'spentRaw', 'reservedRaw'].every(k => raw(input[k])) || typeof input.unresolved !== 'boolean' || input.candidates.length > 32 || input.history.length > 32 || !Array.isArray(input.history) || !Array.isArray(input.candidates) || !Number.isSafeInteger(input.nowMs)) throw Error('INVALID_OBSERVATION');
  for (const h of input.history) if (!h || !['sum-integers', 'balanced-brackets'].includes(h.problemId) || !['succeeded', 'failed', 'refunded'].includes(h.outcome) || !['chargedRaw', 'refundedRaw', 'revenueRaw'].every(k => raw(h[k])) || BigInt(h.refundedRaw) > BigInt(h.chargedRaw)) throw Error('INVALID_HISTORY');
  const ids = input.candidates.map(c => c.taskId);
  if (new Set(ids).size !== ids.length) throw Error('INVALID_CANDIDATE');
  const stopReason = input.unresolved ? 'UNRESOLVED_PAYMENT_OR_HISTORY' : input.nowMs < policy.startedAtMs || input.nowMs >= policy.deadlineMs ? 'TIME_LIMIT' : input.history.length >= policy.maxTasks ? 'TASK_LIMIT' : BigInt(input.spentRaw) >= BigInt(policy.totalSpendRaw) ? 'TOTAL_SPEND_LIMIT' : null;
  const assessments = input.candidates.map(c => {
    if (!c || !['sum-integers', 'balanced-brackets'].includes(c.problemId) || !raw(c.taskId) || c.taskId === '0' || !['deadlineMs', 'expiresAtMs', 'observedAtMs', 'blockNumber'].every(k => Number.isSafeInteger(c[k]) && c[k] >= 0) || !/^0x[a-f0-9]{64}$/i.test(c.blockHash) || !/^0x[a-f0-9]{64}$/i.test(c.paymentId) || !/^0x[a-f0-9]{64}$/i.test(c.requestDigest) || !raw(c.status) || !['rewardRaw', 'escrowBalanceRaw', 'priceRaw', 'protocolFeeBps'].every(k => raw(c[k])) || c.priceRaw === '0' || BigInt(c.protocolFeeBps) > 10000n) throw Error('INVALID_CANDIDATE');
    const comparable = input.history.filter(h => h.problemId === c.problemId),
      failures = comparable.filter(h => h.outcome === 'failed');
    const coldStart = comparable.length === 0,
      failureCushion = failures.reduce((n, h) => max(n, BigInt(h.chargedRaw) - BigInt(h.refundedRaw)), 0n);
    const netRevenue = BigInt(c.rewardRaw) - BigInt(c.rewardRaw) * BigInt(c.protocolFeeBps) / 10000n;
    const required = BigInt(policy.minProfitRaw) + failureCushion + (coldStart ? BigInt(policy.coldStartCushionRaw) : 0n),
      profit = netRevenue - BigInt(c.priceRaw);
    const reasons = [];
    if (stopReason) reasons.push(stopReason);
    if (c.status !== '1') reasons.push('TASK_NOT_OPEN');
    if (BigInt(c.rewardRaw) === 0n || BigInt(c.escrowBalanceRaw) < BigInt(c.rewardRaw)) reasons.push('TASK_NOT_FUNDED');
    if (input.nowMs >= c.deadlineMs || input.nowMs >= c.expiresAtMs) reasons.push('QUOTE_OR_TASK_EXPIRED');
    if (c.observedAtMs > input.nowMs || input.nowMs - c.observedAtMs > 10000) reasons.push('OBSERVATION_STALE');
    if (BigInt(c.priceRaw) > BigInt(policy.maxPaymentRaw)) reasons.push('PAYMENT_LIMIT');
    if (BigInt(input.spentRaw) + BigInt(input.reservedRaw) + BigInt(c.priceRaw) > BigInt(policy.totalSpendRaw)) reasons.push('TOTAL_SPEND_LIMIT');
    if (BigInt(input.cashRaw) - BigInt(input.reservedRaw) - BigInt(c.priceRaw) < BigInt(policy.reserveCashRaw)) reasons.push('CASH_RESERVE');
    if (profit < required) reasons.push('MINIMUM_PROFIT');
    return {
      taskId: c.taskId,
      problemId: c.problemId,
      coldStart,
      comparableCount: comparable.length,
      failedComparableCount: failures.length,
      failureCushionRaw: String(failureCushion),
      netRevenueRaw: String(netRevenue),
      requiredProfitRaw: String(required),
      completionProfitRaw: String(profit),
      surplusRaw: String(profit - required),
      reasons,
      status: reasons.length ? 'rejected' : 'eligible'
    };
  });
  const eligible = assessments.filter(a => a.status === 'eligible').sort((a, b) => BigInt(a.surplusRaw) === BigInt(b.surplusRaw) ? Number(BigInt(a.taskId) - BigInt(b.taskId)) : BigInt(a.surplusRaw) > BigInt(b.surplusRaw) ? -1 : 1);
  return {
    status: eligible.length ? 'selected' : 'stopped',
    selectedTaskId: eligible[0]?.taskId ?? null,
    stopReason: eligible.length ? null : stopReason ?? 'NO_ELIGIBLE_CANDIDATE',
    assessments
  };
}
