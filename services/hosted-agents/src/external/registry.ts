import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Contract, getAddress, ZeroAddress, type JsonRpcProvider } from "ethers";
import { IDENTITY_ABI, REPUTATION_ABI } from "@agentfuel/erc8004";
import { validateExternalService, type ExternalServiceView } from "../goal-types.js";
import { resolveSpecialist } from "../specialists/catalog.js";

export interface ExternalServiceTrust {
  id: string; name: string; taskType: string; endpoint: string; serviceId: string;
  modelId: string; physicalModel: string; responseModel?: string; priceRaw: string; provider: string;
  identity?: { chainId: string; registry: string; agentId: string; wallet: string };
  reputation?: { registry: string; clients: string[]; tag1: string; tag2: string; maxValue: number };
}
export interface ExternalHiringConfig {
  version: 1; registryUrl: string; services: ExternalServiceTrust[]; minReputation?: number; timeoutMs?: number;
}
export interface ExternalServiceSnapshot {
  trust: ExternalServiceTrust; service: ExternalServiceView; registryDigest: string;
}
export interface ExternalRegistryDependencies { fetch?: typeof fetch; provider?: JsonRpcProvider }

function fail(code = "HOSTED_EXTERNAL_CONFIG_INVALID"): never { throw new Error(code); }
const text = (v: unknown, max = 120): v is string => typeof v === "string" && !!v.trim() && v.length <= max;
const uint = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,29}$/.test(v);
const address = (v: unknown) => { try { return typeof v === "string" && getAddress(v) !== ZeroAddress; } catch { return false; } };
const allowedKeys = (value: object, keys: string[]) => Object.keys(value).every(k => keys.includes(k));
export const externalDigest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Only operator configuration supplies URLs. A task or registry advertisement
 * cannot add an endpoint, a payment target, a capability or a model. */
export function externalUrl(value: unknown): string {
  try {
    if (typeof value !== "string") fail();
    const url = new URL(value as string);
    if (url.username || url.password || url.search || url.hash ||
      !(url.protocol === "https:" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))) fail();
    return url.href;
  } catch { return fail(); }
}
export function validateExternalHiringConfig(value: ExternalHiringConfig): ExternalHiringConfig {
  if (!value || value.version !== 1 || !allowedKeys(value, ["version", "registryUrl", "services", "minReputation", "timeoutMs"]) ||
    !Array.isArray(value.services) || !value.services.length || value.services.length > 32 ||
    new Set(value.services.map(s => s?.id)).size !== value.services.length ||
    value.minReputation !== undefined && (!Number.isFinite(value.minReputation) || value.minReputation < 0 || value.minReputation > 5) ||
    value.timeoutMs !== undefined && (!Number.isSafeInteger(value.timeoutMs) || value.timeoutMs < 100 || value.timeoutMs > 30000)) fail();
  externalUrl(value.registryUrl);
  for (const s of value.services) {
    if (!s || !allowedKeys(s, ["id", "name", "taskType", "endpoint", "serviceId", "modelId", "physicalModel", "responseModel", "priceRaw", "provider", "identity", "reputation"]) ||
      [s.id, s.name, s.taskType, s.serviceId, s.modelId, s.physicalModel, s.responseModel ?? s.physicalModel].some(v => !text(v)) ||
      !resolveSpecialist(s.taskType) || resolveSpecialist(s.taskType)!.id !== s.taskType || !uint(s.priceRaw) || !address(s.provider) ||
      new URL(externalUrl(s.endpoint)).pathname !== "/v1/chat") fail();
    if (s.identity && (!allowedKeys(s.identity, ["chainId", "registry", "agentId", "wallet"]) ||
      !uint(s.identity.chainId) || !uint(s.identity.agentId) || !address(s.identity.registry) || !address(s.identity.wallet) ||
      getAddress(s.identity.wallet) !== getAddress(s.provider))) fail();
    if (s.reputation && (!s.identity || !allowedKeys(s.reputation, ["registry", "clients", "tag1", "tag2", "maxValue"]) ||
      !address(s.reputation.registry) || !Array.isArray(s.reputation.clients) || !s.reputation.clients.length || s.reputation.clients.length > 32 ||
      s.reputation.clients.some(c => !address(c)) || new Set(s.reputation.clients.map(c => getAddress(c))).size !== s.reputation.clients.length ||
      typeof s.reputation.tag1 !== "string" || s.reputation.tag1.length > 80 || typeof s.reputation.tag2 !== "string" || s.reputation.tag2.length > 80 ||
      !Number.isFinite(s.reputation.maxValue) || s.reputation.maxValue <= 0 || s.reputation.maxValue > 1000000)) fail();
    try { validateExternalService(externalServiceView(s)); } catch { fail(); }
  }
  return structuredClone(value);
}

