import { getAddress, Wallet, ZeroAddress } from "ethers";
import { resolve } from "node:path";
import { uint } from "@agentfuel/sdk/protocol";

export interface Upstream { name: string; baseUrl: string; model: string; key: string }
export interface TierRoute { price: bigint; upstreams: Upstream[] }
export interface RelayService {
  id: string; model: string; price: bigint; upstreams: Upstream[];
  tiers?: { cheap: TierRoute; strong: TierRoute };
}
export interface RelayConfig {
  rpcUrl: string; chainId: bigint; account: string; asset: string; assetDecimals: number; payTo: string;
  service: RelayService;
  dataDir: string; quoteTtl: number; confirmations: number; upstreamTimeout: number; logScanChunkBlocks?: number;
  host: string; port: number; frontendOrigin?: string; operatorToken?: string; refunderKey?: string;
}
export function upstreamUrl(value: string) {
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
    throw new Error("Upstream URL must be HTTP(S) without credentials, query or fragment");
  }
  return url.href.replace(/\/$/, "");
}
export function validateService(service: RelayService) {
  const route = (value: TierRoute) => {
    if (!value || typeof value.price !== "bigint" || uint(value.price.toString(), "price") === 0n ||
      !Array.isArray(value.upstreams) || !value.upstreams.length || value.upstreams.length > 4) throw new Error("Configure positive price and 1..4 ordered upstreams");
    const names = new Set<string>();
    for (const upstream of value.upstreams) {
      if (!upstream || typeof upstream.name !== "string" || !upstream.name.trim() || names.has(upstream.name) ||
        typeof upstream.model !== "string" || !upstream.model.trim() || typeof upstream.key !== "string" || !upstream.key.trim()) throw new Error("Invalid or duplicate upstream definition");
      upstreamUrl(upstream.baseUrl); names.add(upstream.name);
    }
  };
  if (!service.id || !service.model) throw new Error("Configure service id/model");
  if (service.tiers) {
    if (Object.keys(service.tiers).sort().join(",") !== "cheap,strong") throw new Error("Configure both cheap and strong tiers only");
    route(service.tiers.cheap); route(service.tiers.strong);
    if (service.tiers.cheap.price >= service.tiers.strong.price) throw new Error("cheap price must be less than strong price");
  } else route(service);
}
export function loadConfig(env: NodeJS.ProcessEnv): RelayConfig {
  const need = (name: string) => { const value = env[name]?.trim(); if (!value) throw new Error(`${name} is required`); return value; };
  const httpUrl = (value: string) => { if (!["http:", "https:"].includes(new URL(value).protocol)) throw new Error("Use HTTP(S) URL"); return value; };
  const positive = (name: string, fallback: string, max: number) => { const value = uint(env[name] || fallback, name); if (value === 0n || value > BigInt(max)) throw new Error(`${name} out of range`); return Number(value); };
  const account = getAddress(need("ACCOUNT_ADDRESS"));
  const payTo = getAddress(need("PROVIDER_ADDRESS"));
  if (account === ZeroAddress || payTo === ZeroAddress) throw new Error("Account/provider must be nonzero");
  const asset = getAddress(need("SETTLEMENT_ASSET"));
  const decimals = need("ASSET_DECIMALS");
  if (!["6", "18"].includes(decimals) || (asset === ZeroAddress && decimals !== "18")) throw new Error("Demo decimals must match USDC-6/native-18");
  const chainId = uint(need("CHAIN_ID"), "CHAIN_ID");
  if (!chainId) throw new Error("Chain must be positive");
  const upstreamsFrom = (definitions: unknown): Upstream[] => {
    if (!Array.isArray(definitions) || !definitions.length || definitions.length > 4) throw new Error("Configure 1..4 ordered upstreams");
    return definitions.map(upstream => {
      if (!upstream || typeof upstream.name !== "string" || typeof upstream.model !== "string" ||
        typeof upstream.keyEnv !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(upstream.keyEnv)) throw new Error("Invalid upstream definition");
      return { name: upstream.name, model: upstream.model, baseUrl: upstreamUrl(upstream.baseUrl), key: need(upstream.keyEnv) };
    });
  };
  let tiers: RelayService["tiers"];
  let price: bigint, upstreams: Upstream[];
  if (env.TIERS_JSON?.trim()) {
    if (env.PRICE?.trim() || env.UPSTREAMS_JSON?.trim()) throw new Error("Use TIERS_JSON or legacy PRICE/UPSTREAMS_JSON, not both");
    const definitions = JSON.parse(env.TIERS_JSON) as Record<string, { price: string; upstreams: unknown }>;
    if (!definitions || Array.isArray(definitions) || Object.keys(definitions).sort().join(",") !== "cheap,strong") throw new Error("Configure both cheap and strong tiers only");
    const tier = (name: "cheap" | "strong") => ({ price: uint(definitions[name]?.price, `${name}.price`), upstreams: upstreamsFrom(definitions[name]?.upstreams) });
    tiers = { cheap: tier("cheap"), strong: tier("strong") };
    // Retain the legacy service shape for existing integrations; tiered requests still require an explicit tier.
    ({ price, upstreams } = tiers.cheap);
  } else {
    price = uint(need("PRICE"), "PRICE"); upstreams = upstreamsFrom(JSON.parse(need("UPSTREAMS_JSON")));
  }
  const service: RelayService = { id: env.SERVICE_ID || "infercredit/coder", model: env.LOGICAL_MODEL || "coder", price, upstreams, ...(tiers ? { tiers } : {}) };
  validateService(service);
  const operatorToken = env.OPERATOR_TOKEN?.trim() || undefined;
  if (operatorToken && operatorToken.length < 32) throw new Error("OPERATOR_TOKEN needs at least 32 characters");
  const refunderKey = env.REFUNDER_PRIVATE_KEY?.trim() || undefined;
  if (refunderKey) { try { new Wallet(refunderKey); } catch { throw new Error("REFUNDER_PRIVATE_KEY is invalid"); } }
  const frontendOrigin = env.FRONTEND_ORIGIN?.trim() || undefined;
  if (frontendOrigin && new URL(frontendOrigin).origin !== frontendOrigin) throw new Error("FRONTEND_ORIGIN must be an exact origin");
  return { rpcUrl: httpUrl(need("RPC_URL")), chainId, account, asset, assetDecimals: Number(decimals), payTo,
    service,
    dataDir: resolve(env.DATA_DIR || "relay-data"), quoteTtl: positive("QUOTE_TTL", "300", 86400),
    confirmations: positive("CONFIRMATIONS", "1", 100), upstreamTimeout: positive("UPSTREAM_TIMEOUT_MS", "60000", 180000),
    logScanChunkBlocks: positive("LOG_SCAN_CHUNK_BLOCKS", "1000", 1000),
    host: env.HOST || "127.0.0.1", port: positive("PORT", "8788", 65535), frontendOrigin, operatorToken, refunderKey };
}
