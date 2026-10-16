import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { getAddress } from "ethers";
import { taskPrivateFile } from "../../../packages/pi-loop/src/task-runner/config.js";
import { HostedError, type HostedAgent, type HostedConfig } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH_USD = "0x20c0000000000000000000000000000000000000";
export interface BoundedGameAuthorization {
  version: 1; id: string; parentRequestId: string; chainId: "42431"; origin: string; asset: string; owner: string;
  issuedAtMs: number; expiresAtMs: number; baselineOwnerGames: number; baselineTotalGames: number;
  maxAdditionalGames: number; maxGameCalls: number; maxGameCompletionTokens: number; maxCashRewardsRaw: "0";
  actor: { hostedAgentId: string; registryId: string; wallet: string };
}
export interface BoundedGameAdmission {
  parentRequestId: string; childRequestId: string; agentId: string; ordinal: number; admittedAt: string; rewardKind: "llm-credits";
}
export interface BoundedGameAuthorizationState { grant: BoundedGameAuthorization; digest: string; admissions: BoundedGameAdmission[] }
function fail(): never { throw new HostedError("HOSTED_BOUNDED_GAMES_INVALID", 503); }
function closed(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== fields.length || fields.some(key => !Object.hasOwn(value, key))) fail();
}
export function boundedGameOrigin(origin: string): boolean {
  try {
    const url = new URL(origin);
    return url.origin === origin && (origin === "https://tempo.tabbyai.xyz" || url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname));
  } catch { return false; }
}
/** This authorization is independent of the historical test sponsorship. Expiry
 * is checked on first installation and each new admission, never renewed here. */
export function validateBoundedGameAuthorization(value: unknown, config: Pick<HostedConfig, "chainId" | "origin">): BoundedGameAuthorization {
  try {
    closed(value, ["version", "id", "parentRequestId", "chainId", "origin", "asset", "owner", "issuedAtMs", "expiresAtMs", "baselineOwnerGames", "baselineTotalGames", "maxAdditionalGames", "maxGameCalls", "maxGameCompletionTokens", "maxCashRewardsRaw", "actor"]);
    if (value.version !== 1 || !UUID.test(value.id) || !UUID.test(value.parentRequestId) || config.chainId !== "42431" || value.chainId !== config.chainId || value.origin !== config.origin || !boundedGameOrigin(value.origin)
      || value.asset !== PATH_USD || getAddress(value.owner) !== value.owner || /^0x0{40}$/.test(value.owner)
      || !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs) || value.issuedAtMs < 1 || value.issuedAtMs > Date.now()
      || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 86400000
      || !Number.isSafeInteger(value.baselineOwnerGames) || value.baselineOwnerGames < 0 || !Number.isSafeInteger(value.baselineTotalGames)
      || value.baselineTotalGames < value.baselineOwnerGames || value.baselineTotalGames > 100
      || !Number.isSafeInteger(value.maxAdditionalGames) || value.maxAdditionalGames < 1 || value.maxAdditionalGames > 2
      || value.maxGameCalls !== 20 * value.maxAdditionalGames || value.maxGameCompletionTokens !== 10240 * value.maxAdditionalGames || value.maxCashRewardsRaw !== "0") fail();
    closed(value.actor, ["hostedAgentId", "registryId", "wallet"]);
    if (!UUID.test(value.actor.hostedAgentId) || typeof value.actor.registryId !== "string" || !/^[1-9][0-9]{0,77}$/.test(value.actor.registryId)
      || BigInt(value.actor.registryId) >= 2n ** 256n || getAddress(value.actor.wallet) !== value.actor.wallet || /^0x0{40}$/.test(value.actor.wallet)) fail();
    return structuredClone(value) as BoundedGameAuthorization;
  } catch { return fail(); }
}
export async function loadBoundedGameAuthorization(file: string, config: Pick<HostedConfig, "chainId" | "origin">) {
  try {
    if (!isAbsolute(file) || resolve(file) !== file) fail();
    const raw = await taskPrivateFile(file), grant = validateBoundedGameAuthorization(JSON.parse(raw), config);
    return { grant, digest: createHash("sha256").update(raw).digest("hex") };
  } catch { return fail(); }
}
export function assertBoundedGameActor(grant: BoundedGameAuthorization, agent: HostedAgent) {
  if (agent.id !== grant.actor.hostedAgentId || agent.owner !== grant.owner || agent.wallet !== grant.actor.wallet
    || agent.binding?.chainId !== grant.chainId || agent.binding.agentId !== grant.actor.registryId || agent.binding.wallet !== grant.actor.wallet
    || agent.modelId !== "kimi-k2.6" || agent.strategy !== "balanced" || agent.allowCredit !== false || agent.configurationRequired) fail();
}
export function assertBoundedGameAdmissions(state: BoundedGameAuthorizationState) {
  if (!Array.isArray(state.admissions) || state.admissions.length > state.grant.maxAdditionalGames || !/^[0-9a-f]{64}$/.test(state.digest)) fail();
  const children = new Set<string>();
  for (const [index, row] of state.admissions.entries()) {
    closed(row, ["parentRequestId", "childRequestId", "agentId", "ordinal", "admittedAt", "rewardKind"]);
    const admittedAt = Date.parse(row.admittedAt);
    if (!UUID.test(row.parentRequestId) || row.parentRequestId !== state.grant.parentRequestId || !UUID.test(row.childRequestId) || row.parentRequestId === row.childRequestId || children.has(row.childRequestId)
      || row.agentId !== state.grant.actor.hostedAgentId || row.ordinal !== index + 1 || row.rewardKind !== "llm-credits"
      || !Number.isSafeInteger(admittedAt) || new Date(admittedAt).toISOString() !== row.admittedAt || admittedAt < state.grant.issuedAtMs || admittedAt >= state.grant.expiresAtMs) fail();
    children.add(row.childRequestId);
  }
}
