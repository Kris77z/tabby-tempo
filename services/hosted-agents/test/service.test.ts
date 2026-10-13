import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import type { AgentSettings, HostedConfig, HostedExecution, HostedExecutor, HostedResult } from "../src/types.js";
const settings: AgentSettings = { name: "Alice", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: true };
async function fixture(t: any, execute?: (input: HostedExecution) => Promise<HostedResult>) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hosted-core-"))); let counter = 0;
  const seen: HostedExecution[] = [];
  const executor: HostedExecutor = { async execute(input) {
    seen.push(input);
    if (execute) return execute(input);
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: String(++counter), wallet: input.agent.wallet } };
    return { phase: "Complete", terminal: true, success: true, chargedRaw: input.run.action === "task" ? "100000" : "0" };
  } };
  const config: HostedConfig = { directory, origin: "http://localhost:3020", chainId: "31337", models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }], maxAgentsPerOwner: 5, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "200000" };
  let service = await HostedService.open(config, executor);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { executor, get service() { return service; }, config, seen, async restart() { await service.close(); service = await HostedService.open(config, executor); return service; } };
}
test("signed owner login is domain-bound, single-use, expiring and revocable; only token hashes persist", async t => {
  const f = await fixture(t), wallet = Wallet.createRandom(), other = Wallet.createRandom();
  const c = await f.service.challenge(wallet.address);
  assert.match(c.message, /Origin: http:\/\/localhost:3020/);
  await assert.rejects(f.service.login(c.id, await other.signMessage(c.message)), /HOSTED_AUTH_INVALID/);
  await assert.rejects(f.service.login(c.id, await wallet.signMessage(c.message.replace("localhost", "evil"))), /HOSTED_AUTH_INVALID/);
  const login = await f.service.login(c.id, await wallet.signMessage(c.message));
  assert.equal(await f.service.authenticate(login.token), wallet.address);
  await assert.rejects(f.service.login(c.id, await wallet.signMessage(c.message)), /HOSTED_AUTH_INVALID/);
  assert.ok(!(await readFile(join(f.config.directory, "database/session.json"), "utf8")).includes(login.token));
  await f.restart(); assert.equal(await f.service.authenticate(login.token), wallet.address);
  await f.service.logout(login.token); await assert.rejects(f.service.authenticate(login.token), /HOSTED_AUTH_REQUIRED/);
  const expires = await f.service.challenge(wallet.address); const original = Date.now;
  try { Date.now = () => expires.expiresAt + 1; await assert.rejects(f.service.login(expires.id, await wallet.signMessage(expires.message)), /HOSTED_AUTH_INVALID/); }
  finally { Date.now = original; }
});
test("two owners get unique custody wallets, private keys and immutable ownership; retries never create extra agents", async t => {
  const f = await fixture(t), a = Wallet.createRandom(), b = Wallet.createRandom(), requestId = randomUUID();
  const first = await f.service.create(a.address, { ...settings, requestId }); await f.service.waitUntilIdle();
  const second = await f.service.create(b.address, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const retry = await f.service.create(a.address, { ...settings, requestId });
  assert.equal(retry.id, first.id); assert.notEqual(first.wallet, second.wallet);
  assert.equal(f.seen.length, 2); assert.equal((await f.service.snapshot(a.address)).agents.length, 1);
  assert.equal((await f.service.snapshot(b.address)).runs.length, 1);
  await assert.rejects(f.service.update(b.address, first.id, settings), /HOSTED_AGENT_NOT_FOUND/);
  await assert.rejects(f.service.pause(b.address, first.id, true), /HOSTED_AGENT_NOT_FOUND/);
  await assert.rejects(f.service.command(b.address, first.id, { action: "task", requestId: randomUUID() }), /HOSTED_AGENT_NOT_FOUND/);
  await assert.rejects(f.service.create(a.address, { ...settings, name: "Changed", requestId }), /HOSTED_REQUEST_CONFLICT/);
  const keyFile = join(f.config.directory, "agents", first.id, "wallet.key"), key = (await readFile(keyFile, "utf8")).trim();
  assert.equal(new Wallet(key).address, first.wallet); assert.equal((await stat(keyFile)).mode & 0o777, 0o600);
  assert.ok(!JSON.stringify(await f.service.snapshot(a.address)).includes(key));
});
test("durable per-agent reservation prevents concurrent overspend, retains unknowns and recovers only original request", async t => {
  let dispatched = 0;
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (!input.recover) { dispatched++; throw new Error("MODEL_RESULT_UNKNOWN"); }
    return { phase: "Complete", terminal: true, success: true, chargedRaw: "120000" };
  });
  const who = Wallet.createRandom().address, a = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const rid = randomUUID(); await f.service.command(who, a.id, { action: "task", requestId: rid }); await f.service.waitUntilIdle();
  assert.equal((await f.service.snapshot(who)).agents[0].reservedRaw, "120000");
  await assert.rejects(f.service.update(who, a.id, settings), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
  await assert.rejects(f.service.command(who, a.id, { action: "game", requestId: randomUUID(), rewardKind: "usdc" }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
  await f.restart(); await f.service.pause(who, a.id, true);
  await f.service.command(who, a.id, { action: "task", requestId: rid }); await f.service.waitUntilIdle();
  let snapshot = await f.service.snapshot(who); assert.equal(snapshot.agents[0].spentRaw, "120000"); assert.equal(snapshot.agents[0].reservedRaw, "0"); assert.equal(dispatched, 1);
  await f.service.command(who, a.id, { action: "task", requestId: rid }); assert.equal(dispatched, 1);
  await assert.rejects(f.service.command(who, a.id, { action: "task", requestId: randomUUID() }), /HOSTED_AGENT_PAUSED/);
  await f.service.pause(who, a.id, false);
  const rid2 = randomUUID(); await f.service.command(who, a.id, { action: "task", requestId: rid2 }); await f.service.waitUntilIdle();
  await f.service.command(who, a.id, { action: "task", requestId: rid2 }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(who, a.id, { action: "task", requestId: randomUUID() }), /HOSTED_BUDGET_EXHAUSTED/);
});
test("invalid executor output cannot leak secrets, swap binding, release budgets or report success", async t => {
  const f = await fixture(t, async input => ({ phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: Wallet.createRandom().address }, privateKey: "secret" } as any));
  const who = Wallet.createRandom().address, a = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const s = await f.service.snapshot(who); assert.equal(s.agents[0].binding, undefined); assert.equal(s.runs[0].status, "Paused"); assert.equal(s.runs[0].recoverable, true); assert.ok(!JSON.stringify(s).includes("secret"));
  await assert.rejects(f.service.command(who, a.id, { action: "task", requestId: randomUUID() }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
});
test("free game sponsorship is owner-scoped, persists across restart and cannot be reset by a new Agent", async t => {
  const f = await fixture(t), who = Wallet.createRandom().address;
  const a = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  for (let n = 0; n < 3; n++) { await f.service.command(who, a.id, { action: "game", requestId: randomUUID(), rewardKind: "llm-credits" }); await f.service.waitUntilIdle(); }
  const b = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle(); await f.restart();
  await assert.rejects(f.service.command(who, b.id, { action: "game", requestId: randomUUID(), rewardKind: "usdc" }), /HOSTED_SPONSOR_LIMIT/);
  assert.equal((await f.service.snapshot(who)).agents[0].spentRaw, "0");
});

test("deposit is owner-bound with exact immutable amount and does not consume inference budget", async t => {
  const f = await fixture(t), who = Wallet.createRandom().address;
  const a = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  for (const amountRaw of ["0", "-1", "1.5", "999999999", "01"]) await assert.rejects(f.service.command(who, a.id, { action: "deposit", requestId: randomUUID(), amountRaw }), /HOSTED_DEPOSIT_AMOUNT_INVALID/);
  const requestId = randomUUID(); await f.service.command(who, a.id, { action: "deposit", requestId, amountRaw: "40000" }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(who, a.id, { action: "deposit", requestId, amountRaw: "50000" }), /HOSTED_REQUEST_CONFLICT/);
  await f.service.command(who, a.id, { action: "deposit", requestId, amountRaw: "40000" }); assert.equal(f.seen.length, 2);
  assert.equal((await f.service.snapshot(who)).agents[0].spentRaw, "0");
  await assert.rejects(f.service.command(who, a.id, { action: "task", requestId: randomUUID(), amountRaw: "40000" }), /HOSTED_DEPOSIT_AMOUNT_INVALID/);
});

test("concurrent cross-owner create UUID collision rejects before another custody wallet/creation is admitted", async t => {
  const f = await fixture(t), owners = [Wallet.createRandom().address, Wallet.createRandom().address], requestId = randomUUID();
  const results = await Promise.allSettled(owners.map(who => f.service.create(who, { ...settings, requestId })));
  await f.service.waitUntilIdle(); assert.equal(results.filter(r => r.status === "fulfilled").length, 1);
  assert.equal(results.filter(r => r.status === "rejected").length, 1);
  const views = await Promise.all(owners.map(who => f.service.snapshot(who))); assert.equal(views.reduce((n, s) => n + s.agents.length, 0), 1);
  assert.equal(f.seen.length, 1);
});

test("close drains a creation still awaiting durable admission and its subsequently queued provisioning job", async t => {
  let entered!: () => void, release!: () => void;
  const executing = new Promise<void>(done => entered = done), gate = new Promise<void>(done => release = done);
  const f = await fixture(t, async input => { entered(); await gate; return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } }; });
  const who = Wallet.createRandom().address;
  const creation = f.service.create(who, { ...settings, requestId: randomUUID() });
  let closed = false; const closing = f.service.close().then(() => closed = true);
  await executing; assert.equal(closed, false); release();
  const a = await creation; await closing;
  await f.restart(); const snapshot = await f.service.snapshot(who);
  assert.equal(snapshot.agents[0].id, a.id); assert.equal(snapshot.agents[0].status, "Ready"); assert.equal(snapshot.runs[0].status, "Succeeded");
});

test("only a known reward funding pause admits a bounded refuel game and restores the original request after restart", async t => {
  let funded = false;
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (input.run.action === "game") { funded = true; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 4096 }; }
    return funded ? { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsUsed: 30 }
      : { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "INFERENCE_FUNDING_REQUIRED" };
  });
  const who = Wallet.createRandom().address, a = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const requestId = randomUUID(); await f.service.command(who, a.id, { action: "reward-task", requestId }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(who, a.id, { action: "task", requestId: randomUUID() }), /RECOVER_ORIGINAL/);
  await assert.rejects(f.service.command(who, a.id, { action: "game", rewardKind: "usdc", requestId: randomUUID() }), /RECOVER_ORIGINAL/);
  await assert.rejects(f.service.command(who, a.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID(), fundingFor: requestId } as any), /INPUT_INVALID/);
  const gameId = randomUUID(), game = await f.service.command(who, a.id, { action: "game", rewardKind: "llm-credits", requestId: gameId });
  assert.equal(game.fundingFor, requestId); await f.service.waitUntilIdle();
  await f.restart(); assert.equal((await f.service.snapshot(who)).agents[0].activeRequestId, requestId);
  await f.service.command(who, a.id, { action: "game", rewardKind: "llm-credits", requestId: gameId });
  assert.equal(f.seen.filter(i => i.run.action === "game").length, 1);
  await f.service.command(who, a.id, { action: "reward-task", requestId }); await f.service.waitUntilIdle();
  const final = await f.service.snapshot(who); assert.equal(final.agents[0].activeRequestId, undefined);
  assert.equal(final.agents[0].spentRaw, "0"); assert.equal(final.runs.find(r => r.requestId === requestId)?.status, "Succeeded");
});


