import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { syntheticKey } from "./demo-common.js";
import { ALL_ROLES, MONAD_IDENTITY, MONAD_REPUTATION, MONAD_USDC, parseMonadConfig, SIGNING_ROLES, type Role } from "./demo-monad-config.js";
import { runMonadDemo } from "./demo-monad.js";

const directory = await mkdtemp(join(tmpdir(), "af-public-readonly-"));
try {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--rpc-url")) throw new Error("ONLY_EXPLICIT_PUBLIC_RPC_URL_ARGUMENT_SUPPORTED");
  const roles = { deployer: 1, guardian: 1, treasury: 1, poster: 1, refunder: 1, rotatedOwner: 1,
    underwriter: 2, verifier: 3, hero: 11, veteran: 12, defaulted: 13, rotatedWallet: 15, provider: 15 } as Record<Role, number>;
  const config = parseMonadConfig({ version: 1, chainId: "10143", rpcUrl: args[1] ?? "https://testnet-rpc.monad.xyz", explorerUrl: "https://testnet.monadexplorer.com",
    asset: { address: MONAD_USDC, symbol: "USDC", decimals: 6 }, registries: { identity: MONAD_IDENTITY, reputation: MONAD_REPUTATION },
    roles: Object.fromEntries(ALL_ROLES.map(role => [role, new Wallet(syntheticKey(roles[role])).address])),
    keyFiles: Object.fromEntries(SIGNING_ROLES.map(role => [role, join(directory, `ABSENT-${roles[role]}.key`)])),
    upstream: { name: "kimi", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k2.5", apiKeyFile: join(directory, "ABSENT-kimi.key"), requestOptions: { max_tokens: 1024 } },
    blockedProvider: new Wallet(syntheticKey(99)).address });
  console.log("SYNTHETIC READ-ONLY FIXTURE: DO NOT FUND THESE PUBLIC TEST ADDRESSES. No key files exist; no signing, broadcasting or model API call.");
  const result = await runMonadDemo(config, { output: directory });
  if (!("canStartFresh" in result) || result.canStartFresh !== false) throw new Error("SYNTHETIC_FIXTURE_MUST_NOT_BE_EXECUTABLE");
} catch (error) {
  const message = (error as Error).message;
  console.error(/^[A-Z_]+$/.test(message) ? message : "PUBLIC_RPC_PREFLIGHT_UNAVAILABLE_NO_TRANSACTIONS_SENT"); process.exitCode = 1;
} finally { await rm(directory, { recursive: true, force: true }); }
