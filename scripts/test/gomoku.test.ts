import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { boardHash, emptyBoard, IllegalMove, parseDecision, play, replayMoves, type Move } from "../../services/arena/src/gomoku/rules.js";
import { replayMatch, runMatch, type MatchSession } from "../../services/arena/src/gomoku/match.js";
import { createGomokuFixture } from "../gomoku-fixture.js";
import { read } from "../../services/underwriter/test/fixture.js";

test("15x15 freestyle referee verifies directions, overline, turns, illegal coordinates and a full-board draw", () => {
  for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
    let board = emptyBoard();
    for (let index = 0; index < 5; index++) {
      board = play(board, { ply: board.moves.length + 1, side: "black", row: 4 + index * dr, col: 7 + index * dc });
      if (index < 4) board = play(board, { ply: board.moves.length + 1, side: "white", row: 13, col: index * 2 });
    }
    assert.deepEqual(board.result, { kind: "win", winner: "black" }); assert.equal(boardHash(replayMoves(board.moves)), boardHash(board));
    assert.throws(() => play(board, { ply: 10, side: "white", row: 0, col: 0 }), (error: unknown) => error instanceof IllegalMove && error.code === "GAME_ALREADY_FINISHED");
  }
  let overline = emptyBoard();
  for (const [index, col] of [0, 1, 2, 4, 5, 6, 3].entries()) {
    overline = play(overline, { ply: overline.moves.length + 1, side: "black", row: 7, col });
    if (index < 6) overline = play(overline, { ply: overline.moves.length + 1, side: "white", row: 12, col: index * 2 });
  }
  assert.deepEqual(overline.result, { kind: "win", winner: "black" });
  const first = play(emptyBoard(), { ply: 1, side: "black", row: 0, col: 0 });
  for (const move of [{ ply: 2, side: "black", row: 0, col: 1 }, { ply: 3, side: "white", row: 0, col: 1 }, { ply: 2, side: "white", row: 0, col: 0 }, { ply: 2, side: "white", row: -1, col: 0 }, { ply: 2, side: "white", row: 15, col: 0 }, { ply: 2, side: "white", row: 1.2, col: 0 }]) assert.throws(() => play(first, move as Move), IllegalMove);
  const spots = { black: [] as { row: number; col: number }[], white: [] as { row: number; col: number }[] };
  for (let row = 0; row < 15; row++) for (let col = 0; col < 15; col++) spots[(Math.floor(row / 2) + col) % 2 ? "white" : "black"].push({ row, col });
  let draw = emptyBoard(); for (let ply = 1; ply <= 225; ply++) { const side = ply % 2 ? "black" : "white"; draw = play(draw, { ply, side, ...spots[side].shift()! }); }
  assert.deepEqual(draw.result, { kind: "draw" }); assert.equal(draw.moves.length, 225);
  for (const content of ["winner black", '{"row":1}', '{"row":1,"col":2,"winner":"black"}', '{"row":1.5,"col":2}']) assert.throws(() => parseDecision({ choices: [{ finish_reason: "stop", message: { role: "assistant", content } }] }), IllegalMove);
});

