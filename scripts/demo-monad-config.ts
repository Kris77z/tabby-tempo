import { readFile, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { Contract, getAddress, JsonRpcProvider, keccak256, toUtf8Bytes, ZeroAddress, ZeroHash } from "ethers";
import { IDENTITY_ABI, REPUTATION_ABI } from "../packages/erc8004/src/index.js";
import { artifact, json, read } from "./demo-common.js";
import type { Json } from "../packages/sdk/src/protocol.js";

export const MONAD_CHAIN_ID = 10143n;
export const MONAD_USDC = "0x534b2f3A21130d7a60830c2Df862319e593943A3";
export const MONAD_IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const MONAD_REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const SIGNING_ROLES = ["deployer", "underwriter", "verifier", "guardian", "treasury", "poster", "hero", "veteran", "defaulted", "rotatedOwner", "rotatedWallet"] as const;
export const ALL_ROLES = [...SIGNING_ROLES, "provider", "refunder"] as const;
export type SigningRole = typeof SIGNING_ROLES[number];
export type Role = typeof ALL_ROLES[number];
export type ContractAddresses = { manager: string; adapter: string; account: string; escrow: string };
export interface MonadConfig {
  version: 1; chainId: "10143"; rpcUrl: string; explorerUrl: string;
  asset: { address: string; symbol: "USDC"; decimals: 6 };
  registries: { identity: string; reputation: string };
  roles: Record<Role, string>; keyFiles: Record<SigningRole, string>;
  upstream: { name: "kimi"; baseUrl: string; model: string; apiKeyFile: string; requestOptions: Record<string, Json> };
  contracts?: ContractAddresses;
  blockedProvider: string; frontendOrigin: string;
}
const address = (value: unknown, field: string) => {
  if (typeof value !== "string") throw new Error(`INVALID_${field}`);
  let result: string; try { result = getAddress(value); } catch { throw new Error(`INVALID_${field}`); }
  if (result === ZeroAddress) throw new Error(`INVALID_${field}`); return result;
};
const absoluteFile = (value: unknown, field: string) => {
  if (typeof value !== "string" || !isAbsolute(value)) throw new Error(`ABSOLUTE_${field}_REQUIRED`);
  return resolve(value);
};
function https(value: unknown, field: string) {
  if (typeof value !== "string") throw new Error(`INVALID_${field}`);
  let url: URL; try { url = new URL(value); } catch { throw new Error(`INVALID_${field}`); }
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) throw new Error(`INVALID_${field}`);
  return url.toString().replace(/\/$/, "");
}
export function parseMonadConfig(input: unknown): MonadConfig {
  const data = input as Record<string, any>;
  if (!data || typeof data !== "object" || data.version !== 1 || data.chainId !== "10143") throw new Error("MONAD_CONFIG_VERSION_CHAIN_REQUIRED");
  const roles = Object.fromEntries(ALL_ROLES.map(role => [role, address(data.roles?.[role], `ROLE_${role.toUpperCase()}`)])) as Record<Role, string>;
  const management = [roles.deployer, roles.guardian, roles.treasury, roles.poster];
  if (roles.provider === roles.poster) throw new Error("PROVIDER_POSTER_MUST_DIFFER");
  const isolated = [roles.underwriter, roles.verifier, roles.hero, roles.veteran, roles.defaulted];
  if (new Set(isolated).size !== isolated.length || isolated.some(role => management.includes(role))) throw new Error("SIGNER_AND_AGENT_ISOLATION_REQUIRED");
  if (roles.rotatedOwner === roles.veteran || roles.rotatedWallet === roles.veteran || roles.rotatedWallet === roles.rotatedOwner || isolated.includes(roles.rotatedOwner) || isolated.includes(roles.rotatedWallet)) throw new Error("IDENTITY_ROTATION_ROLES_MUST_DIFFER");
  const keyFiles = Object.fromEntries(SIGNING_ROLES.map(role => [role, absoluteFile(data.keyFiles?.[role], `KEY_FILE_${role.toUpperCase()}`)])) as Record<SigningRole, string>;
  if (SIGNING_ROLES.some(role => role !== "verifier" && keyFiles[role] === keyFiles.verifier)) throw new Error("VERIFIER_KEY_FILE_MUST_BE_EXCLUSIVE");
  if (data.asset?.symbol !== "USDC" || data.asset?.decimals !== 6 || address(data.asset?.address, "ASSET") !== MONAD_USDC) throw new Error("MONAD_TEST_USDC6_REQUIRED");
  const apiBase = https(data.upstream?.baseUrl, "KIMI_BASE_URL");
  const apiHost = new URL(apiBase).hostname;
  if (data.upstream?.name !== "kimi" || !["api.moonshot.cn", "api.moonshot.ai"].includes(apiHost) || new URL(apiBase).pathname !== "/v1" || typeof data.upstream.model !== "string" || !data.upstream.model.trim()) throw new Error("OFFICIAL_KIMI_ENDPOINT_MODEL_REQUIRED");
  const requestOptions = data.upstream.requestOptions;
  if (!requestOptions || typeof requestOptions !== "object" || Array.isArray(requestOptions) || !Number.isSafeInteger(requestOptions.max_tokens) || requestOptions.max_tokens < 256 || requestOptions.max_tokens > 8192 || ["model", "messages", "stream"].some(key => Object.hasOwn(requestOptions, key))) throw new Error("BOUNDED_KIMI_REQUEST_OPTIONS_REQUIRED");
  const contracts = data.contracts ? Object.fromEntries(["manager", "adapter", "account", "escrow"].map(name => [name, address(data.contracts[name], `CONTRACT_${name.toUpperCase()}`)])) as ContractAddresses : undefined;
  if (contracts && new Set(Object.values(contracts)).size !== 4) throw new Error("DISTINCT_CONTRACT_ADDRESSES_REQUIRED");
  const blockedProvider = address(data.blockedProvider, "BLOCKED_PROVIDER");
  if (Object.values(roles).includes(blockedProvider)) throw new Error("BLOCKED_PROVIDER_MUST_BE_DISTINCT");
  const frontendOrigin = data.frontendOrigin ?? "http://127.0.0.1:3000";
  if (frontendOrigin !== "http://127.0.0.1:3000" && frontendOrigin !== "http://localhost:3000") throw new Error("LOCAL_FRONTEND_ORIGIN_REQUIRED");
  if (address(data.registries?.identity, "IDENTITY") !== MONAD_IDENTITY || address(data.registries?.reputation, "REPUTATION") !== MONAD_REPUTATION) throw new Error("VERIFIED_MONAD_CANONICAL_REGISTRIES_REQUIRED");
  return { version: 1, chainId: "10143", rpcUrl: https(data.rpcUrl, "RPC_URL"), explorerUrl: https(data.explorerUrl, "EXPLORER_URL"),
    asset: { address: MONAD_USDC, symbol: "USDC", decimals: 6 },
    registries: { identity: address(data.registries?.identity, "IDENTITY"), reputation: address(data.registries?.reputation, "REPUTATION") },
    roles, keyFiles, upstream: { name: "kimi", baseUrl: apiBase, model: data.upstream.model, apiKeyFile: absoluteFile(data.upstream.apiKeyFile, "KIMI_KEY_FILE"), requestOptions },
    contracts, blockedProvider, frontendOrigin };
}
export const loadMonadConfig = async (path: string) => parseMonadConfig(JSON.parse(await readFile(path, "utf8")));
export function monadRuntimeConfig(original: MonadConfig, rpcUrl?: string, privateOverride = false) {
  // The journal remains bound to the original parsed configuration. Only an
  // explicit CLI override changes the endpoint used by this invocation.
  const configHash = keccak256(toUtf8Bytes(json(original)));
  const config = rpcUrl === undefined ? original : { ...original, rpcUrl: https(rpcUrl, "RPC_URL") };
  return { config, configHash, publicRpcUrl: privateOverride ? original.rpcUrl : config.rpcUrl };
}
export async function secretMetadata(path: string) {
  try { const file = await stat(path); return { exists: true, privatePermissions: file.isFile() && (file.mode & 0o077) === 0 }; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false, privatePermissions: false }; throw new Error("SECRET_FILE_METADATA_UNAVAILABLE"); }
}
export async function readSecret(path: string) {
  const metadata = await secretMetadata(path);
  if (!metadata.exists || !metadata.privatePermissions) throw new Error("PRIVATE_SECRET_FILE_REQUIRED");
  const value = (await readFile(path, "utf8")).trim();
  if (!value) throw new Error("EMPTY_SECRET_FILE"); return value;
}

