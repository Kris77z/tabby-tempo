/** Public facts only. A run owns its ordered stream; the service assigns seq and at. */
export const HOSTED_ACTIVITY_LIMIT = 256;
export const hostedScenes = ["onboarding", "idle", "decision", "chain-lookup", "specialists", "task", "funding", "credit", "model", "execution", "review", "game", "settlement", "delivery", "interruption"] as const;
export const hostedActivityStates = ["queued", "started", "waiting", "selected", "confirmed", "completed", "blocked", "failed", "paused", "reconciling", "stopping", "cancelled", "refunded", "revising"] as const;
export type HostedScene = typeof hostedScenes[number];
export type HostedActivityState = typeof hostedActivityStates[number];
export type HostedSubjectKind = "agent" | "task" | "specialist" | "model" | "funds" | "wallet" | "credit" | "chain" | "game" | "artifact";
export type HostedRequiredAction = "configure" | "deposit" | "fund-gas" | "provide-input" | "play-game" | "resume" | "reconcile";
export interface HostedActivityEvidence {
  chainId?: string; agentId?: string; taskId?: string; paymentId?: string; txHash?: string; acceptTxHash?: string; paymentTxHash?: string;
  matchId?: string; blockNumber?: number; blockHash?: string; researchDigest?: string;
  priceRaw?: string; amountRaw?: string; budgetRaw?: string; cashRaw?: string; debtRaw?: string; creditAvailableRaw?: string; chargedRaw?: string;
  fromCashRaw?: string; fromCreditRaw?: string; feeRaw?: string; rewardRaw?: string; refundedRaw?: string;
  repaidRaw?: string; slashedRaw?: string; residualRaw?: string;
  reservedCreditsRaw?: string; usedCreditsRaw?: string; inputMicroCreditsPerToken?: string; outputMicroCreditsPerToken?: string;
  creditsGranted?: number; creditsUsed?: number; promptTokens?: number; completionTokens?: number;
  candidateIds?: string[]; available?: number; completedTasks?: number; passed?: boolean;
  outcome?: "won" | "lost" | "draw" | "no-reward";
}
export interface HostedActivityInput {
  scene: HostedScene; state: HostedActivityState; phaseId?: string;
  subject?: { id: string; name: string; kind: HostedSubjectKind };
  reason?: string; requiredAction?: HostedRequiredAction; evidence?: HostedActivityEvidence;
}
export interface HostedActivity extends HostedActivityInput { seq: number; at: string }
const code = /^[A-Z][A-Z0-9_]{0,100}$/;
const identifier = /^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,127}$/;
const amount = /^(0|[1-9][0-9]{0,77})$/;
const txHash = /^0x[0-9a-f]{64}$/i;
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
/** Reject unknown fields instead of serializing an executor's private journal. */
export function validateHostedActivity(input: unknown): HostedActivityInput {
  const invalid = () => { throw new Error("HOSTED_ACTIVITY_INVALID"); };
  if (!object(input) || Object.keys(input).some(k => !["scene", "state", "phaseId", "subject", "reason", "requiredAction", "evidence"].includes(k))
    || !hostedScenes.includes(input.scene as HostedScene) || !hostedActivityStates.includes(input.state as HostedActivityState)) return invalid();
  if (input.phaseId !== undefined && (typeof input.phaseId !== "string" || !identifier.test(input.phaseId))) return invalid();
  if (input.reason !== undefined && (typeof input.reason !== "string" || !code.test(input.reason))) return invalid();
  if (input.requiredAction !== undefined && (typeof input.requiredAction!=="string" || !["configure", "deposit", "fund-gas", "provide-input", "play-game", "resume", "reconcile"].includes(input.requiredAction))) return invalid();
  if (input.subject !== undefined) {
    const s = input.subject;
    if (!object(s) || Object.keys(s).some(k => !["id", "name", "kind"].includes(k)) || typeof s.id !== "string" || !identifier.test(s.id)
      || typeof s.name !== "string" || !s.name.trim() || s.name.length > 120 || /[\x00-\x1f\x7f]/.test(s.name)
      || typeof s.kind!=="string" || !["agent", "task", "specialist", "model", "funds", "wallet", "credit", "chain", "game", "artifact"].includes(s.kind)) return invalid();
  }
  if (input.evidence !== undefined) {
    if (!object(input.evidence)) return invalid();
    for (const [key, value] of Object.entries(input.evidence)) {
      if (["paymentId", "txHash", "acceptTxHash", "paymentTxHash", "blockHash"].includes(key)) { if (typeof value !== "string" || !txHash.test(value)) return invalid(); }
      else if (key === "researchDigest") { if (typeof value !== "string" || !/^(0x)?[0-9a-f]{64}$/i.test(value)) return invalid(); }
      else if (["chainId", "agentId", "taskId", "priceRaw", "amountRaw", "budgetRaw", "cashRaw", "debtRaw", "creditAvailableRaw", "chargedRaw", "fromCashRaw", "fromCreditRaw", "feeRaw", "rewardRaw", "refundedRaw", "repaidRaw", "slashedRaw", "residualRaw", "reservedCreditsRaw", "usedCreditsRaw", "inputMicroCreditsPerToken", "outputMicroCreditsPerToken"].includes(key)) { if (typeof value !== "string" || !amount.test(value)) return invalid(); }
      else if (["blockNumber", "creditsGranted", "creditsUsed", "promptTokens", "completionTokens", "available", "completedTasks"].includes(key)) { if (!Number.isSafeInteger(value) || Number(value) < 0) return invalid(); }
      else if (key === "matchId") { if (typeof value !== "string" || !/^[a-zA-Z0-9_-]{1,100}$/.test(value)) return invalid(); }
      else if (key === "candidateIds") { if (!Array.isArray(value) || value.length > 32 || value.some(id => typeof id !== "string" || !identifier.test(id))) return invalid(); }
      else if (key === "passed") { if (typeof value !== "boolean") return invalid(); }
      else if (key === "outcome") { if (typeof value!=="string" || !["won", "lost", "draw", "no-reward"].includes(value)) return invalid(); }
      else return invalid();
    }
  }
  const result=structuredClone(input) as unknown as HostedActivityInput;
  if(result.reason&&!/^(HOSTED_|WORKFLOW_|AUTONOMY_|INFERENCE_|REWARD_|ALLOWANCE_|GATEWAY_|HOLDEM_|SERVICE_|SESSION_|REFUND_|PAYMENT_|TASK_|AUTHORIZATION_|NO_FEASIBLE_CANDIDATE$|CASH_REQUIRED$|UNDERWRITER_REQUIRED$|NETWORK_MISMATCH$|HANDLE_NOT_PERSISTED$)/.test(result.reason))result.reason="HOSTED_ACTIVITY_UNCERTAIN";
  return result;
}
