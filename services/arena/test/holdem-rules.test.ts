import assert from "node:assert/strict";
import test from "node:test";
import { createHand, replayHand, type Action, type Card, type HandConfig, type HoldemHand, type Seat } from "../src/holdem/index.js";
import { createHandWithDeckForTest, orderedDeck } from "../src/holdem/test-support.js";

const config: HandConfig = { initialStack: 100, smallBlind: 1, bigBlind: 2 };
const top = ["Ac", "Kd", "Ah", "Kh", "2c", "3c", "4d", "5h", "6s", "7c", "8d", "9h"] as Card[];
const deck = (prefix = top) => [...prefix, ...orderedDeck().filter(card => !prefix.includes(card))];
const hand = (options: HandConfig = config, prefix?: Card[]) => createHandWithDeckForTest(options, deck(prefix));
function checkThrough(current: HoldemHand): void {
  while (current.view(0).handStatus === "playing") {
    const actor = current.view(0).actor!;
    const available = current.view(actor).legalActions;
    current.act(actor, { type: available.some(action => action.type === "check") ? "check" : "call" });
  }
}
function assertConserved(current: HoldemHand, stack: number): void {
  const view = current.view(0);
  assert.equal(view.stacks[0] + view.stacks[1] + view.pot, 2 * stack);
  for (const amount of [...view.stacks, ...view.streetCommitted, ...view.totalCommitted, view.pot]) assert.ok(Number.isSafeInteger(amount) && amount >= 0);
}

test("heads-up button is small blind, acts first preflop and last after flop; hole cards are dealt in order", () => {
  const current = hand();
  assert.deepEqual(current.view(0).holeCards, ["Kd", "Kh"]);
  assert.deepEqual(current.view(1).holeCards, ["Ac", "Ah"]);
  assert.equal(current.view(0).actor, 0);
  assert.deepEqual(current.view(0).stacks, [99, 98]);
  assert.deepEqual(current.view(0).streetCommitted, [1, 2]);
  assert.equal(current.view(0).pot, 3);
  current.act(0, { type: "call" });
  assert.equal(current.view(0).street, "preflop");
  assert.equal(current.view(0).actor, 1); // big blind retains its option
  current.act(1, { type: "check" });
  assert.equal(current.view(0).street, "flop");
  assert.equal(current.view(0).actor, 1);
  assert.deepEqual(current.view(0).streetCommitted, [0, 0]);
  assert.deepEqual(current.view(0).board, ["3c", "4d", "5h"]);
  current.act(1, { type: "check" });
  assert.equal(current.view(0).actor, 0);
  current.act(0, { type: "check" });
  assert.equal(current.view(0).street, "turn");
  assert.deepEqual(current.view(0).board, ["3c", "4d", "5h", "7c"]);
  current.act(1, { type: "check" }); current.act(0, { type: "check" });
  assert.equal(current.view(0).street, "river");
  assert.deepEqual(current.view(0).board, ["3c", "4d", "5h", "7c", "9h"]);
  current.act(1, { type: "check" }); current.act(0, { type: "check" });
  const view = current.view(0);
  assert.equal(view.handStatus, "complete");
  assert.deepEqual(view.result!.winners, [1]);
  assert.deepEqual(view.stacks, [98, 102]);
  assert.equal(view.actor, null);
  assert.equal(view.pot, 0);
  assertConserved(current, 100);
});

test("swapping button swaps blinds, preflop turn and later street turn", () => {
  const current = hand({ ...config, button: 1 });
  assert.deepEqual(current.view(0).stacks, [98, 99]);
  assert.deepEqual(current.view(0).holeCards, ["Ac", "Ah"]);
  assert.equal(current.view(0).actor, 1);
  current.act(1, { type: "call" }); current.act(0, { type: "check" });
  assert.equal(current.view(0).actor, 0);
});

