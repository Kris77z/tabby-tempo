import { randomInt } from "node:crypto";
import { makeTrustedHand, type Action, type HoldemHand, type Seat } from "@agentfuel/arena/holdem-engine";
import { shuffledDeck, type Card } from "@agentfuel/arena/holdem-cards";
import { emptyBoard, play, type Board } from "@agentfuel/arena/gomoku-rules";
import { createChessGame } from "@agentfuel/arena/chess-rules";
import { BalatroGame, orderedBalatroDeck, type BalatroCard, type JokerId } from "@agentfuel/arena/balatro-rules";
import type { PlayAction, PlayGame, PlayOutcome } from "../../../../frontend/lib/play-types.js";

export interface FreeGame {
  view(seat: Seat | null): object;
  act(seat: Seat, action: PlayAction): void;
  actor(): Seat | null;
  outcome(): PlayOutcome | null;
  botAction(): PlayAction | null;
  /** Contains private decks. Only the trusted store may persist this journal. */
  exportTrustedReplay(): FreeGameReplay;
}
type GameEngine = Omit<FreeGame, "exportTrustedReplay">;
export interface FreeGameReplay {
  version: 1; game: PlayGame; chips: number; hands: number;
  random: { kind: "holdem-deck" | "balatro-deck" | "balatro-rewards"; values: string[] }[];
  actions: { seat: Seat; action: PlayAction }[];
}
const keys = (action: object, allowed: string[]) => Object.keys(action).every(key => allowed.includes(key));

