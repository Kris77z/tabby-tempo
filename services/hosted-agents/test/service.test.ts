import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, writeFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { HostedService, type HostedServiceOptions } from "../src/service.js";
import type { AgentSettings, HostedConfig, HostedExecution, HostedExecutor, HostedResult } from "../src/types.js";
const settings: AgentSettings = { name: "Alice", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: true };
test("name-only creation survives restart without spending authority; settings unlock execution and original creation remains idempotent", async t => {
  const f = await fixture(t), who = Wallet.createRandom().address, requestId = randomUUID();
  const created = await f.service.create(who, { name: " New Agent ", requestId });
  await f.service.waitUntilIdle(); await f.restart();
  const agent = (await f.service.snapshot(who)).agents[0];
  assert.equal(agent.id, created.id); assert.equal(agent.name, "New Agent");
  assert.equal(agent.status, "Ready"); assert.ok(agent.binding);
  assert.equal(agent.configurationRequired, true); assert.equal(agent.modelId, "");
  assert.equal(agent.perRunBudgetRaw, "0"); assert.equal(agent.totalBudgetRaw, "0"); assert.equal(agent.allowCredit, false);
  for (const action of ["task", "metered-task", "autonomous", "game", "credits", "reward-task"] as const) {
    await assert.rejects(f.service.command(who, agent.id, { action, requestId: randomUUID(), ...(action === "game" ? { rewardKind: "usdc" as const } : {}) }), /HOSTED_CONFIGURATION_REQUIRED/);
  }
  assert.equal(f.seen.length, 1);
  await f.service.command(who, agent.id, { action: "deposit", amountRaw: "40000", requestId: randomUUID() }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.update(who, agent.id, { ...settings, modelId: "missing" }), /HOSTED_SETTINGS_INVALID/);
  assert.equal((await f.service.snapshot(who)).agents[0].configurationRequired, true);
  await f.service.update(who, agent.id, { ...settings, name: "Renamed", allowCredit: false });
  await f.restart();
  const replay = await f.service.create(who, { name: "New Agent", requestId });
  assert.equal(replay.id, agent.id); assert.equal(replay.name, "Renamed"); assert.equal(replay.configurationRequired, false);
  assert.equal(f.seen.length, 2);
  await f.service.command(who, agent.id, { action: "task", requestId: randomUUID() }); await f.service.waitUntilIdle();
  assert.equal((await f.service.snapshot(who)).agents[0].spentRaw, "100000");
  await assert.rejects(f.service.create(who, { name: "Partial", allowCredit: true, requestId: randomUUID() } as any), /HOSTED_SETTINGS_INVALID/);
});
async function fixture(t: any, execute?: (input: HostedExecution) => Promise<HostedResult>, options: HostedServiceOptions = {}) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "hosted-core-"))); let counter = 0;
  const seen: HostedExecution[] = [];
  const executor: HostedExecutor = { async execute(input) {
    seen.push(input);
    if (execute) return execute(input);
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: String(++counter), wallet: input.agent.wallet } };
    return { phase: "Complete", terminal: true, success: true, chargedRaw: input.run.action === "task" ? "100000" : "0" };
  } };
  const config: HostedConfig = { directory, origin: "http://localhost:3020", chainId: "31337", models: [{ id: "kimi-k2.6", label: "Kimi K2.6" }], maxAgentsPerOwner: 5, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "200000" };
  let service = await HostedService.open(config, executor, options);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { executor, get service() { return service; }, config, seen, async restart() { await service.close(); service = await HostedService.open(config, executor, options); return service; } };
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
test("authenticated zero-Agent snapshots retain their normalized owner across restart, account switch and logout", async t => {
  const f = await fixture(t), first = Wallet.createRandom(), second = Wallet.createRandom();
  const signIn = async (wallet: typeof first) => {
    const challenge = await f.service.challenge(wallet.address);
    return f.service.login(challenge.id, await wallet.signMessage(challenge.message));
  };
  const firstLogin = await signIn(first);
  const firstSnapshot = await f.service.snapshot(await f.service.authenticate(firstLogin.token));
  assert.equal(firstSnapshot.owner, first.address); assert.deepEqual(firstSnapshot.agents, []); assert.deepEqual(firstSnapshot.runs, []);
  assert.equal((await f.service.snapshot(first.address.toLowerCase())).owner, first.address);
  await f.restart();
  assert.equal((await f.service.snapshot(await f.service.authenticate(firstLogin.token))).owner, first.address);
  await f.service.create(first.address, { name: "First owner's Agent", requestId: randomUUID() }); await f.service.waitUntilIdle();
  const secondLogin = await signIn(second), secondSnapshot = await f.service.snapshot(await f.service.authenticate(secondLogin.token));
  assert.equal(secondSnapshot.owner, second.address); assert.deepEqual(secondSnapshot.agents, []); assert.deepEqual(secondSnapshot.runs, []);
  assert.equal((await f.service.snapshot(await f.service.authenticate(firstLogin.token))).agents.length, 1);
  await f.service.logout(secondLogin.token); await f.restart();
  await assert.rejects(f.service.authenticate(secondLogin.token), /HOSTED_AUTH_REQUIRED/);
  assert.equal((await f.service.snapshot(await f.service.authenticate(firstLogin.token))).owner, first.address);
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

test("funded autonomous parent runs consume no sponsorship slots and may continue after the game ceiling", async t => {
  const f = await fixture(t), who = Wallet.createRandom().address;
  f.executor.capabilities = { autonomy: { maxTasks: 1, durationMs: 60000, plannerPriceRaw: "10000", games: { maxGames: 2, rewardKinds: ["usdc", "llm-credits"] } } };
  const actor = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const parentId = randomUUID(); await f.service.command(who, actor.id, { action: "autonomous", requestId: parentId }); await f.service.waitUntilIdle();
  await f.restart(); await f.service.command(who, actor.id, { action: "autonomous", requestId: parentId });
  await f.service.command(who, actor.id, { action: "autonomous", requestId: randomUUID() }); await f.service.waitUntilIdle();
  const database = JSON.parse(await readFile(join(f.config.directory, "database", "session.json"), "utf8"));
  assert.equal(database.sponsoredOwners[who] ?? 0, 0); assert.equal(database.sponsoredTotal, 0);
  for (let n = 0; n < 3; n++) { await f.service.command(who, actor.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID() }); await f.service.waitUntilIdle(); }
  const other = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle(); await f.restart();
  await f.service.command(who, other.id, { action: "autonomous", requestId: randomUUID() }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(who, other.id, { action: "game", rewardKind: "usdc", requestId: randomUUID() }), /HOSTED_SPONSOR_LIMIT/);
  assert.equal(f.seen.filter(input => input.run.action === "autonomous").length, 3);
});

test("automatic child admission persists each actual entry once across unknown recovery and rejects the fourth before dispatch", async t => {
  const children = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]; let parents = 0, modelRequests = 0;
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (input.recover) {
      await f.service.admitAutonomyGame(input.run.requestId, children[0], input.agent.id);
      return { phase: "Completed", terminal: true, success: true, chargedRaw: "0", autonomousTasks: 0, autonomousGames: 1 };
    }
    parents++;
    for (const child of parents === 1 ? children.slice(0, 1) : parents === 2 ? children.slice(1, 3) : children.slice(3)) {
      try { await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id); }
      catch (error) { assert.match((error as Error).message, /HOSTED_SPONSOR_LIMIT/); return { phase: "Stopped", terminal: true, success: false, chargedRaw: "0", reason: "HOSTED_SPONSOR_LIMIT", autonomousGames: 0, autonomousTasks: 0 }; }
      await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id); modelRequests++;
    }
    return parents === 1 ? { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_GAME_UPSTREAM_UNKNOWN", autonomousGames: 0 }
      : { phase: "Completed", terminal: true, success: true, chargedRaw: "0", autonomousGames: 2, autonomousTasks: 0 };
  });
  f.executor.capabilities = { autonomy: { maxTasks: 1, durationMs: 60000, plannerPriceRaw: "10000", games: { maxGames: 2, rewardKinds: ["usdc", "llm-credits"] } } };
  const who = Wallet.createRandom().address, actor = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const first = randomUUID(); await f.service.command(who, actor.id, { action: "autonomous", requestId: first }); await f.service.waitUntilIdle(); await f.restart();
  await f.service.command(who, actor.id, { action: "autonomous", requestId: first }); await f.service.waitUntilIdle(); assert.equal(modelRequests, 1);
  await f.service.command(who, actor.id, { action: "autonomous", requestId: randomUUID() }); await f.service.waitUntilIdle();
  const denied = randomUUID(); await f.service.command(who, actor.id, { action: "autonomous", requestId: denied }); await f.service.waitUntilIdle();
  const run = (await f.service.snapshot(who)).runs.find(run => run.requestId === denied)!;
  assert.equal(run.status, "Failed"); assert.equal(run.reason, "HOSTED_SPONSOR_LIMIT"); assert.equal(modelRequests, 3);
  const database = JSON.parse(await readFile(join(f.config.directory, "database", "session.json"), "utf8"));
  assert.equal(database.sponsoredOwners[who], 3); assert.equal(database.sponsoredTotal, 3); assert.equal(Object.keys(database.autonomousGameAdmissions).length, 3);
  await assert.rejects(f.service.command(who, actor.id, { action: "game", rewardKind: "usdc", requestId: children[0] }), /HOSTED_REQUEST_CONFLICT/);
  await assert.rejects(f.service.create(who, { ...settings, requestId: children[0] }), /HOSTED_REQUEST_CONFLICT/);
  await assert.rejects(f.service.admitAutonomyGame(denied, randomUUID(), actor.id), /HOSTED_AUTONOMY_GAME_ADMISSION_INVALID/);
});

