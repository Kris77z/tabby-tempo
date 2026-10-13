import "server-only";
import { GameFiRunner, loadGameFiRunnerConfig, type LoadedGameFiConfig } from "@agentfuel/arena/gamefi-runner";
import { loadDeployment } from "./config";

type Context = { runner: GameFiRunner; loaded: LoadedGameFiConfig };
const globalCache = globalThis as typeof globalThis & { agentfuelGameFi?: Map<string, Context> };
/** Configuration is operator-only. The HTTP request never supplies a config pathname. */
export async function getGameFiServerContext(): Promise<Context | undefined> {
  // This legacy runner dispatches Monad CLI stages. Tempo uses authenticated
  // hosted game commands; an accidentally configured legacy path stays disabled.
  if ((await loadDeployment())?.chainId === "42431") return undefined;
  const path = process.env.GAMEFI_RUNNER_CONFIG;
  if (!path) return undefined;
  const loaded = await loadGameFiRunnerConfig(path), key = `${path}:${loaded.digest}`;
  const cache = globalCache.agentfuelGameFi ??= new Map();
  let context = cache.get(key);
  if (!context) { context = { loaded, runner: new GameFiRunner(loaded) }; cache.set(key, context); }
  return context;
}
