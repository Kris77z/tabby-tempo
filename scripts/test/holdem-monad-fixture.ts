import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Contract, ContractFactory, JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { createHand } from "../../services/arena/src/holdem/index.js";
import { key, startAnvil, stopAnvil, tx } from "../../services/underwriter/test/fixture.js";
import { artifact, saveJson } from "../demo-common.js";
import { ALL_ROLES, MONAD_IDENTITY, MONAD_REPUTATION, MONAD_USDC, SIGNING_ROLES } from "../demo-monad-config.js";
import { buildHoldemMonadPlan, parseHoldemMonadConfig } from "../holdem-monad.js";

// Controlled local chain with canonical-address test doubles. This is never a public-chain certification.
export async function source(directory: string, complete = true) {
  await mkdir(directory, { mode: 0o700 }); await mkdir(join(directory, ".private"), { mode: 0o700 });
  const hand = createHand({ initialStack: 1000, smallBlind: 5, bigBlind: 10 });
  if (complete) hand.act(0, { type: "fold" });
  const replay = hand.exportTrustedReplay(), result = hand.view(0).result;
  const report = { version: 1, mode: "holdem-live", network: "local-anvil", upstreamMode: "real-kimi-system-https-proxy",
    matchId: "controlled-source-contract", phase: "Complete", verified: true,
    game: { result: result ? { reason: result.reason, winners: result.winners, contestedPot: result.contestedPot,
      payouts: result.payouts, refunds: result.refunds, finalStacks: result.finalStacks } : null },
    reward: { replayDigest: createHash("sha256").update(JSON.stringify(replay)).digest("hex"), allocations: ["0", "100000"] },
    localChain: { addresses: { wallets: [new Wallet(key(22)).address, new Wallet(key(25)).address] } } };
  await saveJson(join(directory, "report.json"), report); await saveJson(join(directory, ".private", "trusted-replay.json"), replay);
  return report;
}
export async function canonicalFixture(directory: string) {
  const local = await startAnvil();
  let provider: JsonRpcProvider | undefined;
  try {
    const response = await fetch(local.rpc, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "anvil_setChainId", params: [10143] }) });
    assert.equal((await response.json() as any).error, undefined);
    provider = new JsonRpcProvider(local.rpc, 10143, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 20 });
    const sponsor = new Wallet(key(1), provider), players: [Wallet, Wallet] = [new Wallet(key(2), provider), new Wallet(key(5), provider)];
    for (const signer of [sponsor, ...players]) await provider.send("anvil_setBalance", [signer.address, "0x3635c9adc5dea00000"]);
    const deployer = new NonceManager(sponsor);
    const deploy = async (name: string, args: unknown[] = []) => {
      const data = await artifact(name), instance = await new ContractFactory(data.abi, data.bytecode.object, deployer).deploy(...args);
      await instance.waitForDeployment(); return new Contract(await instance.getAddress(), data.abi, provider!);
    };
    const tokenOriginal = await deploy("MockERC20", ["Controlled USDC", "USDC", 6]);
    await provider.send("anvil_setCode", [MONAD_USDC, await provider.getCode(await tokenOriginal.getAddress())]);
    for (const slot of [0, 1, 2]) await provider.send("anvil_setStorageAt", [MONAD_USDC, "0x" + slot.toString(16), await provider.getStorage(await tokenOriginal.getAddress(), slot)]);
    const token = new Contract(MONAD_USDC, (await artifact("MockERC20")).abi, provider);
    const identityOriginal = await deploy("MockIdentityRegistry");
    await provider.send("anvil_setCode", [MONAD_IDENTITY, await provider.getCode(await identityOriginal.getAddress())]);
    await provider.send("anvil_setStorageAt", [MONAD_IDENTITY, "0x0", "0x" + "1".padStart(64, "0")]);
    const identity = new Contract(MONAD_IDENTITY, (await artifact("MockIdentityRegistry")).abi, provider);
    const reputationOriginal = await deploy("MockReputationRegistry", [MONAD_IDENTITY]);
    await provider.send("anvil_setCode", [MONAD_REPUTATION, await provider.getCode(await reputationOriginal.getAddress())]);
    const adapter = await deploy("ERC8004Adapter", [MONAD_IDENTITY, MONAD_REPUTATION, sponsor.address]);
    const providerWallet = new Wallet(key(4)).address;
    const manager = await deploy("CreditManager", [{ settlementAsset: MONAD_USDC, adapter: await adapter.getAddress(),
      underwriter: new Wallet(key(3)).address, treasury: sponsor.address, guardian: sponsor.address,
      relayRefunder: sponsor.address, owner: sponsor.address, maxLtvBps: 8000, grace: 3600 }]);
    const account = await deploy("AgentAccount", [MONAD_USDC, await adapter.getAddress(), sponsor.address]);
    const escrow = await deploy("TaskEscrow", [MONAD_USDC, await adapter.getAddress(), sponsor.address, sponsor.address, 0, sponsor.address]);
    await tx(manager, deployer, "setProtocolContracts", [await account.getAddress(), await escrow.getAddress()]);
    await tx(account, deployer, "setProtocolContracts", [await manager.getAddress(), await escrow.getAddress()]);
    await tx(escrow, deployer, "setProtocolContracts", [await manager.getAddress(), await account.getAddress()]);
    await tx(adapter, deployer, "setCreditManager", [await manager.getAddress()]);
    await tx(adapter, deployer, "setReporter", [await escrow.getAddress(), true]);
    await tx(token, deployer, "mint", [sponsor.address, 1000000n]);
    for (const seat of [0, 1] as const) {
      await tx(identity, deployer, "registerFor", [players[seat].address, players[seat].address]);
      await tx(account, new NonceManager(players[seat]), "setPolicy", [BigInt(seat + 1), { maxCashPerTx: 100000n, maxDebtPerTx: 0n, maxDebtPerDay: 0n, ownerFrozen: false }]);
    }
    await tx(account, deployer, "setProviderWhitelist", [providerWallet, true]);
    const addresses = { manager: await manager.getAddress(), adapter: await adapter.getAddress(), account: await account.getAddress(), escrow: await escrow.getAddress() };
    const monadConfigFile = join(directory, "monad.json"), deploymentStateFile = join(directory, "state.json");
    const roles = Object.fromEntries(ALL_ROLES.map((role, i) => [role, new Wallet(key(i + 10)).address]));
    roles.deployer = sponsor.address; roles.provider = providerWallet;
    await saveJson(monadConfigFile, { version: 1, chainId: "10143", rpcUrl: "https://controlled.invalid", explorerUrl: "https://testnet.monadexplorer.com",
      asset: { address: MONAD_USDC, symbol: "USDC", decimals: 6 }, registries: { identity: MONAD_IDENTITY, reputation: MONAD_REPUTATION },
      roles, keyFiles: Object.fromEntries(SIGNING_ROLES.map(role => [role, join(directory, role + ".key")])), upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "controlled", apiKeyFile: join(directory, "model.key"), requestOptions: { max_tokens: 512 } },
      blockedProvider: new Wallet(key(100)).address, frontendOrigin: "http://127.0.0.1:3000", contracts: addresses });
    await saveJson(deploymentStateFile, { version: 1, addresses });
    const sourceDirectory = join(directory, "source"); await source(sourceDirectory);
    const keyPaths = ["sponsor", "player0", "player1"].map(name => join(directory, name + ".key"));
    for (const [i, signer] of [sponsor, ...players].entries()) await writeFile(keyPaths[i], signer.privateKey, { mode: 0o600 });
    const config = parseHoldemMonadConfig({ version: 1, sourceDirectory, monadConfigFile, deploymentStateFile,
      sponsor: { wallet: sponsor.address, keyFile: keyPaths[0] }, players: players.map((signer, seat) => ({ agentId: String(seat + 1), wallet: signer.address, keyFile: keyPaths[seat + 1] })) });
    const { plan } = await buildHoldemMonadPlan(config);
    return { provider, sponsor, players, token, account, manager, config, plan,
      runtime: { provider, token, account, manager }, close: async () => { provider?.destroy(); await stopAnvil(local.child); } };
  } catch (error) { provider?.destroy(); await stopAnvil(local.child); throw error; }
}

