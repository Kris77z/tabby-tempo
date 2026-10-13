import { INFERENCE_REWARD_POLICY, type RedemptionInput, type RewardBalance, type RewardIdentity, type RewardRedemption } from "./index.js";

export type CreditCommand = ({ action: "redeem" } & RedemptionInput) | { action: "query"; redemptionId: string };
export interface CreditSnapshot {
  enabled: boolean; identity?: RewardIdentity; policy?: typeof INFERENCE_REWARD_POLICY; balance?: RewardBalance;
  redemption?: RewardRedemption | null; error?: string;
}
export class CreditHttpError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export function parseCreditCommand(value: unknown): CreditCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new CreditHttpError("REWARD_COMMAND_INVALID");
  const item = value as Record<string, unknown>;
  if (item.action === "query" && Object.keys(item).every(k => ["action", "redemptionId"].includes(k))
    && typeof item.redemptionId === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.redemptionId))
    return { action: "query", redemptionId: item.redemptionId };
  if (item.action !== "redeem" || Object.keys(item).some(k => !["action", "redemptionId", "prompt", "maxCompletionTokens"].includes(k))
    || typeof item.redemptionId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(item.redemptionId)
    || typeof item.prompt !== "string" || !item.prompt.trim() || Buffer.byteLength(item.prompt) > INFERENCE_REWARD_POLICY.maxPromptBytes)
    throw new CreditHttpError("REWARD_COMMAND_INVALID");
  const maxCompletionTokens = item.maxCompletionTokens ?? 128;
  if (!Number.isSafeInteger(maxCompletionTokens) || typeof maxCompletionTokens !== "number" || maxCompletionTokens < 1
    || maxCompletionTokens > INFERENCE_REWARD_POLICY.maxCompletionTokens) throw new CreditHttpError("REWARD_COMMAND_INVALID");
  return { action: "redeem", redemptionId: item.redemptionId, prompt: item.prompt, maxCompletionTokens };
}
