import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { runLocalDemo } from "./demo-local.js";
import { ROOT, reportDemoFailure } from "./demo-common.js";
import { loadMonadConfig } from "./demo-monad-config.js";
import { runMonadDemo } from "./demo-monad.js";
import type { RpcTransport } from "./demo-rpc.js";

const args = process.argv.slice(2);
let mode = "local", output: string | undefined, config: string | undefined, serve = false, pauseBeforeThird = false, execute = false, resume = false;
let stopAfterDeploy = false, rpcTransport: RpcTransport = "direct", rpcUrl: string | undefined, rpcUrlFile: string | undefined;
try {
for (let i = 0; i < args.length; i++) {
  const value = () => { const next = args[++i]; if (!next || next.startsWith("--")) throw new Error("ARGUMENT_VALUE_REQUIRED"); return next; };
  if (args[i] === "--mode") mode = value();
  else if (args[i] === "--output") output = resolve(value());
  else if (args[i] === "--config") config = resolve(value());
  else if (args[i] === "--serve") serve = true;
  else if (args[i] === "--pause-before-third") pauseBeforeThird = true;
  else if (args[i] === "--execute") execute = true;
  else if (args[i] === "--resume") resume = true;
  else if (args[i] === "--stop-after-deploy") stopAfterDeploy = true;
  else if (args[i] === "--rpc-url") rpcUrl = value();
  else if (args[i] === "--rpc-url-file") rpcUrlFile = resolve(value());
  else if (args[i] === "--rpc-transport") { const transport = value(); if (transport !== "direct" && transport !== "system-https-proxy") throw new Error("UNKNOWN_RPC_TRANSPORT"); rpcTransport = transport; }
  else throw new Error("UNKNOWN_ARGUMENT");
}
if (rpcUrl !== undefined && rpcUrlFile !== undefined) throw new Error("RPC_URL_OPTIONS_MUTUALLY_EXCLUSIVE");
if (mode === "local") {
  if (execute || resume || config || stopAfterDeploy || rpcUrl !== undefined || rpcUrlFile !== undefined || rpcTransport !== "direct") throw new Error("MONAD_FLAGS_REQUIRE_MONAD_MODE");
  await mkdir(join(ROOT, "demo-output"), { recursive: true });
  await runLocalDemo({ output: output ?? join(ROOT, "demo-output", `local-${Date.now()}-${randomUUID().slice(0, 8)}`), serve, pauseBeforeThird });
} else if (mode === "monad") {
  if (!config) throw new Error("MONAD_CONFIG_PATH_REQUIRED");
  if ((!execute && (resume || serve || pauseBeforeThird)) || (resume && !output)) throw new Error("RESUME_SERVE_PAUSE_REQUIRE_EXECUTE_AND_RESUME_OUTPUT");
  if (stopAfterDeploy && (!execute || serve || pauseBeforeThird)) throw new Error("STOP_AFTER_DEPLOY_REQUIRES_EXECUTE_WITHOUT_SERVE_OR_LIVE_PAUSE");
  if (execute) await mkdir(join(ROOT, "demo-output"), { recursive: true });
  await runMonadDemo(await loadMonadConfig(config), { output: output ?? join(ROOT, "demo-output", `monad-${Date.now()}-${randomUUID().slice(0, 8)}`), execute, resume, serve, pauseBeforeThird, stopAfterDeploy, rpcTransport, rpcUrl, rpcUrlFile });
} else throw new Error("MODE_LOCAL_OR_MONAD_REQUIRED");
} catch (error) {
  reportDemoFailure(error); process.exitCode = 1;
}
