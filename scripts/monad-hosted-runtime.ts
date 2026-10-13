import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, Wallet, getAddress, ZeroAddress } from "ethers";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import type { WorkflowConfig } from "../packages/pi-loop/src/workflow.js";
import { isFixedProblemId } from "../packages/pi-loop/src/public-sample.js";
import { DockerExecutor } from "../services/arena/src/docker.js";
import { createArenaHttpServer, type ArenaHttpJournal } from "../services/arena/src/http.js";
import { atomicJson, ESCROW_ABI, type ArenaConfig } from "../services/arena/src/protocol.js";
import { Underwriter } from "../services/underwriter/src/underwriter.js";
import { createHttpServer as creditHttp } from "../services/underwriter/src/http.js";
import { FixedPriceSolvingRelay, FixedPriceRefunder, FIXED_SOLVE_MODEL, FIXED_SOLVE_SERVICE } from "../services/provider-relay/src/fixed-price.js";
import { InferenceAllowanceRelay, ALLOWANCE_MODEL, ALLOWANCE_SERVICE } from "../services/provider-relay/src/allowance.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer as relayHttp } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { modelCatalogDigest } from "../services/hosted-agents/src/metered-task.js";
import { validateGatewayCatalog, type GatewayModel } from "../services/hosted-agents/src/inference-gateway.js";
import { verifyHostedAllowanceClosure } from "../services/hosted-agents/src/allowance-closure-reader.js";
import { loadHostedDaemonConfig } from "./hosted-agents.js";
import { MONAD_IDENTITY, MONAD_USDC, readSecret, type ContractAddresses } from "./demo-monad-config.js";
import { checkVerifierKey } from "./demo-monad.js";
import { monadProvider, readRpcUrlFile, type RpcTransport } from "./demo-rpc.js";
import { prepareArenaIpc, backupAndRemoveArenaIpc } from "./demo-arena-state.js";