test("automatic child admission shares the global sponsor ceiling and never dispatches a game beyond 100", async t => {
  let requests = 0;
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    for (let n = 0; n < 2; n++) {
      try { await f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id); }
      catch (error) { assert.match((error as Error).message, /HOSTED_SPONSOR_LIMIT/); return { phase: "Stopped", terminal: true, success: false, chargedRaw: "0", reason: "HOSTED_SPONSOR_LIMIT", autonomousGames: 1 }; }
      requests++;
    }
    throw new Error("global limit must have rejected second new game");
  });
  f.executor.capabilities = { autonomy: { maxTasks: 1, durationMs: 60000, plannerPriceRaw: "10000", games: { maxGames: 2, rewardKinds: ["usdc"] } } };
  await f.service.close(); const path = join(f.config.directory, "database", "session.json");
  const state = JSON.parse(await readFile(path, "utf8")); state.sponsoredTotal = 99; await writeFile(path, JSON.stringify(state)); await f.restart();
  const who = Wallet.createRandom().address, actor = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const requestId = randomUUID(); await f.service.command(who, actor.id, { action: "autonomous", requestId }); await f.service.waitUntilIdle();
  assert.equal(requests, 1); assert.equal((await f.service.snapshot(who)).runs.find(run => run.requestId === requestId)?.reason, "HOSTED_SPONSOR_LIMIT");
  const database = JSON.parse(await readFile(path, "utf8")); assert.equal(database.sponsoredTotal, 100); assert.equal(database.sponsoredOwners[who], 1);
});

