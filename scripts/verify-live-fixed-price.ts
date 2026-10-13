import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createServer as reservePort } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, JsonRpcProvider, Wallet, type TransactionRequest } from "ethers";
import { runFixedPriceTask, type FixedTaskConfig, type FixedTaskSession } from "@agentfuel/pi-loop/fixed-task";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { DockerExecutor } from "@agentfuel/arena/docker";
import type { ProblemId } from "@agentfuel/arena";
import { isFixedProblemId } from "@agentfuel/pi-loop/public-sample";
import { FixedPriceSolvingRelay, FixedPriceRefunder, FIXED_SOLVE_MODEL, FIXED_SOLVE_SERVICE } from "../services/provider-relay/src/fixed-price.js";
import { createHttpServer as relayHttp } from "../services/provider-relay/src/http.js";
import { Underwriter } from "../services/underwriter/src/underwriter.js";
import { createHttpServer as creditHttp } from "../services/underwriter/src/http.js";
import { createArenaHttpServer, type ArenaHttpJournal } from "../services/arena/src/http.js";
import type { ArenaConfig } from "../services/arena/src/protocol.js";
import { fixture, key, startAnvil } from "../services/underwriter/test/fixture.js";
import { ROOT, artifact, closeServer, read, saveJson, stopChild } from "./demo-common.js";
import { DemoJournal } from "./demo-journal.js";
import { backupAndRemoveArenaIpc, prepareArenaIpc } from "./demo-arena-state.js";
import { deployedContracts, loadMonadConfig, readSecret, type ContractAddresses, type MonadConfig } from "./demo-monad-config.js";
import { checkVerifierKey } from "./demo-monad.js";
import { monadProvider, proxyUpstreamFetch, readRpcUrlFile, systemHttpsProxy, type RpcTransport } from "./demo-rpc.js";
import { auditSavedFixedPrice } from "./live-fixed-price-evidence.js";

export const LIVE_FIXED_PLAN = { version: 1, fixedPriceRaw: "120000", rewardRaw: "150000", models: { cheap: "kimi-k2.6", strong: "kimi-k3" },
  tiers: ["cheap", "strong", "strong"] as const, maxRounds: 3, maxToolCalls: 4, maxCompletionTokens: 2048, deadlineMs: 300000,
  modelRetries: 0, fixedPriceEarlySuccessRefund: false, undeliveredFullRefund: true,
  gasUnits: { poster: "650000", agent: "1300000", verifier: "2000000", refunder: "500000" },
  pricingMeaning: "Operator fixed service price; neither observed Kimi cost nor a model bill" };
export interface LiveFixedOptions { mode: "local" | "monad"; configFile: string; deploymentFile?: string; output: string;
  scenario?: "strong-only" | "catalog-once"; problemId?: ProblemId; agentId?: string; execute?: boolean; resume?: boolean; recover?: boolean; enableRefunderProvider?: boolean; rpcUrlFile?: string; rpcTransport?: RpcTransport; maxFeePerGas?: string; routesFile?: string }
export const LIVE_FIXED_CATALOG_PLAN = Object.freeze({ version: 1, problemIds: Object.freeze(["sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"] as const),
  mode: "local", scenario: "catalog-once", maxRoundsPerTask: 1, maxModelCalls: 4, modelRetries: 0,
  stopOnUnconfirmedTask: true, fixedPriceRawPerTask: "120000", rewardRawPerTask: "150000" });
export async function readLiveRoutes(path: string) {
  const input = JSON.parse(await readFile(path, "utf8"));
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).sort().join(",") !== "cheap,strong") throw new Error("INVALID_LIVE_ROUTES");
  for (const tier of ["cheap", "strong"] as const) {
    const value = input[tier];
    if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["name", "model", "baseUrl", "keyFile"].includes(key)) || value.name !== tier || typeof value.model !== "string" || !value.model.trim() || typeof value.baseUrl !== "string" || typeof value.keyFile !== "string" || !value.keyFile.startsWith("/")) throw new Error("INVALID_LIVE_ROUTES");
    const url = new URL(value.baseUrl);
    if (url.username || url.password || url.search || url.hash || url.pathname.replace(/\/$/, "") !== "/v1" || !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) throw new Error("INVALID_LIVE_ROUTES");
  }
  return input as Record<"cheap" | "strong", { name: string; model: string; baseUrl: string; keyFile: string }>;
}
interface Checkpoint { version: 1; binding: string; mode: "local" | "monad"; upstreamMode: string; rpcUrl: string; chainId: string;
  contracts: ContractAddresses; asset: string; agentId: string; roles: { poster: string; agent: string; verifier: string; refunder: string; underwriter: string };
  maxFeePerGas: string; ports: Partial<Record<"underwriter" | "relay" | "arena", number>>; ipcDirectory?: string;
  task?: { id: string; deadline: number }; client?: FixedTaskConfig; before?: Record<string, any> }
