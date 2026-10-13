import assert from "node:assert/strict";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { Server } from "node:http";
import { once } from "node:events";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, ContractFactory, getAddress, JsonRpcProvider, keccak256, toUtf8Bytes, Wallet, ZeroAddress, type TransactionReceipt } from "ethers";
import { IdentityRegistry, ReputationRegistry, type WalletConsent } from "../packages/erc8004/src/index.js";
import { registrationFromReceipt } from "../packages/erc8004/src/identity.js";
import { InferCredit, EMPTY_AUTH, accountInterface, type PaymentHandle, type Json } from "../packages/sdk/src/index.js";
import { Underwriter } from "../services/underwriter/src/underwriter.js";
import { createHttpServer as underwriterHttp } from "../services/underwriter/src/http.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer as relayHttp } from "../services/provider-relay/src/http.js";
import { createArenaHttpServer } from "../services/arena/src/http.js";
import { submissionTypedData } from "../services/arena/src/submission-auth.js";
import { parseConfig, type ArenaConfig } from "../services/arena/src/protocol.js";
import { readControllerToken, requestSettlement } from "../services/arena/src/ipc.js";
import { DockerExecutor } from "../services/arena/src/docker.js";
import { ROOT, artifact, closeServer, inferenceCode, json, read, readCreditProfile, saveJson, stopChild } from "./demo-common.js";
import { DemoJournal } from "./demo-journal.js";
import { backupAndRemoveArenaIpc, prepareArenaIpc } from "./demo-arena-state.js";
import { deployedContracts, enforceFreshDeployment, MONAD_CHAIN_ID, monadPreflight, monadRuntimeConfig, readSecret, SIGNING_ROLES, type MonadConfig, type SigningRole, type ContractAddresses } from "./demo-monad-config.js";
import { monadProvider, proxyUpstreamFetch, readRpcUrlFile, type RpcTransport } from "./demo-rpc.js";

type AgentRole = "hero" | "veteran" | "defaulted";
interface Task { id: string; agentId: string; deadline: number; createTx: string; acceptTx?: string }
interface State {
  version: 1; configHash: string; deploymentBlock: number; addresses?: ContractAddresses;
  agents: Partial<Record<AgentRole, string>>; tasks: Record<string, Task>; rounds: Record<string, any>;
  contexts: Record<string, any>; reverse: Record<string, any>;
  ports: Partial<Record<"underwriter" | "relay" | "arena", number>>; ipcDirectory?: string;
}
export interface MonadOptions { output: string; execute?: boolean; resume?: boolean; serve?: boolean; pauseBeforeThird?: boolean; stopAfterDeploy?: boolean; rpcTransport?: RpcTransport; rpcUrl?: string; rpcUrlFile?: string }
const PRICE = 120000n, REWARD = 150000n, CASH = [58000n, 78700n, 105396n];
const SETTLEMENT_TIMEOUT_MS = 180000, SETTLER_START_TIMEOUT_MS = 90000, ARENA_RUN_TIMEOUT_MS = 240000;
const AGENTS: AgentRole[] = ["hero", "veteran", "defaulted"];
const sequence = [["veteran-1", "veteran", 1, true], ["veteran-2", "veteran", 2, true], ["veteran-3", "veteran", 3, true],
  ["defaulted-1", "defaulted", 1, false], ["hero-1", "hero", 1, true], ["hero-2", "hero", 2, true]] as const;
export function monadManifest(config: MonadConfig, publicRpcUrl: string, deploymentBlock: number, addresses: ContractAddresses,
  agents: Partial<Record<AgentRole, string>>, urls: { underwriterUrl: string; relayUrl: string; arenaUrl: string }) {
  return { chainId: "10143", network: "Monad Testnet · canonical ERC8004 · real Kimi", rpcUrl: publicRpcUrl, explorerUrl: config.explorerUrl,
    deploymentBlock, underwriterUrl: urls.underwriterUrl, asset: config.asset, contracts: addresses,
    agents: AGENTS.map(role => ({ id: agents[role]!, name: role })),
    providers: [{ name: "Kimi relay", address: config.roles.provider, relayUrl: urls.relayUrl, service: "infercredit/coder", model: "coder" }], arenaUrl: urls.arenaUrl };
}
export function monadDeploymentEvidence(config: MonadConfig, addresses: ContractAddresses,
  receipts: Record<string, Pick<TransactionReceipt, "toJSON">>, rpcTransport: RpcTransport) {
  return { chainId: "10143", stage: "deployment-configured", addresses, registries: config.registries, asset: config.asset,
    roles: config.roles, maxTotalOutstanding: "50000000", maxDrawPerEpoch: "20000000", protocolFeeBps: 0,
    inferenceCalled: false, agentsRegistered: false, fundsDeposited: false,
    rpcTransport, rpcOrigin: new URL(config.rpcUrl).origin,
    receipts: Object.fromEntries(Object.entries(receipts).map(([id, receipt]) => [id, receipt.toJSON()])) };
}
export const needsBeforeLiveCheckpoint = (tasks: Record<string, { id: string }>) => !Object.hasOwn(tasks, "hero-3");
export const arenaBindings = (tasks: Record<string, { id: string; agentId: string }>) => Object.fromEntries(Object.values(tasks)
  .filter(task => task.id !== "").map(task => [task.id, { agentId: task.agentId, problemId: "sum-integers" }]));
