import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as reservePort } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, ContractFactory, JsonRpcProvider, keccak256, NonceManager, toUtf8Bytes, Wallet, ZeroAddress, type Signer } from "ethers";
import { AUTH_TYPES } from "../../underwriter/src/underwriter.js";
import { ArenaController } from "../src/controller.js";
import { ArenaSettler } from "../src/settler.js";
import { createArenaHttpServer } from "../src/http.js";
import { readControllerToken, requestSettlement } from "../src/ipc.js";
import { parseConfig, validateVerdict, type ArenaConfig, type Verdict } from "../src/protocol.js";
import { recoverStaleSettler } from "../src/recover.js";
import { submissionTypedData } from "../src/submission-auth.js";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const tx = async (contract: Contract, signer: Signer, method: string, args: unknown[] = [], overrides = {}) =>
  (await contract.connect(signer).getFunction(method)(...args, overrides)).wait();
const read = (contract: Contract, method: string, args: unknown[] = []) => contract.getFunction(method).staticCall(...args);
async function stop(child?: ChildProcess): Promise<void> {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), delay(2500).then(() => false)])) { child.kill("SIGKILL"); await exited; }
}
async function startAnvil() {
  const reservation = reservePort(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.env.ANVIL_BIN || "anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--accounts", "0", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let failure = "";
  child.stderr!.on("data", chunk => { failure += String(chunk).slice(0, 1000); });
  child.on("error", error => { failure = error.message; });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (failure || child.exitCode !== null) { await stop(child); throw new Error(`ANVIL_START_FAILED: ${failure}`); }
    try {
      const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(200) });
      if ((await response.json() as { result: string }).result === "0x7a69") return { rpc, child };
    } catch { /* Only wait for the local process we own. */ }
    await delay(50);
  }
  await stop(child); throw new Error("ANVIL_START_TIMEOUT");
}
async function startSettler(config: ArenaConfig, directory: string): Promise<ChildProcess> {
  const configFile = join(directory, "config.json");
  await writeFile(configFile, JSON.stringify(config), { mode: 0o600 });
  const child = spawn(process.execPath, ["--import", "tsx", new URL("../src/settler-main.ts", import.meta.url).pathname], {
    cwd: new URL("../../..", import.meta.url).pathname,
    env: { ...process.env, ARENA_CONFIG: configFile, ARENA_VERIFIER_PRIVATE_KEY: key(4) }, stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000);
      const finish = (error?: Error) => { clearTimeout(timer); if (error) reject(error); else resolve(); };
      child.stdout!.on("data", chunk => { if (String(chunk).includes('"ready":true')) finish(); });
      child.stderr!.on("data", chunk => { finish(new Error(`SETTLER_START_FAILED:${String(chunk).replaceAll(key(4), "[synthetic-key]").slice(0, 3000)}`)); });
      child.on("error", error => finish(error));
      child.once("exit", () => finish(new Error("SETTLER_EXITED")));
    });
    return child;
  } catch (error) { await stop(child); throw error; }
}