const hash = (input: unknown) => createHash("sha256").update(JSON.stringify(input)).digest("hex");
const safeError = (e: unknown) => /^[A-Z][A-Z0-9_]+$/.test((e as Error)?.message) ? (e as Error).message : "LIVE_FIXED_RUN_UNCONFIRMED";
async function optionalJson(path: string) { try { return JSON.parse(await readFile(path, "utf8")); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error("EVIDENCE_JSON_UNREADABLE"); } }
async function listen(server: ReturnType<typeof relayHttp>, port?: number) { server.listen(port ?? 0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }
async function restoreAnvil(rpcUrl: string, stateFile: string) {
  const port = new URL(rpcUrl).port; if (!/^\d+$/.test(port) || new URL(rpcUrl).hostname !== "127.0.0.1") throw new Error("INVALID_LOCAL_CHECKPOINT_RPC");
  const reservation = reservePort();
  await new Promise<void>((ready, reject) => { reservation.once("error", () => reject(new Error("LOCAL_ANVIL_PORT_UNAVAILABLE"))); reservation.listen(Number(port), "127.0.0.1", ready); });
  await new Promise<void>(ready => reservation.close(() => ready()));
  const child = spawn(process.env.ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", port, "--chain-id", "31337", "--accounts", "0", "--silent"], { stdio: "ignore" });
  try {
    const p = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    for (let i = 0; i < 100; i++) { if (child.exitCode !== null) throw new Error("LOCAL_ANVIL_PORT_UNAVAILABLE"); try { await p.send("eth_chainId", []); break; } catch { await delay(50); } }
    // Never use a different fixture, task or payment on resume.
    await p.send("anvil_loadState", [JSON.parse(await readFile(stateFile, "utf8"))]); return { child, provider: p };
  } catch (error) { await stopChild(child); throw error; }
}
/** Wallet remains a Wallet so SDK journals raw bytes before its first broadcast. */
export class BoundedWallet extends Wallet {
  constructor(key: string, provider: JsonRpcProvider, readonly feeCeiling: bigint, readonly gasCeiling: bigint) { super(key, provider); }
  override async populateTransaction(request: TransactionRequest) {
    const populated = await super.populateTransaction({ ...request, gasLimit: request.gasLimit ?? this.gasCeiling });
    if (BigInt(populated.gasLimit ?? 0) > this.gasCeiling || BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0n) > this.feeCeiling) throw new Error("GAS_CEILING_EXCEEDED");
    return populated;
  }
}
async function addresses(file: string | undefined): Promise<ContractAddresses> { if (!file) throw new Error("EXISTING_DEPLOYMENT_FILE_REQUIRED"); const data = await optionalJson(file); if (!data?.contracts) throw new Error("EXISTING_DEPLOYMENT_FILE_REQUIRED"); return data.contracts; }

/** Default is read-only. The test-only controlled fetch cannot be selected from the CLI. */
export async function verifyLiveFixedPrice(options: LiveFixedOptions, controlledFetch?: typeof fetch) {
  if (options.scenario !== undefined && !["strong-only", "catalog-once"].includes(options.scenario)) throw new Error("INVALID_LIVE_SCENARIO");
  if (options.scenario === "strong-only" && options.mode !== "local") throw new Error("STRONG_ONLY_LOCAL_REQUIRED");
  const problemId = options.problemId === undefined ? "sum-integers" : options.problemId;
  if (!isFixedProblemId(problemId)) throw new Error("INVALID_FIXED_PROBLEM");
  const scenario = options.scenario ?? (problemId !== "sum-integers" ? "catalog-once" : undefined);
  if (scenario === "catalog-once" && options.mode !== "local") throw new Error("CATALOG_LOCAL_REQUIRED");
  if (options.rpcTransport !== undefined && options.rpcTransport !== "direct" && options.rpcTransport !== "system-https-proxy") throw new Error("INVALID_RPC_TRANSPORT");
  const rpcTransport = options.mode === "monad" ? options.rpcTransport ?? "system-https-proxy" : "direct";
  const original = await loadMonadConfig(resolve(options.configFile)), output = resolve(options.output);
  const routes = options.routesFile ? await readLiveRoutes(resolve(options.routesFile)) : undefined;
  const plan = { ...LIVE_FIXED_PLAN, ...(scenario === "strong-only" ? { scenario, tiers: ["strong", "strong"] as const, maxRounds: 2, ...(problemId !== "sum-integers" ? { problemId } : {}) } : {}),
    ...(scenario === "catalog-once" ? { scenario, problemId, tiers: ["cheap"] as const, maxRounds: 1 } : {}),
    responseModels: LIVE_FIXED_PLAN.models, models: routes ? { cheap: routes.cheap.model, strong: routes.strong.model } : LIVE_FIXED_PLAN.models };
  const upstreamMode = controlledFetch ? "controlled" : routes ? "real-kimi-via-configured-gateway" : "real-kimi-system-https-proxy";
  const identityBinding = hash({ mode: options.mode, original, deployment: options.deploymentFile ? await addresses(options.deploymentFile) : null,
    agentId: options.agentId ?? (options.mode === "monad" ? "1977" : "1"), plan, routes, upstreamMode });
  if (options.resume && !options.execute) throw new Error("RESUME_REQUIRES_EXECUTE");
  if (options.maxFeePerGas && !/^[1-9][0-9]*$/.test(options.maxFeePerGas)) throw new Error("INVALID_GAS_CEILING");
  let checkpoint: Checkpoint | undefined, connection: Awaited<ReturnType<typeof monadProvider>> | undefined, provider: JsonRpcProvider | undefined;
  let anvil: ChildProcess | undefined, settler: ChildProcess | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined;
  let underwriter: Underwriter | undefined, relay: FixedPriceSolvingRelay | undefined, creditServer: ReturnType<typeof creditHttp> | undefined, computeServer: ReturnType<typeof relayHttp> | undefined;
  let arena: ReturnType<typeof createArenaHttpServer> | undefined, transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  let lock: SessionStore<Checkpoint> | undefined, report: Record<string, any> = { version: 1, upstreamMode, rpcTransport, mode: options.mode, plan, complete: false, paidModelEndpointNotCalled: true, attempts: [],
    ...(routes ? { routes: Object.fromEntries(Object.entries(routes).map(([tier, { keyFile: _, ...route }]) => [tier, route])) } : {}) };
  let client: FixedTaskSession | undefined;
  let outputAccepted = false, ownsIpc = false;
  const save = async (name: string, data: unknown) => { const path = join(output, name); await mkdir(resolve(path, ".."), { recursive: true, mode: 0o700 }); await saveJson(path, data); };
  const saveCheckpoint = () => lock!.write(checkpoint!);
  try {
    if (options.mode === "monad") {
      report.stage = "preflight-connect";
      connection = await monadProvider(options.rpcUrlFile ? await readRpcUrlFile(options.rpcUrlFile) : original.rpcUrl, rpcTransport); provider = connection.provider;
      const deployed = await addresses(options.deploymentFile);
      const config = { ...original, contracts: deployed };
      report.stage = "preflight-deployment";
      const contracts = await deployedContracts(config, provider, deployed), { account, manager, adapter } = contracts;
      const credit = new Underwriter({ rpcUrl: "https://testnet-rpc.monad.xyz", chainId: 10143n, managerAddress: deployed.manager, settlementAsset: original.asset.address,
        assetDecimals: 6, tokenUsdPrice: 10n ** 18n, privateKey: await readSecret(original.keyFiles.underwriter), evidenceDir: join(output, "underwriter"), host: "127.0.0.1", port: 0 }, provider);
      report.stage = "preflight-credit";
      let eligibility; try { eligibility = await credit.credit(BigInt(options.agentId ?? "1977")); } finally { credit.close(); }
      report.stage = "preflight-balances";
      const token = new Contract(original.asset.address, ["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)"], provider);
      const cash = BigInt(await read(account, "cash", [options.agentId ?? "1977"])), draw = 120000n > cash ? 120000n - cash : 0n;
      const feeCap = (await provider.getFeeData()).maxFeePerGas;
      if (!feeCap) throw new Error("FEE_DATA_UNAVAILABLE");
      const maxFeePerGas = options.maxFeePerGas ? BigInt(options.maxFeePerGas) : feeCap * 2n;
      const wallets = await Promise.all(["poster", "hero", "verifier", "refunder"].map(async role => ({ role, address: original.roles[role as keyof MonadConfig["roles"]], native: String(await provider!.getBalance(original.roles[role as keyof MonadConfig["roles"]])), usdc: String(await read(token, "balanceOf", [original.roles[role as keyof MonadConfig["roles"]]])) })));
      report.preflight = { readOnly: true, chainId: "10143", contracts: deployed, agentId: options.agentId ?? "1977", agentAddress: eligibility.identity.wallet,
        cash: cash.toString(), draw: draw.toString(), feeBps: eligibility.terms.feeBps.toString(), expectedFee: (draw * eligibility.terms.feeBps / 10000n).toString(),
        eligible: eligibility.eligible, rejection: eligibility.rejection, payTo: original.roles.refunder, refunderWhitelisted: await read(account, "providerWhitelist", [original.roles.refunder]),
        previousProviderWhitelisted: await read(account, "providerWhitelist", [original.roles.provider]), maxFeePerGas: maxFeePerGas.toString(), wallets,
        estimatedNativeCeilings: Object.fromEntries(Object.entries(LIVE_FIXED_PLAN.gasUnits).map(([role, units]) => [role, (BigInt(units) * maxFeePerGas).toString()])),
        vaultBalance: String(await read(manager, "vaultBalance")), identityChanged: await read(adapter, "identityChanged", [options.agentId ?? "1977"]),
        gasBudgetMeaning: "Gas units times fee ceiling; budget includes optional whitelist/approval and protected full refund, not model invoices" };
      report.stage = "preflight-complete";
      if (!options.execute) return report;
      if (!options.resume && (!eligibility.eligible || draw <= 0n || draw * (10000n + eligibility.terms.feeBps) > 150000n * 8000n || draw > BigInt(report.preflight.vaultBalance))) throw new Error("REAL_CREDIT_FUNDING_REQUIRED");
      if (!options.resume && !report.preflight.refunderWhitelisted && !options.enableRefunderProvider) throw new Error("REFUNDER_PROVIDER_WHITELIST_REQUIRED");
      if (!options.resume && eligibility.identity.wallet.toLowerCase() !== original.roles.hero.toLowerCase()) throw new Error("HERO_IDENTITY_MISMATCH");
      checkpoint = { version: 1, binding: identityBinding, mode: "monad", upstreamMode: report.upstreamMode, rpcUrl: "https://testnet-rpc.monad.xyz", chainId: "10143", contracts: deployed, asset: original.asset.address,
        agentId: options.agentId ?? "1977", roles: { poster: original.roles.poster, agent: original.roles.hero, verifier: original.roles.verifier, refunder: original.roles.refunder, underwriter: original.roles.underwriter }, maxFeePerGas: maxFeePerGas.toString(), ports: {} };
    } else if (!options.execute) return { ...report, preflight: { readOnly: true, chainId: "31337", newLocalFixtureOnly: true, cash: "40000", draw: "80000", feeBps: "1500", expectedFee: "12000", providerInitialTokenBalance: "0", privateKimiConfigurationValidated: true } };
    await mkdir(output, { recursive: true, mode: 0o700 });
    lock = new SessionStore<Checkpoint>(join(output, "runner")); await lock.start(options.recover);
    const previous = await lock.read();
    if (Boolean(options.resume) !== Boolean(previous)) throw new Error(previous ? "USE_SAME_OUTPUT_RESUME" : "RESUME_CHECKPOINT_REQUIRED");
    if (previous) {
      if (previous.binding !== identityBinding || previous.mode !== options.mode || previous.upstreamMode !== report.upstreamMode) throw new Error("RUN_CONFIG_MISMATCH");
      checkpoint = previous; report = await optionalJson(join(output, "report.json")) ?? report;
      const failureFields = ["error", "shutdownError", "evidenceError", "auditError"] as const;
      const previousFailure = Object.fromEntries(failureFields.filter(field => report[field] !== undefined).map(field => [field, report[field]]));
      if (Object.keys(previousFailure).length) report.failureHistory = [...(report.failureHistory ?? []), { recordedAtMs: Date.now(), stage: report.stage, ...previousFailure }];
      for (const field of failureFields) delete report[field];
      report.complete = false; report.stage = "resume-setup";
      const path = "scripts/verify-live-fixed-price.ts";
      report.resumeSourceHash = { path, sha256: createHash("sha256").update(await readFile(join(ROOT, path))).digest("hex") };
    }
    outputAccepted = true; // Neither a second writer nor a mismatched invocation may rewrite existing evidence.
    report.rpcTransport = rpcTransport;
    if (options.mode === "local") {
      if (previous) {
        const restored = await restoreAnvil(previous.rpcUrl, join(output, "anvil-state.json")); anvil = restored.child; provider = restored.provider;
        const priorSession = await optionalJson(join(output, "session/session.json")) as FixedTaskSession | undefined;
        if (priorSession?.inference) {
          const original = priorSession.inference.receipt;
          const [receipt, transaction, block] = await Promise.all([provider.getTransactionReceipt(original.txHash), provider.getTransaction(original.txHash), provider.getBlock(original.blockNumber)]);
          if (!receipt || !transaction || receipt.blockHash !== original.blockHash || block?.hash !== original.blockHash) throw new Error("LOCAL_SNAPSHOT_HISTORY_UNSUPPORTED");
          report.localSnapshotHistoryRestored = true;
        }
      }
      else {
        const local = await startAnvil(); anvil = local.child; f = await fixture(local.rpc, join(output, "fixture-underwriter"), 6, { refunderKey: key(4) }); provider = f.provider;
        await provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]); // Native gas only; no provider token mint.
        checkpoint = { version: 1, binding: identityBinding, mode: "local", upstreamMode: report.upstreamMode, rpcUrl: local.rpc, chainId: "31337", contracts: { manager: await f.manager.getAddress(), account: await f.account.getAddress(), adapter: await f.adapter.getAddress(), escrow: await f.escrow.getAddress() },
          asset: f.config.settlementAsset, agentId: "1", roles: { poster: new Wallet(key(1)).address, agent: new Wallet(key(2)).address, verifier: new Wallet(key(1)).address, refunder: f.payee, underwriter: new Wallet(key(3)).address }, maxFeePerGas: options.maxFeePerGas ?? "100000000000", ports: {} };
      }
    }
    if (!checkpoint || !provider) throw new Error("RUN_CHECKPOINT_REQUIRED");
    await saveCheckpoint(); report.chainId = checkpoint.chainId; report.contracts = checkpoint.contracts; report.roles = checkpoint.roles; report.agentId = checkpoint.agentId;
    report.sourceHashes ??= {};
    if (!previous) for (const path of ["scripts/verify-live-fixed-price.ts", "scripts/live-fixed-price-evidence.ts", "scripts/demo-journal.ts", "scripts/demo-rpc.ts", "scripts/demo-settler.ts", "packages/pi-loop/src/provider.ts", "packages/pi-loop/src/fixed-task.ts", "packages/pi-loop/src/submission.ts", "packages/pi-loop/src/session.ts", "packages/pi-loop/src/adapter.ts", "packages/pi-loop/src/public-sample.ts", "packages/sdk/src/index.ts", "packages/sdk/src/protocol.ts", "services/provider-relay/src/fixed-price.ts", "services/provider-relay/src/relay.ts", "services/provider-relay/src/refunder.ts", "services/arena/src/http.ts", "services/arena/src/problems.ts", "services/arena/src/controller.ts", "services/arena/src/settler.ts", "contracts/src/AgentAccount.sol", "contracts/src/CreditManager.sol", "contracts/src/TaskEscrow.sol"])
      report.sourceHashes[path] = createHash("sha256").update(await readFile(join(ROOT, path))).digest("hex");
    const chain = checkpoint, rpc = provider;
    report.roleReuse = { providerEqualsPoster: chain.roles.refunder === chain.roles.poster, providerEqualsRefunder: true,
      intentionalForThisService: true, previousDemoProviderAndConfigRetained: true, balanceBaselineAfterRewardEscrow: true };
    const c = Object.fromEntries(await Promise.all(Object.entries({ manager: "CreditManager", account: "AgentAccount", adapter: "ERC8004Adapter", escrow: "TaskEscrow" }).map(async ([field, name]) => [field, new Contract(chain.contracts[field as keyof ContractAddresses], (await artifact(name)).abi, rpc)]))) as Record<keyof ContractAddresses, Contract>;
    const token = new Contract(chain.asset, ["function balanceOf(address) view returns(uint256)", "function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"], rpc);
    const rawKey = async (role: "poster" | "hero" | "underwriter" | "refunder") => options.mode === "local" ? key({ poster: 1, hero: 2, underwriter: 3, refunder: 4 }[role]) : readSecret(original.keyFiles[role === "refunder" ? "deployer" : role]);
    const poster = new BoundedWallet(await rawKey("poster"), rpc, BigInt(chain.maxFeePerGas), 350000n), agent = new BoundedWallet(await rawKey("hero"), rpc, BigInt(chain.maxFeePerGas), 1000000n);
    assert.equal(poster.address.toLowerCase(), chain.roles.poster.toLowerCase()); assert.equal(agent.address.toLowerCase(), chain.roles.agent.toLowerCase());
    const refunderKey = await rawKey("refunder"); assert.equal(new Wallet(refunderKey).address.toLowerCase(), chain.roles.refunder.toLowerCase());
    if (options.mode === "monad") await checkVerifierKey(original.keyFiles.verifier, chain.roles.verifier);
    const journal = new DemoJournal(rpc, join(output, "transactions.json")); await journal.load();
    const operation = async (id: string, contract: Contract, method: string, args: unknown[], wallet: Wallet) => {
      const gasLimit = { approve: 100000n, setProviderWhitelist: 150000n, createTask: 300000n, acceptTask: 300000n }[method as "approve" | "setProviderWhitelist" | "createTask" | "acceptTask"];
      if (!journal.has(id)) await contract.connect(journal.signer(id, wallet)).getFunction(method)(...args, { gasLimit });
      const receipt = await journal.receipt(id); await save(`receipts/${id}.json`, receipt.toJSON()); return receipt;
    };
    const runner = new DockerExecutor(); await runner.ready();
    if (!await read(c.account, "providerWhitelist", [chain.roles.refunder])) {
      if (!options.enableRefunderProvider || options.mode !== "monad") throw new Error("REFUNDER_PROVIDER_WHITELIST_REQUIRED");
      await operation("refunder-provider-whitelist", c.account, "setProviderWhitelist", [chain.roles.refunder, true], poster);
    }
    if (!chain.task) {
      if (!journal.has("create-task")) {
        if ((await read(token, "balanceOf", [poster.address])) < 150000n) throw new Error("POSTER_REWARD_FUNDS_REQUIRED");
        if ((await read(token, "allowance", [poster.address, chain.contracts.escrow])) < 150000n) await operation("poster-approve", token, "approve", [chain.contracts.escrow, 150000n], poster);
      }
      const taskDeadline = (await rpc.getBlock("latest"))!.timestamp + 900;
      const receipt = await operation("create-task", c.escrow, "createTask", [150000n, taskDeadline], poster);
      const created = receipt.logs.map(log => { try { return c.escrow.interface.parseLog(log); } catch { return null; } }).find(event => event?.name === "TaskCreated");
      if (!created) throw new Error("TASK_CREATED_EVENT_REQUIRED");
      const task = await read(c.escrow, "getTask", [created.args.taskId]); chain.task = { id: String(created.args.taskId), deadline: Number(task.deadline) }; await saveCheckpoint();
    }
    if (!journal.has("accept-task") && (await read(c.escrow, "getTask", [chain.task.id])).status !== 1n) throw new Error("TASK_ASSIGNMENT_RECOVERY_REQUIRED");
    await operation("accept-task", c.escrow, "acceptTask", [chain.task.id, chain.agentId], agent);
    if (!chain.before) {
      chain.before = { cash: String(await read(c.account, "cash", [chain.agentId])), providerTokenBalance: String(await read(token, "balanceOf", [chain.roles.refunder])), agentNonce: await rpc.getTransactionCount(agent.address),
        loan: [...await read(c.manager, "getLoan", [chain.task.id])].map(String), taskStatus: String((await read(c.escrow, "getTask", [chain.task.id])).status), totalOutstanding: String(await read(c.manager, "totalOutstanding")) };
      if (BigInt(chain.before.cash) >= 120000n) throw new Error("REAL_CREDIT_FUNDING_REQUIRED"); await saveCheckpoint();
    }
    if (!chain.ipcDirectory) { chain.ipcDirectory = await mkdtemp(join(tmpdir(), "af-live-b-")); await saveCheckpoint(); }
    await prepareArenaIpc(chain.ipcDirectory, join(output, "settlement-journal.json"));
    ownsIpc = true;
    const arenaConfig: ArenaConfig = { rpcUrl: chain.rpcUrl, chainId: chain.chainId, escrowAddress: chain.contracts.escrow, ipcDirectory: chain.ipcDirectory,
      tasks: { [chain.task.id]: { agentId: chain.agentId, problemId } }, settlementTimeoutMs: options.mode === "monad" ? 180000 : 30000 };
    await save("arena-config.json", arenaConfig);
    // Local synthetic verifier file is private; Monad verifier remains exclusively in the independent child.
    let verifierFile = original.keyFiles.verifier;
    if (options.mode === "local") { verifierFile = join(output, "local-verifier.key"); await writeFile(verifierFile, key(1), { mode: 0o600 }); }
    settler = spawn(process.execPath, ["--import", "tsx", join(ROOT, "scripts/demo-settler.ts")], { cwd: ROOT, env: { PATH: process.env.PATH, ARENA_CONFIG: join(output, "arena-config.json"), ARENA_VERIFIER_KEY_FILE: verifierFile,
      ARENA_MAX_FEE_PER_GAS: chain.maxFeePerGas, ARENA_RPC_TRANSPORT: rpcTransport, ...(options.rpcUrlFile ? { ARENA_RPC_URL_FILE: resolve(options.rpcUrlFile) } : options.mode === "monad" ? { ARENA_RPC_CONFIG_FILE: resolve(options.configFile) } : {}) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((ready, reject) => {
      const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 90000);
      const done = (error?: Error) => { clearTimeout(timer); error ? reject(error) : ready(); };
      settler!.stdout!.on("data", data => { if (String(data).includes('"ready":true')) done(); }); settler!.stderr!.on("data", () => done(new Error("SETTLER_START_FAILED")));
      settler!.once("error", () => done(new Error("SETTLER_START_FAILED"))); settler!.once("exit", () => done(new Error("SETTLER_EXITED")));
    });
    report.independentSettler = { ready: true, sharesProcessWithSolver: false, verifier: chain.roles.verifier };
    arena = createArenaHttpServer(arenaConfig, [], rpc, { initial: await optionalJson(join(output, "arena-http-journal.json")) as ArenaHttpJournal | undefined, save: state => save("arena-http-journal.json", state) });
    chain.ports.arena = await listen(arena.server, chain.ports.arena); await saveCheckpoint();
    underwriter = new Underwriter({ rpcUrl: chain.rpcUrl, chainId: BigInt(chain.chainId), managerAddress: chain.contracts.manager, settlementAsset: chain.asset, assetDecimals: 6, tokenUsdPrice: 10n ** 18n,
      privateKey: await rawKey("underwriter"), evidenceDir: join(output, "underwriter"), host: "127.0.0.1", port: 0 }, rpc);
    await underwriter.initialize(); creditServer = creditHttp(underwriter); chain.ports.underwriter = await listen(creditServer, chain.ports.underwriter); await saveCheckpoint();
    const upstreamKey = controlledFetch || routes ? "unused-key" : await readSecret(original.upstream.apiKeyFile);
    const upstreams = await Promise.all((["cheap", "strong"] as const).map(async tier => ({ name: tier, model: plan.models[tier], baseUrl: routes?.[tier].baseUrl ?? original.upstream.baseUrl, key: controlledFetch ? "controlled-key" : routes ? await readSecret(routes[tier].keyFile) : upstreamKey })));
    if (!controlledFetch && !routes) transport = proxyUpstreamFetch(await systemHttpsProxy(), 120000);
    relay = new FixedPriceSolvingRelay({ rpcUrl: chain.rpcUrl, chainId: BigInt(chain.chainId), account: chain.contracts.account, asset: chain.asset, assetDecimals: 6, payTo: chain.roles.refunder,
      service: { id: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL, price: 120000n, upstreams },
      dataDir: join(output, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 120000, host: "127.0.0.1", port: 0, refunderKey, operatorToken: randomBytes(32).toString("hex") },
      { provider: rpc, runner, recoverLock: options.recover, modelFetch: async (url, init) => {
        const saved = await optionalJson(join(output, "session/session.json")) as FixedTaskSession;
        if (!saved?.handle) throw new Error("HANDLE_NOT_PERSISTED");
        const run = await optionalJson(join(output, "relay/solve-runs", saved.handle.quote.paymentId, "session.json")); const index = run?.rounds.length;
        if (!index || index > plan.maxRounds || report.attempts.some((a: any) => a.round === index) || Date.now() >= saved.config.deadlineMs) throw new Error("PAID_REQUEST_LIMIT_REACHED");
        assert.equal(run.rounds[index - 1].tier, plan.tiers[index - 1]);
        const request = JSON.parse(String(init?.body)); assert.deepEqual(request, run.rounds[index - 1].body); assert.equal(request.max_completion_tokens, plan.maxCompletionTokens); assert.equal(request.model, plan.models[run.rounds[index - 1].tier as "cheap" | "strong"]);
        const attempt: Record<string, any> = { round: index, paymentId: saved.handle.quote.paymentId, requestDigest: saved.handle.quote.requestDigest, requestedModel: request.model, state: "Dispatching" };
        report.attempts.push(attempt); report.paidModelEndpointNotCalled = false; await save(`round-${index}/request.json`, request); await save("report.json", report);
        const started = Date.now();
        try { const response = await (controlledFetch ?? transport?.fetch ?? fetch)(url, init); attempt.httpStatus = response.status;
          const responseBody = await response.clone().json(); await save(`round-${index}/response.json`, responseBody); attempt.state = "Responded";
          assert.equal(responseBody.model, plan.responseModels[run.rounds[index - 1].tier as "cheap" | "strong"]);
          attempt.returnedModel = responseBody.model; attempt.usage = responseBody.usage; attempt.finishReason = responseBody.choices?.[0]?.finish_reason; return response;
        } catch (error) { attempt.state = "Unknown"; attempt.error = safeError(error); throw error; }
        finally { attempt.durationMs = Date.now() - started; await save("report.json", report); }
      } });
    await relay.initialize(); const refunder = new FixedPriceRefunder(relay, { maxFeePerGas: BigInt(chain.maxFeePerGas), gasLimit: 400000n }); await refunder.initialize();
    computeServer = relayHttp(relay, refunder); chain.ports.relay = await listen(computeServer, chain.ports.relay); await saveCheckpoint();
    if (!chain.client) {
      const deadlineMs = Date.now() + plan.deadlineMs;
      chain.client = { taskId: chain.task.id, agentId: chain.agentId, rpcUrl: chain.rpcUrl, chainId: chain.chainId, account: chain.contracts.account, asset: chain.asset, provider: chain.roles.refunder,
        relayUrl: `http://127.0.0.1:${chain.ports.relay}/v1/chat`, underwriterUrl: `http://127.0.0.1:${chain.ports.underwriter}`, maxServicePrice: "120000", solve: { version: 1, problemId, tiers: [...plan.tiers], maxRounds: plan.maxRounds, maxToolCalls: plan.maxToolCalls, maxCompletionTokens: plan.maxCompletionTokens, deadlineMs },
        deadlineMs, arenaUrl: `http://127.0.0.1:${chain.ports.arena}`, escrowAddress: chain.contracts.escrow }; await saveCheckpoint();
    }
    report.stage = "fixed-price-purchase"; await save("report.json", report);
    client = await runFixedPriceTask(join(output, "session"), chain.client, { signer: agent, provider: rpc, runner, recoverLock: options.recover, timeoutMs: 180000, pollTimeoutMs: options.mode === "monad" ? 240000 : 30000 });
    report.clientPhase = client.phase; report.clientReason = client.reason; report.taskId = chain.task.id;
    if (!client.inference && client.handle) {
      const record = await relay.store.read(client.handle.quote.paymentId);
      const run = await optionalJson(join(output, "relay/solve-runs", client.handle.quote.paymentId, "session.json"));
      if (record.state !== "Delivered" && ["Unknown", "Undelivered"].includes(run?.phase)) {
        // Host operator only. Unknown upstream cost is borne by provider, never a new dispatch.
        const { id } = await import("ethers"); const refundId = id(`fixed-full-refund:${client.handle.quote.paymentId}`);
        await refunder.refund(client.handle.quote.paymentId, refundId, client.handle.quote.price);
        client = await runFixedPriceTask(join(output, "session"), chain.client, { signer: agent, provider: rpc, runner, recoverLock: options.recover, timeoutMs: 30000 });
        report.clientPhase = client.phase; report.clientReason = client.reason;
      }
    }
    report.complete = client.phase === "Succeeded"; report.outcome = client.phase;
    await save("session-result.json", client);
  } catch (error) { report.error = safeError(error); report.complete = false; }
  finally {
    // Stop admission and finish any in-flight controller/settlement before capturing chain evidence.
    try { await closeServer(computeServer); await closeServer(creditServer); await arena?.close(); }
    catch (error) { report.shutdownError = safeError(error); report.complete = false; }
    // Raw chain evidence is saved before any server/chain shutdown, on both success and failure.
    try {
      if (checkpoint && provider && outputAccepted) {
        const s = await optionalJson(join(output, "session/session.json")) as FixedTaskSession | undefined;
        if (s) { client = s; report.taskId = s.config.taskId; await save("session-result.json", s);
          if (s.handle) { const record = await optionalJson(join(output, "relay", `${s.handle.quote.paymentId}.json`));
            const hashes = [s.handle.submission?.txHash, ...((record?.refunds ?? []).flatMap((entry: any) => [entry.approval?.txHash, entry.transaction?.txHash]))].filter(Boolean);
            for (const txHash of hashes) { const raw = await provider.getTransactionReceipt(txHash); if (raw) await save(`receipts/${txHash}.json`, raw.toJSON()); }
          }
        }
        const transactions = await optionalJson(join(output, "transactions.json"));
        for (const [id, entry] of Object.entries(transactions ?? {}) as [string, any][]) { const raw = await provider.getTransactionReceipt(entry.txHash); if (raw) await save(`receipts/${id}.json`, raw.toJSON()); }
        if (checkpoint.ipcDirectory) { const journal = await optionalJson(join(checkpoint.ipcDirectory, "settlements.json"));
          if (journal) { await save("settlement-journal.json", journal); for (const entry of Object.values(journal) as any[]) { const raw = await provider.getTransactionReceipt(entry.txHash); if (raw) await save(`receipts/${entry.txHash}.json`, raw.toJSON()); } }
        }
        if (checkpoint.task) {
          const manager = new Contract(checkpoint.contracts.manager, (await artifact("CreditManager")).abi, provider), account = new Contract(checkpoint.contracts.account, (await artifact("AgentAccount")).abi, provider), escrow = new Contract(checkpoint.contracts.escrow, (await artifact("TaskEscrow")).abi, provider), token = new Contract(checkpoint.asset, ["function balanceOf(address) view returns(uint256)"], provider);
          report.chain = { chainId: checkpoint.chainId, taskId: checkpoint.task.id, agentId: checkpoint.agentId, account: checkpoint.contracts.account, manager: checkpoint.contracts.manager, escrow: checkpoint.contracts.escrow, asset: checkpoint.asset,
            agentAddress: checkpoint.roles.agent, provider: checkpoint.roles.refunder, verifier: checkpoint.roles.verifier, underwriter: checkpoint.roles.underwriter, before: checkpoint.before,
            after: { cash: String(await read(account, "cash", [checkpoint.agentId])), providerTokenBalance: String(await read(token, "balanceOf", [checkpoint.roles.refunder])), agentNonce: await provider.getTransactionCount(checkpoint.roles.agent),
              loan: [...await read(manager, "getLoan", [checkpoint.task.id])].map(String), taskStatus: String((await read(escrow, "getTask", [checkpoint.task.id])).status), totalOutstanding: String(await read(manager, "totalOutstanding")) } };
        }
        if (checkpoint.mode === "local") { report.anvilClientVersion = await provider.send("web3_clientVersion", []); await save("anvil-state.json", await provider.send("anvil_dumpState", [])); }
      }
    } catch (error) { report.evidenceError = safeError(error); report.complete = false; }
    if (options.execute && outputAccepted) await save("report.json", report);
    await stopChild(settler);
    if (ownsIpc && checkpoint?.ipcDirectory) await backupAndRemoveArenaIpc(checkpoint.ipcDirectory, join(output, "settlement-journal.json"));
    relay?.close(); underwriter?.close(); transport?.close(); await f?.close();
    if (!f && options.mode === "local") provider?.destroy(); connection?.close(); await stopChild(anvil); await lock?.close();
  }
  if (report.complete) { try { report.audit = await auditSavedFixedPrice(output); } catch { report.complete = false; report.auditError = "FIXED_PRICE_EVIDENCE_INVALID"; } await save("report.json", report); }
  return report;
}

/** Fixed local four-task batch. Every original task owns its one-dispatch journal; no failed task is replaced. */
export async function verifyLiveFixedCatalog(options: Omit<LiveFixedOptions, "scenario" | "problemId">, controlledFetch?: typeof fetch) {
  if (options.mode !== "local") throw new Error("CATALOG_LOCAL_REQUIRED");
  if ("scenario" in options || "problemId" in options) throw new Error("CATALOG_FIXED_TASKS_REQUIRED");
  if (options.resume && !options.execute) throw new Error("RESUME_REQUIRES_EXECUTE");
  const original = await loadMonadConfig(resolve(options.configFile)), routes = options.routesFile ? await readLiveRoutes(resolve(options.routesFile)) : undefined;
  const output = resolve(options.output), upstreamMode = controlledFetch ? "controlled" : routes ? "real-kimi-via-configured-gateway" : "real-kimi-system-https-proxy";
  const binding = hash({ original, routes, upstreamMode, plan: LIVE_FIXED_CATALOG_PLAN });
  const fresh = { version: 1, binding, plan: LIVE_FIXED_CATALOG_PLAN, upstreamMode, complete: false, modelCalls: 0,
    runs: LIVE_FIXED_CATALOG_PLAN.problemIds.map(problemId => ({ problemId, output: join(output, problemId), started: false, complete: false })) };
  if (!options.execute) return { ...fresh, paidModelEndpointNotCalled: true, preflight: { readOnly: true, newLocalFixturesOnly: true } };
  const journal = new SessionStore<typeof fresh>(join(output, "catalog")); await journal.start(options.recover);
  try {
    const previous = await journal.read();
    if (Boolean(previous) !== Boolean(options.resume)) throw new Error(previous ? "USE_SAME_OUTPUT_RESUME" : "RESUME_CHECKPOINT_REQUIRED");
    if (previous && (previous.binding !== binding || hash(previous.plan) !== hash(LIVE_FIXED_CATALOG_PLAN))) throw new Error("RUN_CONFIG_MISMATCH");
    const state = previous ?? fresh;
    assert.equal(state.runs.length, LIVE_FIXED_CATALOG_PLAN.problemIds.length);
    state.runs.forEach((entry, index) => { assert.equal(entry.problemId, LIVE_FIXED_CATALOG_PLAN.problemIds[index]); assert.equal(entry.output, join(output, entry.problemId)); });
    const refreshModelCalls = async () => {
      let calls = 0;
      for (const entry of state.runs) {
        const report = await optionalJson(join(entry.output, "report.json"));
        if (!report) { assert.equal(entry.complete, false); continue; }
        assert.equal(report.plan.scenario, "catalog-once"); assert.equal(report.plan.problemId, entry.problemId);
        assert.equal(report.plan.maxRounds, 1); assert.deepEqual(report.plan.tiers, ["cheap"]); assert.equal(report.upstreamMode, upstreamMode);
        assert.deepEqual(report.plan.models, routes ? { cheap: routes.cheap.model, strong: routes.strong.model } : LIVE_FIXED_PLAN.models);
        assert.ok(Array.isArray(report.attempts) && report.attempts.length <= LIVE_FIXED_CATALOG_PLAN.maxRoundsPerTask);
        calls += report.attempts.length;
      }
      assert.ok(calls <= LIVE_FIXED_CATALOG_PLAN.maxModelCalls); state.modelCalls = calls;
    };
    const save = async () => { await journal.write(state); await saveJson(join(output, "catalog-report.json"), state); };
    await refreshModelCalls();
    await save();
    for (const [index, entry] of state.runs.entries()) {
      assert.equal(entry.problemId, LIVE_FIXED_CATALOG_PLAN.problemIds[index]); assert.equal(entry.output, join(output, entry.problemId));
      if (entry.complete) { const audit = await auditSavedFixedPrice(entry.output); assert.equal(audit.problemId, entry.problemId); assert.equal(audit.scenario, "catalog-once"); continue; }
      const childCheckpoint = await optionalJson(join(entry.output, "runner/session.json"));
      entry.started = true; await save();
      const report = await verifyLiveFixedPrice({ ...options, output: entry.output, scenario: "catalog-once", problemId: entry.problemId, resume: Boolean(childCheckpoint) }, controlledFetch);
      entry.complete = report.complete;
      await refreshModelCalls(); await save();
      if (!report.complete) {
        const stopped = { ...state, stoppedAt: entry.problemId, error: report.error ?? report.clientReason ?? report.auditError ?? "TASK_NOT_CONFIRMED" };
        await saveJson(join(output, "catalog-report.json"), stopped); return stopped;
      }
    }
    state.complete = true; await save(); return state;
  } finally { await journal.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2), value = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
  if (args.includes("--audit-output")) auditSavedFixedPrice(value("--audit-output")!).then(x => console.log(JSON.stringify(x))).catch(() => { console.error("FIXED_PRICE_EVIDENCE_INVALID"); process.exitCode = 1; });
  else if (args.includes("--scenario") && (args.filter(arg => arg === "--scenario").length !== 1 || !["strong-only", "catalog-once"].includes(value("--scenario") ?? ""))) { console.error("INVALID_LIVE_SCENARIO"); process.exitCode = 1; }
  else if (value("--scenario") === "strong-only" && value("--mode") !== "local") { console.error("STRONG_ONLY_LOCAL_REQUIRED"); process.exitCode = 1; }
  else if (args.includes("--problem-id") && (args.filter(arg => arg === "--problem-id").length !== 1 || !isFixedProblemId(value("--problem-id")))) { console.error("INVALID_FIXED_PROBLEM"); process.exitCode = 1; }
  else if (args.includes("--catalog") && (args.includes("--scenario") || args.includes("--problem-id"))) { console.error("CATALOG_FIXED_TASKS_REQUIRED"); process.exitCode = 1; }
  else if ((args.includes("--catalog") || value("--scenario") === "catalog-once" || value("--problem-id") && value("--problem-id") !== "sum-integers") && value("--mode") !== "local") { console.error("CATALOG_LOCAL_REQUIRED"); process.exitCode = 1; }
  else if (args.includes("--rpc-transport") && !["direct", "system-https-proxy"].includes(value("--rpc-transport") ?? "")) { console.error("INVALID_RPC_TRANSPORT"); process.exitCode = 1; }
  else if (!value("--config") || !value("--output") || !["local", "monad"].includes(value("--mode") ?? "")) { console.error("Usage: tsx scripts/verify-live-fixed-price.ts --mode local|monad --config PRIVATE_CONFIG --output OUTPUT [--catalog (local only) | --problem-id sum-integers|unique-sorted|balanced-brackets|word-frequency] [--scenario strong-only|catalog-once (local only)] [--deployment MANIFEST --rpc-url-file PRIVATE_RPC --rpc-transport direct|system-https-proxy --enable-refunder-provider] [--execute --resume --recover --max-fee-per-gas WEI]"); process.exitCode = 1; }
  else {
    const options = { mode: value("--mode") as "local" | "monad", configFile: value("--config")!, output: value("--output")!, deploymentFile: value("--deployment"), rpcUrlFile: value("--rpc-url-file"), agentId: value("--agent-id"),
      execute: args.includes("--execute"), resume: args.includes("--resume"), recover: args.includes("--recover"), enableRefunderProvider: args.includes("--enable-refunder-provider"), rpcTransport: value("--rpc-transport") as RpcTransport | undefined, maxFeePerGas: value("--max-fee-per-gas"), routesFile: value("--routes") };
    const run = args.includes("--catalog") ? verifyLiveFixedCatalog(options) : verifyLiveFixedPrice({ ...options, scenario: value("--scenario") as LiveFixedOptions["scenario"], problemId: value("--problem-id") as ProblemId | undefined });
    run.then(report => { console.log(JSON.stringify(report)); if ("error" in report && report.error || args.includes("--execute") && !report.complete) process.exitCode = 1; }).catch(error => { console.error(safeError(error)); process.exitCode = 1; });
  }
}
