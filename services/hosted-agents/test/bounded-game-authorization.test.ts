import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { atomicJson } from "../../arena/src/protocol.js";
import { HostedService, validateHostedConfig } from "../src/service.js";
import { assertBoundedGameAdmissions, validateBoundedGameAuthorization, type BoundedGameAuthorization } from "../src/bounded-game-authorization.js";
import type { TestSponsorshipState } from "../src/test-sponsorship.js";
import type { AgentSettings, HostedAgent, HostedConfig, HostedExecution, HostedExecutor, HostedResult } from "../src/types.js";

const settings: AgentSettings = { name: "Existing bounded actor", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "300000", allowCredit: false };
const completed: HostedResult = { phase: "Completed", terminal: true, success: true, chargedRaw: "0", autonomousGames: 1, autonomousTasks: 0 };
const paused: HostedResult = { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_GAME_UPSTREAM_UNKNOWN" };

async function fixture(t: any, install = true, baselineTotalGames = 7) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tempo-bounded-games-"))), owner = Wallet.createRandom().address;
  const config: HostedConfig = { directory: join(directory, "hosted"), origin: "http://127.0.0.1:3028", chainId: "42431", models: [{ id: "kimi-k2.6", label: "K2.6" }], maxAgentsPerOwner: 6, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" };
  let service: HostedService, registry = 1, automatic: (input: HostedExecution) => Promise<HostedResult> = async () => completed;
  const executor: HostedExecutor = { capabilities: { autonomy: { maxTasks: 1, durationMs: 600000, plannerPriceRaw: "10000", games: { maxGames: 2, rewardKinds: ["llm-credits"] } } },
    async execute(input) {
      if (input.run.action === "provision") return { phase: "Ready", success: true, terminal: true, chargedRaw: "0", binding: { chainId: "42431", agentId: String(registry++), wallet: input.agent.wallet } };
      return input.run.action === "autonomous" ? automatic(input) : completed;
    } };
  service = await HostedService.open(config, executor);
  const actors: HostedAgent[] = [];
  for (let i = 0; i < 2; i++) {
    const created = await service.create(owner, { ...settings, requestId: randomUUID() }); await service.waitUntilIdle();
    actors.push((await service.snapshot(owner)).agents.find(agent => agent.id === created.id)!);
  }
  await service.close();
  const database = join(config.directory, "database/session.json"), state = JSON.parse(await readFile(database, "utf8"));
  // This is fixture setup only: preserve a fully expired historical grant and
  // seven consumed games so new admission cannot use the default three slots.
  const oldGrant: TestSponsorshipState["grant"] = { version: 1, id: randomUUID(), chainId: "42431", origin: config.origin, asset: "0x20c0000000000000000000000000000000000000", owner,
    issuedAtMs: Date.now() - 7200000, expiresAtMs: Date.now() - 3600000, baselineGames: 3, maxAdditionalGames: 6, maxGameCalls: 120, maxGameCompletionTokens: 61440, maxCashRewardsRaw: "600000",
    actors: actors.map((actor, index) => ({ hostedAgentId: actor.id, registryId: actor.binding!.agentId, wallet: actor.wallet, rewardKind: index ? "llm-credits" : "usdc" })) };
  const oldFile = join(directory, "old-authorization/grant.json"); await atomicJson(oldFile, oldGrant);
  const oldState: TestSponsorshipState = { grant: oldGrant, digest: createHash("sha256").update(await readFile(oldFile)).digest("hex"),
    admissions: Array.from({ length: 4 }, (_, index) => ({ requestId: randomUUID(), agentId: actors[index % 2].id, ordinal: index + 1, admittedAt: new Date(oldGrant.issuedAtMs + index + 1).toISOString(), rewardKind: index % 2 ? "llm-credits" : "usdc" })) };
  state.sponsoredOwners[owner] = 7; state.sponsoredTotal = baselineTotalGames; state.testSponsorship = oldState;
  await atomicJson(database, state); await atomicJson(join(directory, "old-authorization/admissions/session.json"), oldState);
  config.testSponsorshipFile = oldFile;
  const grant: BoundedGameAuthorization = { version: 1, id: randomUUID(), parentRequestId: randomUUID(), chainId: "42431", origin: config.origin, asset: oldGrant.asset, owner,
    issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 600000, baselineOwnerGames: 7, baselineTotalGames, maxAdditionalGames: 2, maxGameCalls: 40, maxGameCompletionTokens: 20480, maxCashRewardsRaw: "0",
    actor: { hostedAgentId: actors[0].id, registryId: actors[0].binding!.agentId, wallet: actors[0].wallet } };
  const file = join(directory, "new-authorization/bounded-games.json"), mirror = join(directory, "new-authorization/bounded-admissions/session.json");
  await atomicJson(file, grant); config.boundedGamesFile = file;
  if (install) service = await HostedService.open(config, executor, { recover: true });
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { config, owner, actors, grant, file, mirror, database, directory, oldState, oldFile, get service() { return service; },
    plan(fn: typeof automatic) { automatic = fn; },
    async state() { return JSON.parse(await readFile(database, "utf8")); },
    async restart() { await service.close(); service = await HostedService.open(config, executor, { recover: true }); },
    async run(requestId = grant.parentRequestId) { await service.command(owner, actors[0].id, { action: "autonomous", requestId }); await service.waitUntilIdle(); return (await service.snapshot(owner)).runs.find(run => run.requestId === requestId)!; },
    child(input: HostedExecution, childRequestId: string): HostedExecution { return { ...input, run: { ...input.run, requestId: childRequestId, action: "game", rewardKind: "llm-credits" } }; } };
}

test("bounded authorization has a closed Tempo domain, one parent and exact two-game model/cash ceilings", () => {
  const config = { chainId: "42431" as const, origin: "https://tempo.tabbyai.xyz" };
  const grant: BoundedGameAuthorization = { version: 1, id: randomUUID(), parentRequestId: randomUUID(), chainId: "42431", origin: config.origin, asset: "0x20c0000000000000000000000000000000000000", owner: Wallet.createRandom().address,
    issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 60000, baselineOwnerGames: 7, baselineTotalGames: 7, maxAdditionalGames: 2, maxGameCalls: 40, maxGameCompletionTokens: 20480, maxCashRewardsRaw: "0",
    actor: { hostedAgentId: randomUUID(), registryId: "73", wallet: Wallet.createRandom().address } };
  assert.deepEqual(validateBoundedGameAuthorization(grant, config), grant);
  for (const change of [{ maxAdditionalGames: 3 }, { maxAdditionalGames: 0 }, { maxGameCalls: 41 }, { maxGameCompletionTokens: 20481 }, { maxCashRewardsRaw: "1" },
    { expiresAtMs: grant.issuedAtMs + 86400001 }, { issuedAtMs: Date.now() + 60000 }, { parentRequestId: "old-parent" }, { baselineOwnerGames: -1 }, { baselineTotalGames: 6 },
    { baselineTotalGames: 101 }, { asset: Wallet.createRandom().address }, { extra: true }, { actor: { ...grant.actor, rewardKind: "usdc" } }]) {
    assert.throws(() => validateBoundedGameAuthorization({ ...grant, ...change }, config), /HOSTED_BOUNDED_GAMES_INVALID/);
  }
  for (const origin of ["https://attacker.example", "http://public.example", "https://tempo.tabbyai.xyz/path"]) assert.throws(() => validateBoundedGameAuthorization({ ...grant, origin }, { ...config, origin }), /HOSTED_BOUNDED_GAMES_INVALID/);
  assert.throws(() => validateBoundedGameAuthorization(grant, { ...config, chainId: "31337" }), /HOSTED_BOUNDED_GAMES_INVALID/);
  assert.deepEqual(validateBoundedGameAuthorization({ ...grant, maxAdditionalGames: 1, maxGameCalls: 20, maxGameCompletionTokens: 10240 }, config).maxAdditionalGames, 1);
  const base = { directory: "/private/fixture", ...config, models: [{ id: "kimi-k2.6", label: "Kimi" }], maxAgentsPerOwner: 2, maxTotalBudgetRaw: "300000", maxPerRunBudgetRaw: "120000", boundedGamesFile: "/private/grant.json" };
  assert.equal(validateHostedConfig(base).boundedGamesFile, base.boundedGamesFile);
  assert.throws(() => validateHostedConfig({ ...base, boundedGamesFile: "relative.json" }), /HOSTED_BOUNDED_GAMES_INVALID/);
  assert.throws(() => validateHostedConfig({ ...base, boundedGamesFile: undefined, boundedGamesSealed: true }), /HOSTED_BOUNDED_GAMES_INVALID/);
});

test("first installation requires unchanged counters, an existing exact actor and an unused parent", async t => {
  const f = await fixture(t, false);
  for (const change of [{ baselineOwnerGames: 6 }, { baselineTotalGames: 8 }, { expiresAtMs: Date.now() - 1 }, { id: f.oldState.grant.id },
    { parentRequestId: (await f.state()).creations[0].requestId }, { actor: { ...f.grant.actor, hostedAgentId: randomUUID() } },
    { actor: { ...f.grant.actor, registryId: "999" } }, { actor: { ...f.grant.actor, wallet: Wallet.createRandom().address } }]) {
    await atomicJson(f.file, { ...f.grant, ...change }); await assert.rejects(f.restart(), /HOSTED_BOUNDED_GAMES_(BASELINE_CHANGED|INVALID|BINDING_CHANGED)/);
    assert.equal((await f.state()).boundedGames, undefined);
  }
  await atomicJson(f.file, f.grant);
  const original = await f.state();
  for (const change of [{ modelId: "other" }, { strategy: "aggressive" }, { allowCredit: true }, { owner: Wallet.createRandom().address }]) {
    const state = structuredClone(original); Object.assign(state.agents[0], change); await atomicJson(f.database, state);
    await assert.rejects(f.restart(), /HOSTED_BOUNDED_GAMES_INVALID/);
  }
  await atomicJson(f.database, original); await f.restart(); assert.equal((await f.state()).boundedGames.admissions.length, 0);
});

test("only the bound parent gets two durable children; repeated recovery never adds slots or revives the old grant", async t => {
  const f = await fixture(t), children = [randomUUID(), randomUUID(), randomUUID()]; let dispatches = 0;
  const oldMirror = await readFile(join(f.directory, "old-authorization/admissions/session.json"), "utf8"), oldFile = await readFile(f.oldFile, "utf8");
  f.plan(async input => {
    await f.service.admitAutonomyGame(input.run.requestId, children[0], input.agent.id, "llm-credits");
    await f.service.admitAutonomyGame(input.run.requestId, children[0], input.agent.id, "llm-credits");
    if (!input.recover) { dispatches++; return paused; }
    const concurrent = await Promise.allSettled(children.slice(1).map(child => f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits")));
    assert.equal(concurrent.filter(result => result.status === "fulfilled").length, 1);
    assert.match((concurrent.find(result => result.status === "rejected") as PromiseRejectedResult).reason.message, /HOSTED_SPONSOR_LIMIT/); dispatches++;
    return completed;
  });
  assert.equal((await f.run()).status, "Paused"); await f.restart(); assert.equal((await f.run()).status, "Succeeded");
  assert.equal(dispatches, 2); const state = await f.state();
  assert.equal(state.sponsoredOwners[f.owner], 9); assert.equal(state.sponsoredTotal, 9); assert.equal(state.boundedGames.admissions.length, 2);
  assert.deepEqual(JSON.parse(await readFile(f.mirror, "utf8")), state.boundedGames); assert.deepEqual(state.testSponsorship, f.oldState);
  assert.equal(await readFile(f.oldFile, "utf8"), oldFile); assert.equal(await readFile(join(f.directory, "old-authorization/admissions/session.json"), "utf8"), oldMirror);
  await f.run(); assert.equal(dispatches, 2);
  await assert.rejects(f.service.command(f.owner, f.actors[0].id, { action: "game", requestId: randomUUID(), rewardKind: "usdc" }), /HOSTED_SPONSOR_LIMIT/);
  f.plan(async input => { await f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id, "llm-credits"); dispatches++; return completed; });
  const rejected = await f.run(randomUUID()); assert.equal(rejected.reason, "HOSTED_AUTONOMY_GAME_ADMISSION_INVALID"); assert.equal(dispatches, 2);
  assert.equal((await f.state()).boundedGames.admissions.length, 2);
});

test("wrong actor, reward and child binding fail before dispatch; grant deadline never extends an ordinary game", async t => {
  const f = await fixture(t), child = randomUUID(); let checked = false;
  f.plan(async input => {
    await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, randomUUID(), f.actors[1].id, "llm-credits"), /HOSTED_AUTONOMY_GAME_ADMISSION_INVALID/);
    await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id, "usdc"), /HOSTED_AUTONOMY_GAME_ADMISSION_INVALID/);
    await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id), /HOSTED_AUTONOMY_GAME_ADMISSION_INVALID/);
    await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits");
    await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "usdc"), /HOSTED_AUTONOMY_GAME_ADMISSION_INVALID/);
    const game = f.child(input, child); assert.equal(f.service.gameDeadline(game), f.grant.expiresAtMs);
    assert.equal(f.service.gameDeadline({ ...game, deadlineMs: f.grant.expiresAtMs - 1 }), f.grant.expiresAtMs - 1);
    assert.equal(f.service.gameDeadline(f.child(input, randomUUID())), undefined);
    assert.throws(() => f.service.gameDeadline({ ...game, agent: f.actors[1] }), /HOSTED_BOUNDED_GAMES_INVALID/);
    assert.throws(() => f.service.gameDeadline({ ...game, run: { ...game.run, rewardKind: "usdc" } }), /HOSTED_BOUNDED_GAMES_BINDING_CHANGED/);
    checked = true; return completed;
  });
  assert.equal((await f.run()).status, "Succeeded"); assert.equal(checked, true); assert.equal((await f.state()).boundedGames.admissions.length, 1);
});

