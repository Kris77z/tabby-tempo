import assert from "node:assert/strict";
import test from "node:test";
import { decideLocal, freezePolicy, policyHash, preflightLocal } from "../lib/bounded-economy-policy.js";

// Independent policy tests use synthetic observations only. They prove the
// local controller's rejection boundaries, never chain or provider provenance.
const NOW = 1_800_000_000_000;
const HASH = "a".repeat(64);
const HASH2 = "b".repeat(64);
const CHAIN_HASH = `0x${"c".repeat(64)}`;
const requestId = "00000000-0000-4000-8000-000000000001";

function policy(patch: Record<string, unknown> = {}): any {
  return freezePolicy({ version: 1, id: "independent-audit", chainId: "31337", maxTasks: 3,
    totalSpendRaw: "1000", maxPaymentRaw: "500", reserveCashRaw: "100", minProfitRaw: "1", minMarginBps: "0",
    coldStartCushionRaw: "100", coldStartMaxPriceRaw: "100", maxObservationAgeMs: 1000,
    startedAtMs: NOW - 1000, deadlineMs: NOW + 60_000, allowedProviderIds: ["local-provider"], ...patch } as any);
}
function candidate(patch: Record<string, unknown> = {}): any {
  return { source: "local-chain-and-provider-quote", taskId: "2", problemId: "sum-integers", providerId: "local-provider", tier: "cheap", routeBinding: HASH,
    rewardRaw: "500", escrowBalanceRaw: "500", protocolFeeBps: "0", taskStatus: "1", deadlineMs: NOW + 30_000,
    quote: { priceRaw: "100", paymentId: `0x${"d".repeat(64)}`, requestDigest: `0x${"e".repeat(64)}`, expiresAtMs: NOW + 10_000 },
    observedAtMs: NOW, blockNumber: 100, blockHash: CHAIN_HASH, ...patch };
}
function input(patch: Record<string, unknown> = {}): any {
  return { policy: policy(), nowMs: NOW, cashRaw: "1000", debtRaw: "0", spentRaw: "0", completedTasks: 0,
    unresolved: false, candidates: [candidate()], history: [], ...patch };
}
function history(patch: Record<string, unknown> = {}): any {
  return { requestId, at: new Date(NOW - 5000).toISOString(), action: "task", outcome: "failed",
    prediction: { source: "original-workflow-admission", atMs: NOW - 6000, snapshotHash: HASH2, routeBinding: HASH,
      taskId: "1", problemId: "sum-integers", providerId: "local-provider", tier: "cheap", funding: "cash",
      executionCostRaw: "200", planningCostRaw: "0", borrowerFeeRaw: "0", netRevenueRaw: "500", netRewardRaw: "300", originalMinNetRewardRaw: "1" },
    realized: { status: "confirmed", executionCostRaw: "200", borrowingFeeRaw: "0", taskRevenueRaw: "0", planningCostRaw: "0",
      taskContributionRaw: "-200", netAfterPlanningRaw: "-200", failureLossRaw: "200", knownFailureLossLowerBoundRaw: "200" },
    executionCostDeviationRaw: "0", gaps: [], ...patch };
}
function notSelected(value: any, label: string) {
  try { assert.equal(decideLocal(value).status, "stopped", label); }
  catch (error) {
    if (error instanceof assert.AssertionError) throw error;
    assert.match(String((error as Error).message), /^[A-Z][A-Z0-9_]+$/, `${label}: rejected with a fixed diagnostic`);
  }
}

test("audit: policy is copied, deeply frozen, and hashes all execution bounds", () => {
  const source = { ...policy(), allowedProviderIds: ["local-provider"] };
  const saved = freezePolicy(source);
  source.allowedProviderIds.push("untrusted");
  assert.deepEqual(saved.allowedProviderIds, ["local-provider"]);
  assert.equal(Object.isFrozen(saved), true);
  assert.equal(Object.isFrozen(saved.allowedProviderIds), true);
  assert.notEqual(policyHash(saved), policyHash(policy({ reserveCashRaw: "101" })));
  assert.notEqual(policyHash(saved), policyHash(policy({ deadlineMs: NOW + 60_001 })));
});

