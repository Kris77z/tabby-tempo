import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, JsonRpcProvider, keccak256, NonceManager, toUtf8Bytes, Wallet } from "ethers";
import { InferCredit, EMPTY_AUTH, accountInterface, type PaymentHandle } from "../packages/sdk/src/index.js";
import { IdentityRegistry, ReputationRegistry } from "../packages/erc8004/src/index.js";
import { Underwriter } from "../services/underwriter/src/underwriter.js";
import { createHttpServer as underwriterHttp } from "../services/underwriter/src/http.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer as relayHttp } from "../services/provider-relay/src/http.js";
import { createArenaHttpServer } from "../services/arena/src/http.js";
import { submissionTypedData } from "../services/arena/src/submission-auth.js";
import { parseConfig, type ArenaConfig } from "../services/arena/src/protocol.js";
import { DockerExecutor } from "../services/arena/src/docker.js";
import { ROOT, closeServer, deploy, inferenceCode, json, listen, read, rejectedTransaction,
  readCreditProfile, saveJson, startLocalAnvil, stopChild, syntheticKey, tx } from "./demo-common.js";

export interface LocalDemoOptions { output: string; serve?: boolean; pauseBeforeThird?: boolean }
const ROLES = { deployer: 1, underwriter: 2, verifier: 3, guardian: 4, treasury: 5, poster: 6, provider: 7, refunder: 8,
  hero: 11, veteran: 12, defaulted: 13, rotatedOwner: 14, rotatedWallet: 15, blocked: 99 };
const PRICE = 120000n, REWARD = 150000n;
const EXPECTED_CASH = [58000n, 78700n, 105396n];

