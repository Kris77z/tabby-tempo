import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, mkdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { tempoFrontendOriginAllowed, tempoPublicOrigin, tempoRuntimeBinding } from "../tempo-hosted-runtime.js";
import { applyTempoVpsMigration, migratedHostedAuthentication, planTempoVpsMigration } from "../tempo-vps-migrate.js";
import { HostedService } from "../../services/hosted-agents/src/service.js";

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const origin = "https://tempo.tabbyai.xyz";
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tempo-vps-migration-")));
  const runtime = join(directory, "runtime");
  const put = async (file: string, value: unknown, pretty = false) => { await mkdir(join(file, ".."), { recursive: true, mode: 0o700 }); await writeFile(file, JSON.stringify(value, null, pretty ? 2 : undefined) + "\n", { mode: 0o600 }); };
  const gatewayFile = join(directory, "gateway.json"), gateway = { url: "http://127.0.0.1:3426/v1", endpoint: "http://127.0.0.1:3426/v1/chat/completions", keyFile: join(directory, "do-not-read.key"),
    models: [{ id: "cheap", model: "cheap/kimi-k2.6", responseModel: "kimi-k2.6" }, { id: "strong", model: "strong/kimi-k3", responseModel: "kimi-k3" }] };
  await put(gatewayFile, gateway);
  const catalog = gateway.models.map((model, index) => ({ ...model, route: gateway.endpoint, inputMicroCreditsPerToken: index ? "3" : "1", outputMicroCreditsPerToken: index ? "6" : "2", maxCompletionTokens: 1024 }));
  const bootstrapFile = join(directory, "bootstrap.json"), bootstrap: any = { chainId: "42431", frontendOrigin: "http://127.0.0.1:3028", hostedPort: 57941,
    gatewayReadyFile: gatewayFile, dashboardAgents: [{ id: "1", name: "historical" }], tasks: [{ taskId: "1" }], contracts: { account: "historical-address" } };
  await put(bootstrapFile, bootstrap);
  const binding = tempoRuntimeBinding(bootstrap, gateway, catalog);
  const grantFile = join(directory, "authorization.json"), issuedAtMs = Date.now() - 3600000;
  const grant = { version: 1, id: randomUUID(), chainId: "42431", origin: bootstrap.frontendOrigin, asset: "0x20c0000000000000000000000000000000000000", owner: "0x" + "1".repeat(40),
    issuedAtMs, expiresAtMs: issuedAtMs + 60000, baselineGames: 3, maxAdditionalGames: 6, maxGameCalls: 120, maxGameCompletionTokens: 61440, maxCashRewardsRaw: "600000",
    actors: ["usdc", "llm-credits"].map((rewardKind, i) => ({ hostedAgentId: randomUUID(), registryId: String(i + 1), wallet: "0x" + String(i + 2).repeat(40), rewardKind })) };
  await put(grantFile, grant); const grantRaw = await readFile(grantFile, "utf8"), grantDigest = createHash("sha256").update(grantRaw).digest("hex");
  const databaseFile = join(runtime, "hosted", "database", "session.json"), database = { version: 1, configBinding: hash({ origin: bootstrap.frontendOrigin, chainId: "42431" }),
    challenges: [{ message: 'old origin: ], \\" }' }], sessions: [{ digest: "old-session" }], agents: [{ wallet: "preserved-wallet" }],
    runs: [{ status: "Succeeded", requestId: randomUUID(), result: { txHash: "original-paid-tx" } }], creations: [], sponsoredOwners: { owner: 7 }, sponsoredTotal: 7,
    testSponsorship: { grant, digest: grantDigest, admissions: [{ requestId: randomUUID(), ordinal: 1 }] } };
  await put(databaseFile, database, true);
  await put(join(runtime, "hosted.json"), { hosted: { chainId: "42431", origin: bootstrap.frontendOrigin, directory: join(runtime, "hosted"), testSponsorshipFile: grantFile } });
  const runtimeFile = join(runtime, "runtime-journal", "session.json"), journal: any = { version: 1, binding, originalBootstrap: bootstrap, originalCatalog: bootstrap.tasks, ports: {},
    testSponsorship: { file: grantFile, digest: grantDigest, grantId: grant.id } };
  await put(runtimeFile, journal);
  const financialFile = join(runtime, "fixed", "paid.json"), financialRaw = '{ "rawTransaction":"0xoriginal", "dispatch":"Unknown" }\n';
  await mkdir(join(financialFile, ".."), { recursive: true }); await writeFile(financialFile, financialRaw, { mode: 0o600 });
  return { directory, runtime, put, bootstrapFile, bootstrap, databaseFile, database, runtimeFile, journal, grantFile, grantRaw, financialFile, financialRaw,
    close: () => rm(directory, { recursive: true, force: true }) };
}

test("production origin must be an explicitly pinned HTTPS origin; development loopback remains valid", () => {
  assert.equal(tempoPublicOrigin(origin), origin); assert.equal(tempoFrontendOriginAllowed(origin, origin), true);
  assert.equal(tempoFrontendOriginAllowed(origin, undefined), false); assert.equal(tempoFrontendOriginAllowed("https://different.example", origin), false);
  assert.equal(tempoFrontendOriginAllowed("http://127.0.0.1:3028"), true);
  for (const value of ["http://tempo.tabbyai.xyz", origin + "/", origin + "/path", origin + "?x=1", "https://user@tempo.tabbyai.xyz", "https://127.0.0.1", "https://localhost"]) assert.throws(() => tempoPublicOrigin(value), /TEMPO_PUBLIC_ORIGIN_INVALID/);
});