test("audit: policy rejects nonlocal environments, unknown permissions and unsafe raw units", () => {
  for (const patch of [
    { chainId: "10143" }, { rpcUrl: "https://example.invalid" }, { privateKey: "not-a-secret" }, { allowCredit: true },
    { maxTasks: -1 }, { maxTasks: 1.5 }, { maxTasks: Number.MAX_SAFE_INTEGER + 1 },
    { totalSpendRaw: "01" }, { maxPaymentRaw: "-1" }, { reserveCashRaw: 1 }, { coldStartCushionRaw: "1.5" },
    { minMarginBps: "10001" }, { minProfitRaw: (1n << 256n).toString() },
    { maxObservationAgeMs: -1 }, { startedAtMs: NOW + 100_000 }, { deadlineMs: NOW - 100_001 },
    { allowedProviderIds: [] }, { allowedProviderIds: ["local-provider", "local-provider"] },
  ]) assert.throws(() => policy(patch), /LOCAL_CONTROLLER_INPUT_INVALID/, JSON.stringify(patch));
});

test("audit: cold start needs its explicit cushion and price cap", () => {
  assert.equal(decideLocal(input()).selectedTaskId, "2");
  notSelected(input({ candidates: [candidate({ rewardRaw: "200", escrowBalanceRaw: "200" })] }), "cold-start cushion");
  const costly = candidate(); costly.quote.priceRaw = "101";
  notSelected(input({ candidates: [costly] }), "cold-start price cap");
});

test("audit: cash, reserve, outstanding debt, total spend and payment limits reject separately", () => {
  for (const [label, patch] of [
    ["cash cannot be replaced by task credit", { cashRaw: "99" }],
    ["reserve is retained", { cashRaw: "199" }],
    ["outstanding debt is retained", { cashRaw: "300", debtRaw: "101" }],
    ["total budget", { spentRaw: "901" }],
    ["individual payment", { policy: policy({ maxPaymentRaw: "99", coldStartMaxPriceRaw: "99" }) }],
    ["completed task count", { completedTasks: 3 }],
  ] as const) notSelected(input(patch), label);
  assert.equal(decideLocal(input({ cashRaw: "200" })).status, "selected", "cash at the exact reserve boundary is usable");
  assert.equal(decideLocal(input({ spentRaw: "900" })).status, "selected", "budget equality is usable");
});

test("audit: unknown or pending original work blocks every new candidate", () => {
  notSelected(input({ unresolved: true }), "unknown liability");
  notSelected(input({ history: [history({ outcome: "pending", realized: { ...history().realized, status: "pending" } })] }), "pending history");
});

test("audit: deadline, task availability and observation freshness fail closed", () => {
  for (const [label, patch] of [
    ["controller deadline", { policy: policy({ deadlineMs: NOW }) }],
    ["controller has not started", { nowMs: NOW - 1001 }],
    ["stale observation", { candidates: [candidate({ observedAtMs: NOW - 1001 })] }],
    ["future observation", { candidates: [candidate({ observedAtMs: NOW + 1 })] }],
    ["expired task", { candidates: [candidate({ deadlineMs: NOW })] }],
    ["already accepted task", { candidates: [candidate({ taskStatus: "2" })] }],
    ["unfunded escrow", { candidates: [candidate({ escrowBalanceRaw: "499" })] }],
  ] as const) notSelected(input(patch), label);
  const expired = candidate(); expired.quote.expiresAtMs = NOW;
  notSelected(input({ candidates: [expired] }), "expired quote");
});

test("audit: a real comparable failure changes the next decision, unrelated routes do not inherit it", () => {
  const narrow = candidate({ rewardRaw: "250", escrowBalanceRaw: "250" });
  assert.equal(decideLocal(input({ candidates: [narrow] })).status, "selected");
  notSelected(input({ candidates: [narrow], history: [history()] }), "observed failure loss changes admission");
  const differentRoute = history(); differentRoute.prediction.routeBinding = HASH2;
  assert.equal(decideLocal(input({ candidates: [narrow], history: [differentRoute] })).status, "selected");
  const differentProblem = history(); differentProblem.prediction.problemId = "balanced-brackets";
  assert.equal(decideLocal(input({ candidates: [narrow], history: [differentProblem] })).status, "selected");
  const future = history({ at: new Date(NOW + 1).toISOString(), outcome: "succeeded" });
  notSelected(input({ candidates: [candidate({ rewardRaw: "200", escrowBalanceRaw: "200" })], history: [future] }), "future history cannot remove the cold-start cushion");
});

