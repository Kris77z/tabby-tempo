import { createHash } from "node:crypto";
import { chmod, lstat, mkdir, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { loadHoldemMonadConfig, type HoldemMonadConfig } from "../../../../scripts/holdem-monad.js";
import type { RpcTransport } from "../../../../scripts/demo-rpc.js";
import { GameFiError, type GameFiRewardKind } from "./types.js";

export interface GameFiRunnerConfig {
  version: 1; dataDirectory: string; holdemConfigFile: string;
  rpcUrlFile?: string; rpcTransport: RpcTransport; rewardKinds: GameFiRewardKind[];
}
export interface LoadedGameFiConfig { config: GameFiRunnerConfig; holdem: HoldemMonadConfig; digest: string }
function absolute(value: unknown): string {
  if (typeof value !== "string" || !isAbsolute(value)) throw new GameFiError("GAMEFI_ABSOLUTE_CONFIG_PATH_REQUIRED", 503);
  return resolve(value);
}
export function parseGameFiRunnerConfig(value: unknown): GameFiRunnerConfig {
  const item = value as Record<string, unknown>;
  if (!item || item.version !== 1 || Object.keys(item).some(key => !["version", "dataDirectory", "holdemConfigFile", "rpcUrlFile", "rpcTransport", "rewardKinds"].includes(key))
    || !Array.isArray(item.rewardKinds) || item.rewardKinds.length < 1 || item.rewardKinds.length > 2
    || new Set(item.rewardKinds).size !== item.rewardKinds.length || item.rewardKinds.some(kind => kind !== "usdc" && kind !== "llm-credits")
    || (item.rpcTransport !== undefined && item.rpcTransport !== "direct" && item.rpcTransport !== "system-https-proxy")) throw new GameFiError("GAMEFI_CONFIG_INVALID", 503);
  return { version: 1, dataDirectory: absolute(item.dataDirectory), holdemConfigFile: absolute(item.holdemConfigFile),
    ...(item.rpcUrlFile === undefined ? {} : { rpcUrlFile: absolute(item.rpcUrlFile) }), rpcTransport: item.rpcTransport as RpcTransport ?? "direct",
    rewardKinds: item.rewardKinds as GameFiRewardKind[] };
}
export async function privateFile(path: string): Promise<string> {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600 || (process.getuid && info.uid !== process.getuid())
    || await realpath(path) !== path) throw new GameFiError("GAMEFI_PRIVATE_CONFIG_REQUIRED", 503);
  return readFile(path, "utf8");
}
export async function privateDirectory(path: string) {
  await mkdir(path, { recursive: true, mode: 0o700 });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink() || await realpath(path) !== path || (process.getuid && info.uid !== process.getuid())) throw new GameFiError("GAMEFI_PRIVATE_DIRECTORY_REQUIRED", 503);
  await chmod(path, 0o700);
}
export async function loadGameFiRunnerConfig(path: string): Promise<LoadedGameFiConfig> {
  const config = parseGameFiRunnerConfig(JSON.parse(await privateFile(absolute(path)))), holdem = await loadHoldemMonadConfig(config.holdemConfigFile);
  await privateFile(holdem.monadConfigFile); await privateFile(holdem.deploymentStateFile);
  if (config.rpcUrlFile) await privateFile(config.rpcUrlFile);
  await privateDirectory(config.dataDirectory); await privateDirectory(join(config.dataDirectory, "runs"));
  return { config, holdem, digest: createHash("sha256").update(JSON.stringify({ config, holdem })).digest("hex") };
}