export async function checkVerifierKey(file: string, address: string) {
  try {
    const result = await promisify(execFile)(process.execPath, ["--import", "tsx", join(ROOT, "scripts/demo-settler.ts")], { cwd: ROOT,
      env: { PATH: process.env.PATH, ARENA_VERIFIER_KEY_FILE: file, ARENA_KEY_CHECK_EXPECTED: address }, timeout: 15000, maxBuffer: 2048 });
    if (JSON.parse(result.stdout).checked !== true) throw new Error();
  } catch { throw new Error("VERIFIER_KEY_CHECK_FAILED_BEFORE_TRANSACTIONS"); }
}

// This is the runner's original deployment stage, also used by its local
// pause/resume regression. No token approvals, deposits or registrations here.
export async function prepareMonadDeployment(config: MonadConfig, provider: JsonRpcProvider, wallet: Wallet, journal: DemoJournal,
  addresses: ContractAddresses | undefined, checkpointAddresses: (addresses: ContractAddresses) => Promise<void>, check = () => {}) {
  const receipts: Record<string, TransactionReceipt> = {};
  const deploy = async (name: string, args: unknown[]) => {
    check();
    const id = `deploy-${name}`;
    if (!journal.has(id)) {
      const definition = await artifact(name);
      await new ContractFactory(definition.abi, definition.bytecode.object, journal.signer(id, wallet)).deploy(...args);
    }
    const receipt = receipts[id] = await journal.receipt(id);
    if (!receipt.contractAddress) throw new Error("DEPLOYMENT_ADDRESS_MISSING"); return receipt.contractAddress;
  };
  if (!addresses) {
    const adapter = await deploy("ERC8004Adapter", [config.registries.identity, config.registries.reputation, config.roles.deployer]);
    const manager = await deploy("CreditManager", [{ settlementAsset: config.asset.address, adapter, underwriter: config.roles.underwriter,
      treasury: config.roles.treasury, guardian: config.roles.guardian, relayRefunder: config.roles.refunder, owner: config.roles.deployer, maxLtvBps: 8000, grace: 3600 }]);
    const account = await deploy("AgentAccount", [config.asset.address, adapter, config.roles.deployer]);
    const escrow = await deploy("TaskEscrow", [config.asset.address, adapter, config.roles.verifier, config.roles.treasury, 0, config.roles.deployer]);
    addresses = { manager, adapter, account, escrow }; await checkpointAddresses(addresses);
  }
  const contracts = Object.fromEntries(await Promise.all(Object.entries({ manager: "CreditManager", adapter: "ERC8004Adapter", account: "AgentAccount", escrow: "TaskEscrow" })
    .map(async ([key, name]) => [key, new Contract(addresses[key as keyof ContractAddresses], (await artifact(name)).abi, provider)]))) as Record<keyof ContractAddresses, Contract>;
  const { manager, adapter, account, escrow } = contracts;
  const operation = async (id: string, contract: Contract, method: string, args: unknown[]) => {
    check();
    if (!journal.has(id)) await contract.connect(journal.signer(id, wallet)).getFunction(method)(...args);
    receipts[id] = await journal.receipt(id);
  };
  if (!config.contracts) {
    await operation("wire-manager", manager, "setProtocolContracts", [addresses.account, addresses.escrow]);
    await operation("wire-account", account, "setProtocolContracts", [addresses.manager, addresses.escrow]);
    await operation("wire-escrow", escrow, "setProtocolContracts", [addresses.manager, addresses.account]);
    await operation("wire-adapter", adapter, "setCreditManager", [addresses.manager]);
    await operation("wire-reporter", adapter, "setReporter", [addresses.escrow, true]);
    // On resume addresses are already checkpointed; retain all four original
    // deployment receipts in the public stage evidence as well.
    for (const name of ["ERC8004Adapter", "CreditManager", "AgentAccount", "TaskEscrow"]) receipts[`deploy-${name}`] = await journal.receipt(`deploy-${name}`);
  }
  await deployedContracts(config, provider, addresses);
  await operation("limits", manager, "setGlobalLimits", [50000000n, 20000000n]);
  await operation("provider-whitelist", account, "setProviderWhitelist", [config.roles.provider, true]);
  if (await read(manager, "maxTotalOutstanding") !== 50000000n || await read(manager, "maxDrawPerEpoch") !== 20000000n ||
    !await read(account, "providerWhitelist", [config.roles.provider]) || await read(account, "providerWhitelist", [config.blockedProvider])) throw new Error("DEPLOYMENT_LIMITS_OR_PROVIDER_MISMATCH");
  return { addresses, contracts, receipts };
}

