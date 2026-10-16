import test from "node:test";
import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, realpath, readFile, rm, mkdir, chmod, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { Wallet } from "ethers";
import { SessionStore } from "../../packages/pi-loop/src/session.js";
import { atomicJson } from "../../services/arena/src/protocol.js";
import { TEMPO_IDENTITY, TEMPO_REPUTATION, TEMPO_PATH_USD } from "../tempo-config.js";
import { enableTempoHostedFeatures, sealTempoHostedFeatures, loadTempoHostedBootstrap, tempoRuntimeBinding, type TempoHostedBootstrap } from "../tempo-hosted-runtime.js";
import { TEMPO_EXTERNAL_PORTS, tempoFeaturePaths, tempoFeatureTaskDomain, tempoFeatureAutonomy, tempoFeatureBudgetFile, validateTempoHostedFeatures, verifyTempoHostedFeatures, type TempoHostedFeatures } from "../tempo-hosted-features.js";

async function fixture(t: any) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "tempo-features-"))), directory = join(root, "runtime");
  const paths = tempoFeaturePaths(directory), actorWallet = Wallet.createRandom().address, owner = Wallet.createRandom().address;
  const put = async (file: string, value: unknown) => { await atomicJson(file, value); return file; };
  const rpcUrlFile = await put(join(root, "rpc.txt"), "https://rpc.example.invalid"), vendorKeyFile = await put(join(root, "vendor.key"), "synthetic-vendor"), keyFile = await put(join(root, "gateway.key"), "synthetic-gateway");
  // Raw URL/key files are strings, not JSON documents.
  const { writeFile } = await import("node:fs/promises");
  await writeFile(rpcUrlFile, "https://rpc.example.invalid", { mode: 0o600 }); await writeFile(vendorKeyFile, "synthetic-vendor", { mode: 0o600 }); await writeFile(keyFile, "synthetic-gateway", { mode: 0o600 });
  const gateway = { url: "http://127.0.0.1:3426/v1", endpoint: "http://127.0.0.1:3426/v1/chat/completions", keyFile,
    models: [{ id: "cheap", model: "cheap/kimi-k2.6", responseModel: "kimi-k2.6" }, { id: "strong", model: "strong/kimi-k3", responseModel: "kimi-k3" }] };
  const gatewayReadyFile = await put(join(root, "gateway-ready.json"), gateway), address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
  const oldTasks: TempoHostedBootstrap["tasks"] = [1, 2, 3, 4].map(id => ({ taskId: String(id), problemId: "sum-integers", deadlineMs: Date.now() - 86400000, creditLimit: "80000" }));
  const newTask: TempoHostedBootstrap["tasks"][number] = { taskId: "5", problemId: "sum-integers", deadlineMs: Date.now() + 3600000, creditLimit: "80000" };
  const bootstrap: TempoHostedBootstrap = { version: 1, chainId: "42431", contracts: { account: address(1), adapter: address(2), escrow: address(3), manager: address(4) }, deploymentBlock: 5,
    asset: { address: TEMPO_PATH_USD, symbol: "PathUSD", decimals: 6 }, identity: TEMPO_IDENTITY, reputation: TEMPO_REPUTATION, payTo: address(6), publicRpcUrl: "https://rpc.example.invalid", rpcUrlFile, rpcTransport: "direct",
    roleKeyFiles: Object.fromEntries(["guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent"].map(role => [role, join(root, `${role}.key`)])) as TempoHostedBootstrap["roleKeyFiles"],
    opponentBinding: { chainId: "42431", agentId: "43", wallet: Wallet.createRandom().address }, dashboardAgents: [1, 2, 3].map(id => ({ id: String(id), name: `Agent ${id}` })), gatewayReadyFile, vendorKeyFile,
    tasks: [...oldTasks, newTask], maxFeePerGas: "3600000003", frontendOrigin: "http://127.0.0.1:3028", hostedPort: 8794 };
  const bootstrapFile = await put(join(root, "bootstrap.json"), bootstrap), loaded = await loadTempoHostedBootstrap(bootstrapFile);
  const before = { ...structuredClone(bootstrap), tasks: oldTasks }, oldBinding = tempoRuntimeBinding(before, gateway, loaded.catalog), binding = tempoRuntimeBinding(bootstrap, gateway, loaded.catalog);
  const journal = { version: 1, binding: oldBinding, effectiveBinding: binding, startedAt: "2026-10-12T00:00:00.000Z", templateDeadlineMs: Date.now() - 86400000,
    ipcDirectory: join(directory, "ipc"), operatorToken: "synthetic-operator", ports: {}, originalBootstrap: before, originalCatalog: oldTasks,
    migrations: [{ id: "a".repeat(64), status: "Applied", createdAt: new Date().toISOString(), beforeBinding: oldBinding, afterBinding: binding, before, after: bootstrap, appended: [newTask] }] };
  const journalFile = await put(join(directory, "runtime-journal/session.json"), journal);
  const actorId = randomUUID(), actor = { id: actorId, owner, wallet: actorWallet, modelId: "kimi-k2.6", strategy: "balanced", allowCredit: false, perRunBudgetRaw: "120000", totalBudgetRaw: "300000",
    reservedRaw: "0", spentRaw: "0", status: "Ready", binding: { chainId: "42431", agentId: "73", wallet: actorWallet } };
  const database = await put(join(directory, "hosted/database/session.json"), { version: 1, agents: [actor], runs: [], creations: [], sponsoredOwners: { [owner]: 7 }, sponsoredTotal: 7 });
  await put(paths.boundedGamesFile, { version: 1, id: randomUUID(), parentRequestId: randomUUID(), chainId: "42431", origin: bootstrap.frontendOrigin, asset: TEMPO_PATH_USD, owner, issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 1800000,
    baselineOwnerGames: 7, baselineTotalGames: 7, maxAdditionalGames: 2, maxGameCalls: 40, maxGameCompletionTokens: 20480, maxCashRewardsRaw: "0", actor: { hostedAgentId: actorId, registryId: "73", wallet: actorWallet } });
  const snapshotFile = await put(join(root, "operator/acceptance-20261016/bootstrap-snapshot.json"), { version: 1, chainId: bootstrap.chainId, asset: bootstrap.asset, contracts: { account: bootstrap.contracts.account, escrow: bootstrap.contracts.escrow, manager: bootstrap.contracts.manager } });
  await put(paths.transactionBudgetFile, { version: 1, id: randomUUID(), chainId: "42431", asset: TEMPO_PATH_USD, issuedAtMs: Date.now() - 1000, expiresAtMs: Date.now() + 1800000, maxTransactions: 40,
    maxGasPerTransaction: "20000000", maxFeePerGas: "3600000003", maxFeeRaw: "3000000", signers: [actorWallet], targets: [bootstrap.contracts.account], bootstrapSnapshotFile: snapshotFile,
    bootstrapSnapshotSha256: createHash("sha256").update(await readFile(snapshotFile)).digest("hex") });
  const config: TempoHostedFeatures = { version: 1, id: randomUUID(), chainId: "42431", origin: bootstrap.frontendOrigin,
    externalProvider: { chainId: "42431", registry: bootstrap.identity, agentId: "43", wallet: bootstrap.opponentBinding.wallet }, boundedGamesFile: paths.boundedGamesFile, transactionBudgetFile: paths.transactionBudgetFile,
    taskIds: [newTask.taskId], taskTemplateDeadlineMs: newTask.deadlineMs };
  const input = await put(join(root, "draft-features.json"), config), snapshot = await put(join(directory, "hosted/agents/old/runs/old/task-executor/session.json"), { oldTaskSnapshot: before, deadlineMs: journal.templateDeadlineMs });
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, directory, paths, put, config, input, journal, journalFile, database, bootstrap, bootstrapFile, snapshot };
}

