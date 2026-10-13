import { ChessGame } from "./rules.js";

/** Trusted test fixture, never accepted from a session request. */
export function createChessGameFromPositionForTest(fen: string): ChessGame { return new ChessGame(fen); }