class PokerMatch implements GameEngine {
  #hand: HoldemHand;
  #number = 1;
  #stacks: [number, number];
  #finished: PlayOutcome | null = null;
  #history: Record<string, unknown>[] = [];
  #bigBlind: number;
  constructor(private chips: number, private hands: number, private deckFactory: () => Card[]) {
    this.#stacks = [chips, chips];
    this.#bigBlind = 10;
    this.#hand = this.#next();
    this.#settle();
  }
  #next() {
    return makeTrustedHand({ initialStack: Math.max(this.#bigBlind, ...this.#stacks), initialStacks: [...this.#stacks],
      smallBlind: this.#bigBlind / 2, bigBlind: this.#bigBlind, button: ((this.#number - 1) % 2) as Seat }, this.deckFactory());
  }
  actor() { return this.#finished ? null : this.#hand.view(0).actor; }
  outcome() { return this.#finished; }
  view(seat: Seat | null): Record<string, unknown> {
    const view = this.#hand.view(seat ?? 0);
    const { holeCards, legalActions, ...publicView } = view;
    return { ...publicView, ...(seat !== null ? { holeCards, legalActions } : { holeCards: [], legalActions: [] }),
      handNumber: this.#number, handsTotal: this.hands, matchStacks: [...this.#stacks], initialChips: this.chips,
      handHistory: structuredClone(this.#history), unit: "virtual chips" };
  }
  act(seat: Seat, action: PlayAction) {
    if (this.#finished) throw new Error("GAME_FINISHED");
    this.#hand.act(seat, action as Action);
    this.#settle();
  }
  #settle() {
    // Posting a short blind can complete a newly created hand without an action.
    // Process that result through the same chip accounting before exposing actor().
    while (!this.#finished) {
      const view = this.#hand.view(0);
      if (!view.result) return;
      this.#stacks = [...view.result.finalStacks];
      this.#history.push({ handNumber: this.#number, board: view.board, ...view.result });
      if ((this.hands > 0 && this.#number >= this.hands) || this.#stacks.some(stack => stack === 0)) {
        this.#finished = this.#stacks[0] === this.#stacks[1] ? { kind: "draw", reason: "CHIP_TOTAL_TIED" }
          : { kind: "win", winner: this.#stacks[0] > this.#stacks[1] ? 0 : 1, reason: this.#stacks.some(stack => stack === 0) ? "BANKRUPT" : "HAND_LIMIT" };
      } else { this.#number++; this.#hand = this.#next(); }
    }
  }
  botAction(): PlayAction | null {
    const actor = this.actor();
    if (actor === null) return null;
    const view = this.#hand.view(actor);
    const check = view.legalActions.find(action => action.type === "check");
    if (check) return { type: "check" };
    const call = view.legalActions.find(action => action.type === "call");
    if (call) return { type: "call" };
    return { type: "fold" };
  }
}

class GomokuGame implements GameEngine {
  #board: Board = emptyBoard();
  actor(): Seat | null { return this.#board.result ? null : this.#board.next === "black" ? 0 : 1; }
  outcome(): PlayOutcome | null {
    const result = this.#board.result;
    if (!result) return null;
    return result.kind === "draw" ? { kind: "draw", reason: "BOARD_FULL" }
      : { kind: "win", winner: result.winner === "black" ? 0 : 1, reason: "FIVE_IN_A_ROW" };
  }
  view(seat: Seat | null) { return { ...structuredClone(this.#board), actor: this.actor(), seat, size: 15, rules: "freestyle-15" }; }
  act(seat: Seat, action: PlayAction) {
    if (action.type !== "place" || !keys(action, ["type", "row", "col"])) throw new Error("INVALID_ACTION");
    this.#board = play(this.#board, { side: seat === 0 ? "black" : "white", ply: this.#board.moves.length + 1, row: action.row, col: action.col });
  }
  botAction(): PlayAction | null {
    const actor = this.actor();
    if (actor === null) return null;
    const available = [];
    for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) if (this.#board.rows[row][col] === ".") available.push({ row, col });
    const side = actor === 0 ? "black" : "white";
    const opponent = side === "black" ? "white" : "black";
    for (const player of [side, opponent] as const) for (const move of available) {
      const board = { ...this.#board, next: player };
      if (play(board, { ...move, side: player, ply: board.moves.length + 1 }).result?.kind === "win") return { type: "place", ...move };
    }
    const marker = actor === 0 ? "X" : "O";
    const score = (row: number, col: number) => {
      let value = -Math.abs(row - 7) - Math.abs(col - 7);
      for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
        let own = 0, theirs = 0;
        for (const direction of [-1, 1]) for (let step = 1; step < 5; step++) {
          const r = row + dr * direction * step, c = col + dc * direction * step;
          if (r < 0 || r > 14 || c < 0 || c > 14 || this.#board.rows[r][c] === ".") break;
          if (this.#board.rows[r][c] === marker) own++; else theirs++;
        }
        value += own ** 3 * 8 + theirs ** 3 * 6;
      }
      return value;
    };
    available.sort((a, b) => score(b.row, b.col) - score(a.row, a.col));
    return available[0] ? { type: "place", ...available[0] } : null;
  }
}

function shuffled<T>(items: T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [result[i], result[j]] = [result[j]!, result[i]!];
  }
  return result;
}

/** Replays successful actions against exactly the private random draws already used. */
class JournalGame implements FreeGame {
  #engine: GameEngine;
  #journal: FreeGameReplay;
  #cursor = 0;
  #replaying: boolean;
  constructor(game: PlayGame, chips: number, hands: number, replay?: FreeGameReplay) {
    this.#journal = replay ? structuredClone(replay) : { version: 1, game, chips, hands, random: [], actions: [] };
    this.#replaying = replay !== undefined;
    if (game === "holdem") this.#engine = new PokerMatch(chips, hands, () => this.#random("holdem-deck", shuffledDeck) as Card[]);
    else if (game === "gomoku") this.#engine = new GomokuGame();
    else if (game === "chess") this.#engine = createChessGame();
    else this.#engine = new BalatroGame({
      deckFactory: () => this.#random("balatro-deck", () => shuffled(orderedBalatroDeck())) as BalatroCard[],
      rewardFactory: available => this.#random("balatro-rewards", () => shuffled(available).slice(0, 3)) as JokerId[],
    });
    if (replay) {
      for (const entry of replay.actions) this.#engine.act(entry.seat, entry.action);
      if (this.#cursor !== this.#journal.random.length) throw new Error("INVALID_GAME_REPLAY");
    }
    this.#replaying = false;
  }
  #random(kind: FreeGameReplay["random"][number]["kind"], generate: () => string[]): string[] {
    if (this.#replaying) {
      const entry = this.#journal.random[this.#cursor++];
      if (!entry || entry.kind !== kind || !Array.isArray(entry.values)) throw new Error("INVALID_GAME_REPLAY");
      return [...entry.values];
    }
    const values = generate();
    this.#journal.random.push({ kind, values: [...values] });
    return values;
  }
  actor() { return this.#engine.actor(); }
  outcome() { return this.#engine.outcome(); }
  view(seat: Seat | null) { return this.#engine.view(seat); }
  botAction() { return this.#engine.botAction(); }
  act(seat: Seat, action: PlayAction) {
    // Own the input before applying it: callers cannot later alter a committed replay.
    const owned = structuredClone(action);
    this.#engine.act(seat, owned);
    this.#journal.actions.push({ seat, action: owned });
  }
  exportTrustedReplay() { return structuredClone(this.#journal); }
}

export function createFreeGame(game: PlayGame, chips: number, hands: number): FreeGame {
  return new JournalGame(game, chips, hands);
}

/** Trusted disk entry point; never accepts client fields or exposes this payload in views. */
export function restoreFreeGame(input: unknown): FreeGame {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_GAME_REPLAY");
  const replay = input as FreeGameReplay;
  if (!keys(replay, ["version", "game", "chips", "hands", "random", "actions"]) || replay.version !== 1
    || !["holdem", "gomoku", "chess", "balatro"].includes(replay.game)
    || !Number.isSafeInteger(replay.chips) || replay.chips < 1 || !Number.isSafeInteger(replay.hands) || replay.hands < 0
    || !Array.isArray(replay.random) || !Array.isArray(replay.actions)
    || replay.random.some(entry => !entry || !keys(entry, ["kind", "values"]) || !Array.isArray(entry.values) || entry.values.some(value => typeof value !== "string"))
    || replay.actions.some(entry => !entry || !keys(entry, ["seat", "action"]) || (entry.seat !== 0 && entry.seat !== 1))) throw new Error("INVALID_GAME_REPLAY");
  return new JournalGame(replay.game, replay.chips, replay.hands, replay);
}
