import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { PlayError, PlayStore } from "../src/freeplay/store.js";
import { createHand, replayHand, type Action, type Seat } from "../src/holdem/engine.js";
import { createFreeGame } from "../src/freeplay/games.js";
import type { PlayCommand, PlayGame, PlayMatchView, PlaySession } from "../../../frontend/lib/play-types.js";

const requestId = () => randomUUID();
const create = (store: PlayStore, game: PlayGame, mode: "challenge" | "invite" = "challenge", hands = 1) =>
  store.command({ op: "create", game, mode, hands, chips: 500, requestId: requestId() });
const operation = (store: PlayStore, session: PlaySession, op: "ready" | "auto" | "resign") =>
  store.command({ op, matchId: session.match.id, version: store.get(session.match.id, session.seatToken).version, requestId: requestId() }, session.seatToken);
function errorCode(action: () => unknown, code: string) {
  assert.throws(action, error => error instanceof PlayError && error.code === code);
}
function invite(store: PlayStore, game: PlayGame = "holdem", hands = 1) {
  const first = create(store, game, "invite", hands);
  const second = store.command({ op: "join", inviteCode: first.match.inviteCode, name: "Second client", requestId: requestId() });
  operation(store, first, "ready"); operation(store, second, "ready");
  return [first, second] as const;
}
function action(store: PlayStore, session: PlaySession, move: PlayCommand & { op: "action" }) {
  return store.command(move, session.seatToken);
}

test("independent invited clients ready, act, replay and never receive another seat token or hidden cards", () => {
  const store = new PlayStore();
  const [first, second] = invite(store);
  const a = store.get(first.match.id, first.seatToken), b = store.get(first.match.id, second.seatToken);
  assert.equal(a.status, "playing"); assert.equal(a.yourSeat, 0); assert.equal(b.yourSeat, 1);
  assert.equal((a.gameView!.holeCards as string[]).length, 2); assert.equal((b.gameView!.holeCards as string[]).length, 2);
  assert.notDeepEqual(a.gameView!.holeCards, b.gameView!.holeCards);
  const publicView = store.get(first.match.id);
  assert.deepEqual(publicView.gameView!.holeCards, []);
  for (const text of [JSON.stringify(a), JSON.stringify(b), JSON.stringify(publicView), JSON.stringify(store.list())]) {
    assert.ok(!text.includes(first.seatToken!)); assert.ok(!text.includes(second.seatToken!));
    assert.ok(!text.includes('"deck"')); assert.ok(!text.includes('"token"'));
  }
  assert.equal(publicView.inviteCode, undefined);
  errorCode(() => store.get(first.match.id, "random-token"), "UNAUTHORIZED");
  errorCode(() => operation(store, { ...second, seatToken: "random-token" }, "auto"), "UNAUTHORIZED");
  const command: PlayCommand = { op: "action", matchId: first.match.id, version: a.version, requestId: requestId(), action: { type: "call" } };
  const accepted = store.command(command, first.seatToken);
  const repeated = store.command(command, first.seatToken);
  assert.deepEqual(repeated, accepted);
  assert.deepEqual(store.command({ action: command.action, requestId: command.requestId, version: command.version, matchId: command.matchId, op: command.op }, first.seatToken), accepted);
  assert.equal(store.get(first.match.id).version, accepted.match.version);
  errorCode(() => store.command({ ...command, action: { type: "fold" } }, first.seatToken), "REQUEST_ID_REUSED");
  errorCode(() => store.command({ ...command, requestId: requestId() }, first.seatToken), "VERSION_CONFLICT");
  errorCode(() => store.command({ ...command, version: accepted.match.version, requestId: requestId() }, first.seatToken), "OUT_OF_TURN");
  let steps = 0;
  while (store.get(first.match.id).status === "playing") {
    const current = store.get(first.match.id); operation(store, current.actor === 0 ? first : second, "auto");
    assert.ok(++steps < 20);
  }
  assert.equal(store.list().history.length, 1);
  const done = store.get(first.match.id, second.seatToken);
  assert.ok(done.outcome); assert.equal(done.deadline, null);
  assert.ok(done.logs.some(log => log.kind === "finished"));
});

test("create and join retries are idempotent and conflicting request payloads are refused", () => {
  const store = new PlayStore();
  const c: PlayCommand = { op: "create", game: "gomoku", mode: "invite", requestId: requestId() };
  const owner = store.command(c);
  assert.deepEqual(store.command(c), owner);
  errorCode(() => store.command({ ...c, game: "chess" }), "REQUEST_ID_REUSED");
  const j: PlayCommand = { op: "join", inviteCode: owner.match.inviteCode, requestId: requestId() };
  const guest = store.command(j);
  assert.deepEqual(store.command(j), guest);
  errorCode(() => store.command({ ...j, name: "Changed" }), "REQUEST_ID_REUSED");
  errorCode(() => store.command({ ...j, requestId: requestId() }), "INVITE_FULL_OR_CLOSED");
  errorCode(() => store.command({ op: "join", matchId: owner.match.id, requestId: requestId() }), "INVITE_CODE_REQUIRED");
});