test("feature schema binds exact existing provider, private files, one new task and deadline", async t => {
  const f = await fixture(t); assert.deepEqual(validateTempoHostedFeatures(f.config, f.directory, f.bootstrap), f.config); assert.equal(TEMPO_EXTERNAL_PORTS.length, 17); assert.equal(new Set(TEMPO_EXTERNAL_PORTS).size, 17);
  for (const change of [{ extra: true }, { chainId: "10143" }, { origin: "https://attacker.example" }, { boundedGamesFile: join(f.root, "other.json") }, { transactionBudgetFile: join(f.root, "other.json") },
    { taskIds: ["1", "5"] }, { taskIds: ["99"] }, { taskTemplateDeadlineMs: f.config.taskTemplateDeadlineMs + 1 }, { externalProvider: { ...f.config.externalProvider, agentId: "1999" } }, { externalProvider: { ...f.config.externalProvider, extra: true } }])
    assert.throws(() => validateTempoHostedFeatures({ ...f.config, ...change }, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
});

test("explicit stopped enable freezes features and selects a new task without changing old deadlines or any saved run", async t => {
  const f = await fixture(t), snapshot = await readFile(f.snapshot, "utf8"), bootstrap = await readFile(f.bootstrapFile, "utf8"), database = await readFile(f.database, "utf8");
  const result = await enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input); assert.equal(result.chainWrites, 0); assert.equal(result.cached, false);
  const journal = JSON.parse(await readFile(f.journalFile, "utf8")), verified = await verifyTempoHostedFeatures(journal.features, f.directory, f.bootstrap);
  assert.deepEqual(verified!.config, f.config); assert.equal(journal.templateDeadlineMs, f.journal.templateDeadlineMs);
  assert.deepEqual(tempoFeatureTaskDomain(verified!.config, f.bootstrap, journal), { tasks: [f.bootstrap.tasks.at(-1)], deadlineMs: f.config.taskTemplateDeadlineMs });
  assert.deepEqual(tempoFeatureTaskDomain(undefined, f.bootstrap, journal), { tasks: f.bootstrap.tasks, deadlineMs: f.journal.templateDeadlineMs });
  assert.equal(await readFile(f.snapshot, "utf8"), snapshot); assert.equal(await readFile(f.bootstrapFile, "utf8"), bootstrap); assert.equal(await readFile(f.database, "utf8"), database);
  await assert.rejects(lstat(f.paths.externalDirectory), { code: "ENOENT" }); await assert.rejects(lstat(join(f.root, "operator/acceptance-20261016/transaction-budget-ledger.json")), { code: "ENOENT" });
  assert.equal((await enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input)).cached, true);
  await f.put(f.paths.file, { ...f.config, id: randomUUID() }); await assert.rejects(verifyTempoHostedFeatures(journal.features, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
});

test("enable rejects occupied ports, live settler, locks and in-flight hosted state before installation", async t => {
  const f = await fixture(t), listener = createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  await f.put(f.journalFile, { ...f.journal, ports: { planner: (listener.address() as { port: number }).port } });
  try { await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input), /TEMPO_RUNTIME_STOP_REQUIRED/); }
  finally { await new Promise<void>(done => listener.close(() => done())); }
  await f.put(f.journalFile, f.journal); await mkdir(f.journal.ipcDirectory, { recursive: true });
  const { writeFile } = await import("node:fs/promises"); await writeFile(join(f.journal.ipcDirectory, "settler.owner"), String(process.pid));
  await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input), /TEMPO_RUNTIME_STOP_REQUIRED/); await rm(join(f.journal.ipcDirectory, "settler.owner"));
  const lock = new SessionStore(join(f.directory, "hosted/database")); await lock.start();
  try { await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input)); } finally { await lock.close(); }
  const original = JSON.parse(await readFile(f.database, "utf8"));
  for (const change of [{ runs: [{ status: "Paused" }] }, { agents: [{ ...original.agents[0], reservedRaw: "1" }] }, { agents: [{ ...original.agents[0], activeRequestId: randomUUID() }] }]) {
    await f.put(f.database, { ...original, ...change }); await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input), /TEMPO_TERMINAL_RUNS_REQUIRED/);
  }
  await assert.rejects(lstat(f.paths.file), { code: "ENOENT" });
});