test("manual autonomous token replenishment uses a private bound child route, recovers unknown same game and restores original parent", async t => {
  let funded = false, gameRecovered = false, resolutions = 0; const childId = randomUUID();
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (input.run.action === "game") {
      assert.equal(input.run.fundingFor, childId); assert.equal(input.agent.modelId, "kimi-k2.6"); assert.equal(input.agent.allowCredit, false);
      assert.equal(input.directory, join(f.config.directory, "agents", input.agent.id, "runs", parentId, "children", input.run.requestId));
      if (!input.recover) return { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_GAME_UPSTREAM_UNKNOWN" };
      gameRecovered = true; funded = true; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", creditsGranted: 4096 };
    }
    assert.equal(input.run.action, "autonomous");
    if (!input.recover) {
      await f.service.admitAutonomyGame(input.run.requestId, automaticGameIds[0], input.agent.id);
      await f.service.admitAutonomyGame(input.run.requestId, automaticGameIds[1], input.agent.id);
    }
    return funded ? { phase: "Completed", terminal: true, success: true, chargedRaw: "0", autonomousTasks: 1, autonomousGames: 2 }
      : { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "AUTONOMY_GAME_LIMIT", autonomousTasks: 0, autonomousGames: 2 };
  }, { autonomyFunding: async input => { resolutions++; assert.equal(input.run.requestId, parentId); return { childId, modelId: "kimi-k2.6", funding: "reward-tokens" }; } });
  f.executor.capabilities = { autonomy: { maxTasks: 1, durationMs: 60000, plannerPriceRaw: "10000", games: { maxGames: 2, rewardKinds: ["llm-credits"] } } };
  const who = Wallet.createRandom().address, other = Wallet.createRandom().address;
  const actor = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const parentId = randomUUID(), automaticGameIds = [randomUUID(), randomUUID()]; await f.service.command(who, actor.id, { action: "autonomous", requestId: parentId }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(other, actor.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID() }), /HOSTED_AGENT_NOT_FOUND/);
  assert.equal((await f.service.snapshot(who)).runs.find(run => run.requestId === parentId)?.fundingNeed, "reward-tokens");
  await assert.rejects(f.service.command(who, actor.id, { action: "game", rewardKind: "usdc", requestId: randomUUID() }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
  await assert.rejects(f.service.command(who, actor.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID(), fundingFor: childId } as any), /HOSTED_INPUT_INVALID/);
  const gameId = randomUUID(), game = await f.service.command(who, actor.id, { action: "game", rewardKind: "llm-credits", requestId: gameId });
  assert.equal(game.fundingFor, parentId); await f.service.waitUntilIdle(); await f.restart();
  await assert.rejects(f.service.command(who, actor.id, { action: "autonomous", requestId: parentId }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
  const calls = resolutions; await f.service.command(who, actor.id, { action: "game", rewardKind: "llm-credits", requestId: gameId }); await f.service.waitUntilIdle();
  assert.equal(resolutions, calls); assert.equal(gameRecovered, true);
  const resumed = await f.service.snapshot(who); assert.equal(resumed.agents[0].activeRequestId, parentId); assert.equal(resumed.agents[0].reservedRaw, "240000");
  assert.equal(JSON.stringify(resumed).includes(childId), false, "private child route is not caller-controlled or public metadata");
  await f.service.command(who, actor.id, { action: "autonomous", requestId: parentId }); await f.service.waitUntilIdle();
  const final = await f.service.snapshot(who); assert.equal(final.agents[0].activeRequestId, undefined); assert.equal(final.runs.find(run => run.requestId === parentId)?.status, "Succeeded");
  assert.equal(final.runs.find(run => run.requestId === parentId)?.fundingNeed, undefined);
  const database = JSON.parse(await readFile(join(f.config.directory, "database", "session.json"), "utf8")); assert.equal(database.sponsoredOwners[who], 3);
  assert.equal(f.seen.filter(input => input.run.action === "game" && !input.recover).length, 1);
});

test("cash deposit for paused autonomous child preserves the parent reservation and original sibling wallet journal", async t => {
  let deposited = false; const childId = randomUUID(), parentId = randomUUID();
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (input.run.action === "deposit") {
      assert.equal(input.run.fundingFor, childId); assert.equal(input.run.amountRaw, "40000");
      assert.equal(input.directory, join(f.config.directory, "agents", input.agent.id, "runs", parentId, "children", input.run.requestId)); deposited = true;
      return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "0", cashRaw: "40000" };
    }
    return deposited ? { phase: "Completed", terminal: true, success: true, chargedRaw: "130000", autonomousTasks: 1 }
      : { phase: "Paused", terminal: false, success: false, chargedRaw: "10000", reason: "INFERENCE_FUNDING_REQUIRED", autonomousTasks: 0 };
  }, { autonomyFunding: async () => ({ childId, modelId: "kimi-k2.6", funding: "cash" }) });
  f.executor.capabilities = { autonomy: { maxTasks: 1, durationMs: 60000, plannerPriceRaw: "10000" } };
  const who = Wallet.createRandom().address, actor = await f.service.create(who, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  await f.service.command(who, actor.id, { action: "autonomous", requestId: parentId }); await f.service.waitUntilIdle();
  assert.equal((await f.service.snapshot(who)).runs.find(run => run.requestId === parentId)?.fundingNeed, "cash");
  await assert.rejects(f.service.command(who, actor.id, { action: "game", rewardKind: "llm-credits", requestId: randomUUID() }), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
  const deposit = await f.service.command(who, actor.id, { action: "deposit", requestId: randomUUID(), amountRaw: "40000" }); await f.service.waitUntilIdle();
  assert.equal(deposit.fundingFor, parentId); const snapshot = await f.service.snapshot(who); assert.equal(snapshot.agents[0].activeRequestId, parentId); assert.equal(snapshot.agents[0].reservedRaw, "240000");
  assert.equal(snapshot.agents[0].spentRaw, "0"); await f.restart();
  await f.service.command(who, actor.id, { action: "autonomous", requestId: parentId }); await f.service.waitUntilIdle();
  assert.equal((await f.service.snapshot(who)).agents[0].spentRaw, "130000");
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


test("goal admission binds exact text and owner; progress survives recovery and cancellation releases only reconciled budget", async t => {
  let goalCalls = 0;
  const mission = { stage: "executing" as const, phases: [{ name: "分析", taskType: "analyst", goal: "比较方案", output: "已完成对比" }], calls: [{ stage: "plan", model: "kimi-k2.6", chargedRaw: "10000", promptTokens: 32, completionTokens: 20 }] };
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    goalCalls++; assert.equal(input.run.action, "goal"); assert.equal(typeof input.progress, "function");
    if (!input.recover) {
      await input.progress!({ ...mission, privateKey: "DO_NOT_PROJECT", phases: [{ ...mission.phases[0], rawTransaction: "DO_NOT_PROJECT" }] } as any);
      return { phase: "Paused", terminal: false, success: false, chargedRaw: "10000", reason: "HOSTED_GOAL_CALL_UNCERTAIN" };
    }
    assert.equal(input.run.stopRequested, true); assert.deepEqual(input.run.mission, mission);
    assert.deepEqual(await f.service.goalControl(input.agent.id, input.run.requestId), { paused: false, cancelled: true });
    const cancelled = { ...mission, stage: "cancelled" as const }; await input.progress!(cancelled);
    return { phase: "Cancelled", terminal: true, success: false, chargedRaw: "10000", reason: "HOSTED_GOAL_CANCELLED", mission: cancelled };
  });
  f.executor.capabilities = { goals: { maxPhases: 3, models: [{ id: "kimi-k2.6", pricePerCallRaw: "10000" }] } };
  const owner = Wallet.createRandom().address, other = Wallet.createRandom().address;
  const agent = await f.service.create(owner, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const command = { action: "goal" as const, goal: "  帮我比较三种方案\nKeep exact whitespace.  ", requestId: randomUUID() };
  await assert.rejects(f.service.command(other, agent.id, command), /HOSTED_AGENT_NOT_FOUND/);
  for (const goal of ["", " ", "x".repeat(12001), "bad\u0000goal"]) await assert.rejects(f.service.command(owner, agent.id, { ...command, goal }), /HOSTED_GOAL_INVALID/);
  const admitted = await f.service.command(owner, agent.id, command); assert.equal(admitted.reservedRaw, "120000"); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(owner, agent.id, { ...command, goal: command.goal.trim() }), /HOSTED_REQUEST_CONFLICT/);
  await assert.rejects(f.service.cancelGoal(other, agent.id, command.requestId), /HOSTED_AGENT_NOT_FOUND/);
  assert.deepEqual((await f.service.snapshot(other)).runs, []);
  await f.restart(); const pending = await f.service.snapshot(owner), run = pending.runs.find(r => r.requestId === command.requestId)!;
  assert.equal(run.goal, command.goal); assert.deepEqual(run.mission, mission); assert.equal(run.status, "Paused");
  assert.equal(pending.agents[0].reservedRaw, "120000"); assert.equal(pending.agents[0].spentRaw, "0");
  assert.doesNotMatch(await readFile(join(f.config.directory, "database/session.json"), "utf8"), /DO_NOT_PROJECT/);
  await f.service.cancelGoal(owner, agent.id, command.requestId); await f.service.waitUntilIdle(); await f.restart();
  const final = await f.service.snapshot(owner), stopped = final.runs.find(r => r.requestId === command.requestId)!;
  assert.equal(stopped.status, "Failed"); assert.equal(stopped.reason, "HOSTED_GOAL_CANCELLED"); assert.equal(stopped.mission?.stage, "cancelled");
  assert.equal(final.agents[0].spentRaw, "10000"); assert.equal(final.agents[0].reservedRaw, "0"); assert.equal(final.agents[0].activeRequestId, undefined);
  await f.service.cancelGoal(owner, agent.id, command.requestId); await f.service.command(owner, agent.id, command); await f.service.waitUntilIdle(); assert.equal(goalCalls, 2);
});

