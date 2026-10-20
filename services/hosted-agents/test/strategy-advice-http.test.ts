import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import { createHostedHttpServer } from "../src/http.js";
import type { HostedExecutor } from "../src/types.js";

test("strategy advice is owner authenticated, preview-only, closed-schema and preserves retained state", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-strategy-http-"))), owners = [Wallet.createRandom(), Wallet.createRandom()];
  let executions = 0, financeCalls = 0;
  const executor: HostedExecutor = { async execute(input) {
    executions++;
    return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", cashRaw: "1000", binding: { chainId: "31337", agentId: "2", wallet: input.agent.wallet } };
  }, async finance() { financeCalls++; return { status: "unavailable", observedAt: new Date().toISOString(), reason: "HOSTED_FINANCE_UNCONFIRMED" }; } };
  const service = await HostedService.open({ directory, origin: "http://127.0.0.1:3000", chainId: "31337", models: [{ id: "controlled", label: "Controlled" }],
    maxAgentsPerOwner: 2, maxTotalBudgetRaw: "10000", maxPerRunBudgetRaw: "100" }, executor);
  const server = createHostedHttpServer(service); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const request = (path: string, token?: string, method = "GET", value?: unknown, extra: Record<string, string> = {}) => fetch(base + path, { method,
    headers: { origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}), ...(value === undefined ? {} : { "content-type": "application/json" }), ...extra },
    ...(value === undefined ? {} : { body: JSON.stringify(value) }) });
  try {
    const tokens: string[] = [];
    for (const owner of owners) { const challenge = await service.challenge(owner.address); tokens.push((await service.login(challenge.id, await owner.signMessage(challenge.message))).token); }
    const agent = await service.create(owners[0].address, { requestId: randomUUID(), name: "Advice", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "10000", allowCredit: true });
    await service.waitUntilIdle();
    const path = `/agents/${agent.id}/strategy-advice`, before = await readFile(join(directory, "database", "session.json"), "utf8"), beforeExecutions = executions;
    assert.equal((await request(path)).status, 401);
    assert.equal((await request(path, tokens[1])).status, 404);
    assert.equal((await request(path, tokens[1], "POST", {})).status, 404);
    assert.equal((await request(path, tokens[0], "PATCH", {})).status, 405);
    assert.equal((await request(path + "?owner=other", tokens[0])).status, 400);
    assert.equal((await request(path, tokens[0], "POST", {}, { origin: "https://other.invalid" })).status, 403);
    assert.equal(financeCalls, 0);
    const response = await request(path, tokens[0]); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const value = await response.json();
    assert.equal(value.mode, "advisory-only"); assert.equal(value.recommendation.status, "unavailable");
    assert.deepEqual(value.policy, { reserveCashRaw: "100", minProfitRaw: "1", minMarginBps: "1000", source: "advisory-default", marginBasis: "net-task-revenue" });
    const preview = await request(path, tokens[0], "POST", { policy: { reserveCashRaw: "20", minProfitRaw: "2", minMarginBps: "2000" }, candidates: [] });
    assert.equal(preview.status, 200); assert.equal((await preview.json()).policy.source, "owner-preview");
    assert.equal((await request(path, tokens[0], "POST", { policy: { reserveCashRaw: "-1", minProfitRaw: "2", minMarginBps: "2000" } })).status, 400);
    assert.equal((await request(path, tokens[0], "POST", { owner: owners[1].address })).status, 400);
    assert.equal((await request(path, tokens[0], "POST", { candidates: [{ relayUrl: "https://private.invalid", prompt: "SECRET" }] })).status, 400);
    assert.equal(executions, beforeExecutions); assert.equal(financeCalls, 2);
    assert.equal(await readFile(join(directory, "database", "session.json"), "utf8"), before);
    assert.equal(JSON.stringify(value).includes(directory), false);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a concurrent state change invalidates cash observed before that change", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-strategy-race-"))), owner = Wallet.createRandom();
  let release!: () => void, started!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }), called = new Promise<void>(resolve => { started = resolve; });
  const service = await HostedService.open({ directory, origin: "http://127.0.0.1:3000", chainId: "31337", models: [{ id: "controlled", label: "Controlled" }],
    maxAgentsPerOwner: 2, maxTotalBudgetRaw: "10000", maxPerRunBudgetRaw: "100" }, { async execute(input) {
      return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", cashRaw: "1000", binding: { chainId: "31337", agentId: "2", wallet: input.agent.wallet } };
    }, async finance(agent) {
      const at = new Date().toISOString(); started(); await gate;
      return { status: "confirmed", observedAt: at, chainId: "31337", agentId: "2", wallet: agent.wallet,
        block: { number: 1, hash: "0x" + "a".repeat(64), timestamp: Math.floor(Date.parse(at) / 1000) }, cashRaw: "1000", debtRaw: "0", scannedTaskCount: 0, ownedTaskCount: 0,
        credit: { score: "0", tier: "C", tierCapRaw: "0", feeBps: "1500", eligible: false, rejection: null },
        policy: { maxCashPerTxRaw: "100", maxDebtPerTxRaw: "0", maxDebtPerDayRaw: "0", ownerFrozen: false },
        counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
    } });
  try {
    const agent = await service.create(owner.address, { requestId: randomUUID(), name: "Advice", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "10000", allowCredit: false });
    await service.waitUntilIdle();
    const pending = service.strategyAdvice(owner.address, agent.id); await called;
    await service.pause(owner.address, agent.id, true);
    const before = await readFile(join(directory, "database", "session.json"), "utf8"); release();
    const advice = await pending;
    assert.equal(advice.cash.status, "unavailable"); assert.equal(advice.cash.cashRaw, null);
    assert.ok(advice.gaps.includes("STRATEGY_CASH_UNAVAILABLE"));
    assert.equal(await readFile(join(directory, "database", "session.json"), "utf8"), before);
  } finally { release(); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