async function fixture(rpc: string, directory: string, erc20: boolean) {
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, pollingInterval: 20 });
  const adminWallet = new Wallet(key(1), provider); const agentWallet = new Wallet(key(2), provider);
  const admin = new NonceManager(adminWallet); const agent = new NonceManager(agentWallet);
  const underwriter = new Wallet(key(3)); const verifier = new Wallet(key(4)); const payee = new Wallet(key(5)).address;
  for (const wallet of [adminWallet, agentWallet, verifier]) await provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
  const deploy = async (name: string, args: unknown[] = []) => {
    const artifact = JSON.parse(await readFile(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    const deployed = await new ContractFactory(artifact.abi, artifact.bytecode.object, admin).deploy(...args); await deployed.waitForDeployment();
    return new Contract(await deployed.getAddress(), artifact.abi, provider);
  };
  const identity = await deploy("MockIdentityRegistry");
  const reputation = await deploy("MockReputationRegistry", [await identity.getAddress()]);
  const adapter = await deploy("ERC8004Adapter", [await identity.getAddress(), await reputation.getAddress(), adminWallet.address]);
  const token = erc20 ? await deploy("MockERC20", ["Test USDC", "USDC", 6]) : undefined;
  const asset = token ? await token.getAddress() : ZeroAddress;
  const manager = await deploy("CreditManager", [{ settlementAsset: asset, adapter: await adapter.getAddress(), underwriter: underwriter.address, treasury: adminWallet.address, guardian: adminWallet.address, relayRefunder: adminWallet.address, owner: adminWallet.address, maxLtvBps: 8000, grace: 3600 }]);
  const account = await deploy("AgentAccount", [asset, await adapter.getAddress(), adminWallet.address]);
  const escrow = await deploy("TaskEscrow", [asset, await adapter.getAddress(), verifier.address, adminWallet.address, 0, adminWallet.address]);
  await tx(manager, admin, "setProtocolContracts", [await account.getAddress(), await escrow.getAddress()]);
  await tx(account, admin, "setProtocolContracts", [await manager.getAddress(), await escrow.getAddress()]);
  await tx(escrow, admin, "setProtocolContracts", [await manager.getAddress(), await account.getAddress()]);
  await tx(adapter, admin, "setCreditManager", [await manager.getAddress()]);
  await tx(adapter, admin, "setReporter", [await escrow.getAddress(), true]);
  const unit = 10n ** BigInt(erc20 ? 6 : 18);
  await tx(manager, admin, "setGlobalLimits", [100n * unit, 100n * unit]);
  await tx(identity, admin, "registerFor", [agentWallet.address, agentWallet.address]);
  await tx(manager, admin, "enrollAgent", [1n]);
  await tx(account, agent, "setPolicy", [1n, { maxCashPerTx: unit, maxDebtPerTx: unit, maxDebtPerDay: 10n * unit, ownerFrozen: false }]);
  await tx(account, admin, "setProviderWhitelist", [payee, true]);
  if (token) {
    await tx(token, admin, "mint", [adminWallet.address, 100n * unit]);
    await tx(token, admin, "mint", [agentWallet.address, unit]);
    await tx(token, admin, "approve", [await manager.getAddress(), 2n ** 256n - 1n]);
    await tx(token, admin, "approve", [await escrow.getAddress(), 2n ** 256n - 1n]);
    await tx(token, agent, "approve", [await account.getAddress(), 2n ** 256n - 1n]);
  }
  await tx(manager, admin, "deposit", [10n * unit], token ? {} : { value: 10n * unit });
  await tx(account, agent, "depositCash", [1n, 4n * unit / 100n], token ? {} : { value: 4n * unit / 100n });
  const taskIds: string[] = [];
  for (let i = 0; i < 7; i++) {
    const now = (await provider.getBlock("latest"))!.timestamp;
    const receipt = await tx(escrow, admin, "createTask", [15n * unit / 100n, now + 172800], token ? {} : { value: 15n * unit / 100n });
    const event = receipt.logs.map((log: any) => { try { return escrow.interface.parseLog(log); } catch { return null; } }).find((event: any) => event?.name === "TaskCreated");
    const taskId = event.args.taskId.toString(); taskIds.push(taskId);
    // Last task remains Open, to test the signer's independent state gate.
    if (i !== 6) await tx(escrow, agent, "acceptTask", [taskId, 1n]);
  }
  const config = parseConfig({ rpcUrl: rpc, chainId: "31337", escrowAddress: await escrow.getAddress(), ipcDirectory: join(directory, "ipc"), allowManual: false,
    tasks: Object.fromEntries(taskIds.map(taskId => [taskId, { agentId: "1", problemId: "sum-integers" }])) });
  const draw = async (taskId: string, nonce: number) => {
    const now = (await provider.getBlock("latest"))!.timestamp;
    const auth = { agentId: "1", taskId, principalCap: 104347n * unit / 1000000n, feeBps: 1500, riskTier: 3, identityVersion: 1,
      authDeadline: now + 1800, loanDueAt: now + 86400, nonce, evidenceHash: keccak256(toUtf8Bytes(`arena-${taskId}`)) };
    const signature = await underwriter.signTypedData({ name: "InferCredit", version: "1", chainId: 31337, verifyingContract: await manager.getAddress() }, AUTH_TYPES, auth);
    await tx(account, agent, "payProvider", [1n, payee, 12n * unit / 100n, keccak256(toUtf8Bytes(`arena-payment-${taskId}`)), auth, signature]);
    assert.equal((await read(manager, "getLoan", [taskId])).status, 1n);
  };
  return { provider, admin, agentWallet, escrow, manager, account, reputation, config, unit, taskIds, draw };
}

test("strict config/verdict reject ambiguous numbers and uncontrolled tasks", () => {
  assert.throws(() => parseConfig({}), /INVALID_RPC_URL/);
  assert.throws(() => parseConfig({ rpcUrl: "http://localhost", chainId: 31337 }), /INVALID_CHAIN_ID/);
  const config = parseConfig({ rpcUrl: "http://localhost", chainId: "31337", escrowAddress: new Wallet(key(1)).address, ipcDirectory: "/tmp/arena-config-test", tasks: { "1": { agentId: "1", problemId: "sum-integers" } } });
  assert.equal(parseConfig({ ...config, tasks: { "1": { agentId: "0", problemId: "sum-integers" } } }).tasks["1"].agentId, "0");
  assert.equal(parseConfig({ ...config, settlementTimeoutMs: 180000 }).settlementTimeoutMs, 180000);
  for (const settlementTimeoutMs of [49, 300001, 50.5, "180000", null]) assert.throws(() => parseConfig({ ...config, settlementTimeoutMs }), /INVALID_SETTLEMENT_TIMEOUT/);
  const valid: Verdict = { version: 1, runId: "11111111-1111-1111-1111-111111111111", chainId: "31337", escrowAddress: config.escrowAddress, taskId: "1", agentId: "1", problemId: "sum-integers", passed: true, mode: "docker", evidenceHash: "0".repeat(64) };
  for (const [patch, error] of [[{ taskId: "2" }, "TASK_NOT_AUTHORIZED"], [{ agentId: "2" }, "TASK_NOT_AUTHORIZED"], [{ chainId: "10143" }, "DOMAIN_MISMATCH"], [{ passed: "true" }, "INVALID_VERDICT"], [{ mode: "manual" }, "MANUAL_DISABLED"]] as const) {
    assert.throws(() => validateVerdict({ ...valid, ...patch }, config), new RegExp(error));
  }
});

test("container startup timeout never settles failure or slashes an active task loan", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-startup-verdict-")), local = await startAnvil();
  let f: Awaited<ReturnType<typeof fixture>> | undefined, settler: ArenaSettler | undefined, controller: ArenaController | undefined;
  try {
    f = await fixture(local.rpc, directory, true);
    settler = new ArenaSettler(f.config, key(4), f.provider); await settler.start();
    await f.draw(f.taskIds[0], 1);
    const wrapper = join(directory, "docker-delayed");
    await writeFile(wrapper, '#!/bin/sh\nif [ "$1" = start ]; then sleep 1; fi\nexec docker "$@"\n', { mode: 0o700 });
    controller = new ArenaController(f.config, { dockerBin: wrapper, timeoutMs: 600, startupTimeoutMs: 100 }, f.provider);
    const loan = await read(f.manager, "getLoan", [f.taskIds[0]]);
    await assert.rejects(controller.submit({ taskId: f.taskIds[0], code: "import json,sys\nprint(sum(json.load(sys.stdin)))\n" }), /DOCKER_START_TIMEOUT/);
    assert.equal((await read(f.escrow, "getTask", [f.taskIds[0]])).status, 2n);
    assert.deepEqual(Array.from(await read(f.manager, "getLoan", [f.taskIds[0]])), Array.from(loan));
    await assert.rejects(stat(join(f.config.ipcDirectory, "settlements.json")), { code: "ENOENT" });
  } finally { controller?.close(); await settler?.close(); f?.provider.destroy(); await stop(local.child); await rm(directory, { recursive: true, force: true }); }
});

