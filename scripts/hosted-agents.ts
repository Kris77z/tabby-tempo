import { HostedAutonomyExecutor, validateHostedAutonomyConfig, type HostedAutonomyConfig } from "../services/hosted-agents/src/autonomy-executor.js";
import { once } from "node:events";
import { isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet } from "ethers";
import { taskPrivateFile } from "../packages/pi-loop/src/task-runner/config.js";
import { HostedService, validateHostedConfig } from "../services/hosted-agents/src/service.js";
import { createHostedHttpServer } from "../services/hosted-agents/src/http.js";
import { createHostedTaskExecutor, loadHostedTaskExecutorConfig, type HostedTaskExecutorConfig } from "../services/hosted-agents/src/task-executor.js";
import { createHostedGameExecutor, loadHostedGameExecutorConfig, type HostedGameExecutorConfig } from "../services/hosted-agents/src/game-executor.js";
import { HostedError, type HostedConfig, type HostedExecutor } from "../services/hosted-agents/src/types.js";
import { loadTestSponsorship } from "../services/hosted-agents/src/test-sponsorship.js";

export interface HostedDaemonConfig { version: 1; port: number; autonomy?: HostedAutonomyConfig; hosted: HostedConfig; executor: { taskConfigFile: string; gameConfigFile: string } }
export interface LoadedHostedDaemon { config: HostedDaemonConfig; task: HostedTaskExecutorConfig; game: HostedGameExecutorConfig }
function fail(code: string): never { throw new HostedError(code, 503); }
function object(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail("HOSTED_DAEMON_CONFIG_INVALID");
}
function absolute(value: unknown): string { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail("HOSTED_DAEMON_PATH_INVALID"); return value; }
const ids = (models: { id: string }[]) => models.map(model => model.id).sort().join("\n");
/** Read/validation only: no service open, executor construction, wallet generation or runtime directories. */
export async function loadHostedDaemonConfig(path: string): Promise<LoadedHostedDaemon> {
  try {
    const value: unknown = JSON.parse(await taskPrivateFile(absolute(path)));
    object(value, ["version", "port", "hosted", "executor", "autonomy"]); object(value.executor, ["taskConfigFile", "gameConfigFile"]);
    if (value.version !== 1 || !Number.isSafeInteger(value.port) || value.port < 1024 || value.port > 65535) fail("HOSTED_DAEMON_CONFIG_INVALID");
    const autonomy = value.autonomy === undefined ? undefined : validateHostedAutonomyConfig(value.autonomy);
    const hosted = validateHostedConfig(value.hosted), taskConfigFile = absolute(value.executor.taskConfigFile), gameConfigFile = absolute(value.executor.gameConfigFile);
    if (hosted.testSponsorshipFile) await loadTestSponsorship(hosted.testSponsorshipFile, hosted);
    const task = await loadHostedTaskExecutorConfig(taskConfigFile), game = await loadHostedGameExecutorConfig(gameConfigFile);
    if (autonomy && !task.metered) fail("HOSTED_AUTONOMY_NOT_CONFIGURED");
    const workflow = task.models[0].templates.conservative;
    if (ids(hosted.models) !== ids(task.models) || ids(hosted.models) !== ids(game.models)) fail("HOSTED_DAEMON_MODELS_MISMATCH");
    if (hosted.chainId !== workflow.chainId || hosted.chainId !== game.chainId || task.identity.toLowerCase() !== game.identity.toLowerCase() ||
      workflow.account.toLowerCase() !== game.account.toLowerCase() || workflow.asset.toLowerCase() !== game.token.toLowerCase() ||
      task.walletDirectory !== game.walletDirectory || task.rpcTransport !== game.rpcTransport) fail("HOSTED_DAEMON_DOMAIN_MISMATCH");
    const taskRpc = (await taskPrivateFile(task.rpcUrlFile)).trim(), gameRpc = game.rpcUrlFile ? (await taskPrivateFile(game.rpcUrlFile)).trim() : game.publicRpcUrl;
    if (taskRpc !== gameRpc) fail("HOSTED_DAEMON_RPC_MISMATCH");
    const bot = new Wallet((await taskPrivateFile(game.opponent.keyFile)).trim()).address;
    for (const file of [task.guardianKeyFile, ...(task.gasSponsorKeyFile ? [task.gasSponsorKeyFile] : []), game.sponsorKeyFile])
      if (new Wallet((await taskPrivateFile(file)).trim()).address === bot) fail("HOSTED_DAEMON_OPPONENT_OPERATOR_COLLISION");
    return { config: { version: 1, port: value.port, hosted, ...(autonomy ? { autonomy } : {}), executor: { taskConfigFile, gameConfigFile } }, task, game };
  } catch (error) { if (error instanceof HostedError) throw error; throw new HostedError("HOSTED_DAEMON_PRIVATE_CONFIG_REQUIRED", 503); }
}
export async function startHostedDaemon(loaded: LoadedHostedDaemon, options: { recover?: boolean } = {}) {
  const game = createHostedGameExecutor(loaded.game, { gameDeadline: input => service.gameDeadline(input) }), task = createHostedTaskExecutor(loaded.task, { reward: input => game.rewardTask(input) });
  const autonomous = loaded.config.autonomy ? new HostedAutonomyExecutor(task, loaded.config.autonomy, { shouldContinue: agentId => service.mayContinue(agentId) }) : undefined;
  const executor: HostedExecutor = { capabilities: {
    ...(loaded.task.metered ? { inference: { priceRaw: loaded.task.metered.priceRaw, creditsRaw: loaded.task.metered.creditsRaw,
      models: loaded.task.metered.catalog.map(({ id, inputMicroCreditsPerToken, outputMicroCreditsPerToken }) => ({ id, inputMicroCreditsPerToken, outputMicroCreditsPerToken })) } } : {}),
    ...(autonomous ? { autonomy: { maxTasks: autonomous.config.maxTasks, durationMs: autonomous.config.durationMs, plannerPriceRaw: autonomous.config.plannerPriceRaw } } : {}),
  }, execute(input) { if (input.run.action === "autonomous") { if (!autonomous) throw new HostedError("HOSTED_AUTONOMY_NOT_CONFIGURED", 503); return autonomous.execute(input); } return ["provision", "deposit", "task", "reward-task", "metered-task"].includes(input.run.action) ? task.execute(input) : game.execute(input); }, finance: agent => task.finance(agent),
    canRecoverTerminal: input => input.run.action === "autonomous" && autonomous ? autonomous.canRecoverTerminal(input) : Promise.resolve(false) };
  let service: HostedService;
  try { service = await HostedService.open(loaded.config.hosted, executor, options); } catch (error) { await game.close(); throw error; }
  const server = createHostedHttpServer(service);
  let closing: Promise<void> | undefined;
  const close = () => closing ??= (async () => {
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    try { await service.close(); await stopped; } finally { await game.close(); }
  })();
  try { server.listen(loaded.config.port, "127.0.0.1"); await once(server, "listening"); }
  catch (error) { await close(); throw new HostedError("HOSTED_DAEMON_START_FAILED", 503); }
  return { service, server, close };
}
export async function hostedMain(args: string[], env: NodeJS.ProcessEnv = process.env) {
  const [major, minor] = process.versions.node.split(".").map(Number);
  if (major < 22 || major === 22 && minor < 19) fail("HOSTED_NODE_22_REQUIRED");
  if (args.some(arg => !["--check", "--start", "--recover"].includes(arg)) || new Set(args).size !== args.length || args.includes("--check") && args.includes("--start") || args.includes("--recover") && !args.includes("--start")) fail("HOSTED_DAEMON_ARGUMENT_INVALID");
  if (!env.HOSTED_AGENTS_CONFIG) fail("HOSTED_DAEMON_CONFIG_REQUIRED");
  const loaded = await loadHostedDaemonConfig(env.HOSTED_AGENTS_CONFIG);
  if (!args.includes("--start")) { console.log(JSON.stringify({ service: "hosted-agents", checked: true })); return; }
  const runtime = await startHostedDaemon(loaded, { recover: args.includes("--recover") });
  console.log(JSON.stringify({ ready: true, service: "hosted-agents", host: "127.0.0.1", port: loaded.config.port }));
  const stop = () => { void runtime.close().catch(() => { console.error("HOSTED_DAEMON_CLOSE_FAILED"); process.exitCode = 1; }); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, stop);
  runtime.server.once("close", () => { process.off("SIGINT", stop); process.off("SIGTERM", stop); });
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  hostedMain(process.argv.slice(2)).catch(error => { console.error(error instanceof HostedError && /^HOSTED_[A-Z_0-9]{1,80}$/.test(error.code) ? error.code : "HOSTED_UNAVAILABLE"); process.exitCode = 1; });
}
