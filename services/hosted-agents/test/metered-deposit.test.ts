import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { createHostedTaskFixture } from "./task-fixture.js";
import { createHostedTaskExecutor } from "../src/task-executor.js";
import { modelCatalogDigest } from "../src/metered-task.js";
import { InferenceAllowanceRelay, ALLOWANCE_SERVICE, ALLOWANCE_MODEL } from "../../provider-relay/src/allowance.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { modelToolResponse } from "../../../packages/pi-loop/test/workflow-fixture.js";
import { tx } from "../../underwriter/test/fixture.js";
import { HostedAutonomyExecutor } from "../src/autonomy-executor.js";
import { HostedService } from "../src/service.js";
import type { HostedConfig, HostedExecution, HostedExecutor } from "../src/types.js";
import type { GatewayModel } from "../src/inference-gateway.js";

test("cash refill lends only the waiting metered wallet slot and resumes its original accepted task without borrowing", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-metered-deposit-")));
  let succeeded = false;
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const keyFile = join(directory, "model.key"); await writeFile(keyFile, "controlled", { mode: 0o600 });
  const catalog: [GatewayModel, GatewayModel] = [
    { id: "cheap", model: "cheap/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 256 },
    { id: "strong", model: "strong/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 },
  ];
  const relay = new InferenceAllowanceRelay({ ...f.fx.relayConfig, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
    upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
    { creditsRaw: "100000", modelCatalogDigest: modelCatalogDigest(catalog), provider: f.fx.f.provider });
  const server = createHttpServer(relay, new Refunder(relay)); await relay.initialize(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config = structuredClone(f.config); config.initialCashRaw = "0";
  config.metered = { relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, payTo: f.fx.f.payee, priceRaw: "120000", creditsRaw: "100000", catalog, keyFile };
  let calls = 0;
  const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, gatewayDispatch: async (model) => {
    calls++; return { status: 200, body: modelToolResponse(f.GOOD_CODE["sum-integers"], model.model) };
  } });
  try {
    const actor = await f.actor(5, "cheap", 0n); actor.agent.allowCredit = false;
    const ready = await tasks.execute(actor.input("provision")); assert.equal(ready.success, true, JSON.stringify(ready));
    actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const parent = actor.input("task"); parent.run.action = "metered-task";
    const paused = await tasks.execute(parent);
    assert.equal(paused.phase, "Paused", JSON.stringify(paused)); assert.equal(paused.reason, "INFERENCE_FUNDING_REQUIRED"); assert.ok(paused.acceptTxHash); assert.equal(calls, 0);
    const slotPath = join(config.walletDirectory, actor.wallet.address.toLowerCase(), "session.json");
    const originalSlot = JSON.parse(await readFile(slotPath, "utf8"));
    const wrong = actor.input("deposit"); wrong.run.amountRaw = "120000"; wrong.run.fundingFor = randomUUID();
    const rejected = await tasks.execute(wrong); assert.equal(rejected.reason, "HOSTED_DEPOSIT_PARENT_INVALID"); assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), originalSlot);
    const deposit = actor.input("deposit"); deposit.run.amountRaw = "120000"; deposit.run.fundingFor = parent.run.requestId;
    const unfunded = await tasks.execute(deposit); assert.equal(unfunded.reason, "HOSTED_AGENT_FUNDS_REQUIRED");
    const privateDeposit = JSON.parse(await readFile(join(deposit.directory, "task-executor/session.json"), "utf8"));
    assert.deepEqual(privateDeposit.suspended, originalSlot);
    assert.equal(JSON.parse(await readFile(slotPath, "utf8")).directory, join(deposit.directory, "task-executor/workflow"));
    f.fx.f.admin.reset(); await tx(f.fx.f.token!, f.fx.f.admin, "mint", [actor.wallet.address, 120000n]);
    const resumedDeposit = await tasks.execute({ ...deposit, recover: true });
    assert.equal(resumedDeposit.phase, "Deposited", JSON.stringify(resumedDeposit)); assert.equal(resumedDeposit.cashRaw, "120000");
    assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), originalSlot);
    const result = await tasks.execute({ ...parent, recover: true });
    const evidence = result.phase === "Succeeded" ? undefined : {
      journal: JSON.parse(await readFile(join(directory, "chain/arena-http-journal.json"), "utf8").catch(() => "null")),
      solver: JSON.parse(await readFile(join(parent.directory, "task-executor/workflow/reward-task/solver/session.json"), "utf8").catch(() => "null")),
    };
    assert.equal(result.phase, "Succeeded", JSON.stringify({ ...result, evidence })); assert.equal(result.fromCashRaw, "120000"); assert.equal(result.fromCreditRaw, "0");
    assert.equal(result.acceptTxHash, paused.acceptTxHash); assert.equal(result.settlement?.loanStatus, "0"); assert.equal(result.settlement?.repaidRaw, "0"); assert.equal(calls, 1);
    const finishedSlot = JSON.parse(await readFile(slotPath, "utf8")), nonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await tasks.execute({ ...deposit, recover: true }), resumedDeposit);
    assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), finishedSlot);
    assert.deepEqual(await tasks.execute({ ...parent, recover: true }), result); assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    succeeded = true;
  } catch (error) {
    if (error instanceof Error) error.message += `\nPreserved metered refill failure fixture: ${directory}`;
    throw error;
  } finally { await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); relay.close(); await f.close(); if (succeeded) await rm(directory, { recursive: true, force: true }); }
});