test("expiry rejects every new child while an admitted child retains its original deadline and slot", async t => {
  const f = await fixture(t), child = randomUUID(); let dispatches = 0;
  f.plan(async input => { await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits"); dispatches++; return paused; });
  assert.equal((await f.run()).status, "Paused"); const realNow = Date.now;
  try {
    Date.now = () => f.grant.expiresAtMs + 1; await f.restart();
    f.plan(async input => {
      await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits");
      assert.ok(f.service.gameDeadline(f.child(input, child))! < Date.now());
      await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id, "llm-credits"), /HOSTED_SPONSOR_LIMIT/);
      return completed; // Cached terminal recovery, with no further model dispatch.
    });
    assert.equal((await f.run()).status, "Succeeded"); assert.equal(dispatches, 1); assert.equal((await f.state()).sponsoredOwners[f.owner], 8);
  } finally { Date.now = realNow; }
});

test("database-before-mirror crash blocks dispatch and restart repairs only the committed original child", async t => {
  const f = await fixture(t), child = randomUUID(); let dispatches = 0;
  f.plan(async input => { await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits"); dispatches++; return completed; });
  const original = SessionStore.prototype.write;
  SessionStore.prototype.write = async function(value) { if (this.directory.endsWith("/new-authorization/bounded-admissions")) throw new Error("SIMULATED_BOUNDED_AUDIT_CRASH"); return original.call(this, value); };
  try { await f.run(); } finally { SessionStore.prototype.write = original; }
  assert.equal(dispatches, 0); assert.equal((await f.state()).sponsoredOwners[f.owner], 8); assert.equal((await f.state()).boundedGames.admissions[0].childRequestId, child);
  assert.equal(JSON.parse(await readFile(f.mirror, "utf8")).admissions.length, 0);
  await f.restart(); assert.equal(JSON.parse(await readFile(f.mirror, "utf8")).admissions[0].childRequestId, child);
  // The synthetic executor threw, so explicitly retain a resource pause to
  // exercise the same admitted child recovery without creating a new parent.
  await f.service.close(); const state = await f.state(), parent = state.runs.find((run: any) => run.requestId === f.grant.parentRequestId);
  parent.status = "Paused"; parent.recoverable = true; state.agents[0].activeRequestId = parent.requestId; await atomicJson(f.database, state);
  await f.restart(); assert.equal((await f.run()).status, "Succeeded"); assert.equal(dispatches, 1); assert.equal((await f.state()).sponsoredOwners[f.owner], 8);
});

test("a conflicting mirror, swapped authorization or regressed counter cannot restart", async t => {
  const f = await fixture(t); await f.service.close(); const initial = await readFile(f.mirror, "utf8");
  const audit = JSON.parse(initial); audit.digest = "0".repeat(64); await atomicJson(f.mirror, audit);
  await assert.rejects(f.restart(), /HOSTED_BOUNDED_GAMES_AUDIT_CONFLICT/); await atomicJson(f.mirror, JSON.parse(initial));
  await atomicJson(f.file, { ...f.grant, id: randomUUID() }); await assert.rejects(f.restart(), /HOSTED_BOUNDED_GAMES_BINDING_CHANGED/); await atomicJson(f.file, f.grant);
  const original = await f.state(); const changed = structuredClone(original); changed.sponsoredOwners[f.owner] = 6; await atomicJson(f.database, changed);
  await assert.rejects(f.restart(), /HOSTED_BOUNDED_GAMES_BASELINE_CHANGED/); await atomicJson(f.database, original); await f.restart();
});

test("global ceiling remains 100 and does not reset or spend a second authorized slot", async t => {
  const f = await fixture(t, true, 99); let checked = false;
  f.plan(async input => {
    await f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id, "llm-credits");
    await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id, "llm-credits"), /HOSTED_SPONSOR_LIMIT/);
    checked = true; return completed;
  });
  assert.equal((await f.run()).status, "Succeeded"); assert.equal(checked, true); assert.equal((await f.state()).sponsoredTotal, 100); assert.equal((await f.state()).boundedGames.admissions.length, 1);
});