test("server refuses supplied winner/deck/chips verdict and malformed action without changing state", () => {
  const store = new PlayStore();
  errorCode(() => store.command({ op: "create", game: "holdem", mode: "challenge", requestId: requestId(), deck: [] }), "INVALID_COMMAND");
  errorCode(() => store.command({ op: "create", game: "balatro", mode: "invite", requestId: requestId() }), "BALATRO_SOLO_ONLY");
  errorCode(() => store.command({ op: "create", game: "chess", mode: "challenge", chips: -1, requestId: requestId() }), "INVALID_CONFIG");
  const [first] = invite(store);
  const before = store.get(first.match.id, first.seatToken);
  errorCode(() => store.command({ op: "action", matchId: first.match.id, version: before.version, requestId: requestId(),
    action: { type: "call", winner: 0, finalStacks: [999999, 0] } }, first.seatToken), "INVALID_ACTION");
  assert.deepEqual(store.get(first.match.id, first.seatToken), before);
});

test("challenge bot makes legal moves for four games and explicit local auto completes holdem/balatro", () => {
  const store = new PlayStore();
  for (const game of ["holdem", "gomoku", "chess", "balatro"] as const) {
    const player = create(store, game);
    const started = operation(store, player, "ready");
    assert.equal(started.match.actor, 0);
    const moved = operation(store, player, "auto");
    assert.ok(moved.match.logs.some(log => log.kind === "action" && log.seat === 0));
    if (game !== "balatro") assert.ok(moved.match.logs.some(log => log.kind === "action" && log.seat === 1));
    if (game === "holdem" || game === "balatro") {
      let steps = 0;
      while (store.get(player.match.id).status === "playing") { operation(store, player, "auto"); assert.ok(++steps < 200); }
      assert.ok(store.get(player.match.id).outcome);
    } else operation(store, player, "resign");
  }
  assert.equal(store.list().history.length, 4);
  assert.match(store.list().bot.description, /不调用 LLM/);
});

test("gomoku invitation referee determines five in a row, chess legal referee determines checkmate", () => {
  const store = new PlayStore();
  const [a, b] = invite(store, "gomoku");
  for (let col = 0; col < 5; col++) {
    let view = store.get(a.match.id);
    action(store, a, { op: "action", matchId: a.match.id, version: view.version, requestId: requestId(), action: { type: "place", row: 0, col } });
    if (col < 4) { view = store.get(a.match.id); action(store, b, { op: "action", matchId: a.match.id, version: view.version, requestId: requestId(), action: { type: "place", row: 2, col } }); }
  }
  assert.deepEqual(store.get(a.match.id).outcome, { kind: "win", winner: 0, reason: "FIVE_IN_A_ROW" });
  const [white, black] = invite(store, "chess");
  for (const [seat, from, to] of [[0, "f2", "f3"], [1, "e7", "e5"], [0, "g2", "g4"], [1, "d8", "h4"]] as const) {
    const view = store.get(white.match.id); action(store, seat === 0 ? white : black,
      { op: "action", matchId: white.match.id, version: view.version, requestId: requestId(), action: { type: "move", from, to } });
  }
  assert.deepEqual(store.get(white.match.id).outcome, { kind: "win", winner: 1, reason: "checkmate" });
});

test("ten-minute readiness and action deadlines are adjudicated server-side", () => {
  let clock = 0;
  const store = new PlayStore(() => clock);
  const waiting = create(store, "gomoku", "invite");
  clock = 10 * 60 * 1000;
  assert.equal(store.get(waiting.match.id).status, "cancelled");
  assert.equal(store.get(waiting.match.id).outcome, null);
  const player = create(store, "chess"); operation(store, player, "ready");
  clock += 10 * 60 * 1000;
  assert.deepEqual(store.get(player.match.id).outcome, { kind: "win", winner: 1, reason: "ACTION_TIMEOUT" });
});

test("multi-hand holdem carries asymmetric stacks and conserves virtual chips", () => {
  const store = new PlayStore();
  const [first, second] = invite(store, "holdem", 3);
  const initial = store.get(first.match.id);
  const folded = action(store, first, { op: "action", matchId: first.match.id, version: initial.version, requestId: requestId(), action: { type: "fold" } });
  assert.deepEqual(folded.match.gameView!.matchStacks, [495, 505]);
  assert.equal(folded.match.gameView!.handNumber, 2);
  let steps = 0;
  while (store.get(first.match.id).status === "playing") {
    const current = store.get(first.match.id); operation(store, current.actor === 0 ? first : second, "auto"); assert.ok(++steps < 50);
  }
  const final = store.get(first.match.id).gameView!;
  assert.equal((final.matchStacks as number[]).reduce((total, value) => total + value, 0), 1000);
  assert.equal((final.handHistory as unknown[]).length, 3);
});

