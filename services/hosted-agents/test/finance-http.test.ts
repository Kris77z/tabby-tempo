import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import { createHostedHttpServer } from "../src/http.js";
import type { HostedExecutor, HostedFinance } from "../src/types.js";

test("finance admission enforces ownership, shares an in-flight read and leaves list/mutation admission responsive", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-finance-http-")));
  const owners = [Wallet.createRandom(), Wallet.createRandom()];
  let release!: () => void, started!: () => void, calls = 0;
  const gate = new Promise<void>(resolve => { release = resolve; }), began = new Promise<void>(resolve => { started = resolve; });
  const executor: HostedExecutor = { async execute(input) {
    return { phase: "SyntheticProvision", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "2", wallet: input.agent.wallet } };
  }, async finance() { calls++; started(); await gate; return { status: "unavailable", observedAt: new Date().toISOString(), reason: "HOSTED_FINANCE_NOT_CONFIGURED" }; } };
  const service = await HostedService.open({ directory, origin: "http://127.0.0.1:3000", chainId: "31337", models: [{ id: "controlled", label: "Controlled" }],
    maxAgentsPerOwner: 3, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" }, executor);
  const server = createHostedHttpServer(service); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const send = (path: string, token?: string, method = "GET") => fetch(base + path, { method, headers: { origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  try {
    const challenge = await service.challenge(owners[0].address), login = await service.login(challenge.id, await owners[0].signMessage(challenge.message));
    const agent = await service.create(owners[0].address, { requestId: randomUUID(), name: "Controlled", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true });
    await service.waitUntilIdle();
    assert.equal((await send(`/agents/${agent.id}/finance`)).status, 401);
    await assert.rejects(service.finance(owners[1].address, agent.id), /HOSTED_AGENT_NOT_FOUND/); assert.equal(calls, 0);
    assert.equal((await send(`/agents/${agent.id}/finance`, login.token, "POST")).status, 405);
    const first = service.finance(owners[0].address, agent.id), second = service.finance(owners[0].address, agent.id); await began;
    const snapshot = await service.snapshot(owners[0].address); assert.equal(snapshot.agents.length, 1);
    assert.equal((await service.pause(owners[0].address, agent.id, true)).status, "Paused");
    assert.equal((await send("/agents", login.token)).status, 200); assert.equal(calls, 1);
    release(); assert.deepEqual(await first, await second); assert.equal(calls, 1);
    const response = await send(`/agents/${agent.id}/finance`, login.token); assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "unavailable"); assert.equal(calls, 2);
    // Adapters cannot leak arbitrary financial state through the service.
    executor.finance = async () => ({ status: "unavailable", observedAt: new Date().toISOString(), reason: "HOSTED_FINANCE_NOT_CONFIGURED", privateKey: "SECRET" }) as HostedFinance;
    const unsafe = await service.finance(owners[0].address, agent.id); assert.equal(unsafe.status, "unavailable"); assert.equal(JSON.stringify(unsafe).includes("SECRET"), false);
    if (unsafe.status === "unavailable") assert.equal(unsafe.reason, "HOSTED_FINANCE_UNCONFIRMED");
  } finally { release(); await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); await rm(directory, { recursive: true, force: true }); }
});
