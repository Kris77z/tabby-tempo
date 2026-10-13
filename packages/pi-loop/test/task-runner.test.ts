import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { randomUUID } from "node:crypto";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { TaskRunner, createTaskRunnerHttpServer, loadTaskRunnerConfig, parseTaskRunnerCommand, parseTaskRunnerSnapshot, type TaskRunnerDependencies } from "../src/task-runner/index.js";
import type { WorkflowConfig, WorkflowStatus } from "../src/workflow.js";

const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value), { mode: 0o600 });
async function setup() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-task-runner-"))), wallet = Wallet.createRandom(), deadlineMs = Date.now() + 240000;
  const keyFile = join(directory, "wallet.key"), rpcUrlFile = join(directory, "rpc-url"), workflowConfigFile = join(directory, "profile.json"), path = join(directory, "runner.json");
  await writeFile(keyFile, wallet.privateKey, { mode: 0o600 }); await writeFile(rpcUrlFile, "http://127.0.0.1:8545", { mode: 0o600 });
  const workflow: WorkflowConfig = { agentId: "1", chainId: "31337", account: wallet.address, asset: Wallet.createRandom().address, escrowAddress: Wallet.createRandom().address,
    tasks: [{ taskId: "1", problemId: "sum-integers", deadlineMs, creditLimit: "80000" }], providers: [{ id: "fixed-b", payTo: Wallet.createRandom().address, relayUrl: "http://127.0.0.1:8788/v1/chat",
      service: "infercredit/solve-fixed", model: "pi-fixed-v1", routes: [{ tier: "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers"],
        solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 4, maxCompletionTokens: 2048 } }] }],
    allowCredit: true, maxPrice: "120000", deadlineMs, minRemainingMs: 1000, maxCompletionTokens: 2048 };
  await save(workflowConfigFile, workflow);
  const config = { version: 1, dataDirectory: join(directory, "data"), port: 8790, wallet: wallet.address, keyFile,
    profiles: [{ id: "sum-credit", label: "求和信用任务", workflowConfigFile, rpcUrlFile, rpcTransport: "direct", arenaUrl: "http://127.0.0.1:8789", underwriterUrl: "http://127.0.0.1:8787" }] };
  await save(path, config); const loaded = await loadTaskRunnerConfig(path); loaded.walletLockDirectory = join(directory, "wallet-lock");
  return { directory, path, config, loaded, workflowConfigFile, rpcUrlFile, keyFile };
}
async function serve(runner: TaskRunner) {
  const server = createTaskRunnerHttpServer(runner); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks/runs`;
  const command = (value: unknown, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(value) });
  return { server, url, command, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
const status = (phase: WorkflowStatus["phase"] = "Succeeded"): WorkflowStatus => ({ version: 1, phase, deadlineMs: Date.now() + 100000, reservedPrice: "120000",
  choice: { taskId: "1", problemId: "sum-integers", providerId: "fixed-b", tier: "cheap", price: "120000", funding: "task-credit" }, paymentId: "0x" + "a".repeat(64) });
function connection(): NonNullable<TaskRunnerDependencies["connect"]> { return async () => { const provider = new JsonRpcProvider("http://127.0.0.1:8545", 31337, { staticNetwork: true }); return { provider, rpcUrl: "http://127.0.0.1:8545", close: () => provider.destroy() }; }; }

test("TaskRunner HTTP is nonblocking and idempotent; fixed profiles and safe state never expose private fields", async () => {
  const f = await setup(); let calls = 0, finish!: () => void, entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const pending = new Promise<void>(resolve => { finish = resolve; }), states = new Map<string, WorkflowStatus>();
  const runner = new TaskRunner(f.loaded, { connect: connection(), readStatus: async directory => states.get(directory), workflow: async directory => {
    calls++; entered(); await pending; const value = { ...status(), rawTransaction: "private-signed-bytes", rpcUrl: "private-key-url", code: "private-code" }; states.set(directory, value); return value;
  } }); const http = await serve(runner), requestId = randomUUID();
  try {
    const initial = await http.command({ action: "start", requestId, profileId: "sum-credit" }); assert.equal(initial.status, 202);
    const snapshot = parseTaskRunnerSnapshot(await initial.json()); assert.ok(["Queued", "Running"].includes(snapshot.run!.status));
    const idem = await http.command({ action: "start", requestId, profileId: "sum-credit" }); assert.equal(idem.status, 202);
    const busy = await http.command({ action: "start", requestId: randomUUID(), profileId: "sum-credit" }); assert.equal(busy.status, 409);
    const active = await fetch(http.url + `?requestId=${requestId}`); assert.equal(active.status, 200); await started; assert.equal(calls, 1);
    finish(); await runner.waitUntilIdle(); const result = parseTaskRunnerSnapshot(await (await fetch(http.url + `?requestId=${requestId}`)).json());
    assert.equal(result.run!.status, "Succeeded"); assert.equal(result.run!.recoverable, false);
    for (const privateValue of [f.directory, f.loaded.config.wallet, "rawTransaction", "private-signed-bytes", "private-key-url", "private-code", "keyFile", "rpcUrl"]) assert.equal(JSON.stringify(result).includes(privateValue), false);
    assert.equal((await http.command({ action: "recover", requestId })).status, 202); await runner.waitUntilIdle(); assert.equal(calls, 1);
  } finally { finish(); await runner.waitUntilIdle(); await http.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("TaskRunner rejects browser parameters, cross-origin/host requests and oversized bodies before dispatch", async () => {
  const f = await setup(); let calls = 0;
  const runner = new TaskRunner(f.loaded, { connect: connection(), workflow: async () => { calls++; return status(); }, readStatus: async () => undefined }), http = await serve(runner);
  try {
    const command = { action: "start", requestId: randomUUID(), profileId: "sum-credit" };
    for (const extra of [{ wallet: "0x0" }, { prompt: "do anything" }, { amount: "1" }, { url: "http://evil" }, { path: "/tmp" }]) assert.equal((await http.command({ ...command, ...extra })).status, 400);
    assert.equal((await http.command({ ...command, profileId: "unknown" })).status, 403);
    assert.equal((await http.command(command, { origin: "https://evil.example" })).status, 403);
    const invalidHost = await new Promise<number>((resolve, reject) => {
      const request = httpRequest(http.url, { method: "POST", headers: { host: "evil.example", "content-type": "application/json" } }, response => { response.resume(); resolve(response.statusCode!); });
      request.once("error", reject); request.end(JSON.stringify(command));
    }); assert.equal(invalidHost, 403);
    assert.equal((await http.command(command, { "sec-fetch-site": "cross-site" })).status, 403);
    assert.equal((await http.command({ action: "recover", requestId: command.requestId, profileId: "sum-credit" })).status, 400);
    assert.equal((await fetch(http.url, { method: "POST", headers: { "content-type": "application/json" }, body: "x".repeat(3000) })).status, 413);
    assert.equal((await fetch(http.url, { method: "POST", body: "{}" })).status, 415);
    assert.equal((await fetch(http.url + "?url=evil")).status, 400);
    assert.equal((await fetch(http.url + `?requestId=${command.requestId}&requestId=${command.requestId}`)).status, 400);
    assert.equal((await fetch(http.url, { method: "OPTIONS" })).status, 405); assert.equal(calls, 0);
  } finally { await runner.waitUntilIdle(); await http.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("paused original request blocks new IDs and dead process writer recovery retains its exact workflow directory", async () => {
  const f = await setup(), requestId = randomUUID(), workflowDirectory = join(f.loaded.config.dataDirectory, "runs", requestId), registry = join(f.loaded.config.dataDirectory, ".task-runner");
  await mkdir(join(registry, ".writer"), { recursive: true, mode: 0o700 }); await save(join(registry, ".writer/owner.json"), { pid: 99999999, token: "dead" });
  await save(join(registry, "session.json"), { version: 1, configDigest: f.loaded.digest, activeRequestId: requestId,
    runs: [{ requestId, profileId: "sum-credit", workflowDirectory, ownerPid: 99999999, status: "Running", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoverable: false }] });
  let calls = 0; const observed = status("Paused"); observed.reason = "UPSTREAM_UNCERTAIN";
  const runner = new TaskRunner(f.loaded, { connect: connection(), readStatus: async () => observed, workflow: async directory => { assert.equal(directory, workflowDirectory); calls++; return observed; } }), http = await serve(runner);
  try {
    const snapshot = parseTaskRunnerSnapshot(await (await fetch(http.url + `?requestId=${requestId}`)).json()); assert.equal(snapshot.run!.status, "Paused"); assert.equal(snapshot.run!.recoverable, true); assert.equal(calls, 0);
    assert.equal((await http.command({ action: "start", requestId: randomUUID(), profileId: "sum-credit" })).status, 409);
    assert.equal((await http.command({ action: "recover", requestId })).status, 202); await runner.waitUntilIdle(); assert.equal(calls, 1);
    const blocked = await http.command({ action: "start", requestId: randomUUID(), profileId: "sum-credit" }); assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, "TASK_RECOVER_ORIGINAL_REQUIRED");
  } finally { await http.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("private preset configuration enforces owner-only files, matching wallet and loopback services; supported RPC chains are not browser-selected", async () => {
  const f = await setup();
  try {
    await chmod(f.keyFile, 0o644); await assert.rejects(loadTaskRunnerConfig(f.path), /TASK_PRIVATE_FILE_REQUIRED/); await chmod(f.keyFile, 0o600);
    const linked = join(f.directory, "wallet-link"); await symlink(f.keyFile, linked); await save(f.path, { ...f.config, keyFile: linked }); await assert.rejects(loadTaskRunnerConfig(f.path), /TASK_PRIVATE_FILE_REQUIRED/);
    await save(f.path, { ...f.config, wallet: Wallet.createRandom().address }); await assert.rejects(loadTaskRunnerConfig(f.path), /TASK_SIGNER_WALLET_MISMATCH/);
    await save(f.path, { ...f.config, profiles: [{ ...f.config.profiles[0], arenaUrl: "http://example.com" }] }); await assert.rejects(loadTaskRunnerConfig(f.path), /TASK_LOOPBACK_SERVICE_REQUIRED/);
    await save(f.path, f.config); const workflow = JSON.parse(await readFile(f.workflowConfigFile, "utf8")); workflow.chainId = "10143";
    await save(f.workflowConfigFile, workflow); await writeFile(f.rpcUrlFile, "https://rpc.invalid/private-key-in-memory-only", { mode: 0o600 });
    assert.equal((await loadTaskRunnerConfig(f.path)).profiles[0].workflow.chainId, "10143");
    workflow.chainId = "1"; await save(f.workflowConfigFile, workflow); await assert.rejects(loadTaskRunnerConfig(f.path), /TASK_CHAIN_NOT_SUPPORTED/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("an old Stopped registry with lost active ID rejects new start before creating a run and recovers only its original paid submission", async () => {
  const f = await setup(), requestId = randomUUID(), workflowDirectory = join(f.loaded.config.dataDirectory, "runs", requestId), registry = join(f.loaded.config.dataDirectory, ".task-runner");
  await mkdir(registry, { recursive: true, mode: 0o700 });
  await save(join(registry, "session.json"), { version: 1, configDigest: f.loaded.digest,
    runs: [{ requestId, profileId: "sum-credit", workflowDirectory, status: "Stopped", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoverable: false, workflow: status("Stopped") }] });
  let observed = status("SubmissionPending"), calls = 0; observed.childPhase = "SubmissionPending"; observed.reason = "SUBMISSION_HTTP_400";
  const originalPaymentId = observed.paymentId;
  const runner = new TaskRunner(f.loaded, { connect: connection(), readStatus: async () => observed, workflow: async (directory, _config, options) => {
    assert.equal(directory, workflowDirectory); assert.equal(options.recoverLock, true); calls++;
    observed = status(); return observed;
  } }), http = await serve(runner);
  try {
    const old = parseTaskRunnerSnapshot(await (await fetch(http.url + `?requestId=${requestId}`)).json());
    assert.equal(old.run!.status, "Paused"); assert.equal(old.run!.workflow!.phase, "SubmissionPending"); assert.equal(old.run!.recoverable, true); assert.equal(calls, 0);
    const newRequestId = randomUUID(), blocked = await http.command({ action: "start", requestId: newRequestId, profileId: "sum-credit" });
    assert.equal(blocked.status, 409); assert.equal((await blocked.json()).error, "TASK_RECOVER_ORIGINAL_REQUIRED");
    const restored = JSON.parse(await readFile(join(registry, "session.json"), "utf8"));
    assert.equal(restored.activeRequestId, requestId); assert.equal(restored.runs.length, 1); assert.equal(restored.runs[0].status, "Paused"); assert.equal(calls, 0);
    assert.equal((await fetch(http.url + `?requestId=${newRequestId}`)).status, 404);
    assert.equal((await http.command({ action: "recover", requestId })).status, 202); await runner.waitUntilIdle(); assert.equal(calls, 1);
    const complete = parseTaskRunnerSnapshot(await (await fetch(http.url + `?requestId=${requestId}`)).json());
    assert.equal(complete.run!.status, "Succeeded"); assert.equal(complete.run!.workflow!.paymentId, originalPaymentId);
    assert.equal((await http.command({ action: "recover", requestId })).status, 202); await runner.waitUntilIdle(); assert.equal(calls, 1);
  } finally { await runner.waitUntilIdle(); await http.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("an existing nonterminal registry without an active ID also blocks new start and restores the original active ID", async () => {
  const f = await setup(), requestId = randomUUID(), workflowDirectory = join(f.loaded.config.dataDirectory, "runs", requestId), registry = join(f.loaded.config.dataDirectory, ".task-runner");
  await mkdir(registry, { recursive: true, mode: 0o700 });
  await save(join(registry, "session.json"), { version: 1, configDigest: f.loaded.digest,
    runs: [{ requestId, profileId: "sum-credit", workflowDirectory, status: "Paused", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoverable: true, workflow: status("Paused") }] });
  let calls = 0;
  const runner = new TaskRunner(f.loaded, { connect: connection(), readStatus: async () => status("Paused"), workflow: async directory => { assert.equal(directory, workflowDirectory); calls++; return status("Paused"); } }), http = await serve(runner);
  try {
    const blocked = await http.command({ action: "start", requestId: randomUUID(), profileId: "sum-credit" }); assert.equal(blocked.status, 409);
    const restored = JSON.parse(await readFile(join(registry, "session.json"), "utf8")); assert.equal(restored.activeRequestId, requestId); assert.equal(restored.runs.length, 1); assert.equal(calls, 0);
    assert.equal((await http.command({ action: "recover", requestId })).status, 202); await runner.waitUntilIdle(); assert.equal(calls, 1);
  } finally { await runner.waitUntilIdle(); await http.close(); await rm(f.directory, { recursive: true, force: true }); }
});

test("the lightweight public schema rejects untrusted upstream extras and malformed safe fields", () => {
  const valid = { enabled: true, profiles: [{ profileId: "sum-credit", label: "Sum", chainId: "31337", agentId: "1", problemIds: ["sum-integers"] }],
    runs: [], run: { requestId: randomUUID(), profileId: "sum-credit", status: "Succeeded", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoverable: false, workflow: status() } };
  assert.deepEqual(parseTaskRunnerSnapshot(valid), valid);
  for (const mutate of [(v: any) => { v.url = "private"; }, (v: any) => { v.run.rawTransaction = "signed"; }, (v: any) => { v.run.workflow.code = "secret"; },
    (v: any) => { v.run.workflow.reason = "https://key.invalid"; }, (v: any) => { v.run.workflow.reservedPrice = "-1"; }, (v: any) => { v.run.workflow.choice.providerId = undefined; }]) {
    const changed = structuredClone(valid); mutate(changed); assert.throws(() => parseTaskRunnerSnapshot(changed), /TASK_PUBLIC_SNAPSHOT_INVALID/);
  }
  assert.throws(() => parseTaskRunnerCommand({ action: "start", requestId: randomUUID(), profileId: "sum-credit", configFile: "/private" }), /TASK_COMMAND_INVALID/);
});