test("preflop fold returns unmatched blind and does not reveal opponent cards", () => {
  const current = hand(); current.act(0, { type: "fold" });
  const view = current.view(0);
  assert.deepEqual(view.stacks, [99, 101]);
  assert.deepEqual(view.result!.refunds, [0, 1]);
  assert.deepEqual(view.result!.payouts, [0, 2]);
  assert.equal(view.result!.contestedPot, 2);
  assert.equal(view.result!.showdown, undefined);
  assert.deepEqual(view.board, []);
  assert.ok(!JSON.stringify(view).includes('"Ac"'));
  assertConserved(current, 100);
});

test("raise and fold refund all of the unmatched wager before awarding matched pot", () => {
  const current = hand(); current.act(0, { type: "raise", to: 10 }); current.act(1, { type: "fold" });
  assert.deepEqual(current.view(0).result, {
    reason: "fold", winners: [0], contestedPot: 4, payouts: [4, 0], refunds: [8, 0], finalStacks: [102, 98],
  });
  assert.deepEqual(current.view(0).totalCommitted, [2, 2]);
  assertConserved(current, 100);
});

test("minimum full raise tracks the last full increment; failed actions leave the state and journal intact", () => {
  const current = hand();
  for (const action of [{ type: "check" }, { type: "raise", to: 3 }, { type: "raise", to: 101 }, { type: "raise", to: 2 }] as Action[]) {
    const before = current.exportTrustedReplay();
    assert.throws(() => current.act(0, action));
    assert.deepEqual(current.exportTrustedReplay(), before);
  }
  current.act(0, { type: "raise", to: 4 });
  assert.deepEqual(current.view(1).legalActions.find(action => action.type === "raise"), { type: "raise", minTo: 6, maxTo: 100, allInOnly: false });
  assert.throws(() => current.act(1, { type: "raise", to: 5 }), /MINIMUM_RAISE/);
  current.act(1, { type: "raise", to: 8 });
  assert.equal(current.view(0).legalActions.find(action => action.type === "raise")?.minTo, 12);
  current.act(0, { type: "call" });
  assert.equal(current.view(0).street, "flop");
  assert.equal(current.view(1).legalActions.find(action => action.type === "raise")?.minTo, 2);
});

test("check followed by a full bet permits a raise and a raise/call closes the round", () => {
  const current = hand(); current.act(0, { type: "call" }); current.act(1, { type: "check" });
  current.act(1, { type: "check" }); current.act(0, { type: "raise", to: 2 });
  current.act(1, { type: "raise", to: 4 }); current.act(0, { type: "call" });
  assert.equal(current.view(0).street, "turn");
  assert.equal(current.view(0).pot, 12);
  assertConserved(current, 100);
});

test("short all-in is legal below minimum and cannot reopen betting", () => {
  const current = hand({ initialStack: 10, smallBlind: 1, bigBlind: 2 });
  current.act(0, { type: "raise", to: 8 });
  assert.deepEqual(current.view(1).legalActions.find(action => action.type === "raise"), { type: "raise", minTo: 14, maxTo: 10, allInOnly: true });
  assert.throws(() => current.act(1, { type: "raise", to: 9 }), /MINIMUM_RAISE/);
  current.act(1, { type: "all-in" });
  assert.equal(current.view(0).actor, 0);
  assert.ok(!current.view(0).legalActions.some(action => action.type === "raise"));
  assert.throws(() => current.act(0, { type: "raise", to: 10 }), /RAISE_NOT_OPEN/);
  current.act(0, { type: "call" });
  assert.equal(current.view(0).result!.contestedPot, 20);
  assert.equal(current.view(0).board.length, 5);
  assertConserved(current, 10);
});

test("folding to a short all-in refunds the unmatched short increment", () => {
  const current = hand({ initialStack: 10, smallBlind: 1, bigBlind: 2 });
  current.act(0, { type: "raise", to: 8 }); current.act(1, { type: "raise", to: 10 }); current.act(0, { type: "fold" });
  assert.deepEqual(current.view(0).stacks, [2, 18]);
  assert.deepEqual(current.view(0).result!.refunds, [0, 2]);
  assert.equal(current.view(0).result!.contestedPot, 16);
  assertConserved(current, 10);
});

