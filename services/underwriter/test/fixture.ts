import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createServer as netServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet, ZeroAddress, type Signer } from "ethers";
import { UINT256_MAX, type Config } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { Underwriter } from "../src/underwriter.js";
export const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`; // Local synthetic keys only.
export const tx = async (contract: Contract, signer: Signer, method: string, args: unknown[] = [], overrides = {}) =>
  (await contract.connect(signer).getFunction(method)(...args, overrides)).wait();
export const read = (contract: Contract, method: string, args: unknown[] = []) => contract.getFunction(method).staticCall(...args);

export async function startAnvil() {
  const reserved = netServer();
  reserved.listen(0, "127.0.0.1");
  await once(reserved, "listening");
  const port = (reserved.address() as { port: number }).port;
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  const child = spawn(process.env.ANVIL_BIN || "anvil", ["--host", "127.0.0.1", "--port", String(port),
    "--chain-id", "31337", "--accounts", "0", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let failure = "";
  child.stderr!.on("data", chunk => { failure += String(chunk).slice(0, 1000); });
  child.on("error", error => { failure = error.message; });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null || failure) { await stopAnvil(child); throw new Error(`Anvil startup failed: ${failure}`); }
    try {
      const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(200) });
      if ((await response.json() as { result: string }).result === "0x7a69") return { rpc, child };
    } catch { /* Retry only our newly spawned local process. */ }
    await delay(50);
  }
  await stopAnvil(child);
  throw new Error("Own Anvil did not become ready within 5 seconds");
}

export async function stopAnvil(child: ChildProcess) {
  if (child.exitCode !== null || !child.pid) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const result = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
  if (!result) { child.kill("SIGKILL"); await exited; }
}

export async function fixture(rpc: string, evidenceDir: string, decimals: 6 | 18, options: { refunderKey?: string } = {}) {
  const provider = new JsonRpcProvider(rpc, undefined, { cacheTimeout: -1, pollingInterval: 20 });
  const adminWallet = new Wallet(key(1), provider);
  const agentWallet = new Wallet(key(2), provider);
  const admin = new NonceManager(adminWallet);
  const agent = new NonceManager(agentWallet);
  const signingKey = key(3);
  const payee = new Wallet(key(4)).address;
  for (const address of [adminWallet.address, agentWallet.address]) {
    await provider.send("anvil_setBalance", [address, "0x3635c9adc5dea00000"]);
  }
  const deploy = async (name: string, args: unknown[] = []) => {
    const artifact = JSON.parse(await readFile(new URL(`../../../contracts/out/${name}.sol/${name}.json`, import.meta.url), "utf8"));
    const deployed = await new ContractFactory(artifact.abi, artifact.bytecode.object, admin).deploy(...args);
    await deployed.waitForDeployment();
    return new Contract(await deployed.getAddress(), artifact.abi, provider);
  };
  const identity = await deploy("MockIdentityRegistry");
  const reputation = await deploy("MockReputationRegistry", [await identity.getAddress()]);
  const adapter = await deploy("ERC8004Adapter", [await identity.getAddress(), await reputation.getAddress(), adminWallet.address]);
  const token = decimals === 6 ? await deploy("MockERC20", ["Test USDC", "USDC", 6]) : undefined;
  const asset = token ? await token.getAddress() : ZeroAddress;
  const manager = await deploy("CreditManager", [{ settlementAsset: asset, adapter: await adapter.getAddress(),
    underwriter: new Wallet(signingKey).address, treasury: adminWallet.address, guardian: adminWallet.address,
    relayRefunder: options.refunderKey ? new Wallet(options.refunderKey).address : adminWallet.address, owner: adminWallet.address, maxLtvBps: 8000, grace: 3600 }]);
  const account = await deploy("AgentAccount", [asset, await adapter.getAddress(), adminWallet.address]);
  const escrow = await deploy("TaskEscrow", [asset, await adapter.getAddress(), adminWallet.address, adminWallet.address, 0, adminWallet.address]);
  await tx(manager, admin, "setProtocolContracts", [await account.getAddress(), await escrow.getAddress()]);
  await tx(account, admin, "setProtocolContracts", [await manager.getAddress(), await escrow.getAddress()]);
  await tx(escrow, admin, "setProtocolContracts", [await manager.getAddress(), await account.getAddress()]);
  await tx(adapter, admin, "setCreditManager", [await manager.getAddress()]);
  await tx(adapter, admin, "setReporter", [await escrow.getAddress(), true]);
  const unit = 10n ** BigInt(decimals);
  await tx(manager, admin, "setGlobalLimits", [50n * unit, 20n * unit]);
  await tx(identity, admin, "registerFor", [agentWallet.address, agentWallet.address]);
  const agentId = 1n;
  await tx(manager, admin, "enrollAgent", [agentId]);
  await tx(account, agent, "setPolicy", [agentId, { maxCashPerTx: unit, maxDebtPerTx: unit, maxDebtPerDay: 10n * unit, ownerFrozen: false }]);
  await tx(account, admin, "setProviderWhitelist", [payee, true]);
  if (token) {
    await tx(token, admin, "mint", [adminWallet.address, 100n * unit]);
    await tx(token, admin, "mint", [agentWallet.address, unit]);
    for (const contract of [manager, escrow]) await tx(token, admin, "approve", [await contract.getAddress(), UINT256_MAX]);
    await tx(token, agent, "approve", [await account.getAddress(), UINT256_MAX]);
  }
  await tx(manager, admin, "deposit", [10n * unit], token ? {} : { value: 10n * unit });
  await tx(account, agent, "depositCash", [agentId, 4n * unit / 100n], token ? {} : { value: 4n * unit / 100n });
  const config: Config = { rpcUrl: rpc, chainId: 31337n, managerAddress: await manager.getAddress(), settlementAsset: asset,
    assetDecimals: decimals, tokenUsdPrice: 10n ** 18n, privateKey: signingKey, evidenceDir, host: "127.0.0.1", port: 8787 };
  const underwriter = new Underwriter(config);
  await underwriter.initialize();
  const server = createHttpServer(underwriter);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const http = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, body?: unknown) => {
    const response = await fetch(http + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() as Record<string, any> };
  };
  const authorize = (taskId: bigint, nonce: bigint, id = agentId) =>
    request("/authorize", { agentId: id.toString(), taskId: taskId.toString(), nonce: nonce.toString() });
  const task = async (reward = 15n * unit / 100n, remaining = 172800) => {
    const now = (await provider.getBlock("latest"))!.timestamp;
    const receipt = await tx(escrow, admin, "createTask", [reward, now + remaining], token ? {} : { value: reward });
    const event = receipt.logs.map((log: any) => { try { return escrow.interface.parseLog(log); } catch { return null; } })
      .find((event: any) => event?.name === "TaskCreated");
    const id = BigInt(event!.args.taskId);
    await tx(escrow, agent, "acceptTask", [id, agentId]);
    return id;
  };
  const providerBalance = () => token ? read(token, "balanceOf", [payee]) : provider.getBalance(payee);
  return { provider, admin, agent, identity, reputation, adapter, manager, account, escrow, token, unit, config, agentId,
    agentAddress: agentWallet.address, payee, http, request, authorize, task, providerBalance, underwriter,
    close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); underwriter.close(); provider.destroy(); } };
}