test("Arena borrowed RPC survives controller/HTTP/settler close and rejected startup", { timeout: 40_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-provider-"));
  let anvil: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let settler: ArenaSettler | undefined;
  let service: ReturnType<typeof createArenaHttpServer> | undefined;
  try {
    const local = await startAnvil(); anvil = local.child;
    f = await fixture(local.rpc, directory, true);
    const config = { ...f.config, rpcUrl: "http://127.0.0.1:1" };
    // Synthetic key only: exercise signer ownership without any public chain.
    const wrongSettler = new ArenaSettler({ ...config, chainId: "10143" }, key(4), f.provider);
    try { await assert.rejects(wrongSettler.start(), /NETWORK_MISMATCH/); }
    finally { await wrongSettler.close(); }
    settler = new ArenaSettler(config, key(4), f.provider);
    await settler.start();
    const noDocker = new ArenaController(config, { dockerBin: "/not-a-docker", timeoutMs: 700, maxOutputBytes: 1024 }, f.provider);
    try { await assert.rejects(noDocker.submit({ taskId: f.taskIds[0], code: "print(0)" }), { code: "ENOENT" }); }
    finally { noDocker.close(); }
    assert.equal(f.provider.destroyed, false);
    assert.equal(await f.provider.send("eth_chainId", []), "0x7a69");
    const ownedController = new ArenaController(f.config);
    ownedController.close();
    await assert.rejects(ownedController.submit({ taskId: f.taskIds[0], code: "print(0)" }), { code: "UNSUPPORTED_OPERATION" });
    const ownedSettler = new ArenaSettler(f.config, key(4));
    await ownedSettler.close();
    await assert.rejects(ownedSettler.start(), { code: "UNSUPPORTED_OPERATION" });

    service = createArenaHttpServer(config, [], f.provider);
    service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
    const url = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
    const input = { taskId: f.taskIds[0], code: "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n",
      deadline: String((await f.provider.getBlock("latest"))!.timestamp + 300), signature: "" };
    const typed = submissionTypedData(config, input);
    input.signature = await f.agentWallet.signTypedData(typed.domain, typed.types, typed.message);
    const submitted = await fetch(url + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    assert.equal(submitted.status, 202);
    const { runId } = await submitted.json() as { runId: string };
    let run: any;
    for (let i = 0; i < 100; i++) {
      run = await (await fetch(url + `/runs/${runId}`)).json();
      if (run.status !== "running") break;
      await delay(100);
    }
    assert.equal(run.status, "settled", JSON.stringify(run));
    assert.equal(run.result.tests.length, 5);
    assert.equal(run.result.verdict.passed, true);
    await service.close(); service = undefined;
    assert.equal(await f.provider.send("eth_chainId", []), "0x7a69");
    await settler.close(); settler = undefined;
    assert.equal(f.provider.destroyed, false);
    await assert.rejects(readFile(join(config.ipcDirectory, "controller.token")), { code: "ENOENT" });
    // The same HTTP/controller and signer connection can be reused after shutdown.
    settler = new ArenaSettler(config, key(4), f.provider);
    await settler.start();
    service = createArenaHttpServer(config, [], f.provider);
    service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
    const restartUrl = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
    const other = { ...input, taskId: f.taskIds[1], signature: "" };
    const otherTyped = submissionTypedData(config, other);
    other.signature = await new Wallet(key(6)).signTypedData(otherTyped.domain, otherTyped.types, otherTyped.message);
    const denied = await fetch(restartUrl + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(other) });
    assert.equal(denied.status, 403);
    assert.equal((await denied.json() as { error: string }).error, "SUBMISSION_SIGNER_MISMATCH");
  } finally {
    await service?.close(); await settler?.close();
    f?.provider.destroy(); await stop(anvil); await rm(directory, { recursive: true, force: true });
  }
});