test("two real HTTP agents pay independently; replay/recovery never repeats unknown paid inference", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-gomoku-")); const local = await createGomokuFixture(directory);
  const options = { signers: local.signers, timeoutMs: 5000 };
  try {
    const before = { provider: await local.f.providerBalance(), black: await read(local.f.account, "cash", [1n]), white: await read(local.f.account, "cash", [2n]), calls: local.calls.length };
    const successConfig = local.config("black-win"); const success = await runMatch(join(directory, "success"), successConfig, options);
    assert.deepEqual(success.result, { kind: "win", winner: "black" }); assert.equal(success.turns.length, 9); assert.equal(local.calls.length - before.calls, 9);
    assert.equal(await local.f.providerBalance() - before.provider, 9000n); assert.equal(before.black - await read(local.f.account, "cash", [1n]), 5000n); assert.equal(before.white - await read(local.f.account, "cash", [2n]), 4000n);
    assert.deepEqual(success.reservedPrice, { black: "5000", white: "4000" }); assert.equal(replayMatch(success).moves.length, 9);
    assert.deepEqual(await runMatch(join(directory, "success"), successConfig, options), success); assert.equal(local.calls.length - before.calls, 9);
    for (const mutation of [
      (s: MatchSession) => { s.result = { kind: "win", winner: "white" }; },
      (s: MatchSession) => { s.turns[0].afterBoardHash = "00".repeat(32); },
      (s: MatchSession) => { s.turns[0].inference!.receipt.price = "1"; },
      (s: MatchSession) => { s.turns[0].body.messages[1] = { role: "user", content: "fake board" }; },
      (s: MatchSession) => { s.reservedPrice.white = "0"; },
    ]) { const modified = structuredClone(success); mutation(modified); assert.throws(() => replayMatch(modified)); }
    const budgetConfig = local.config("budget"); budgetConfig.players.black.maxTotalPrice = "2000";
    const budgetCalls = local.calls.length; const budget = await runMatch(join(directory, "budget"), budgetConfig, options);
    assert.equal(budget.phase, "Stopped"); assert.equal(budget.reason, "BUDGET_EXHAUSTED_BLACK"); assert.equal(budget.result, undefined); assert.equal(replayMatch(budget).moves.length, 4); assert.equal(local.calls.length - budgetCalls, 4);
    const capped = await runMatch(join(directory, "plies"), local.config("plies", { maxPlies: 3 }), options); assert.equal(capped.reason, "PLY_LIMIT"); assert.equal(capped.result, undefined); assert.equal(replayMatch(capped).moves.length, 3);
    const deadlineCalls = local.calls.length; const deadline = await runMatch(join(directory, "deadline"), local.config("deadline", { deadlineMs: Date.now() - 1 }), options);
    assert.equal(deadline.reason, "MATCH_DEADLINE"); assert.equal(deadline.result, undefined); assert.equal(local.calls.length, deadlineCalls);
    const invalid = await runMatch(join(directory, "invalid"), local.config("invalid-json"), options); assert.deepEqual(invalid.result, { kind: "forfeit", winner: "white", reason: "INVALID_MOVE_JSON" }); assert.equal(replayMatch(invalid).moves.length, 0);
    const occupied = await runMatch(join(directory, "occupied"), local.config("occupied"), options); assert.deepEqual(occupied.result, { kind: "forfeit", winner: "black", reason: "OCCUPIED" }); assert.equal(replayMatch(occupied).moves.length, 1);

    // The paid provider request was received, then its response was lost: no runner retry on this or a later invocation.
    const lostConfig = local.config("lost-model-response"); const lostDir = join(directory, "lost-model"); const lostCalls = local.calls.length; const lostProvider = await local.f.providerBalance();
    const lost = await runMatch(lostDir, lostConfig, options); assert.equal(lost.phase, "Paused"); assert.equal(lost.result, undefined); assert.equal(lost.turns.length, 1); assert.ok(lost.turns[0].handle?.submission?.rawTransaction);
    assert.equal(local.calls.length - lostCalls, 1); assert.equal(await local.f.providerBalance() - lostProvider, 1000n);
    for (let count = 0; count < 2; count++) { const paused = await runMatch(lostDir, lostConfig, options); assert.equal(paused.phase, "Paused"); assert.equal(paused.reason, "PAID_INFERENCE_UNKNOWN"); assert.equal(paused.result, undefined); }
    assert.equal(local.calls.length - lostCalls, 1); assert.equal(await local.f.providerBalance() - lostProvider, 1000n);

    const timeoutConfig = local.config("model-timeout"); const timeoutDir = join(directory, "timeout"); const timeoutCalls = local.calls.length;
    const timedOut = await runMatch(timeoutDir, timeoutConfig, options); assert.equal(timedOut.phase, "Paused"); assert.equal(timedOut.result, undefined);
    const timeoutResume = await runMatch(timeoutDir, timeoutConfig, options); assert.equal(timeoutResume.reason, "PAID_INFERENCE_UNKNOWN"); assert.equal(timeoutResume.result, undefined); assert.equal(local.calls.length - timeoutCalls, 1);

    // A malformed or over-cap quote is uncertain, never mislabeled as a game draw or a known budget exhaustion.
    const priceCap = local.config("price-cap"); priceCap.players.black.maxPricePerMove = "500"; const priceCapCalls = local.calls.length;
    const cappedQuote = await runMatch(join(directory, "price-cap"), priceCap, options); assert.equal(cappedQuote.phase, "Paused"); assert.equal(cappedQuote.reason, "UNTRUSTED_QUOTE"); assert.equal(cappedQuote.result, undefined); assert.equal(local.calls.length, priceCapCalls); assert.equal(cappedQuote.turns[0].handle, undefined);

    // Delivered exists durably in Relay while HTTP reports a lost reply: recovery takes that cache and completes remaining turns.
    const relay = local.relays[0]; const originalWrite = relay.store.write.bind(relay.store); let crash = true;
    relay.store.write = async record => { await originalWrite(record); if (crash && record.state === "Delivered") { crash = false; throw new Error("Controlled reply loss after Delivered commit"); } };
    const recoveryConfig = local.config("cached-recovery"); const recoveryDir = join(directory, "recovery"); const recoveryCalls = local.calls.length; const recoveryProvider = await local.f.providerBalance();
    try { const pending = await runMatch(recoveryDir, recoveryConfig, options); assert.equal(pending.phase, "Paused"); assert.equal(pending.turns[0].inference, undefined); }
    finally { relay.store.write = originalWrite; }
    const recovered = await runMatch(recoveryDir, recoveryConfig, options); assert.deepEqual(recovered.result, { kind: "win", winner: "black" });
    assert.equal(local.calls.length - recoveryCalls, 9); assert.equal(await local.f.providerBalance() - recoveryProvider, 9000n); assert.equal(replayMatch(recovered).moves.length, 9);

    // Crash after paid response journal, before referee application: replay uses the saved response without another HTTP call/payment.
    const originalSave = SessionStore.prototype.write; let journalCrash = true;
    SessionStore.prototype.write = async function (value: unknown) { await originalSave.call(this, value); const session = value as MatchSession; if (journalCrash && session.config?.matchId === "response-checkpoint" && session.turns?.[0]?.inference && !session.turns[0].applied) { journalCrash = false; throw new Error("controlled response checkpoint crash"); } };
    const checkpointConfig = local.config("response-checkpoint"); const checkpointDir = join(directory, "checkpoint"); const checkpointCalls = local.calls.length;
    try { await assert.rejects(runMatch(checkpointDir, checkpointConfig, options), /controlled response checkpoint crash/); } finally { SessionStore.prototype.write = originalSave; }
    const checkpoint = await runMatch(checkpointDir, checkpointConfig, options); assert.deepEqual(checkpoint.result, { kind: "win", winner: "black" }); assert.equal(local.calls.length - checkpointCalls, 9);
    const changed = structuredClone(checkpointConfig); changed.players.black.maxTotalPrice = "30000";
    await assert.rejects(runMatch(checkpointDir, changed, options), /MATCH_CONFIG_MISMATCH/);
    const persisted = JSON.parse(await readFile(join(checkpointDir, "session.json"), "utf8")); assert.equal(replayMatch(persisted).moves.length, 9);
    assert.ok(local.calls.every(call => call.request.max_completion_tokens === 128 && call.request.tier === undefined && call.request.agentId === undefined && call.request.taskId === undefined));
    assert.equal(await read(local.f.manager, "totalOutstanding"), 0n);
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});
