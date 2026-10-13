import { spawn, type ChildProcess, type SpawnOptions } from "node:child_process";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { connect, createServer } from "node:net";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { Wallet } from "ethers";
import { loadConfig as underwriterConfig } from "../services/underwriter/src/config.js";
import { loadConfig as relayConfig } from "../services/provider-relay/src/config.js";
import { parseConfig as arenaConfig } from "../services/arena/src/protocol.js";
import { parseTaskRunnerConfig, taskLoopbackUrl } from "../packages/pi-loop/src/task-runner/config.js";
import { validateWorkflowConfig } from "../packages/pi-loop/src/workflow.js";
import { readRpcUrlFile } from "./demo-rpc.js";

const entries = {
  underwriter: "services/underwriter/src/main.ts", "fixed-relay": "scripts/fixed-relay.ts",
  settler: "services/arena/src/settler-main.ts", arena: "services/arena/src/http-main.ts", "task-runner": "scripts/task-runner.ts",
} as const;
export type BackendRole = keyof typeof entries;
const roles = Object.keys(entries) as BackendRole[];
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
interface RoleConfig { envFile: string; configFile?: string; port?: number }
export interface BackendManifest { version: 1; runtimeDirectory: string; startupTimeoutMs?: number; roles: Record<BackendRole, RoleConfig> }
interface LoadedBackend { manifest: BackendManifest; environments: Record<BackendRole, NodeJS.ProcessEnv> }
const variables: Record<BackendRole, string[]> = {
  underwriter: ["RPC_URL", "CHAIN_ID", "MANAGER_ADDRESS", "SETTLEMENT_ASSET", "ASSET_DECIMALS", "TOKEN_USD_PRICE", "UNDERWRITER_PRIVATE_KEY", "EVIDENCE_DIR", "HOST", "PORT", "FRONTEND_ORIGIN"],
  "fixed-relay": ["RPC_URL", "RPC_URL_FILE", "CHAIN_ID", "ACCOUNT_ADDRESS", "SETTLEMENT_ASSET", "ASSET_DECIMALS", "PROVIDER_ADDRESS", "SERVICE_ID", "LOGICAL_MODEL", "PRICE", "UPSTREAMS_JSON", "TIERS_JSON", "DATA_DIR", "QUOTE_TTL", "CONFIRMATIONS", "UPSTREAM_TIMEOUT_MS", "LOG_SCAN_CHUNK_BLOCKS", "HOST", "PORT", "FRONTEND_ORIGIN", "OPERATOR_TOKEN", "REFUNDER_PRIVATE_KEY", "RPC_TRANSPORT", "UPSTREAM_TRANSPORT", "SOLVE_RECOVER_LOCK"],
  settler: ["ARENA_CONFIG", "ARENA_VERIFIER_PRIVATE_KEY"], arena: ["ARENA_CONFIG", "ARENA_PORT", "ARENA_UI_ORIGIN", "ARENA_DOCKER_IMAGE"], "task-runner": ["TASK_RUNNER_CONFIG"],
};
function fail(code: string): never { throw new Error(code); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { if (Object.keys(value).some(key => !allowed.includes(key))) fail("BACKEND_CONFIG_INVALID"); }
function absolute(value: unknown): string { if (typeof value !== "string" || !isAbsolute(value)) fail("BACKEND_ABSOLUTE_PATH_REQUIRED"); return resolve(value); }
async function privateFile(path: string) {
  const info = await lstat(path).catch(() => fail("BACKEND_PRIVATE_FILE_REQUIRED"));
  if (!info.isFile() || (info.mode & 0o777) !== 0o600 || process.getuid && info.uid !== process.getuid()) fail("BACKEND_PRIVATE_FILE_REQUIRED");
  return readFile(path, "utf8");
}
async function privateDirectory(path: string, create = false) {
  if (create) await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path).catch(error => { if (!create && error.code === "ENOENT") return undefined; throw error; });
  if (info && (!info.isDirectory() || (info.mode & 0o777) !== 0o700 || process.getuid && info.uid !== process.getuid())) fail("BACKEND_PRIVATE_DIRECTORY_REQUIRED");
}
export async function loadBackend(path: string): Promise<LoadedBackend> {
  const value: unknown = JSON.parse(await privateFile(absolute(path)));
  if (!object(value)) fail("BACKEND_CONFIG_INVALID"); keys(value, ["version", "runtimeDirectory", "startupTimeoutMs", "roles"]);
  if (value.version !== 1 || !object(value.roles) || Object.keys(value.roles).sort().join() !== [...roles].sort().join()) fail("BACKEND_FIXED_ROLES_REQUIRED");
  const timeout = value.startupTimeoutMs ?? 90000;
  if (!Number.isSafeInteger(timeout) || Number(timeout) < 100 || Number(timeout) > 300000) fail("BACKEND_STARTUP_TIMEOUT_INVALID");
  const manifest: BackendManifest = { version: 1, runtimeDirectory: absolute(value.runtimeDirectory), startupTimeoutMs: Number(timeout), roles: {} as BackendManifest["roles"] };
  const environments = {} as LoadedBackend["environments"], ports = new Set<number>(), files = new Set<string>();
  for (const role of roles) {
    const item = value.roles[role]; if (!object(item)) fail("BACKEND_CONFIG_INVALID"); keys(item, ["envFile", "configFile", "port"]);
    const configFile = ["settler", "arena", "task-runner"].includes(role) ? absolute(item.configFile) : undefined;
    if (!configFile && item.configFile !== undefined) fail("BACKEND_CONFIG_INVALID");
    const envFile = absolute(item.envFile); if (files.has(envFile)) fail("BACKEND_SEPARATE_ROLE_ENV_REQUIRED"); files.add(envFile);
    const port = role === "settler" ? undefined : typeof item.port === "number" ? item.port : NaN;
    if (role === "settler" && item.port !== undefined || port !== undefined && (!Number.isSafeInteger(port) || port < 1024 || port > 65535 || ports.has(port))) fail("BACKEND_PORT_INVALID");
    if (port) ports.add(port); manifest.roles[role] = { envFile, ...(configFile ? { configFile } : {}), ...(port ? { port } : {}) };
    const env = parseEnv(await privateFile(envFile)), allowed = new Set(variables[role]);
    if (role === "fixed-relay") {
      const definitions = env.TIERS_JSON ? Object.values(JSON.parse(env.TIERS_JSON)).flatMap((tier: any) => tier.upstreams) : JSON.parse(env.UPSTREAMS_JSON ?? "[]");
      for (const upstream of definitions) {
        if (typeof upstream.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(upstream.keyEnv) || /VERIFIER|^NODE_|^LD_|^DYLD_|^OPENSSL_CONF$|^SSLKEYLOGFILE$|^PATH$|^HOME$|^TMPDIR$/.test(upstream.keyEnv)) fail("BACKEND_ENV_REJECTED");
        allowed.add(upstream.keyEnv);
      }
    }
    if (Object.keys(env).some(key => !allowed.has(key))) fail("BACKEND_ENV_REJECTED");
    if (role === "underwriter" || role === "fixed-relay") {
      if (env.HOST && env.HOST !== "127.0.0.1" || env.PORT && env.PORT !== String(port)) fail("BACKEND_LOOPBACK_PORT_REQUIRED");
      env.HOST = "127.0.0.1"; env.PORT = String(port);
      if (role === "underwriter") underwriterConfig(env);
      else relayConfig({ ...env, ...(env.RPC_URL_FILE ? { RPC_URL: await readRpcUrlFile(absolute(env.RPC_URL_FILE)) } : {}) });
    }
    if (configFile) {
      const variable = role === "task-runner" ? "TASK_RUNNER_CONFIG" : "ARENA_CONFIG";
      if (env[variable] && env[variable] !== configFile) fail("BACKEND_CONFIG_PATH_MISMATCH"); env[variable] = configFile;
      const contents = JSON.parse(await privateFile(configFile));
      if (role === "task-runner") { if (parseTaskRunnerConfig(contents).port !== port) fail("BACKEND_PORT_MISMATCH"); }
      else {
        if (!object(contents)) fail("BACKEND_CONFIG_INVALID");
        keys(contents, ["rpcUrl", "chainId", "escrowAddress", "tasks", "ipcDirectory", "allowManual", "settlementTimeoutMs"]); arenaConfig(contents);
      }
    }
    if (role === "arena") { if (env.ARENA_PORT && env.ARENA_PORT !== String(port)) fail("BACKEND_PORT_MISMATCH"); env.ARENA_PORT = String(port); }
    if (env.RPC_URL_FILE) await privateFile(absolute(env.RPC_URL_FILE));
    environments[role] = env;
  }
  if (manifest.roles.arena.configFile !== manifest.roles.settler.configFile) fail("BACKEND_SHARED_ARENA_CONFIG_REQUIRED");
  const rawVerifier = environments.settler.ARENA_VERIFIER_PRIVATE_KEY?.trim();
  if (!rawVerifier) fail("BACKEND_VERIFIER_REQUIRED");
  let verifier: string; try { verifier = new Wallet(rawVerifier).privateKey.toLowerCase(); } catch { fail("BACKEND_VERIFIER_INVALID"); }
  for (const role of roles.filter(role => role !== "settler")) {
    if (Object.values(environments[role]).some(value => value?.toLowerCase().includes(verifier))) fail("BACKEND_VERIFIER_ISOLATION_REQUIRED");
    const configFile = manifest.roles[role].configFile;
    for (const path of [configFile, environments[role].RPC_URL_FILE]) if (path && (await privateFile(path)).toLowerCase().includes(verifier)) fail("BACKEND_VERIFIER_ISOLATION_REQUIRED");
  }
  const runner = parseTaskRunnerConfig(JSON.parse(await privateFile(manifest.roles["task-runner"].configFile!)));
  const runnerKey = (await privateFile(runner.keyFile)).trim();
  if (runnerKey.toLowerCase() === verifier) fail("BACKEND_VERIFIER_ISOLATION_REQUIRED");
  let wallet: Wallet; try { wallet = new Wallet(runnerKey); } catch { fail("BACKEND_RUNNER_KEY_INVALID"); }
  if (wallet.address !== runner.wallet) fail("BACKEND_RUNNER_WALLET_MISMATCH");
  for (const profile of runner.profiles) {
    const contents = await privateFile(profile.workflowConfigFile), rpcUrl = (await privateFile(profile.rpcUrlFile)).trim();
    if ([contents, rpcUrl].some(value => value.toLowerCase().includes(verifier))) fail("BACKEND_VERIFIER_ISOLATION_REQUIRED");
    let workflow: ReturnType<typeof validateWorkflowConfig>;
    try { workflow = validateWorkflowConfig(JSON.parse(contents)); } catch { fail("BACKEND_WORKFLOW_CONFIG_INVALID"); }
    if (!["31337", "10143", "42431"].includes(workflow.chainId)) fail("BACKEND_RUNNER_CHAIN_UNSUPPORTED");
    try {
      workflow.providers.forEach(provider => taskLoopbackUrl(provider.relayUrl));
      if (workflow.chainId === "31337") taskLoopbackUrl(rpcUrl);
      else { const url = new URL(rpcUrl); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(); }
    } catch { fail("BACKEND_RUNNER_RPC_OR_RELAY_INVALID"); }
  }
  await privateDirectory(manifest.runtimeDirectory);
  return { manifest, environments };
}
export async function checkBackend(loaded: LoadedBackend): Promise<void> {
  for (const role of roles) {
    const port = loaded.manifest.roles[role].port; if (!port) continue;
    await new Promise<void>((done, reject) => {
      const server = createServer(); server.once("error", () => reject(new Error("BACKEND_PORT_IN_USE")));
      server.listen(port, "127.0.0.1", () => server.close(() => done()));
    });
  }
}
async function writeStatus(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value) + "\n", { flag: "wx", mode: 0o600 }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
async function portReady(port: number) {
  return new Promise<boolean>(done => {
    const socket = connect(port, "127.0.0.1"), finish = (ready: boolean) => { socket.destroy(); done(ready); };
    socket.setTimeout(200, () => finish(false)); socket.once("error", () => finish(false)); socket.once("connect", () => finish(true));
  });
}
/** Test injection is an in-process dependency only; manifest/CLI never accept executable paths. */
export async function startBackend(loaded: LoadedBackend, options: { launch?: (role: BackendRole, args: string[], options: SpawnOptions) => ChildProcess; shutdownTimeoutMs?: number } = {}) {
  const directory = loaded.manifest.runtimeDirectory; await privateDirectory(directory, true);
  const lock = join(directory, "backend.pid"), statusFile = join(directory, "status.json");
  const owner = await open(lock, "wx", 0o600).catch(() => fail("BACKEND_LOCK_EXISTS"));
  await owner.writeFile(String(process.pid)); await owner.close();
  const processes = new Map<BackendRole, ChildProcess>(), states: Partial<Record<BackendRole, { pid?: number; port?: number; state: string; logFile: string }>> = {};
  let closing: Promise<void> | undefined, failed = false, running = false, failedRole: BackendRole | undefined, currentRole: BackendRole | undefined, finish!: (code: number) => void;
  const done = new Promise<number>(resolve => { finish = resolve; });
  const save = () => writeStatus(statusFile, { service: "backend", pid: process.pid, state: failed ? "failed" : closing ? "stopped" : running ? "running" : "starting", ...(failedRole ? { failedRole } : {}), roles: states });
  const close = () => closing ??= (async () => {
    for (const child of processes.values()) if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await Promise.all([...processes.values()].map(async child => {
      if (!child.pid) return;
      const until = Date.now() + (options.shutdownTimeoutMs ?? 10000);
      while (child.exitCode === null && child.signalCode === null && Date.now() < until) await delay(25);
      if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise<void>(resolve => child.once("exit", () => resolve())); }
    }));
    for (const [role, state] of Object.entries(states)) state.state = role === failedRole ? "failed" : "stopped";
    try { await save(); } catch { failed = true; }
    finally { process.off("SIGINT", stop); process.off("SIGTERM", stop); try { await rm(lock, { force: true }); } catch { failed = true; } finish(failed ? 1 : 0); }
  })();
  const stop = () => { void close(); }; process.once("SIGINT", stop); process.once("SIGTERM", stop);
  try {
    await checkBackend(loaded);
    const base: NodeJS.ProcessEnv = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: process.env.HOME, TMPDIR: process.env.TMPDIR, NODE_ENV: "production" };
    for (const role of roles) {
      currentRole = role;
      if (closing) fail("BACKEND_CHILD_FAILED");
      const logFile = join(directory, `${role}-${randomUUID()}.log`), log = await open(logFile, "wx", 0o600);
      const args = ["--import", "tsx", entries[role]], settings: SpawnOptions = { cwd: root, env: { ...base, ...loaded.environments[role] }, stdio: ["ignore", log.fd, log.fd] };
      let child: ChildProcess;
      try {
        if (closing) fail("BACKEND_CHILD_FAILED"); child = options.launch ? options.launch(role, args, settings) : spawn(process.execPath, args, settings);
        processes.set(role, child); states[role] = { pid: child.pid, port: loaded.manifest.roles[role].port, state: "starting", logFile };
        const stop = () => { if (!closing) { failed = true; failedRole = role; void close(); } }; child.once("exit", stop); child.once("error", stop);
      } finally { await log.close(); }
      await save(); const until = Date.now() + loaded.manifest.startupTimeoutMs!;
      while (true) {
        if (closing || child.exitCode !== null || child.signalCode !== null) fail("BACKEND_CHILD_FAILED");
        const ready = role === "settler" ? (await readFile(logFile, "utf8")).split("\n").some(line => { try { return JSON.parse(line).ready === true; } catch { return false; } }) : await portReady(loaded.manifest.roles[role].port!);
        if (ready) break; if (Date.now() >= until) fail("BACKEND_STARTUP_TIMEOUT"); await delay(100);
      }
      states[role]!.state = "ready"; await save();
    }
    if (closing) fail("BACKEND_CHILD_FAILED"); running = true; await save(); return { close, done, statusFile };
  } catch (error) { failed = true; failedRole ??= currentRole; await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2); let path: string | undefined, mode: "start" | "check" | undefined;
    for (let index = 0; index < args.length; index++) {
      if (args[index] === "--manifest" && !path) path = args[++index];
      else if (["--start", "--check"].includes(args[index]) && !mode) mode = args[index].slice(2) as "start" | "check";
      else fail("BACKEND_INVALID_ARGUMENT");
    }
    if (!path) fail("BACKEND_MANIFEST_REQUIRED"); const loaded = await loadBackend(path);
    if (mode !== "start") { await checkBackend(loaded); console.log(JSON.stringify({ service: "backend", checked: true })); }
    else {
      const runtime = await startBackend(loaded);
      console.log(JSON.stringify({ service: "backend", ready: true, statusFile: runtime.statusFile })); process.exitCode = await runtime.done;
    }
  } catch (error) { const message = (error as Error).message; console.error(/^BACKEND_[A-Z_]+$/.test(message) ? message : "BACKEND_START_FAILED"); process.exitCode = 1; }
}