test("audit: malformed or non-original history cannot manufacture comparable evidence", () => {
  const marginal = candidate({ rewardRaw: "200", escrowBalanceRaw: "200" });
  for (const mutate of [
    (row: any) => { row.prediction.source = "owner-hypothetical"; row.outcome = "succeeded"; },
    (row: any) => { row.prediction.atMs = -1; row.outcome = "succeeded"; },
    (row: any) => { delete row.realized.failureLossRaw; },
    (row: any) => { row.realized.failureLossRaw = "-200"; },
    (row: any) => { row.executionCostDeviationRaw = "1.5"; row.outcome = "succeeded"; },
  ]) {
    const row = history(); mutate(row);
    notSelected(input({ candidates: [marginal], history: [row] }), "untrusted history cannot remove cold-start or failure protection");
  }
});

test("audit: self-declared hypothetical candidates and extra execution fields cannot enter the real candidate path", () => {
  for (const patch of [
    { source: "owner-hypothetical" }, { providerId: "outside-allowlist" }, { routeBinding: "" },
    { model: "invented-live-model" }, { executionCommand: "buy-again" }, { rewardRaw: "999999999", modelClaimedReward: true },
  ]) notSelected(input({ candidates: [candidate(patch)] }), JSON.stringify(patch));
});

test("audit: a shadow decision is deterministic and never mutates policy, observations or history", () => {
  const value = input({ history: [history()] }), before = structuredClone(value);
  const first = decideLocal(value), second = decideLocal(value);
  assert.deepEqual(first, second);
  assert.deepEqual(value, before);
});

test("audit: preflight binds every original task, route and quote field while allowing a fresh block", () => {
  const original = input(), decision = decideLocal(original);
  const fresh = structuredClone(original);
  fresh.nowMs++; fresh.candidates[0].observedAtMs++; fresh.candidates[0].blockNumber++;
  fresh.candidates[0].blockHash = `0x${"f".repeat(64)}`;
  assert.deepEqual(preflightLocal({ ...fresh, decision }), fresh.candidates[0]);
  for (const mutate of [
    (c: any) => { c.rewardRaw = "501"; c.escrowBalanceRaw = "501"; },
    (c: any) => { c.escrowBalanceRaw = "501"; },
    (c: any) => { c.taskStatus = "2"; },
    (c: any) => { c.deadlineMs++; },
    (c: any) => { c.protocolFeeBps = "1"; },
    (c: any) => { c.routeBinding = HASH2; },
    (c: any) => { c.problemId = "balanced-brackets"; },
    (c: any) => { c.quote.priceRaw = "99"; },
    (c: any) => { c.quote.priceRaw = "101"; },
    (c: any) => { c.quote.paymentId = `0x${"0".repeat(64)}`; },
    (c: any) => { c.quote.requestDigest = `0x${"0".repeat(64)}`; },
    (c: any) => { c.quote.expiresAtMs++; },
  ]) {
    const changed = structuredClone(fresh); mutate(changed.candidates[0]);
    assert.throws(() => preflightLocal({ ...changed, decision }), /SELECTED_BINDING_CHANGED/);
  }
});

test("audit: preflight rechecks current limits and does not buy another candidate when the selection changes", () => {
  const original = input(), decision = decideLocal(original);
  for (const patch of [
    { policy: policy({ reserveCashRaw: "101" }) }, { cashRaw: "199" }, { debtRaw: "1" },
    { spentRaw: "901" }, { completedTasks: 3 }, { nowMs: NOW + 60_000 }, { unresolved: true }, { history: [history()] },
  ]) {
    const current = { ...structuredClone(original), ...patch, decision };
    if (Object.hasOwn(patch, "history")) {
      current.history = [history({ executionCostDeviationRaw: "500" })];
    }
    assert.throws(() => preflightLocal(current));
  }
  const better = candidate({ taskId: "3", rewardRaw: "1000", escrowBalanceRaw: "1000" });
  const changed = { ...original, candidates: [...original.candidates, better], decision };
  assert.equal(decideLocal(changed).selectedTaskId, "3");
  assert.throws(() => preflightLocal(changed), /PREFLIGHT_CONSTRAINT_CHANGED/);
  assert.deepEqual(original, input(), "preflight never alters the saved original selection");
});
