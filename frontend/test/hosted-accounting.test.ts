import assert from "node:assert/strict";
import test from "node:test";
import { hostedAgentsRequest } from "../lib/hosted-agents-proxy.js";
import { projectHostedAccounting } from "../lib/hosted-accounting.js";
import { amount } from "../lib/format.js";
import { accountingFixture } from "./accounting-fixture.js";

const origin = "http://127.0.0.1:3000", upstreamUrl = "http://127.0.0.1:8791", token = "a".repeat(64);
function request(method = "GET", cookie = `agentfuel_hosted_session=${token}`) {
  return new Request(`${origin}/api/hosted/agents/accounting-agent-a/accounting`, { method, headers: { host: "127.0.0.1:3000", origin, cookie } });
}
test("accounting is a cookie authenticated read-only projection with no private nested state", async () => {
  const value = accountingFixture(), privateValue = { ...value, privateResponse: "SECRET", totals: { ...value.totals, privateKey: "SECRET" }, coverage: { ...value.coverage, path: "SECRET" }, entries: value.entries.map(entry => ({ ...entry, prompt: "SECRET", signedTransaction: "SECRET" })) };
  let calls = 0;
  const fetcher = (async (url, options) => {
    calls++; assert.equal(String(url), `${upstreamUrl}/agents/accounting-agent-a/accounting`); assert.equal(options?.method, "GET"); assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    return Response.json(privateValue);
  }) as typeof fetch;
  const result = await hostedAgentsRequest(request(), { origin, upstreamUrl, fetcher });
  assert.equal(result.status, 200); assert.deepEqual(await result.json(), value); assert.equal(result.headers.get("cache-control"), "private, no-store");
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await hostedAgentsRequest(request(method), { origin, upstreamUrl, fetcher })).status, 405);
  assert.equal((await hostedAgentsRequest(request("GET", ""), { origin, upstreamUrl, fetcher })).status, 401);
  assert.equal(calls, 1);
});
test("accounting rejects unsafe or incomplete numeric data instead of coercing it to zero", () => {
  const base = accountingFixture();
  for (const value of [
    { ...base, totals: { ...base.totals, inferenceCostRaw: undefined } },
    { ...base, totals: { ...base.totals, taskRevenueRaw: -1 } },
    { ...base, totals: { ...base.totals, borrowingFeeRaw: "NaN" } },
    { ...base, totals: { ...base.totals, creditsUsed: Number.MAX_SAFE_INTEGER + 1 } },
    { ...base, status: "partial" },
    { ...base, coverage: { ...base.coverage, scope: "all-wallet-history" } },
    { ...base, coverage: { ...base.coverage, uncoveredSpentRaw: "1" } },
    { ...base, coverage: { ...base.coverage, pendingCount: 2 } },
    { ...base, entries: [{ ...base.entries[0], reasons: ["SECRET provider response"] }] },
  ]) assert.throws(() => projectHostedAccounting(value));
  const partial = { ...base, status: "partial", totals: { ...base.totals, netOperatingRaw: null }, coverage: { ...base.coverage, incompleteCount: 1, reasons: ["ACCOUNTING_PAYMENT_UNRESOLVED"] } };
  assert.equal(projectHostedAccounting(partial).totals.netOperatingRaw, null);
  assert.equal(amount("-2", 6), "−0.000002"); assert.equal(amount("120001", 6), "0.120001");
});

test("Tempo projection preserves PathUSD and cannot turn missing chain fees into net profit", () => {
 const v=projectHostedAccounting({...accountingFixture(),currency:"PathUSD"});
 assert.equal(v.currency,"PathUSD");assert.equal(v.chainFeesRaw,null);assert.equal(v.actualProfitRaw,null);
 for(const patch of [{chainFeesRaw:"0"},{actualProfitRaw:"10"},{costScope:"full-profit"}]) assert.throws(()=>projectHostedAccounting({...v,...patch}));
});
