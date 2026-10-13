import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Wallet } from "ethers";
import { checkBackend, loadBackend, startBackend, type BackendManifest, type BackendRole } from "../backend.js";

const roles: BackendRole[] = ["underwriter", "fixed-relay", "settler", "arena", "task-runner"];
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = `0x${"1".repeat(40)}`;
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-backend-")));
  const servers = Array.from({ length: 4 }, () => createServer());
  for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
  const ports = servers.map(server => (server.address() as { port: number }).port);
  await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
  const put = async (name: string, value: string | object) => {
    const path = join(directory, name); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return path;
  };
  const arena = await put("arena.json", { rpcUrl: "http://127.0.0.1:1", chainId: "31337", escrowAddress: address,
    tasks: { "1": { agentId: "1", problemId: "sum-integers" } }, ipcDirectory: join(directory, "ipc") });
  const deadlineMs = Date.now() + 240000;
  const workflowConfig = { agentId: "1", chainId: "31337", account: address, asset: address, escrowAddress: address,
    tasks: [{ taskId: "1", problemId: "sum-integers", deadlineMs, creditLimit: "80000" }], providers: [{ id: "synthetic", payTo: address, relayUrl: `http://127.0.0.1:${ports[1]}/v1/chat`,
      service: "infercredit/solve-fixed", model: "pi-fixed-v1", routes: [{ tier: "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers"],
        solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128 } }] }],
    allowCredit: true, maxPrice: "120000", deadlineMs, minRemainingMs: 1000, maxCompletionTokens: 128 };
  const agentKey = await put("agent.key", key(3)), workflow = await put("workflow.json", workflowConfig), rpc = await put("rpc.txt", "http://127.0.0.1:1");
  const runner = await put("runner.json", { version: 1, dataDirectory: join(directory, "tasks"), port: ports[3], wallet: new Wallet(key(3)).address, keyFile: agentKey,
    profiles: [{ id: "local", label: "Synthetic controlled test", workflowConfigFile: workflow, rpcUrlFile: rpc, rpcTransport: "direct", arenaUrl: `http://127.0.0.1:${ports[2]}`, underwriterUrl: `http://127.0.0.1:${ports[0]}` }] });
  const env = async (name: string, values: Record<string, string>) => put(`${name}.env`, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n"));
  const underwriter = await env("underwriter", { RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "31337", MANAGER_ADDRESS: address, SETTLEMENT_ASSET: address, ASSET_DECIMALS: "6", UNDERWRITER_PRIVATE_KEY: key(1) });
  const relay = await env("relay", { RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "31337", ACCOUNT_ADDRESS: address, SETTLEMENT_ASSET: address, ASSET_DECIMALS: "6", PROVIDER_ADDRESS: address, PRICE: "120000", MODEL_KEY: "SYNTHETIC_MODEL_SECRET",
    UPSTREAMS_JSON: JSON.stringify([{ name: "synthetic", model: "synthetic", baseUrl: "http://127.0.0.1:1/v1", keyEnv: "MODEL_KEY" }]) });
  const settler = await env("settler", { ARENA_VERIFIER_PRIVATE_KEY: key(2) }), http = await env("http", {}), task = await env("task", {});
  const manifest: BackendManifest = { version: 1, runtimeDirectory: join(directory, "runtime"), startupTimeoutMs: 2000, roles: {
    underwriter: { envFile: underwriter, port: ports[0] }, "fixed-relay": { envFile: relay, port: ports[1] }, settler: { envFile: settler, configFile: arena },
    arena: { envFile: http, configFile: arena, port: ports[2] }, "task-runner": { envFile: task, configFile: runner, port: ports[3] },
  } };
  const path = await put("backend.json", manifest);
  return { directory, path, manifest, put, agentKey, workflow, workflowConfig, rpc, runner, close: () => rm(directory, { recursive: true, force: true }) };
}
const controlledChild = `
  const fs = require('node:fs'), net = require('node:net');
  const [role, port, behavior] = process.argv.slice(1);
  fs.writeSync(1, JSON.stringify({environment: process.env}) + '\\n');
  if (behavior === 'fail') { fs.writeSync(2, 'FAKE_SECRET_DO_NOT_PROPAGATE\\n'); process.exit(7); }
  let server;
  if (role === 'settler') { console.log(JSON.stringify({ready:true,pid:process.pid})); setInterval(() => {}, 1000); }
  else if (behavior === 'hang') setInterval(() => {}, 1000);
  else server = net.createServer(socket => socket.end()).listen(Number(port), '127.0.0.1');
  process.on('SIGTERM', () => { if (behavior === 'ignore') return; if (server) server.close(() => process.exit(0)); else process.exit(0); });
`;
function launcher(manifest: BackendManifest, children: Map<BackendRole, ChildProcess>, behavior?: [BackendRole, string]) {
  return (role: BackendRole, args: string[], options: Parameters<typeof spawn>[2]) => {
    assert.deepEqual(args.slice(0, 2), ["--import", "tsx"]);
    assert.match(args[2], /^(services\/(underwriter|arena)\/src\/(main|settler-main|http-main)|scripts\/(fixed-relay|task-runner))\.ts$/);
    assert.equal(options?.shell, undefined);
    const child = spawn(process.execPath, ["-e", controlledChild, role, String(manifest.roles[role].port ?? 0), behavior?.[0] === role ? behavior[1] : "normal"], options);
    children.set(role, child); return child;
  };
}
function stopped(children: Map<BackendRole, ChildProcess>) {
  for (const child of children.values()) { assert.ok(child.exitCode !== null || child.signalCode !== null); assert.throws(() => process.kill(child.pid!, 0), /ESRCH/); }
}

