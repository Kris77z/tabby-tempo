import assert from "node:assert/strict";
import test from "node:test";
import { assessHostedStrategyAdvice } from "../../services/hosted-agents/src/strategy-advice.js";
import type { StrategyAdviceInput, StrategyPreviewCandidate } from "../../services/hosted-agents/src/strategy-types.js";
import { hostedAgentsRequest } from "../lib/hosted-agents-proxy.js";
import { projectHostedStrategyAdvice, projectStrategyAdvicePreview } from "../lib/hosted-strategy-advice.js";

const at = "2026-10-17T00:00:00.000Z", origin = "http://127.0.0.1:3000", upstreamUrl = "http://127.0.0.1:8791", agentId = "11111111-1111-4111-8111-111111111111";
const token = "s".repeat(64), wallet = "0x" + "c".repeat(40), routeBinding = "a".repeat(64);
const previewCandidate: StrategyPreviewCandidate = { taskId: "10", problemId: "sum-integers", providerId: "controlled", tier: "cheap", funding: "cash", executionCostRaw: "100", planningCostRaw: "10",
  borrowerFeeBps: "1500", creditLimitRaw: "1000", rewardRaw: "1000", escrowBalanceRaw: "1000", protocolFeeBps: "0", deadlineMs: Date.parse(at) + 60000, routeBinding };
