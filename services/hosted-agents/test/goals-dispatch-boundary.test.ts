import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, realpath, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, keccak256, toUtf8Bytes } from "ethers";
import { Relay } from "../../provider-relay/src/relay.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { createHostedTaskFixture } from "./task-fixture.js";
import { HostedService } from "../src/service.js";
import { HostedGoalExecutor } from "../src/goals/executor.js";
import { assertRefundedGoalCancellation } from "../../../scripts/hosted-recovery-audit.js";
import { tx } from "../../underwriter/test/fixture.js";

test("typed paid pause, 38-block HTTP400, 10-block cold cursor recovery, refund and cancel stay idempotent", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tempo-dispatch-boundary-"))), f = await createHostedTaskFixture(join(directory, "chain"));
  let dispatches = 0, service: HostedService | undefined, mined = false;
  const ranges: { from: number; to: number; rejected: boolean }[] = [];
  const provider = f.fx.f.provider, originalLogs = provider.getLogs;
  let failFrom: number | undefined;
  provider.getLogs = async filter => {
    assert.ok("fromBlock" in filter && "toBlock" in filter);
    const from = Number(filter.fromBlock), to = Number(filter.toBlock), rejected = to - from + 1 > 10 || from === failFrom;
    ranges.push({ from, to, rejected });
    // Controlled local provider capability. It is not evidence of Alchemy's historical rejection reason.
    if (rejected) throw Object.assign(Error("controlled HTTP400 log range rejection"), { status: 400 });
    return originalLogs.call(provider, filter);
  };
  const relayConfig: import("../../provider-relay/src/config.js").RelayConfig = { ...f.fx.relayConfig, dataDir: join(directory, "relay"), service: { id: "tabby/mission", model: "logical", price: 10000n,
    upstreams: [{ name: "local", model: "physical", baseUrl: "http://127.0.0.1:1/v1", key: "synthetic" }] } };
  let relay = new Relay(relayConfig, { provider: f.fx.f.provider, upstreamFetch: async () => { dispatches++; throw new Error("UNEXPECTED_MODEL_CALL"); } });
  await relay.initialize(); let refunder = new Refunder(relay); await refunder.initialize();
  let server = createHttpServer(relay, refunder); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  const owner = Wallet.createRandom().address, hostedConfig = { directory: join(directory, "hosted"), origin: "http://127.0.0.1:3028", chainId: "31337" as const,
    models: [{ id: "cheap", label: "Isolated" }], maxAgentsPerOwner: 2, maxTotalBudgetRaw: "500000", maxPerRunBudgetRaw: "120000" };
  const goals = new HostedGoalExecutor({ durationMs: 120000, models: [{ id: "cheap", relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`,
    provider: f.fx.f.payee, priceRaw: "10000", service: "tabby/mission", model: "logical", physicalModel: "physical" }] }, f.config, {
    control: async (agentId, requestId) => {
      const control = await service!.goalControl(agentId, requestId), agent = (await service!.snapshot(owner)).agents.find(agent => agent.id === agentId)!;
      const paid = await f.fx.f.account.getFunction("cash").staticCall(agent.binding!.agentId) < 40000n;
      if (!mined && !paid) {
        const mission = await readFile(join(hostedConfig.directory, "agents", agentId, "runs", requestId, "mission/session.json"), "utf8").then(JSON.parse).catch(() => undefined);
        if (mission?.calls?.[0]?.handle?.quote) { mined = true; await provider.send("anvil_mine", ["0x24"]); }
      }
      return { ...control, paused: control.paused || paid };
    },
  });
  const executor = { capabilities: { goals: { maxPhases: 3, models: [{ id: "cheap", pricePerCallRaw: "10000" }] } }, async execute(input: import("../src/types.js").HostedExecution) {
    if (input.run.action === "provision") {
      await f.fx.f.provider.send("anvil_setBalance", [input.agent.wallet, "0x3635c9adc5dea00000"]);
      f.fx.f.admin.reset(); await tx(f.fx.f.token!, f.fx.f.admin, "mint", [input.agent.wallet, 40000n]);
      return f.executor.execute(input);
    }
    return goals.execute(input);
  } };
  try {
    service = await HostedService.open(hostedConfig, executor);
    const actor = await service.create(owner, { name: "Boundary actor", modelId: "cheap", strategy: "balanced", allowCredit: false, perRunBudgetRaw: "120000", totalBudgetRaw: "240000", requestId: randomUUID() });
    await service.waitUntilIdle(); const agent = (await service.snapshot(owner)).agents[0]; assert.ok(agent.binding);
    const requestId = randomUUID(); await service.command(owner, actor.id, { action: "goal", requestId, goal: "Write a short note" }); await service.waitUntilIdle();
    const paused = (await service.snapshot(owner)).runs.find(run => run.requestId === requestId)!;
    assert.equal(paused.status, "Paused", JSON.stringify(paused)); assert.equal(paused.result!.chargedRaw, "10000", JSON.stringify(paused)); assert.equal(dispatches, 0);
    const mission = JSON.parse(await readFile(join(hostedConfig.directory, "agents", actor.id, "runs", requestId, "mission/session.json"), "utf8"));
    const call = mission.calls[0], paymentId = call.handle.quote.paymentId;
    assert.equal(call.inference, undefined); assert.equal(call.response, undefined);
    assert.equal(call.firstControlError, "paused"); assert.equal(call.firstPaymentErrorCode, undefined);
    assert.equal(call.firstPaymentErrorCause, undefined);
    assert.equal(call.recovery.resolved, false);
    const quote = call.handle.quote, paymentHash = call.handle.submission.txHash;
    const record = await relay.store.read(paymentId); assert.equal(record.state, "Quoted"); assert.deepEqual(record.upstreamAttempts, []);
    const initial = ranges.splice(0); assert.ok(initial.length > 0);
    assert.ok(initial.every(range => range.from === quote.createdBlock && range.to === quote.createdBlock + 37 && range.rejected), JSON.stringify(initial));
    assert.equal((await provider.getTransactionReceipt(paymentHash))!.status, 1);
    const paymentNonce = await provider.getTransactionCount(agent.wallet);
    await assert.rejects(relay.confirm({ ...record, scanBlock: quote.createdBlock - 1 }), (e: any) => e.code === "STORE_BINDING_MISMATCH");
    assert.deepEqual(ranges, []);
    relayConfig.logScanChunkBlocks = 10;
    await service.close(); service = undefined;
    server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); relay.close();
    relay = new Relay(relayConfig, { provider: f.fx.f.provider, upstreamFetch: async () => { dispatches++; throw Error("NO_STARTUP_DISPATCH"); } });
    await relay.initialize();
    failFrom = quote.createdBlock + 10;
    await assert.rejects(relay.confirm(await relay.store.read(paymentId)), /controlled HTTP400/);
    assert.equal((await relay.store.read(paymentId)).scanBlock, failFrom);
    assert.deepEqual(ranges.splice(0), [
      { from: quote.createdBlock, to: quote.createdBlock + 9, rejected: false },
      { from: quote.createdBlock + 10, to: quote.createdBlock + 19, rejected: true },
    ]);
    relay.close(); // Fully replace the instance; failed second range remains the durable cursor.
    failFrom = undefined;
    relay = new Relay(relayConfig, { provider, upstreamFetch: async () => { dispatches++; throw Error("NO_COLD_DISPATCH"); } });
    await relay.initialize(); await relay.recover({ dispatch: false });
    const confirmed = await relay.store.read(paymentId);
    assert.equal(confirmed.state, "Paid"); assert.equal(confirmed.proof!.txHash, paymentHash);
    assert.deepEqual(confirmed.upstreamAttempts, []);
    assert.deepEqual(ranges.splice(0), [
      { from: quote.createdBlock + 10, to: quote.createdBlock + 19, rejected: false },
      { from: quote.createdBlock + 20, to: quote.createdBlock + 29, rejected: false },
      { from: quote.createdBlock + 30, to: quote.createdBlock + 37, rejected: false },
    ]);
    assert.equal(await provider.getTransactionCount(agent.wallet), paymentNonce); assert.equal(dispatches, 0);
    refunder = new Refunder(relay); await refunder.initialize();
    server = createHttpServer(relay, refunder); server.listen(port, "127.0.0.1"); await once(server, "listening");
    await refunder.refund(paymentId, keccak256(toUtf8Bytes("isolated-full-refund")), "10000");
    service = await HostedService.open(hostedConfig, executor, { recover: true });
    await service.cancelGoal(owner, actor.id, requestId); await service.waitUntilIdle();
    const final = (await service.snapshot(owner)).runs.find(run => run.requestId === requestId)!;
    assert.equal(assertRefundedGoalCancellation(final).refundedRaw, "10000");
    assert.equal(final.chargedRaw, "0"); assert.equal(final.result!.refundedRaw, "10000");
    assert.ok(final.activities!.some(event => event.state === "stopping"));
    assert.throws(() => assertRefundedGoalCancellation({ ...final, activities: undefined }), /HOSTED_REFUNDED_CANCEL_AUDIT_FAILED/);
    const nonce = await f.fx.f.provider.getTransactionCount(agent.wallet), database = await readFile(join(hostedConfig.directory, "database/session.json"), "utf8");
    await service.cancelGoal(owner, actor.id, requestId); await service.command(owner, actor.id, { action: "goal", requestId, goal: "Write a short note" }); await service.waitUntilIdle();
    assert.equal(await readFile(join(hostedConfig.directory, "database/session.json"), "utf8"), database);
    assert.equal(await f.fx.f.provider.getTransactionCount(agent.wallet), nonce); assert.equal(dispatches, 0);
    assert.equal((await relay.store.read(paymentId)).refunds.length, 1);
    if (process.env.RECOVERY_CLASSIFICATION_EVIDENCE) await writeFile(process.env.RECOVERY_CLASSIFICATION_EVIDENCE, JSON.stringify({
      engineeringOnly: true, chainId: 31337, realModel: false, firstControlError: call.firstControlError, firstPaymentErrorCode: call.firstPaymentErrorCode ?? null,
      quote, paymentHash, canonicalReceipt: (await provider.getTransactionReceipt(paymentHash))!.toJSON(),
      ranges: { rejected38: initial, firstTwo: [10, 10], coldRemaining: [10, 10, 8] }, cursorAfterFailure: quote.createdBlock + 10,
      canonicalProof: confirmed.proof, refundedRecord: await relay.store.read(paymentId), final,
      replay: { newModelDispatches: dispatches, nonceBefore: nonce, nonceAfter: await provider.getTransactionCount(agent.wallet), databaseUnchanged: true },
    }, null, 2), { mode: 0o600 });
  } finally { await service?.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); relay.close(); provider.getLogs = originalLogs; await f.close(); await rm(directory, { recursive: true, force: true }); }
});
