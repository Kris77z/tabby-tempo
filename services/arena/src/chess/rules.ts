import { Chess, type Move, type Square } from "chess.js";

export const CHESS_RULES = "standard-v1" as const;
export type ChessSeat = 0 | 1;
export type Promotion = "q" | "r" | "b" | "n";
export interface ChessAction { type: "move"; from: string; to: string; promotion?: Promotion }
export interface ChessOutcome { kind: "win" | "draw"; winner?: ChessSeat; reason: string }
export interface ChessMove { from: string; to: string; promotion?: Promotion; san: string }
export interface ChessView {
  rules: typeof CHESS_RULES;
  fen: string;
  board: (string | null)[][];
  turn: ChessSeat;
  inCheck: boolean;
  ply: number;
  lastMove: ChessMove | null;
  legalMoves: ChessMove[];
  history: string[];
  result: ChessOutcome | null;
}
export class ChessRuleError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "ChessRuleError"; }
}
function seatOf(color: "w" | "b"): ChessSeat { return color === "w" ? 0 : 1; }
function assertSeat(seat: unknown): asserts seat is ChessSeat {
  if (seat !== 0 && seat !== 1) throw new ChessRuleError("INVALID_SEAT");
}
function publicMove(move: Move): ChessMove {
  return { from: move.from, to: move.to, ...(move.promotion ? { promotion: move.promotion as Promotion } : {}), san: move.san };
}
function outcome(game: Chess): ChessOutcome | null {
  // The Arena automatically adjudicates claimable draws, with checkmate taking priority.
  if (game.isCheckmate()) return { kind: "win", winner: seatOf(game.turn() === "w" ? "b" : "w"), reason: "checkmate" };
  if (game.isStalemate()) return { kind: "draw", reason: "stalemate" };
  if (game.isInsufficientMaterial()) return { kind: "draw", reason: "insufficient_material" };
  if (game.isThreefoldRepetition()) return { kind: "draw", reason: "threefold_repetition" };
  if (game.isDrawByFiftyMoves()) return { kind: "draw", reason: "fifty_moves" };
  return null;
}
const values = { p: 100, n: 320, b: 330, r: 500, q: 900, k: 0 };

/** A referee backed by chess.js 1.4.0. FEN alone cannot restore repetition history. */
export class ChessGame {
  #game: Chess;
  constructor(initialFen?: string) { this.#game = new Chess(initialFen); }
  actor(): ChessSeat | null { return this.outcome() ? null : seatOf(this.#game.turn()); }
  outcome(): ChessOutcome | null { return outcome(this.#game); }
  view(seat: ChessSeat | null): ChessView {
    if (seat !== null) assertSeat(seat);
    const history = this.#game.history({ verbose: true });
    return {
      rules: CHESS_RULES, fen: this.#game.fen(),
      board: this.#game.board().map(row => row.map(piece => piece ? piece.color === "w" ? piece.type.toUpperCase() : piece.type : null)),
      turn: seatOf(this.#game.turn()), inCheck: this.#game.inCheck(), ply: history.length,
      lastMove: history.length ? publicMove(history[history.length - 1]!) : null,
      legalMoves: this.actor() === seat ? this.#game.moves({ verbose: true }).map(publicMove) : [],
      history: history.map(move => move.san), result: this.outcome(),
    };
  }
  act(seat: ChessSeat, action: ChessAction): void {
    assertSeat(seat);
    if (this.outcome()) throw new ChessRuleError("GAME_COMPLETE");
    if (this.actor() !== seat) throw new ChessRuleError("OUT_OF_TURN");
    if (!action || typeof action !== "object" || Array.isArray(action) || action.type !== "move" ||
      Object.keys(action).some(key => !["type", "from", "to", "promotion"].includes(key)) ||
      typeof action.from !== "string" || !/^[a-h][1-8]$/.test(action.from) ||
      typeof action.to !== "string" || !/^[a-h][1-8]$/.test(action.to) ||
      ("promotion" in action && !["q", "r", "b", "n"].includes(action.promotion!))) throw new ChessRuleError("INVALID_ACTION");
    // Exact candidate matching requires explicit promotion and forbids a promotion field on ordinary moves.
    const legal = this.#game.moves({ verbose: true }).find(move => move.from === action.from && move.to === action.to && move.promotion === action.promotion);
    if (!legal) throw new ChessRuleError("ILLEGAL_MOVE");
    this.#game.move({ from: action.from as Square, to: action.to as Square, ...(action.promotion ? { promotion: action.promotion } : {}) });
  }
  /** Small deterministic local opponent. It inspects legal chess positions and never calls a model. */
  botAction(): ChessAction | null {
    if (this.outcome()) return null;
    const color = this.#game.turn();
    const evaluate = (): number => {
      if (this.#game.isCheckmate()) return this.#game.turn() === color ? -100_000 : 100_000;
      if (this.#game.isDraw()) return 0;
      let score = 0;
      for (const row of this.#game.board()) for (const piece of row) if (piece) {
        const file = piece.square.charCodeAt(0) - 97;
        const rank = Number(piece.square[1]) - 1;
        const center = 7 - Math.abs(file - 3.5) - Math.abs(rank - 3.5);
        score += (piece.color === color ? 1 : -1) * (values[piece.type] + (piece.type === "k" ? 0 : center * 3));
      }
      return score;
    };
    let best: Move | null = null, bestScore = -Infinity;
    for (const move of this.#game.moves({ verbose: true })) {
      this.#game.move(move);
      let score = evaluate();
      if (!this.#game.isGameOver()) {
        score = Infinity;
        for (const reply of this.#game.moves({ verbose: true })) {
          this.#game.move(reply);
          score = Math.min(score, evaluate());
          this.#game.undo();
        }
      }
      this.#game.undo();
      if (score > bestScore) { bestScore = score; best = move; }
    }
    return best ? { type: "move", from: best.from, to: best.to, ...(best.promotion ? { promotion: best.promotion as Promotion } : {}) } : null;
  }
}
export function createChessGame(): ChessGame { return new ChessGame(); }
