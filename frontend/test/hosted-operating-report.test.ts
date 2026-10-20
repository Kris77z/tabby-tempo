import assert from "node:assert/strict";
import test from "node:test";
import { assessHostedOperatingReport, validateOperatingReportPreview } from "../../services/hosted-agents/src/operating-report.js";
import type { HostedAgent, HostedAccounting, HostedFinance } from "../../services/hosted-agents/src/types.js";
import { hostedAgentsRequest } from "../lib/hosted-agents-proxy.js";
import { projectHostedOperatingReport, projectOperatingReportPreview } from "../lib/hosted-operating-report.js";
import { buildOperatingReportDemo } from "../../scripts/operating-report-demo.js";

const origin = "http://127.0.0.1:3000", upstreamUrl = "http://127.0.0.1:8792", token = "a".repeat(40), agentId = "operating-agent-a", at = "2026-10-17T00:00:00.000Z", hash = "0x" + "1".repeat(64), route = "2".repeat(64);
const preview = { reserveCashRaw: "200000", recurringCostRaw: "50000", subsidyBudgetRaw: "600000", burn: { amountRaw: "100000", windowMs: 86400000, taskCount: 2 }, subsidyBurn: { amountRaw: "50000", windowMs: 86400000 } };
function fixture() {
  const agent: HostedAgent = { id: agentId, owner: "0x" + "a".repeat(40), wallet: "0x" + "b".repeat(40), name: "Operating test", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "500000", totalBudgetRaw: "10000000", spentRaw: "180000", reservedRaw: "0", allowCredit: true, status: "Ready", createdAt: at, updatedAt: at, binding: { chainId: "31337", agentId: "1", wallet: "0x" + "b".repeat(40) } };
  const finance: HostedFinance = { status: "confirmed", observedAt: at, chainId: "31337", agentId: "1", wallet: agent.wallet, cashRaw: "1000000", debtRaw: "100000", block: { number: 1, hash, timestamp: Date.parse(at) / 1000 }, scannedTaskCount: 0, ownedTaskCount: 0,
    credit: { score: "100", tier: "A", tierCapRaw: "1000000", feeBps: "1500", eligible: true, rejection: null }, policy: { maxCashPerTxRaw: "1000000", maxDebtPerTxRaw: "1000000", maxDebtPerDayRaw: "1000000", ownerFrozen: false }, counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
  const money = { taskRevenueRaw: "1400000", inferenceCostRaw: "180000", borrowingFeeRaw: "15000", refundsRaw: "20000", gameSubsidyRaw: "400000", ownerCapitalRaw: "1000000", startupCapitalRaw: "200000", loanPrincipalRaw: "100000", creditsGranted: 10000, creditsUsed: 215 };
  const accounting: HostedAccounting = { version: 1, agentId, observedAt: at, currency: "USDC", decimals: 6, status: "complete", totals: { ...money, netOperatingRaw: "1205000" },
    entries: [{ ...money, id: "controlled-request", requestId: "controlled-request", action: "task", at, status: "confirmed", taskId: "1", paymentId: hash, reasons: [] }],
    coverage: { scope: "retained-hosted-history", since: at, runCount: 1, entryCount: 1, pendingCount: 0, incompleteCount: 0, returnedEntryCount: 1, entriesTruncated: false, uncoveredSpentRaw: "0", reasons: [] } };
  const domain = { chainId: "31337", account: "0x" + "c".repeat(40), asset: "0x" + "d".repeat(40) };
  return assessHostedOperatingReport({ agent, finance, accounting, pendingReservationsRaw: "100000", observedAt: at, preview,
    evidence: { settlementDomain: domain, suppliers: [{ ...domain, requestId: "controlled-request", paymentId: hash, paymentTxHash: hash, routeBinding: route, providerId: "controlled-supplier", payTo: "0x" + "e".repeat(40), service: "infercredit/solve-fixed", model: "pi-fixed-v1", grossReceiptsRaw: "200000", refundsRaw: "20000", netReceiptsRaw: "180000" }],
      taskFees: [{ requestId: "controlled-request", taskId: "1", settlementTxHash: hash, protocolFeeRaw: "100000", creditFeeSettledRaw: "15000", source: "settled-task-and-original-reward", gaps: [] }], gaps: [], entriesTruncated: false } });
}
function request(method = "GET", body?: unknown, headers: Record<string, string> = {}, suffix = "") {
  return new Request(`${origin}/api/hosted/agents/${agentId}/operating-report${suffix}`, { method, headers: { host: "127.0.0.1:3000", origin, cookie: `agentfuel_hosted_session=${token}`, "content-type": "application/json", ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
}
function taint(value: unknown) { if (Array.isArray(value)) value.forEach(taint); else if (value && typeof value === "object") { Object.values(value).forEach(taint); (value as Record<string, unknown>).privateKey = "SECRET"; } }

test("operating GET/POST keep cookie auth, fixed route, no-store, Tempo bounded 130s timeout and recursive public fields", async t => {
  const expected = fixture(), tainted = structuredClone(expected); taint(tainted); let calls = 0; const timeouts: number[] = [];
  t.mock.method(AbortSignal, "timeout", (ms: number) => { timeouts.push(ms); return new AbortController().signal; });
  const fetcher = (async (url, options) => {
    calls++; assert.equal(String(url), `${upstreamUrl}/agents/${agentId}/operating-report`); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    const headers = new Headers(options?.headers); assert.equal(headers.get("authorization"), `Bearer ${token}`); assert.equal(headers.get("cookie"), null); assert.equal(headers.get("origin"), upstreamUrl);
    if (options?.method === "GET") assert.equal(options.body, undefined); else assert.deepEqual(JSON.parse(options!.body as string), preview);
    return Response.json(tainted);
  }) as typeof fetch;
  for (const req of [request(), request("POST", preview)]) {
    const response = await hostedAgentsRequest(req, { origin, upstreamUrl, fetcher }); assert.equal(response.status, 200); assert.deepEqual(await response.json(), expected);
    assert.equal(response.headers.get("cache-control"), "private, no-store"); assert.equal(response.headers.get("x-content-type-options"), "nosniff");
  }
  assert.equal(calls, 2); assert.deepEqual(timeouts, [130000, 130000]); assert.equal(expected.scenario?.subsidyBudgetRemainingRaw, "200000");
  assert.equal(expected.agent.actualProfitRaw, null); assert.equal(expected.platform.actualProfitRaw, null); assert.equal(expected.suppliers.actualProfitRaw, null);
});

test("operating browser assumptions match backend's closed numeric schema and reject owner/operator books", async () => {
  let calls = 0; const config = { origin, upstreamUrl, fetcher: (async () => { calls++; return Response.json(fixture()); }) as typeof fetch };
  for (const method of ["PATCH", "PUT", "DELETE"]) assert.equal((await hostedAgentsRequest(request(method), config)).status, 405);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, { cookie: "" }), config)).status, 401);
  assert.equal((await hostedAgentsRequest(request("POST", {}, { origin: "https://other.invalid" }), config)).status, 403);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, { "x-owner": "other" }), config)).status, 403);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, { authorization: "Bearer other" }), config)).status, 403);
  assert.equal((await hostedAgentsRequest(request("GET", undefined, {}, "?owner=other"), config)).status, 400);
  const invalid = [{ owner: "other" }, { role: "platform", costsRaw: "100" }, { costsRaw: "100", evidenceDigest: route }, { supplier: { receiptsRaw: "100" } },
    { reserveCashRaw: 100 }, { reserveCashRaw: "-1" }, { reserveCashRaw: "01" }, { reserveCashRaw: (1n << 256n).toString() },
    { burn: { amountRaw: "1", windowMs: 0 } }, { burn: { amountRaw: "1", windowMs: 1.5 } }, { burn: { amountRaw: "1", windowMs: Number.MAX_SAFE_INTEGER + 1 } },
    { burn: { amountRaw: "1", windowMs: 1, taskCount: 0 } }, { burn: { amountRaw: "1", windowMs: 1, prompt: "SECRET" } },
    { subsidyBurn: { amountRaw: "1", windowMs: 0 } }, { subsidyBurn: { amountRaw: "1", windowMs: 1, provider: "SECRET" } }, { subsidyBudgetRaw: null }];
  for (const value of invalid) {
    assert.throws(() => projectOperatingReportPreview(value)); assert.throws(() => validateOperatingReportPreview(value));
    const response = await hostedAgentsRequest(request("POST", value), config); assert.equal(response.status, 400); assert.deepEqual(await response.json(), { error: "HOSTED_BODY_INVALID" });
  }
  for (const value of [{}, preview, { reserveCashRaw: ((1n << 256n) - 1n).toString(), burn: { amountRaw: "0", windowMs: 1 } }]) assert.deepEqual(projectOperatingReportPreview(value), validateOperatingReportPreview(value));
  assert.equal((await hostedAgentsRequest(request("POST", { padding: "x".repeat(65536) }), config)).status, 413); assert.equal(calls, 0);
});