export function externalServiceView(trust: ExternalServiceTrust, reputation: ExternalServiceView["reputation"] = { score: null, samples: 0, source: "registry" }): ExternalServiceView {
  return { id: trust.id, name: trust.name, taskType: trust.taskType, serviceId: trust.serviceId, modelId: trust.modelId,
    provider: trust.provider, priceRaw: trust.priceRaw, ...(trust.identity ? { identity: structuredClone(trust.identity) } : {}), reputation: structuredClone(reputation) };
}
function validRegistryRating(value: unknown): ExternalServiceView["reputation"] {
  const v = value as { score?: unknown; samples?: unknown } | undefined;
  if (!v || v.score === null && v.samples === 0) return { score: null, samples: 0, source: "registry" };
  if (typeof v.score !== "number" || !Number.isFinite(v.score) || v.score < 0 || v.score > 5 ||
    !Number.isSafeInteger(v.samples) || Number(v.samples) < 1 || Number(v.samples) > 1000000000) return fail("HOSTED_EXTERNAL_REGISTRY_INVALID");
  return { score: v.score, samples: Number(v.samples), source: "registry" };
}
const advertisedBinding = (s: ExternalServiceTrust) => ({ id: s.id, name: s.name, taskType: s.taskType, endpoint: s.endpoint,
  serviceId: s.serviceId, modelId: s.modelId, physicalModel: s.physicalModel, responseModel: s.responseModel ?? s.physicalModel,
  priceRaw: s.priceRaw, provider: getAddress(s.provider), ...(s.identity ? { identity: { ...s.identity, registry: getAddress(s.identity.registry), wallet: getAddress(s.identity.wallet) } } : {}) });