test("check is offline/read-only, accepts only fixed roles and rejects unsafe configuration", async () => {
  const f = await fixture();
  try {
    await checkBackend(await loadBackend(f.path)); await assert.rejects(lstat(f.manifest.runtimeDirectory), { code: "ENOENT" });
    const cli = promisify(execFile); const result = await cli(process.execPath, ["--import", "tsx", "scripts/backend.ts", "--manifest", f.path], { cwd: resolve(import.meta.dirname, "../.."), timeout: 10000 });
    assert.deepEqual(JSON.parse(result.stdout), { service: "backend", checked: true }); assert.equal(result.stderr, "");
    await assert.rejects(cli(process.execPath, ["--import", "tsx", "scripts/backend.ts", "--manifest", f.path, "--command", "sh"], { cwd: resolve(import.meta.dirname, "../.."), timeout: 10000 }), (error: any) => { assert.equal(error.stderr.trim(), "BACKEND_INVALID_ARGUMENT"); return true; });
    const invalid = structuredClone(f.manifest) as any; invalid.roles.underwriter.command = "/bin/sh"; await f.put("invalid.json", invalid);
    await assert.rejects(loadBackend(join(f.directory, "invalid.json")), /BACKEND_CONFIG_INVALID/);
    await chmod(f.path, 0o644); await assert.rejects(loadBackend(f.path), /BACKEND_PRIVATE_FILE_REQUIRED/); await chmod(f.path, 0o600);
    const text = await readFile(f.manifest.roles.underwriter.envFile, "utf8");
    await writeFile(f.manifest.roles.underwriter.envFile, text + "\nHOST=0.0.0.0"); await assert.rejects(loadBackend(f.path), /BACKEND_LOOPBACK_PORT_REQUIRED/);
    await writeFile(f.manifest.roles.underwriter.envFile, text + "\nNODE_OPTIONS=--eval"); await assert.rejects(loadBackend(f.path), /BACKEND_ENV_REJECTED/);
    await writeFile(f.manifest.roles.underwriter.envFile, text + `\nARENA_VERIFIER_PRIVATE_KEY=${key(2)}`); await assert.rejects(loadBackend(f.path), /BACKEND_ENV_REJECTED/);
    await writeFile(f.manifest.roles.underwriter.envFile, text.replace(key(1), key(2))); await assert.rejects(loadBackend(f.path), /BACKEND_VERIFIER_ISOLATION_REQUIRED/);
    await writeFile(f.manifest.roles.settler.envFile, `ARENA_VERIFIER_PRIVATE_KEY='${key(171)}'`);
    await writeFile(f.manifest.roles.underwriter.envFile, text.replace(key(1), key(171).replace("ab", "AB"))); await assert.rejects(loadBackend(f.path), /BACKEND_VERIFIER_ISOLATION_REQUIRED/);
    await writeFile(f.manifest.roles.underwriter.envFile, text); await writeFile(f.agentKey, key(171).replace("ab", "AB")); await assert.rejects(loadBackend(f.path), /BACKEND_VERIFIER_ISOLATION_REQUIRED/);
  } finally { await f.close(); }
});

