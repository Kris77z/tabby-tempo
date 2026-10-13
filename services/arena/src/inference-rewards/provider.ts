import { INFERENCE_REWARD_POLICY, type RewardDispatch } from "./index.js";

/** Operator configuration only. Redemption bodies never select a key, endpoint, model, tools, or routing. */
export function createKimiRewardDispatch(config: { baseUrl: string; key: string; upstreamFetch?: typeof fetch }): RewardDispatch {
  const url = new URL(config.baseUrl);
  if (url.protocol !== "https:" || !["api.moonshot.cn", "api.moonshot.ai"].includes(url.hostname) || url.port
    || url.username || url.password || url.search || url.hash || !["/v1", "/v1/"].includes(url.pathname)
    || typeof config.key !== "string" || !config.key.trim()) throw new Error("REWARD_OFFICIAL_KIMI_CONFIGURATION_REQUIRED");
  const endpoint = `${url.origin}/v1/chat/completions`, key = config.key;
  const physicalFetch = config.upstreamFetch ?? fetch;
  return (request, signal) => {
    if (request.model !== INFERENCE_REWARD_POLICY.model) throw new Error("REWARD_FIXED_MODEL_REQUIRED");
    // One physical request. No SDK retry, fallback provider, redirect, or repair request.
    return physicalFetch(endpoint, { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(request) });
  };
}
