import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { getAddress, ZeroAddress } from "ethers";
import type { Dashboard, Deployment, PublicConfig } from "./types";

const uint = (value: unknown, field: string) => {
  if (typeof value !== "string" || !/^(0|[1-9]\d*)$/.test(value) || BigInt(value) > 2n ** 256n - 1n) throw new Error(`${field} 必须是 uint256 十进制字符串。`);
  return value;
};
const url = (value: unknown, field: string, optional = false) => {
  if (optional && !value) return "";
  if (typeof value !== "string") throw new Error(`${field} 未配置。`);
  const parsed = new URL(value);
  if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.hash || (field !== "rpcUrl" && parsed.search)) throw new Error(`${field} 必须是不含凭据的 HTTP(S) URL。`);
  return value.replace(/\/$/, "");
};
const address = (value: unknown, field: string, allowZero = false) => {
  if (typeof value !== "string") throw new Error(`${field} 未配置。`);
  let valid: string;
  try { valid = getAddress(value); } catch { throw new Error(`${field} 尚未填写有效部署地址。`); }
  if (!allowZero && valid === ZeroAddress) throw new Error(`${field} 不得使用零地址。`);
  return valid;
};

export function validateDeployment(value: unknown): Deployment {
  if (!value || typeof value !== "object") throw new Error("部署清单必须是 JSON 对象。");
  const v = value as Deployment;
  const chainId = uint(v.chainId, "chainId");
  if (BigInt(chainId) === 0n || !v.network || typeof v.network !== "string") throw new Error("chainId / network 未配置。");
  if (!Number.isSafeInteger(v.deploymentBlock) || v.deploymentBlock < 0) throw new Error("deploymentBlock 必须是部署区块整数。");
  if (!v.asset || !Number.isInteger(v.asset.decimals) || v.asset.decimals < 0 || v.asset.decimals > 36 || !v.asset.symbol) throw new Error("asset symbol / decimals 未配置。");
  const assetAddress = address(v.asset.address, "asset.address", true);
  if (assetAddress === ZeroAddress && v.asset.decimals !== 18) throw new Error("原生资产必须使用 18 位小数。");
  if (!v.contracts) throw new Error("四合约地址未配置。");
  const contracts = { manager: address(v.contracts.manager, "contracts.manager"), adapter: address(v.contracts.adapter, "contracts.adapter"),
    account: address(v.contracts.account, "contracts.account"), escrow: address(v.contracts.escrow, "contracts.escrow") };
  if (!Array.isArray(v.agents) || v.agents.length < 3 || v.agents.length > 12) throw new Error("部署清单需包含 3–12 个 Agent。");
  const agents = v.agents.map(a => {
    const id = uint(a.id, "agents.id");
    if (!a.name || typeof a.name !== "string") throw new Error("Agent 名称未配置。");
    return { id, name: a.name };
  });
  if (new Set(agents.map(a => a.id)).size !== agents.length) throw new Error("Agent IDs 不得重复。");
  if (!Array.isArray(v.providers) || v.providers.length > 8) throw new Error("providers 必须是最多 8 个 Provider 的数组。");
  const providers = v.providers.map(p => {
    if (!p.name || typeof p.name !== "string") throw new Error("Provider 名称未配置。");
    const relayUrl = url(p.relayUrl, "providers.relayUrl", true) || undefined;
    if (relayUrl && (!p.service || typeof p.service !== "string" || !p.model || typeof p.model !== "string")) throw new Error("配置 Relay 需显式填写 providers.service 与 providers.model 协议字段。");
    return { name: p.name, address: address(p.address, "providers.address"), relayUrl, service: p.service, model: p.model };
  });
  return { chainId, network: v.network, deploymentBlock: v.deploymentBlock, rpcUrl: url(v.rpcUrl, "rpcUrl"),
    underwriterUrl: url(v.underwriterUrl, "underwriterUrl"), explorerUrl: url(v.explorerUrl, "explorerUrl", true),
    asset: { address: assetAddress, symbol: v.asset.symbol, decimals: v.asset.decimals }, contracts, agents, providers,
    arenaUrl: url(v.arenaUrl, "arenaUrl", true) || undefined };
}
export async function loadDeployment(): Promise<Deployment | null> {
  const path = process.env.FRONTEND_MANIFEST_PATH;
  if (!path) return null;
  return validateDeployment(JSON.parse(await readFile(resolve(path), "utf8")));
}
export function publicConfig(config: Deployment): PublicConfig {
  const { chainId, network, explorerUrl, asset, contracts, agents, providers, arenaUrl, underwriterUrl } = config;
  // These service URLs are browser endpoints; credentials are not accepted by validateDeployment.
  return { chainId, network, explorerUrl, asset, contracts, agents, providers, arenaUrl, underwriterUrl };
}
export function unavailableDashboard(config: Deployment): Dashboard {
  return { mode: "chain", configured: true, readStatus: "unavailable", config: publicConfig(config), profiles: [], openTasks: [],
    updatedAt: new Date().toISOString(), message: "部署清单已配置，实时链上读取暂不可用。现金、债务、评分与任务记录等待完整核验。" };
}