test("settler polls only its persisted hash, rejects a noncanonical receipt and recovers with no second signature or broadcast", { timeout: 40000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-arena-receipt-"));
  let anvil: ChildProcess | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined, settler: ArenaSettler | undefined;
  try {
    const local = await startAnvil(); anvil = local.child; f = await fixture(local.rpc, directory, true);
    const config = { ...f.config, allowManual: true }; settler = new ArenaSettler(config, key(4), f.provider); await settler.start();
    const token = await readControllerToken(config.ipcDirectory), taskId = f.taskIds[0];
    const verdict: Verdict = { version: 1, runId: randomUUID(), chainId: config.chainId, escrowAddress: config.escrowAddress,
      taskId, agentId: "1", problemId: "sum-integers", passed: true, mode: "manual", evidenceHash: "0".repeat(64) };
    const nonce = await f.provider.getTransactionCount(new Wallet(key(4)).address);
    const send = f.provider.send.bind(f.provider), getReceipt = f.provider.getTransactionReceipt.bind(f.provider), getBlock = f.provider.getBlock.bind(f.provider);
    let broadcasts = 0, receiptQueries = 0, badCanonical = true, eventWaits = 0;
    f.provider.send = async (method, params) => { if (method === "eth_sendRawTransaction") broadcasts++; return send(method, params); };
    // Delay indexing once after broadcast; a missed block event must not matter.
    f.provider.getTransactionReceipt = async hash => { receiptQueries++; return receiptQueries <= 2 ? null : getReceipt(hash); };
    f.provider.waitForTransaction = async () => { eventWaits++; throw new Error("BLOCK_SUBSCRIPTION_MUST_NOT_BE_USED"); };
    f.provider.getBlock = async (...args) => {
      const block = await getBlock(...args);
      if (badCanonical && block) { badCanonical = false; return { ...block, hash: "0x" + "f".repeat(64) } as typeof block; }
      return block;
    };
    await assert.rejects(requestSettlement(config.ipcDirectory, token, verdict), /SETTLEMENT_NOT_CANONICAL/);
    const beforeRecovery = JSON.parse(await readFile(join(config.ipcDirectory, "settlements.json"), "utf8"))[taskId];
    assert.equal(beforeRecovery.settlement, undefined); assert.equal(keccak256(beforeRecovery.rawTx), beforeRecovery.txHash);
    assert.equal(broadcasts, 1); assert.equal(eventWaits, 0); assert.ok(receiptQueries >= 3);
    assert.equal(await f.provider.getTransactionCount(new Wallet(key(4)).address), nonce + 1);
    const recovered = await requestSettlement(config.ipcDirectory, token, verdict);
    assert.equal(recovered.txHash, beforeRecovery.txHash); assert.equal(recovered.passed, true);
    const afterRecovery = JSON.parse(await readFile(join(config.ipcDirectory, "settlements.json"), "utf8"))[taskId];
    assert.equal(afterRecovery.rawTx, beforeRecovery.rawTx); assert.equal(broadcasts, 1); assert.equal(eventWaits, 0);
    assert.equal(await f.provider.getTransactionCount(new Wallet(key(4)).address), nonce + 1);
    assert.equal((await read(f.escrow, "getTask", [taskId])).status, 3n);
  } finally { await settler?.close(); f?.provider.destroy(); await stop(anvil); await rm(directory, { recursive: true, force: true }); }
});