test("non-goal executors remain structuredClone compatible and goal commands require configured capability", async t => {
  const f = await fixture(t, async input => {
    assert.equal("progress" in input, false); assert.deepEqual(structuredClone(input), input);
    return input.run.action === "provision" ? { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } }
      : { phase: "Complete", terminal: true, success: true, chargedRaw: "10000" };
  });
  const owner = Wallet.createRandom().address, agent = await f.service.create(owner, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  await assert.rejects(f.service.command(owner, agent.id, { action: "goal", goal: "Draft a plan", requestId: randomUUID() }), /HOSTED_GOAL_NOT_CONFIGURED/);
  await f.service.command(owner, agent.id, { action: "task", requestId: randomUUID() }); await f.service.waitUntilIdle();
  assert.equal((await f.service.snapshot(owner)).agents[0].spentRaw, "10000");
  const blank = await f.service.create(owner, { name: "Unconfigured", requestId: randomUUID() }); await f.service.waitUntilIdle();
  f.executor.capabilities = { goals: { maxPhases: 3, models: [{ id: "kimi-k2.6", pricePerCallRaw: "10000" }] } };
  await assert.rejects(f.service.command(owner, blank.id, { action: "goal", goal: "Draft a plan", requestId: randomUUID() }), /HOSTED_CONFIGURATION_REQUIRED/);
});

