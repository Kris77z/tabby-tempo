import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, ZeroHash } from "ethers";
import { fixture, key, startAnvil, stopAnvil, tx } from "../../services/underwriter/test/fixture.js";
import { rejectedTransaction } from "../../scripts/demo-common.js";
import { validateDeployment } from "../lib/config";

// Synthetic local identities; the rejected transaction is actually mined on our own Anvil.
export async function rejectionFixture() {
  const directory = await mkdtemp(join(tmpdir(), "infercredit-rejection-test-"));
  const local = await startAnvil();
  const f = await fixture(local.rpc, join(directory, "underwriter"), 6);
  try {
    for (const id of [2n, 3n]) {
      await tx(f.identity, f.admin, "registerFor", [f.agentAddress, f.agentAddress]);
      await tx(f.manager, f.admin, "enrollAgent", [id]);
    }
    const config = validateDeployment({ chainId: "31337", network: "Local Anvil rejection test · MOCK registries", rpcUrl: local.rpc,
      deploymentBlock: 0, explorerUrl: "https://explorer.example.invalid", underwriterUrl: f.http,
      asset: { address: f.config.settlementAsset, symbol: "USDC", decimals: 6 },
      contracts: { manager: await f.manager.getAddress(), adapter: await f.adapter.getAddress(), account: await f.account.getAddress(), escrow: await f.escrow.getAddress() },
      agents: [1, 2, 3].map(id => ({ id: String(id), name: `Agent ${id}` })), providers: [{ name: "Local test provider", address: f.payee }] });
    const auth = { agentId: 1, taskId: 0, principalCap: 0, feeBps: 0, riskTier: 0, identityVersion: 0,
      authDeadline: 0, loanDueAt: 0, nonce: 0, evidenceHash: ZeroHash };
    const target = "0x000000000000000000000000000000000000dEaD";
    const rejected = await rejectedTransaction(f.provider, new Wallet(key(2), f.provider), f.account, "payProvider",
      [1, target, 120000, ZeroHash, auth, "0x"]);
    const successful = await tx(f.manager, f.admin, "setGlobalLimits", [50n * f.unit, 20n * f.unit]);
    const state = { addresses: config.contracts, agents: { hero: "1" }, reverse: { spendRejected: { ...rejected, name: "SpendRejected", reason: "1" } },
      contexts: { privateAuthorization: "PRIVATE_TEST_CANARY_NEVER_EXPORT" } };
    const statePath = join(directory, "state.json"), manifestPath = join(directory, "manifest.json");
    await writeFile(statePath, JSON.stringify(state)); await writeFile(manifestPath, JSON.stringify(config));
    return { f, config, state, statePath, manifestPath, target, successful,
      save: () => writeFile(statePath, JSON.stringify(state)),
      close: async () => { await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); } };
  } catch (error) { await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); throw error; }
}