test("fixed-relay RPC_URL_FILE-only configuration is checked without exposing the private URL", async () => {
  const f = await fixture();
  try {
    const sentinel = "SENTINEL_PRIVATE_RPC_PATH", rpcFile = await f.put("private-rpc.txt", `https://example.invalid/v2/${sentinel}`);
    const relay = f.manifest.roles["fixed-relay"].envFile, text = (await readFile(relay, "utf8")).replace(/^RPC_URL=.*\n/m, "").replace("CHAIN_ID='31337'", "CHAIN_ID='10143'");
    await writeFile(relay, text + `\nRPC_URL_FILE='${rpcFile}'`);
    const loaded = await loadBackend(f.path); assert.equal(loaded.environments["fixed-relay"].RPC_URL, undefined); assert.equal(loaded.environments["fixed-relay"].RPC_URL_FILE, rpcFile);
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", "scripts/backend.ts", "--manifest", f.path, "--check"], { cwd: resolve(import.meta.dirname, "../.."), timeout: 10000 });
    assert.equal(JSON.parse(result.stdout).checked, true); assert.ok(!(result.stdout + result.stderr).includes(sentinel));
    await chmod(rpcFile, 0o644); await assert.rejects(loadBackend(f.path), /PRIVATE_RPC_URL_FILE_REQUIRED/);
  } finally { await f.close(); }
});

test("offline check rejects bad workflow, wallet/key and RPC/relay semantics without creating runtime state", async () => {
  const f = await fixture();
  try {
    await f.put("workflow.json", {}); await assert.rejects(loadBackend(f.path), /BACKEND_WORKFLOW_CONFIG_INVALID/);
    await f.put("workflow.json", f.workflowConfig); await writeFile(f.agentKey, key(5)); await assert.rejects(loadBackend(f.path), /BACKEND_RUNNER_WALLET_MISMATCH/);
    await writeFile(f.agentKey, key(3)); await writeFile(f.rpc, "https://example.invalid/private-sentinel"); await assert.rejects(loadBackend(f.path), /BACKEND_RUNNER_RPC_OR_RELAY_INVALID/);
    await writeFile(f.rpc, "http://127.0.0.1:1"); const invalidRelay = structuredClone(f.workflowConfig); invalidRelay.providers[0].relayUrl = "https://example.invalid/v1/chat";
    await f.put("workflow.json", invalidRelay); await assert.rejects(loadBackend(f.path), /BACKEND_RUNNER_RPC_OR_RELAY_INVALID/);
    const invalidChain = structuredClone(f.workflowConfig); invalidChain.chainId = "1"; await f.put("workflow.json", invalidChain); await assert.rejects(loadBackend(f.path), /BACKEND_RUNNER_CHAIN_UNSUPPORTED/);
    for (const path of [f.manifest.runtimeDirectory, join(f.directory, "tasks")]) await assert.rejects(lstat(path), { code: "ENOENT" });
    await f.put("workflow.json", f.workflowConfig); await checkBackend(await loadBackend(f.path));
    for (const path of [f.manifest.runtimeDirectory, join(f.directory, "tasks")]) await assert.rejects(lstat(path), { code: "ENOENT" });
  } finally { await f.close(); }
});