/** Only tests import the pure backend evaluator; production projection has type imports alone. */
function fixture() {
  const input: StrategyAdviceInput = {
    agent: { id: agentId, owner: "0x" + "b".repeat(40), wallet, name: "Controlled", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "1000", totalBudgetRaw: "10000", spentRaw: "100", reservedRaw: "0",
      allowCredit: true, createdAt: at, updatedAt: at, status: "Ready", binding: { chainId: "31337", agentId: "1", wallet } },
    finance: { status: "confirmed", observedAt: at, chainId: "31337", agentId: "1", wallet, block: { number: 1, hash: "0x" + routeBinding, timestamp: Date.parse(at) / 1000 }, cashRaw: "10000", debtRaw: "0", scannedTaskCount: 1, ownedTaskCount: 1,
      credit: { score: "1", tier: "A", tierCapRaw: "10000", feeBps: "1500", eligible: true, rejection: null }, policy: { maxCashPerTxRaw: "10000", maxDebtPerTxRaw: "10000", maxDebtPerDayRaw: "10000", ownerFrozen: false },
      counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "1", mirrorDefaults: "0" } },
    accounting: { version: 1, observedAt: at, agentId, currency: "USDC", decimals: 6, status: "complete",
      totals: { taskRevenueRaw: "1000", inferenceCostRaw: "100", borrowingFeeRaw: "0", refundsRaw: "0", gameSubsidyRaw: "0", ownerCapitalRaw: "0", startupCapitalRaw: "0", loanPrincipalRaw: "0", creditsGranted: 0, creditsUsed: 0, netOperatingRaw: "900" },
      coverage: { scope: "retained-hosted-history", since: at, runCount: 1, entryCount: 1, pendingCount: 0, incompleteCount: 0, returnedEntryCount: 1, entriesTruncated: false, uncoveredSpentRaw: "0", reasons: [] }, entries: [] },
    history: { scope: "retained-hosted-history", entryCount: 1, entriesTruncated: false, gaps: [], entries: [{ requestId: "22222222-2222-4222-8222-222222222222", at, action: "task", outcome: "succeeded",
      prediction: { source: "original-workflow-admission", atMs: Date.parse(at) - 1000, snapshotHash: routeBinding, routeBinding, taskId: "1", problemId: "sum-integers", providerId: "controlled", tier: "cheap", funding: "cash",
        executionCostRaw: "100", planningCostRaw: "0", borrowerFeeRaw: "0", netRevenueRaw: "1000", netRewardRaw: "900", originalMinNetRewardRaw: "1" },
      realized: { status: "confirmed", executionCostRaw: "100", borrowingFeeRaw: "0", taskRevenueRaw: "1000", planningCostRaw: "0", taskContributionRaw: "900", netAfterPlanningRaw: "900", failureLossRaw: null, knownFailureLossLowerBoundRaw: null },
      executionCostDeviationRaw: "0", gaps: [] }] }, preview: { candidates: [previewCandidate] }, observedAt: at,
  };
  return assessHostedStrategyAdvice(input);
}
function request(method = "GET", body?: unknown, headers: Record<string, string> = {}, suffix = "") {
  return new Request(`${origin}/api/hosted/agents/${agentId}/strategy-advice${suffix}`, { method, headers: { host: "127.0.0.1:3000", origin,
    cookie: `agentfuel_hosted_session=${token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}

test("strategy GET and POST use owner cookie, the fixed path, finance timeout and recursive public projections", async t => {
  const expected = fixture(), timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  const tainted = structuredClone(expected) as unknown as Record<string, any>;
  tainted.privateKey = "SECRET"; tainted.policy.owner = "SECRET"; tainted.cash.rpcUrl = "SECRET"; tainted.history.privatePath = "SECRET";
  tainted.history.entries[0].prompt = "SECRET"; tainted.history.entries[0].prediction.providerResponse = "SECRET";
  tainted.history.entries[0].realized.rawTransaction = "SECRET"; tainted.candidates[0].execution = { command: "SECRET" }; tainted.recommendation.token = "SECRET";
  let calls = 0;
  const body = { policy: { reserveCashRaw: "1000", minProfitRaw: "1", minMarginBps: "1000" }, candidates: [previewCandidate] };
  const fetcher = (async (url, options) => {
    calls++; assert.equal(String(url), `${upstreamUrl}/agents/${agentId}/strategy-advice`); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    const headers = new Headers(options?.headers); assert.equal(headers.get("authorization"), `Bearer ${token}`); assert.equal(headers.get("cookie"), null); assert.equal(headers.get("origin"), upstreamUrl);
    if (options?.method === "GET") assert.equal(options.body, undefined); else assert.deepEqual(JSON.parse(options!.body as string), body);
    return Response.json(tainted);
  }) as typeof fetch;
  for (const input of [request(), request("POST", body)]) {
    const result = await hostedAgentsRequest(input, { origin, upstreamUrl, fetcher });
    assert.equal(result.status, 200); assert.deepEqual(await result.json(), expected); assert.equal(result.headers.get("cache-control"), "private, no-store"); assert.equal(result.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(calls, 2); assert.deepEqual(timeouts, [130000, 130000]);
  assert.equal(expected.recommendation.status, "preview");
});

test("strategy bridge rejects unsupported methods, origin/owner injection and nested arbitrary preview fields before fetch", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json(fixture()); }) as typeof fetch;
  const config = { origin, upstreamUrl, fetcher };
  for (const method of ["PATCH", "PUT", "DELETE"]) assert.equal((await hostedAgentsRequest(request(method), config)).status, 405);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, { cookie: "" }), config)).status, 401);
  assert.equal((await hostedAgentsRequest(request("POST", {}, { origin: "https://other.invalid" }), config)).status, 403);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, { "x-owner": "other" }), config)).status, 403);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, {}, "?owner=other"), config)).status, 400);
  for (const value of [
    { owner: "other" }, { policy: { reserveCashRaw: "1", minProfitRaw: "1", minMarginBps: "1000", modelId: "other" } },
    { candidates: [{ ...previewCandidate, prompt: "SECRET" }] }, { candidates: [{ ...previewCandidate, executionCostRaw: 100 }] },
    { candidates: [{ ...previewCandidate, successProbability: "1" }] }, { candidates: [{ ...previewCandidate, routeBinding: "invalid" }] },
    { candidates: [previewCandidate, previewCandidate] }, { candidates: [{ ...previewCandidate, funding: "reward-tokens", executionCostRaw: "100" }] },
    { candidates: [{ ...previewCandidate, tokenFundingConfirmed: true }] }, { policy: { reserveCashRaw: "-1", minProfitRaw: "1", minMarginBps: "1000" } },
    { policy: { reserveCashRaw: "1", minProfitRaw: "1", minMarginBps: "10001" } },
  ]) assert.equal((await hostedAgentsRequest(request("POST", value), config)).status, 400);
  assert.equal((await hostedAgentsRequest(request("POST", { padding: "x".repeat(8192) }), config)).status, 413);
  assert.equal(calls, 0); assert.deepEqual(projectStrategyAdvicePreview({}), {});
});

test("strategy projection rejects wrong Agent identity and malformed nested evidence without leaking upstream data", async () => {
  const base = fixture();
  const invalid: unknown[] = [
    { ...base, agentId: "other" }, { ...base, mode: "execute" }, { ...base, exclusions: ["chain-fees"] },
    { ...base, policy: { ...base.policy, minMarginBps: "10001" } }, { ...base, cash: { ...base.cash, creditIncluded: true } },
    { ...base, cash: { ...base.cash, cashRaw: undefined } }, { ...base, cash: { ...base.cash, cashRaw: -1 } },
    { ...base, cash: { ...base.cash, reserveCashRaw: "1" } }, { ...base, cash: { ...base.cash, pendingCommitmentsRaw: "1" } },
    { ...base, history: { ...base.history, entryCount: 0 } }, { ...base, history: { ...base.history, creditsUsed: Number.MAX_SAFE_INTEGER + 1 } },
    { ...base, history: { ...base.history, entries: [{ ...base.history.entries[0], prediction: { ...base.history.entries[0].prediction, routeBinding: "SECRET" } }] } },
    { ...base, history: { ...base.history, entries: [{ ...base.history.entries[0], realized: { ...base.history.entries[0].realized, taskContributionRaw: "NaN" } }] } },
    { ...base, candidates: [{ ...base.candidates[0], failedComparableCount: 2 }] }, { ...base, candidates: [{ ...base.candidates[0], observedCostBufferRaw: null }] },
    { ...base, candidates: [{ ...base.candidates[0], reasons: ["SECRET"] }] }, { ...base, recommendation: { ...base.recommendation, taskId: "999" } },
    { ...base, recommendation: { ...base.recommendation, status: "blocked" } }, { ...base, gaps: ["STRATEGY_SECRET_PROVIDER_RESPONSE"] },
  ];
  for (const value of invalid) {
    assert.throws(() => projectHostedStrategyAdvice(value, agentId));
    const response = await hostedAgentsRequest(request(), { origin, upstreamUrl, fetcher: (async () => Response.json(value)) as typeof fetch });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "HOSTED_UNAVAILABLE" });
  }
  const unavailable = { ...base, cash: { ...base.cash, status: "unavailable", cashRaw: null, outstandingDebtRaw: null, financeObservedAt: null, availableBeforeReserveRaw: null, spendableCashRaw: null },
    candidates: [], recommendation: { status: "unavailable", reasons: ["STRATEGY_CURRENT_CANDIDATES_UNAVAILABLE"] } };
  assert.equal(projectHostedStrategyAdvice(unavailable, agentId).cash.status, "unavailable");
  const denied = await hostedAgentsRequest(request(), { origin, upstreamUrl, fetcher: (async () => Response.json({ error: "HOSTED_AGENT_NOT_FOUND", privateKey: "SECRET" }, { status: 404 })) as typeof fetch });
  assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: "HOSTED_AGENT_NOT_FOUND" });
});