test("short blind/asymmetric holdem stays non-negative and trusted replay preserves initial stacks", () => {
  const hand = createHand({ initialStack: 100, initialStacks: [3, 100], smallBlind: 5, bigBlind: 10 });
  assert.equal(hand.view(0).handStatus, "complete");
  assert.equal(hand.view(0).result!.finalStacks.reduce((sum, value) => sum + value, 0), 103);
  assert.ok(hand.view(0).result!.finalStacks.every(value => value >= 0));
  assert.deepEqual(replayHand(hand.exportTrustedReplay()).view(0), hand.view(0));
  for (let sample = 0; sample < 20; sample++) {
    const match = createFreeGame("holdem", 3, 20);
    assert.equal(match.actor(), null);
    assert.ok(match.outcome(), "constructor-completed short-blind hands must reach an outcome");
    assert.equal(((match.view(0) as { matchStacks: number[] }).matchStacks).reduce((sum, value) => sum + value, 0), 6);
  }
});

test("until-bust holdem continues past twenty hands and ends only when a seat is bankrupt", () => {
  const store = new PlayStore();
  const [first, second] = invite(store, "holdem", 0);
  let steps = 0;
  while (store.get(first.match.id).status === "playing") {
    const current = store.get(first.match.id);
    action(store, current.actor === 0 ? first : second,
      { op: "action", matchId: first.match.id, version: current.version, requestId: requestId(), action: { type: current.actor === 0 ? "fold" : "call" } });
    assert.ok(++steps < 150);
  }
  const final = store.get(first.match.id);
  assert.equal(final.outcome!.reason, "BANKRUPT");
  assert.deepEqual(final.gameView!.matchStacks, [0, 1000]);
  assert.ok((final.gameView!.handNumber as number) > 20);
  assert.equal(create(store, "holdem", "challenge", 100).match.config.hands, 100);
  errorCode(() => create(store, "holdem", "challenge", 101), "INVALID_HANDS");
});

test("asymmetric stacks conserve chips and replay across diverse legal betting paths", () => {
  let seed = 72349;
  const next = (modulo: number) => { seed = (seed * 48271) % 2147483647; return seed % modulo; };
  for (let sample = 0; sample < 100; sample++) {
    const stacks: [number, number] = [1 + next(500), 1 + next(500)];
    const total = stacks[0] + stacks[1];
    const hand = createHand({ initialStack: Math.max(10, ...stacks), initialStacks: stacks, smallBlind: 5, bigBlind: 10, button: next(2) as Seat });
    let actions = 0;
    while (hand.view(0).handStatus === "playing") {
      const view = hand.view(0);
      assert.equal(view.stacks[0] + view.stacks[1] + view.pot, total);
      const actor = view.actor!;
      const choices = hand.view(actor).legalActions;
      const choice = choices[next(choices.length)];
      const move: Action = choice.type === "raise" ? { type: "raise", to: choice.allInOnly ? choice.maxTo : choice.minTo + next(choice.maxTo - choice.minTo + 1) } : { type: choice.type };
      hand.act(actor, move); assert.ok(++actions < total + 20);
    }
    assert.equal(hand.view(0).result!.finalStacks.reduce((sum, stack) => sum + stack, 0), total);
    assert.deepEqual(replayHand(hand.exportTrustedReplay()).view(0), hand.view(0));
  }
});

test("waiting cancellation has no winner and does not count as a completed win or draw", () => {
  const store = new PlayStore();
  const owner = create(store, "holdem", "invite");
  errorCode(() => operation(store, owner, "resign"), "NOT_STARTED_USE_CANCEL");
  const done = store.command({ op: "cancel", matchId: owner.match.id, version: owner.match.version, requestId: requestId() }, owner.seatToken);
  assert.equal(done.match.status, "cancelled"); assert.equal(done.match.outcome, null); assert.equal(done.match.deadline, null);
  assert.equal(store.list().matches.length, 0); assert.equal(store.list().history[0].status, "cancelled");
});

test("Balatro spectator sees played-card scores, never current hand or discarded private cards", () => {
  const store = new PlayStore();
  const owner = create(store, "balatro"); operation(store, owner, "ready");
  const view = store.get(owner.match.id, owner.seatToken);
  const card = (view.gameView!.hand as string[])[0];
  action(store, owner, { op: "action", matchId: owner.match.id, version: view.version, requestId: requestId(), action: { type: "discard", cards: [card] } });
  const spectator = store.get(owner.match.id);
  assert.deepEqual(spectator.gameView!.hand, []);
  assert.deepEqual(spectator.logs.at(-1)!.action, { type: "discard", cards: [] });
  assert.deepEqual(store.get(owner.match.id, owner.seatToken).logs.at(-1)!.action, { type: "discard", cards: [card] });
});