test("enable never adopts an existing external journal or old authorization, and rejects unsafe feature file permissions", async t => {
  const f = await fixture(t); await mkdir(f.paths.externalDirectory, { recursive: true }); await f.put(join(f.paths.externalDirectory, "unknown.json"), { priorPayment: true });
  await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input), /TEMPO_FEATURES_EXTERNAL_JOURNAL_EXISTS/); await rm(f.paths.externalDirectory, { recursive: true });
  const state = JSON.parse(await readFile(f.database, "utf8")); await f.put(f.database, { ...state, boundedGames: {} });
  await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input), /TEMPO_FEATURES_GAME_AUTHORIZATION_INVALID/); await f.put(f.database, state);
  await chmod(f.input, 0o644); await assert.rejects(enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input), /TEMPO_FEATURES_BINDING_INVALID/);
  await assert.rejects(lstat(f.paths.file), { code: "ENOENT" });
});

test("features cannot expand the original task catalog or rewrite a prior migration; bounded autonomy is opt-in", async t => {
  const f = await fixture(t);
  for (const journal of [{ ...f.journal, originalCatalog: f.bootstrap.tasks }, { ...f.journal, migrations: [] }, { ...f.journal, migrations: [{ ...f.journal.migrations[0], appended: f.bootstrap.tasks }] }])
    assert.throws(() => tempoFeatureTaskDomain(f.config, f.bootstrap, journal), /TEMPO_FEATURES_BINDING_INVALID/);
  const base = { maxTasks: 2, maxDecisions: 3, durationMs: 1200000, plannerRelayUrl: "http://127.0.0.1:12345/v1/chat", plannerProvider: f.bootstrap.payTo, plannerPriceRaw: "10000", plannerService: "infercredit/plan", plannerModel: "logical-planner", plannerPhysicalModel: "cheap/kimi-k2.6" };
  assert.deepEqual(tempoFeatureAutonomy(base, false), base); assert.deepEqual(tempoFeatureAutonomy(base, true).games, { maxGames: 2, maxSpendPerGameRaw: "0", rewardKinds: ["llm-credits"], rewardTaskMinTokens: 2048 });
  assert.equal(tempoFeatureAutonomy(base, true).maxTasks, 1); assert.equal(tempoFeatureAutonomy(base, true).maxDecisions, 4); assert.equal(base.maxTasks, 2);
});

