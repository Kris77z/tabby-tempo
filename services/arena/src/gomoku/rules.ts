import { createHash } from "node:crypto";

export const RULES = "gomoku-freestyle-15-v1" as const;
export const SIZE = 15;
export type Side = "black" | "white";
export interface Move { ply: number; side: Side; row: number; col: number }
export interface Board { rows: string[]; moves: Move[]; next: Side; result?: { kind: "win"; winner: Side } | { kind: "draw" } }
export class IllegalMove extends Error { constructor(public code: string) { super(code); } }
export const other = (side: Side): Side => side === "black" ? "white" : "black";
export const boardHash = (board: Board) => createHash("sha256").update(JSON.stringify({ rules: RULES, rows: board.rows, moves: board.moves, next: board.next, result: board.result ?? null })).digest("hex");
export function emptyBoard(): Board { return { rows: Array.from({ length: SIZE }, () => ".".repeat(SIZE)), moves: [], next: "black" }; }

/** Trusted referee: the agents provide coordinates, never a win/draw verdict. Zero-based coordinates. */
export function play(board: Board, move: Move): Board {
  if (board.result) throw new IllegalMove("GAME_ALREADY_FINISHED");
  if (!move || move.side !== board.next || move.ply !== board.moves.length + 1) throw new IllegalMove("TURN_MISMATCH");
  if (!Number.isInteger(move.row) || !Number.isInteger(move.col) || move.row < 0 || move.row >= SIZE || move.col < 0 || move.col >= SIZE) throw new IllegalMove("OUT_OF_BOUNDS");
  if (board.rows[move.row][move.col] !== ".") throw new IllegalMove("OCCUPIED");
  const marker = move.side === "black" ? "X" : "O";
  const next: Board = { rows: [...board.rows], moves: [...board.moves, { ...move }], next: other(move.side) };
  next.rows[move.row] = next.rows[move.row].slice(0, move.col) + marker + next.rows[move.row].slice(move.col + 1);
  const at = (row: number, col: number) => row >= 0 && row < SIZE && col >= 0 && col < SIZE && next.rows[row][col] === marker;
  for (const [dr, dc] of [[1, 0], [0, 1], [1, 1], [1, -1]]) {
    let length = 1;
    for (const direction of [-1, 1]) { let step = 1; while (at(move.row + dr * step * direction, move.col + dc * step * direction)) { length++; step++; } }
    if (length >= 5) { next.result = { kind: "win", winner: move.side }; return next; }
  }
  if (next.moves.length === SIZE * SIZE) next.result = { kind: "draw" };
  return next;
}
export function replayMoves(moves: Move[]): Board {
  if (!Array.isArray(moves) || moves.length > SIZE * SIZE) throw new IllegalMove("INVALID_TRANSCRIPT");
  return moves.reduce((board, move) => play(board, move), emptyBoard());
}
export function parseDecision(value: unknown): { row: number; col: number } {
  const result = value as { choices?: { finish_reason?: string; message?: { role?: string; content?: unknown } }[] };
  const choice = result?.choices?.[0];
  if (!choice || choice.finish_reason !== "stop" || choice.message?.role !== "assistant" || typeof choice.message.content !== "string" || choice.message.content.length > 4096) throw new IllegalMove("INVALID_MODEL_RESPONSE");
  let move: unknown;
  try { move = JSON.parse(choice.message.content); } catch { throw new IllegalMove("INVALID_MOVE_JSON"); }
  if (!move || typeof move !== "object" || Array.isArray(move) || Object.keys(move).sort().join(",") !== "col,row" ||
    !Number.isInteger((move as any).row) || !Number.isInteger((move as any).col)) throw new IllegalMove("INVALID_MOVE_SHAPE");
  return move as { row: number; col: number };
}
