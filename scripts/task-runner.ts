import { once } from "node:events";
import { TaskRunner, createTaskRunnerHttpServer, loadTaskRunnerConfig, TaskRunnerError } from "@agentfuel/pi-loop/task-runner";

async function main() {
  const [major, minor] = process.versions.node.split(".").map(Number); if (major < 22 || major === 22 && minor < 19) throw new TaskRunnerError("TASK_NODE_22_REQUIRED");
  if (process.argv.length !== 2) throw new TaskRunnerError("TASK_RUNNER_ENV_CONFIG_ONLY");
  const path = process.env.TASK_RUNNER_CONFIG; if (!path) throw new TaskRunnerError("TASK_RUNNER_CONFIG_REQUIRED");
  const loaded = await loadTaskRunnerConfig(path), runner = new TaskRunner(loaded), server = createTaskRunnerHttpServer(runner);
  server.listen(loaded.config.port, "127.0.0.1"); await once(server, "listening");
  console.log(JSON.stringify({ ready: true, service: "task-runner", host: "127.0.0.1", port: loaded.config.port }));
  let closing = false;
  const close = async () => {
    if (closing) return; closing = true;
    const stopped = new Promise<void>(resolve => server.close(() => resolve()));
    await runner.waitUntilIdle(); await stopped;
  };
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close().catch(() => { process.exitCode = 1; }); });
}
main().catch(error => { console.error(error instanceof TaskRunnerError ? error.code : "TASK_RUNNER_UNAVAILABLE"); process.exitCode = 1; });
