import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { HostedService, type HostedCommand } from "../src/service.js";
import type { AgentSettings, HostedConfig, HostedExecution, HostedExecutor, HostedResult } from "../src/types.js";

const settings: AgentSettings = { name: "Recovery", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: true };

async function fixture(t: TestContext, execute: HostedExecutor["execute"], release: () => void) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hosted-recovery-snapshot-")));
  const config: HostedConfig = { directory, origin: "http://localhost:3020", chainId: "31337", models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }], maxAgentsPerOwner: 5, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "200000" };
  let service = await HostedService.open(config, { execute });
  t.after(async () => { release(); await service.close(); await rm(directory, { recursive: true, force: true }); });
  return {
    get service() { return service; },
    async restart() { await service.close(); service = await HostedService.open(config, { execute }); }
  };
}

for (const original of [
  { action: "task" as const, reservedRaw: "120000", chargedRaw: "120000" },
  { action: "deposit" as const, amountRaw: "40000", reservedRaw: "0", chargedRaw: "0" },
  { action: "game" as const, rewardKind: "llm-credits" as const, reservedRaw: "0", chargedRaw: "0" }
]) {
  test(`owner snapshot retains an old recoverable ${original.action} and its parameters beyond 100 newer runs`, async t => {
    const initialTime = Date.parse("2026-10-11T00:00:00.000Z");
    t.mock.timers.enable({ apis: ["Date"], now: initialTime });
    const originalCommand: HostedCommand = { action: original.action, requestId: randomUUID() };
    if ("amountRaw" in original) originalCommand.amountRaw = original.amountRaw;
    if ("rewardKind" in original) originalCommand.rewardKind = original.rewardKind;
    const recentPausedId = randomUUID(), foreignPausedId = randomUUID();
    const pausedIds = new Set([originalCommand.requestId, recentPausedId, foreignPausedId]);
    const executions: HostedExecution[] = [];
    let bindingId = 0, releaseRecovery!: () => void, enteredRecovery!: () => void;
    const recoveryGate = new Promise<void>(resolve => releaseRecovery = resolve);
    const recoveryStarted = new Promise<void>(resolve => enteredRecovery = resolve);
    const f = await fixture(t, async input => {
      executions.push(input);
      if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: String(++bindingId), wallet: input.agent.wallet } };
      if (pausedIds.has(input.run.requestId) && !input.recover) throw new Error("MODEL_RESULT_UNKNOWN");
      if (input.run.requestId === originalCommand.requestId) {
        enteredRecovery(); await recoveryGate;
        return { phase: "Complete", terminal: true, success: true, chargedRaw: original.chargedRaw };
      }
      return { phase: "Complete", terminal: true, success: true, chargedRaw: "0" } satisfies HostedResult;
    }, () => releaseRecovery());

    const who = Wallet.createRandom().address, foreignOwner = Wallet.createRandom().address;
    const first = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
    const second = await f.service.create(who, { ...settings, name: "History", requestId: randomUUID() }); await f.service.waitUntilIdle();
    const foreign = await f.service.create(foreignOwner, { ...settings, name: "Foreign", requestId: randomUUID() }); await f.service.waitUntilIdle();
    await f.service.command(who, first.id, originalCommand); await f.service.waitUntilIdle();

    const historyIds: string[] = [];
    for (let n = 0; n < 105; n++) {
      const requestId = randomUUID(); historyIds.push(requestId);
      await f.service.command(who, second.id, { action: "credits", requestId }); await f.service.waitUntilIdle();
    }
    await f.service.command(who, second.id, { action: "task", requestId: recentPausedId }); await f.service.waitUntilIdle();
    await f.service.command(foreignOwner, foreign.id, { action: "task", requestId: foreignPausedId }); await f.service.waitUntilIdle();
    await f.restart();

    const snapshot = await f.service.snapshot(who.toLowerCase());
    const visibleIds = snapshot.runs.map(run => run.requestId);
    const recentIds = [recentPausedId, ...historyIds.slice(-99).reverse()];
    assert.deepEqual(visibleIds, [...recentIds, originalCommand.requestId]);
    assert.ok(snapshot.runs.every(run => run.updatedAt === new Date(initialTime).toISOString()), "equal timestamps must use reverse insertion order");
    assert.equal(new Set(visibleIds).size, visibleIds.length, "a recent active run must appear only once");
    assert.deepEqual(snapshot.agents.map(agent => agent.id), [first.id, second.id]);
    assert.ok(snapshot.runs.every(run => run.agentId === first.id || run.agentId === second.id));
    assert.ok(!visibleIds.includes(foreignPausedId));
    const foreignSnapshot = await f.service.snapshot(foreignOwner);
    assert.deepEqual(foreignSnapshot.agents.map(agent => agent.id), [foreign.id]);
    assert.ok(foreignSnapshot.runs.every(run => run.agentId === foreign.id));
    assert.ok(!foreignSnapshot.runs.some(run => visibleIds.includes(run.requestId)));

    const recoverable = snapshot.runs.find(run => run.requestId === originalCommand.requestId)!;
    assert.equal(recoverable.status, "Paused"); assert.equal(recoverable.recoverable, true);
    assert.equal(recoverable.reservedRaw, original.reservedRaw); assert.equal(recoverable.chargedRaw, "0");
    const pausedAgent = snapshot.agents.find(agent => agent.id === first.id)!;
    assert.equal(pausedAgent.activeRequestId, originalCommand.requestId);
    assert.equal(pausedAgent.reservedRaw, original.reservedRaw); assert.equal(pausedAgent.spentRaw, "0");
    const recoveryCommand: HostedCommand = { action: recoverable.action, requestId: recoverable.requestId };
    if (recoverable.amountRaw !== undefined) recoveryCommand.amountRaw = recoverable.amountRaw;
    if (recoverable.rewardKind !== undefined) recoveryCommand.rewardKind = recoverable.rewardKind;
    assert.deepEqual(recoveryCommand, originalCommand, "the visible run must contain every original command parameter");

    t.mock.timers.setTime(initialTime + 1000);
    await f.service.command(who, first.id, recoveryCommand); await recoveryStarted;
    const running = await f.service.snapshot(who);
    const recoveredHistoryIds = [originalCommand.requestId, recentPausedId, ...historyIds.slice(-98).reverse()];
    assert.deepEqual(running.runs.map(run => run.requestId), recoveredHistoryIds);
    assert.equal(running.runs.find(run => run.requestId === originalCommand.requestId)!.status, "Running");
    const attempts = executions.filter(input => input.run.requestId === originalCommand.requestId);
    assert.deepEqual(attempts.map(input => input.recover), [false, true], "recovery must never dispatch another fresh request");
    assert.equal(attempts[1].run.reservedRaw, original.reservedRaw);
    assert.equal(attempts[1].agent.reservedRaw, original.reservedRaw);
    assert.equal(attempts[1].run.createdAt, recoverable.createdAt);
    assert.equal(attempts[1].directory, attempts[0].directory);

    releaseRecovery(); await f.service.waitUntilIdle();
    const completed = await f.service.snapshot(who);
    assert.deepEqual(completed.runs.map(run => run.requestId), recoveredHistoryIds, "recently updated recovery results stay visible within the latest-100 history");
    assert.equal(completed.runs[0].status, "Succeeded");
    assert.equal(completed.runs[0].recoverable, false); assert.equal(completed.runs[0].chargedRaw, original.chargedRaw);
    const completedAgent = completed.agents.find(agent => agent.id === first.id)!;
    assert.equal(completedAgent.activeRequestId, undefined); assert.equal(completedAgent.reservedRaw, "0");
    assert.equal(completedAgent.spentRaw, original.chargedRaw);
    await f.service.command(who, first.id, recoveryCommand); await f.service.waitUntilIdle();
    assert.equal(executions.filter(input => input.run.requestId === originalCommand.requestId).length, 2);
    assert.equal((await f.service.snapshot(who)).agents.find(agent => agent.id === first.id)!.spentRaw, original.chargedRaw, "a completed retry must not charge twice");
  });
}
