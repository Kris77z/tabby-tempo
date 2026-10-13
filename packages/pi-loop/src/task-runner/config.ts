import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { Wallet, getAddress } from "ethers";
import { validateWorkflowConfig, type WorkflowConfig } from "../workflow.js";
import { TaskRunnerError, type TaskRunnerProfile } from "./types.js";

export interface TaskRunnerPreset { id: string; label: string; workflowConfigFile: string; rpcUrlFile: string;
  rpcTransport: "direct" | "system-https-proxy"; arenaUrl: string; underwriterUrl: string; timeoutMs?: number; pollTimeoutMs?: number }
export interface TaskRunnerConfig { version: 1; dataDirectory: string; port: number; wallet: string; keyFile: string; profiles: TaskRunnerPreset[] }
export interface LoadedTaskRunnerConfig { config: TaskRunnerConfig; digest: string; keyDigest: string;
  profiles: Array<{ preset: TaskRunnerPreset; workflow: WorkflowConfig }>; walletLockDirectory: string }
const digest = (input: string) => createHash("sha256").update(input).digest("hex");
function absolute(value: unknown) {
  if (typeof value !== "string" || !isAbsolute(value)) throw new TaskRunnerError("TASK_ABSOLUTE_CONFIG_PATH_REQUIRED", 503);
  return resolve(value);
}
export async function taskPrivateFile(path: string) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid()) || await realpath(path) !== path)
    throw new TaskRunnerError("TASK_PRIVATE_FILE_REQUIRED", 503);
  return readFile(path, "utf8");
}
export async function taskPrivateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 }); const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (process.getuid && info.uid !== process.getuid()))
    throw new TaskRunnerError("TASK_PRIVATE_DIRECTORY_REQUIRED", 503);
  await chmod(path, 0o700);
}
export function taskLoopbackUrl(value: unknown): string {
  try {
    if (typeof value !== "string") throw new Error(); const url = new URL(value);
    if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) || url.username || url.password || url.search || url.hash) throw new Error();
    return value;
  } catch { throw new TaskRunnerError("TASK_LOOPBACK_SERVICE_REQUIRED", 503); }
}
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function keys(value: Record<string, unknown>, allowed: string[]) { return Object.keys(value).every(key => allowed.includes(key)); }
export function parseTaskRunnerConfig(value: unknown): TaskRunnerConfig {
  if (!object(value) || !keys(value, ["version", "dataDirectory", "port", "wallet", "keyFile", "profiles"]) || value.version !== 1 ||
    !Number.isSafeInteger(value.port) || Number(value.port) < 1024 || Number(value.port) > 65535 || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > 16)
    throw new TaskRunnerError("TASK_RUNNER_CONFIG_INVALID", 503);
  let wallet: string; try { wallet = getAddress(value.wallet as string); } catch { throw new TaskRunnerError("TASK_RUNNER_CONFIG_INVALID", 503); }
  const ids = new Set<string>();
  const profiles = value.profiles.map(raw => {
    if (!object(raw) || !keys(raw, ["id", "label", "workflowConfigFile", "rpcUrlFile", "rpcTransport", "arenaUrl", "underwriterUrl", "timeoutMs", "pollTimeoutMs"]) ||
      typeof raw.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(raw.id) || ids.has(raw.id) || typeof raw.label !== "string" || !raw.label.trim() || raw.label.length > 80 ||
      raw.rpcTransport !== "direct" && raw.rpcTransport !== "system-https-proxy") throw new TaskRunnerError("TASK_RUNNER_CONFIG_INVALID", 503);
    ids.add(raw.id);
    for (const field of ["timeoutMs", "pollTimeoutMs"] as const) if (raw[field] !== undefined && (!Number.isSafeInteger(raw[field]) || Number(raw[field]) < 1000 || Number(raw[field]) > 300000)) throw new TaskRunnerError("TASK_RUNNER_CONFIG_INVALID", 503);
    return { id: raw.id, label: raw.label, workflowConfigFile: absolute(raw.workflowConfigFile), rpcUrlFile: absolute(raw.rpcUrlFile), rpcTransport: raw.rpcTransport,
      arenaUrl: taskLoopbackUrl(raw.arenaUrl), underwriterUrl: taskLoopbackUrl(raw.underwriterUrl),
      ...(raw.timeoutMs === undefined ? {} : { timeoutMs: raw.timeoutMs }), ...(raw.pollTimeoutMs === undefined ? {} : { pollTimeoutMs: raw.pollTimeoutMs }) } as TaskRunnerPreset;
  });
  return { version: 1, dataDirectory: absolute(value.dataDirectory), port: Number(value.port), wallet, keyFile: absolute(value.keyFile), profiles };
}
export async function loadTaskRunnerConfig(path: string): Promise<LoadedTaskRunnerConfig> {
  const config = parseTaskRunnerConfig(JSON.parse(await taskPrivateFile(absolute(path))));
  const key = (await taskPrivateFile(config.keyFile)).trim(); let address: string;
  try { address = new Wallet(key).address; } catch { throw new TaskRunnerError("TASK_SIGNER_KEY_INVALID", 503); }
  if (address !== config.wallet) throw new TaskRunnerError("TASK_SIGNER_WALLET_MISMATCH", 503);
  const keyDigest = digest(key), profiles = await Promise.all(config.profiles.map(async preset => {
    const workflow = validateWorkflowConfig(JSON.parse(await taskPrivateFile(preset.workflowConfigFile)));
    if (!["31337", "10143", "42431"].includes(workflow.chainId)) throw new TaskRunnerError("TASK_CHAIN_NOT_SUPPORTED", 503);
    workflow.providers.forEach(provider => taskLoopbackUrl(provider.relayUrl));
    const rpcUrl = (await taskPrivateFile(preset.rpcUrlFile)).trim();
    if (workflow.chainId === "31337") taskLoopbackUrl(rpcUrl);
    else { try { const url = new URL(rpcUrl); if (url.protocol !== "https:" || url.username || url.password || url.hash) throw new Error(); } catch { throw new TaskRunnerError("TASK_RPC_CONFIG_INVALID", 503); } }
    return { preset, workflow };
  }));
  // One fixed namespace for every runner using this wallet; dataDirectory does not choose the wallet lock.
  const walletLockDirectory = join(homedir(), ".config", "agentfuel", "pi-task-wallets", config.wallet.toLowerCase());
  await taskPrivateDirectory(config.dataDirectory); await taskPrivateDirectory(join(config.dataDirectory, "runs"));
  return { config, profiles, keyDigest, walletLockDirectory, digest: digest(JSON.stringify({ config, profiles, keyDigest })) };
}
export function taskPublicProfiles(loaded: LoadedTaskRunnerConfig): TaskRunnerProfile[] {
  return loaded.profiles.map(({ preset, workflow }) => ({ profileId: preset.id, label: preset.label, chainId: workflow.chainId, agentId: workflow.agentId,
    problemIds: [...new Set(workflow.tasks.map(task => task.problemId))] }));
}