export async function runMonadDemo(originalConfig: MonadConfig, options: MonadOptions) {
  if (options.pauseBeforeThird && !process.stdin.isTTY) throw new Error("PAUSE_REQUIRES_INTERACTIVE_TERMINAL");
  if (options.rpcUrl !== undefined && options.rpcUrlFile !== undefined) throw new Error("RPC_URL_OPTIONS_MUTUALLY_EXCLUSIVE");
  const rpcOverride = options.rpcUrlFile === undefined ? options.rpcUrl : await readRpcUrlFile(options.rpcUrlFile);
  const { config, configHash, publicRpcUrl } = monadRuntimeConfig(originalConfig, rpcOverride, options.rpcUrlFile !== undefined);
  const connection = await monadProvider(config.rpcUrl, options.rpcTransport ?? "direct"), { provider } = connection;
  const output = resolve(options.output);
  if (!options.execute) {
    try { const report = await monadPreflight(config, provider); console.log(json(report)); return report; }
    finally { connection.close(); }
  }
  // The CLI deliberately needs an explicit execute flag. This branch is not
  // run by the default local tests and never substitutes a FAKE upstream.
  if (!options.stopAfterDeploy) try { await new DockerExecutor().ready(); } catch (error) { connection.close(); throw error; }
  let state: State, lockOwned = false;
  const lockPath = join(output, "private", "runner.pid");
  let settler: ChildProcess | undefined, creditServer: Server | undefined, computeServer: Server | undefined;
  let arena: ReturnType<typeof createArenaHttpServer> | undefined, underwriter: Underwriter | undefined, relay: Relay | undefined;
  let upstreamTransport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  const serviceProvider = connection.proxyUrl ? provider : undefined;
  let ownsIpc = false, interrupted = false, notifySignal!: () => void;
  const signal = new Promise<void>(resolveSignal => { notifySignal = resolveSignal; });
  const interrupt = () => { interrupted = true; upstreamTransport?.close(); notifySignal(); };
  const check = () => { if (interrupted) throw new Error("DEMO_INTERRUPTED"); };
  process.once("SIGINT", interrupt); process.once("SIGTERM", interrupt);
  try {
    const preflight = await monadPreflight(config, provider);
    enforceFreshDeployment(preflight.freshDeploymentReady, options.resume ?? false);
    if (options.resume) {
      state = JSON.parse(await readFile(join(output, "private", "state.json"), "utf8"));
      if (state.version !== 1 || state.configHash !== configHash) throw new Error("RESUME_CONFIG_MISMATCH");
    } else {
      if (!preflight.canStartFresh) throw new Error("PREFLIGHT_FUNDING_OR_SECRET_METADATA_INCOMPLETE");
      await mkdir(output, { mode: 0o700 });
      for (const directory of ["private", "evidence"]) await mkdir(join(output, directory), { mode: 0o700 });
      state = { version: 1, configHash, deploymentBlock: (await provider.getBlock("latest"))!.number,
        addresses: config.contracts, agents: {}, tasks: {}, rounds: {}, contexts: {}, reverse: {}, ports: {} };
    }
    // A single output owns a single execution. A stale PID is removable only
    // after the OS confirms no live process; active runs are never interrupted.
    try {
      const pid = Number((await readFile(lockPath, "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid < 1) throw new Error("INVALID_RUNNER_PID");
      try { process.kill(pid, 0); throw new Error("DEMO_OUTPUT_IN_USE"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
      await rm(lockPath);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await writeFile(lockPath, String(process.pid), { mode: 0o600, flag: "wx" }); lockOwned = true;
    const checkpoint = () => saveJson(join(output, "private", "state.json"), state);
    await checkpoint(); await saveJson(join(output, "evidence", "preflight.json"), preflight);
    const wallets = {} as Record<Exclude<SigningRole, "verifier">, Wallet>;
    wallets.deployer = new Wallet(await readSecret(config.keyFiles.deployer), provider);
    if (wallets.deployer.address !== config.roles.deployer) throw new Error("ROLE_KEY_ADDRESS_MISMATCH");
    let apiKey = "";
    if (!options.stopAfterDeploy) {
      for (const role of SIGNING_ROLES) {
        if (role === "verifier" || role === "deployer") continue; // Only the independent signer reads verifier.
        const wallet = new Wallet(await readSecret(config.keyFiles[role]), provider);
        if (wallet.address !== config.roles[role]) throw new Error("ROLE_KEY_ADDRESS_MISMATCH"); wallets[role] = wallet;
      }
      apiKey = await readSecret(config.upstream.apiKeyFile);
      await checkVerifierKey(config.keyFiles.verifier, config.roles.verifier);
    }
    const journal = new DemoJournal(provider, join(output, "private", "transactions.json")); await journal.load();
    const operation = async (id: string, contract: Contract, role: Exclude<SigningRole, "verifier">, method: string, args: unknown[] = [], gasLimit?: bigint) => {
      check();
      if (!journal.has(id)) await contract.connect(journal.signer(id, wallets[role])).getFunction(method)(...args, gasLimit ? { gasLimit } : {});
      return journal.receipt(id);
    };
    const deployment = await prepareMonadDeployment(config, provider, wallets.deployer, journal, state.addresses, async addresses => { state.addresses = addresses; await checkpoint(); }, check);
    const { addresses, contracts } = deployment;
    const { manager, adapter, account, escrow } = contracts;
    const deploymentEvidence = monadDeploymentEvidence(config, addresses, deployment.receipts, options.rpcTransport ?? "direct");
    await saveJson(join(output, "evidence", "deployment.json"), deploymentEvidence);
    if (options.stopAfterDeploy) {
      console.log(`DEPLOYMENT_PAUSED ${JSON.stringify({ output, addresses, transactionCount: Object.keys(deployment.receipts).length, resumeWithSameOutput: true })}`);
      return deploymentEvidence;
    }
    const token = new Contract(config.asset.address, ["function approve(address,uint256) returns(bool)", "function balanceOf(address) view returns(uint256)"], provider);
    await operation("treasury-approve", token, "treasury", "approve", [addresses.manager, 10000000n]);
    await operation("treasury-deposit", manager, "treasury", "deposit", [10000000n]);
    await operation("poster-approve", token, "poster", "approve", [addresses.escrow, REWARD * 8n]);
    const identity = new IdentityRegistry({ provider, address: config.registries.identity, expectedChainId: MONAD_CHAIN_ID });
    const reputation = new ReputationRegistry({ provider, address: config.registries.reputation, expectedChainId: MONAD_CHAIN_ID });
    for (const role of AGENTS) {
      const registerId = `register-${role}`, uri = `ipfs://infercredit-demo-${state.configHash.slice(2, 18)}-${role}`;
      const registration = journal.has(registerId) ? registrationFromReceipt(await journal.receipt(registerId), config.registries.identity, config.roles[role], uri)
        : await identity.register(journal.signer(registerId, wallets[role]), uri);
      state.agents[role] = registration.agentId.toString(); await checkpoint();
      const bindId = `initial-bind-${role}`;
      if (!journal.has(bindId)) await identity.bindWallet(journal.signer(bindId, wallets[role]), await identity.signWalletConsent(wallets[role], registration.agentId));
      await journal.receipt(bindId);
      const id = state.agents[role]!;
      await operation(`enroll-${role}`, manager, "guardian", "enrollAgent", [id]);
      await operation(`policy-${role}`, account, role, "setPolicy", [id, { maxCashPerTx: 1000000n, maxDebtPerTx: 1000000n, maxDebtPerDay: 10000000n, ownerFrozen: false }]);
      await operation(`cash-approve-${role}`, token, role, "approve", [addresses.account, 40000n]);
      await operation(`cash-deposit-${role}`, account, role, "depositCash", [id, 40000n]);
      await operation(`backstop-approve-${role}`, token, role, "approve", [addresses.manager, 10000n]);
      await operation(`backstop-fund-${role}`, manager, role, "fundBackstop", [id, 10000n]);
    }
    const createTask = async (label: string, role: AgentRole) => {
      check(); const id = `create-${label}`;
      if (!state.tasks[label]) {
        state.tasks[label] = { id: "", agentId: state.agents[role]!, deadline: (await provider.getBlock("latest"))!.timestamp + 172800, createTx: "" }; await checkpoint();
      }
      const task = state.tasks[label];
      const created = await operation(id, escrow, "poster", "createTask", [REWARD, task.deadline]);
      const event = created.logs.flatMap(log => { try { const decoded = escrow.interface.parseLog(log); return decoded?.name === "TaskCreated" ? [decoded] : []; } catch { return []; } });
      if (event.length !== 1) throw new Error("TASK_CREATED_EVENT_MISSING");
      task.id = event[0].args.taskId.toString(); task.createTx = created.hash; await checkpoint();
      task.acceptTx = (await operation(`accept-${label}`, escrow, role, "acceptTask", [task.id, task.agentId])).hash; await checkpoint();
      return task;
    };
    for (const [label, role] of sequence) await createTask(label, role);
    await createTask("identity-negative", "veteran");

    const listen = async (server: Server, name: "underwriter" | "relay" | "arena") => {
      server.listen(state.ports[name] ?? 0, "127.0.0.1"); await once(server, "listening");
      state.ports[name] = (server.address() as { port: number }).port; await checkpoint(); return `http://127.0.0.1:${state.ports[name]}`;
    };
    underwriter = new Underwriter({ rpcUrl: config.rpcUrl, chainId: MONAD_CHAIN_ID, managerAddress: addresses.manager, settlementAsset: config.asset.address, assetDecimals: 6,
      tokenUsdPrice: 10n ** 18n, privateKey: await readSecret(config.keyFiles.underwriter), evidenceDir: join(output, "evidence", "underwriter"), host: "127.0.0.1", port: 8787 }, serviceProvider);
    await underwriter.initialize(); creditServer = underwriterHttp(underwriter, config.frontendOrigin); const underwriterUrl = await listen(creditServer, "underwriter");
    if (connection.proxyUrl) upstreamTransport = proxyUpstreamFetch(connection.proxyUrl);
    relay = new Relay({ rpcUrl: config.rpcUrl, chainId: MONAD_CHAIN_ID, account: addresses.account, asset: config.asset.address, assetDecimals: 6, payTo: config.roles.provider,
      service: { id: "infercredit/coder", model: "coder", price: PRICE, upstreams: [{ name: "kimi", baseUrl: config.upstream.baseUrl, model: config.upstream.model, key: apiKey }] },
      dataDir: join(output, "private", "relay"), quoteTtl: 900, confirmations: 1, upstreamTimeout: 120000, logScanChunkBlocks: 100, host: "127.0.0.1", port: 8788, frontendOrigin: config.frontendOrigin },
      { provider: serviceProvider, upstreamFetch: upstreamTransport?.fetch });
    await relay.initialize(); const refunder = new Refunder(relay); await refunder.initialize(); await refunder.recover(); await relay.recover();
    computeServer = relayHttp(relay, refunder); const relayUrl = await listen(computeServer, "relay");
    if (!state.ipcDirectory) { state.ipcDirectory = await mkdtemp("/tmp/afmonad-ipc-"); await checkpoint(); }
    await prepareArenaIpc(state.ipcDirectory, join(output, "private", "arena-settlements.json"));
    ownsIpc = true;
    let arenaConfig!: ArenaConfig, arenaUrl = "";
    const startArena = async () => {
      await arena?.close(); await stopChild(settler);
      arenaConfig = parseConfig({ rpcUrl: config.rpcUrl, chainId: "10143", escrowAddress: addresses.escrow, ipcDirectory: state.ipcDirectory!, allowManual: false, settlementTimeoutMs: SETTLEMENT_TIMEOUT_MS,
        tasks: arenaBindings(state.tasks) });
      const path = join(output, "private", "arena.json"); await saveJson(path, arenaConfig);
      settler = spawn(process.execPath, ["--import", "tsx", join(ROOT, "scripts/demo-settler.ts")], { cwd: ROOT,
        env: { PATH: process.env.PATH, ARENA_CONFIG: path, ARENA_VERIFIER_KEY_FILE: config.keyFiles.verifier, ARENA_RPC_TRANSPORT: options.rpcTransport ?? "direct" }, stdio: ["ignore", "pipe", "pipe"] });
      await new Promise<void>((resolveReady, reject) => {
        const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), SETTLER_START_TIMEOUT_MS);
        const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolveReady(); };
        settler!.stdout!.on("data", chunk => { if (String(chunk).includes('"ready":true')) finish(); });
        settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("error", finish); settler!.once("exit", () => finish(new Error("SETTLER_EXITED")));
      });
      arena = createArenaHttpServer(arenaConfig, [config.frontendOrigin], serviceProvider); arenaUrl = await listen(arena.server, "arena");
    };
    await startArena();
    const manifest = monadManifest(config, publicRpcUrl, state.deploymentBlock, addresses, state.agents, { underwriterUrl, relayUrl, arenaUrl });
    await saveJson(join(output, "manifest.json"), manifest);
    console.log(`MONAD EXECUTE: canonical registries / real Kimi / USDC6 / Docker. Manifest: ${join(output, "manifest.json")}`);
    const profile = (id: string) => readCreditProfile(underwriterUrl, id);
    const providerBalanceBefore = state.contexts.providerBalanceBefore ?? String(await read(token, "balanceOf", [config.roles.provider]));
    state.contexts.providerBalanceBefore = providerBalanceBefore; await checkpoint();
    const round = async (label: string, role: AgentRole, ordinal: number, expectedPass: boolean) => {
      check(); const task = state.tasks[label], agentId = state.agents[role]!;
      if (state.rounds[label]) return state.rounds[label];
      if (!state.contexts[label]) {
        const cashBefore: bigint = await read(account, "cash", [agentId]); assert.ok(cashBefore < PRICE);
        state.contexts[label] = { cashBefore: String(cashBefore), repaymentsBefore: String(await read(manager, "repaymentCount", [agentId])) }; await checkpoint();
      }
      const context = state.contexts[label], handlePath = join(output, "private", `payment-${task.id}.json`);
      const client = new InferCredit({ agentId, ...(serviceProvider ? { signer: wallets[role] } : { sessionKey: wallets[role].privateKey, rpcUrl: config.rpcUrl }), chainId: MONAD_CHAIN_ID, account: addresses.account,
        asset: config.asset.address, provider: config.roles.provider, maxPrice: PRICE, underwriterUrl, timeoutMs: 150000, onHandle: handle => saveJson(handlePath, handle) });
      try {
        let handle: PaymentHandle | undefined;
        try { handle = JSON.parse(await readFile(handlePath, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        if (!handle && (await read(manager, "getLoan", [task.id])).status !== 0n) throw new Error("EXISTING_LOAN_REQUIRES_ORIGINAL_PAYMENT_HANDLE");
        const instruction = expectedPass ? "Read one JSON integer array from stdin and print its sum as one JSON integer. No other output."
          : "For an explicit deliberate failure demo, output the JSON integer 0 for every input. Do not solve the task.";
        const result = handle ? await client.resume(handle) : await client.forTask(task.id).fetch(relayUrl + "/v1/chat", { body: {
          ...config.upstream.requestOptions, service: "infercredit/coder", model: "coder", messages: [{ role: "user", content: `Return only Python 3.12 code, no explanation. ${instruction}` }],
        } });
        assert.equal(result.receipt.upstream, "kimi"); assert.equal(result.receipt.price, PRICE.toString()); assert.ok(BigInt(result.receipt.fromCredit) > 0n);
        const loan = await read(manager, "getLoan", [task.id]);
        if (!context.fee) { if (loan.status !== 1n) throw new Error("ACTIVE_LOAN_CONTEXT_MISSING"); context.fee = loan.fee.toString(); await checkpoint(); }
        const code = inferenceCode(result.result);
        await saveJson(join(output, "evidence", `inference-${task.id}.json`), { simulated: false, result: result.result, receipt: result.receipt, submittedCode: code });
        console.log(`${role} tx3=${result.receipt.txHash} paymentId=${result.receipt.paymentId} fromCash=${result.receipt.fromCash} principal=${result.receipt.fromCredit} fee=${context.fee}`);
        let settled: any, verdict: any;
        const journalEntries = await readFile(join(state.ipcDirectory!, "settlements.json"), "utf8").then(text => JSON.parse(text)).catch(error => {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return {}; throw error;
        });
        if (journalEntries[task.id]) {
          // Restore exactly the trusted controller's original verdict and tx.
          verdict = journalEntries[task.id].verdict;
          settled = await requestSettlement(state.ipcDirectory!, await readControllerToken(state.ipcDirectory!), verdict, arenaConfig.settlementTimeoutMs);
        } else {
          const deadline = String((await provider.getBlock("latest"))!.timestamp + 300);
          const typed = submissionTypedData(arenaConfig, { taskId: task.id, code, deadline });
          const signature = await wallets[role].signTypedData(typed.domain, typed.types, typed.message);
          const response = await fetch(arenaUrl + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ taskId: task.id, code, deadline, signature }) });
          if (!response.ok) throw new Error("ARENA_SUBMISSION_REJECTED");
          const submitted = await response.json() as any; let run: any;
          const runDeadline = Date.now() + ARENA_RUN_TIMEOUT_MS;
          while (Date.now() < runDeadline) {
            run = await (await fetch(arenaUrl + `/runs/${submitted.runId}`, { signal: AbortSignal.timeout(Math.max(1, Math.min(5000, runDeadline - Date.now()))) })).json();
            if (run.status !== "running") break;
            await delay(100);
          }
          if (run?.status !== "settled") throw new Error("ARENA_RUN_INCOMPLETE_USE_SAME_OUTPUT");
          verdict = run.result.verdict; settled = run.result.settlement;
        }
        const receipt = await provider.getTransactionReceipt(settled.txHash); assert.equal(receipt?.status, 1);
        const events = receipt!.logs.flatMap(log => {
          const iface = Object.values(contracts).find(contract => String(contract.target).toLowerCase() === log.address.toLowerCase())?.interface;
          try { const decoded = iface?.parseLog(log); return decoded ? [{ address: log.address, name: decoded.name, args: Array.from(decoded.args) }] : []; } catch { return []; }
        });
        await saveJson(join(output, "evidence", `settlement-${task.id}.json`), { receipt: receipt!.toJSON(), events, verdict, explorerUrl: `${config.explorerUrl}/tx/${settled.txHash}` });
        if (verdict.passed !== expectedPass) throw new Error("ACTUAL_KIMI_CODE_VERDICT_DIFFERS_DEMO_STOPS_NO_REPLACEMENT");
        const types = expectedPass ? [1, 2] : [3];
        for (const type of types) {
          if (await read(escrow, "pendingFeedback", [task.id, type])) await operation(`feedback-retry-${task.id}-${type}`, escrow, "deployer", "retryFeedback", [task.id, type], 2000000n);
          if (!await read(escrow, "feedbackSent", [task.id, type])) throw new Error("FEEDBACK_NOT_SENT_DEMO_CANNOT_CLAIM_UPGRADE");
        }
        const summary = await reputation.readSummary(BigInt(agentId), [addresses.adapter], "infercredit", expectedPass ? "repayment" : "default");
        assert.equal(summary.count, expectedPass ? BigInt(ordinal) : 1n);
        assert.equal((await read(manager, "getLoan", [task.id])).status, expectedPass ? 2n : 3n);
        assert.equal(await read(manager, "repaymentCount", [agentId]), BigInt(context.repaymentsBefore) + (expectedPass ? 1n : 0n));
        const cashAfter: bigint = await read(account, "cash", [agentId]);
        if (expectedPass) { assert.equal(cashAfter, CASH[ordinal - 1]); assert.equal(BigInt(context.fee), BigInt(result.receipt.fromCredit) * (ordinal < 3 ? 1500n : 800n) / 10000n); }
        else { assert.equal(await read(manager, "defaultCount", [agentId]), 1n); assert.equal(await read(manager, "protocolFrozen", [agentId]), true); }
        const credit = await profile(agentId);
        state.rounds[label] = { role, agentId, ordinal, taskId: task.id, tx1: task.createTx, tx2: task.acceptTx, tx3: result.receipt.txHash, tx4: settled.txHash,
          principal: result.receipt.fromCredit, fee: context.fee, cashBefore: context.cashBefore, cashAfter: String(cashAfter), passed: verdict.passed,
          score: credit.terms.score, tier: credit.terms.tier, reputationSummary: { count: String(summary.count), summaryValue: String(summary.summaryValue), decimals: String(summary.summaryValueDecimals) }, explorerUrl: `${config.explorerUrl}/tx/${settled.txHash}` };
        await checkpoint(); console.log(`${role} order ${ordinal}: ${verdict.passed ? "PASS" : "FAIL/default"}; cash=${cashAfter} score=${credit.terms.score} tier=${credit.terms.tier}; tx4=${settled.txHash}`);
        return state.rounds[label];
      } finally { client.close(); }
    };
    for (const [label, role, ordinal, expectedPass] of sequence) await round(label, role, ordinal, expectedPass);
    const reverse = async (label: string, role: "hero" | "rotatedWallet", args: unknown[], expectedError: string) => {
      if (state.reverse[label]?.txHash) return;
      const id = `reverse-${label}`;
      if (!state.reverse[label]) {
        let data = "";
        try { await provider.call({ from: wallets[role].address, to: addresses.account, data: account.interface.encodeFunctionData("payProvider", args) }); }
        catch (error) { data = (error as { data?: string }).data ?? ""; }
        if (!data.startsWith("0x")) throw new Error("EXPECTED_REVERT_DATA_MISSING");
        const error = expectedError === "SpendRejected" ? accountInterface.parseError(data) : manager.interface.parseError(data);
        assert.equal(error?.name, expectedError); if (expectedError === "SpendRejected") assert.equal(error!.args.reason, 1n);
        state.reverse[label] = { name: expectedError, revertData: data, ...(expectedError === "SpendRejected" ? { reason: "1" } : {}) }; await checkpoint();
      }
      if (!journal.has(id)) await journal.send(id, wallets[role], { to: addresses.account, data: account.interface.encodeFunctionData("payProvider", args), gasLimit: 1000000n });
      const receipt = await journal.receipt(id, 0); assert.equal(receipt.logs.length, 0);
      state.reverse[label] = { ...state.reverse[label], txHash: receipt.hash, status: 0, blockNumber: receipt.blockNumber, logCount: 0,
        explorerUrl: `${config.explorerUrl}/tx/${receipt.hash}` }; await checkpoint();
    };
    await reverse("spendRejected", "hero", [state.agents.hero!, config.blockedProvider, PRICE, keccak256(toUtf8Bytes(state.configHash + "blocked")), EMPTY_AUTH, "0x"], "SpendRejected");
    const veteranId = BigInt(state.agents.veteran!);
    if (state.contexts.identityAuthorization && !state.reverse.identityChanged?.txHash &&
      BigInt(state.contexts.identityAuthorization.authorization.authDeadline) < BigInt((await provider.getBlock("latest"))!.timestamp)) {
      // Once transferred, the old owner authorization cannot be re-created.
      if (journal.has("identity-transfer")) throw new Error("IDENTITY_EXAMPLE_AUTHORIZATION_EXPIRED_EVIDENCE_RETAINED");
      delete state.contexts.identityAuthorization; delete state.contexts.oldConsent; await checkpoint();
    }
    if (!state.contexts.identityAuthorization) {
      const response = await fetch(underwriterUrl + "/authorize", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: veteranId.toString(), taskId: state.tasks["identity-negative"].id, nonce: "9000001" }) });
      if (!response.ok) throw new Error("IDENTITY_EXAMPLE_AUTHORIZATION_REJECTED");
      state.contexts.identityAuthorization = await response.json();
      state.contexts.oldConsent = await identity.signWalletConsent(wallets.rotatedWallet, veteranId); await checkpoint();
    }
    if (!journal.has("identity-transfer")) await identity.transferIdentity(journal.signer("identity-transfer", wallets.veteran), veteranId, config.roles.rotatedOwner);
    await journal.receipt("identity-transfer");
    if (!journal.has("identity-new-bind")) {
      assert.equal((await identity.readIdentity(veteranId)).wallet, ZeroAddress);
      const cached = state.contexts.oldConsent;
      const oldConsent: WalletConsent = { ...cached, agentId: BigInt(cached.agentId), deadline: BigInt(cached.deadline), chainId: BigInt(cached.chainId) };
      let rejection = "";
      try { await identity.bindWallet(wallets.rotatedOwner, oldConsent); }
      catch (error) { rejection = (error as Error).message; }
      if (!["IDENTITY_OWNER_CHANGED", "WALLET_DEADLINE_INVALID"].includes(rejection)) throw new Error("CANONICAL_OLD_CONSENT_REJECTION_NOT_PROVEN");
      state.contexts.oldConsentRejection = rejection; await checkpoint();
      const consent = await identity.signWalletConsent(wallets.rotatedWallet, veteranId);
      await identity.bindWallet(journal.signer("identity-new-bind", wallets.rotatedOwner), consent);
    }
    await journal.receipt("identity-new-bind"); assert.equal(await read(adapter, "identityChanged", [veteranId]), true);
    const authorization = state.contexts.identityAuthorization;
    await reverse("identityChanged", "rotatedWallet", [veteranId, config.roles.provider, PRICE, keccak256(toUtf8Bytes(state.configHash + "identity")), authorization.authorization, authorization.signature], "IdentityChanged");
    await operation("identity-freeze", manager, "guardian", "freezeAgent", [veteranId]);
    state.reverse.identityChanged.protocolFrozen = true; state.reverse.identityChanged.canonicalBinding = true; await checkpoint();
    if (!state.rounds["hero-3"]) {
      if (needsBeforeLiveCheckpoint(state.tasks)) {
        const before = await profile(state.agents.hero!); assert.equal(before.terms.score, "640"); assert.equal(before.terms.tier, "B");
        console.log("LIVE starting point: hero 640 / Tier B / two real repayments; Enter runs tx1→tx4.");
        if (options.pauseBeforeThird) await Promise.race([new Promise<void>(resolveInput => process.stdin.once("data", () => resolveInput())), signal]);
      }
      check(); const task = await createTask("hero-3", "hero");
      console.log(`LIVE tx1=${task.createTx} tx2=${task.acceptTx}; task=${task.id}`);
      await startArena(); // Narrow config restart after actual receipt, same URL/port.
    }
    await round("hero-3", "hero", 3, true);
    const final = await profile(state.agents.hero!); assert.equal(final.terms.score, "710"); assert.equal(final.terms.tier, "A");
    assert.equal(await read(manager, "totalOutstanding"), 0n);
    const paid: bigint = await read(token, "balanceOf", [config.roles.provider]);
    const actualBalanceDelta = paid - BigInt(providerBalanceBefore);
    assert.equal(actualBalanceDelta, 840000n); // Provider cannot alias poster.
    const vault: bigint = await read(manager, "vaultBalance"), backstop: bigint = await read(manager, "backstopTotal");
    const accountCash = (await Promise.all(AGENTS.map(role => read(account, "cash", [state.agents[role]!])))).reduce((sum: bigint, balance: bigint) => sum + balance, 0n);
    assert.equal(await read(token, "balanceOf", [addresses.manager]), vault + backstop);
    assert.equal(await read(token, "balanceOf", [addresses.account]), accountCash); assert.equal(await read(token, "balanceOf", [addresses.escrow]), REWARD);
    const evidence = { mode: "monad", chainId: "10143", inference: "real Kimi", registryMode: "canonical", completed: true, rounds: Object.values(state.rounds), reverse: state.reverse,
      beforeLive: { score: "640", tier: "B", cash: "78700", repayments: "2" }, afterLive: { score: "710", tier: "A", cash: "105396", repayments: "3" },
      providerPayments: "840000", actualBalanceDelta: String(actualBalanceDelta),
      oldConsentRejection: state.contexts.oldConsentRejection,
      assetLedger: { manager: String(vault + backstop), vault: String(vault), backstop: String(backstop), account: String(accountCash), escrow: String(REWARD) } };
    await saveJson(join(output, "evidence", "demo.json"), evidence);
    console.log(`DEMO_RESULT ${JSON.stringify({ output, manifest: join(output, "manifest.json"), mode: "monad", completed: true })}`);
    if (options.serve && !interrupted) await signal;
    return evidence;
  } finally {
    process.removeListener("SIGINT", interrupt); process.removeListener("SIGTERM", interrupt);
    upstreamTransport?.close();
    await arena?.close(); await stopChild(settler);
    let backupFailed = false;
    if (ownsIpc) try { await backupAndRemoveArenaIpc(state!.ipcDirectory!, join(output, "private", "arena-settlements.json")); }
    catch { backupFailed = true; }
    await closeServer(computeServer); relay?.close(); await closeServer(creditServer); underwriter?.close();
    if (lockOwned) await rm(lockPath, { force: true }); connection.close();
    if (backupFailed) throw new Error("ARENA_JOURNAL_BACKUP_FAILED_SOURCE_PRESERVED");
  }
}
