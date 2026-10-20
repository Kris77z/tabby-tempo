import { loadTestSponsorship, type TestSponsorshipState } from "../services/hosted-agents/src/test-sponsorship.js";
import { assertBoundedGameActor, loadBoundedGameAuthorization } from "../services/hosted-agents/src/bounded-game-authorization.js";
import type { HostedGoalConfig } from "../services/hosted-agents/src/goals/executor.js";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import { mkdtemp, readFile, lstat } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
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
import { readSecret, type ContractAddresses } from "./demo-monad-config.js";
import { TEMPO_IDENTITY, TEMPO_REPUTATION, TEMPO_PATH_USD, tempoPreflight } from "./tempo-config.js";
import { checkVerifierKey } from "./demo-monad.js";
import { chainRpcProvider, defaultUpstreamTransport, readRpcUrlFile, type RpcTransport } from "./demo-rpc.js";
import { prepareArenaIpc, backupAndRemoveArenaIpc } from "./demo-arena-state.js";
import { startExternalSpecialistStack } from "./external-specialist-stack.js";
import { taskPrivateFile } from "../packages/pi-loop/src/task-runner/config.js";
import { readTempoHostedFeatures, tempoFeaturePaths, tempoFeatureTaskDomain, tempoFeatureAutonomy, tempoFeatureBudgetFile, verifyTempoHostedFeatures, verifyTempoFeatureSeal, type TempoHostedFeaturesJournal } from "./tempo-hosted-features.js";
import { validateTempoTransactionBudget } from "./tempo-transaction-budget.js";
import { tempoHostedConfig } from "./tempo-hosted-config.js";
import type { HostedDaemonConfig } from "./hosted-agents.js";