async function closureFixture(f: Awaited<ReturnType<typeof fixture>>) {
  await enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input);
  const sha = (raw: string) => createHash("sha256").update(raw).digest("hex");
  const grantRaw = await readFile(f.paths.boundedGamesFile, "utf8"), grant = JSON.parse(grantRaw), budgetRaw = await readFile(f.paths.transactionBudgetFile, "utf8"), budget = JSON.parse(budgetRaw);
  const ledgerFile = join(f.root, "operator/acceptance-20261016/transaction-budget-ledger.json");
  await f.put(ledgerFile, { version: 1, budgetId: budget.id, digest: sha(budgetRaw), reservations: [] });
  const bounded = { grant, digest: sha(grantRaw), admissions: [] };
  const mirror = join(f.root, "operator/bounded-admissions/session.json"); await f.put(mirror, bounded);
  const state = JSON.parse(await readFile(f.database, "utf8")), goalId = randomUUID(), terminalTime = new Date(Date.now() - 1).toISOString();
  state.boundedGames = bounded; state.runs = [{ requestId: goalId, action: "goal", agentId: grant.actor.hostedAgentId, status: "Failed", recoverable: false, result: { terminal: true }, reservedRaw: "120000", updatedAt: terminalTime },
    { requestId: grant.parentRequestId, action: "autonomous", agentId: grant.actor.hostedAgentId, status: "Succeeded", recoverable: false, result: { terminal: true }, reservedRaw: "300000", updatedAt: terminalTime }];
  await f.put(f.database, state);
  const closure = { version: 1, id: f.config.id, closedAt: new Date().toISOString(), goalRequestId: goalId, parentRequestId: grant.parentRequestId,
    budgetId: budget.id, budgetDigest: sha(budgetRaw), ledgerSha256: sha(await readFile(ledgerFile, "utf8")), boundedAdmissionsSha256: sha(await readFile(mirror, "utf8")) };
  await f.put(f.paths.closureFile, closure);
  return { closure, ledgerFile, mirror, state };
}

