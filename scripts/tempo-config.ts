import { Contract, getAddress, ZeroHash, type JsonRpcProvider } from "ethers";

export const TEMPO_CHAIN_ID = 42431n;
export const TEMPO_RPC_URL = "https://rpc.moderato.tempo.xyz";
export const TEMPO_EXPLORER_URL = "https://explore.testnet.tempo.xyz";
export const TEMPO_PATH_USD = "0x20c0000000000000000000000000000000000000";
export const TEMPO_IDENTITY = "0x8004A818BFB912233c491871b3d84c89A494BD9e";
export const TEMPO_REPUTATION = "0x8004B663056A597Dffe9eCcC1965A193B7388713";
export const TEMPO_ASSET = { address: TEMPO_PATH_USD, symbol: "PathUSD" as const, decimals: 6 as const };

/** Reads actual deployed interfaces; addresses are not inferred from EVM compatibility. */
export async function tempoPreflight(provider: JsonRpcProvider) {
  if (BigInt(await provider.send("eth_chainId", [])) !== TEMPO_CHAIN_ID) throw new Error("TEMPO_NETWORK_MISMATCH");
  const block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("TEMPO_BLOCK_REQUIRED");
  for (const address of [TEMPO_PATH_USD, TEMPO_IDENTITY, TEMPO_REPUTATION])
    if (await provider.getCode(address, block.number) === "0x") throw new Error("TEMPO_DEPENDENCY_CODE_REQUIRED");
  const token = new Contract(TEMPO_PATH_USD, ["function symbol() view returns(string)", "function decimals() view returns(uint8)"], provider);
  const identity = new Contract(TEMPO_IDENTITY, ["function eip712Domain() view returns(bytes1 fields,string name,string version,uint256 chainId,address verifyingContract,bytes32 salt,uint256[] extensions)", "function supportsInterface(bytes4) view returns(bool)"], provider);
  const reputation = new Contract(TEMPO_REPUTATION, ["function getIdentityRegistry() view returns(address)"], provider);
  const override = { blockTag: block.number };
  const domain = await identity.eip712Domain(override);
  if (domain.fields !== "0x0f" || domain.name !== "ERC8004IdentityRegistry" || domain.version !== "1"
    || domain.chainId !== TEMPO_CHAIN_ID || getAddress(domain.verifyingContract) !== TEMPO_IDENTITY || domain.salt !== ZeroHash || domain.extensions.length)
    throw new Error("TEMPO_IDENTITY_DOMAIN_MISMATCH");
  if (!await identity.supportsInterface("0x80ac58cd", override) || getAddress(await reputation.getIdentityRegistry(override)) !== TEMPO_IDENTITY)
    throw new Error("TEMPO_REGISTRY_INTERFACE_MISMATCH");
  if (await token.symbol(override) !== "PathUSD" || await token.decimals(override) !== 6n) throw new Error("TEMPO_PATH_USD_REQUIRED");
  return { readOnly: true, chainId: "42431", network: "Tempo Moderato", blockNumber: block.number, blockHash: block.hash,
    asset: TEMPO_ASSET, feeToken: TEMPO_ASSET, registryMode: "existing ERC-8004 registries; interfaces verified",
    registries: { identity: TEMPO_IDENTITY, reputation: TEMPO_REPUTATION }, identityDomainVerified: true, registryPairVerified: true,
    nativeBalanceIsPlaceholder: true, explorerUrl: TEMPO_EXPLORER_URL };
}