/** Operator-prepared, existing deployment and task catalog. This script never bootstraps chain state. */
export interface MonadHostedBootstrap {
  version: 1; chainId: "10143"; contracts: ContractAddresses; deploymentBlock: number;
  asset: { address: string; symbol: "USDC"; decimals: 6 }; identity: string; payTo: string;
  publicRpcUrl: string; rpcUrlFile: string; rpcTransport: RpcTransport;
  roleKeyFiles: Record<"guardian" | "underwriter" | "verifier" | "refunder" | "sponsor" | "opponent", string>;
  opponentBinding: { chainId: "10143"; agentId: string; wallet: string };
  /** Real, operator-selected chain identities for the public protocol dashboard. */
  dashboardAgents: { id: string; name: string }[];
  gatewayReadyFile: string; vendorKeyFile: string; tasks: WorkflowConfig["tasks"];
  maxFeePerGas: string; frontendOrigin: "http://127.0.0.1:3024";
}
type PortName = "underwriter" | "arena" | "fixed" | "allowance" | "planner";
interface CatalogMigration {
  id: string; status: "Intent" | "Applied"; createdAt: string; appliedAt?: string;
  beforeBinding: string; afterBinding: string; before: MonadHostedBootstrap; after: MonadHostedBootstrap;
  appended: WorkflowConfig["tasks"];
}
interface RuntimeJournal {
  version: 1; binding: string; startedAt: string; templateDeadlineMs: number; ipcDirectory: string; operatorToken: string; ports: Partial<Record<PortName, number>>;
  originalBootstrap?: MonadHostedBootstrap; originalCatalog?: WorkflowConfig["tasks"];
  effectiveBinding?: string; migrations?: CatalogMigration[];
}
interface GatewayReady { url: string; endpoint: string; keyFile: string; models: GatewayModel[] }
const fail = (code: string): never => { throw new Error(code); };
const safe = (error: unknown) => /^[A-Z][A-Z0-9_]{1,100}$/.test((error as Error)?.message) ? (error as Error).message : "MONAD_HOSTED_RUNTIME_FAILED";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function runtimeBinding(bootstrap: MonadHostedBootstrap, gateway: GatewayReady, catalog: GatewayModel[]) {
  const { dashboardAgents: _dashboardAgents, ...executionBootstrap } = bootstrap;
  return hash({ bootstrap: executionBootstrap, gateway: { url: gateway.url, endpoint: gateway.endpoint, keyFile: gateway.keyFile }, catalog });
}
const address = (value: string) => { const result = getAddress(value); if (result === ZeroAddress) fail("MONAD_ADDRESS_INVALID"); return result; };
const same = (a: string, b: string) => address(a) === address(b);
const absolute = (value: string) => { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail("MONAD_ABSOLUTE_PATH_REQUIRED"); return value; };
async function optionalJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
export async function loadMonadHostedBootstrap(file: string) {
  const b = JSON.parse(await readFile(absolute(file), "utf8")) as MonadHostedBootstrap;
  if (b.version !== 1 || b.chainId !== "10143" || !Number.isSafeInteger(b.deploymentBlock) || b.deploymentBlock < 0
    || b.asset?.symbol !== "USDC" || b.asset.decimals !== 6 || !same(b.asset.address, MONAD_USDC) || !same(b.identity, MONAD_IDENTITY)
    || !["direct", "system-https-proxy"].includes(b.rpcTransport) || b.frontendOrigin !== "http://127.0.0.1:3024"
    || !/^[1-9][0-9]*$/.test(b.maxFeePerGas)) fail("MONAD_BOOTSTRAP_INVALID");
  for (const value of Object.values(b.contracts)) address(value);
  if (Object.keys(b.contracts).sort().join(",") !== "account,adapter,escrow,manager" || new Set(Object.values(b.contracts).map(address)).size !== 4) fail("MONAD_CONTRACTS_INVALID");
  address(b.payTo); address(b.opponentBinding.wallet);
  if (b.opponentBinding.chainId !== "10143" || !/^[1-9][0-9]*$/.test(b.opponentBinding.agentId)) fail("MONAD_OPPONENT_INVALID");
  if (!Array.isArray(b.dashboardAgents) || b.dashboardAgents.length < 3 || b.dashboardAgents.length > 12
    || new Set(b.dashboardAgents.map(agent => agent.id)).size !== b.dashboardAgents.length
    || b.dashboardAgents.some(agent => !/^[1-9][0-9]{0,77}$/.test(agent.id) || BigInt(agent.id) >= 2n ** 256n
      || typeof agent.name !== "string" || !agent.name.trim())) fail("MONAD_DASHBOARD_AGENTS_REQUIRED");
  const publicUrl = new URL(b.publicRpcUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) fail("MONAD_PUBLIC_RPC_INVALID");
  for (const role of ["guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent"] as const) absolute(b.roleKeyFiles[role]);
  if (Object.entries(b.roleKeyFiles).some(([role, path]) => role !== "verifier" && path === b.roleKeyFiles.verifier)) fail("MONAD_VERIFIER_ISOLATION_REQUIRED");
  for (const path of [b.rpcUrlFile, b.gatewayReadyFile, b.vendorKeyFile]) absolute(path);
  if (!Array.isArray(b.tasks) || b.tasks.length < 4 || new Set(b.tasks.map(t => t.taskId)).size !== b.tasks.length) fail("MONAD_TASK_CATALOG_REQUIRED");
  for (const task of b.tasks) if (!/^[1-9][0-9]*$/.test(task.taskId) || !isFixedProblemId(task.problemId)
    || !Number.isSafeInteger(task.deadlineMs) || task.deadlineMs <= 0 || task.creditLimit !== "80000") fail("MONAD_TASK_CATALOG_INVALID");
  const gateway = JSON.parse(await readFile(b.gatewayReadyFile, "utf8")) as GatewayReady;
  if (gateway.url !== "http://127.0.0.1:3426/v1" || gateway.endpoint !== `${gateway.url}/chat/completions` || gateway.models?.length !== 2) fail("MONAD_GATEWAY_INVALID");
  const catalog = validateGatewayCatalog(gateway.models.map((model, index) => ({ ...model, route: gateway.endpoint,
    inputMicroCreditsPerToken: index ? "3" : "1", outputMicroCreditsPerToken: index ? "6" : "2", maxCompletionTokens: 1024 }))) as [GatewayModel, GatewayModel];
  if (catalog[0].model !== "cheap/kimi-k2.6" || catalog[1].model !== "strong/kimi-k3" || catalog[0].responseModel !== "kimi-k2.6" || catalog[1].responseModel !== "kimi-k3") fail("MONAD_GATEWAY_MODELS_INVALID");
  absolute(gateway.keyFile);
  await Promise.all([readRpcUrlFile(b.rpcUrlFile), readSecret(b.vendorKeyFile), readSecret(gateway.keyFile)]);
  return { bootstrap: b, gateway, catalog };
}
/** Chain reads only. Verifier key bytes are read exclusively by the independent child. */
export async function checkMonadHostedBootstrap(file: string) {
  const loaded = await loadMonadHostedBootstrap(file), b = loaded.bootstrap;
  const connection = await monadProvider(await readRpcUrlFile(b.rpcUrlFile), b.rpcTransport);
  try {
    const p = connection.provider;
    if (BigInt(await p.send("eth_chainId", [])) !== 10143n) fail("MONAD_NETWORK_MISMATCH");
    for (const target of [...Object.values(b.contracts), b.identity, b.asset.address]) if (await p.getCode(target) === "0x") fail("MONAD_DEPLOYMENT_CODE_REQUIRED");
    const manager = new Contract(b.contracts.manager, ["function guardian() view returns(address)", "function underwriter() view returns(address)", "function relayRefunder() view returns(address)", "function agentAccount() view returns(address)", "function taskEscrow() view returns(address)", "function adapter() view returns(address)"], p);
    const account = new Contract(b.contracts.account, ["function settlementAsset() view returns(address)", "function creditManager() view returns(address)", "function providerWhitelist(address) view returns(bool)"], p);
    const adapter = new Contract(b.contracts.adapter, ["function identity() view returns(address)", "function resolveAgent(uint256) view returns(address owner,address wallet)", "function identityChanged(uint256) view returns(bool)"], p);
    const escrow = new Contract(b.contracts.escrow, ESCROW_ABI, p);
    const roleAddresses: Record<string, string> = {};
    for (const role of ["guardian", "underwriter", "refunder", "sponsor", "opponent"] as const) roleAddresses[role] = new Wallet(await readSecret(b.roleKeyFiles[role])).address;
    for (const [observed, expected] of await Promise.all([
      manager.guardian().then((value: string) => [value, roleAddresses.guardian]), manager.underwriter().then((value: string) => [value, roleAddresses.underwriter]),
      manager.relayRefunder().then((value: string) => [value, b.payTo]),
      manager.agentAccount().then((value: string) => [value, b.contracts.account]), manager.taskEscrow().then((value: string) => [value, b.contracts.escrow]),
      manager.adapter().then((value: string) => [value, b.contracts.adapter]), account.creditManager().then((value: string) => [value, b.contracts.manager]),
      account.settlementAsset().then((value: string) => [value, b.asset.address]), adapter.identity().then((value: string) => [value, b.identity]),
    ])) if (!same(observed, expected)) fail("MONAD_DEPLOYMENT_ROLE_MISMATCH");
    if (!same(roleAddresses.refunder, b.payTo) || !same(roleAddresses.opponent, b.opponentBinding.wallet)
      || ["guardian", "underwriter", "refunder", "sponsor"].some(role => same(roleAddresses[role], roleAddresses.opponent))) fail("MONAD_ROLE_BINDING_MISMATCH");
    if (!await account.providerWhitelist(b.payTo)) fail("MONAD_PROVIDER_NOT_WHITELISTED");
    const opponent = await adapter.resolveAgent(b.opponentBinding.agentId);
    if (!same(opponent.wallet, b.opponentBinding.wallet) || await adapter.identityChanged(b.opponentBinding.agentId)) fail("MONAD_OPPONENT_BINDING_MISMATCH");
    for (const agent of b.dashboardAgents) {
      const identity = await adapter.resolveAgent(agent.id);
      address(identity.owner); address(identity.wallet);
    }
    const verifier = await escrow.verifier();
    if (Object.values(roleAddresses).some(role => same(role, verifier))) fail("MONAD_VERIFIER_ISOLATION_REQUIRED");
    await checkVerifierKey(b.roleKeyFiles.verifier, verifier);
    const tasks = [];
    for (const task of b.tasks) {
      const chain = await escrow.getTask(task.taskId);
      if (Number(chain.deadline) * 1000 !== task.deadlineMs || chain.reward !== 150000n || chain.status === 0n) fail("MONAD_TASK_CHAIN_MISMATCH");
      tasks.push({ taskId: task.taskId, problemId: task.problemId, deadlineMs: task.deadlineMs, status: chain.status.toString(), agentId: chain.agentId.toString() });
    }
    return { checked: true, readOnly: true, chainId: "10143", taskCount: tasks.length, tasks, roles: { ...roleAddresses, verifier }, gasSponsorship: false };
  } finally { connection.close(); }
}
async function childReady(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(script), ...args], { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("MONAD_CHILD_START_TIMEOUT")), 90000);
      let output = "";
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : done(); };
      child.stdout!.on("data", chunk => { output += chunk.toString(); if (output.includes('"ready":true')) finish(); if (output.length > 8192) output = output.slice(-8192); });
      child.stderr!.on("data", () => { /* Never echo child RPC errors or private configuration. */ });
      child.once("error", () => finish(new Error("MONAD_CHILD_START_FAILED"))); child.once("exit", () => finish(new Error("MONAD_CHILD_EXITED")));
    });
    return child;
  } catch (error) { await stopChild(child); throw error; }
}
async function stopChild(child?: ChildProcess) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
async function listen(server: ReturnType<typeof relayHttp>, port?: number) { server.listen(port ?? 0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }

/** Pure validation: only additional tasks, never replacement/reordering of a saved catalog. */
export function appendTaskCatalog(original: WorkflowConfig["tasks"], additional: WorkflowConfig["tasks"]) {
  if (!Array.isArray(additional) || additional.length < 1 || additional.length > 16) fail("MONAD_TASK_ADDITIONS_REQUIRED");
  const ids = new Set(original.map(task => task.taskId));
  for (const task of additional) {
    if (!task || Object.keys(task).sort().join(",") !== "creditLimit,deadlineMs,problemId,taskId"
      || !/^[1-9][0-9]{0,77}$/.test(task.taskId) || ids.has(task.taskId) || !isFixedProblemId(task.problemId)
      || !Number.isSafeInteger(task.deadlineMs) || task.deadlineMs <= Date.now() || task.creditLimit !== "80000") fail("MONAD_TASK_APPEND_INVALID");
    ids.add(task.taskId);
  }
  return [...structuredClone(original), ...structuredClone(additional)];
}
async function portListening(port: number) {
  return new Promise<boolean>(done => {
    const socket = createConnection({ host: "127.0.0.1", port });
    const finish = (listening: boolean) => { socket.destroy(); done(listening); };
    socket.once("connect", () => finish(true)); socket.once("error", () => finish(false)); socket.setTimeout(1000, () => finish(true));
  });
}

/** Explicit offline configuration migration. No chain writes, HTTP business commands or model calls. */
export async function appendMonadHostedTasks(directory: string, bootstrapFile: string, additionalFile: string) {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile); additionalFile = absolute(additionalFile);
  const additional = JSON.parse(await readFile(additionalFile, "utf8")) as WorkflowConfig["tasks"];
  const store = new SessionStore<RuntimeJournal>(join(directory, "runtime-journal")); await store.start(true);
  const hostedLock = new SessionStore<{ runs: { status: string }[] }>(join(directory, "hosted", "database")); let hostedHeld = false;
  let connection: Awaited<ReturnType<typeof monadProvider>> | undefined;
  try {
    const state = await store.read() ?? fail("MONAD_RUNTIME_JOURNAL_REQUIRED");
    for (const port of [8792, ...Object.values(state.ports)]) if (await portListening(port)) fail("MONAD_RUNTIME_STOP_REQUIRED");
    try {
      const pid = Number((await readFile(join(state.ipcDirectory, "settler.owner"), "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid < 1) fail("MONAD_SETTLER_OWNER_INVALID");
      try { process.kill(pid, 0); fail("MONAD_RUNTIME_STOP_REQUIRED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await hostedLock.start(true); hostedHeld = true;
    const hosted = await hostedLock.read();
    if (!hosted || hosted.runs.some(run => !["Succeeded", "Failed"].includes(run.status))) fail("MONAD_TERMINAL_RUNS_REQUIRED");
    const { bootstrap: current, gateway, catalog } = await loadMonadHostedBootstrap(bootstrapFile);
    const currentBinding = runtimeBinding(current, gateway, catalog), id = hash(additional);
    if (state.originalBootstrap && (runtimeBinding(state.originalBootstrap, gateway, catalog) !== state.binding
      || hash(state.originalBootstrap.tasks) !== hash(state.originalCatalog))) fail("MONAD_ORIGINAL_CATALOG_INVALID");
    let migration = state.migrations?.find(entry => entry.id === id);
    if (migration && (runtimeBinding(migration.before, gateway, catalog) !== migration.beforeBinding
      || runtimeBinding(migration.after, gateway, catalog) !== migration.afterBinding
      || runtimeBinding({ ...migration.before, tasks: [...migration.before.tasks, ...migration.appended] }, gateway, catalog) !== migration.afterBinding)) fail("MONAD_MIGRATION_SNAPSHOT_INVALID");
    if (migration?.status === "Applied") {
      if (currentBinding !== state.effectiveBinding) fail("MONAD_RUNTIME_BINDING_CHANGED");
      return { applied: true, cached: true, migrationId: id, taskIds: migration.appended.map(task => task.taskId), chainWrites: 0 };
    }
    if (state.migrations?.some(entry => entry.status === "Intent" && entry.id !== id)) fail("MONAD_ORIGINAL_MIGRATION_REQUIRED");
    if (migration) {
      if (![migration.beforeBinding, migration.afterBinding].includes(currentBinding) || hash(migration.appended) !== id
        || (state.effectiveBinding ?? state.binding) !== migration.beforeBinding) fail("MONAD_MIGRATION_BINDING_CHANGED");
    } else {
      if (currentBinding !== (state.effectiveBinding ?? state.binding)) fail("MONAD_RUNTIME_BINDING_CHANGED");
      const after = { ...structuredClone(current), tasks: appendTaskCatalog(current.tasks, additional) };
      migration = { id, status: "Intent", createdAt: new Date().toISOString(), beforeBinding: currentBinding,
        afterBinding: runtimeBinding(after, gateway, catalog), before: structuredClone(current), after, appended: structuredClone(additional) };
    }
    // Even interrupted intents recheck each new task, never change a chain task.
    connection = await monadProvider(await readRpcUrlFile(current.rpcUrlFile), current.rpcTransport);
    const provider = connection.provider;
    if (BigInt(await provider.send("eth_chainId", [])) !== 10143n) fail("MONAD_NETWORK_MISMATCH");
    const escrow = new Contract(current.contracts.escrow, ESCROW_ABI, provider), latest = await provider.getBlock("latest") ?? fail("MONAD_LATEST_BLOCK_REQUIRED");
    for (const task of migration.appended) {
      const chain = await escrow.getTask(task.taskId);
      if (chain.status !== 1n || chain.agentId !== 0n || chain.reward !== 150000n || chain.escrowBalance !== 150000n
        || Number(chain.deadline) * 1000 !== task.deadlineMs || task.deadlineMs <= Math.max(Date.now(), latest.timestamp * 1000)) fail("MONAD_APPEND_OPEN_TASK_REQUIRED");
    }
    state.originalBootstrap ??= structuredClone(migration.before);
    state.originalCatalog ??= structuredClone(migration.before.tasks);
    if (!state.migrations?.some(entry => entry.id === id)) (state.migrations ??= []).push(migration);
    await store.write(state); // Original binding plus complete before/after snapshots precede the first config write.
    await atomicJson(bootstrapFile, { ...migration.after, dashboardAgents: current.dashboardAgents });
    migration.status = "Applied"; migration.appliedAt = new Date().toISOString(); state.effectiveBinding = migration.afterBinding;
    await store.write(state);
    return { applied: true, cached: false, migrationId: id, taskIds: migration.appended.map(task => task.taskId), chainWrites: 0,
      next: "start the same runtime with --recover; original ports, old run snapshots and settlement journal remain intact" };
  } finally { connection?.close(); if (hostedHeld) await hostedLock.close(); await store.close(); }
}

export async function startMonadHostedRuntime(directory: string, bootstrapFile: string, recover = false) {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile);
  const check = await checkMonadHostedBootstrap(bootstrapFile), { bootstrap: b, gateway, catalog } = await loadMonadHostedBootstrap(bootstrapFile);
  const store = new SessionStore<RuntimeJournal>(join(directory, "runtime-journal")); await store.start(recover);
  let connection: Awaited<ReturnType<typeof monadProvider>> | undefined, hosted: ChildProcess | undefined, settler: ChildProcess | undefined;
  let arena: ReturnType<typeof createArenaHttpServer> | undefined, underwriter: Underwriter | undefined;
  const servers: ReturnType<typeof relayHttp>[] = [], relays: Relay[] = [];
  let state: RuntimeJournal | undefined, reload: (() => void) | undefined, closing: Promise<void> | undefined, ownsIpc = false;
  const close = () => closing ??= (async () => {
    if (reload) process.off("SIGUSR2", reload);
    await stopChild(hosted);
    for (const server of servers) if (server.listening) await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
    await arena?.close(); await stopChild(settler);
    if (ownsIpc && state) await backupAndRemoveArenaIpc(state.ipcDirectory, join(directory, "settlement-journal.json"));
    for (const relay of relays) relay.close(); underwriter?.close(); connection?.close(); await store.close();
  })();
  try {
    // Public dashboard selection may change after enrolling hosted Agents; it does
    // not change the execution domain or invalidate the original payment journals.
    const binding = runtimeBinding(b, gateway, catalog);
    state = await store.read();
    if (state?.migrations?.some(entry => entry.status === "Intent")) fail("MONAD_MIGRATION_RECOVERY_REQUIRED");
    if (state && (state.effectiveBinding ?? state.binding) !== binding) fail("MONAD_RUNTIME_BINDING_CHANGED");
    if (state && !recover) fail("MONAD_RUNTIME_RECOVER_REQUIRED");
    if (!state) {
      if (check.tasks.some(task => task.status !== "1" || task.deadlineMs <= Date.now())) fail("MONAD_OPEN_TASKS_REQUIRED");
      state = { version: 1, binding, startedAt: new Date().toISOString(), templateDeadlineMs: Date.now() + 86400000,
        ipcDirectory: await mkdtemp("/tmp/af-monad-hosted-"), operatorToken: randomBytes(32).toString("hex"), ports: {},
        originalBootstrap: structuredClone(b), originalCatalog: structuredClone(b.tasks) };
      await store.write(state);
    }
    const journal = state;
    const runner = new DockerExecutor(); await runner.ready();
    connection = await monadProvider(await readRpcUrlFile(b.rpcUrlFile), b.rpcTransport); const rpc = connection.provider;
    const put = async (name: string, value: unknown) => { const path = join(directory, name); await atomicJson(path, value); return path; };
    const listening = async (name: PortName, server: ReturnType<typeof relayHttp>) => { servers.push(server); journal.ports[name] = await listen(server, journal.ports[name]); await store.write(journal); };
    const url = (name: PortName) => `http://127.0.0.1:${journal.ports[name]}`;
    await prepareArenaIpc(journal.ipcDirectory, join(directory, "settlement-journal.json")); ownsIpc = true;
    const arenaConfig: ArenaConfig = { rpcUrl: b.publicRpcUrl, chainId: b.chainId, escrowAddress: b.contracts.escrow, ipcDirectory: journal.ipcDirectory,
      tasks: Object.fromEntries(b.tasks.map(task => [task.taskId, { problemId: task.problemId }])), settlementTimeoutMs: 240000 };
    const arenaFile = await put("arena.json", arenaConfig);
    settler = await childReady("scripts/demo-settler.ts", [], { PATH: process.env.PATH, ARENA_CONFIG: arenaFile, ARENA_VERIFIER_KEY_FILE: b.roleKeyFiles.verifier,
      AGENTFUEL_RPC_RETRY_READ_503: process.env.AGENTFUEL_RPC_RETRY_READ_503, ARENA_MAX_FEE_PER_GAS: b.maxFeePerGas, ARENA_RPC_TRANSPORT: b.rpcTransport, ARENA_RPC_URL_FILE: b.rpcUrlFile });
    arena = createArenaHttpServer(arenaConfig, [], rpc, { initial: await optionalJson<ArenaHttpJournal>(join(directory, "arena-http-journal.json")), save: value => put("arena-http-journal.json", value).then(() => undefined) });
    journal.ports.arena = await listen(arena.server, journal.ports.arena); await store.write(journal);
    underwriter = new Underwriter({ rpcUrl: b.publicRpcUrl, chainId: 10143n, managerAddress: b.contracts.manager, settlementAsset: b.asset.address,
      assetDecimals: 6, tokenUsdPrice: 10n ** 18n, privateKey: await readSecret(b.roleKeyFiles.underwriter), evidenceDir: join(directory, "underwriter"), host: "127.0.0.1", port: 0 }, rpc);
    await underwriter.initialize(); await listening("underwriter", creditHttp(underwriter));
    const gatewayKey = await readSecret(gateway.keyFile);
    const base: RelayConfig = { rpcUrl: b.publicRpcUrl, chainId: 10143n, account: b.contracts.account, asset: b.asset.address, assetDecimals: 6, payTo: b.payTo,
      service: { id: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL, price: 120000n,
        upstreams: catalog.map((model, index) => ({ name: index ? "strong" : "cheap", model: model.model, baseUrl: gateway.url, key: gatewayKey })) },
      dataDir: join(directory, "fixed"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 120000, host: "127.0.0.1", port: 0,
      operatorToken: journal.operatorToken, refunderKey: await readSecret(b.roleKeyFiles.refunder) };
    const fixed = new FixedPriceSolvingRelay(base, { provider: rpc, runner, modelFetch: fetch, recoverLock: recover });
    relays.push(fixed); await fixed.initialize(); const fixedRefunder = new FixedPriceRefunder(fixed, { maxFeePerGas: BigInt(b.maxFeePerGas), gasLimit: 400000n }); await fixedRefunder.initialize();
    await listening("fixed", relayHttp(fixed, fixedRefunder));
    const allowance = new InferenceAllowanceRelay({ ...base, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
      upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
      { provider: rpc, creditsRaw: "200000", modelCatalogDigest: modelCatalogDigest(catalog),
        verifyAllowanceClosure: closure => verifyHostedAllowanceClosure(join(directory, "hosted"), closure) });
    const planner = new Relay({ ...base, dataDir: join(directory, "planner"), service: { id: "infercredit/plan", model: "logical-planner", price: 10000n,
      upstreams: [{ name: "magpie-cheap", model: catalog[0].model, baseUrl: gateway.url, key: gatewayKey }] } }, { provider: rpc });
    for (const [name, relay] of [["allowance", allowance], ["planner", planner]] as const) {
      relays.push(relay); await relay.initialize(); const refunder = new Refunder(relay, { maxFeePerGas: BigInt(b.maxFeePerGas), gasLimit: 400000n }); await refunder.initialize(); await listening(name, relayHttp(relay, refunder));
    }
    const walletDirectory = join(directory, "wallets"), models = ["kimi-k2.6", "kimi-k3"];
    const taskModels = models.map((id, index) => {
      const workflow: WorkflowConfig = { agentId: "1", chainId: "10143", account: b.contracts.account, asset: b.asset.address, escrowAddress: b.contracts.escrow,
        tasks: b.tasks, allowCredit: true, maxPrice: "120000", deadlineMs: journal.templateDeadlineMs, minRemainingMs: 60000, maxCompletionTokens: 1024,
        providers: [{ id: "trusted-fixed", payTo: b.payTo, relayUrl: `${url("fixed")}/v1/chat`, service: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL,
          routes: [{ tier: index ? "strong" : "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"],
            solve: { version: 1, tiers: index ? ["strong", "strong"] : ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 1024 } }] }] };
      return { id, physicalModels: { cheap: catalog[0].model, strong: catalog[1].model }, templates: Object.fromEntries(["conservative", "balanced", "aggressive"].map(strategy => [strategy, structuredClone(workflow)])) };
    });
    const taskConfigFile = await put("task.json", { version: 1, identity: b.identity, guardianKeyFile: b.roleKeyFiles.guardian, initialCashRaw: "0", rpcUrlFile: b.rpcUrlFile,
      rpcTransport: b.rpcTransport, publicRpcUrl: b.publicRpcUrl, walletDirectory, arenaUrl: url("arena"), underwriterUrl: url("underwriter"), models: taskModels,
      timeoutMs: 120000, pollTimeoutMs: 240000, metered: { relayUrl: `${url("allowance")}/v1/chat`, payTo: b.payTo, priceRaw: "120000", creditsRaw: "200000", catalog, keyFile: gateway.keyFile } });
    const gameConfigFile = await put("game.json", { version: 1, chainId: "10143", identity: b.identity, account: b.contracts.account, token: b.asset.address,
      rpcUrlFile: b.rpcUrlFile, rpcTransport: b.rpcTransport, upstreamTransport: "system-https-proxy", walletDirectory, sponsorKeyFile: b.roleKeyFiles.sponsor,
      opponent: { binding: b.opponentBinding, keyFile: b.roleKeyFiles.opponent, modelId: "kimi-k2.6", strategy: "balanced" },
      models: models.map(id => ({ id, baseUrl: "https://api.moonshot.cn/v1", keyFile: b.vendorKeyFile })), creditsDirectory: join(directory, "credits") });
    const hostedConfigFile = await put("hosted.json", { version: 1, port: 8792,
      hosted: { directory: join(directory, "hosted"), origin: b.frontendOrigin, chainId: "10143", models: models.map(id => ({ id, label: id === "kimi-k2.6" ? "Kimi K2.6" : "Kimi K3" })),
        maxAgentsPerOwner: 6, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" }, executor: { taskConfigFile, gameConfigFile },
      autonomy: { maxTasks: 2, maxDecisions: 3, durationMs: 1200000, plannerRelayUrl: `${url("planner")}/v1/chat`, plannerProvider: b.payTo, plannerPriceRaw: "10000",
        plannerService: "infercredit/plan", plannerModel: "logical-planner", plannerPhysicalModel: catalog[0].model, plannerResponseModel: catalog[0].responseModel } });
    await loadHostedDaemonConfig(hostedConfigFile);
    const launch = () => childReady("scripts/hosted-agents.ts", ["--start", "--recover"], { ...process.env, HOSTED_AGENTS_CONFIG: hostedConfigFile });
    hosted = await launch();
    let reloadPromise: Promise<void> | undefined;
    reload = () => { if (reloadPromise || closing) return; reloadPromise = (async () => { await stopChild(hosted); if (!closing) { hosted = await launch(); console.log("MONAD_HOSTED_RELOADED"); } })()
      .catch(() => { console.error("MONAD_HOSTED_RELOAD_FAILED"); }).finally(() => { reloadPromise = undefined; }); };
    process.on("SIGUSR2", reload);
    const manifestFile = await put("deployment.json", { chainId: "10143", network: "Monad Testnet · real Kimi models", deploymentBlock: b.deploymentBlock,
      rpcUrl: b.publicRpcUrl, underwriterUrl: url("underwriter"), explorerUrl: "https://testnet.monadexplorer.com", asset: b.asset, contracts: b.contracts,
      agents: b.dashboardAgents,
      providers: [{ name: "Monad allowance", address: b.payTo, relayUrl: `${url("allowance")}/v1/chat`, service: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL }], arenaUrl: url("arena") });
    const ready = { version: 1, pid: process.pid, startedAt: journal.startedAt, chainId: "10143", token: b.asset.address, identity: b.identity, account: b.contracts.account,
      hostedUrl: "http://127.0.0.1:8792", frontendOrigin: b.frontendOrigin, manifestFile, hostedConfigFile, gateway: gateway.url, models, taskCount: b.tasks.length,
      rpcUrlFile: b.rpcUrlFile, rpcTransport: b.rpcTransport, bootstrapFile,
      ports: journal.ports, gasSponsorship: false, registryMode: "canonical ERC8004", assetMode: "Monad test USDC", inference: "real Kimi K2.6/K3 via Magpie" };
    await put("ready.json", ready); return { ready, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, first, second, ...rest] = process.argv.slice(2);
  if (mode === "--check" && first && !second) checkMonadHostedBootstrap(resolve(first)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else if (mode === "append-tasks" && first && second && rest.length === 1)
    appendMonadHostedTasks(resolve(first), resolve(second), resolve(rest[0])).then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else if (mode === "start" && first && second && (rest.length === 0 || rest.length === 1 && rest[0] === "--recover"))
    startMonadHostedRuntime(resolve(first), resolve(second), rest.includes("--recover")).then(runtime => {
      console.log(JSON.stringify(runtime.ready)); const stop = () => { void runtime.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    }).catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else { console.error("Usage: monad-hosted-runtime.ts --check BOOTSTRAP | start DIRECTORY BOOTSTRAP [--recover] | append-tasks DIRECTORY BOOTSTRAP ADDITIONAL_TASKS_JSON"); process.exitCode = 1; }
}
