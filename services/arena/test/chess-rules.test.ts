import assert from "node:assert/strict";
import test from "node:test";
import { createChessGame, type ChessAction, type ChessGame } from "../src/chess/game.js";
import { createChessGameFromPositionForTest } from "../src/chess/test-support.js";

const move = (game: ChessGame, from: string, to: string, promotion?: ChessAction["promotion"]) => game.act(game.actor()!, { type: "move", from, to, ...(promotion ? { promotion } : {}) });
test("chess enforces side, legal moves and exact action shape without altering failed positions", () => {
  const game = createChessGame(), before = game.view(0);
  assert.equal(before.legalMoves.length, 20);
  assert.deepEqual(game.view(1).legalMoves, []);
  assert.deepEqual(game.view(null).legalMoves, []);
  assert.equal(JSON.stringify(game), "{}");
  for (const [seat, action] of [
    [1, { type: "move", from: "e7", to: "e5" }],
    [0, { type: "move", from: "e2", to: "e5" }],
    [0, { type: "move", from: "a1", to: "a3" }],
    [0, { type: "move", from: "e2", to: "e4", promotion: "q" }],
    [0, { type: "move", from: "e2", to: "e4", winner: 0 }],
    [0, { type: "move", from: "E2", to: "e4" }],
  ] as [0 | 1, ChessAction][]) { assert.throws(() => game.act(seat, action)); assert.deepEqual(game.view(0), before); }
  move(game, "e2", "e4");
  assert.equal(game.actor(), 1); assert.equal(game.view(1).ply, 1); assert.equal(game.view(1).lastMove!.san, "e4");
  before.board[0]![0] = null; before.legalMoves[0]!.to = "h8";
  assert.equal(game.view(0).board[0]![0], "r");
});

test("castling moves both pieces, observes attacked transit squares and loses rights after king moves", () => {
  const game = createChessGameFromPositionForTest("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  move(game, "e1", "g1");
  assert.deepEqual(game.view(1).board[7], ["R", null, null, null, null, "R", "K", null]);
  move(game, "e8", "c8");
  assert.deepEqual(game.view(0).board[0], [null, null, "k", "r", null, null, null, "r"]);
  const attacked = createChessGameFromPositionForTest("4kr2/8/8/8/8/8/8/R3K2R w KQ - 0 1");
  assert.throws(() => move(attacked, "e1", "g1"), /ILLEGAL_MOVE/);
  const lost = createChessGameFromPositionForTest("r3k2r/8/8/8/8/8/8/R3K2R w KQkq - 0 1");
  move(lost, "e1", "e2"); move(lost, "e8", "e7"); move(lost, "e2", "e1"); move(lost, "e7", "e8");
  assert.throws(() => move(lost, "e1", "g1"), /ILLEGAL_MOVE/);
});

test("en passant removes the pawn, expires after a turn and cannot expose one's own king", () => {
  const game = createChessGame();
  for (const [from, to] of [["e2", "e4"], ["a7", "a6"], ["e4", "e5"], ["d7", "d5"], ["e5", "d6"]]) move(game, from!, to!);
  assert.equal(game.view(1).board[2]![3], "P"); assert.equal(game.view(1).board[3]![3], null);
  assert.equal(game.view(1).lastMove!.san, "exd6");
  const pinned = createChessGameFromPositionForTest("k3r3/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  assert.throws(() => move(pinned, "e5", "d6"), /ILLEGAL_MOVE/);
  const expired = createChessGameFromPositionForTest("k7/8/8/3pP3/8/8/8/4K3 w - d6 0 1");
  move(expired, "e1", "e2"); move(expired, "a8", "a7");
  assert.throws(() => move(expired, "e5", "d6"), /ILLEGAL_MOVE/);
});

test("promotion requires an explicit q/r/b/n and replaces the pawn", () => {
  for (const promotion of ["q", "r", "b", "n"] as const) {
    const game = createChessGameFromPositionForTest("7k/P7/8/8/8/8/8/7K w - - 0 1");
    assert.equal(game.view(0).legalMoves.filter(candidate => candidate.from === "a7" && candidate.to === "a8").length, 4);
    assert.throws(() => move(game, "a7", "a8"), /ILLEGAL_MOVE/);
    move(game, "a7", "a8", promotion);
    assert.equal(game.view(1).board[0]![0], promotion.toUpperCase());
  }
});

test("checkmate beats the fifty-move threshold; terminal positions reject later moves", () => {
  const game = createChessGameFromPositionForTest("7k/5K2/8/8/8/8/8/R7 w - - 99 1");
  move(game, "a1", "h1");
  assert.deepEqual(game.outcome(), { kind: "win", winner: 0, reason: "checkmate" });
  assert.equal(game.actor(), null); assert.deepEqual(game.view(1).legalMoves, []);
  assert.throws(() => game.act(1, { type: "move", from: "h8", to: "g8" }), /GAME_COMPLETE/);
  const foolsMate = createChessGame();
  for (const [from, to] of [["f2", "f3"], ["e7", "e5"], ["g2", "g4"], ["d8", "h4"]]) move(foolsMate, from!, to!);
  assert.deepEqual(foolsMate.outcome(), { kind: "win", winner: 1, reason: "checkmate" });
});

test("stalemate, insufficient material, automatic repetition and fifty-move draw are distinct", () => {
  assert.deepEqual(createChessGameFromPositionForTest("7k/5K2/6Q1/8/8/8/8/8 b - - 0 1").outcome(), { kind: "draw", reason: "stalemate" });
  for (const fen of ["7k/8/8/8/8/8/8/7K w - - 0 1", "7k/8/8/8/8/8/8/5B1K w - - 0 1", "7k/8/8/8/8/8/8/5N1K w - - 0 1", "5b1k/8/8/8/8/8/8/7K w - - 0 1", "5b1k/8/8/8/8/8/8/2B4K w - - 0 1"]) {
    assert.deepEqual(createChessGameFromPositionForTest(fen).outcome(), { kind: "draw", reason: "insufficient_material" });
  }
  const repetition = createChessGame();
  for (let cycle = 0; cycle < 2; cycle++) for (const [from, to] of [["g1", "f3"], ["g8", "f6"], ["f3", "g1"], ["f6", "g8"]]) move(repetition, from!, to!);
  assert.deepEqual(repetition.outcome(), { kind: "draw", reason: "threefold_repetition" });
  const fifty = createChessGameFromPositionForTest("7k/8/8/8/8/8/8/R6K w - - 99 1");
  move(fifty, "a1", "a2"); assert.deepEqual(fifty.outcome(), { kind: "draw", reason: "fifty_moves" });
  const reset = createChessGameFromPositionForTest("7k/8/8/8/8/8/P7/R6K w - - 99 1");
  move(reset, "a2", "a3"); assert.equal(reset.outcome(), null);
});

test("local opponent makes a legal choice without mutating referee history and finds mate in one", () => {
  const initial = createChessGame(), before = initial.view(0), action = initial.botAction()!;
  assert.deepEqual(initial.view(0), before); initial.act(0, action); assert.equal(initial.actor(), 1);
  const mating = createChessGameFromPositionForTest("7k/5K2/8/8/8/8/8/R7 w - - 0 1");
  const mate = mating.botAction()!; mating.act(0, mate);
  assert.equal(mating.outcome()!.reason, "checkmate"); assert.equal(mating.botAction(), null);
});