test("autonomy refill validates the current child and restores its wallet slot before resuming the same parent", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-metered-deposit-")));
  let succeeded = false;
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const keyFile = join(directory, "model.key"); await writeFile(keyFile, "controlled", { mode: 0o600 });
  const catalog: [GatewayModel, GatewayModel] = [
    { id: "cheap", model: "cheap/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 256 },
    { id: "strong", model: "strong/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 },
  ];
  const relay = new InferenceAllowanceRelay({ ...f.fx.relayConfig, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
    upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
    { creditsRaw: "100000", modelCatalogDigest: modelCatalogDigest(catalog), provider: f.fx.f.provider });
  const server = createHttpServer(relay, new Refunder(relay)); await relay.initialize(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config = structuredClone(f.config); config.initialCashRaw = "40000";
  config.metered = { relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, payTo: f.fx.f.payee, priceRaw: "120000", creditsRaw: "100000", catalog, keyFile };
  let calls = 0;
  const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, gatewayDispatch: async (model) => {
    calls++; return { status: 200, body: modelToolResponse(f.GOOD_CODE["sum-integers"], model.model) };
  } });
  try {
    const actor = await f.actor(5, "cheap", 40000n); actor.agent.allowCredit = false;
    const ready = await tasks.execute(actor.input("provision")); assert.equal(ready.success, true, JSON.stringify(ready));
    actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const autonomous = new HostedAutonomyExecutor(tasks, { maxTasks: 1, maxDecisions: 2, durationMs: 120000,
      plannerRelayUrl: config.metered!.relayUrl, plannerProvider: f.fx.f.payee, plannerPriceRaw: "1", plannerService: "planner", plannerModel: "planner", plannerPhysicalModel: "planner" },
      { provider: f.fx.f.provider, planner: async () => ({ decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "0" }) });
    const parent = actor.input("task"); parent.run.action = "autonomous"; parent.run.reservedRaw = "240000";
    const parentPaused = await autonomous.execute(parent); assert.equal(parentPaused.phase, "Paused", JSON.stringify(parentPaused));
    const hostPath = join(parent.directory, "autonomy-host/session.json"), loopPath = join(parent.directory, "autonomy-loop/session.json");
    const host = JSON.parse(await readFile(hostPath, "utf8")), loop = JSON.parse(await readFile(loopPath, "utf8"));
    const child = host.children[loop.steps.at(-1).childId] as HostedExecution;
    const paused = JSON.parse(await readFile(join(child.directory, "task-executor/session.json"), "utf8")).result;
    assert.equal(paused.phase, "Paused", JSON.stringify(paused)); assert.equal(paused.reason, "INFERENCE_FUNDING_REQUIRED"); assert.ok(paused.acceptTxHash); assert.equal(calls, 0);
    const slotPath = join(config.walletDirectory, actor.wallet.address.toLowerCase(), "session.json");
    const originalSlot = JSON.parse(await readFile(slotPath, "utf8"));
    const wrong = actor.input("deposit"); wrong.run.amountRaw = "120000"; wrong.run.fundingFor = randomUUID();
    const rejected = await tasks.execute(wrong); assert.equal(rejected.reason, "HOSTED_DEPOSIT_PARENT_INVALID"); assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), originalSlot);
    const forged = structuredClone(host); forged.children[child.run.requestId].directory = actor.input("task").directory;
    await writeFile(hostPath, JSON.stringify(forged));
    const attack = actor.input("deposit"); attack.run.amountRaw = "80000"; attack.run.fundingFor = parent.run.requestId;
    assert.equal((await tasks.execute(attack)).reason, "HOSTED_DEPOSIT_PARENT_INVALID");
    assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), originalSlot); await writeFile(hostPath, JSON.stringify(host));
    const deposit = actor.input("deposit"); deposit.run.amountRaw = "80000"; deposit.run.fundingFor = parent.run.requestId;
    const unfunded = await tasks.execute(deposit); assert.equal(unfunded.reason, "HOSTED_AGENT_FUNDS_REQUIRED");
    const privateDeposit = JSON.parse(await readFile(join(deposit.directory, "task-executor/session.json"), "utf8"));
    assert.deepEqual(privateDeposit.suspended, originalSlot);
    assert.equal(JSON.parse(await readFile(slotPath, "utf8")).directory, join(deposit.directory, "task-executor/workflow"));
    f.fx.f.admin.reset(); await tx(f.fx.f.token!, f.fx.f.admin, "mint", [actor.wallet.address, 80000n]);
    const resumedDeposit = await tasks.execute({ ...deposit, recover: true });
    assert.equal(resumedDeposit.phase, "Deposited", JSON.stringify(resumedDeposit)); assert.equal(resumedDeposit.cashRaw, "120000");
    assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), originalSlot);
    const completed = await autonomous.execute({ ...parent, recover: true }); assert.equal(completed.phase, "Completed", JSON.stringify(completed));
    const result = await tasks.execute({ ...child, recover: true });
    const evidence = result.phase === "Succeeded" ? undefined : {
      journal: JSON.parse(await readFile(join(directory, "chain/arena-http-journal.json"), "utf8").catch(() => "null")),
      solver: JSON.parse(await readFile(join(child.directory, "task-executor/workflow/reward-task/solver/session.json"), "utf8").catch(() => "null")),
    };
    assert.equal(result.phase, "Succeeded", JSON.stringify({ ...result, evidence })); assert.equal(result.fromCashRaw, "120000"); assert.equal(result.fromCreditRaw, "0");
    assert.equal(result.acceptTxHash, paused.acceptTxHash); assert.equal(result.settlement?.loanStatus, "0"); assert.equal(result.settlement?.repaidRaw, "0"); assert.equal(calls, 1);
    const finishedSlot = JSON.parse(await readFile(slotPath, "utf8")), nonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await tasks.execute({ ...deposit, recover: true }), resumedDeposit);
    assert.deepEqual(JSON.parse(await readFile(slotPath, "utf8")), finishedSlot);
    assert.deepEqual(await autonomous.execute({ ...parent, recover: true }), completed); assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    succeeded = true;
  } catch (error) {
    if (error instanceof Error) error.message += `\nPreserved metered refill failure fixture: ${directory}`;
    throw error;
  } finally { await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); relay.close(); await f.close(); if (succeeded) await rm(directory, { recursive: true, force: true }); }
});

