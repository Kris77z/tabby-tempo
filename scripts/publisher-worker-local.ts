import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { copyFile, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { Contract, Wallet } from "ethers";
import { DockerExecutor, DEFAULT_IMAGE } from "../services/arena/src/docker.js";
import { createArenaHttpServer } from "../services/arena/src/http.js";
import { parseConfig } from "../services/arena/src/protocol.js";
import { FixedPriceSolvingRelay, FixedPriceRefunder } from "../services/provider-relay/src/fixed-price.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../services/underwriter/test/fixture.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2), onlineInstall = args.includes("--online-install");
if (args.some(arg => arg !== "--online-install")) throw new Error("INVALID_PRIVATE_HARNESS_ARGUMENTS");
const baseEnv = { PATH: process.env.PATH!, TMPDIR: process.env.TMPDIR ?? "/tmp", HOME: process.env.HOME!, npm_config_workspaces: "false",
  ...(process.env.npm_config_cache ? { npm_config_cache: process.env.npm_config_cache } : {}) };
const runFile = promisify(execFile);
const directory = process.env.AF_PW_DIRECTORY!, ipc = process.env.AF_PW_IPC!, privateReport = process.env.AF_PW_PRIVATE_REPORT!;
if (!directory || !ipc || !privateReport) throw new Error("LAUNCH_WITH_CHECK_PUBLISHER_WORKER");
const consumer = join(directory, "consumer");
let local: Awaited<ReturnType<typeof startAnvil>> | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined;
let settler: ChildProcess | undefined, arena: ReturnType<typeof createArenaHttpServer> | undefined;
let relay: FixedPriceSolvingRelay | undefined, relayServer: ReturnType<typeof createHttpServer> | undefined;
let resultReport: Record<string, unknown> = { version: 1, suite: "local-publisher-worker", status: "failed", error: "NOT_STARTED" };
let stage = "consumer";
const json = (value: unknown) => JSON.stringify(value, (_, item) => typeof item === "bigint" ? String(item) : item);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const consumerFiles = ["README.md", "package.json", "package-lock.json", "protocol.mjs", "durable.mjs", "publisher.mjs", "admit.mjs", "worker.mjs", "test/protocol.test.mjs"];
const consumerSha256: Record<string, string> = {};
async function save(name: string, value: unknown) { await writeFile(join(directory, name), json(value), { mode: 0o600 }); return join(directory, name); }
async function role(script: string, argv: string[], secret: Record<string, string> = {}) {
  try {
    const result = await runFile(process.execPath, [join(consumer, script), ...argv], { cwd: consumer, env: { ...baseEnv, ...secret }, timeout: 180000, maxBuffer: 1024 * 1024 });
    return JSON.parse(result.stdout.trim().split("\n").at(-1)!);
  } catch (error) {
    const detail = error as { stderr?: string; code?: string; signal?: string };
    const code = detail.stderr?.trim().split("\n").reverse().find(line => /^[A-Z_]{1,100}$/.test(line));
    if (detail.stderr?.includes("Detected unsettled top-level await")) throw new Error("UNSETTLED_ROLE_AWAIT");
    if (error instanceof SyntaxError) throw new Error("ROLE_OUTPUT_INVALID_JSON");
    throw new Error(code ?? (typeof detail.code === "string" && /^[A-Z_]{1,100}$/.test(detail.code) ? detail.code : "EXTERNAL_ROLE_FAILED"));
  }
}
async function rejected(script: string, argv: string[], code: RegExp, secret: Record<string, string> = {}) {
  await assert.rejects(role(script, argv, secret), code);
}
async function port() {
  const server = createServer(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const number = (server.address() as { port: number }).port;
  await new Promise<void>(done => server.close(() => done())); return number;
}
function parseEvents(receipt: any, contract: Contract, name: string) {
  return receipt.logs.filter((log: any) => log.address.toLowerCase() === String(contract.target).toLowerCase()).map((log: any) => {
    try { return contract.interface.parseLog(log); } catch { return null; }
  }).filter((event: any) => event?.name === name);
}
async function canonical(hash: string, sender: string, target: string) {
  const receipt = await f!.provider.getTransactionReceipt(hash), transaction = await f!.provider.getTransaction(hash);
  assert.ok(receipt); assert.equal(receipt.status, 1); assert.equal((await f!.provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash);
  assert.equal(transaction!.from.toLowerCase(), sender.toLowerCase()); assert.equal(transaction!.to!.toLowerCase(), target.toLowerCase()); return receipt;
}

try {
  process.stderr.write("publisher-worker: building isolated consumer\n");
  execFileSync("forge", ["build", "--root", "contracts", "--skip-lint"], { cwd: root, env: baseEnv, stdio: "ignore", timeout: 90000 });
  execFileSync(process.execPath, [join(root, "packages/sdk/scripts/pack.mjs"), "--out-dir", directory], { cwd: root, env: baseEnv, stdio: "ignore", timeout: 60000 });
  for (const name of consumerFiles) {
    const destination = join(consumer, name); await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, "examples/publisher-worker", name), destination);
    consumerSha256[name] = sha(await readFile(destination));
  }
  try {
    execFileSync("npm", ["install", ...(onlineInstall ? [] : ["--offline"]), "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", join(directory, "agentfuel-sdk-0.0.0.tgz")], { cwd: consumer, env: baseEnv, stdio: "ignore", timeout: 60000 });
  } catch { throw new Error("DEPENDENCY_ARCHIVES_MISSING"); }
  const installed = await realpath(join(consumer, "node_modules/@agentfuel/sdk"));
  assert.ok(!relative(await realpath(consumer), installed).startsWith(".."));
  const distribution = JSON.parse(await readFile(join(installed, "package.json"), "utf8"));
  assert.equal(distribution.exports["."].import, "./dist/index.js");
  execFileSync("npm", ["test"], { cwd: consumer, env: baseEnv, stdio: "ignore", timeout: 60000 });
  process.stderr.write("publisher-worker: starting isolated anvil lifecycle\n");

  local = await startAnvil(); f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
  stage = "infrastructure";
  const publisher = new Wallet(key(11), f.provider), worker = new Wallet(key(2), f.provider), verifier = new Wallet(key(13), f.provider);
  assert.equal(new Set([publisher.address, worker.address, verifier.address, f.payee]).size, 4);
  for (const wallet of [publisher, verifier, new Wallet(key(4))]) await f.provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
  await tx(f.token!, f.admin, "mint", [publisher.address, 150000n]);
  await tx(f.escrow, f.admin, "setVerifier", [verifier.address]);
  const arenaPort = await port(); let modelCalls = 0;
  const relayConfig: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
    service: { id: "infercredit/solve-fixed", model: "pi-fixed-v1", price: 120000n, upstreams: [
      { name: "cheap", model: "controlled-cheap", baseUrl: "https://cheap.invalid/v1", key: "synthetic" },
      { name: "strong", model: "controlled-strong", baseUrl: "https://strong.invalid/v1", key: "synthetic" }] },
    dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 3000, host: "127.0.0.1", port: 0, refunderKey: key(4) };
  relay = new FixedPriceSolvingRelay(relayConfig, { provider: f.provider, runner: new DockerExecutor({ image: DEFAULT_IMAGE }), modelFetch: async (_url, init) => {
    modelCalls++; const body = JSON.parse(String(init?.body)); assert.equal(modelCalls, 1);
    return Response.json({ model: body.model, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "external_sample_call", type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code: "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n" }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
  } });
  await relay.initialize(); const refunder = new FixedPriceRefunder(relay); await refunder.initialize();
  relayServer = createHttpServer(relay, refunder); relayServer.listen(0, "127.0.0.1"); await once(relayServer, "listening");
  const config = { version: 1, chainId: "31337", rpcUrl: local.rpc, escrow: await f.escrow.getAddress(), account: await f.account.getAddress(), asset: f.config.settlementAsset,
    verifier: verifier.address, poster: publisher.address, provider: f.payee, agentId: "1", maxPrice: "120000", maxBorrowFeeBps: "1500", minimumProfit: "10000",
    underwriterUrl: f.http, relayUrl: `http://127.0.0.1:${(relayServer.address() as { port: number }).port}/v1/chat`, arenaUrl: `http://127.0.0.1:${arenaPort}`, solveDeadlineMs: Date.now() + 240000 };
  const configFile = await save("deployment.json", config), publisherJournal = join(directory, "publisher.private.json"), manifestFile = join(directory, "publication.json");
  const request = { version: 1, requestId: "0x" + "a1".repeat(32), problemId: "sum-integers", reward: "150000", deadline: String((await f.provider.getBlock("latest"))!.timestamp + 1800) };
  const requestFile = await save("request.json", request), publisherArgs = [configFile, requestFile, publisherJournal, manifestFile];
  const beforePublish = { nextTaskId: String(await f.escrow.nextTaskId()), balance: String(await f.token!.balanceOf(publisher.address)) };
  stage = "publication";
  const publication = await role("publisher.mjs", publisherArgs, { PUBLISHER_PRIVATE_KEY: key(11) });
  assert.equal(publication.state, "Published"); const taskId = publication.taskId;
  const manifest = JSON.parse(await readFile(manifestFile, "utf8"));
  const createReceipt = await canonical(publication.txHash, publisher.address, config.escrow);
  assert.equal(parseEvents(createReceipt, f.escrow, "TaskCreated").length, 1);
  assert.equal(String((await f.escrow.getTask(taskId)).escrowBalance), "150000");
  assert.equal(String(await f.token!.balanceOf(publisher.address)), "0");
  assert.equal(String(await f.escrow.nextTaskId()), String(BigInt(beforePublish.nextTaskId) + 1n));
  // Drop only the derived manifest from the private journal to simulate lost acknowledgement after mining.
  const privatePublication = JSON.parse(await readFile(publisherJournal, "utf8")); delete privatePublication.manifest;
  await writeFile(publisherJournal, json(privatePublication), { mode: 0o600 });
  const publisherNonce = await f.provider.getTransactionCount(publisher.address);
  assert.deepEqual(await role("publisher.mjs", publisherArgs, { PUBLISHER_PRIVATE_KEY: key(11) }), publication);
  assert.equal(await f.provider.getTransactionCount(publisher.address), publisherNonce);
  assert.equal(String(await f.escrow.nextTaskId()), String(BigInt(beforePublish.nextTaskId) + 1n));
  const arenaFile = join(directory, "arena.json");
  stage = "admission";
  const tamperedManifest = await save("tampered-publication.json", { ...manifest, publication: { ...manifest.publication, reward: "1" } });
  await rejected("admit.mjs", [configFile, tamperedManifest, ipc, arenaFile], /PUBLICATION_SIGNER_MISMATCH/);
  await assert.rejects(stat(arenaFile), { code: "ENOENT" });
  await role("admit.mjs", [configFile, manifestFile, ipc, arenaFile]);
  const arenaConfig = parseConfig(JSON.parse(await readFile(arenaFile, "utf8")));
  assert.deepEqual(arenaConfig.tasks, { [taskId]: { problemId: "sum-integers" } });
  settler = spawn(process.execPath, ["--import", "tsx", join(root, "services/arena/src/settler-main.ts")], { cwd: root,
    env: { ...baseEnv, ARENA_CONFIG: arenaFile, ARENA_VERIFIER_PRIVATE_KEY: key(13) }, stdio: ["ignore", "pipe", "pipe"] });
  await new Promise<void>((done, reject) => {
    const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000);
    const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : done(); };
    settler!.stdout!.on("data", data => { if (String(data).includes('"ready":true')) finish(); });
    settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("error", finish); settler!.once("exit", () => finish(new Error("SETTLER_EXITED")));
  });
  let arenaSaved: unknown;
  // The wrapper's environment allowlist excludes ARENA_DOCKER_IMAGE; the existing default is pinned.
  assert.equal(process.env.ARENA_DOCKER_IMAGE, undefined);
  arena = createArenaHttpServer(arenaConfig, [], f.provider, { save: async journal => { arenaSaved = journal; await save("arena-http.json", journal); } });
  arena.server.listen(arenaPort, "127.0.0.1"); await once(arena.server, "listening");
  const workerJournal = join(directory, "worker.private.json"), workerArgs = [configFile, manifestFile, workerJournal];
  stage = "worker-delivery";
  const losingConfig = await save("losing-config.json", { ...config, maxPrice: "140000" });
  const workerNonceBefore = await f.provider.getTransactionCount(worker.address);
  await rejected("worker.mjs", [losingConfig, manifestFile, workerJournal], /UNPROFITABLE_TASK/, { WORKER_PRIVATE_KEY: key(2) });
  await assert.rejects(stat(workerJournal), { code: "ENOENT" });
  assert.equal(await f.provider.getTransactionCount(worker.address), workerNonceBefore); assert.equal(modelCalls, 0); assert.equal((await f.escrow.getTask(taskId)).status, 1n);
  const delivered = await role("worker.mjs", [...workerArgs, "--stop-after-delivery"], { WORKER_PRIVATE_KEY: key(2) });
  assert.equal(delivered.state, "Delivered"); assert.equal((await f.escrow.getTask(taskId)).status, 2n);
  const savedWorker = JSON.parse(await readFile(workerJournal, "utf8")), paymentId = savedWorker.payment.quote.paymentId;
  const paymentReceipt = await canonical(savedWorker.payment.submission.txHash, worker.address, config.account);
  const paid = parseEvents(paymentReceipt, f.account, "ProviderPaid"); assert.equal(paid.length, 1);
  assert.equal(String(paid[0]!.args.fromCash), "40000"); assert.equal(String(paid[0]!.args.fromCredit), "80000");
  assert.equal(String((await read(f.manager, "getLoan", [taskId])).status), "1");
  const paidNonce = await f.provider.getTransactionCount(worker.address), verifierNonceBefore = await f.provider.getTransactionCount(verifier.address);
  const mismatchConfig = await save("mismatch-config.json", { ...config, minimumProfit: "11000" });
  const journalBytes = await readFile(workerJournal, "utf8");
  await rejected("worker.mjs", [mismatchConfig, manifestFile, workerJournal], /JOURNAL_BINDING_MISMATCH/, { WORKER_PRIVATE_KEY: key(2) });
  assert.equal(await readFile(workerJournal, "utf8"), journalBytes); assert.equal(await f.provider.getTransactionCount(worker.address), paidNonce); assert.equal(modelCalls, 1);
  // A Worker cannot authorize its own settlement.
  await assert.rejects(f.escrow.connect(worker).getFunction("settle").staticCall(taskId, true));
  stage = "arena-recovery";
  process.stderr.write("publisher-worker: verifying original arena recovery\n");
  await f.provider.send("anvil_setBalance", [verifier.address, "0x0"]);
  await rejected("worker.mjs", workerArgs, /SETTLEMENT_UNAVAILABLE/, { WORKER_PRIVATE_KEY: key(2) });
  const interruptedWorker = JSON.parse(await readFile(workerJournal, "utf8"));
  assert.ok(interruptedWorker.runId); assert.equal(interruptedWorker.run, undefined);
  assert.equal((await f.escrow.getTask(taskId)).status, 2n); assert.equal(modelCalls, 1);
  assert.equal(await f.provider.getTransactionCount(worker.address), paidNonce); assert.equal(await f.provider.getTransactionCount(verifier.address), verifierNonceBefore);
  const savedSettlement = JSON.parse(await readFile(join(ipc, "settlements.json"), "utf8"))[taskId];
  assert.equal(savedSettlement.verdict.runId, interruptedWorker.runId);
  await f.provider.send("anvil_setBalance", [verifier.address, "0x3635c9adc5dea00000"]);
  await rejected("worker.mjs", workerArgs, /SUBMISSION_RECOVERY_NOT_AUTHORIZED/, { WORKER_PRIVATE_KEY: key(2) });
  const completed = await role("worker.mjs", [...workerArgs,"--allow-submission-recovery"], { WORKER_PRIVATE_KEY: key(2) });
  stage = "settlement-checks";
  assert.equal(completed.settlement.txHash, savedSettlement.txHash);
  assert.equal(completed.state, "Settled"); assert.equal(completed.settlement.passed, true);
  assert.equal(completed.openingCash, "40000"); assert.equal(completed.closingCash, "58000");
  const settlementReceipt = await canonical(completed.settlement.txHash, verifier.address, config.escrow);
  const settlements = parseEvents(settlementReceipt, f.escrow, "TaskSettled"), repaid = parseEvents(settlementReceipt, f.manager, "LoanRepaid");
  assert.equal(settlements.length, 1); assert.equal(repaid.length, 1);
  assert.deepEqual([String(settlements[0]!.args.repaid), String(settlements[0]!.args.toAgent)], ["92000", "58000"]);
  assert.deepEqual([String(repaid[0]!.args.principal), String(repaid[0]!.args.fee)], ["80000", "12000"]);
  assert.equal((await f.escrow.getTask(taskId)).status, 3n); assert.equal((await f.escrow.getTask(taskId)).escrowBalance, 0n);
  assert.equal((await read(f.manager, "getLoan", [taskId])).status, 2n); assert.equal(await f.manager.totalOutstanding(), 0n);
  assert.equal(await f.manager.repaymentCount(1), 1n); assert.equal(await f.escrow.feedbackSent(taskId, 1), true); assert.equal(await f.escrow.feedbackSent(taskId, 2), true);
  assert.equal(await f.provider.getTransactionCount(worker.address), paidNonce); assert.equal(await f.provider.getTransactionCount(verifier.address), verifierNonceBefore + 1); assert.equal(modelCalls, 1);
  const finalJournal = JSON.parse(await readFile(workerJournal, "utf8"));
  assert.equal(finalJournal.runId, interruptedWorker.runId);
  assert.deepEqual(finalJournal.submission, interruptedWorker.submission);
  assert.equal(finalJournal.run.result.verdict.mode, "docker"); assert.equal(finalJournal.run.result.tests.length, 5);
  assert.ok(finalJournal.run.result.tests.every((test: any) => test.passed));
  assert.ok(arenaSaved); assert.equal(finalJournal.payment.quote.paymentId, paymentId);
  assert.deepEqual(await role("worker.mjs", workerArgs, { WORKER_PRIVATE_KEY: key(2) }), completed);
  assert.equal(await f.provider.getTransactionCount(worker.address), paidNonce); assert.equal(await f.provider.getTransactionCount(verifier.address), verifierNonceBefore + 1); assert.equal(modelCalls, 1);
  for (const path of [publisherJournal, workerJournal]) assert.equal((await stat(path)).mode & 0o777, 0o600);
  const report = { version: 1, suite: "local-publisher-worker", status: "passed", generatedAt: new Date().toISOString(), scope: "isolated Anvil; controlled model response; existing Docker Arena; no production execution or external adoption",
    source: { revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, env: baseEnv, encoding: "utf8" }).trim(),
      dirty: Boolean(execFileSync("git", ["status", "--porcelain"], { cwd: root, env: baseEnv, encoding: "utf8" }).trim()),
      harnessSha256: sha(await readFile(fileURLToPath(import.meta.url))), consumerSha256, trustedConfigSha256: sha(json(config)), sdkArchiveSha256: sha(await readFile(join(directory, "agentfuel-sdk-0.0.0.tgz"))), node: process.version },
    chainId: "31337", assetDecimals: 6, contracts: { escrow: config.escrow, account: config.account, manager: await f.manager.getAddress(), asset: config.asset },
    roles: { publisher: publisher.address, worker: worker.address, verifier: verifier.address, provider: f.payee }, taskId, paymentId,
    publication: { txHash: createReceipt.hash, blockNumber: createReceipt.blockNumber, reward: "150000", recoveredSameTask: true },
    payment: { txHash: paymentReceipt.hash, blockNumber: paymentReceipt.blockNumber, fromCash: "40000", fromCredit: "80000", modelCalls },
    verification: { mode: "docker", image: DEFAULT_IMAGE, cases: 5, passed: true, runId: finalJournal.runId },
    settlement: completed.settlement, economics: { openingCash: "40000", closingCash: "58000", netTaskIncome: "18000", reward: "150000", providerCost: "120000", principal: "80000", borrowFee: "12000", protocolFee: "0", gasIncluded: false },
    replay: { publisherExtraTasks: 0, workerExtraPayments: 0, modelExtraCalls: 0, verifierExtraTransactions: 0, recoveredSameArenaRun: true, recoveredSameSettlementHash: true },
    negativeChecks: ["tampered publication rejected before admission write", "unprofitable task rejected before acceptance/payment", "changed worker config preserves original journal", "worker cannot self-settle"] };
  resultReport = report;
} catch (error) {
  const code = (error as { code?: string }).code ?? (error as Error).message;
  const location = (error as Error).stack?.match(/publisher-worker-local\.ts:[0-9]+:[0-9]+/)?.[0];
  const nestedCode = (error as Error).message.match(/Error: ([A-Z_]{1,100})/)?.[1];
  resultReport = { version: 1, suite: "local-publisher-worker", status: "failed", stage, error: /^[A-Z_]{1,100}$/.test(code) ? code : "LOCAL_LIFECYCLE_FAILED", location, nestedCode };
  process.exitCode = 1;
} finally {
  if (relayServer?.listening) await new Promise<void>(done => relayServer!.close(() => done()));
  await arena?.close(); relay?.close(); if (settler) await stopAnvil(settler);
  await f?.close(); if (local) await stopAnvil(local.child);
  await rm(ipc, { recursive: true, force: true });
}
await writeFile(privateReport, JSON.stringify(resultReport, null, 2) + "\n", { mode: 0o600, flag: "wx" });
