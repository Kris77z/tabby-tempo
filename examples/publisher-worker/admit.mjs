import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { JsonRpcProvider } from "ethers";
import { cliFailure, readJson, writeJson } from "./durable.mjs";
import { configValue, verifyPublication } from "./protocol.mjs";

/** Operator admission for this sample only. The publisher cannot change Arena's built-in problem. */
export async function admit(config, manifest, ipcDirectory) {
  configValue(config);
  if (typeof ipcDirectory !== "string" || !ipcDirectory.startsWith("/") || `${ipcDirectory}/settler.sock`.length > 100) throw new Error("INVALID_IPC_DIRECTORY");
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
  try {
    const { task } = await verifyPublication(config, manifest, provider);
    if (task.status !== 1n && task.status !== 2n) throw new Error("TASK_NOT_ADMISSIBLE");
    if (BigInt((await provider.getBlock("latest")).timestamp) >= task.deadline) throw new Error("TASK_DEADLINE_PASSED");
    return { rpcUrl: config.rpcUrl, chainId: config.chainId, escrowAddress: config.escrow, ipcDirectory, allowManual: false,
      tasks: { [manifest.publication.taskId]: { problemId: "sum-integers" } } };
  } finally { provider.destroy(); }
}
async function main() {
  const [configFile, manifestFile, ipcDirectory, arenaFile, ...extra] = process.argv.slice(2);
  if (!configFile || !manifestFile || !ipcDirectory || !arenaFile || extra.length) throw new Error("ADMISSION_ARGUMENTS_REQUIRED");
  if (process.env.PUBLISHER_PRIVATE_KEY || process.env.WORKER_PRIVATE_KEY || process.env.ARENA_VERIFIER_PRIVATE_KEY) throw new Error("ADMISSION_ROLE_KEY_LEAK");
  const config = await admit(await readJson(configFile), await readJson(manifestFile), ipcDirectory);
  await writeJson(arenaFile, config);
  console.log(JSON.stringify({ state: "Admitted", taskId: Object.keys(config.tasks)[0] }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main().catch(cliFailure);