test("explicit seal retains frozen files and old reserve history, releases the acceptance budget and rejects ambient injection", async t => {
  const f = await fixture(t), closure = await closureFixture(f);
  const before = JSON.parse(await readFile(f.journalFile, "utf8")).features;
  assert.equal(tempoFeatureBudgetFile(before, undefined), f.config.transactionBudgetFile);
  assert.throws(() => tempoFeatureBudgetFile(before, "/unapproved/budget.json"), /TEMPO_FEATURES_BUDGET_ENV_REJECTED/);
  const result = await sealTempoHostedFeatures(f.directory, f.bootstrapFile); assert.equal(result.chainWrites, 0); assert.equal(result.cached, false);
  const after = JSON.parse(await readFile(f.journalFile, "utf8")).features;
  assert.deepEqual({ version: after.version, file: after.file, digest: after.digest, config: after.config }, before);
  assert.equal(tempoFeatureBudgetFile(after, undefined), undefined); assert.throws(() => tempoFeatureBudgetFile(after, f.config.transactionBudgetFile), /TEMPO_FEATURES_BUDGET_ENV_REJECTED/);
  assert.deepEqual(await verifyTempoHostedFeatures(after, f.directory, f.bootstrap), after);
  // Subsequent normal terminal goals do not invalidate the original closure.
  const state = JSON.parse(await readFile(f.database, "utf8")); state.runs.push({ requestId: randomUUID(), action: "goal", agentId: state.agents[0].id, status: "Succeeded", recoverable: false, result: { terminal: true }, updatedAt: new Date(Date.now() + 1).toISOString() }); await f.put(f.database, state);
  assert.equal((await sealTempoHostedFeatures(f.directory, f.bootstrapFile)).cached, true);
  assert.equal((await verifyTempoHostedFeatures(after, f.directory, f.bootstrap))!.seal!.file, f.paths.closureFile);
  await f.put(closure.ledgerFile, { changed: true }); await assert.rejects(verifyTempoHostedFeatures(after, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
});

test("seal requires an existing audit and terminal original requests and cannot predate completion", async t => {
  const f = await fixture(t); await enableTempoHostedFeatures(f.directory, f.bootstrapFile, f.input);
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile)); await assert.rejects(lstat(f.paths.closureFile), { code: "ENOENT" });
  const { closure, state } = await closureFixture(f);
  for (const change of [{ goalRequestId: randomUUID() }, { parentRequestId: randomUUID() }, { closedAt: new Date(Date.parse(state.runs[0].updatedAt) - 1).toISOString() },
    { boundedAdmissionsSha256: "0".repeat(64) }, { ledgerSha256: "0".repeat(64) }]) {
    await f.put(f.paths.closureFile, { ...closure, ...change }); await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
    assert.equal(JSON.parse(await readFile(f.journalFile, "utf8")).features.seal, undefined);
  }
  await f.put(f.paths.closureFile, closure); await f.put(f.database, { ...state, runs: state.runs.map((run: any, index: number) => index ? run : { ...run, status: "Paused" }) });
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_TERMINAL_RUNS_REQUIRED/);
});

