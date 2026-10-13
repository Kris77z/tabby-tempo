import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import { validateTestSponsorship, type TestSponsorshipGrant } from "../src/test-sponsorship.js";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { atomicJson } from "../../arena/src/protocol.js";
import type { HostedConfig, HostedExecutor, HostedExecution, AgentSettings } from "../src/types.js";
const settings: AgentSettings = { name: "Bound test actor", modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "300000", allowCredit: false };
async function fixture(t: any) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tempo-sponsorship-"))), owner = Wallet.createRandom().address;
  let nextRegistry = 1, service: HostedService, unknown = false; const seen: HostedExecution[] = [];
  const executor: HostedExecutor = { async execute(input) {
    seen.push(input);
    if (input.run.action === "provision") return { phase: "Ready", success: true, terminal: true, chargedRaw: "0", binding: { chainId: "42431", agentId: String(nextRegistry++), wallet: input.agent.wallet } };
    if (unknown) return { phase: "Stopped", success: false, terminal: false, chargedRaw: "0", reason: "HOLDEM_UNKNOWN" };
    return { phase: "Succeeded", success: true, terminal: true, chargedRaw: "0" };
  } };
  const config: HostedConfig = { directory: join(directory, "hosted"), origin: "http://127.0.0.1:3028", chainId: "42431", models: [{ id: "kimi-k2.6", label: "K2.6" }], maxAgentsPerOwner: 6, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "200000" };
  service = await HostedService.open(config, executor);
  const actors = [];
  for (let i = 0; i < 2; i++) { const actor = await service.create(owner, { ...settings, requestId: randomUUID() }); await service.waitUntilIdle(); actors.push((await service.snapshot(owner)).agents.find(row => row.id === actor.id)!); }
  for (let i = 0; i < 3; i++) { await service.command(owner, actors[0].id, { action: "game", rewardKind: "usdc", requestId: randomUUID() }); await service.waitUntilIdle(); }
  const grant: TestSponsorshipGrant = { version: 1, id: randomUUID(), chainId: "42431", origin: config.origin, asset: "0x20c0000000000000000000000000000000000000", owner,
    issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 600000, baselineGames: 3, maxAdditionalGames: 6, maxGameCalls: 120, maxGameCompletionTokens: 61440, maxCashRewardsRaw: "600000",
    actors: actors.map((actor, index) => ({ hostedAgentId: actor.id, registryId: actor.binding!.agentId, wallet: actor.wallet, rewardKind: index === 0 ? "usdc" : "llm-credits" })) };
  const file = join(directory, "authorization/grant.json"); await atomicJson(file, grant); config.testSponsorshipFile = file;
  await service.close(); service = await HostedService.open(config, executor);
  t.after(async () => { await service.close(); await rm(directory, { recursive: true, force: true }); });
  return { config, grant, owner, actors, seen, directory, get service() { return service; }, setUnknown(value: boolean) { unknown = value; }, async restart() { await service.close(); service = await HostedService.open(config, executor, { recover: true }); } };
}
test("test sponsorship rejects wrong domain, token, increased caps and overlong expiry", () => {
  const actor = (kind: string) => ({ hostedAgentId: randomUUID(), registryId: kind === "usdc" ? "73" : "74", wallet: Wallet.createRandom().address, rewardKind: kind });
  const grant = { version: 1, id: randomUUID(), chainId: "42431", origin: "http://127.0.0.1:3028", asset: "0x20c0000000000000000000000000000000000000", owner: Wallet.createRandom().address,
    issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 1000, baselineGames: 3, maxAdditionalGames: 6, maxGameCalls: 120, maxGameCompletionTokens: 61440, maxCashRewardsRaw: "600000", actors: [actor("usdc"), actor("llm-credits")] };
  assert.deepEqual(validateTestSponsorship(grant, { chainId: "42431", origin: grant.origin }), grant);
  for (const changed of [{ maxAdditionalGames: 7 }, { maxGameCalls: 121 }, { maxGameCompletionTokens: 61441 }, { maxCashRewardsRaw: "600001" }, { expiresAtMs: grant.issuedAtMs + 86400001 }, { asset: Wallet.createRandom().address }])
    assert.throws(() => validateTestSponsorship({ ...grant, ...changed }, { chainId: "42431", origin: grant.origin }), /HOSTED_TEST_SPONSOR_INVALID/);
  assert.throws(() => validateTestSponsorship(grant, { chainId: "10143", origin: grant.origin }), /HOSTED_TEST_SPONSOR_INVALID/);
  assert.throws(() => validateTestSponsorship({ ...grant, origin: "https://public.example" }, { chainId: "42431", origin: "https://public.example" }), /HOSTED_TEST_SPONSOR_INVALID/);
});
test("same owner keeps original three games, concurrent final admission cannot exceed nine, replay/reload cannot renew grant", async t => {
  const f = await fixture(t);
  assert.equal((await f.service.snapshot(f.owner)).sponsorship.remaining, 6);
  const other = Wallet.createRandom().address; const otherView = await f.service.snapshot(other);
  assert.deepEqual(otherView.sponsorship, { used: 0, limit: 3, remaining: 3, globalLimit: 100 });
  await assert.rejects(f.service.command(f.owner, f.actors[0].id, { action: "game", requestId: randomUUID(), rewardKind: "llm-credits" }), /HOSTED_TEST_SPONSOR_INVALID/);
  for (let i = 0; i < 5; i++) { const actor = f.actors[i % 2]; await f.service.command(f.owner, actor.id, { action: "game", requestId: randomUUID(), rewardKind: i % 2 === 0 ? "usdc" : "llm-credits" }); await f.service.waitUntilIdle(); }
  const commands = f.actors.map((actor, index) => ({ agent: actor.id, input: { action: "game" as const, requestId: randomUUID(), rewardKind: index === 0 ? "usdc" as const : "llm-credits" as const } }));
  const results = await Promise.allSettled(commands.map(row => f.service.command(f.owner, row.agent, row.input))); await f.service.waitUntilIdle();
  assert.equal(results.filter(row => row.status === "fulfilled").length, 1);
  const accepted = commands[results.findIndex(row => row.status === "fulfilled")], seen = f.seen.length;
  await f.service.command(f.owner, accepted.agent, accepted.input); assert.equal(f.seen.length, seen);
  await f.restart(); assert.equal((await f.service.snapshot(f.owner)).sponsorship.used, 9);
  const audit = JSON.parse(await readFile(join(f.directory, "authorization/admissions/session.json"), "utf8")); assert.equal(audit.admissions.length, 6);
  await assert.rejects(f.service.command(f.owner, f.actors[0].id, { action: "game", requestId: randomUUID(), rewardKind: "usdc" }), /HOSTED_SPONSOR_LIMIT/);
  await atomicJson(f.config.testSponsorshipFile!, { ...f.grant, id: randomUUID() }); await assert.rejects(f.restart(), /HOSTED_TEST_SPONSOR_BINDING_CHANGED/);
});
test("database-before-audit interruption never dispatches; restart reconstructs audit and resumes only the original UUID", async t => {
  const f = await fixture(t), requestId = randomUUID(), seen = f.seen.length;
  const original = SessionStore.prototype.write;
  SessionStore.prototype.write = async function(value) { if (this.directory.endsWith("/authorization/admissions")) throw new Error("SIMULATED_AUDIT_CRASH"); return original.call(this, value); };
  try { await assert.rejects(f.service.command(f.owner, f.actors[0].id, { action: "game", requestId, rewardKind: "usdc" }), /SIMULATED_AUDIT_CRASH/); }
  finally { SessionStore.prototype.write = original; }
  assert.equal(f.seen.length, seen); assert.equal((await f.service.snapshot(f.owner)).sponsorship.used, 4);
  await f.restart(); const audit = JSON.parse(await readFile(join(f.directory, "authorization/admissions/session.json"), "utf8")); assert.equal(audit.admissions[0].requestId, requestId);
  await f.service.command(f.owner, f.actors[0].id, { action: "game", requestId, rewardKind: "usdc" }); await f.service.waitUntilIdle();
  assert.equal(f.seen.length, seen + 1); assert.equal((await f.service.snapshot(f.owner)).sponsorship.used, 4);
});
test("Unknown retains the added slot and expired authorization permits only cached terminal replay", async t => {
  const f = await fixture(t); f.setUnknown(true);
  await f.service.command(f.owner, f.actors[0].id, { action: "game", requestId: randomUUID(), rewardKind: "usdc" }); await f.service.waitUntilIdle();
  assert.equal((await f.service.snapshot(f.owner)).sponsorship.used, 4);
  f.setUnknown(false); const requestId = randomUUID(); await f.service.command(f.owner, f.actors[1].id, { action: "game", requestId, rewardKind: "llm-credits" }); await f.service.waitUntilIdle();
  const original = Date.now, seen = f.seen.length;
  try { Date.now = () => f.grant.expiresAtMs + 1;
    assert.equal((await f.service.snapshot(f.owner)).sponsorship.remaining, 0);
    await f.service.command(f.owner, f.actors[1].id, { action: "game", requestId, rewardKind: "llm-credits" }); assert.equal(f.seen.length, seen);
    await assert.rejects(f.service.command(f.owner, f.actors[1].id, { action: "game", requestId: randomUUID(), rewardKind: "llm-credits" }), /HOSTED_SPONSOR_LIMIT/);
  } finally { Date.now = original; }
});
