import { once } from "node:events";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { TaskRunner, createTaskRunnerHttpServer, loadTaskRunnerConfig, parseTaskRunnerSnapshot } from "../src/task-runner/index.js";
import { createWorkflowFixture } from "./workflow-fixture.js";

export type TaskRunnerFixtureOptions = NonNullable<Parameters<typeof createWorkflowFixture>[2]> & { maxCompletionTokens?: number; workflowTimeoutMs?: number };
/** Trusted test/operator harness. Dependencies never come from HTTP. No model is dispatched during setup. */
export async function createTaskRunnerFixture(directory: string, definitions?: Parameters<typeof createWorkflowFixture>[1], options: TaskRunnerFixtureOptions = {}) {
  const { maxCompletionTokens, workflowTimeoutMs, ...modelOptions } = options;
  if (maxCompletionTokens !== undefined && (!Number.isSafeInteger(maxCompletionTokens) || maxCompletionTokens < 1 || maxCompletionTokens > 2048)) throw new Error("FIXTURE_TOKEN_LIMIT_INVALID");
  if (workflowTimeoutMs !== undefined && (!Number.isSafeInteger(workflowTimeoutMs) || workflowTimeoutMs < 5000 || workflowTimeoutMs > 300000)) throw new Error("FIXTURE_TIMEOUT_INVALID");
  await mkdir(directory, { recursive: true, mode: 0o700 }); directory = await realpath(directory);
  const fx = await createWorkflowFixture(directory, definitions, { ...modelOptions, ...(workflowTimeoutMs === undefined || modelOptions.upstreamTimeoutMs !== undefined ? {} : { upstreamTimeoutMs: workflowTimeoutMs }) });
  const keyFile = join(directory, "runner-wallet.key"), rpcUrlFile = join(directory, "runner-rpc-url"), workflowConfigFile = join(directory, "runner-profile.json"), configFile = join(directory, "task-runner.json");
  // This harness sells one cheap round, including for a root-owned real-model injection.
  if (maxCompletionTokens !== undefined) fx.config.maxCompletionTokens = maxCompletionTokens;
  if (workflowTimeoutMs !== undefined) fx.config.deadlineMs = Date.now() + workflowTimeoutMs;
  for (const provider of fx.config.providers) for (const route of provider.routes) route.solve = { ...route.solve, tiers: [route.tier], maxRounds: 1, ...(maxCompletionTokens === undefined ? {} : { maxCompletionTokens }) };
  await writeFile(keyFile, fx.options.signer.privateKey, { mode: 0o600 }); await writeFile(rpcUrlFile, fx.local.rpc, { mode: 0o600 });
  await writeFile(workflowConfigFile, JSON.stringify(fx.config), { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({ version: 1, dataDirectory: join(directory, "runner-data"), port: 8790, wallet: fx.options.signer.address, keyFile,
    profiles: [{ id: "local-fixed-b", label: "本地固定价任务", workflowConfigFile, rpcUrlFile, rpcTransport: "direct", arenaUrl: fx.options.arenaUrl, underwriterUrl: fx.options.underwriterUrl,
      timeoutMs: workflowTimeoutMs ?? fx.options.timeoutMs, pollTimeoutMs: workflowTimeoutMs ?? fx.options.pollTimeoutMs }] }), { mode: 0o600 });
  const loaded = await loadTaskRunnerConfig(configFile); loaded.walletLockDirectory = fx.options.walletLockDirectory;
  const runner = new TaskRunner(loaded), server = createTaskRunnerHttpServer(runner);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const apiUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/tasks/runs`;
  return { fx, runner, loaded, configFile, apiUrl,
    close: async () => { await runner.waitUntilIdle(); await new Promise<void>(resolve => server.close(() => resolve())); await fx.close(); } };
}
export async function waitTaskRunnerHttp(apiUrl: string, requestId: string, timeoutMs = 45000) {
  const until = Date.now() + timeoutMs;
  do {
    const response = await fetch(apiUrl + `?requestId=${requestId}`, { signal: AbortSignal.timeout(5000) });
    if (!response.ok) throw new Error("TASK_HTTP_STATE_UNAVAILABLE"); const snapshot = parseTaskRunnerSnapshot(await response.json());
    if (snapshot.run && !["Queued", "Running"].includes(snapshot.run.status)) return snapshot;
    await delay(100);
  } while (Date.now() < until);
  throw new Error("TASK_HTTP_STATE_TIMEOUT");
}