test("goal refuel owns the active slot until deposit settles; resumed success clears stale pause reason", async t => {
  let release!: () => void, funded = false;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(t, async input => {
    if (input.run.action === "provision") return { phase: "Ready", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: "1", wallet: input.agent.wallet } };
    if (input.run.action === "deposit") { await gate; funded = true; return { phase: "Complete", terminal: true, success: true, chargedRaw: "0" }; }
    return funded ? { phase: "Completed", terminal: true, success: true, chargedRaw: "10000" }
      : { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "INFERENCE_FUNDING_REQUIRED" };
  });
  f.executor.capabilities = { goals: { maxPhases: 3, models: [{ id: "kimi-k2.6", pricePerCallRaw: "10000" }] } };
  const owner = Wallet.createRandom().address, agent = await f.service.create(owner, { ...settings, requestId: randomUUID() }); await f.service.waitUntilIdle();
  const command = { action: "goal" as const, goal: "Write a clear plan", requestId: randomUUID() };
  await f.service.command(owner, agent.id, command); await f.service.waitUntilIdle();
  try {
    const deposit = await f.service.command(owner, agent.id, { action: "deposit", amountRaw: "40000", requestId: randomUUID() }); assert.equal(deposit.fundingFor, command.requestId);
    await assert.rejects(f.service.cancelGoal(owner, agent.id, command.requestId), /HOSTED_RECOVER_ORIGINAL_REQUIRED/);
    const pending = await f.service.snapshot(owner); assert.equal(pending.agents[0].activeRequestId, deposit.requestId);
    assert.equal(pending.runs.find(r => r.requestId === command.requestId)?.stopRequested, undefined);
  } finally { release(); }
  await f.service.waitUntilIdle(); assert.equal((await f.service.snapshot(owner)).agents[0].activeRequestId, command.requestId);
  await f.service.command(owner, agent.id, command); await f.service.waitUntilIdle();
  const result = await f.service.snapshot(owner), run = result.runs.find(r => r.requestId === command.requestId)!;
  assert.equal(run.status, "Succeeded"); assert.equal(run.reason, undefined); assert.equal(result.agents[0].spentRaw, "10000"); assert.equal(result.agents[0].reservedRaw, "0");
});
