import "server-only";
import { join } from "node:path";
import { InferenceRewardLedger, INFERENCE_REWARD_POLICY, type RewardIdentity } from "@agentfuel/arena/inference-rewards";
import { createKimiRewardDispatch } from "@agentfuel/arena/inference-rewards-provider";
import { loadProbeUpstream } from "../../scripts/verify-live-tiers";
import { proxyUpstreamFetch, systemHttpsProxy } from "../../scripts/demo-rpc";
import { CreditHttpError, type CreditCommand, type CreditSnapshot } from "../../services/arena/src/inference-rewards/http";
import { getGameFiServerContext } from "./gamefi-server";

const globalQueue = globalThis as typeof globalThis & { agentfuelCreditQueues?: Map<string, Promise<unknown>> };
async function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
  const queues = globalQueue.agentfuelCreditQueues ??= new Map();
  const current = (queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(work);
  queues.set(key, current);
  try { return await current; } finally { if (queues.get(key) === current) queues.delete(key); }
}
function fixedIdentity(players: RewardIdentity[]): RewardIdentity | undefined {
  const agentId = process.env.GAMEFI_CREDIT_ACCOUNT_AGENT_ID;
  if (!agentId) return undefined;
  const account = players.find(player => player.agentId === agentId);
  if (!account) throw new CreditHttpError("REWARD_CONFIGURED_IDENTITY_UNAVAILABLE", 503);
  return { agentId: account.agentId, wallet: account.wallet };
}
/** Local operator identity is pinned by server configuration, not selected by a request. */
export async function gameFiCreditSnapshot(command?: CreditCommand): Promise<CreditSnapshot> {
  const context = await getGameFiServerContext();
  if (!context || !context.loaded.config.rewardKinds.includes("llm-credits")) {
    if (command?.action === "redeem") throw new CreditHttpError("REWARD_NOT_CONFIGURED", 503);
    return { enabled: false };
  }
  const owner = fixedIdentity(context.loaded.holdem.players);
  if (!owner) {
    if (command?.action === "redeem") throw new CreditHttpError("REWARD_IDENTITY_NOT_CONFIGURED", 503);
    return { enabled: false, error: "REWARD_IDENTITY_NOT_CONFIGURED" };
  }
  const directory = join(context.loaded.config.dataDirectory, "credits");
  return serialized(directory, async () => {
    let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
    const ledger = await InferenceRewardLedger.open(directory, { accounts: context.loaded.holdem.players, recover: true,
      // Provider credentials/transport are accessed only if a new, funded dispatch is needed. Cached
      // results, query and balance do not need an API key and cannot cause a physical request.
      dispatch: async (request, signal, metadata) => {
        const upstream = await loadProbeUpstream(context.loaded.holdem.monadConfigFile);
        transport = proxyUpstreamFetch(await systemHttpsProxy(), INFERENCE_REWARD_POLICY.upstreamTimeoutMs);
        return createKimiRewardDispatch({ ...upstream, upstreamFetch: transport.fetch })(request, signal, metadata);
      } });
    try {
      const redemption = command?.action === "redeem" ? await ledger.redeem(owner, command)
        : command?.action === "query" ? await ledger.redemption(owner, command.redemptionId) : undefined;
      return { enabled: true, identity: owner, policy: INFERENCE_REWARD_POLICY, balance: await ledger.balance(owner),
        ...(redemption === undefined ? {} : { redemption }) };
    } finally { await ledger.close(); transport?.close(); }
  });
}
