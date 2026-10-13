import assert from "node:assert/strict";
import type { Contracts } from "../frontend/lib/types.js";
import type { HostedFinance } from "../services/hosted-agents/src/types.js";

type Finance = Extract<HostedFinance, { status: "confirmed" }>;
interface Entry { kind: string; financeBefore: Finance; financeAfter: Finance }
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();
const hash = (value: unknown) => assert.match(String(value), /^0x[0-9a-f]{64}$/i, "Canonical transaction/block hash required");

/** Consume the root's public canonical audit without initiating RPC or recovery.
 * ClosedByRefund history explains an extra owned task, never a success or repayment. */
export function verifyTempoBrowserAudit(value: unknown, contracts: Contracts, entries: Entry[]) {
  const audit = value as any;
  assert.equal(audit?.version, 1); assert.equal(audit?.passed, true); assert.equal(String(audit?.chainId), "42431");
  hash(audit.block?.hash); assert.ok(Number.isSafeInteger(audit.block?.number));
  for (const name of ["account", "manager", "adapter", "escrow"] as const) assert.ok(same(audit.contracts?.[name] ?? "", contracts[name]), `Canonical ${name} differs from the active deployment`);
  const hasValidationAgent = entries.some(entry => entry.kind === "autonomy-validation");
  const expectedSuccesses = (kind: string) => kind === "autonomy-validation" ? 2 : kind === "autonomy" && !hasValidationAgent ? 2 : 1;
  assert.ok(Array.isArray(audit.taskResults) && audit.taskResults.length === entries.reduce((sum, entry) => sum + expectedSuccesses(entry.kind), 0), "Every participant needs its own expected successful tasks");
  assert.ok(Array.isArray(audit.fullTaskLedger)); assert.ok(Array.isArray(audit.agents));
  const taskIds = new Set<string>();
  for (const result of audit.taskResults) {
    assert.equal(result.taskStatus, "3"); assert.equal(result.loanStatus, "2");
    assert.equal(result.receipt?.status, 1); assert.equal(String(result.receipt?.chainId), "42431"); hash(result.receipt?.hash);
    assert.ok(!taskIds.has(result.taskId), "A successful task cannot be counted twice"); taskIds.add(result.taskId);
    const task = audit.fullTaskLedger.find((row: any) => String(row.taskId) === result.taskId);
    assert.ok(task); assert.equal(task.agentId, result.agentId); assert.equal(task.status, "3"); assert.equal(task.loanStatus, "2");
  }
  const compensation = audit.compensation;
  if (compensation !== undefined) {
    assert.equal(compensation.verified, true); assert.equal(compensation.originalInferenceState, "Unknown");
    assert.equal(compensation.ledgerSealed, true); assert.equal(compensation.noRepaymentOrDefaultCredit, true);
    assert.equal(compensation.taskStatus, "4"); assert.equal(compensation.loanStatus, "4");
    assert.equal(compensation.fullRefundRaw, "120000"); assert.equal(compensation.rewardReturnedRaw, "150000");
    assert.equal(compensation.refund?.status, 1); assert.equal(compensation.termination?.status, 1);
    hash(compensation.refund?.txHash); hash(compensation.termination?.txHash);
    assert.ok(!taskIds.has(compensation.taskId), "Unknown/refunded history cannot be a successful task");
    const task = audit.fullTaskLedger.find((row: any) => String(row.taskId) === compensation.taskId);
    assert.ok(task); assert.equal(task.agentId, compensation.agentId); assert.equal(task.status, "4"); assert.equal(task.loanStatus, "4");
  }
  const labels: Record<string, { successfulTaskIds: string[]; compensatedTaskIds: string[] }> = {};
  for (const entry of entries) {
    const before = entry.financeBefore, after = entry.financeAfter, id = after.agentId;
    assert.equal(before.chainId, "42431"); assert.equal(after.chainId, "42431");
    assert.equal(before.agentId, id); assert.ok(same(before.wallet, after.wallet)); assert.equal(after.debtRaw, "0");
    const canonical = audit.agents.find((agent: any) => agent.label === entry.kind && agent.agentId === id);
    assert.ok(canonical, `${entry.kind} missing from canonical audit`);
    for (const [actual, expected] of [[after.cashRaw, canonical.cash], [after.counts.repayments, canonical.repayments], [after.counts.defaults, canonical.defaults],
      [after.counts.successes, canonical.successCount], [after.counts.mirrorRepayments, canonical.repaymentFeedbackCount]]) assert.equal(actual, expected);
    const successful = audit.taskResults.filter((task: any) => task.agentId === id);
    assert.equal(successful.length, expectedSuccesses(entry.kind), `${entry.kind} needs its own successful task receipts`);
    assert.equal(BigInt(after.counts.successes) - BigInt(before.counts.successes), BigInt(successful.length));
    assert.equal(BigInt(after.counts.repayments) - BigInt(before.counts.repayments), BigInt(successful.length));
    assert.equal(after.counts.defaults, before.counts.defaults); assert.equal(after.counts.mirrorDefaults, before.counts.mirrorDefaults);
    const owned = audit.fullTaskLedger.filter((task: any) => task.agentId === id);
    const closed = owned.filter((task: any) => !taskIds.has(String(task.taskId)));
    for (const task of owned) { assert.equal(task.principal, "0"); assert.equal(task.fee, "0"); }
    for (const task of closed) assert.ok(compensation && String(task.taskId) === compensation.taskId && id === compensation.agentId, "Every non-successful owned task needs verified compensation and independent termination");
    assert.equal(after.scannedTaskCount, audit.fullTaskLedger.length, "Finance must include the full task ledger");
    assert.equal(after.ownedTaskCount, owned.length); assert.equal(after.ownedTaskCount - before.ownedTaskCount, successful.length + closed.length);
    labels[entry.kind] = { successfulTaskIds: successful.map((task: any) => task.taskId), compensatedTaskIds: closed.map((task: any) => String(task.taskId)) };
  }
  return { source: "root canonical audit", block: audit.block, labels, unknownHistoryCountedAsSuccess: false };
}