test("operating projection rejects wrong identity and malformed nested financial claims with a safe error", async () => {
  const base = fixture();
  const invalid = [{ ...base, agentId: "other" }, { ...base, scope: "global-private-books" }, { ...base, mode: "execute" }, { ...base, currency: "ETH" },
    { ...base, agent: { ...base.agent, actualProfitRaw: "1205000" } }, { ...base, agent: { ...base.agent, settlementOperatingRaw: "1205001" } },
    { ...base, platform: { ...base.platform, treasuryReceiptsRaw: "100000" } }, { ...base, suppliers: { ...base.suppliers, netReceiptsRaw: "180001" } },
    { ...base, suppliers: { ...base.suppliers, rows: [{ ...base.suppliers.rows[0], routeBinding: "SECRET" }] } },
    { ...base, subsidy: { ...base.subsidy, rewardTokensRemaining: 9785 } }, { ...base, subsidy: { ...base.subsidy, usdcGrantRemainingRaw: "220000" } },
    { ...base, cash: { ...base.cash, creditIncluded: true } }, { ...base, cash: { ...base.cash, cashRaw: 1000000 } }, { ...base, cash: { ...base.cash, spendableCashRaw: "600001" } },
    { ...base, scenario: { ...base.scenario, source: "operator-declared" } }, { ...base, scenario: { ...base.scenario, costPeriod: { from: at, to: "SECRET" } } },
    { ...base, runway: { ...base.runway, source: "operator-declared" } }, { ...base, runway: { ...base.runway, horizonMs: "NaN" } },
    { ...base, runway: { ...base.runway, status: "zero-burn" } }, { ...base, consolidation: { ...base.consolidation, roleTotalsAdditive: true } },
    { ...base, coverage: { ...base.coverage, pendingCount: 2 } }, { ...base, gaps: ["OPERATING_PRIVATE_PROVIDER_RESPONSE"] }];
  for (const value of invalid) {
    assert.throws(() => projectHostedOperatingReport(value, agentId));
    const response = await hostedAgentsRequest(request(), { origin, upstreamUrl, fetcher: (async () => Response.json(value)) as typeof fetch });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "HOSTED_UNAVAILABLE" });
  }
  const denied = await hostedAgentsRequest(request(), { origin, upstreamUrl, fetcher: (async () => Response.json({ error: "HOSTED_AGENT_NOT_FOUND", privateKey: "SECRET" }, { status: 404 })) as typeof fetch });
  assert.equal(denied.status, 404); assert.deepEqual(await denied.json(), { error: "HOSTED_AGENT_NOT_FOUND" });
});

