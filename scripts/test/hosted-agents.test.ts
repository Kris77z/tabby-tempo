import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { chmod, lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as portServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { Wallet } from "ethers";
import test from "node:test";
import { loadHostedDaemonConfig } from "../hosted-agents.js";

const key = (n: number) => "0x" + n.toString(16).padStart(64, "0"), address = "0x" + "1".repeat(40), other = "0x" + "2".repeat(40), modelId = "kimi-k2.6";
const cli = promisify(execFile), cwd = resolve(import.meta.dirname, "../..");
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-hosted-cli-"))); let networkCalls = 0;
  const rpc = createServer((_request, response) => { networkCalls++; response.writeHead(500); response.end(); }); rpc.listen(0, "127.0.0.1"); await once(rpc, "listening");
  const rpcUrl = `http://127.0.0.1:${(rpc.address() as any).port}`;
  const listener = portServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening"); const port = (listener.address() as any).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const put = async (name: string, value: unknown) => { const path = join(directory, name); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  const deadlineMs = Date.now() + 240000, workflow = { agentId: "1", chainId: "31337", account: address, asset: address, escrowAddress: address,
    tasks: [{ taskId: "1", problemId: "sum-integers", deadlineMs, creditLimit: "80000" }], providers: [{ id: "fixed", payTo: address, relayUrl: "http://127.0.0.1:8788/v1/chat", service: "infercredit/solve-fixed", model: "pi-fixed-v1",
      routes: [{ tier: "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers"], solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128 } }] }],
    allowCredit: true, maxPrice: "120000", deadlineMs, minRemainingMs: 1000, maxCompletionTokens: 128 };
  const guardianKeyFile = await put("guardian.key", key(1)), rpcUrlFile = await put("rpc.txt", rpcUrl), sponsorKeyFile = await put("sponsor.key", key(4)), opponentKeyFile = await put("opponent.key", key(3)), modelKeyFile = await put("model.key", "FAKE_PRIVATE_MODEL_SENTINEL");
  const walletDirectory = join(directory, "wallet-locks");
  const task = { version: 1, identity: address, guardianKeyFile, rpcUrlFile, rpcTransport: "direct", publicRpcUrl: rpcUrl, walletDirectory, arenaUrl: "http://127.0.0.1:8789", underwriterUrl: "http://127.0.0.1:8787",
    models: [{ id: modelId, physicalModels: { cheap: modelId, strong: modelId }, templates: { conservative: workflow, balanced: workflow, aggressive: workflow } }] };
  const game = { version: 1, chainId: "31337", identity: address, account: address, token: address, publicRpcUrl: rpcUrl, rpcTransport: "direct", walletDirectory,
    sponsorKeyFile, opponent: { binding: { chainId: "31337", agentId: "2", wallet: new Wallet(key(3)).address }, keyFile: opponentKeyFile, modelId, strategy: "conservative" },
    models: [{ id: modelId, baseUrl: "https://api.moonshot.cn/v1", keyFile: modelKeyFile }], creditsDirectory: join(directory, "credits") };
  const taskConfigFile = await put("task.json", task), gameConfigFile = await put("game.json", game);
  const config = { version: 1, port, hosted: { directory: join(directory, "hosted"), origin: "http://127.0.0.1:3000", chainId: "31337", models: [{ id: modelId, label: "Kimi" }], maxAgentsPerOwner: 3, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" }, executor: { taskConfigFile, gameConfigFile } };
  const path = await put("hosted.json", config);
  return { directory, path, config, task, game, put, rpcUrl, calls: () => networkCalls,
    run: (args: string[] = []) => cli(process.execPath, ["--import", "tsx", "scripts/hosted-agents.ts", ...args], { cwd, env: { ...process.env, HOSTED_AGENTS_CONFIG: path }, timeout: 15000 }),
    close: async () => { await new Promise<void>(resolve => rpc.close(() => resolve())); await rm(directory, { recursive: true, force: true }); } };
}
test("CLI check validates actual adapters without any RPC, wallet or runtime creation", async () => {
  const f = await fixture();
  try {
    const loaded = await loadHostedDaemonConfig(f.path); assert.equal(loaded.task.models[0].id, modelId); assert.equal(loaded.game.models[0].id, modelId);
    const output = await f.run(); assert.deepEqual(JSON.parse(output.stdout), { service: "hosted-agents", checked: true }); assert.equal(output.stderr, "");
    assert.doesNotMatch(output.stdout, /FAKE_PRIVATE_MODEL_SENTINEL|rpc|keyFile|guardian|hosted\.json/); assert.equal(f.calls(), 0);
    for (const directory of [f.config.hosted.directory, f.task.walletDirectory, f.game.creditsDirectory]) await assert.rejects(lstat(directory), { code: "ENOENT" });
    for (const args of [["--recover"], ["--check", "--start"], ["--command", "/bin/sh"], ["--check", "--check"]])
      await assert.rejects(f.run(args), (error: any) => { assert.equal(error.stderr.trim(), "HOSTED_DAEMON_ARGUMENT_INVALID"); return true; });
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});
test("check rejects mismatched model/domain/RPC and insecure files without side effects", async () => {
  const f = await fixture();
  try {
    for (const [change, code] of [
      [{ ...f.config, hosted: { ...f.config.hosted, models: [{ id: "other", label: "Other" }] } }, "HOSTED_DAEMON_MODELS_MISMATCH"],
      [{ ...f.config, hosted: { ...f.config.hosted, chainId: "10143" } }, "HOSTED_DAEMON_DOMAIN_MISMATCH"],
      [{ ...f.config, command: "/bin/sh" }, "HOSTED_DAEMON_CONFIG_INVALID"],
      [{ ...f.config, port: 80 }, "HOSTED_DAEMON_CONFIG_INVALID"],
    ] as const) { await f.put("hosted.json", change); await assert.rejects(loadHostedDaemonConfig(f.path), { code }); }
    await f.put("hosted.json", f.config);
    for (const [change, code] of [
      [{ ...f.game, account: other }, "HOSTED_DAEMON_DOMAIN_MISMATCH"],
      [{ ...f.game, walletDirectory: join(f.directory, "different-lock") }, "HOSTED_DAEMON_DOMAIN_MISMATCH"],
      [{ ...f.game, publicRpcUrl: "http://127.0.0.1:2" }, "HOSTED_DAEMON_RPC_MISMATCH"],
    ] as const) { await f.put("game.json", change); await assert.rejects(loadHostedDaemonConfig(f.path), { code }); }
    await f.put("game.json", f.game); await chmod(f.path, 0o644); await assert.rejects(loadHostedDaemonConfig(f.path), { code: "HOSTED_DAEMON_PRIVATE_CONFIG_REQUIRED" }); await chmod(f.path, 0o600);
    assert.equal(f.calls(), 0);
    for (const directory of [f.config.hosted.directory, f.task.walletDirectory, f.game.creditsDirectory]) await assert.rejects(lstat(directory), { code: "ENOENT" });
  } finally { await f.close(); }
});
test("offline check rejects opponent/operator aliases but permits shared operator keys", async () => {
  const f = await fixture();
  try {
    await f.put("game.json", { ...f.game, sponsorKeyFile: f.task.guardianKeyFile }); await loadHostedDaemonConfig(f.path);
    const bot = { ...f.game.opponent, keyFile: f.task.guardianKeyFile, binding: { ...f.game.opponent.binding, wallet: new Wallet(key(1)).address } };
    await f.put("game.json", { ...f.game, opponent: bot });
    await assert.rejects(loadHostedDaemonConfig(f.path), { code: "HOSTED_DAEMON_OPPONENT_OPERATOR_COLLISION" });
    const gasSponsorKeyFile = await f.put("gas-sponsor.key", key(5)), task = { ...f.task, gasGrantWei: "1000000000000000", gasSponsorBudgetWei: "5000000000000000", gasSponsorKeyFile };
    await f.put("task.json", task); await f.put("game.json", { ...f.game, opponent: { ...f.game.opponent, keyFile: gasSponsorKeyFile, binding: { ...f.game.opponent.binding, wallet: new Wallet(key(5)).address } } });
    await assert.rejects(loadHostedDaemonConfig(f.path), { code: "HOSTED_DAEMON_OPPONENT_OPERATOR_COLLISION" });
    await f.put("task.json", { ...task, gasSponsorKeyFile: f.task.guardianKeyFile }); await f.put("game.json", { ...f.game, sponsorKeyFile: f.task.guardianKeyFile }); await loadHostedDaemonConfig(f.path);
    await f.put("game.json", { ...f.game, opponent: { ...f.game.opponent, keyFile: f.game.sponsorKeyFile, binding: { ...f.game.opponent.binding, wallet: new Wallet(key(4)).address } } });
    await assert.rejects(loadHostedDaemonConfig(f.path), { code: "HOSTED_GAME_KEY_BINDING_MISMATCH" });
    assert.equal(f.calls(), 0);
    for (const directory of [f.config.hosted.directory, f.task.walletDirectory, f.game.creditsDirectory]) await assert.rejects(lstat(directory), { code: "ENOENT" });
  } finally { await f.close(); }
});
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const ended = once(child, "exit"); child.kill("SIGTERM");
  await Promise.race([ended, delay(10000, undefined, { ref: false }).then(() => { child.kill("SIGKILL"); throw new Error("HOSTED_TEST_SHUTDOWN_TIMEOUT"); })]);
}
test("actual CLI starts loopback, remains idle, rejects a second daemon and releases its lock on signal", async () => {
  const f = await fixture(); let child: ChildProcess | undefined;
  try {
    child = spawn(process.execPath, ["--import", "tsx", "scripts/hosted-agents.ts", "--start"], { cwd, env: { ...process.env, HOSTED_AGENTS_CONFIG: f.path }, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "", stderr = ""; child.stdout!.on("data", part => { stdout += part; }); child.stderr!.on("data", part => { stderr += part; });
    const until = Date.now() + 10000; while (!stdout.includes("\n")) { assert.equal(child.exitCode, null, stderr); if (Date.now() >= until) throw new Error("HOSTED_TEST_START_TIMEOUT"); await delay(25); }
    assert.deepEqual(JSON.parse(stdout.trim()), { ready: true, service: "hosted-agents", host: "127.0.0.1", port: f.config.port }); assert.equal(stderr, "");
    assert.equal(f.calls(), 0); assert.doesNotMatch(stdout + stderr, /FAKE_PRIVATE_MODEL_SENTINEL|keyFile|rpcUrl/);
    const snapshot = await fetch(`http://127.0.0.1:${f.config.port}/agents`); assert.equal(snapshot.status, 401); assert.equal(f.calls(), 0);
    await assert.rejects(f.run(["--start"]), (error: any) => { assert.match(error.stderr.trim(), /^HOSTED_[A-Z_]+$/); assert.doesNotMatch(error.stderr, /FAKE_PRIVATE_MODEL_SENTINEL|0x|rpc/); return true; });
    await stop(child); assert.equal(child.exitCode, 0); assert.equal(stderr, "");
    await assert.rejects(lstat(join(f.config.hosted.directory, "database", ".writer")), { code: "ENOENT" });
    const database = await readFile(join(f.config.hosted.directory, "database", "session.json"), "utf8"); assert.deepEqual(JSON.parse(database).agents, []);
  } finally { if (child) await stop(child); await f.close(); }
});