test("all-in waits for call or fold, then runs out burned board without further player actions", () => {
  const current = hand(); current.act(0, { type: "all-in" });
  assert.equal(current.view(1).handStatus, "playing");
  assert.equal(current.view(1).actor, 1);
  assert.deepEqual(current.view(1).board, []);
  assert.equal(current.view(1).legalActions.find(action => action.type === "call")?.chips, 98);
  current.act(1, { type: "all-in" });
  assert.equal(current.view(0).handStatus, "complete");
  assert.deepEqual(current.view(0).board, ["3c", "4d", "5h", "7c", "9h"]);
  assert.deepEqual(current.view(0).result!.payouts, [0, 200]);
  assert.equal(current.exportTrustedReplay().actions.length, 2);
  assert.throws(() => current.act(0, { type: "check" }), /HAND_COMPLETE/);
  assertConserved(current, 100);
});

test("blind all-in gives the small blind a decision; both blind all-ins auto-runout", () => {
  const current = hand({ initialStack: 2, smallBlind: 1, bigBlind: 2 });
  assert.equal(current.view(0).actor, 0); current.act(0, { type: "call" });
  assert.equal(current.view(0).handStatus, "complete"); assertConserved(current, 2);
  const automatic = hand({ initialStack: 2, smallBlind: 2, bigBlind: 2 });
  assert.equal(automatic.view(0).handStatus, "complete");
  assert.equal(automatic.exportTrustedReplay().actions.length, 0);
  assertConserved(automatic, 2);
});

test("all-in on flop, turn and river completes with the right public board", () => {
  for (const target of ["flop", "turn", "river"] as const) {
    const current = hand(); current.act(0, { type: "call" }); current.act(1, { type: "check" });
    while (current.view(0).street !== target) { current.act(1, { type: "check" }); current.act(0, { type: "check" }); }
    current.act(1, { type: "all-in" }); current.act(0, { type: "call" });
    assert.equal(current.view(0).result!.reason, "showdown");
    assert.equal(current.view(0).result!.contestedPot, 200);
    assert.equal(current.view(0).board.length, 5);
    assertConserved(current, 100);
  }
});

test("board-only tie returns equal stacks and reveals both hands only at showdown", () => {
  const prefix = ["2c", "3c", "4d", "5d", "6h", "Ts", "Js", "Qs", "7h", "Ks", "8h", "As"] as Card[];
  const current = hand(config, prefix);
  assert.ok(!JSON.stringify(current.view(0)).includes('"2c"'));
  checkThrough(current);
  const result = current.view(0).result!;
  assert.deepEqual(result.winners, [0, 1]);
  assert.deepEqual(result.payouts, [2, 2]);
  assert.deepEqual(result.finalStacks, [100, 100]);
  assert.equal(result.showdown!.length, 2);
  assert.deepEqual(result.showdown![0].rank.score, [8, 14]);
});

test("view and trusted replay are detached copies; serialization of the hand reveals no private state", () => {
  const current = hand();
  const view = current.view(0); const journal = current.exportTrustedReplay();
  assert.ok(!("deck" in view)); assert.ok(!("actions" in view));
  assert.deepEqual(current.view(1).legalActions, []);
  assert.ok(!JSON.stringify(view).includes('"Ac"'));
  assert.ok(!JSON.stringify(view).includes('"3c"'));
  assert.equal(JSON.stringify(current), "{}");
  view.stacks[0] = 0; view.holeCards[0] = "2s"; view.board.push("3s"); journal.deck[0] = "2s"; journal.config.initialStack = 7;
  assert.deepEqual(current.view(0).stacks, [99, 98]);
  assert.deepEqual(current.view(0).holeCards, ["Kd", "Kh"]);
  assert.deepEqual(current.view(0).board, []);
  assert.equal(current.exportTrustedReplay().deck[0], "Ac");
  checkThrough(current);
  const result = current.view(0).result!; result.payouts[0] = 999; result.showdown![1].holeCards[0] = "2s";
  assert.equal(current.view(0).result!.payouts[0], 0);
  assert.equal(current.view(0).result!.showdown![1].holeCards[0], "Ac");
});