test("bound offline journal reports cross the browser projection for both complete contributions and unresolved liabilities", async () => {
  const demo = await buildOperatingReportDemo();
  for (const report of [demo.contribution, demo.ownerHypothetical, demo.unresolved.report, demo.subsidyGrantsUnknown]) {
    assert.deepEqual(projectHostedOperatingReport(report, report.agentId), report);
    const req = new Request(`${origin}/api/hosted/agents/${report.agentId}/operating-report`, { headers: { host: "127.0.0.1:3000", origin, cookie: `agentfuel_hosted_session=${token}` } });
    const response = await hostedAgentsRequest(req, { origin, upstreamUrl, fetcher: (async () => Response.json(report)) as typeof fetch });
    assert.equal(response.status, 200); assert.deepEqual(await response.json(), report);
  }
  assert.equal(demo.unresolved.report.cash.status, "confirmed"); assert.equal(demo.unresolved.report.cash.spendableCashRaw, null); assert.equal(demo.unresolved.report.cash.shortfallRaw, null);
  assert.equal(demo.unresolved.report.runway.status, "unknown"); assert.ok(demo.unresolved.report.runway.reasons.includes("OPERATING_LIABILITIES_UNRESOLVED"));
  const unsafe = structuredClone(demo.unresolved.report); unsafe.cash.spendableCashRaw = "0"; assert.throws(() => projectHostedOperatingReport(unsafe, unsafe.agentId));
  const partialGrant = demo.subsidyGrantsUnknown;
  assert.ok(partialGrant.coverage.reasons.includes("ACCOUNTING_SUBSIDY_UNKNOWN")); assert.equal(partialGrant.subsidy.gameUsdcGrantedRaw, "400000");
  assert.equal(partialGrant.scenario?.subsidyBudgetRemainingRaw, null); assert.equal(partialGrant.scenario?.subsidyBudgetShortfallRaw, null);
  assert.equal(partialGrant.scenario?.subsidyBudgetRunway?.status, "unknown"); assert.equal(partialGrant.scenario?.subsidyBudgetRunway?.availableRaw, null);
  for (const mutation of ["missing-reason", "one-sided-null", "false-numeric-balance"] as const) {
    const broken = structuredClone(partialGrant); assert.ok(broken.scenario?.subsidyBudgetRunway);
    if (mutation === "missing-reason") broken.scenario.subsidyBudgetRunway.reasons = broken.scenario.subsidyBudgetRunway.reasons.filter(reason => reason !== "OPERATING_SUBSIDY_GRANTS_UNKNOWN");
    if (mutation === "one-sided-null") broken.scenario.subsidyBudgetShortfallRaw = "0";
    if (mutation === "false-numeric-balance") { broken.scenario.subsidyBudgetRemainingRaw = "200000"; broken.scenario.subsidyBudgetShortfallRaw = "0"; broken.scenario.subsidyBudgetRunway.availableRaw = "200000"; }
    assert.throws(() => projectHostedOperatingReport(broken, broken.agentId));
  }
});