/** Operator-prepared, existing deployment and task catalog. This script never bootstraps chain state. */
export interface TempoHostedBootstrap {
  version: 1; chainId: "42431"; contracts: ContractAddresses; deploymentBlock: number;
  asset: { address: string; symbol: "PathUSD"; decimals: 6 }; identity: string; reputation: string; payTo: string;
  publicRpcUrl: string; rpcUrlFile: string; rpcTransport: RpcTransport;
  roleKeyFiles: Record<"guardian" | "underwriter" | "verifier" | "refunder" | "sponsor" | "opponent", string>;
  opponentBinding: { chainId: "42431"; agentId: string; wallet: string };
  /** Real, operator-selected chain identities for the public protocol dashboard. */
  dashboardAgents: { id: string; name: string }[];
  gatewayReadyFile: string; vendorKeyFile: string; tasks: WorkflowConfig["tasks"];
  maxFeePerGas: string; frontendOrigin: string; hostedPort: number;
}
type PortName = "underwriter" | "arena" | "fixed" | "allowance" | "planner" | "goalCheap" | "goalStrong" | `external-${string}`;
interface CatalogMigration {
  id: string; status: "Intent" | "Applied"; createdAt: string; appliedAt?: string;
  beforeBinding: string; afterBinding: string; before: TempoHostedBootstrap; after: TempoHostedBootstrap;
  appended: WorkflowConfig["tasks"];
}
interface RuntimeJournal {
  version: 1; binding: string; startedAt: string; templateDeadlineMs: number; ipcDirectory: string; operatorToken: string; ports: Partial<Record<PortName, number>>;
  originalBootstrap?: TempoHostedBootstrap; originalCatalog?: WorkflowConfig["tasks"];
  testSponsorship?: RuntimeSponsorship;
  effectiveBinding?: string; migrations?: CatalogMigration[];
  features?: TempoHostedFeaturesJournal;
  publicOriginMigration?: { version: 1; id: string; fromOrigin: string; toOrigin: string; previousBinding: string; publicBinding: string; auditFile: string };
}
interface GatewayReady { url: string; endpoint: string; keyFile: string; models: GatewayModel[] }
const tempoProvider = (url: string, transport: RpcTransport) => chainRpcProvider(url, 42431n, transport);
const fail = (code: string): never => { throw new Error(code); };
const safe = (error: unknown) => /^[A-Z][A-Z0-9_]{1,100}$/.test((error as Error)?.message) ? (error as Error).message : "TEMPO_HOSTED_RUNTIME_FAILED";
function reportRuntimeError(error: unknown) {
  console.error(safe(error));
  if (safe(error) !== "TEMPO_HOSTED_RUNTIME_FAILED") return;
  const value = error as Error & { code?: unknown; cause?: { code?: unknown } };
  const code = [value?.code, value?.cause?.code].find(item => typeof item === "string" && /^[A-Z_0-9]{1,64}$/.test(item));
  const prefix = value?.message?.split(":")[0];
  const source = value?.stack?.match(/(?:scripts|services|packages)\/[A-Za-z0-9_./-]+\.[cm]?ts:\d+:\d+/)?.[0];
  console.error(JSON.stringify({ diagnostic: "TEMPO_RUNTIME_START", ...(code ? { code } : {}),
    ...(prefix && /^DOCKER_(?:UNAVAILABLE|IMAGE_MISSING)$/.test(prefix) ? { reason: prefix } : {}), ...(source ? { source } : {}) }));
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function runtimeBinding(bootstrap: TempoHostedBootstrap, gateway: Pick<GatewayReady, "url" | "endpoint" | "keyFile">, catalog: GatewayModel[]) {
  const { dashboardAgents: _dashboardAgents, ...executionBootstrap } = bootstrap;
  return hash({ bootstrap: executionBootstrap, gateway: { url: gateway.url, endpoint: gateway.endpoint, keyFile: gateway.keyFile }, catalog });
}
export { runtimeBinding as tempoRuntimeBinding };
export function tempoPublicOrigin(value: unknown): string {
  if (typeof value !== "string") return fail("TEMPO_PUBLIC_ORIGIN_INVALID");
  let url: URL; try { url = new URL(value); } catch { return fail("TEMPO_PUBLIC_ORIGIN_INVALID"); }
  if (url.protocol !== "https:" || url.origin !== value || url.username || url.password || url.pathname !== "/" || url.search || url.hash
    || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.[a-z]{2,}$/.test(url.hostname) || url.hostname.endsWith(".localhost")) fail("TEMPO_PUBLIC_ORIGIN_INVALID");
  return value;
}
export function tempoFrontendOriginAllowed(value: unknown, publicOrigin = process.env.TEMPO_PUBLIC_ORIGIN): boolean {
  if (typeof value === "string" && /^http:\/\/127\.0\.0\.1:(?:[0-9]{4,5})$/.test(value)) return true;
  if (!publicOrigin || value !== publicOrigin) return false;
  try { return tempoPublicOrigin(publicOrigin) === value; } catch { return false; }
}
const address = (value: string) => { const result = getAddress(value); if (result === ZeroAddress) fail("TEMPO_ADDRESS_INVALID"); return result; };
const same = (a: string, b: string) => address(a) === address(b);
const absolute = (value: string) => { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail("TEMPO_ABSOLUTE_PATH_REQUIRED"); return value; };
async function optionalJson<T>(path: string): Promise<T | undefined> { try { return JSON.parse(await readFile(path, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; } }
export interface RuntimeSponsorship { file: string; digest: string; grantId: string }
/** Preserve the same private authorization across config regeneration, including after expiry. */
export async function preserveTempoRuntimeSponsorship(directory: string, origin: string, previous?: RuntimeSponsorship): Promise<RuntimeSponsorship | undefined> {
  const current = await optionalJson<{hosted?: {testSponsorshipFile?: string}}>(join(directory, "hosted.json"));
  const configured = current?.hosted?.testSponsorshipFile;
  if (previous && configured && configured !== previous.file) fail("TEMPO_SPONSORSHIP_BINDING_CHANGED");
  const file = previous?.file ?? configured;
  if (!file) return undefined;
  const loaded = await loadTestSponsorship(file, { chainId: "42431", origin });
  const observed = { file, digest: loaded.digest, grantId: loaded.grant.id };
  const primary = await optionalJson<{testSponsorship?: TestSponsorshipState}>(join(directory,"hosted","database","session.json"));
  if (previous && JSON.stringify(previous) !== JSON.stringify(observed)
    || !primary?.testSponsorship || primary.testSponsorship.digest !== loaded.digest
    || JSON.stringify(primary.testSponsorship.grant) !== JSON.stringify(loaded.grant)) fail("TEMPO_SPONSORSHIP_BINDING_CHANGED");
  return observed;
}
export const TEMPO_GOAL_PORTS = ["goalCheap", "goalStrong"] as const;
/** Logical aliases remain identical to the original paid catalog; physical/response models are separate. */
export function tempoGoalConfig(catalog: GatewayModel[], ports: Partial<Record<PortName,number>>, provider: string): HostedGoalConfig {
  return {durationMs:1200000, chainLookup:true, models:catalog.map((model,index)=>({id:["kimi-k2.6","kimi-k3"][index],
    relayUrl:`http://127.0.0.1:${ports[TEMPO_GOAL_PORTS[index]]}/v1/chat`, provider,
    priceRaw:index?"20000":"10000", service:"tabby/mission", model:model.id, physicalModel:model.model, responseModel:model.responseModel}))};
}
export async function loadTempoHostedBootstrap(file: string) {
  const b = JSON.parse(await readFile(absolute(file), "utf8")) as TempoHostedBootstrap;
  // Fail before reading gateway/role material or doing any RPC. Trusted process
  // launchers clear ambient variables, so operators must pass this explicitly.
  if (typeof b.frontendOrigin === "string" && b.frontendOrigin.startsWith("https:") && !process.env.TEMPO_PUBLIC_ORIGIN)
    fail("TEMPO_PUBLIC_ORIGIN_REQUIRED");
  if (b.version !== 1 || b.chainId !== "42431" || !Number.isSafeInteger(b.deploymentBlock) || b.deploymentBlock < 0
    || b.asset?.symbol !== "PathUSD" || b.asset.decimals !== 6 || !same(b.asset.address, TEMPO_PATH_USD) || !same(b.identity, TEMPO_IDENTITY) || !same(b.reputation, TEMPO_REPUTATION)
    || !["direct", "system-https-proxy"].includes(b.rpcTransport) || !tempoFrontendOriginAllowed(b.frontendOrigin) || !Number.isSafeInteger(b.hostedPort) || b.hostedPort < 1024 || b.hostedPort > 65535
    || !/^[1-9][0-9]*$/.test(b.maxFeePerGas)) fail("TEMPO_BOOTSTRAP_INVALID");
  for (const value of Object.values(b.contracts)) address(value);
  if (Object.keys(b.contracts).sort().join(",") !== "account,adapter,escrow,manager" || new Set(Object.values(b.contracts).map(address)).size !== 4) fail("TEMPO_CONTRACTS_INVALID");
  address(b.payTo); address(b.opponentBinding.wallet);
  if (b.opponentBinding.chainId !== "42431" || !/^[1-9][0-9]*$/.test(b.opponentBinding.agentId)) fail("TEMPO_OPPONENT_INVALID");
  if (!Array.isArray(b.dashboardAgents) || b.dashboardAgents.length < 3 || b.dashboardAgents.length > 12
    || new Set(b.dashboardAgents.map(agent => agent.id)).size !== b.dashboardAgents.length
    || b.dashboardAgents.some(agent => !/^[1-9][0-9]{0,77}$/.test(agent.id) || BigInt(agent.id) >= 2n ** 256n
      || typeof agent.name !== "string" || !agent.name.trim())) fail("TEMPO_DASHBOARD_AGENTS_REQUIRED");
  const publicUrl = new URL(b.publicRpcUrl);
  if (publicUrl.protocol !== "https:" || publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash) fail("TEMPO_PUBLIC_RPC_INVALID");
  for (const role of ["guardian", "underwriter", "verifier", "refunder", "sponsor", "opponent"] as const) absolute(b.roleKeyFiles[role]);
  if (Object.entries(b.roleKeyFiles).some(([role, path]) => role !== "verifier" && path === b.roleKeyFiles.verifier)) fail("TEMPO_VERIFIER_ISOLATION_REQUIRED");
  for (const path of [b.rpcUrlFile, b.gatewayReadyFile, b.vendorKeyFile]) absolute(path);
  if (!Array.isArray(b.tasks) || b.tasks.length < 4 || new Set(b.tasks.map(t => t.taskId)).size !== b.tasks.length) fail("TEMPO_TASK_CATALOG_REQUIRED");
  for (const task of b.tasks) if (!/^[1-9][0-9]*$/.test(task.taskId) || !isFixedProblemId(task.problemId)
    || !Number.isSafeInteger(task.deadlineMs) || task.deadlineMs <= 0 || task.creditLimit !== "80000") fail("TEMPO_TASK_CATALOG_INVALID");
  const gateway = JSON.parse(await readFile(b.gatewayReadyFile, "utf8")) as GatewayReady;
  if (!/^http:\/\/127\.0\.0\.1:[0-9]{4,5}\/v1$/.test(gateway.url) || gateway.endpoint !== `${gateway.url}/chat/completions` || gateway.models?.length !== 2) fail("TEMPO_GATEWAY_INVALID");
  const catalog = validateGatewayCatalog(gateway.models.map((model, index) => ({ ...model, route: gateway.endpoint,
    inputMicroCreditsPerToken: index ? "3" : "1", outputMicroCreditsPerToken: index ? "6" : "2", maxCompletionTokens: 1024 }))) as [GatewayModel, GatewayModel];
  if (catalog[0].model !== "cheap/kimi-k2.6" || catalog[1].model !== "strong/kimi-k3" || catalog[0].responseModel !== "kimi-k2.6" || catalog[1].responseModel !== "kimi-k3") fail("TEMPO_GATEWAY_MODELS_INVALID");
  absolute(gateway.keyFile);
  await Promise.all([readRpcUrlFile(b.rpcUrlFile), readSecret(b.vendorKeyFile), readSecret(gateway.keyFile)]);
  return { bootstrap: b, gateway, catalog };
}
/** Chain reads only. Verifier key bytes are read exclusively by the independent child. */
export async function checkTempoHostedBootstrap(file: string) {
  const loaded = await loadTempoHostedBootstrap(file), b = loaded.bootstrap;
  const connection = await tempoProvider(await readRpcUrlFile(b.rpcUrlFile), b.rpcTransport);
  try {
    const p = connection.provider;
    await tempoPreflight(p);
    if (BigInt(await p.send("eth_chainId", [])) !== 42431n) fail("TEMPO_NETWORK_MISMATCH");
    for (const target of [...Object.values(b.contracts), b.identity, b.asset.address]) if (await p.getCode(target) === "0x") fail("TEMPO_DEPLOYMENT_CODE_REQUIRED");
    const manager = new Contract(b.contracts.manager, ["function guardian() view returns(address)", "function underwriter() view returns(address)", "function relayRefunder() view returns(address)", "function agentAccount() view returns(address)", "function taskEscrow() view returns(address)", "function adapter() view returns(address)"], p);
    const account = new Contract(b.contracts.account, ["function settlementAsset() view returns(address)", "function creditManager() view returns(address)", "function providerWhitelist(address) view returns(bool)"], p);
    const adapter = new Contract(b.contracts.adapter, ["function identity() view returns(address)", "function reputation() view returns(address)", "function feedbackGasLimit() view returns(uint256)", "function resolveAgent(uint256) view returns(address owner,address wallet)", "function identityChanged(uint256) view returns(bool)"], p);
    const escrow = new Contract(b.contracts.escrow, ESCROW_ABI, p);
    const roleAddresses: Record<string, string> = {};
    for (const role of ["guardian", "underwriter", "refunder", "sponsor", "opponent"] as const) roleAddresses[role] = new Wallet(await readSecret(b.roleKeyFiles[role])).address;
    for (const [observed, expected] of await Promise.all([
      manager.guardian().then((value: string) => [value, roleAddresses.guardian]), manager.underwriter().then((value: string) => [value, roleAddresses.underwriter]),
      manager.relayRefunder().then((value: string) => [value, b.payTo]),
      manager.agentAccount().then((value: string) => [value, b.contracts.account]), manager.taskEscrow().then((value: string) => [value, b.contracts.escrow]),
      manager.adapter().then((value: string) => [value, b.contracts.adapter]), account.creditManager().then((value: string) => [value, b.contracts.manager]),
      account.settlementAsset().then((value: string) => [value, b.asset.address]), adapter.identity().then((value: string) => [value, b.identity]), adapter.reputation().then((value: string) => [value, b.reputation]),
    ])) if (!same(observed, expected)) fail("TEMPO_DEPLOYMENT_ROLE_MISMATCH");
    if (await adapter.feedbackGasLimit() !== 4_000_000n) fail("TEMPO_FEEDBACK_GAS_MISMATCH");
    if (!same(roleAddresses.refunder, b.payTo) || !same(roleAddresses.opponent, b.opponentBinding.wallet)
      || ["guardian", "underwriter", "refunder", "sponsor"].some(role => same(roleAddresses[role], roleAddresses.opponent))) fail("TEMPO_ROLE_BINDING_MISMATCH");
    if (!await account.providerWhitelist(b.payTo)) fail("TEMPO_PROVIDER_NOT_WHITELISTED");
    const opponent = await adapter.resolveAgent(b.opponentBinding.agentId);
    if (!same(opponent.wallet, b.opponentBinding.wallet) || await adapter.identityChanged(b.opponentBinding.agentId)) fail("TEMPO_OPPONENT_BINDING_MISMATCH");
    for (const agent of b.dashboardAgents) {
      const identity = await adapter.resolveAgent(agent.id);
      address(identity.owner); address(identity.wallet);
    }
    const verifier = await escrow.verifier();
    if (Object.values(roleAddresses).some(role => same(role, verifier))) fail("TEMPO_VERIFIER_ISOLATION_REQUIRED");
    await checkVerifierKey(b.roleKeyFiles.verifier, verifier);
    const tasks = [];
    for (const task of b.tasks) {
      const chain = await escrow.getTask(task.taskId);
      if (Number(chain.deadline) * 1000 !== task.deadlineMs || chain.reward !== 150000n || chain.status === 0n) fail("TEMPO_TASK_CHAIN_MISMATCH");
      tasks.push({ taskId: task.taskId, problemId: task.problemId, deadlineMs: task.deadlineMs, status: chain.status.toString(), agentId: chain.agentId.toString() });
    }
    return { checked: true, readOnly: true, chainId: "42431", taskCount: tasks.length, tasks, roles: { ...roleAddresses, verifier }, gasSponsorship: false };
  } finally { connection.close(); }
}
async function childReady(script: string, args: string[], env: NodeJS.ProcessEnv) {
  const child = spawn(process.execPath, ["--import", "tsx", resolve(script), ...args], { cwd: resolve("."), env, stdio: ["ignore", "pipe", "pipe"] });
  try {
    await new Promise<void>((done, reject) => {
      const timer = setTimeout(() => reject(new Error("TEMPO_CHILD_START_TIMEOUT")), 90000);
      let output = "";
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : done(); };
      child.stdout!.on("data", chunk => { output += chunk.toString(); if (output.includes('"ready":true')) finish(); if (output.length > 8192) output = output.slice(-8192); });
      child.stderr!.on("data", () => { /* Never echo child RPC errors or private configuration. */ });
      child.once("error", () => finish(new Error("TEMPO_CHILD_START_FAILED"))); child.once("exit", () => finish(new Error("TEMPO_CHILD_EXITED")));
    });
    return child;
  } catch (error) { await stopChild(child); throw error; }
}
async function stopChild(child?: ChildProcess) { if (!child || child.exitCode !== null || child.signalCode !== null) return; const exited = once(child, "exit"); child.kill("SIGTERM"); await exited; }
async function listen(server: ReturnType<typeof relayHttp>, port?: number) { server.listen(port ?? 0, "127.0.0.1"); await once(server, "listening"); return (server.address() as { port: number }).port; }

/** Pure validation: only additional tasks, never replacement/reordering of a saved catalog. */
export function appendTaskCatalog(original: WorkflowConfig["tasks"], additional: WorkflowConfig["tasks"]) {
  if (!Array.isArray(additional) || additional.length < 1 || additional.length > 16) fail("TEMPO_TASK_ADDITIONS_REQUIRED");
  const ids = new Set(original.map(task => task.taskId));
  for (const task of additional) {
    if (!task || Object.keys(task).sort().join(",") !== "creditLimit,deadlineMs,problemId,taskId"
      || !/^[1-9][0-9]{0,77}$/.test(task.taskId) || ids.has(task.taskId) || !isFixedProblemId(task.problemId)
      || !Number.isSafeInteger(task.deadlineMs) || task.deadlineMs <= Date.now() || task.creditLimit !== "80000") fail("TEMPO_TASK_APPEND_INVALID");
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

async function assertRuntimeStopped(state: RuntimeJournal, hostedPort: number) {
  for (const port of [hostedPort, ...Object.values(state.ports).filter((port): port is number => typeof port === "number")]) if (await portListening(port)) fail("TEMPO_RUNTIME_STOP_REQUIRED");
  try {
    const pid = Number((await readFile(join(state.ipcDirectory, "settler.owner"), "utf8")).trim());
    if (!Number.isSafeInteger(pid) || pid < 1) fail("TEMPO_SETTLER_OWNER_INVALID");
    try { process.kill(pid, 0); fail("TEMPO_RUNTIME_STOP_REQUIRED"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
}

/** Explicit stopped migration only. No service launch, RPC, model dispatch or
 * chain writes. The existing append-tasks migration must already be applied. */
export async function enableTempoHostedFeatures(directory: string, bootstrapFile: string, featuresFile: string) {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile); featuresFile = absolute(featuresFile);
  const { bootstrap: b, gateway, catalog } = await loadTempoHostedBootstrap(bootstrapFile);
  const desired = await readTempoHostedFeatures(featuresFile, directory, b), paths = tempoFeaturePaths(directory);
  const store = new SessionStore<RuntimeJournal>(join(directory, "runtime-journal")); await store.start(true);
  const hostedLock = new SessionStore<any>(join(directory, "hosted/database")); let hostedHeld = false;
  try {
    const journal = await store.read() ?? fail("TEMPO_RUNTIME_JOURNAL_REQUIRED");
    if ((journal.effectiveBinding ?? journal.binding) !== runtimeBinding(b, gateway, catalog) || journal.migrations?.some(m => m.status !== "Applied")) fail("TEMPO_RUNTIME_BINDING_CHANGED");
    await assertRuntimeStopped(journal, b.hostedPort);
    await hostedLock.start(true); hostedHeld = true;
    const hosted = await hostedLock.read();
    if (!hosted || !Array.isArray(hosted.runs) || hosted.runs.some((run: any) => !["Succeeded", "Failed"].includes(run.status) || run.recoverable !== false || run.result?.terminal !== true)
      || !Array.isArray(hosted.agents) || hosted.agents.some((agent: any) => agent.activeRequestId || agent.reservedRaw !== "0")) fail("TEMPO_TERMINAL_RUNS_REQUIRED");
    if (journal.features) {
      const existing = await verifyTempoHostedFeatures(journal.features, directory, b);
      if (!isDeepStrictEqual(existing!.config, desired.config)) fail("TEMPO_FEATURES_BINDING_INVALID");
      return { enabled: true, cached: true, featureId: existing!.config.id, taskIds: existing!.config.taskIds, chainWrites: 0 };
    }
    tempoFeatureTaskDomain(desired.config, b, journal);
    if (desired.config.taskTemplateDeadlineMs <= Date.now() + 60000) fail("TEMPO_FEATURES_TASK_DEADLINE_REQUIRED");
    const authorization = await loadBoundedGameAuthorization(desired.config.boundedGamesFile, { chainId: b.chainId, origin: b.frontendOrigin });
    const grant = authorization.grant, actor = hosted.agents.find((agent: any) => agent.id === grant.actor.hostedAgentId);
    if (!actor || hosted.boundedGames || grant.expiresAtMs <= Date.now() || grant.id === hosted.testSponsorship?.grant.id
      || (hosted.sponsoredOwners[grant.owner] ?? 0) !== grant.baselineOwnerGames || hosted.sponsoredTotal !== grant.baselineTotalGames
      || hosted.runs.some((run: any) => run.requestId === grant.parentRequestId) || hosted.creations.some((creation: any) => creation.requestId === grant.parentRequestId)) fail("TEMPO_FEATURES_GAME_AUTHORIZATION_INVALID");
    assertBoundedGameActor(grant, actor);
    validateTempoTransactionBudget(JSON.parse(await taskPrivateFile(desired.config.transactionBudgetFile)));
    const budgetDirectory = await lstat(resolve(desired.config.transactionBudgetFile, ".."));
    if (!budgetDirectory.isDirectory() || budgetDirectory.isSymbolicLink() || budgetDirectory.mode & 0o077 || budgetDirectory.uid !== process.getuid?.()) fail("TEMPO_FEATURES_BUDGET_DIRECTORY_INVALID");
    try { await lstat(paths.externalDirectory); fail("TEMPO_FEATURES_EXTERNAL_JOURNAL_EXISTS"); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await atomicJson(paths.file, desired.config);
    const frozen = await readTempoHostedFeatures(paths.file, directory, b);
    journal.features = { version: 1, file: paths.file, ...frozen };
    await store.write(journal);
    return { enabled: true, cached: false, featureId: frozen.config.id, taskIds: frozen.config.taskIds, chainWrites: 0 };
  } finally { if (hostedHeld) await hostedLock.close(); await store.close(); }
}

/** Explicit stopped exit from the acceptance budget. The operator supplies the
 * closure file; this operation only verifies it and freezes its raw digest. */
export async function sealTempoHostedFeatures(directory: string, bootstrapFile: string, closureFile = tempoFeaturePaths(directory).closureFile) {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile); closureFile = absolute(closureFile);
  if (closureFile !== tempoFeaturePaths(directory).closureFile) fail("TEMPO_FEATURES_BINDING_INVALID");
  const { bootstrap: b, gateway, catalog } = await loadTempoHostedBootstrap(bootstrapFile);
  const store = new SessionStore<RuntimeJournal>(join(directory, "runtime-journal")); await store.start(true);
  const hostedLock = new SessionStore<any>(join(directory, "hosted/database")); let hostedHeld = false;
  try {
    const journal = await store.read() ?? fail("TEMPO_RUNTIME_JOURNAL_REQUIRED");
    if ((journal.effectiveBinding ?? journal.binding) !== runtimeBinding(b, gateway, catalog) || journal.migrations?.some(m => m.status !== "Applied")) fail("TEMPO_RUNTIME_BINDING_CHANGED");
    await assertRuntimeStopped(journal, b.hostedPort); await hostedLock.start(true); hostedHeld = true;
    const hosted = await hostedLock.read();
    if (!hosted || !Array.isArray(hosted.runs) || hosted.runs.some((run: any) => !["Succeeded", "Failed"].includes(run.status) || run.recoverable !== false || run.result?.terminal !== true)
      || hosted.agents.some((agent: any) => agent.activeRequestId || agent.reservedRaw !== "0")) fail("TEMPO_TERMINAL_RUNS_REQUIRED");
    const record = await verifyTempoHostedFeatures(journal.features, directory, b) ?? fail("TEMPO_FEATURES_REQUIRED");
    const cached = !!record.seal;
    if (!cached) {
      const raw = await taskPrivateFile(closureFile);
      record.seal = { version: 1, file: closureFile, digest: createHash("sha256").update(raw).digest("hex") };
      await verifyTempoFeatureSeal(record, directory, true);
    }
    // Read before freezing the seal, so a missing/invalid generated config does
    // not leave an unusable partial seal. Both writes are replayable on retry.
    const configFile = join(directory, "hosted.json");
    const generated = JSON.parse(await taskPrivateFile(configFile)) as HostedDaemonConfig;
    if (generated.hosted?.boundedGamesFile !== record.config.boundedGamesFile || generated.hosted.directory !== join(directory, "hosted")) fail("TEMPO_FEATURES_BINDING_INVALID");
    await atomicJson(configFile, tempoHostedConfig(generated, true));
    if (!cached) { journal.features = record; await store.write(journal); }
    return { sealed: true, cached, featureId: record.config.id, chainWrites: 0 };
  } finally { if (hostedHeld) await hostedLock.close(); await store.close(); }
}

/** Explicit offline configuration migration. No chain writes, HTTP business commands or model calls. */
export async function appendTempoHostedTasks(directory: string, bootstrapFile: string, additionalFile: string) {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile); additionalFile = absolute(additionalFile);
  const additional = JSON.parse(await readFile(additionalFile, "utf8")) as WorkflowConfig["tasks"];
  const store = new SessionStore<RuntimeJournal>(join(directory, "runtime-journal")); await store.start(true);
  const hostedLock = new SessionStore<{ runs: { status: string }[] }>(join(directory, "hosted", "database")); let hostedHeld = false;
  let connection: Awaited<ReturnType<typeof tempoProvider>> | undefined;
  try {
    const state = await store.read() ?? fail("TEMPO_RUNTIME_JOURNAL_REQUIRED");
    for (const port of [state.originalBootstrap?.hostedPort ?? 8794, ...Object.values(state.ports).filter((port): port is number => typeof port === "number")]) if (await portListening(port)) fail("TEMPO_RUNTIME_STOP_REQUIRED");
    try {
      const pid = Number((await readFile(join(state.ipcDirectory, "settler.owner"), "utf8")).trim());
      if (!Number.isSafeInteger(pid) || pid < 1) fail("TEMPO_SETTLER_OWNER_INVALID");
      try { process.kill(pid, 0); fail("TEMPO_RUNTIME_STOP_REQUIRED"); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    await hostedLock.start(true); hostedHeld = true;
    const hosted = await hostedLock.read();
    if (!hosted || hosted.runs.some(run => !["Succeeded", "Failed"].includes(run.status))) fail("TEMPO_TERMINAL_RUNS_REQUIRED");
    const { bootstrap: current, gateway, catalog } = await loadTempoHostedBootstrap(bootstrapFile);
    const currentBinding = runtimeBinding(current, gateway, catalog), id = hash(additional);
    if (state.originalBootstrap && (runtimeBinding(state.originalBootstrap, gateway, catalog) !== state.binding
      || hash(state.originalBootstrap.tasks) !== hash(state.originalCatalog))) fail("TEMPO_ORIGINAL_CATALOG_INVALID");
    let migration = state.migrations?.find(entry => entry.id === id);
    if (migration && (runtimeBinding(migration.before, gateway, catalog) !== migration.beforeBinding
      || runtimeBinding(migration.after, gateway, catalog) !== migration.afterBinding
      || runtimeBinding({ ...migration.before, tasks: [...migration.before.tasks, ...migration.appended] }, gateway, catalog) !== migration.afterBinding)) fail("TEMPO_MIGRATION_SNAPSHOT_INVALID");
    if (migration?.status === "Applied") {
      if (currentBinding !== state.effectiveBinding) fail("TEMPO_RUNTIME_BINDING_CHANGED");
      return { applied: true, cached: true, migrationId: id, taskIds: migration.appended.map(task => task.taskId), chainWrites: 0 };
    }
    if (state.migrations?.some(entry => entry.status === "Intent" && entry.id !== id)) fail("TEMPO_ORIGINAL_MIGRATION_REQUIRED");
    if (migration) {
      if (![migration.beforeBinding, migration.afterBinding].includes(currentBinding) || hash(migration.appended) !== id
        || (state.effectiveBinding ?? state.binding) !== migration.beforeBinding) fail("TEMPO_MIGRATION_BINDING_CHANGED");
    } else {
      if (currentBinding !== (state.effectiveBinding ?? state.binding)) fail("TEMPO_RUNTIME_BINDING_CHANGED");
      const after = { ...structuredClone(current), tasks: appendTaskCatalog(current.tasks, additional) };
      migration = { id, status: "Intent", createdAt: new Date().toISOString(), beforeBinding: currentBinding,
        afterBinding: runtimeBinding(after, gateway, catalog), before: structuredClone(current), after, appended: structuredClone(additional) };
    }
    // Even interrupted intents recheck each new task, never change a chain task.
    connection = await tempoProvider(await readRpcUrlFile(current.rpcUrlFile), current.rpcTransport);
    const provider = connection.provider;
    if (BigInt(await provider.send("eth_chainId", [])) !== 42431n) fail("TEMPO_NETWORK_MISMATCH");
    const escrow = new Contract(current.contracts.escrow, ESCROW_ABI, provider), latest = await provider.getBlock("latest") ?? fail("TEMPO_LATEST_BLOCK_REQUIRED");
    for (const task of migration.appended) {
      const chain = await escrow.getTask(task.taskId);
      if (chain.status !== 1n || chain.agentId !== 0n || chain.reward !== 150000n || chain.escrowBalance !== 150000n
        || Number(chain.deadline) * 1000 !== task.deadlineMs || task.deadlineMs <= Math.max(Date.now(), latest.timestamp * 1000)) fail("TEMPO_APPEND_OPEN_TASK_REQUIRED");
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

export async function startTempoHostedRuntime(directory: string, bootstrapFile: string, recover = false) {
  directory = absolute(directory); bootstrapFile = absolute(bootstrapFile);
  const check = await checkTempoHostedBootstrap(bootstrapFile), { bootstrap: b, gateway, catalog } = await loadTempoHostedBootstrap(bootstrapFile);
  const store = new SessionStore<RuntimeJournal>(join(directory, "runtime-journal")); await store.start(recover);
  let connection: Awaited<ReturnType<typeof tempoProvider>> | undefined, hosted: ChildProcess | undefined, settler: ChildProcess | undefined;
  let arena: ReturnType<typeof createArenaHttpServer> | undefined, underwriter: Underwriter | undefined;
  let external: Awaited<ReturnType<typeof startExternalSpecialistStack>> | undefined;
  const previousBudget = process.env.TEMPO_TRANSACTION_BUDGET_FILE;
  const servers: ReturnType<typeof relayHttp>[] = [], relays: Relay[] = [];
  let state: RuntimeJournal | undefined, reload: (() => void) | undefined, closing: Promise<void> | undefined, ownsIpc = false;
  const close = () => closing ??= (async () => {
    if (reload) process.off("SIGUSR2", reload);
    await stopChild(hosted);
    await external?.close();
    for (const server of servers) if (server.listening) await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); });
    await arena?.close(); await stopChild(settler);
    if (ownsIpc && state) await backupAndRemoveArenaIpc(state.ipcDirectory, join(directory, "settlement-journal.json"));
    for (const relay of relays) relay.close(); underwriter?.close(); connection?.close(); await store.close();
    if (previousBudget === undefined) delete process.env.TEMPO_TRANSACTION_BUDGET_FILE; else process.env.TEMPO_TRANSACTION_BUDGET_FILE = previousBudget;
  })();
  try {
    // Public dashboard selection may change after enrolling hosted Agents; it does
    // not change the execution domain or invalidate the original payment journals.
    const binding = runtimeBinding(b, gateway, catalog);
    state = await store.read();
    if (state?.migrations?.some(entry => entry.status === "Intent")) fail("TEMPO_MIGRATION_RECOVERY_REQUIRED");
    if (state && (state.effectiveBinding ?? state.binding) !== binding) fail("TEMPO_RUNTIME_BINDING_CHANGED");
    if (state?.publicOriginMigration) {
      const audit = await optionalJson<{ status: string; id: string; origin: string }>(state.publicOriginMigration.auditFile);
      if (audit?.status !== "Applied" || audit.id !== state.publicOriginMigration.id || audit.origin !== b.frontendOrigin
        || state.publicOriginMigration.toOrigin !== b.frontendOrigin) fail("TEMPO_PUBLIC_ORIGIN_MIGRATION_INCOMPLETE");
    }
    if (state && !recover) fail("TEMPO_RUNTIME_RECOVER_REQUIRED");
    if (!state) {
      if (check.tasks.some(task => task.status !== "1" || task.deadlineMs <= Date.now())) fail("TEMPO_OPEN_TASKS_REQUIRED");
      state = { version: 1, binding, startedAt: new Date().toISOString(), templateDeadlineMs: Date.now() + 86400000,
        ipcDirectory: await mkdtemp("/tmp/af-tempo-hosted-"), operatorToken: randomBytes(32).toString("hex"), ports: {},
        originalBootstrap: structuredClone(b), originalCatalog: structuredClone(b.tasks) };
      await store.write(state);
    }
    const journal = state;
    const features = await verifyTempoHostedFeatures(journal.features, directory, b);
    const taskDomain = tempoFeatureTaskDomain(features?.config, b, journal);
    if (features) {
      const budgetFile = tempoFeatureBudgetFile(features, process.env.TEMPO_TRANSACTION_BUDGET_FILE);
      if (budgetFile !== undefined) process.env.TEMPO_TRANSACTION_BUDGET_FILE = budgetFile;
    }
    journal.testSponsorship = await preserveTempoRuntimeSponsorship(directory,b.frontendOrigin,journal.testSponsorship);
    await store.write(journal);
    const runner = new DockerExecutor(); await runner.ready();
    connection = await tempoProvider(await readRpcUrlFile(b.rpcUrlFile), b.rpcTransport); const rpc = connection.provider;
    const put = async (name: string, value: unknown) => { const path = join(directory, name); await atomicJson(path, value); return path; };
    const listening = async (name: PortName, server: ReturnType<typeof relayHttp>) => { servers.push(server); journal.ports[name] = await listen(server, journal.ports[name]); await store.write(journal); };
    const url = (name: PortName) => `http://127.0.0.1:${journal.ports[name]}`;
    await prepareArenaIpc(journal.ipcDirectory, join(directory, "settlement-journal.json")); ownsIpc = true;
    const arenaConfig: ArenaConfig = { rpcUrl: b.publicRpcUrl, chainId: b.chainId, escrowAddress: b.contracts.escrow, ipcDirectory: journal.ipcDirectory,
      tasks: Object.fromEntries(b.tasks.map(task => [task.taskId, { problemId: task.problemId }])), settlementTimeoutMs: 240000 };
    const arenaFile = await put("arena.json", arenaConfig);
    settler = await childReady("scripts/demo-settler.ts", [], { PATH: process.env.PATH, ARENA_CONFIG: arenaFile, ARENA_VERIFIER_KEY_FILE: b.roleKeyFiles.verifier,
      ...(features && !features.seal ? { TEMPO_TRANSACTION_BUDGET_FILE: features.config.transactionBudgetFile } : {}),
      AGENTFUEL_RPC_RETRY_READ_503: process.env.AGENTFUEL_RPC_RETRY_READ_503, ARENA_MAX_FEE_PER_GAS: b.maxFeePerGas, ARENA_RPC_TRANSPORT: b.rpcTransport, ARENA_RPC_URL_FILE: b.rpcUrlFile });
    arena = createArenaHttpServer(arenaConfig, [], rpc, { initial: await optionalJson<ArenaHttpJournal>(join(directory, "arena-http-journal.json")), save: value => put("arena-http-journal.json", value).then(() => undefined) });
    journal.ports.arena = await listen(arena.server, journal.ports.arena); await store.write(journal);
    underwriter = new Underwriter({ rpcUrl: b.publicRpcUrl, chainId: 42431n, managerAddress: b.contracts.manager, settlementAsset: b.asset.address,
      assetDecimals: 6, tokenUsdPrice: 10n ** 18n, privateKey: await readSecret(b.roleKeyFiles.underwriter), evidenceDir: join(directory, "underwriter"), host: "127.0.0.1", port: 0 }, rpc);
    await underwriter.initialize(); await listening("underwriter", creditHttp(underwriter));
    const gatewayKey = await readSecret(gateway.keyFile);
    const base: RelayConfig = { rpcUrl: b.publicRpcUrl, chainId: 42431n, account: b.contracts.account, asset: b.asset.address, assetDecimals: 6, payTo: b.payTo,
      service: { id: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL, price: 120000n,
        upstreams: catalog.map((model, index) => ({ name: index ? "strong" : "cheap", model: model.model, baseUrl: gateway.url, key: gatewayKey })) },
      dataDir: join(directory, "fixed"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 120000, host: "127.0.0.1", port: 0,
      operatorToken: journal.operatorToken, refunderKey: await readSecret(b.roleKeyFiles.refunder) };
    // All relay refunds use the same role wallet; serialize it across the distinct journals.
    let refundQueue: Promise<unknown> = Promise.resolve();
    const serializeRefund = <T>(operation:()=>Promise<T>):Promise<T> => {
      const next=refundQueue.catch(()=>{}).then(operation); refundQueue=next; return next;
    };
    const fixed = new FixedPriceSolvingRelay(base, { provider: rpc, runner, modelFetch: fetch, recoverLock: recover });
    relays.push(fixed); await fixed.initialize(); const fixedRefunder = new FixedPriceRefunder(fixed, { maxFeePerGas: BigInt(b.maxFeePerGas), gasLimit: 10_000_000n, serialize: serializeRefund }); await fixedRefunder.initialize();
    await listening("fixed", relayHttp(fixed, fixedRefunder));
    const allowance = new InferenceAllowanceRelay({ ...base, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
      upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
      { provider: rpc, creditsRaw: "200000", modelCatalogDigest: modelCatalogDigest(catalog),
        verifyAllowanceClosure: closure => verifyHostedAllowanceClosure(join(directory, "hosted"), closure) });
    const planner = new Relay({ ...base, dataDir: join(directory, "planner"), service: { id: "infercredit/plan", model: "logical-planner", price: 10000n,
      upstreams: [{ name: "magpie-cheap", model: catalog[0].model, baseUrl: gateway.url, key: gatewayKey }] } }, { provider: rpc });
    const goalRelays = catalog.map((model,index)=>new Relay({...base,dataDir:join(directory,`goal-${model.id}`),service:{
      id:"tabby/mission",model:model.id,price:index?20000n:10000n,
      upstreams:[{name:`magpie-${model.id}`,model:model.model,baseUrl:gateway.url,key:gatewayKey}]
    }},{provider:rpc}));
    for (const [name, relay] of [["allowance", allowance], ["planner", planner], ...goalRelays.map((relay,index)=>[TEMPO_GOAL_PORTS[index],relay] as const)] as const) {
      relays.push(relay); await relay.initialize(); const refunder = new Refunder(relay, { maxFeePerGas: BigInt(b.maxFeePerGas), gasLimit: 10_000_000n, serialize: serializeRefund }); await refunder.initialize(); await listening(name, relayHttp(relay, refunder));
    }
    if (features) {
      external = await startExternalSpecialistStack({ base, provider: rpc, directory: tempoFeaturePaths(directory).externalDirectory,
        providerIdentity: features.config.externalProvider,
        models: catalog.map((model, index) => ({ id: index ? "strong" : "cheap", model: model.model, responseModel: model.responseModel, baseUrl: gateway.url, key: gatewayKey, priceRaw: index ? "20000" : "10000" })),
        ports: Object.fromEntries(Object.entries(journal.ports).flatMap(([name, port]) => name.startsWith("external-") && typeof port === "number" ? [[name, port]] : [])),
        savePort: async (name, port) => { journal.ports[name as PortName] = port; await store.write(journal); },
        refundLimits: { maxFeePerGas: BigInt(b.maxFeePerGas), gasLimit: 10_000_000n, serialize: serializeRefund } });
    }
    const walletDirectory = join(directory, "wallets"), models = ["kimi-k2.6", "kimi-k3"];
    const taskModels = models.map((id, index) => {
      const workflow: WorkflowConfig = { agentId: "1", chainId: "42431", account: b.contracts.account, asset: b.asset.address, escrowAddress: b.contracts.escrow,
        tasks: taskDomain.tasks, allowCredit: true, maxPrice: "120000", deadlineMs: taskDomain.deadlineMs, minRemainingMs: 60000, maxCompletionTokens: 1024,
        providers: [{ id: "trusted-fixed", payTo: b.payTo, relayUrl: `${url("fixed")}/v1/chat`, service: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL,
          routes: [{ tier: index ? "strong" : "cheap", price: "120000", capabilities: ["python3-json-stdio", "sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"],
            solve: { version: 1, tiers: index ? ["strong", "strong"] : ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 1024 } }] }] };
      return { id, physicalModels: { cheap: catalog[0].model, strong: catalog[1].model }, templates: Object.fromEntries(["conservative", "balanced", "aggressive"].map(strategy => [strategy, structuredClone(workflow)])) };
    });
    const taskConfigFile = await put("task.json", { version: 1, identity: b.identity, guardianKeyFile: b.roleKeyFiles.guardian, initialCashRaw: "0", rpcUrlFile: b.rpcUrlFile,
      rpcTransport: b.rpcTransport, publicRpcUrl: b.publicRpcUrl, walletDirectory, arenaUrl: url("arena"), underwriterUrl: url("underwriter"), models: taskModels,
      timeoutMs: 120000, pollTimeoutMs: 240000, metered: { relayUrl: `${url("allowance")}/v1/chat`, payTo: b.payTo, priceRaw: "120000", creditsRaw: "200000", catalog, keyFile: gateway.keyFile } });
    const gameConfigFile = await put("game.json", { version: 1, chainId: "42431", identity: b.identity, account: b.contracts.account, token: b.asset.address,
      rpcUrlFile: b.rpcUrlFile, rpcTransport: b.rpcTransport, upstreamTransport: defaultUpstreamTransport(), walletDirectory, sponsorKeyFile: b.roleKeyFiles.sponsor,
      opponent: { binding: b.opponentBinding, keyFile: b.roleKeyFiles.opponent, modelId: "kimi-k2.6", strategy: "balanced" },
      models: models.map(id => ({ id, baseUrl: "https://api.moonshot.cn/v1", keyFile: b.vendorKeyFile })), creditsDirectory: join(directory, "credits") });
    const hostedConfigFile = await put("hosted.json", tempoHostedConfig({ version: 1, port: b.hostedPort,
      hosted: { ...(journal.testSponsorship?{testSponsorshipFile:journal.testSponsorship.file}:{}), ...(features ? { boundedGamesFile: features.config.boundedGamesFile, ...(features.seal ? { boundedGamesSealed: true } : {}) } : {}), directory: join(directory, "hosted"), origin: b.frontendOrigin, chainId: "42431", models: models.map(id => ({ id, label: id === "kimi-k2.6" ? "Kimi K2.6" : "Kimi K3" })),
        maxAgentsPerOwner: 6, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" }, executor: { taskConfigFile, gameConfigFile },
      goals: { ...tempoGoalConfig(catalog,journal.ports,b.payTo), ...(external ? { external: external.config } : {}) },
      autonomy: tempoFeatureAutonomy({ maxTasks: 2, maxDecisions: 3, durationMs: 1200000, plannerRelayUrl: `${url("planner")}/v1/chat`, plannerProvider: b.payTo, plannerPriceRaw: "10000",
        plannerService: "infercredit/plan", plannerModel: "logical-planner", plannerPhysicalModel: catalog[0].model, plannerResponseModel: catalog[0].responseModel }, !!features) }));
    await loadHostedDaemonConfig(hostedConfigFile);
    const launch = () => childReady("scripts/hosted-agents.ts", ["--start", "--recover"], { ...process.env, HOSTED_AGENTS_CONFIG: hostedConfigFile });
    hosted = await launch();
    let reloadPromise: Promise<void> | undefined;
    reload = () => { if (reloadPromise || closing) return; reloadPromise = (async () => { await stopChild(hosted); if (!closing) { hosted = await launch(); console.log("TEMPO_HOSTED_RELOADED"); } })()
      .catch(() => { console.error("TEMPO_HOSTED_RELOAD_FAILED"); }).finally(() => { reloadPromise = undefined; }); };
    process.on("SIGUSR2", reload);
    const manifestFile = await put("deployment.json", { chainId: "42431", network: "Tempo Moderato · real Kimi models", deploymentBlock: b.deploymentBlock,
      rpcUrl: b.publicRpcUrl, underwriterUrl: url("underwriter"), explorerUrl: "https://explore.testnet.tempo.xyz", asset: b.asset, contracts: b.contracts,
      agents: b.dashboardAgents,
      providers: [{ name: "Tempo allowance", address: b.payTo, relayUrl: `${url("allowance")}/v1/chat`, service: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL }], arenaUrl: url("arena") });
    const ready = { version: 1, pid: process.pid, startedAt: journal.startedAt, chainId: "42431", token: b.asset.address, identity: b.identity, account: b.contracts.account,
      hostedUrl: `http://127.0.0.1:${b.hostedPort}`, frontendOrigin: b.frontendOrigin, manifestFile, hostedConfigFile, gateway: gateway.url, models, taskCount: b.tasks.length,
      rpcUrlFile: b.rpcUrlFile, rpcTransport: b.rpcTransport, bootstrapFile,
      ports: journal.ports, gasSponsorship: false, registryMode: "existing ERC8004 · interfaces verified", assetMode: "Tempo test PathUSD", inference: "real Kimi K2.6/K3 via Magpie", feeToken: { address: TEMPO_PATH_USD, symbol: "PathUSD", decimals: 6 }, nativeBalanceIsPlaceholder: true };
    await put("ready.json", ready); return { ready, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [mode, first, second, ...rest] = process.argv.slice(2);
  if (mode === "--check" && first && !second) checkTempoHostedBootstrap(resolve(first)).then(result => console.log(JSON.stringify(result))).catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else if (mode === "append-tasks" && first && second && rest.length === 1)
    appendTempoHostedTasks(resolve(first), resolve(second), resolve(rest[0])).then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else if (mode === "enable-features" && first && second && rest.length === 1)
    enableTempoHostedFeatures(resolve(first), resolve(second), resolve(rest[0])).then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else if (mode === "seal-features" && first && second && rest.length <= 1)
    sealTempoHostedFeatures(resolve(first), resolve(second), rest[0] ? resolve(rest[0]) : undefined).then(result => console.log(JSON.stringify(result)))
      .catch(error => { console.error(safe(error)); process.exitCode = 1; });
  else if (mode === "start" && first && second && (rest.length === 0 || rest.length === 1 && rest[0] === "--recover"))
    startTempoHostedRuntime(resolve(first), resolve(second), rest.includes("--recover")).then(runtime => {
      console.log(JSON.stringify(runtime.ready)); const stop = () => { void runtime.close().then(() => process.exit(0)).catch(() => process.exit(1)); };
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
    }).catch(error => { reportRuntimeError(error); process.exitCode = 1; });
  else { console.error("Usage: tempo-hosted-runtime.ts --check BOOTSTRAP | start DIRECTORY BOOTSTRAP [--recover] | append-tasks DIRECTORY BOOTSTRAP ADDITIONAL_TASKS_JSON | enable-features DIRECTORY BOOTSTRAP FEATURES_JSON | seal-features DIRECTORY BOOTSTRAP [CLOSURE_JSON]"); process.exitCode = 1; }
}
