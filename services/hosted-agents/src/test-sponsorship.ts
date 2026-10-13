import { createHash } from "node:crypto";
import { isAbsolute, resolve } from "node:path";
import { getAddress } from "ethers";
import { taskPrivateFile } from "../../../packages/pi-loop/src/task-runner/config.js";
import { HostedError, type HostedAgent, type HostedConfig } from "./types.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PATH_USD = "0x20c0000000000000000000000000000000000000";
export interface TestSponsorshipGrant {
  version: 1; id: string; chainId: "42431"; origin: string; asset: string; owner: string;
  issuedAtMs: number; expiresAtMs: number; baselineGames: 3; maxAdditionalGames: 6;
  maxGameCalls: 120; maxGameCompletionTokens: 61440; maxCashRewardsRaw: "600000";
  actors: { hostedAgentId: string; registryId: string; wallet: string; rewardKind: "usdc" | "llm-credits" }[];
}
export interface TestSponsorshipAdmission { requestId: string; agentId: string; ordinal: number; admittedAt: string; rewardKind: "usdc" | "llm-credits" }
export interface TestSponsorshipState { grant: TestSponsorshipGrant; digest: string; admissions: TestSponsorshipAdmission[] }
function fail(): never { throw new HostedError("HOSTED_TEST_SPONSOR_INVALID", 503); }
function closed(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) fail();
}
export function validateTestSponsorship(value: unknown, config: Pick<HostedConfig, "chainId" | "origin">): TestSponsorshipGrant {
  try {
    closed(value, ["version", "id", "chainId", "origin", "asset", "owner", "issuedAtMs", "expiresAtMs", "baselineGames", "maxAdditionalGames", "maxGameCalls", "maxGameCompletionTokens", "maxCashRewardsRaw", "actors"]);
    const origin = new URL(config.origin);
    if (config.chainId !== "42431" || value.chainId !== config.chainId || value.origin !== config.origin || origin.protocol !== "http:"
      || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) || value.version !== 1 || !UUID.test(value.id)
      || value.asset !== PATH_USD || getAddress(value.owner) !== value.owner || !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs)
      || value.issuedAtMs > Date.now() || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 86400000
      || value.baselineGames !== 3 || value.maxAdditionalGames !== 6 || value.maxGameCalls !== 120 || value.maxGameCompletionTokens !== 61440 || value.maxCashRewardsRaw !== "600000"
      || !Array.isArray(value.actors) || value.actors.length !== 2) fail();
    for (const actor of value.actors) {
      closed(actor, ["hostedAgentId", "registryId", "wallet", "rewardKind"]);
      if (!UUID.test(actor.hostedAgentId) || typeof actor.registryId !== "string" || !/^[1-9][0-9]{0,77}$/.test(actor.registryId)
        || getAddress(actor.wallet) !== actor.wallet || !["usdc", "llm-credits"].includes(actor.rewardKind)) fail();
    }
    for (const key of ["hostedAgentId", "registryId", "wallet", "rewardKind"]) if (new Set(value.actors.map((actor: any) => actor[key])).size !== 2) fail();
    return structuredClone(value) as TestSponsorshipGrant;
  } catch { return fail(); }
}
export async function loadTestSponsorship(file: string, config: Pick<HostedConfig, "chainId" | "origin">) {
  if (!isAbsolute(file) || resolve(file) !== file) fail();
  const raw = await taskPrivateFile(file), grant = validateTestSponsorship(JSON.parse(raw), config);
  return { grant, digest: createHash("sha256").update(raw).digest("hex") };
}
export function assertTestSponsorshipActor(grant: TestSponsorshipGrant, agent: HostedAgent, rewardKind?: string) {
  const actor = grant.actors.find(actor => actor.hostedAgentId === agent.id);
  if (!actor || agent.owner !== grant.owner || agent.binding?.chainId !== grant.chainId || agent.binding.agentId !== actor.registryId || agent.wallet !== actor.wallet
    || agent.binding.wallet !== actor.wallet || agent.allowCredit || agent.totalBudgetRaw !== "300000" || agent.perRunBudgetRaw !== "120000"
    || agent.modelId !== "kimi-k2.6" || agent.strategy !== "balanced" || rewardKind !== undefined && rewardKind !== actor.rewardKind) fail();
}