export function externalAdvertisement(trust: ExternalServiceTrust, reputation?: { score: number | null; samples: number }) {
  return { ...advertisedBinding(trust), ...(reputation ? { reputation } : {}) };
}
function assertAdvertisement(raw: unknown, trust: ExternalServiceTrust): ExternalServiceView["reputation"] {
  const s = raw as ExternalServiceTrust & { reputation?: { score: number | null; samples: number } };
  try { if (!s || !isDeepStrictEqual(advertisedBinding(s), advertisedBinding(trust))) fail("HOSTED_EXTERNAL_REGISTRY_BINDING_CHANGED"); }
  catch { return fail("HOSTED_EXTERNAL_REGISTRY_BINDING_CHANGED"); }
  return validRegistryRating(s.reputation);
}
async function readJson(url: string, config: ExternalHiringConfig, fetcher: typeof fetch) {
  const response = await fetcher(url, { signal: AbortSignal.timeout(config.timeoutMs ?? 5000), redirect: "error", headers: { accept: "application/json" } });
  if (!response.ok || Number(response.headers.get("content-length") ?? 0) > 131072) fail("HOSTED_EXTERNAL_REGISTRY_UNAVAILABLE");
  const reader = response.body?.getReader(); if (!reader) fail("HOSTED_EXTERNAL_REGISTRY_INVALID");
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) { const next = await reader!.read(); if (next.done) break; length += next.value.length;
      if (length > 131072) fail("HOSTED_EXTERNAL_REGISTRY_INVALID"); chunks.push(next.value); }
  } finally { await reader!.cancel().catch(() => {}); }
  try { return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>; }
  catch { return fail("HOSTED_EXTERNAL_REGISTRY_INVALID"); }
}
export async function readExternalServiceChainMetadata(trust: ExternalServiceTrust, rpc: JsonRpcProvider): Promise<ExternalServiceView["reputation"] | undefined> {
  if (!trust.identity) return;
  const identity = trust.identity;
  if (BigInt(await rpc.send("eth_chainId", [])) !== BigInt(identity.chainId)) fail("HOSTED_EXTERNAL_IDENTITY_INVALID");
  const head = await rpc.getBlock("latest"); if (!head?.hash) fail("HOSTED_EXTERNAL_IDENTITY_UNCONFIRMED");
  const registry = new Contract(identity.registry, IDENTITY_ABI, rpc);
  const [wallet, owner] = await Promise.all([
    registry.getFunction("getAgentWallet").staticCall(identity.agentId, { blockTag: head.number }),
    registry.getFunction("ownerOf").staticCall(identity.agentId, { blockTag: head.number })]);
  if (!address(owner) || getAddress(wallet) !== getAddress(identity.wallet)) fail("HOSTED_EXTERNAL_IDENTITY_INVALID");
  let reputation: ExternalServiceView["reputation"] | undefined;
  if (trust.reputation) {
    const r = trust.reputation, registry = new Contract(r.registry, REPUTATION_ABI, rpc);
    if (getAddress(await registry.getFunction("getIdentityRegistry").staticCall({ blockTag: head.number })) !== getAddress(identity.registry)) fail("HOSTED_EXTERNAL_IDENTITY_INVALID");
    const summary = await registry.getFunction("getSummary").staticCall(identity.agentId, r.clients, r.tag1, r.tag2, { blockTag: head.number });
    const decimals = Number(summary.summaryValueDecimals), count = BigInt(summary.count);
    if (!Number.isSafeInteger(decimals) || decimals < 0 || decimals > 18 || count > 1000000000n) fail("HOSTED_EXTERNAL_REPUTATION_INVALID");
    const score = Number(summary.summaryValue) / 10 ** decimals / r.maxValue * 5;
    if (!Number.isFinite(score)) fail("HOSTED_EXTERNAL_REPUTATION_INVALID");
    reputation = { score: count === 0n ? null : Math.max(0, Math.min(5, score)), samples: Number(count), source: "erc8004", blockNumber: head.number, blockHash: head.hash };
  }
  if ((await rpc.getBlock(head.number))?.hash !== head.hash) fail("HOSTED_EXTERNAL_IDENTITY_UNCONFIRMED");
  return reputation;
}

/** Discover advertised services and then verify their own identity endpoint.
 * Ranking metadata can change; the configured execution/payment binding cannot. */