test("sealed service rejects every new child while preserving original admitted recovery and terminal replay", async t => {
  const f = await fixture(t), child = randomUUID(); let dispatches = 0;
  f.plan(async input => { await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits"); dispatches++; return paused; });
  assert.equal((await f.run()).status, "Paused"); const admissions = (await f.state()).boundedGames;
  f.config.boundedGamesSealed = true; await f.restart();
  f.plan(async input => {
    await f.service.admitAutonomyGame(input.run.requestId, child, input.agent.id, "llm-credits");
    await assert.rejects(f.service.admitAutonomyGame(input.run.requestId, randomUUID(), input.agent.id, "llm-credits"), /HOSTED_SPONSOR_LIMIT/);
    return completed;
  });
  assert.equal((await f.run()).status, "Succeeded"); await f.run(); assert.equal(dispatches, 1); assert.deepEqual((await f.state()).boundedGames, admissions);
});

test("sealed unused parent is rejected before any run, reservation or admission is persisted", async t => {
  const f = await fixture(t); let executions = 0;
  f.config.boundedGamesSealed = true; await f.restart();
  f.plan(async () => { executions++; return completed; });
  const database = await readFile(f.database, "utf8"), mirror = await readFile(f.mirror, "utf8");
  await assert.rejects(f.service.create(f.owner, { ...settings, requestId: f.grant.parentRequestId }), /HOSTED_BOUNDED_PARENT_SEALED/);
  assert.equal(await readFile(f.database, "utf8"), database);
  for (const action of ["autonomous", "task", "game"] as const) {
    await assert.rejects(f.service.command(f.owner, f.actors[0].id, { action, requestId: f.grant.parentRequestId,
      ...(action === "game" ? { rewardKind: "llm-credits" as const } : {}) }), /HOSTED_BOUNDED_PARENT_SEALED/);
    assert.equal(await readFile(f.database, "utf8"), database); assert.equal(await readFile(f.mirror, "utf8"), mirror);
  }
  await f.restart();
  await assert.rejects(f.run(), /HOSTED_BOUNDED_PARENT_SEALED/); assert.equal(executions, 0);
  assert.equal((await f.state()).runs.some((run: any) => run.requestId === f.grant.parentRequestId), false);
});

test("bounded admission history rejects a second parent, duplicate child, changed ordinal or out-of-window timestamp", async t => {
  const f = await fixture(t), child = randomUUID();
  const row = { parentRequestId: f.grant.parentRequestId, childRequestId: child, agentId: f.actors[0].id, ordinal: 1, admittedAt: new Date().toISOString(), rewardKind: "llm-credits" as const };
  const state = { grant: f.grant, digest: "a".repeat(64), admissions: [row] }; assertBoundedGameAdmissions(state);
  for (const changed of [{ ...row, parentRequestId: randomUUID() }, { ...row, ordinal: 2 }, { ...row, admittedAt: new Date(f.grant.expiresAtMs).toISOString() }, { ...row, rewardKind: "usdc" }])
    assert.throws(() => assertBoundedGameAdmissions({ ...state, admissions: [changed as typeof row] }), /HOSTED_BOUNDED_GAMES_INVALID/);
  assert.throws(() => assertBoundedGameAdmissions({ ...state, admissions: [row, { ...row, ordinal: 2 }] }), /HOSTED_BOUNDED_GAMES_INVALID/);
});

test("new feature limits never replay an old terminal parent or rewrite its persisted two-task snapshot", async t => {
  const f = await fixture(t, false), oldParentId = randomUUID(), state = await f.state(), timestamp = new Date().toISOString();
  state.runs.push({ requestId: oldParentId, action: "autonomous", agentId: f.actors[0].id, status: "Succeeded", recoverable: false, createdAt: timestamp, updatedAt: timestamp,
    reservedRaw: "300000", chargedRaw: "130000", result: { ...completed, autonomousTasks: 2, autonomousGames: undefined } });
  await atomicJson(f.database, state);
  const snapshot = join(f.config.directory, "agents", f.actors[0].id, "runs", oldParentId, "autonomy-host/session.json");
  await atomicJson(snapshot, { config: { maxTasks: 2, maxDecisions: 3 }, originalPayments: ["historical-paid-handle"] }); const original = await readFile(snapshot, "utf8");
  f.plan(async () => { throw new Error("OLD_TERMINAL_MUST_NOT_EXECUTE"); }); await f.restart();
  const replay = await f.run(oldParentId); assert.equal(replay.status, "Succeeded"); assert.equal(replay.result!.autonomousTasks, 2);
  assert.equal(await readFile(snapshot, "utf8"), original); assert.equal((await f.state()).sponsoredOwners[f.owner], 7); assert.equal((await f.state()).boundedGames.admissions.length, 0);
});
