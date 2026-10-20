import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { Contract, JsonRpcProvider, Wallet } from "ethers";
import { uint } from "@agentfuel/sdk/protocol";
import { cliFailure, readJson, sendOnce, withJournal, writeJson } from "./durable.mjs";
import { configValue, digest, PROBLEM, publicationData, same, TOKEN_ABI, verifyDeployment, verifyPublication } from "./protocol.mjs";

export async function publish(config, request, journalPath, privateKey) {
  configValue(config);
  if (!request || request.version !== 1 || request.problemId !== PROBLEM.problemId || !/^0x[0-9a-f]{64}$/.test(request.requestId)) throw new Error("INVALID_PUBLISH_REQUEST");
  for (const name of ["reward", "deadline"]) if (uint(request[name], name) === 0n) throw new Error("INVALID_PUBLISH_REQUEST");
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 });
  try {
    const signer = new Wallet(privateKey, provider);
    if (!same(signer.address, config.poster) || same(signer.address, config.verifier)) throw new Error("PUBLISHER_ROLE_MISMATCH");
    const escrow = await verifyDeployment(config, provider);
    return await withJournal(journalPath, digest({ config, request }), async (state, save) => {
      if (!state.manifest) {
        if (!state.transactions.create && BigInt(request.deadline) <= BigInt((await provider.getBlock("latest")).timestamp)) throw new Error("TASK_DEADLINE_PASSED");
        const token = new Contract(config.asset, TOKEN_ABI, provider);
        await sendOnce(state, save, "approve", signer, await token.approve.populateTransaction(config.escrow, request.reward));
        const receipt = await sendOnce(state, save, "create", signer, await escrow.createTask.populateTransaction(request.reward, request.deadline));
        const created = receipt.logs.filter(log => same(log.address, config.escrow)).map(log => {
          try { return escrow.interface.parseLog(log); } catch { return null; }
        }).filter(event => event?.name === "TaskCreated");
        if (created.length !== 1) throw new Error("TASK_CREATED_EVENT_REQUIRED");
        const taskId = String(created[0].args.taskId), task = await escrow.getTask(taskId);
        const manifest = { version: 1, chainId: config.chainId, escrow: config.escrow, spec: PROBLEM,
          publication: { requestId: request.requestId, taskId, poster: config.poster, asset: config.asset, account: config.account,
            verifier: config.verifier, reward: request.reward, deadline: request.deadline, protocolFeeBps: String(task.protocolFeeBps),
            specHash: digest(PROBLEM), creationTxHash: receipt.hash } };
        const typed = publicationData(manifest);
        state.manifest = { ...manifest, signature: await signer.signTypedData(typed.domain, typed.types, typed.message) };
        await save();
      }
      await verifyPublication(config, state.manifest, provider);
      return state.manifest;
    });
  } finally { provider.destroy(); }
}
async function main() {
  const [configFile, requestFile, journalFile, manifestFile, ...extra] = process.argv.slice(2);
  if (!configFile || !requestFile || !journalFile || !manifestFile || extra.length) throw new Error("PUBLISHER_ARGUMENTS_REQUIRED");
  if (!process.env.PUBLISHER_PRIVATE_KEY) throw new Error("PUBLISHER_KEY_REQUIRED");
  if (process.env.WORKER_PRIVATE_KEY || process.env.ARENA_VERIFIER_PRIVATE_KEY) throw new Error("PUBLISHER_ROLE_KEY_LEAK");
  const manifest = await publish(await readJson(configFile), await readJson(requestFile), journalFile, process.env.PUBLISHER_PRIVATE_KEY);
  await writeJson(manifestFile, manifest);
  console.log(JSON.stringify({ state: "Published", taskId: manifest.publication.taskId, txHash: manifest.publication.creationTxHash }));
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main().catch(cliFailure);