test("offline origin migration preserves original histories, run bytes, grant and financial journals, and invalidates old auth", async t => {
  const f = await fixture(); t.after(f.close);
  const beforeRaw = await readFile(f.databaseFile, "utf8"), historical = beforeRaw.slice(beforeRaw.indexOf('  "agents"'));
  const plan = await planTempoVpsMigration(f.runtime, f.bootstrapFile, origin);
  assert.equal(await readFile(f.databaseFile, "utf8"), beforeRaw); assert.equal(plan.status, "Prepared");
  const result = await applyTempoVpsMigration(f.runtime, f.bootstrapFile, origin); assert.equal(result.cached, false);
  const afterRaw = await readFile(f.databaseFile, "utf8"), after = JSON.parse(afterRaw);
  assert.equal(afterRaw.slice(afterRaw.indexOf('  "agents"')), historical);
  assert.deepEqual(after.runs, f.database.runs); assert.deepEqual(after.testSponsorship, f.database.testSponsorship);
  assert.deepEqual(after.sessions, []); assert.deepEqual(after.challenges, []); assert.equal(after.configBinding, hash({ origin, chainId: "42431" }));
  const runtime = JSON.parse(await readFile(f.runtimeFile, "utf8"));
  assert.equal(runtime.binding, f.journal.binding); assert.deepEqual(runtime.originalBootstrap, f.bootstrap); assert.equal(runtime.testSponsorship, undefined);
  assert.equal(runtime.publicOriginMigration.toOrigin, origin); assert.notEqual(runtime.effectiveBinding, f.journal.binding);
  assert.equal(JSON.parse(await readFile(join(f.runtime, "hosted.json"), "utf8")).hosted.testSponsorshipFile, undefined);
  assert.equal(await readFile(f.grantFile, "utf8"), f.grantRaw); assert.equal(await readFile(f.financialFile, "utf8"), f.financialRaw);
  assert.equal((await applyTempoVpsMigration(f.runtime, f.bootstrapFile, origin)).cached, true);
  await assert.rejects(applyTempoVpsMigration(f.runtime, f.bootstrapFile, "https://different.example"), /ORIGINAL_ORIGIN_MIGRATION_REQUIRED/);
});

test("prepared migration resumes exact original intent after partial config writes and rejects tampered business state", async t => {
  const f = await fixture(); t.after(f.close);
  const plan = await planTempoVpsMigration(f.runtime, f.bootstrapFile, origin);
  await f.put(join(f.runtime, "vps-origin-migration", "session.json"), plan);
  await writeFile(plan.changes[0].path, plan.changes[0].after, { mode: 0o600 });
  await applyTempoVpsMigration(f.runtime, f.bootstrapFile, origin);
  await f.put(f.databaseFile, { ...f.database, runs: [{ status: "Succeeded", result: "changed" }] });
  await assert.rejects(applyTempoVpsMigration(f.runtime, f.bootstrapFile, origin), /SOURCE_CHANGED/);
});

test("migrated service opens with expired historical sponsorship, rejects old sessions and issues only the pinned public login domain", async t => {
  const f = await fixture(); t.after(f.close);
  await applyTempoVpsMigration(f.runtime, f.bootstrapFile, origin);
  const service = await HostedService.open({ directory: join(f.runtime, "hosted"), origin, chainId: "42431", models: [{ id: "kimi-k2.6", label: "Kimi" }],
    maxAgentsPerOwner: 6, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" }, { execute: async () => { throw new Error("NO_EXECUTION_EXPECTED"); } });
  try {
    await assert.rejects(service.authenticate("f".repeat(64)), /HOSTED_AUTH_REQUIRED/);
    assert.ok((await service.challenge("0x" + "1".repeat(40))).message.includes(`Origin: ${origin}\n`));
    assert.deepEqual(JSON.parse(await readFile(f.databaseFile, "utf8")).testSponsorship, f.database.testSponsorship);
  } finally { await service.close(); }
});

test("migration refuses active executions, active listeners and unexpired local sponsorship", async t => {
  const f = await fixture(); t.after(f.close);
  await f.put(f.databaseFile, { ...f.database, runs: [{ status: "Running" }] });
  await assert.rejects(planTempoVpsMigration(f.runtime, f.bootstrapFile, origin), /STATE_INVALID/);
  await f.put(f.databaseFile, f.database);
  const server = createServer(); server.listen(f.bootstrap.hostedPort, "127.0.0.1"); await once(server, "listening");
  try { await assert.rejects(applyTempoVpsMigration(f.runtime, f.bootstrapFile, origin), /STOP_REQUIRED/); }
  finally { await new Promise<void>(done => server.close(() => done())); }
  const grant = { ...f.database.testSponsorship.grant, expiresAtMs: Date.now() + 60000 };
  await f.put(f.grantFile, grant);
  await assert.rejects(planTempoVpsMigration(f.runtime, f.bootstrapFile, origin), /EXPIRED_ORIGIN_SPONSORSHIP_REQUIRED/);
});

test("auth-value patch preserves unrelated JSON bytes containing nested escaped strings", () => {
  const raw = '{ "runs": [{ "code": "\\\" }],x" }], "sessions": [1], "configBinding": "old", "challenges": [2], "other": true }\n';
  const next = migratedHostedAuthentication(raw, "new");
  assert.deepEqual(JSON.parse(next), { ...JSON.parse(raw), configBinding: "new", sessions: [], challenges: [] });
  assert.equal(next.slice(0, next.indexOf('"sessions"')), raw.slice(0, raw.indexOf('"sessions"')));
});
