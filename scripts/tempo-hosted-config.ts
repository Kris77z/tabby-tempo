import type { HostedConfig } from "../services/hosted-agents/src/types.js";
import type { HostedDaemonConfig } from "./hosted-agents.js";

/** Preserve the runtime's original native field order when an offline migration
 * adds a seal. Use this from both writers: no Python pretty/key-sorted rewrite. */
export function tempoHostedConfig(config: HostedDaemonConfig, sealed = config.hosted.boundedGamesSealed === true): HostedDaemonConfig {
  const h = config.hosted;
  const hosted: HostedConfig = {
    ...(h.testSponsorshipFile ? { testSponsorshipFile: h.testSponsorshipFile } : {}),
    ...(h.boundedGamesFile ? { boundedGamesFile: h.boundedGamesFile, ...(sealed ? { boundedGamesSealed: true as const } : {}) } : {}),
    directory: h.directory, origin: h.origin, chainId: h.chainId, models: h.models,
    maxAgentsPerOwner: h.maxAgentsPerOwner, maxTotalBudgetRaw: h.maxTotalBudgetRaw, maxPerRunBudgetRaw: h.maxPerRunBudgetRaw,
  };
  return { version: config.version, port: config.port, hosted, executor: config.executor,
    ...(config.goals ? { goals: config.goals } : {}), ...(config.autonomy ? { autonomy: config.autonomy } : {}) };
}