for (const parentAction of ["metered-task", "autonomous"] as const) test(`hosted admission keeps ${parentAction} parent reservation during deposit, restart and recovery`, async () => {
  const reserved = parentAction === "autonomous" ? "240000" : "120000";
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-metered-admission-")));
  const seen: HostedExecution[] = []; let taskReason = "INFERENCE_FUNDING_REQUIRED";
  const executor: HostedExecutor = { capabilities: { autonomy: { maxTasks: 1, durationMs: 120000, plannerPriceRaw: "1" }, inference: { priceRaw: "120000", creditsRaw: "100000", models: [] } }, async execute(input) {
    seen.push(structuredClone(input));
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (input.run.action === "deposit") return input.recover ? { phase: "Deposited", terminal: true, success: true, chargedRaw: "0" }
      : { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_TRANSACTION_UNCERTAIN" };
    return { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: taskReason };
  } };
  const config: HostedConfig = { directory, origin: "http://localhost:3020", chainId: "31337", models: [{ id: "cheap", label: "Cheap" }], maxAgentsPerOwner: 5, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "200000" };
  let service = await HostedService.open(config, executor);
  try {
    const who = Wallet.createRandom().address, a = await service.create(who, { name: "Refill", modelId: "cheap", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: false, requestId: randomUUID() }); await service.waitUntilIdle();
    const parent = randomUUID(); await service.command(who, a.id, { action: parentAction, requestId: parent }); await service.waitUntilIdle();
    await assert.rejects(service.command(who, a.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID() }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
    await assert.rejects(service.command(who, a.id, { action: "deposit", requestId: randomUUID(), amountRaw: "1", fundingFor: parent } as any), /HOSTED_INPUT_INVALID/);
    const refill = randomUUID(); const child = await service.command(who, a.id, { action: "deposit", requestId: refill, amountRaw: "120000" }); await service.waitUntilIdle();
    assert.equal(child.fundingFor, parent); assert.equal(child.reservedRaw, "0"); assert.equal((await service.snapshot(who)).agents[0].reservedRaw, reserved);
    await assert.rejects(service.command(who, a.id, { action: parentAction, requestId: parent }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
    await service.close(); service = await HostedService.open(config, executor);
    await service.command(who, a.id, { action: "deposit", requestId: refill, amountRaw: "120000" }); await service.waitUntilIdle();
    const restored = (await service.snapshot(who)).agents[0]; assert.equal(restored.activeRequestId, parent); assert.equal(restored.reservedRaw, reserved);
    assert.equal(seen.at(-1)!.run.fundingFor, parent); assert.equal(seen.at(-1)!.recover, true);
    taskReason = "UPSTREAM_DISPATCH_UNKNOWN";
    await service.command(who, a.id, { action: parentAction, requestId: parent }); await service.waitUntilIdle();
    await assert.rejects(service.command(who, a.id, { action: "deposit", requestId: randomUUID(), amountRaw: "120000" }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
  } finally { await service.close(); await rm(directory, { recursive: true, force: true }); }
});
