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

test("owner accounting API is independent of unavailable chain finance, covers runs beyond the latest-100 list, and never writes state", { timeout: 10000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-accounting-http-"))), owners = [Wallet.createRandom(), Wallet.createRandom()];
  let financeCalls = 0, taskId = 0;
  const tx = "0x" + "a".repeat(64), executor: HostedExecutor = { async execute(input) {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", cashRaw: "500", binding: { chainId: "31337", agentId: "2", wallet: input.agent.wallet } };
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "1", fromCashRaw: "1", fromCreditRaw: "0", taskId: String(++taskId), settlement: { txHash: tx,
      block: { number: 1, hash: tx, timestamp: 1792195200 }, passed: true, loanStatus: "0", repaidRaw: "0", slashedRaw: "0", residualRaw: "3" } };
  }, async finance() { financeCalls++; return { status: "unavailable", observedAt: new Date().toISOString(), reason: "HOSTED_FINANCE_UNCONFIRMED" }; } };
  const service = await HostedService.open({ directory, origin: "http://127.0.0.1:3000", chainId: "31337", models: [{ id: "controlled", label: "Controlled" }], maxAgentsPerOwner: 2, maxTotalBudgetRaw: "10000", maxPerRunBudgetRaw: "100" }, executor);
  const server = createHostedHttpServer(service); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const send = (path: string, token?: string, method = "GET") => fetch(base + path, { method, headers: { origin: base, ...(token ? { authorization: `Bearer ${token}` } : {}) } });
  try {
    const challenge = await service.challenge(owners[0].address), login = await service.login(challenge.id, await owners[0].signMessage(challenge.message));
    const agent = await service.create(owners[0].address, { requestId: randomUUID(), name: "Accounting", modelId: "controlled", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "10000", allowCredit: true }); await service.waitUntilIdle();
    for (let i = 0; i < 101; i++) { await service.command(owners[0].address, agent.id, { action: "task", requestId: randomUUID() }); await service.waitUntilIdle(); }
    assert.equal((await service.snapshot(owners[0].address)).runs.length, 100);
    assert.equal((await send(`/agents/${agent.id}/accounting`)).status, 401);
    assert.equal((await send(`/agents/${agent.id}/accounting`, login.token, "POST")).status, 405);
    await assert.rejects(service.accounting(owners[1].address, agent.id), /HOSTED_AGENT_NOT_FOUND/);
    const before = await readFile(join(directory, "database", "session.json"), "utf8");
    const response = await send(`/agents/${agent.id}/accounting`, login.token); assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    const value = await response.json();
    assert.equal(value.status, "complete"); assert.equal(value.coverage.runCount, 102); assert.equal(value.coverage.entryCount, 102);
    assert.equal(value.totals.taskRevenueRaw, "303"); assert.equal(value.totals.inferenceCostRaw, "101"); assert.equal(value.totals.netOperatingRaw, "202"); assert.equal(value.totals.startupCapitalRaw, "500");
    assert.equal(financeCalls, 0); assert.equal(await readFile(join(directory, "database", "session.json"), "utf8"), before);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); await rm(directory, { recursive: true, force: true }); }
});

test("all three Tempo read-only views share PathUSD for an unbound Agent", async () => {
 const directory=await realpath(await mkdtemp(join(tmpdir(),"tempo-accounting-currency-")));
 const owner=Wallet.createRandom();
 const executor:HostedExecutor={async execute(){return {phase:"Failed",terminal:true,success:false,chargedRaw:"0",reason:"HOSTED_CONFIGURATION_REQUIRED"}},async finance(){return {status:"unavailable",observedAt:new Date().toISOString(),reason:"HOSTED_FINANCE_UNCONFIRMED"}}};
 const service=await HostedService.open({directory,origin:"http://127.0.0.1:3000",chainId:"42431",models:[{id:"controlled",label:"Controlled"}],maxAgentsPerOwner:1,maxTotalBudgetRaw:"10000",maxPerRunBudgetRaw:"100"},executor);
 try{
 const agent=await service.create(owner.address,{requestId:randomUUID(),name:"Unbound",modelId:"controlled",strategy:"balanced",perRunBudgetRaw:"100",totalBudgetRaw:"10000",allowCredit:false});await service.waitUntilIdle();
 assert.equal(agent.binding,undefined);
 for(const value of [await service.accounting(owner.address,agent.id),await service.strategyAdvice(owner.address,agent.id),await service.operatingReport(owner.address,agent.id)])assert.equal(value.currency,"PathUSD");
 }finally{await service.close();await rm(directory,{recursive:true,force:true})}
});