// USDC amounts are exact for this eight-task/seven-inference run. Native budgets
// are conservative gas-unit reservations, multiplied by the live fee cap.
export const FUNDING: Record<Role, { usdc: bigint; gasUnits: bigint; purpose: string }> = {
  deployer: { usdc: 0n, gasUnits: 20_000_000n, purpose: "4 deployments, wiring, limits, whitelist" },
  underwriter: { usdc: 0n, gasUnits: 0n, purpose: "off-chain credit signatures only" },
  verifier: { usdc: 0n, gasUnits: 14_000_000n, purpose: "7 settlements at explicit 2M gas limit" },
  guardian: { usdc: 0n, gasUnits: 1_000_000n, purpose: "3 enrollments and identity freeze" },
  treasury: { usdc: 10_000_000n, gasUnits: 300_000n, purpose: "approve and deposit $10 pool liquidity" },
  poster: { usdc: 1_200_000n, gasUnits: 2_000_000n, purpose: "approve and create 8 rewards of $0.15" },
  hero: { usdc: 50_000n, gasUnits: 3_000_000n, purpose: "register/bind/init, 3 accept/pay, nonwhitelist revert" },
  veteran: { usdc: 50_000n, gasUnits: 3_000_000n, purpose: "register/bind/init, 4 accept, 3 pay, identity transfer" },
  defaulted: { usdc: 50_000n, gasUnits: 2_000_000n, purpose: "register/bind/init, accept/pay/default" },
  rotatedOwner: { usdc: 0n, gasUnits: 300_000n, purpose: "canonical owner submits new wallet consent" },
  rotatedWallet: { usdc: 0n, gasUnits: 1_000_000n, purpose: "signed IdentityChanged failed transaction" },
  provider: { usdc: 0n, gasUnits: 0n, purpose: "receive 7 payments, no on-chain sends" },
  refunder: { usdc: 0n, gasUnits: 0n, purpose: "configured protocol role; refunds disabled in this demo" },
};
export interface RoleFunding { role: Role; address: string; native: bigint; usdc: bigint; usdcRequired: bigint; nativeRequired: bigint }
export function combineFunding(roles: RoleFunding[]) {
  return [...new Set(roles.map(role => role.address))].map(address => {
    const assigned = roles.filter(role => role.address === address);
    const usdcRequired = assigned.reduce((total, role) => total + role.usdcRequired, 0n);
    const nativeRequired = assigned.reduce((total, role) => total + role.nativeRequired, 0n);
    return { address, roles: assigned.map(role => role.role), native: assigned[0].native, usdc: assigned[0].usdc,
      usdcRequired, nativeRequired, fundedForFreshRun: assigned[0].native >= nativeRequired && assigned[0].usdc >= usdcRequired };
  });
}
export async function freshDeploymentReady(contracts: Record<keyof ContractAddresses, Contract>, token: Contract, addresses: ContractAddresses) {
  const { manager, escrow } = contracts;
  const values = await Promise.all([
    read(manager, "totalOutstanding"), read(manager, "vaultBalance"), read(manager, "backstopTotal"), read(escrow, "totalEscrowed"),
    ...[addresses.manager, addresses.account, addresses.escrow].map(address => read(token, "balanceOf", [address])),
  ]);
  return values.every(value => value === 0n) && await read(escrow, "nextTaskId") === 1n;
}
export function enforceFreshDeployment(ready: boolean, resume: boolean) {
  if (!resume && !ready) throw new Error("DEDICATED_EMPTY_DEPLOYMENT_REQUIRED");
}
export async function deployedContracts(config: MonadConfig, provider: JsonRpcProvider, addresses: ContractAddresses) {
  const entries = await Promise.all(Object.entries({ manager: "CreditManager", adapter: "ERC8004Adapter", account: "AgentAccount", escrow: "TaskEscrow" }).map(async ([name, artifactName]) => {
    const contractAddress = addresses[name as keyof ContractAddresses];
    if (await provider.getCode(contractAddress) === "0x") throw new Error("BUSINESS_CONTRACT_HAS_NO_CODE");
    return [name, new Contract(contractAddress, (await artifact(artifactName)).abi, provider)] as const;
  }));
  const contracts = Object.fromEntries(entries) as Record<keyof ContractAddresses, Contract>;
  const { manager, adapter, account, escrow } = contracts;
  const equal = async (contract: Contract, method: string, expected: string) => {
    if (getAddress(await read(contract, method)) !== getAddress(expected)) throw new Error(`DEPLOYMENT_${method.toUpperCase()}_MISMATCH`);
  };
  for (const contract of Object.values(contracts)) await equal(contract, "owner", config.roles.deployer);
  for (const contract of [manager, account, escrow]) { await equal(contract, "settlementAsset", config.asset.address); await equal(contract, "adapter", addresses.adapter); }
  await equal(adapter, "identity", config.registries.identity); await equal(adapter, "reputation", config.registries.reputation);
  await equal(manager, "underwriter", config.roles.underwriter); await equal(manager, "guardian", config.roles.guardian);
  await equal(manager, "treasury", config.roles.treasury); await equal(manager, "relayRefunder", config.roles.refunder);
  await equal(manager, "agentAccount", addresses.account); await equal(manager, "taskEscrow", addresses.escrow);
  await equal(adapter, "creditManager", addresses.manager);
  await equal(account, "creditManager", addresses.manager); await equal(account, "taskEscrow", addresses.escrow);
  await equal(escrow, "creditManager", addresses.manager); await equal(escrow, "agentAccount", addresses.account);
  await equal(escrow, "verifier", config.roles.verifier); await equal(escrow, "feeRecipient", config.roles.treasury);
  if (await read(escrow, "protocolFeeBps") !== 0n || await read(manager, "MAX_LTV_BPS") !== 8000n || !await read(adapter, "isReporter", [addresses.escrow])) throw new Error("DEMO_PROTOCOL_CONFIGURATION_MISMATCH");
  if (await read(manager, "drawPaused")) throw new Error("DEPLOYMENT_DRAW_PAUSED");
  return contracts;
}
export async function monadPreflight(config: MonadConfig, provider: JsonRpcProvider) {
  if (BigInt(await provider.send("eth_chainId", [])) !== MONAD_CHAIN_ID) throw new Error("NETWORK_MISMATCH");
  for (const contractAddress of [config.asset.address, config.registries.identity, config.registries.reputation]) if (await provider.getCode(contractAddress) === "0x") throw new Error("PREFLIGHT_CONTRACT_HAS_NO_CODE");
  const token = new Contract(config.asset.address, ["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"], provider);
  if (await read(token, "decimals") !== 6n) throw new Error("USDC_DECIMALS_MISMATCH");
  const identity = new Contract(config.registries.identity, IDENTITY_ABI, provider);
  const domain = await read(identity, "eip712Domain");
  if (domain.fields !== "0x0f" || domain.name !== "ERC8004IdentityRegistry" || domain.version !== "1" || domain.chainId !== MONAD_CHAIN_ID || getAddress(domain.verifyingContract) !== config.registries.identity || domain.salt !== ZeroHash || domain.extensions.length) throw new Error("CANONICAL_IDENTITY_DOMAIN_MISMATCH");
  const reputation = new Contract(config.registries.reputation, REPUTATION_ABI, provider);
  if (getAddress(await read(reputation, "getIdentityRegistry")) !== config.registries.identity) throw new Error("REGISTRY_PAIR_MISMATCH");
  let pendingConfiguration: Record<string, boolean> | undefined, freshReady = true;
  if (config.contracts) {
    const deployed = await deployedContracts(config, provider, config.contracts);
    freshReady = await freshDeploymentReady(deployed, token, config.contracts);
    pendingConfiguration = { providerWhitelistToEnable: !await read(deployed.account, "providerWhitelist", [config.roles.provider]),
      globalLimitsToSet: await read(deployed.manager, "maxTotalOutstanding") !== 50000000n || await read(deployed.manager, "maxDrawPerEpoch") !== 20000000n };
    if (await read(deployed.account, "providerWhitelist", [config.blockedProvider])) throw new Error("BLOCKED_PROVIDER_ALREADY_ALLOWED");
  }
  const fee = await provider.getFeeData(); const feeCap = fee.maxFeePerGas ?? fee.gasPrice;
  if (!feeCap || feeCap <= 0n) throw new Error("FEE_DATA_UNAVAILABLE");
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("PREFLIGHT_SNAPSHOT_UNAVAILABLE");
  const balances = new Map<string, { native: bigint; usdc: bigint }>();
  // Shared management addresses are read once, sequentially, at one block.
  // A failed field aborts this report instead of fabricating a zero balance.
  for (const address of new Set(Object.values(config.roles))) {
    const native = await provider.getBalance(address, block.number);
    const usdc = await token.getFunction("balanceOf").staticCall(address, { blockTag: block.number }) as bigint;
    balances.set(address, { native, usdc });
  }
  const roles = ALL_ROLES.map(role => {
    const { native, usdc } = balances.get(config.roles[role])!;
    const budget = FUNDING[role]; const nativeRequired = budget.gasUnits * feeCap;
    return { role, address: config.roles[role], native, usdc, usdcRequired: budget.usdc, gasUnits: budget.gasUnits, nativeRequired,
      fundedForFreshRun: native >= nativeRequired && usdc >= budget.usdc, purpose: budget.purpose };
  });
  const fundingByAddress = combineFunding(roles);
  // Metadata only. No private key bytes, API call or signing happens here.
  const keyFiles = await Promise.all(SIGNING_ROLES.map(async role => ({ role, ...await secretMetadata(config.keyFiles[role]) })));
  const apiKey = await secretMetadata(config.upstream.apiKeyFile);
  return { mode: "monad", readOnly: true, chainId: "10143", rpcOrigin: new URL(config.rpcUrl).origin, block: block.number, blockHash: block.hash, blockTimestamp: block.timestamp, balancesAtOneBlock: true, canonicalDomainVerified: true, registryPairVerified: true,
    deployment: config.contracts ? "existing validated" : "4 business contracts still to deploy", freshDeploymentReady: freshReady, pendingConfiguration, feeCap, roles, fundingByAddress, keyFiles, apiKey,
    canStartFresh: freshReady && fundingByAddress.every(wallet => wallet.fundedForFreshRun) && keyFiles.every(key => key.exists && key.privatePermissions) && apiKey.exists && apiKey.privatePermissions,
    paidModelEndpointNotCalled: true, apiKeyValidityNotTested: true, keyAddressesNotChecked: true };
}