test("metered/autonomous admission exposes configured capabilities and reserves the entire remaining autonomous budget", async t => {
  const f = await fixture(t, async input => input.run.action === "provision"
    ? { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } }
    : { phase: "Completed", terminal: true, success: true, chargedRaw: "230000", autonomousTasks: 2 });
  const who = Wallet.createRandom().address, a = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(who, a.id, { action: "metered-task", requestId: randomUUID() }), /HOSTED_METERED_NOT_CONFIGURED/);
  await assert.rejects(f.service.command(who, a.id, { action: "autonomous", requestId: randomUUID() }), /HOSTED_AUTONOMY_NOT_CONFIGURED/);
  f.executor.capabilities = { inference: { priceRaw: "120000", creditsRaw: "100000", models: [] }, autonomy: { maxTasks: 2, durationMs: 180000, plannerPriceRaw: "10000" } };
  const requestId = randomUUID(), run = await f.service.command(who, a.id, { action: "autonomous", requestId });
  assert.equal(run.reservedRaw, "240000"); await f.service.waitUntilIdle();
  const snapshot = await f.service.snapshot(who); assert.deepEqual(snapshot.capabilities, f.executor.capabilities);
  assert.equal(snapshot.agents[0].spentRaw, "230000"); assert.equal(snapshot.agents[0].reservedRaw, "0"); assert.equal(snapshot.runs[0].result?.autonomousTasks, 2);
  await f.service.command(who, a.id, { action: "autonomous", requestId }); assert.equal(f.seen.length, 2);
});