test("sealed recover anchors the complete bounded mirror even if a database and mirror are changed together", async t => {
  const f = await fixture(t), c = await closureFixture(f); await sealTempoHostedFeatures(f.directory, f.bootstrapFile);
  const record = JSON.parse(await readFile(f.journalFile, "utf8")).features;
  const changed = structuredClone(c.state); changed.boundedGames.admissions.push({ parentRequestId: c.closure.parentRequestId, childRequestId: randomUUID(), agentId: changed.agents[0].id,
    ordinal: 1, admittedAt: c.closure.closedAt, rewardKind: "llm-credits" });
  await f.put(f.database, changed); await f.put(c.mirror, changed.boundedGames);
  await assert.rejects(verifyTempoHostedFeatures(record, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
});

test("seal and sealed verification reject missing recovery flags or a status-only fake terminal result", async t => {
  const f = await fixture(t), c = await closureFixture(f), record = JSON.parse(await readFile(f.journalFile, "utf8")).features;
  record.seal = { version: 1, file: f.paths.closureFile, digest: createHash("sha256").update(await readFile(f.paths.closureFile)).digest("hex") };
  for (const change of [{ recoverable: undefined }, { recoverable: true }, { result: undefined }, { result: { terminal: false } }]) {
    const changed = structuredClone(c.state); Object.assign(changed.runs[0], change); await f.put(f.database, changed);
    await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_TERMINAL_RUNS_REQUIRED/);
    await assert.rejects(verifyTempoHostedFeatures(record, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
  }
  await f.put(f.database, c.state); assert.equal((await sealTempoHostedFeatures(f.directory, f.bootstrapFile)).sealed, true);
});

async function abortedClosureFixture(f: Awaited<ReturnType<typeof fixture>>) {
  const c = await closureFixture(f), state = structuredClone(c.state), grant = state.boundedGames.grant;
  state.runs = [{ ...state.runs[0], goal: "synthetic interrupted goal", updatedAt: new Date(Date.now() - 1000).toISOString(), result: { terminal: true, success: false, chargedRaw: "0" } }];
  state.autonomousGameAdmissions = {};
  await f.put(f.database, state);
  const missionFile = join(f.directory, "hosted/agents", grant.actor.hostedAgentId, "runs", state.runs[0].requestId, "mission/session.json");
  const mission = { version: 1, input: { goal: state.runs[0].goal, owner: grant.owner, wallet: grant.actor.wallet, agentId: grant.actor.hostedAgentId, chainAgentId: "73", chainId: "42431" },
    view: { stage: "paused", phases: [], calls: [] }, calls: [], result: state.runs[0].result };
  await f.put(missionFile, mission);
  const closure = { ...c.closure, closedAt: new Date(Date.now() - 100).toISOString(), outcome: "aborted-before-parent" as const };
  await f.put(f.paths.closureFile, closure);
  return { ...c, state, closure, mission, missionFile, grant };
}

test("abort-before-parent seals a genuinely failed original goal without fabricating its parent and releases only this window", async t => {
  const f = await fixture(t), c = await abortedClosureFixture(f);
  const historical = await readFile(f.snapshot), taskCatalog = await readFile(f.bootstrapFile), budget = await readFile(f.paths.transactionBudgetFile), grant = await readFile(f.paths.boundedGamesFile);
  assert.equal((await sealTempoHostedFeatures(f.directory, f.bootstrapFile)).sealed, true);
  const record = JSON.parse(await readFile(f.journalFile, "utf8")).features;
  assert.equal(tempoFeatureBudgetFile(record, undefined), undefined);
  assert.equal((await verifyTempoHostedFeatures(record, f.directory, f.bootstrap))!.seal!.file, f.paths.closureFile);
  assert.deepEqual(await readFile(f.snapshot), historical); assert.deepEqual(await readFile(f.bootstrapFile), taskCatalog);
  assert.deepEqual(await readFile(f.paths.transactionBudgetFile), budget); assert.deepEqual(await readFile(f.paths.boundedGamesFile), grant);
  assert.equal(JSON.parse(await readFile(f.database, "utf8")).runs.length, 1);
  await assert.rejects(lstat(join(f.directory, "hosted/agents", c.grant.actor.hostedAgentId, "runs", c.closure.parentRequestId)), { code: "ENOENT" });
});

test("abort rejects a parent, admission, creation or nested child trace even when the visible runs claim terminal", async t => {
  const f = await fixture(t), c = await abortedClosureFixture(f);
  const parent = { requestId: c.closure.parentRequestId, agentId: c.grant.actor.hostedAgentId, action: "autonomous", status: "Failed", recoverable: false, result: { terminal: true, success: false }, updatedAt: c.state.runs[0].updatedAt };
  for (const change of [{ runs: [...c.state.runs, parent] }, { creations: [{ requestId: parent.requestId }] },
    { autonomousGameAdmissions: { [randomUUID()]: { parentRequestId: parent.requestId } } },
    { runs: [{ ...c.state.runs[0], result: { ...c.state.runs[0].result, nested: { childId: parent.requestId } } }] }]) {
    await f.put(f.database, { ...c.state, ...change });
    await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  }
  await f.put(f.database, c.state);
  const nested = join(f.directory, "hosted/agents/unrelated/runs/other/autonomy-host/session.json");
  await f.put(nested, { children: { [parent.requestId]: {} } });
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  await rm(nested);
  const path = join(f.directory, "unrelated", parent.requestId); await mkdir(path, { recursive: true });
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/); await rm(path, { recursive: true });
  const changed = structuredClone(c.state); changed.boundedGames.admissions.push({ parentRequestId: parent.requestId, childRequestId: randomUUID(), agentId: c.grant.actor.hostedAgentId, ordinal: 1, admittedAt: c.closure.closedAt, rewardKind: "llm-credits" });
  await f.put(f.database, changed); await f.put(c.mirror, changed.boundedGames);
  await f.put(f.paths.closureFile, { ...c.closure, boundedAdmissionsSha256: createHash("sha256").update(await readFile(c.mirror)).digest("hex") });
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
});

test("abort requires one failed nonrecoverable goal and its original terminal mission with no outstanding call", async t => {
  const f = await fixture(t), c = await abortedClosureFixture(f);
  for (const change of [{ status: "Succeeded" }, { result: { terminal: true, success: true } }, { agentId: randomUUID() }]) {
    await f.put(f.database, { ...c.state, runs: [{ ...c.state.runs[0], ...change }] });
    await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  }
  await f.put(f.database, { ...c.state, runs: [...c.state.runs, c.state.runs[0]] });
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  await f.put(f.database, c.state);
  for (const mission of [{ ...c.mission, result: { terminal: false, success: false } }, { ...c.mission, input: { ...c.mission.input, owner: Wallet.createRandom().address } },
    { ...c.mission, calls: [{ started: true, recovery: { resolved: false } }] }]) {
    await f.put(c.missionFile, mission); await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  }
});

test("initial abort seal rejects moved sponsor counters or any reward directory rather than erasing them", async t => {
  const f = await fixture(t), c = await abortedClosureFixture(f);
  for (const change of [{ sponsoredTotal: 8 }, { sponsoredOwners: { [c.grant.owner]: 8 } }]) {
    await f.put(f.database, { ...c.state, ...change }); await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  }
  await f.put(f.database, c.state);
  const credits = join(f.directory, "credits", c.grant.actor.hostedAgentId); await mkdir(credits, { recursive: true });
  await assert.rejects(sealTempoHostedFeatures(f.directory, f.bootstrapFile), /TEMPO_FEATURES_BINDING_INVALID/);
  assert.equal((await lstat(credits)).isDirectory(), true);
});

test("sealed abort allows later ordinary settings and rewards, but rejects missing, old, foreign or parent-linked credit evidence", async t => {
  const f = await fixture(t), c = await abortedClosureFixture(f); await sealTempoHostedFeatures(f.directory, f.bootstrapFile);
  const record = JSON.parse(await readFile(f.journalFile, "utf8")).features;
  const changed = structuredClone(c.state); Object.assign(changed.agents[0], { modelId: "kimi-k3", strategy: "aggressive", allowCredit: true }); changed.sponsoredTotal++; changed.sponsoredOwners[c.grant.owner]++;
  await f.put(f.database, changed); assert.ok(await verifyTempoHostedFeatures(record, f.directory, f.bootstrap));
  const credits = join(f.directory, "credits", c.grant.actor.hostedAgentId); await mkdir(credits, { recursive: true });
  await assert.rejects(verifyTempoHostedFeatures(record, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
  const createdAt = new Date().toISOString();
  const later = { version: 1, accounts: [{ agentId: "73", wallet: c.grant.actor.wallet.toLowerCase() }, { agentId: "43", wallet: f.bootstrap.opponentBinding.wallet.toLowerCase() }],
    grants: [{ grantId: randomUUID(), createdAt }], redemptions: [{ redemptionId: "later-task:round:0", createdAt }] };
  await f.put(join(credits, "session.json"), later); assert.ok(await verifyTempoHostedFeatures(record, f.directory, f.bootstrap));
  for (const bad of [{ ...later, accounts: [] }, { ...later, grants: [{ ...later.grants[0], createdAt: c.closure.closedAt }] },
    { ...later, grants: [{ ...later.grants[0], createdAt: new Date(Date.now() + 60000).toISOString() }] },
    { ...later, redemptions: [{ redemptionId: `later:${c.closure.parentRequestId}:round:0`, createdAt }] }]) {
    await f.put(join(credits, "session.json"), bad); await assert.rejects(verifyTempoHostedFeatures(record, f.directory, f.bootstrap), /TEMPO_FEATURES_BINDING_INVALID/);
  }
});
