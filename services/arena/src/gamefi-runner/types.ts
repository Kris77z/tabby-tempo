import type { PublicLiveHand } from "../holdem/live.js";

export type GameFiRewardKind = "usdc" | "llm-credits";
export type GameFiStage = "game" | "award" | "purchase" | "credits";
export interface GameFiCreditGrant {
  grantId: string; matchId: string; replayDigest: string; model: string;
  allocations: [number, number]; winners: (0 | 1)[]; createdAt: string;
}
/** This is the entire browser contract. Local paths, signed bytes and model text stay private. */
export interface GameFiRun {
  requestId: string; rewardKind: GameFiRewardKind; status: "Queued" | "Running" | "Paused" | "Stopped" | "Complete";
  stage: GameFiStage; createdAt: string; updatedAt: string; recoverable: boolean;
  matchId?: string; reason?: string; game?: PublicLiveHand;
  award?: { asset: "USDC"; chainId: "10143"; rewardRaw: string; allocations: [string, string];
    transactions: { seat: 0 | 1; kind: "reward" | "approve" | "deposit"; amount: string; txHash: string }[] };
  purchase?: { phase: "Complete" | "Stopped"; physicalInferenceAttempts: number;
    purchases: { seat: 0 | 1; state: "Delivered" | "Unknown" | "Stopped";
      receipt?: { txHash: string; price: string; paymentId: string } }[] };
  credits?: GameFiCreditGrant;
}
export interface GameFiSnapshot { enabled: boolean; rewardKinds: GameFiRewardKind[]; run?: GameFiRun; runs?: GameFiRun[]; error?: string }
export type GameFiCommand = { action: "start"; requestId: string; rewardKind: GameFiRewardKind } | { action: "recover"; requestId: string };
export class GameFiError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function requestId(value: unknown): string {
  if (typeof value !== "string" || !REQUEST_ID.test(value)) throw new GameFiError("GAMEFI_REQUEST_ID_REQUIRED");
  return value;
}
export function parseGameFiCommand(value: unknown): GameFiCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new GameFiError("GAMEFI_COMMAND_INVALID");
  const item = value as Record<string, unknown>, id = requestId(item.requestId);
  if (item.action === "start" && Object.keys(item).sort().join(",") === "action,requestId,rewardKind"
    && (item.rewardKind === "usdc" || item.rewardKind === "llm-credits")) return { action: "start", requestId: id, rewardKind: item.rewardKind };
  if (item.action === "recover" && Object.keys(item).sort().join(",") === "action,requestId") return { action: "recover", requestId: id };
  throw new GameFiError("GAMEFI_COMMAND_INVALID");
}