test("separate settler process consumes controller verdicts on real USDC/native Anvil contracts", { timeout: 180000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-arena-"));
  let anvil: ChildProcess | undefined;
  try {
    const local = await startAnvil(); anvil = local.child;
    for (const erc20 of [true, false]) await t.test(erc20 ? "USDC hidden tests repay/write feedback; malicious outputs liquidate" : "native asset preserves atomic settlement", async () => {
      const scenario = join(directory, erc20 ? "usdc" : "native");
      await import("node:fs/promises").then(fs => fs.mkdir(scenario));
      const f = await fixture(local.rpc, scenario, erc20);
      let signer: ChildProcess | undefined;
      // Exercise settlement semantics without racing Docker startup under full-suite load.
      const controller = new ArenaController(f.config, { timeoutMs: 3000, maxOutputBytes: 1024 });
      try {
        signer = await startSettler(f.config, scenario);
        assert.notEqual(signer.pid, process.pid);
        assert.equal(process.env.ARENA_VERIFIER_PRIVATE_KEY, undefined);
        assert.equal((await stat(f.config.ipcDirectory)).mode & 0o077, 0);
        assert.equal((await stat(join(f.config.ipcDirectory, "controller.token"))).mode & 0o077, 0);
        const token = await readControllerToken(f.config.ipcDirectory);
        await f.draw(f.taskIds[0], 1);
        const accepted = await controller.submit({ taskId: f.taskIds[0], code: "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n" });
        assert.equal(accepted.verdict.passed, true);
        assert.equal(accepted.tests.length, 5);
        assert.equal((await read(f.escrow, "getTask", [f.taskIds[0]])).status, 3n);
        assert.equal((await read(f.manager, "getLoan", [f.taskIds[0]])).status, 2n);
        assert.equal(await read(f.manager, "repaymentCount", [1n]), 1n);
        assert.equal(await read(f.account, "cash", [1n]), 58n * f.unit / 1000n);
        assert.equal(await read(f.reputation, "countFor", [1n, "task-success"]), 1n);
        assert.equal(await read(f.reputation, "countFor", [1n, "repayment"]), 1n);
        assert.deepEqual(accepted.settlement.feedback.slice(0, 2), [{ type: 1, sent: true, pending: false }, { type: 2, sent: true, pending: false }]);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, "f".repeat(64), accepted.verdict), /UNAUTHORIZED_CONTROLLER/);
        const replay = await requestSettlement(f.config.ipcDirectory, token, accepted.verdict);
        assert.equal(replay.txHash, accepted.settlement.txHash);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, token, { ...accepted.verdict, passed: false }), /TASK_ALREADY_SUBMITTED/);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, token, { ...accepted.verdict, chainId: "10143" }), /DOMAIN_MISMATCH/);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, token, { ...accepted.verdict, escrowAddress: new Wallet(key(6)).address }), /DOMAIN_MISMATCH/);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, token, { ...accepted.verdict, taskId: "999" }), /TASK_NOT_AUTHORIZED/);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, token, { ...accepted.verdict, taskId: f.taskIds[6] }), /TASK_NOT_ASSIGNED/);
        await assert.rejects(controller.manual({ taskId: f.taskIds[1], passed: true, reason: "manual approval" }), /MANUAL_DISABLED/);
        const mismatched = new ArenaController({ ...f.config, chainId: "10143" });
        try { await assert.rejects(mismatched.submit({ taskId: f.taskIds[1], code: "print(0)" }), /NETWORK_MISMATCH/); }
        finally { mismatched.close(); }
        await f.draw(f.taskIds[1], 2);
        const rejected = await controller.submit({ taskId: f.taskIds[1], code: "print('PASS')\n" });
        assert.equal(rejected.verdict.passed, false);
        assert.equal(rejected.tests[0].failure, "invalid-json");
        assert.equal((await read(f.escrow, "getTask", [f.taskIds[1]])).status, 4n);
        assert.equal((await read(f.manager, "getLoan", [f.taskIds[1]])).status, 3n);
        assert.equal(await read(f.manager, "totalOutstanding"), 0n);
        assert.equal(await read(f.manager, "defaultCount", [1n]), 1n);
        assert.equal(await read(f.reputation, "countFor", [1n, "default"]), 1n);
        assert.equal(await read(f.manager, "repaymentCount", [1n]), 1n);
        for (const [taskId, code, failure] of [
          [f.taskIds[2], "print(999)\n", "wrong-answer"],
          [f.taskIds[3], "while True: pass\n", "timeout"],
          [f.taskIds[4], "while True: print('x'*4096,flush=True)\n", "output-limit"],
        ]) {
          const result = await controller.submit({ taskId, code });
          assert.equal(result.verdict.passed, false);
          assert.equal(result.tests[0].failure, failure);
          assert.equal((await read(f.escrow, "getTask", [taskId])).status, 4n);
        }
        // Restart verifies durable idempotence and rotates the IPC capability.
        await assert.rejects(recoverStaleSettler(f.config.ipcDirectory), /SETTLER_IS_RUNNING/);
        const crashed = once(signer, "exit"); signer.kill("SIGKILL"); await crashed;
        await recoverStaleSettler(f.config.ipcDirectory);
        signer = await startSettler(f.config, scenario);
        const rotated = await readControllerToken(f.config.ipcDirectory);
        assert.notEqual(token, rotated);
        assert.equal((await requestSettlement(f.config.ipcDirectory, rotated, accepted.verdict)).txHash, accepted.settlement.txHash);
        await assert.rejects(requestSettlement(f.config.ipcDirectory, token, accepted.verdict), /UNAUTHORIZED_CONTROLLER/);
        const bytes = await readFile(join(f.config.ipcDirectory, "settlements.json"), "utf8");
        assert.ok(!bytes.includes(key(4)));
        assert.equal((await stat(join(f.config.ipcDirectory, "settlements.json"))).mode & 0o077, 0);
        // HTTP exposes submission only, rejects passed injection and unknown mappings.
        const service = createArenaHttpServer(f.config, ["http://127.0.0.1:3000"]);
        service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
        const http = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
        const post = (body: unknown) => fetch(http + "/submissions", { method: "POST", headers: { "content-type": "application/json", origin: "http://127.0.0.1:3000" }, body: JSON.stringify(body) });
        try {
          const catalog = await fetch(http + "/problems"); const publicData = await catalog.json();
          assert.equal(publicData.problems.length, 4); assert.ok(!JSON.stringify(publicData).includes("expected"));
          assert.equal((await fetch(http + "/problems", { headers: { origin: "https://evil.example" } })).status, 403);
          assert.equal((await post({ taskId: f.taskIds[5], code: "print(0)", passed: true })).status, 400);
          const valid: { taskId: string; code: string; deadline: string; signature: string } = {
            taskId: f.taskIds[5], code: "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n", deadline: String((await f.provider.getBlock("latest"))!.timestamp + 300), signature: "",
          };
          const typed = submissionTypedData(f.config, valid);
          valid.signature = await f.agentWallet.signTypedData(typed.domain, typed.types, typed.message);
          assert.equal((await post({ ...valid, taskId: "999" })).status, 403);
          assert.equal((await post({ ...valid, code: "print(0)" })).status, 403);
          const wrongWallet = new Wallet(key(6));
          assert.equal((await post({ ...valid, signature: await wrongWallet.signTypedData(typed.domain, typed.types, typed.message) })).status, 403);
          const wrongDomain = { ...typed.domain, chainId: "10143" };
          assert.equal((await post({ ...valid, signature: await f.agentWallet.signTypedData(wrongDomain, typed.types, typed.message) })).status, 403);
          assert.equal((await post({ ...valid, signature: await f.agentWallet.signTypedData({ ...typed.domain, verifyingContract: new Wallet(key(6)).address }, typed.types, typed.message) })).status, 403);
          const expired = { ...valid, deadline: String((await f.provider.getBlock("latest"))!.timestamp - 1) };
          const expiredTyped = submissionTypedData(f.config, expired);
          expired.signature = await f.agentWallet.signTypedData(expiredTyped.domain, expiredTyped.types, expiredTyped.message);
          assert.equal((await post(expired)).status, 400);
          assert.equal((await post({ ...valid, deadline: String((await f.provider.getBlock("latest"))!.timestamp + 301) })).status, 400);
          const start = await post(valid);
          assert.equal(start.status, 202); assert.equal(start.headers.get("access-control-allow-origin"), "http://127.0.0.1:3000");
          const runId = (await start.json()).runId;
          const retry = await post(valid); assert.equal(retry.status, 200); assert.equal((await retry.json()).runId, runId);
          assert.equal((await post({ ...valid, code: "print(0)" })).status, 409);
          let run: any;
          for (let i = 0; i < 100; i++) { run = await (await fetch(http + `/runs/${runId}`)).json(); if (run.status !== "running") break; await delay(100); }
          assert.equal(run.status, "settled", JSON.stringify(run));
          assert.equal(run.result.verdict.passed, true);
          assert.equal((await read(f.escrow, "getTask", [f.taskIds[5]])).status, 3n);
        } finally { await service.close(); }
        await stop(signer);
        const manualConfig = { ...f.config, allowManual: true };
        signer = await startSettler(manualConfig, scenario);
        const manualController = new ArenaController(manualConfig, { dockerBin: "/not-a-docker" });
        try {
          await tx(f.escrow, f.agentWallet, "acceptTask", [f.taskIds[6], 1n]);
          const manual = await manualController.manual({ taskId: f.taskIds[6], passed: true, reason: "Human inspected the local demonstration submission" });
          assert.equal(manual.verdict.mode, "manual"); assert.deepEqual(manual.tests, []);
          assert.equal((await read(f.escrow, "getTask", [f.taskIds[6]])).status, 3n);
        } finally { manualController.close(); }
      } finally { controller.close(); await stop(signer); f.provider.destroy(); }
    });
  } finally { await stop(anvil); await rm(directory, { recursive: true, force: true }); }
});
