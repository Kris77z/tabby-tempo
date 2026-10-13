import test from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { lstat, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createServer as netServer } from "node:net";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { parseTaskRunnerSnapshot } from "@agentfuel/pi-loop/task-runner";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../services/underwriter/test/fixture.js";
import type { BackendManifest } from "../backend.js";

const syntheticCode = "import json, sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n";
test("actual five backend entrypoints complete HTTP credit workflow and duplicate UUID consumes nothing", { timeout: 120000 }, async () => {
  await new DockerExecutor().ready();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-backend-stack-"))), ipc = await realpath(await mkdtemp("/tmp/af-bs-ipc-"));
  const local = await startAnvil(), agentWallet = Wallet.createRandom();
  const walletDirectory = join(homedir(), ".config", "agentfuel", "pi-task-wallets", agentWallet.address.toLowerCase());
  let f: Awaited<ReturnType<typeof fixture>> | undefined, fixtureClosed = false, walletOwned = false, provider: JsonRpcProvider | undefined, backend: ChildProcess | undefined;
  let modelCalls = 0;
  const modelRequests: Record<string, any>[] = [], model = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); modelCalls++; modelRequests.push(body);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: "synthetic-local-backend-stack-only", synthetic: true, model: body.model,
      choices: [{ message: { role: "assistant", content: null, tool_calls: [{ id: "synthetic-public-sample", type: "function",
        function: { name: "test_public_sample", arguments: JSON.stringify({ code: syntheticCode }) } }] }, finish_reason: "tool_calls" }],
      usage: { prompt_tokens: 10, completion_tokens: 10, total_tokens: 20 } }));
  });
  const put = async (name: string, value: object | string) => { const path = join(directory, name); await writeFile(path, typeof value === "string" ? value : JSON.stringify(value), { mode: 0o600 }); return path; };
  const env = (name: string, values: Record<string, string>) => put(`${name}.env`, Object.entries(values).map(([key, value]) => `${key}='${value}'`).join("\n"));
  const stopBackend = async () => {
    if (!backend?.pid || backend.exitCode !== null || backend.signalCode !== null) return;
    const exited = once(backend, "exit"); backend.kill("SIGTERM");
    if (!await Promise.race([exited.then(() => true), delay(15000, undefined, { ref: false }).then(() => false)])) { backend.kill("SIGKILL"); await exited; }
  };
  try {
    await assert.rejects(lstat(walletDirectory), { code: "ENOENT" });
    walletOwned = true;
    model.listen(0, "127.0.0.1"); await once(model, "listening"); const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    f = await fixture(local.rpc, join(directory, "old-underwriter"), 6, { refunderKey: key(4) });
    const agent = new NonceManager(agentWallet.connect(f.provider));
    await f.provider.send("anvil_setBalance", [agentWallet.address, "0x3635c9adc5dea00000"]);
    await f.provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]);
    const registration = await tx(f.identity, f.admin, "registerFor", [agentWallet.address, agentWallet.address]);
    const agentId = registration.logs.map((log: any) => { try { return f!.identity.interface.parseLog(log); } catch { return null; } }).find((event: any) => event?.name === "Registered").args.agentId.toString();
    await tx(f.manager, f.admin, "enrollAgent", [agentId]);
    await tx(f.account, agent, "setPolicy", [agentId, { maxCashPerTx: f.unit, maxDebtPerTx: f.unit, maxDebtPerDay: 10n * f.unit, ownerFrozen: false }]);
    await tx(f.token!, f.admin, "mint", [agentWallet.address, f.unit]); await tx(f.token!, agent, "approve", [await f.account.getAddress(), f.unit]);
    await tx(f.account, agent, "depositCash", [agentId, 40000n]);
    const now = (await f.provider.getBlock("latest"))!.timestamp, created = await tx(f.escrow, f.admin, "createTask", [150000n, now + 600]);
    const taskId = created.logs.map((log: any) => { try { return f!.escrow.interface.parseLog(log); } catch { return null; } }).find((event: any) => event?.name === "TaskCreated").args.taskId.toString();
    const taskDeadlineMs = Number((await read(f.escrow, "getTask", [taskId])).deadline) * 1000;
    const addresses = { account: await f.account.getAddress(), manager: await f.manager.getAddress(), escrow: await f.escrow.getAddress(), asset: f.config.settlementAsset };
    const servers = Array.from({ length: 4 }, () => netServer());
    for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
    const [underwriterPort, relayPort, arenaPort, runnerPort] = servers.map(server => (server.address() as { port: number }).port);
    await Promise.all(servers.map(server => new Promise<void>(done => server.close(() => done()))));
    const underwriterUrl = `http://127.0.0.1:${underwriterPort}`, relayUrl = `http://127.0.0.1:${relayPort}/v1/chat`, arenaUrl = `http://127.0.0.1:${arenaPort}`;
    const arenaConfig = await put("arena.json", { rpcUrl: local.rpc, chainId: "31337", escrowAddress: addresses.escrow, ipcDirectory: ipc, tasks: { [taskId]: { agentId, problemId: "sum-integers" } } });
    const deadlineMs = Date.now() + 240000;
    const workflowConfigFile = await put("workflow.json", { agentId, chainId: "31337", account: addresses.account, asset: addresses.asset, escrowAddress: addresses.escrow,
      tasks: [{ taskId, problemId: "sum-integers", deadlineMs: taskDeadlineMs, creditLimit: "80000" }], providers: [{ id: "synthetic-fixed", payTo: f.payee, relayUrl,
        service: "infercredit/solve-fixed", model: "pi-fixed-v1", routes: [{ tier: "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers"],
          solve: { version: 1, tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128 } }] }],
      allowCredit: true, maxPrice: "120000", deadlineMs, minRemainingMs: 1000, maxCompletionTokens: 128 });
    const runnerConfig = await put("runner.json", { version: 1, dataDirectory: join(directory, "runner-data"), port: runnerPort, wallet: agentWallet.address,
      keyFile: await put("synthetic-agent.key", agentWallet.privateKey), profiles: [{ id: "sum-credit", label: "Synthetic local stack only", workflowConfigFile,
        rpcUrlFile: await put("rpc-url", local.rpc), rpcTransport: "direct", arenaUrl, underwriterUrl }] });
    const manifest: BackendManifest = { version: 1, runtimeDirectory: join(directory, "runtime"), startupTimeoutMs: 30000, roles: {
      underwriter: { port: underwriterPort, envFile: await env("underwriter", { RPC_URL: local.rpc, CHAIN_ID: "31337", MANAGER_ADDRESS: addresses.manager,
        SETTLEMENT_ASSET: addresses.asset, ASSET_DECIMALS: "6", UNDERWRITER_PRIVATE_KEY: key(3), EVIDENCE_DIR: join(directory, "underwriter") }) },
      "fixed-relay": { port: relayPort, envFile: await env("relay", { RPC_URL: local.rpc, CHAIN_ID: "31337", ACCOUNT_ADDRESS: addresses.account, PROVIDER_ADDRESS: f.payee,
        SETTLEMENT_ASSET: addresses.asset, ASSET_DECIMALS: "6", SERVICE_ID: "infercredit/solve-fixed", LOGICAL_MODEL: "pi-fixed-v1", PRICE: "120000", DATA_DIR: join(directory, "relay"),
        REFUNDER_PRIVATE_KEY: key(4), OPERATOR_TOKEN: "synthetic-local-operator-token-only-0123456789", SYNTHETIC_MODEL_KEY: "synthetic-local-model-only",
        UPSTREAMS_JSON: JSON.stringify(["cheap", "strong"].map(name => ({ name, model: `synthetic-${name}`, baseUrl: modelUrl, keyEnv: "SYNTHETIC_MODEL_KEY" }))) }) },
      settler: { configFile: arenaConfig, envFile: await env("settler", { ARENA_VERIFIER_PRIVATE_KEY: key(1) }) },
      arena: { port: arenaPort, configFile: arenaConfig, envFile: await env("arena", {}) },
      "task-runner": { port: runnerPort, configFile: runnerConfig, envFile: await env("task-runner", {}) },
    } };
    const manifestPath = await put("backend.json", manifest);
    await f.close(); fixtureClosed = true;
    provider = new JsonRpcProvider(local.rpc, undefined, { cacheTimeout: -1, pollingInterval: 20 });
    const account = new Contract(addresses.account, f.account.interface, provider), manager = new Contract(addresses.manager, f.manager.interface, provider), escrow = new Contract(addresses.escrow, f.escrow.interface, provider);
    const token = new Contract(addresses.asset, f.token!.interface, provider);
    const verifier = new Wallet(key(1)).address;
    const before = { nonce: await provider.getTransactionCount(agentWallet.address), verifierNonce: await provider.getTransactionCount(verifier), cash: await read(account, "cash", [agentId]), payee: await read(token, "balanceOf", [f.payee]) };
    assert.deepEqual([before.cash, before.payee], [40000n, 0n]); assert.equal((await read(escrow, "getTask", [taskId])).status, 1n);
    backend = spawn(process.execPath, ["--import", "tsx", "scripts/backend.ts", "--manifest", manifestPath, "--start"], {
      cwd: resolve(import.meta.dirname, "../.."), env: { PATH: process.env.PATH, HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "production" }, stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "", stderr = ""; backend.stdout!.on("data", chunk => { stdout += String(chunk); }); backend.stderr!.on("data", chunk => { stderr += String(chunk); });
    const started = Date.now();
    while (!stdout.split("\n").some(line => { try { return JSON.parse(line).service === "backend" && JSON.parse(line).ready; } catch { return false; } })) {
      if (backend.exitCode !== null || backend.signalCode !== null) throw new Error(`STACK_START_FAILED:${/^BACKEND_[A-Z_]+\s*$/.test(stderr) ? stderr.trim() : "SAFE_LOG_UNAVAILABLE"}`);
      assert.ok(Date.now() - started < 60000, "Actual backend CLI must reach ready"); await delay(100);
    }
    const status = JSON.parse(await readFile(join(manifest.runtimeDirectory, "status.json"), "utf8"));
    assert.equal(status.state, "running"); assert.equal(Object.keys(status.roles).length, 5); for (const role of Object.values(status.roles) as any[]) assert.equal(role.state, "ready"); assert.equal(modelCalls, 0);
    const url = `http://127.0.0.1:${runnerPort}/api/tasks/runs`, requestId = randomUUID();
    const command = () => fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ action: "start", requestId, profileId: "sum-credit" }), signal: AbortSignal.timeout(10000) });
    const admitted = await command(); assert.equal(admitted.status, 202); assert.equal(parseTaskRunnerSnapshot(await admitted.json()).run!.requestId, requestId);
    let result: ReturnType<typeof parseTaskRunnerSnapshot> | undefined; const until = Date.now() + 60000;
    do {
      const response = await fetch(url + `?requestId=${requestId}`, { signal: AbortSignal.timeout(10000) }); assert.equal(response.status, 200); result = parseTaskRunnerSnapshot(await response.json());
      if (!["Queued", "Running"].includes(result.run!.status)) break; await delay(100);
    } while (Date.now() < until);
    assert.equal(result!.run!.status, "Succeeded", JSON.stringify(result)); assert.equal(result!.run!.workflow!.choice!.funding, "task-credit");
    assert.equal(modelCalls, 1); assert.equal(modelRequests[0].model, "synthetic-cheap"); assert.equal(modelRequests[0].max_completion_tokens, 128);
    const workflow = JSON.parse(await readFile(join(directory, "runner-data", "runs", requestId, "session.json"), "utf8"));
    assert.deepEqual([workflow.finance.fromCash, workflow.finance.fromCredit, workflow.finance.repaid, workflow.finance.residual], ["40000", "80000", "92000", "58000"]);
    assert.deepEqual(workflow.child.submission.result.tests, Array.from({ length: 5 }, (_, index) => ({ case: index + 1, passed: true })));
    const paymentReceipt = await provider.getTransactionReceipt(workflow.child.inference.receipt.txHash), settlement = JSON.parse(await readFile(join(ipc, "settlements.json"), "utf8"))[taskId];
    assert.equal(paymentReceipt!.status, 1); assert.equal(paymentReceipt!.logs.filter(log => { try { return account.interface.parseLog(log)?.name === "ProviderPaid"; } catch { return false; } }).length, 1);
    assert.equal(paymentReceipt!.logs.filter(log => { try { return manager.interface.parseLog(log)?.name === "LoanOpened"; } catch { return false; } }).length, 1);
    const paid = paymentReceipt!.logs.map(log => { try { return account.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === "ProviderPaid")!;
    const opened = paymentReceipt!.logs.map(log => { try { return manager.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === "LoanOpened")!;
    assert.deepEqual([paid.args.agentId, paid.args.fromCash, paid.args.fromCredit, opened.args.taskId, opened.args.amount], [BigInt(agentId), 40000n, 80000n, BigInt(taskId), 80000n]);
    assert.equal(settlement.settlement.passed, true); assert.equal(settlement.verdict.mode, "docker");
    const settledReceipt = await provider.getTransactionReceipt(settlement.txHash); assert.equal(settledReceipt!.status, 1);
    const repaid = settledReceipt!.logs.map(log => { try { return manager.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === "LoanRepaid")!;
    assert.deepEqual([repaid.args.taskId, repaid.args.principal, repaid.args.fee], [BigInt(taskId), 80000n, 12000n]);
    assert.equal((await read(escrow, "getTask", [taskId])).status, 3n); assert.equal((await read(manager, "getLoan", [taskId])).status, 2n);
    assert.equal(await read(escrow, "feedbackSent", [taskId, 1]), true); assert.equal(await read(escrow, "feedbackSent", [taskId, 2]), true);
    const after = { nonce: await provider.getTransactionCount(agentWallet.address), verifierNonce: await provider.getTransactionCount(verifier), cash: await read(account, "cash", [agentId]), payee: await read(token, "balanceOf", [f.payee]), outstanding: await read(manager, "totalOutstanding") };
    assert.deepEqual(after, { nonce: before.nonce + 2, verifierNonce: before.verifierNonce + 1, cash: 58000n, payee: 120000n, outstanding: 0n });
    for (const secret of [agentWallet.privateKey, key(1), key(3), key(4), syntheticCode, "rawTransaction", "keyFile", directory]) assert.ok(!JSON.stringify(result).includes(secret));
    assert.ok(!stdout.includes(agentWallet.privateKey)); assert.ok(!stderr.includes(agentWallet.privateKey));
    const duplicate = await command(); assert.equal(duplicate.status, 202); assert.equal(parseTaskRunnerSnapshot(await duplicate.json()).run!.status, "Succeeded"); await delay(200);
    assert.equal(modelCalls, 1); assert.equal(await provider.getTransactionCount(agentWallet.address), after.nonce); assert.equal(await provider.getTransactionCount(verifier), after.verifierNonce); assert.equal(await read(account, "cash", [agentId]), after.cash); assert.equal(await read(token, "balanceOf", [f.payee]), after.payee);
    await stopBackend(); assert.equal(backend.exitCode, 0);
    for (const role of Object.values(status.roles) as any[]) assert.throws(() => process.kill(role.pid, 0), /ESRCH/);
    await assert.rejects(lstat(join(manifest.runtimeDirectory, "backend.pid")), { code: "ENOENT" }); await assert.rejects(lstat(join(ipc, "settler.owner")), { code: "ENOENT" });
  } finally {
    await stopBackend(); if (!fixtureClosed) await f?.close(); provider?.destroy();
    if (model.listening) { model.closeAllConnections(); await new Promise<void>(done => model.close(() => done())); }
    await stopAnvil(local.child); if (walletOwned) await rm(walletDirectory, { recursive: true, force: true }); await rm(directory, { recursive: true, force: true }); await rm(ipc, { recursive: true, force: true });
  }
});
