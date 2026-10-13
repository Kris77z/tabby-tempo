import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { Contract } from "ethers";
import { loadMonadConfig, deployedContracts } from "./demo-monad-config.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";
import { read } from "./demo-common.js";

const directory = resolve(process.argv[2] ?? "demo-output/monad-hosted-20261012");
const configFile = "/Users/jungle/.config/agentfuel/monad-demo-20261002T011344Z-4df31740/demo.monad-ankr.json";
const rpcUrlFile = "/Users/jungle/.config/agentfuel/alchemy-b59e30385b32/rpc-url";
await mkdir(directory, { recursive: true, mode: 0o700 });
const report: any = { observedAt: new Date().toISOString(), readOnly: true, transactionsSent: 0, modelRequests: 0, complete: false };
let connection: Awaited<ReturnType<typeof monadProvider>> | undefined;
try {
  const config = await loadMonadConfig(configFile);
  const manifest = JSON.parse(await readFile("demo-output/monad-20261002-deployment-89b14f6d/manifest.json", "utf8"));
  connection = await monadProvider(await readRpcUrlFile(rpcUrlFile), "direct");
  const rpc = connection.provider; report.chainId = String((await rpc.getNetwork()).chainId);
  console.log("MONAD_CONNECTED");
  const c = await deployedContracts({ ...config, contracts: manifest.contracts }, rpc, manifest.contracts);
  report.contracts = manifest.contracts; report.deploymentVerified = true;
  const token = new Contract(config.asset.address, ["function balanceOf(address) view returns(uint256)"], rpc);
  report.roles = [];
  for (const role of ["poster", "guardian", "verifier", "refunder", "treasury", "hero"] as const) {
    const address = config.roles[role];
    report.roles.push({ role, address, nativeWei: String(await rpc.getBalance(address)), testUsdcRaw: String(await read(token, "balanceOf", [address])), latestNonce: await rpc.getTransactionCount(address, "latest"), pendingNonce: await rpc.getTransactionCount(address, "pending") });
  }
  report.fee = (await rpc.getFeeData()).toJSON();
  report.vaultBalance = String(await read(c.manager, "vaultBalance")); report.totalOutstanding = String(await read(c.manager, "totalOutstanding"));
  report.payToWhitelisted = await read(c.account, "providerWhitelist", [config.roles.refunder]);
  const next = Number(await read(c.escrow, "nextTaskId")); report.nextTaskId = next; report.unfinishedTasks = [];
  for (let id = 1; id < next; id++) {
    const task = await read(c.escrow, "getTask", [id]);
    if ([1n, 2n].includes(task.status)) report.unfinishedTasks.push({ id, poster: task.poster, reward: String(task.reward), agentId: String(task.agentId), deadline: String(task.deadline), status: String(task.status) });
  }
  const identity = new Contract(config.registries.identity, ["function ownerOf(uint256) view returns(address)", "function getAgentWallet(uint256) view returns(address)"], rpc);
  report.opponent = { agentId: "1999", owner: await read(identity, "ownerOf", [1999]), wallet: await read(identity, "getAgentWallet", [1999]) };
  report.complete = true;
} catch (error: any) { report.error = /^[A-Z0-9_]+$/.test(error.message ?? "") ? error.message : "MONAD_PREFLIGHT_UNAVAILABLE"; report.errorCode = /^[A-Z0-9_]+$/.test(error.code ?? "") ? error.code : undefined; }
finally { connection?.close(); await writeFile(join(directory, "preflight.json"), JSON.stringify(report, null, 2), { mode: 0o600 }); }
console.log(JSON.stringify(report));
if (!report.complete) process.exitCode = 1;