test("trusted JSON journal restores an in-progress hand and a terminal hand exactly", () => {
  const current = hand(); current.act(0, { type: "raise", to: 6 });
  const restored = replayHand(JSON.parse(JSON.stringify(current.exportTrustedReplay())));
  assert.deepEqual(restored.view(0), current.view(0)); assert.deepEqual(restored.view(1), current.view(1));
  checkThrough(current); checkThrough(restored);
  assert.deepEqual(restored.view(0), current.view(0));
  assert.deepEqual(replayHand(current.exportTrustedReplay()).view(1), current.view(1));
});

test("malformed config/deck/replay/actions reject without production deck injection", () => {
  for (const options of [
    { ...config, initialStack: 1 }, { ...config, initialStack: 1.5 }, { ...config, initialStack: Number.MAX_SAFE_INTEGER },
    { ...config, smallBlind: 0 }, { ...config, smallBlind: 3 }, { ...config, bigBlind: Infinity }, { ...config, button: 2 }, { ...config, button: null },
    { ...config, deck: deck() },
  ]) assert.throws(() => createHand(options as HandConfig), /INVALID/);
  assert.throws(() => createHandWithDeckForTest(config, deck().slice(1)), /INVALID_DECK/);
  const duplicate = deck(); duplicate[0] = duplicate[1]!;
  assert.throws(() => createHandWithDeckForTest(config, duplicate), /INVALID_DECK/);
  const sparse = deck(); delete sparse[0];
  assert.throws(() => createHandWithDeckForTest(config, sparse), /INVALID_DECK/);
  const current = hand();
  assert.throws(() => current.act(1, { type: "fold" }), /OUT_OF_TURN/);
  assert.throws(() => current.view(2 as Seat), /INVALID_SEAT/);
  for (const action of [{ type: "raise", to: NaN }, { type: "raise", to: 4.5 }, { type: "call", extra: true }, { type: "cheat" }]) {
    assert.throws(() => current.act(0, action as Action), /INVALID_ACTION/);
  }
  assert.throws(() => replayHand({ ...current.exportTrustedReplay(), version: 2 }), /INVALID_REPLAY/);
  assert.throws(() => replayHand({ ...current.exportTrustedReplay(), actions: [{ seat: 1, action: { type: "call" } }] }), /OUT_OF_TURN/);
  assert.throws(() => replayHand({ ...current.exportTrustedReplay(), result: { winners: [0] } }), /INVALID_REPLAY/);
  assert.throws(() => replayHand({ ...current.exportTrustedReplay(), actions: [{ seat: 0, action: { type: "raise", to: 3 } }] }), /MINIMUM_RAISE/);
});

test("production shuffled decks have 52 distinct valid cards and do not repeat across samples", () => {
  const journals = Array.from({ length: 8 }, () => createHand(config).exportTrustedReplay());
  for (const journal of journals) assert.deepEqual([...journal.deck].sort(), orderedDeck().sort());
  assert.equal(new Set(journals.map(journal => journal.deck.join(","))).size, journals.length);
});

test("hundreds of legal-action paths conserve chips and replay identically", () => {
  let seed = 7291;
  const next = (modulo: number) => { seed = (seed * 48271) % 2147483647; return seed % modulo; };
  for (let game = 0; game < 250; game++) {
    const initialStack = 2 + next(199);
    const current = hand({ initialStack, smallBlind: 1, bigBlind: 2, button: next(2) as Seat });
    let steps = 0;
    while (current.view(0).handStatus === "playing") {
      assertConserved(current, initialStack);
      const actor = current.view(0).actor!;
      const options = current.view(actor).legalActions;
      const chosen = options[next(options.length)]!;
      const action: Action = chosen.type === "raise"
        ? { type: "raise", to: chosen.allInOnly ? chosen.maxTo : chosen.minTo + next(chosen.maxTo - chosen.minTo + 1) }
        : { type: chosen.type };
      current.act(actor, action);
      assert.ok(++steps <= 2 * initialStack + 8, "betting must terminate");
    }
    assertConserved(current, initialStack);
    assert.deepEqual(replayHand(current.exportTrustedReplay()).view(0), current.view(0));
  }
});