test("failed parser recovery requires trusted cached proof and rebooks spending once under the original UUID", async t => {
  let calls = 0, allow = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    calls++;
    if (calls === 1) return { phase: "Stopped", terminal: true, success: false, chargedRaw: "10000", reason: "AUTONOMY_INVALID_DECISION", autonomousTasks: 0 };
    assert.equal(input.recover, true); assert.equal(input.agent.spentRaw, "0"); assert.equal(input.run.reservedRaw, "240000");
    assert.equal(input.run.terminalRecovery?.rebasedChargedRaw, "10000"); await gate;
    return { phase: "Completed", terminal: true, success: true, chargedRaw: "130000", autonomousTasks: 1 };
  });
  f.executor.capabilities = { autonomy: { maxTasks: 2, durationMs: 10000, plannerPriceRaw: "10000" } };
  f.executor.canRecoverTerminal = async input => { assert.equal(input.run.status, "Failed"); assert.equal(input.agent.spentRaw, "10000"); return allow; };
  const who = Wallet.createRandom().address, agent = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const command = { action: "autonomous", requestId: randomUUID() } as const;
  await f.service.command(who, agent.id, command); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(who, agent.id, command), /CACHED_DECISION_RECOVERY_UNAVAILABLE/);
  assert.equal((await f.service.snapshot(who)).agents[0].spentRaw, "10000");
  allow = true; await f.service.command(who, agent.id, command); await f.service.command(who, agent.id, command);
  const pending = await f.service.snapshot(who); assert.equal(pending.agents[0].spentRaw, "0"); assert.equal(pending.agents[0].reservedRaw, "240000");
  assert.equal(pending.runs.find(run => run.requestId === command.requestId)?.terminalRecovery?.previousResult.reason, "AUTONOMY_INVALID_DECISION");
  release(); await f.service.waitUntilIdle(); await f.restart(); await f.service.command(who, agent.id, command);
  const result = await f.service.snapshot(who); assert.equal(result.agents[0].spentRaw, "130000"); assert.equal(result.agents[0].reservedRaw, "0"); assert.equal(calls, 2);
});