export async function discoverExternalServices(rawConfig: ExternalHiringConfig, deps: ExternalRegistryDependencies = {}): Promise<ExternalServiceSnapshot[]> {
  const config = validateExternalHiringConfig(rawConfig), fetcher = deps.fetch ?? fetch;
  const registry = await readJson(config.registryUrl, config, fetcher);
  if (!Array.isArray(registry.services) || registry.services.length > 128) fail("HOSTED_EXTERNAL_REGISTRY_INVALID");
  const advertised = new Map<string, unknown>();
  for (const raw of registry.services as { id?: unknown }[]) {
    if (!raw || typeof raw.id !== "string") fail("HOSTED_EXTERNAL_REGISTRY_INVALID");
    if (advertised.has(raw.id)) fail("HOSTED_EXTERNAL_REGISTRY_INVALID"); advertised.set(raw.id, raw);
  }
  const registryDigest = externalDigest(registry);
  const candidates: (ExternalServiceSnapshot | undefined)[] = new Array(config.services.length);
  let cursor = 0;
  const inspect = async (trust: ExternalServiceTrust): Promise<ExternalServiceSnapshot | undefined> => {
    if (!advertised.has(trust.id)) return;
    const registryReputation = assertAdvertisement(advertised.get(trust.id), trust);
    let identity: Record<string, unknown>;
    try { identity = await readJson(new URL("/identity", trust.endpoint).href, config, fetcher); }
    catch (error) {
      // An offline approved candidate must not hide other reachable external
      // experts. A changed/invalid identity remains a hard rejection below.
      if (error instanceof TypeError || error instanceof Error && ["HOSTED_EXTERNAL_REGISTRY_UNAVAILABLE", "TimeoutError", "AbortError"].includes(error.name === "Error" ? error.message : error.name)) return;
      throw error;
    }
    const endpointReputation = assertAdvertisement(identity.service, trust);
    if (!isDeepStrictEqual(registryReputation, endpointReputation)) fail("HOSTED_EXTERNAL_REGISTRY_BINDING_CHANGED");
    if (trust.identity && !deps.provider) fail("HOSTED_EXTERNAL_IDENTITY_READER_REQUIRED");
    const reputation = deps.provider ? await readExternalServiceChainMetadata(trust, deps.provider) ?? registryReputation : registryReputation;
    return { trust: structuredClone(trust), service: externalServiceView(trust, reputation), registryDigest };
  };
  // Bounded parallel reads keep a multi-expert Monad directory responsive
  // without flooding the public RPC or making ranking depend on reply order.
  await Promise.all(Array.from({ length: Math.min(4, config.services.length) }, async () => {
    for (;;) { const index = cursor++; if (index >= config.services.length) return; candidates[index] = await inspect(config.services[index]); }
  }));
  return candidates.filter((candidate): candidate is ExternalServiceSnapshot => candidate !== undefined);
}

/** Same 70% reputation / 30% price preference as monad-rebel, after exact
 * capability, affordability and reputation admission. No internal fallback. */
export function rankExternalServices(candidates: ExternalServiceSnapshot[], taskType: string, budgetRaw: string, minReputation = 0): ExternalServiceSnapshot[] {
  if (!/^(0|[1-9][0-9]{0,29})$/.test(budgetRaw) || !Number.isFinite(minReputation) || minReputation < 0 || minReputation > 5) fail();
  const canonical = resolveSpecialist(taskType)?.id;
  const matching = candidates.filter(s => s.service.taskType === canonical);
  if (!matching.length) fail("HOSTED_EXTERNAL_SERVICE_UNAVAILABLE");
  const reputable = matching.filter(s => (s.service.reputation.score ?? 0) >= minReputation);
  if (!reputable.length) fail("HOSTED_EXTERNAL_REPUTATION_REQUIRED");
  const affordable = reputable.filter(s => BigInt(s.service.priceRaw) <= BigInt(budgetRaw));
  if (!affordable.length) fail("HOSTED_GOAL_BUDGET_REQUIRED");
  const prices = affordable.map(s => BigInt(s.service.priceRaw));
  const min = prices.reduce((a, b) => a < b ? a : b), max = prices.reduce((a, b) => a > b ? a : b);
  const score = (s: ExternalServiceSnapshot) => (s.service.reputation.score ?? 0) / 5 * 0.7 +
    (max === min ? 1 : Number((max - BigInt(s.service.priceRaw)) * 10000n / (max - min)) / 10000) * 0.3;
  return [...affordable].sort((a, b) => score(b) - score(a) || (BigInt(a.service.priceRaw) < BigInt(b.service.priceRaw) ? -1 : BigInt(a.service.priceRaw) > BigInt(b.service.priceRaw) ? 1 : a.service.id.localeCompare(b.service.id)));
}