export async function runLocalDemo(options: LocalDemoOptions) {
  if (options.pauseBeforeThird && !process.stdin.isTTY) throw new Error("PAUSE_REQUIRES_INTERACTIVE_TERMINAL");
  await new DockerExecutor().ready(); // Check isolation before any business transaction.
  const output = resolve(options.output);
  await mkdir(output, { mode: 0o700 }); // Refuse overwriting an earlier run.
  for (const directory of ["private", "evidence"]) await mkdir(join(output, directory), { mode: 0o700 });
  const ipcDirectory = await mkdtemp("/tmp/afdemo-ipc-");
  let interrupted = false;
  let signalReceived!: () => void;
  const signal = new Promise<void>(resolveSignal => { signalReceived = resolveSignal; });
  const interrupt = () => { interrupted = true; signalReceived(); };
  const checkInterrupted = () => { if (interrupted) throw new Error("DEMO_INTERRUPTED"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  let anvil: ChildProcess | undefined, settler: ChildProcess | undefined;
  let provider: JsonRpcProvider | undefined, upstream: Server | undefined, creditServer: Server | undefined, computeServer: Server | undefined;
  let underwriter: Underwriter | undefined, relay: Relay | undefined, arena: ReturnType<typeof createArenaHttpServer> | undefined;
  const evidence: Record<string, unknown> = { mode: "local", chainId: "31337", registries: "MOCK", inference: "FAKE local controlled upstream", rounds: [], reverse: {} };
  const checkpoint = async () => saveJson(join(output, "evidence", "demo.json"), evidence);
  let upstreamCalls = 0;
  try {
    const local = await startLocalAnvil(); anvil = local.child;
    provider = new JsonRpcProvider(local.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 50 });
    const wallets = Object.fromEntries(Object.entries(ROLES).map(([name, role]) => [name, new Wallet(syntheticKey(role), provider)])) as Record<keyof typeof ROLES, Wallet>;
    for (const wallet of Object.values(wallets)) await provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
    const admin = new NonceManager(wallets.deployer), guardian = new NonceManager(wallets.guardian);
    const treasury = new NonceManager(wallets.treasury), poster = new NonceManager(wallets.poster);
    const deploymentBlock = await provider.getBlockNumber();
    const identityContract = await deploy("MockIdentityRegistry", admin, provider);
    const reputation = await deploy("MockReputationRegistry", admin, provider, [await identityContract.getAddress()]);
    const token = await deploy("MockERC20", admin, provider, ["Local test USDC", "USDC", 6]);
    const asset = await token.getAddress();
    const adapter = await deploy("ERC8004Adapter", admin, provider, [await identityContract.getAddress(), await reputation.getAddress(), wallets.deployer.address]);
    const manager = await deploy("CreditManager", admin, provider, [{ settlementAsset: asset, adapter: await adapter.getAddress(), underwriter: wallets.underwriter.address,
      treasury: wallets.treasury.address, guardian: wallets.guardian.address, relayRefunder: wallets.refunder.address, owner: wallets.deployer.address, maxLtvBps: 8000, grace: 3600 }]);
    const account = await deploy("AgentAccount", admin, provider, [asset, await adapter.getAddress(), wallets.deployer.address]);
    const escrow = await deploy("TaskEscrow", admin, provider, [asset, await adapter.getAddress(), wallets.verifier.address, wallets.treasury.address, 0, wallets.deployer.address]);
    await tx(manager, admin, "setProtocolContracts", [await account.getAddress(), await escrow.getAddress()]);
    await tx(account, admin, "setProtocolContracts", [await manager.getAddress(), await escrow.getAddress()]);
    await tx(escrow, admin, "setProtocolContracts", [await manager.getAddress(), await account.getAddress()]);
    await tx(adapter, admin, "setCreditManager", [await manager.getAddress()]);
    await tx(adapter, admin, "setReporter", [await escrow.getAddress(), true]);
    await tx(manager, admin, "setGlobalLimits", [50000000n, 20000000n]);
    await tx(account, admin, "setProviderWhitelist", [wallets.provider.address, true]);
    for (const [wallet, amount] of [[wallets.treasury, 10000000n], [wallets.poster, 10000000n]] as const) await tx(token, admin, "mint", [wallet.address, amount]);
    await tx(token, treasury, "approve", [await manager.getAddress(), 10000000n]);
    await tx(manager, treasury, "deposit", [10000000n]);
    await tx(token, poster, "approve", [await escrow.getAddress(), REWARD * 8n]);
    const identity = new IdentityRegistry({ provider, address: await identityContract.getAddress(), expectedChainId: 31337n });
    const agents: Array<{ id: string; name: string; role: "hero" | "veteran" | "defaulted"; wallet: Wallet; registerTx: string }> = [];
    for (const [name, label] of [["hero", "主角 · 两次预置还款后现场升级"], ["veteran", "高分 Agent · 真实还款 + 身份变更"], ["defaulted", "违约 Agent · 真实失败清算"]] as const) {
      checkInterrupted();
      const wallet = wallets[name], signer = new NonceManager(wallet);
      const registration = await identity.register(signer, `ipfs://local-demo-${name}`);
      const id = registration.agentId.toString();
      await tx(manager, guardian, "enrollAgent", [id]);
      await tx(account, signer, "setPolicy", [id, { maxCashPerTx: 1000000n, maxDebtPerTx: 1000000n, maxDebtPerDay: 10000000n, ownerFrozen: false }]);
      await tx(token, admin, "mint", [wallet.address, 50000n]);
      await tx(token, signer, "approve", [await account.getAddress(), 40000n]);
      await tx(account, signer, "depositCash", [id, 40000n]);
      await tx(token, signer, "approve", [await manager.getAddress(), 10000n]);
      await tx(manager, signer, "fundBackstop", [id, 10000n]);
      agents.push({ id, name: label, role: name, wallet, registerTx: registration.receipt.hash });
    }
    const tasks: Array<{ id: string; agentId: string; createTx: string; acceptTx: string }> = [];
    const createAssignedTask = async (index: number) => {
      checkInterrupted();
      const agent = agents[index]; const now = (await provider!.getBlock("latest"))!.timestamp;
      const created = await tx(escrow, poster, "createTask", [REWARD, now + 172800]);
      const event = created.logs.map(log => { try { return escrow.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === "TaskCreated");
      if (!event) throw new Error("TASK_CREATED_EVENT_MISSING");
      const id = event.args.taskId.toString();
      const accepted = await tx(escrow, agent.wallet, "acceptTask", [id, agent.id]);
      return { id, agentId: agent.id, createTx: created.hash, acceptTx: accepted.hash };
    };
    for (const [position, index] of [0, 0, 0, 1, 1, 1, 2, 1].entries()) {
      if (position !== 2) tasks[position] = await createAssignedTask(index);
    }
    // The local chain is owned by this run. Reserve only its actual next ID;
    // controller/signer still require this task to be Assigned on-chain.
    const liveTaskId = String(await read(escrow, "nextTaskId"));
    tasks[2] = { id: liveTaskId, agentId: agents[0].id, createTx: "", acceptTx: "" };
    evidence.tx0 = { agents: agents.map(({ id, role, registerTx }) => ({ id, role, registerTx })), depositCashEach: "40000", backstopEach: "10000", registryMode: "MOCK (not canonical deployed network)" };
    evidence.tasks = tasks; await checkpoint();

    const origin = "http://127.0.0.1:3000";
    // Only the inference text is simulated. Requests still pay the real relay.
    upstream = createServer(async (request, response) => {
      let body = ""; for await (const chunk of request) body += chunk;
      const input = JSON.parse(body); upstreamCalls++;
      const adversarial = JSON.stringify(input.messages).includes("LOCAL_DELIBERATE_FAILURE");
      const code = adversarial ? "print('PASS')\n" : "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n";
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ model: "FAKE-local-python-fixture", choices: [{ message: { role: "assistant", content: code } }], usage: { total_tokens: 20 } }));
    });
    const fakeUrl = await listen(upstream);
    underwriter = new Underwriter({ rpcUrl: local.rpcUrl, chainId: 31337n, managerAddress: await manager.getAddress(), settlementAsset: asset, assetDecimals: 6,
      tokenUsdPrice: 10n ** 18n, privateKey: syntheticKey(ROLES.underwriter), evidenceDir: join(output, "evidence", "underwriter"), host: "127.0.0.1", port: 8787 });
    await underwriter.initialize(); creditServer = underwriterHttp(underwriter, origin); const underwriterUrl = await listen(creditServer);
    relay = new Relay({ rpcUrl: local.rpcUrl, chainId: 31337n, account: await account.getAddress(), asset, assetDecimals: 6, payTo: wallets.provider.address,
      service: { id: "infercredit/coder", model: "coder", price: PRICE, upstreams: [{ name: "FAKE-local-controlled-upstream", baseUrl: fakeUrl, model: "FAKE-local-python-fixture", key: "local-placeholder" }] },
      dataDir: join(output, "private", "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 2000, host: "127.0.0.1", port: 8788, frontendOrigin: origin });
    await relay.initialize(); const refunder = new Refunder(relay); await refunder.initialize();
    computeServer = relayHttp(relay, refunder); const relayUrl = await listen(computeServer);
    const arenaConfig: ArenaConfig = parseConfig({ rpcUrl: local.rpcUrl, chainId: "31337", escrowAddress: await escrow.getAddress(), allowManual: false, ipcDirectory,
      tasks: Object.fromEntries(tasks.map(task => [task.id, { agentId: task.agentId, problemId: "sum-integers" }])) });
    const configPath = join(output, "private", "arena.json"); await saveJson(configPath, arenaConfig);
    settler = spawn(process.execPath, ["--import", "tsx", resolve(ROOT, "services/arena/src/settler-main.ts")], {
      cwd: ROOT, env: { PATH: process.env.PATH, ARENA_CONFIG: configPath, ARENA_VERIFIER_PRIVATE_KEY: syntheticKey(ROLES.verifier) }, stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolveReady(); };
      settler!.stdout!.on("data", chunk => { if (String(chunk).includes('"ready":true')) finish(); });
      settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.on("error", finish); settler!.once("exit", () => finish(new Error("SETTLER_EXITED")));
    });
    arena = createArenaHttpServer(arenaConfig, [origin]); const arenaUrl = await listen(arena.server);
    const manifest = { chainId: "31337", network: "Local Anvil · MOCK registries · FAKE inference", rpcUrl: local.rpcUrl, explorerUrl: "", deploymentBlock, underwriterUrl,
      asset: { address: asset, symbol: "USDC", decimals: 6 }, contracts: { manager: await manager.getAddress(), adapter: await adapter.getAddress(), account: await account.getAddress(), escrow: await escrow.getAddress() },
      agents: agents.map(({ id, name }) => ({ id, name })), providers: [{ name: "Local FAKE inference relay", address: wallets.provider.address, relayUrl, service: "infercredit/coder", model: "coder" }], arenaUrl };
    await saveJson(join(output, "manifest.json"), manifest);
    await saveJson(join(output, "private", "roles.local.json"), Object.fromEntries(Object.entries(ROLES).map(([role, n]) => [role, { address: wallets[role as keyof typeof ROLES].address, syntheticPrivateKey: syntheticKey(n) }])));
    await saveJson(join(output, "services.json"), { mode: "local", underwriterUrl, relayUrl, arenaUrl, fakeUpstreamUrl: fakeUrl, frontendManifest: join(output, "manifest.json"), localSyntheticRoles: join(output, "private", "roles.local.json") });
    console.log(`LOCAL DEMO: real USDC-6 contracts, MOCK registries, FAKE inference, Docker Python Arena.\nManifest: ${join(output, "manifest.json")}`);

    const profile = (id: string) => readCreditProfile(underwriterUrl, id);
    const reputationReader = new ReputationRegistry({ provider, address: await reputation.getAddress(), expectedChainId: 31337n });
    const round = async (taskIndex: number, agentIndex: number, ordinal: number, shouldPass = true) => {
      checkInterrupted();
      const task = tasks[taskIndex], agent = agents[agentIndex];
      const cashBefore: bigint = await read(account, "cash", [agent.id]); assert.ok(cashBefore < PRICE, "Every demo order must really borrow");
      const repaymentsBefore: bigint = await read(manager, "repaymentCount", [agent.id]);
      const handlePath = join(output, "private", `payment-${task.id}.json`);
      const client = new InferCredit({ agentId: agent.id, sessionKey: syntheticKey(ROLES[agent.role]), rpcUrl: local.rpcUrl, chainId: 31337n,
        account: await account.getAddress(), asset, provider: wallets.provider.address, maxPrice: PRICE, underwriterUrl,
        onHandle: handle => saveJson(handlePath, handle) });
      try {
        // Existing handles resume the same quote/transaction; never fetch anew after uncertainty.
        let handle: PaymentHandle | undefined;
        try { handle = JSON.parse(await readFile(handlePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        const inference = handle ? await client.resume(handle) : await client.forTask(task.id).fetch(relayUrl + "/v1/chat", { body: {
          service: "infercredit/coder", model: "coder", messages: [{ role: "user", content: `Return only Python 3.12 code. Read one JSON integer array from stdin and print its sum as one JSON integer; no other output.${shouldPass ? "" : " LOCAL_DELIBERATE_FAILURE"}` }],
        } });
        assert.equal(inference.receipt.price, PRICE.toString()); assert.ok(BigInt(inference.receipt.fromCredit) > 0n);
        const loanBefore = await read(manager, "getLoan", [task.id]); assert.equal(loanBefore.status, 1n);
        if (shouldPass) assert.equal(loanBefore.fee, BigInt(inference.receipt.fromCredit) * (ordinal < 3 ? 1500n : 800n) / 10000n);
        console.log(`${agent.role} tx3=${inference.receipt.txHash} paymentId=${inference.receipt.paymentId} fromCash=${inference.receipt.fromCash} principal=${inference.receipt.fromCredit} fee=${loanBefore.fee}`);
        const code = inferenceCode(inference.result);
        await saveJson(join(output, "evidence", `inference-${task.id}.json`), { simulated: true, result: inference.result, receipt: inference.receipt, submittedCode: code });
        const deadline = String((await provider!.getBlock("latest"))!.timestamp + 300);
        const typed = submissionTypedData(arenaConfig, { taskId: task.id, code, deadline });
        const signature = await agent.wallet.signTypedData(typed.domain, typed.types, typed.message);
        const response = await fetch(arenaUrl + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id, code, deadline, signature }) });
        const accepted = await response.json() as { runId: string }; assert.equal(response.status, 202);
        let run: any;
        for (let i = 0; i < 400; i++) { run = await (await fetch(arenaUrl + `/runs/${accepted.runId}`)).json(); if (run.status !== "running") break; await delay(100); }
        assert.equal(run.status, "settled", json(run)); assert.equal(run.result.verdict.passed, shouldPass, "The actual model code must pass; never replace a failed answer");
        const settlement = run.result.settlement;
        const receipt = await provider!.getTransactionReceipt(settlement.txHash); assert.equal(receipt?.status, 1);
        const contracts = [manager, account, escrow, adapter, reputation];
        const events = receipt!.logs.flatMap(log => {
          const emitter = contracts.find(contract => String(contract.target).toLowerCase() === log.address.toLowerCase());
          try { const decoded = emitter?.interface.parseLog(log); return decoded ? [{ address: log.address, name: decoded.name, args: Array.from(decoded.args) }] : []; }
          catch { return []; }
        });
        assert.ok(events.some(event => event.name === (shouldPass ? "LoanRepaid" : "LoanDefaulted")));
        assert.equal(events.filter(event => event.name === "NewFeedback").length, shouldPass ? 2 : 1);
        await saveJson(join(output, "evidence", `settlement-${task.id}.json`), { receipt: receipt!.toJSON(), events, verdict: run.result.verdict });
        const loanAfter = await read(manager, "getLoan", [task.id]); assert.equal(loanAfter.status, shouldPass ? 2n : 3n);
        assert.equal(await read(manager, "repaymentCount", [agent.id]), repaymentsBefore + (shouldPass ? 1n : 0n));
        const cashAfter: bigint = await read(account, "cash", [agent.id]);
        if (shouldPass) {
          assert.equal(cashAfter, EXPECTED_CASH[ordinal - 1]);
          assert.equal(await read(escrow, "feedbackSent", [task.id, 1]), true); assert.equal(await read(escrow, "feedbackSent", [task.id, 2]), true);
          assert.equal(await read(reputation, "countFor", [agent.id, "repayment"]), BigInt(ordinal));
        } else {
          assert.equal(await read(manager, "defaultCount", [agent.id]), 1n); assert.equal(await read(manager, "protocolFrozen", [agent.id]), true);
          assert.equal(await read(escrow, "feedbackSent", [task.id, 3]), true); assert.equal(await read(reputation, "countFor", [agent.id, "default"]), 1n);
        }
        const credit = await profile(agent.id);
        const reputationSummary = await reputationReader.readSummary(BigInt(agent.id), [await adapter.getAddress()], "infercredit", shouldPass ? "repayment" : "default");
        assert.equal(reputationSummary.count, shouldPass ? BigInt(ordinal) : 1n);
        const entry = { role: agent.role, agentId: agent.id, ordinal, taskId: task.id, tx1: task.createTx, tx2: task.acceptTx, tx3: inference.receipt.txHash,
          tx4: settlement.txHash, paymentId: inference.receipt.paymentId, fromCash: inference.receipt.fromCash, principal: inference.receipt.fromCredit,
          fee: loanBefore.fee.toString(), cashBefore: cashBefore.toString(), cashAfter: cashAfter.toString(), score: credit.terms.score, tier: credit.terms.tier, passed: shouldPass, feedback: settlement.feedback, reputationSummary };
        (evidence.rounds as unknown[]).push(entry); await checkpoint();
        console.log(`${agent.role} order ${ordinal}: ${shouldPass ? "PASS" : "FAIL/default"}; cash=${cashAfter} score=${credit.terms.score} tier=${credit.terms.tier}; tx4=${settlement.txHash}`);
        return entry;
      } finally { client.close(); }
    };
    for (let i = 0; i < 3; i++) await round(3 + i, 1, i + 1);
    await round(6, 2, 1, false);
    await round(0, 0, 1); await round(1, 0, 2);
    const beforeLive = await profile(agents[0].id); assert.equal(beforeLive.terms.score, "640"); assert.equal(beforeLive.terms.tier, "B");
    evidence.beforeLive = { agentId: agents[0].id, score: "640", tier: "B", cash: "78700", repayments: "2" }; await checkpoint();

    const reverse = evidence.reverse as Record<string, unknown>;
    const blocked = await rejectedTransaction(provider, wallets.hero, account, "payProvider", [agents[0].id, wallets.blocked.address, PRICE,
      keccak256(toUtf8Bytes("demo-blocked-provider")), EMPTY_AUTH, "0x"]);
    const decoded = accountInterface.parseError(blocked.revertData); assert.equal(decoded?.name, "SpendRejected"); assert.equal(decoded!.args.reason, 1n);
    assert.equal(await read(account, "cash", [agents[0].id]), 78700n); assert.equal(blocked.logCount, 0);
    reverse.spendRejected = { ...blocked, name: "SpendRejected", reason: "1", target: wallets.blocked.address, evidenceType: "actual mined reverted transaction + decoded eth_call, no event" };

    const identityTask = tasks[7];
    const authorizationResponse = await fetch(underwriterUrl + "/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: agents[1].id, taskId: identityTask.id, nonce: "9000001" }) });
    const authorization = await authorizationResponse.json() as any; assert.equal(authorizationResponse.status, 200);
    await tx(identityContract, wallets.veteran, "transferIdentity", [agents[1].id, wallets.rotatedOwner.address]);
    const deadline = (await provider.getBlock("latest"))!.timestamp + 300;
    const bindingDigest = await read(identityContract, "walletBindingDigest", [agents[1].id, wallets.rotatedWallet.address, deadline]);
    await tx(identityContract, wallets.rotatedOwner, "setAgentWallet", [agents[1].id, wallets.rotatedWallet.address, deadline, wallets.rotatedWallet.signingKey.sign(bindingDigest).serialized]);
    assert.equal(await read(adapter, "identityChanged", [agents[1].id]), true);
    const changed = await rejectedTransaction(provider, wallets.rotatedWallet, account, "payProvider", [agents[1].id, wallets.provider.address, PRICE,
      keccak256(toUtf8Bytes("demo-identity-changed")), authorization.authorization, authorization.signature]);
    assert.equal(manager.interface.parseError(changed.revertData)?.name, "IdentityChanged");
    await tx(manager, guardian, "freezeAgent", [agents[1].id]);
    reverse.identityChanged = { ...changed, agentId: agents[1].id, name: "IdentityChanged", snapshotUnchanged: true, protocolFrozen: true, mockBinding: true };
    await checkpoint();

    console.log("LIVE starting point: hero 640 / Tier B / two real repayments; third order must upgrade to 710 / Tier A.");
    if (options.pauseBeforeThird) {
      if (!process.stdin.isTTY) throw new Error("PAUSE_REQUIRES_INTERACTIVE_TERMINAL");
      console.log("Open the frontend with this manifest. Press Enter to run the third order.");
      await Promise.race([new Promise<void>(resolve => process.stdin.once("data", () => resolve())), signal]);
    }
    checkInterrupted();
    assert.equal(String(await read(escrow, "nextTaskId")), liveTaskId, "Reserved live task ID changed; stop before creating or paying another task");
    const liveTask = await createAssignedTask(0);
    assert.equal(liveTask.id, liveTaskId, "Actual TaskCreated receipt must match the sole reserved task binding");
    tasks[2] = liveTask;
    console.log(`LIVE tx1=${liveTask.createTx} tx2=${liveTask.acceptTx}; task=${liveTask.id}`);
    await checkpoint();
    await round(2, 0, 3);
    const final = await profile(agents[0].id); assert.equal(final.terms.score, "710"); assert.equal(final.terms.tier, "A");
    assert.equal(await read(manager, "totalOutstanding"), 0n);
    const providerPaid: bigint = await read(token, "balanceOf", [wallets.provider.address]); assert.equal(providerPaid, PRICE * 7n);
    assert.equal(upstreamCalls, 7);
    const vault: bigint = await read(manager, "vaultBalance"), backstop: bigint = await read(manager, "backstopTotal");
    const cashTotal = (await Promise.all(agents.map(agent => read(account, "cash", [agent.id])))).reduce((sum: bigint, balance: bigint) => sum + balance, 0n);
    assert.equal(await read(token, "balanceOf", [await manager.getAddress()]), vault + backstop);
    assert.equal(await read(token, "balanceOf", [await account.getAddress()]), cashTotal);
    assert.equal(await read(token, "balanceOf", [await escrow.getAddress()]), REWARD); // Identity rejection task remains Assigned.
    assert.equal(await read(escrow, "totalEscrowed"), REWARD);
    evidence.assetLedger = { manager: (vault + backstop).toString(), vault: vault.toString(), backstop: backstop.toString(), account: cashTotal.toString(), escrow: REWARD.toString() };
    evidence.afterLive = { agentId: agents[0].id, score: "710", tier: "A", cash: "105396", repayments: "3" };
    evidence.summary = { agents: 3, successfulCreditOrders: 6, defaultedCreditOrders: 1, providerPaid: providerPaid.toString(), upstreamCalls, manualAcceptance: false,
      completed: true, realMonadBroadcast: false, paidModelCall: false };
    await checkpoint();
    const transactionHashes = new Set<string>();
    for (let number = 1; number <= await provider.getBlockNumber(); number++) {
      const block = await provider.send("eth_getBlockByNumber", ["0x" + number.toString(16), false]);
      for (const hash of block.transactions) transactionHashes.add(hash);
    }
    const receipts = [];
    for (const hash of transactionHashes) receipts.push((await provider.getTransactionReceipt(hash))!.toJSON());
    await saveJson(join(output, "evidence", "chain-receipts.json"), receipts);
    await saveJson(join(output, "private", "chain-state.json"), await provider.send("anvil_dumpState", []));
    console.log(`DEMO_RESULT ${JSON.stringify({ output, manifest: join(output, "manifest.json"), evidence: join(output, "evidence", "demo.json"), mode: "local", completed: true })}`);
    if (options.serve && !interrupted) { console.log("Services stay alive for frontend inspection. Ctrl-C cleans this demo's processes."); await signal; }
    return evidence;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    await arena?.close(); await stopChild(settler);
    try { await saveJson(join(output, "private", "arena-settlements.json"), JSON.parse(await readFile(join(ipcDirectory, "settlements.json"), "utf8"))); } catch { /* Signer may not have started. */ }
    await rm(ipcDirectory, { recursive: true, force: true });
    await closeServer(computeServer); relay?.close(); await closeServer(creditServer); underwriter?.close(); await closeServer(upstream);
    provider?.destroy(); await stopChild(anvil);
  }
}
