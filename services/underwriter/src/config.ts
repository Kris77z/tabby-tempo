import { getAddress, parseUnits, Wallet, ZeroAddress } from "ethers";
import { resolve } from "node:path";

export interface Config {
  rpcUrl: string;
  chainId: bigint;
  managerAddress: string;
  settlementAsset: string;
  assetDecimals: number;
  tokenUsdPrice: bigint; // USD per token, scaled by 10^18; demo input, not an oracle.
  privateKey: string;
  evidenceDir: string;
  host: string;
  port: number;
}

export const UINT256_MAX = (1n << 256n) - 1n;

export function uint256(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value)) {
    throw new Error(`${field} must be a decimal uint256 string`);
  }
  const parsed = BigInt(value);
  if (parsed > UINT256_MAX) throw new Error(`${field} exceeds uint256`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const required = (name: string): string => {
    const value = env[name]?.trim();
    if (!value) throw new Error(`${name} is required`);
    return value;
  };
  const rpcUrl = required("RPC_URL");
  if (!["http:", "https:"].includes(new URL(rpcUrl).protocol)) throw new Error("RPC_URL must use HTTP(S)");
  const chainId = uint256(required("CHAIN_ID"), "CHAIN_ID");
  if (chainId === 0n) throw new Error("CHAIN_ID must be positive");
  const managerAddress = getAddress(required("MANAGER_ADDRESS"));
  if (managerAddress === ZeroAddress) throw new Error("MANAGER_ADDRESS must be nonzero");
  const settlementAsset = getAddress(required("SETTLEMENT_ASSET"));
  const decimals = required("ASSET_DECIMALS");
  if (decimals !== "6" && decimals !== "18") throw new Error("Demo ASSET_DECIMALS must be 6 or 18");
  const assetDecimals = Number(decimals);
  if (settlementAsset === ZeroAddress && assetDecimals !== 18) throw new Error("Native asset requires 18 decimals");
  const price = env.TOKEN_USD_PRICE?.trim() || "1";
  if (!/^[0-9]+(\.[0-9]{1,18})?$/.test(price)) throw new Error("TOKEN_USD_PRICE must be a positive decimal");
  const tokenUsdPrice = parseUnits(price, 18);
  if (tokenUsdPrice <= 0n || tokenUsdPrice > UINT256_MAX) throw new Error("TOKEN_USD_PRICE is out of range");
  const privateKey = required("UNDERWRITER_PRIVATE_KEY");
  try { new Wallet(privateKey); } catch { throw new Error("UNDERWRITER_PRIVATE_KEY is invalid"); }
  const portText = env.PORT?.trim() || "8787";
  if (!/^[0-9]{1,5}$/.test(portText)) throw new Error("PORT is invalid");
  const port = Number(portText);
  if (port < 1 || port > 65535) throw new Error("PORT is out of range");
  return {
    rpcUrl, chainId, managerAddress, settlementAsset, assetDecimals, tokenUsdPrice, privateKey,
    evidenceDir: resolve(env.EVIDENCE_DIR || "evidence"), host: env.HOST || "127.0.0.1", port,
  };
}