test("five real children get only their role environment, private logs, ready status and exclusive runtime lock", { timeout: 15000 }, async () => {
  const f = await fixture(), children = new Map<BackendRole, ChildProcess>(); let runtime: Awaited<ReturnType<typeof startBackend>> | undefined;
  const original = { verifier: process.env.ARENA_VERIFIER_PRIVATE_KEY, model: process.env.KIMI_API_KEY, options: process.env.NODE_OPTIONS };
  try {
    process.env.ARENA_VERIFIER_PRIVATE_KEY = "PARENT_SECRET"; process.env.KIMI_API_KEY = "PARENT_MODEL_SECRET"; process.env.NODE_OPTIONS = "--invalid-parent-option";
    runtime = await startBackend(await loadBackend(f.path), { launch: launcher(f.manifest, children), shutdownTimeoutMs: 100 });
    const status = JSON.parse(await readFile(runtime.statusFile, "utf8")); assert.equal(status.state, "running"); assert.equal(Object.keys(status.roles).length, 5);
    for (const role of roles) {
      assert.equal(status.roles[role].state, "ready"); assert.equal((await lstat(status.roles[role].logFile)).mode & 0o777, 0o600);
      const env = JSON.parse((await readFile(status.roles[role].logFile, "utf8")).split("\n")[0]).environment;
      assert.equal(env.NODE_ENV, "production"); assert.equal(env.NODE_OPTIONS, undefined); assert.equal(env.KIMI_API_KEY, undefined);
      assert.equal(env.ARENA_VERIFIER_PRIVATE_KEY, role === "settler" ? key(2) : undefined);
      assert.equal(env.UNDERWRITER_PRIVATE_KEY, role === "underwriter" ? key(1) : undefined);
      assert.equal(env.MODEL_KEY, role === "fixed-relay" ? "SYNTHETIC_MODEL_SECRET" : undefined);
      assert.equal(env.TASK_RUNNER_CONFIG, role === "task-runner" ? f.manifest.roles[role].configFile : undefined);
    }
    assert.equal((await lstat(runtime.statusFile)).mode & 0o777, 0o600); assert.ok(!JSON.stringify(status).includes("SECRET")); assert.ok(!JSON.stringify(status).includes(key(2)));
    const duplicate = await loadBackend(f.path); for (const role of roles) if (duplicate.manifest.roles[role].port) duplicate.manifest.roles[role].port! += 1;
    await assert.rejects(startBackend(duplicate), /BACKEND_LOCK_EXISTS/);
    await runtime.close(); assert.equal(await runtime.done, 0); stopped(children); await assert.rejects(lstat(join(f.manifest.runtimeDirectory, "backend.pid")), { code: "ENOENT" });
  } finally {
    await runtime?.close();
    for (const [name, value] of Object.entries({ ARENA_VERIFIER_PRIVATE_KEY: original.verifier, KIMI_API_KEY: original.model, NODE_OPTIONS: original.options })) { if (value === undefined) delete process.env[name]; else process.env[name] = value; }
    await f.close();
  }
});

test("a child exit closes all owned children and leaves an unrelated process alive", { timeout: 15000 }, async () => {
  const f = await fixture(), children = new Map<BackendRole, ChildProcess>(), unrelated = spawn(process.execPath, ["-e", "setInterval(()=>{},1000)"], { stdio: "ignore" });
  let runtime: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    runtime = await startBackend(await loadBackend(f.path), { launch: launcher(f.manifest, children), shutdownTimeoutMs: 100 });
    children.get("fixed-relay")!.kill("SIGTERM"); assert.equal(await runtime.done, 1); stopped(children);
    process.kill(unrelated.pid!, 0); assert.equal(JSON.parse(await readFile(runtime.statusFile, "utf8")).state, "failed");
  } finally { await runtime?.close(); const exited = once(unrelated, "exit"); unrelated.kill("SIGTERM"); await exited; await f.close(); }
});

test("startup exit and timeout clean prior children, and raw stderr never becomes the public error", { timeout: 15000 }, async () => {
  for (const behavior of ["fail", "hang"] as const) {
    const f = await fixture(), children = new Map<BackendRole, ChildProcess>();
    try {
      const loaded = await loadBackend(f.path); loaded.manifest.startupTimeoutMs = behavior === "hang" ? 250 : 2000;
      await assert.rejects(startBackend(loaded, { launch: launcher(f.manifest, children, ["fixed-relay", behavior]), shutdownTimeoutMs: 100 }), new RegExp(behavior === "hang" ? "BACKEND_STARTUP_TIMEOUT" : "BACKEND_CHILD_FAILED"));
      stopped(children); await assert.rejects(lstat(join(f.manifest.runtimeDirectory, "backend.pid")), { code: "ENOENT" });
      assert.ok(!(await readFile(join(f.manifest.runtimeDirectory, "status.json"), "utf8")).includes("FAKE_SECRET"));
    } finally { await f.close(); }
  }
});

test("supervisor signal during startup and a TERM-resistant child both get bounded cleanup", { timeout: 15000 }, async () => {
  const f = await fixture(), children = new Map<BackendRole, ChildProcess>();
  let runtime: Awaited<ReturnType<typeof startBackend>> | undefined;
  try {
    const loaded = await loadBackend(f.path), starting = startBackend(loaded, { launch: launcher(f.manifest, children, ["fixed-relay", "hang"]), shutdownTimeoutMs: 100 });
    while (!children.has("fixed-relay")) await delay(10);
    process.emit("SIGTERM"); await assert.rejects(starting, /BACKEND_CHILD_FAILED/); stopped(children);
    runtime = await startBackend(loaded, { launch: launcher(f.manifest, children, ["fixed-relay", "ignore"]), shutdownTimeoutMs: 100 });
    await runtime.close(); assert.equal(await runtime.done, 0); stopped(children); assert.equal(children.get("fixed-relay")!.signalCode, "SIGKILL");
  } finally { await runtime?.close(); await f.close(); }
});
