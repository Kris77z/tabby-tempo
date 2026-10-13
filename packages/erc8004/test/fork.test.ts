import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { createServer as reservePort } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Contract, JsonRpcProvider, NonceManager, Wallet, ZeroAddress } from "ethers";
import { IDENTITY_ABI, IdentityRegistry, type WalletConsent } from "../src/identity.js";
import { REPUTATION_ABI, ReputationRegistry } from "../src/reputation.js";

const IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
const REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
const BLOCK = 67277702;
const BLOCK_HASH = "0xd4ff9cd39736b12eb5693ec964ebccd7d09f50e615d8e0a73e5f84887fe3647e";
const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;

async function stop(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), delay(2000).then(() => false)])) { child.kill("SIGKILL"); await exited; }
}
async function localFork() {
  const reservation = reservePort(); reservation.listen(0, "127.0.0.1"); await once(reservation, "listening");
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>(resolve => reservation.close(() => resolve()));
  const child = spawn(process.env.ANVIL_BIN || "anvil", ["--host", "127.0.0.1", "--port", String(port), "--accounts", "0", "--silent",
    "--fork-url", process.env.MONAD_FORK_RPC ?? "https://testnet-rpc.monad.xyz", "--fork-block-number", String(BLOCK),
    "--timeout", "25000", "--retries", "2", "--compute-units-per-second", "15"], { stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr!.on("data", chunk => { error += String(chunk).slice(0, 2000); });
  child.on("error", failure => { error = failure.message; });
  const rpc = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 600; i++) {
    if (child.exitCode !== null) { await stop(child); throw new Error(`LOCAL_FORK_START_FAILED: ${error}`); }
    try {
      const response = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(200) });
      if ((await response.json() as { result: string }).result === "0x279f") return { rpc, child };
    } catch { /* Wait only for the localhost child we created. */ }
    await delay(100);
  }
  await stop(child); throw new Error(`LOCAL_FORK_START_TIMEOUT: ${error}`);
}

test("TypeScript wrappers consume canonical identity/reputation on pinned local Monad fork", { timeout: 240000 }, async () => {
  let child: ChildProcess | undefined; let provider: JsonRpcProvider | undefined;
  try {
    const fork = await localFork(); child = fork.child;
    provider = new JsonRpcProvider(fork.rpc, undefined, { cacheTimeout: -1, pollingInterval: 50 });
    const block = await provider.getBlock(BLOCK);
    assert.equal(block?.hash, BLOCK_HASH); assert.equal((await provider.getNetwork()).chainId, 10143n);
    const identity = new IdentityRegistry({ provider, address: IDENTITY, expectedChainId: 10143n });
    const reputation = new ReputationRegistry({ provider, address: REPUTATION, expectedChainId: 10143n });
    const agent0 = await identity.readIdentity(0n);
    assert.equal(agent0.agentId, 0n); assert.equal(agent0.owner, "0x0b3DD790A902D1E0F1782c2A130336B1398f68Ea");
    const reputationContract = new Contract(REPUTATION, REPUTATION_ABI, provider);
    assert.equal(await reputationContract.getFunction("getIdentityRegistry").staticCall(), IDENTITY);
    const ownerWallet = new Wallet(key(0x80041001), provider);
    const newOwnerWallet = new Wallet(key(0x80041002), provider);
    const newWallet = new Wallet(key(0x80041003));
    const reporterWallet = new Wallet(key(0x80041004), provider);
    const otherWallet = new Wallet(key(0x80041005), provider);
    for (const wallet of [ownerWallet, newOwnerWallet, reporterWallet, otherWallet]) await provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
    const owner = new NonceManager(ownerWallet); const newOwner = new NonceManager(newOwnerWallet);
    const reporter = new NonceManager(reporterWallet); const other = new NonceManager(otherWallet);
    const registration = await identity.register(owner, "ipfs://agentfuel-ts-wrapper-local-fork");
    assert.equal(registration.agentId, 1963n);
    assert.equal((await identity.readIdentity(registration.agentId)).owner, ownerWallet.address);
    const consent = await identity.signWalletConsent(newWallet, registration.agentId);
    await identity.bindWallet(owner, consent);
    assert.equal((await identity.readIdentity(registration.agentId)).wallet, newWallet.address);
    await identity.transferIdentity(owner, registration.agentId, newOwnerWallet.address);
    const transferred = await identity.readIdentity(registration.agentId);
    assert.equal(transferred.owner, newOwnerWallet.address); assert.equal(transferred.wallet, ZeroAddress);
    await assert.rejects(identity.bindWallet(newOwner, consent), /IDENTITY_OWNER_CHANGED/);
    // Also exercise the real canonical signature rejection, beyond the wrapper guard.
    const rawIdentity = new Contract(IDENTITY, IDENTITY_ABI, newOwner);
    await assert.rejects(rawIdentity.getFunction("setAgentWallet").staticCall(consent.agentId, consent.newWallet, consent.deadline, consent.signature), /invalid wallet sig/);
    const currentConsent = await identity.signWalletConsent(newWallet, registration.agentId);
    await identity.bindWallet(newOwner, currentConsent);
    assert.equal((await identity.readIdentity(registration.agentId)).wallet, newWallet.address);
    for (const patch of [{ chainId: 31337n }, { registryAddress: REPUTATION }]) {
      await assert.rejects(identity.bindWallet(newOwner, { ...currentConsent, ...patch } as WalletConsent), /WALLET_CONSENT_DOMAIN_MISMATCH/);
    }
    const wrongNetwork = new IdentityRegistry({ provider, address: IDENTITY, expectedChainId: 31337n });
    await assert.rejects(wrongNetwork.readIdentity(0n), /NETWORK_MISMATCH/);
    await assert.rejects(reputation.giveFeedback(newOwner, { agentId: registration.agentId, value: 100n, valueDecimals: 0, tag1: "infercredit", tag2: "repayment" }), /Self-feedback not allowed/);
    await reputation.giveFeedback(reporter, { agentId: registration.agentId, value: -125n, valueDecimals: 2, tag1: "infercredit", tag2: "default" });
    await reputation.giveFeedback(other, { agentId: registration.agentId, value: 999n, valueDecimals: 2, tag1: "infercredit", tag2: "default" });
    const filtered = await reputation.readSummary(registration.agentId, [reporterWallet.address], "infercredit", "default");
    assert.deepEqual(filtered, { count: 1n, summaryValue: -125n, summaryValueDecimals: 2n });
    const external = await reputation.readSummary(registration.agentId, [otherWallet.address], "infercredit", "default");
    assert.deepEqual(external, { count: 1n, summaryValue: 999n, summaryValueDecimals: 2n });
    const feedback = await reputation.readFeedback(registration.agentId, reporterWallet.address, 1n);
    assert.deepEqual(feedback, { value: -125n, valueDecimals: 2n, tag1: "infercredit", tag2: "default", revoked: false });
    await assert.rejects(reputation.readSummary(registration.agentId, [], "infercredit", "default"), /NONEMPTY_CLIENT_FILTER_REQUIRED/);
    await assert.rejects(reputationContract.getFunction("getSummary").staticCall(registration.agentId, [], "infercredit", "default"), /clientAddresses required/);
    await reputation.revokeFeedback(reporter, registration.agentId, 1n);
    assert.equal((await reputation.readFeedback(registration.agentId, reporterWallet.address, 1n)).revoked, true);
    assert.equal((await reputation.readSummary(registration.agentId, [reporterWallet.address], "infercredit", "default")).count, 0n);
  } finally { provider?.destroy(); await stop(child); }
});
