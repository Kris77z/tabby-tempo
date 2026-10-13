/** Public contract for the free, server-refereed arena. Chips are virtual, never USDC. */
export type PlayGame = "holdem" | "gomoku" | "chess" | "balatro";
export type PlaySeat = 0 | 1;
export type PlayMode = "challenge" | "invite";
export type PlayAction =
  | { type: "fold" | "check" | "call" | "all-in" }
  | { type: "raise"; to: number }
  | { type: "place"; row: number; col: number }
  | { type: "move"; from: string; to: string; promotion?: "q" | "r" | "b" | "n" }
  | { type: "play" | "discard"; cards: string[] }
  | { type: "choose_joker"; jokerId: string; replaceJokerId?: string; upgradeHand?: string }
  | { type: "skip_reward"; upgradeHand?: string };
export interface PlayOutcome { kind: "win" | "draw"; winner?: PlaySeat; reason: string }
export interface PlayPlayer { seat: PlaySeat; name: string; kind: "human" | "bot"; ready: boolean }
export interface PlayLog { sequence: number; time: string; seat?: PlaySeat; kind: "created" | "joined" | "ready" | "action" | "hand" | "finished"; message: string; action?: PlayAction }
export interface PlayMatchSummary {
  id: string;
  game: PlayGame;
  mode: PlayMode;
  status: "waiting" | "playing" | "finished" | "cancelled";
  version: number;
  createdAt: string;
  updatedAt: string;
  players: PlayPlayer[];
  actor: PlaySeat | null;
  deadline: string | null;
  config: { chips: number; hands: number; actionTimeoutMs: number };
  outcome: PlayOutcome | null;
  /** Invite codes are shared intentionally; they never authorize an occupied seat. */
  inviteCode?: string;
}
export interface PlayMatchView extends PlayMatchSummary {
  yourSeat: PlaySeat | null;
  /** Game-specific public/player view. Private hand/deck never appears for a spectator. */
  gameView: Record<string, unknown> | null;
  logs: PlayLog[];
}
export interface PlaySession { match: PlayMatchView; seatToken?: string }
export interface PlayList { matches: PlayMatchSummary[]; history: PlayMatchSummary[]; bot: { name: string; description: string }; storage: string }
export type PlayCommand =
  | { op: "create"; game: PlayGame; mode: PlayMode; name?: string; chips?: 500 | 1000 | 5000; hands?: number; requestId: string }
  | { op: "join"; matchId?: string; inviteCode?: string; name?: string; requestId: string }
  | { op: "ready" | "auto" | "resign" | "cancel"; matchId: string; version: number; requestId: string }
  | { op: "action"; matchId: string; version: number; requestId: string; action: PlayAction };
export interface PlayApiError { error: string; message: string; version?: number }
