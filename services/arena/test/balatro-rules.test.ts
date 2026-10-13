import assert from "node:assert/strict";
import test from "node:test";
import { BALATRO_JOKERS, BALATRO_TARGETS, createBalatroGame, orderedBalatroDeck, scoreBalatroHand, type BalatroAction, type BalatroCard, type HandType, type JokerId } from "../src/balatro/game.js";
import { createBalatroGameWithDeckForTest } from "../src/balatro/test-support.js";

const prefixDeck = (prefix: BalatroCard[]) => [...prefix, ...orderedBalatroDeck().filter(card => !prefix.includes(card))];
const royal = ["AS", "KS", "QS", "JS", "TS"] as BalatroCard[];
const rewardOrder = BALATRO_JOKERS.map(joker => joker.id);
const royalGame = () => createBalatroGameWithDeckForTest(prefixDeck(royal), rewardOrder);

test("all nine hand types score only their constituent cards, including wheel and no wraparound", () => {
  const cases: [BalatroCard[], HandType, number, number, number][] = [
    [["AS", "KD", "2C"], "high_card", 1, 16, 1],
    [["AS", "AH", "KD"], "pair", 2, 32, 2],
    [["KS", "KH", "2D", "2C", "AS"], "two_pair", 4, 44, 2],
    [["3S", "3H", "3D", "AS"], "three_of_a_kind", 3, 39, 3],
    [["AS", "2H", "3D", "4C", "5S"], "straight", 5, 55, 4],
    [["2H", "4H", "6H", "9H", "KH"], "flush", 5, 66, 4],
    [["AS", "AH", "AD", "2S", "2H"], "full_house", 5, 77, 4],
    [["QS", "QH", "QD", "QC", "AS"], "four_of_a_kind", 4, 100, 7],
    [royal, "straight_flush", 5, 151, 8],
  ];
  for (const [cards, type, count, chips, mult] of cases) {
    const score = scoreBalatroHand(cards);
    assert.equal(score.handType, type); assert.equal(score.scoringCards.length, count);
    assert.equal(score.chips, chips); assert.equal(score.mult, mult); assert.equal(score.score, chips * mult);
  }
  assert.equal(scoreBalatroHand(["QS", "KH", "AD", "2C", "3S"]).handType, "high_card");
  assert.equal(scoreBalatroHand(["AH", "2H", "3H", "4H", "5H"]).handType, "straight_flush");
});

test("joker effects match reference, operate only on scoring cards and add before multiplying", () => {
  const pair = ["KS", "KC", "AH"] as BalatroCard[];
  assert.equal(scoreBalatroHand(pair, ["pair"]).mult, 10);
  assert.equal(scoreBalatroHand(pair, ["red"]).mult, 2); // red kicker is not counted
  assert.equal(scoreBalatroHand(pair, ["faces"]).chips, 90); // only the two kings
  assert.equal(scoreBalatroHand(["2S"], ["chips"]).chips, 57);
  assert.equal(scoreBalatroHand(royal, ["flush"]).mult, 18);
  assert.equal(scoreBalatroHand(royal, ["straight"]).mult, 20);
  assert.equal(scoreBalatroHand(["AH", "AD"], ["red"]).mult, 8);
  const context = ["amplifier", "spark", "last", "chips", "pair"] as JokerId[];
  const result = scoreBalatroHand(["AS", "AH"], context, 1);
  assert.equal(result.chips, 82); assert.equal(result.mult, (2 + 4 + 8) * 1.5 * 2); assert.equal(result.score, 3444);
  assert.equal(scoreBalatroHand(["AS", "AH"], [...context].reverse(), 1).score, result.score);
  assert.equal(scoreBalatroHand(["AS", "AH"], ["last"], 2).mult, 2);
  assert.equal(scoreBalatroHand(["2S"], ["amplifier"]).score, 10); // floor 7 × 1.5
  assert.equal(scoreBalatroHand(["AS", "AH"], [], 4, { pair: 4 }).score, 385);
});

test("standard fresh deck starts eight cards with no jokers and player-only actions", () => {
  const game = createBalatroGame(), view = game.view(0);
  assert.equal(view.rules, "arena-balatro-v2"); assert.equal(view.hand.length, 8); assert.equal(new Set(view.hand).size, 8);
  assert.equal(view.deckRemaining, 44); assert.deepEqual(view.jokers, []); assert.equal(view.handsLeft, 4); assert.equal(view.discardsLeft, 3);
  assert.deepEqual(view.targets, BALATRO_TARGETS); assert.deepEqual(view.legalActions, ["play", "discard"]);
  assert.equal(game.actor(), 0); assert.deepEqual(game.view(1).hand, []); assert.deepEqual(game.view(null).hand, []);
  assert.deepEqual(game.view(null).legalActions, []); assert.equal(JSON.stringify(game), "{}");
  assert.ok(!("deck" in view)); assert.throws(() => game.act(1, { type: "play", cards: [view.hand[0]!] }), /OUT_OF_TURN/);
  const privateCard = view.hand[0]!; view.hand[0] = "2S"; view.handLevels.pair = 999;
  assert.equal(game.view(0).hand[0], privateCard); assert.equal(game.view(0).handLevels.pair, 1);
});

test("discard replenishes only from undealt cards and does not consume hands", () => {
  const game = royalGame(), initial = game.view(0).hand;
  game.act(0, { type: "discard", cards: initial.slice(0, 5) });
  const after = game.view(0); assert.equal(after.hand.length, 8); assert.equal(after.deckRemaining, 39); assert.equal(after.discardsLeft, 2); assert.equal(after.handsLeft, 4);
  assert.ok(initial.slice(0, 5).every(card => !after.hand.includes(card))); assert.deepEqual(after.hand.slice(0, 3), initial.slice(5));
  game.act(0, { type: "discard", cards: after.hand.slice(0, 5) }); game.act(0, { type: "discard", cards: game.view(0).hand.slice(0, 5) });
  const before = game.view(0); assert.throws(() => game.act(0, { type: "discard", cards: [before.hand[0]!] }), /NO_DISCARDS_LEFT/);
  assert.deepEqual(game.view(0), before); assert.deepEqual(before.legalActions, ["play"]);
});

test("passing a blind offers three unowned rewards; skipping still upgrades one type and refreshes resources", () => {
  const game = royalGame(); game.act(0, { type: "play", cards: royal });
  const reward = game.view(0); assert.equal(reward.phase, "reward"); assert.equal(reward.cleared, 1); assert.equal(reward.handsLeft, 3);
  assert.equal(reward.rewardChoices.length, 3); assert.equal(new Set(reward.rewardChoices.map(joker => joker.id)).size, 3);
  assert.equal(reward.totalScore, 1208); assert.deepEqual(reward.legalActions, ["choose_joker", "skip_reward"]);
  assert.throws(() => game.act(0, { type: "play", cards: [reward.hand[0]!] }), /REWARD_REQUIRED/);
  game.act(0, { type: "skip_reward", upgradeHand: "pair" });
  const next = game.view(0); assert.equal(next.round, 2); assert.equal(next.target, 450); assert.equal(next.handLevels.pair, 4);
  assert.equal(next.handLevels.straight_flush, 1); assert.deepEqual(next.jokers, []); assert.equal(next.roundScore, 0); assert.equal(next.totalScore, 1208);
  assert.equal(next.handsLeft, 4); assert.equal(next.discardsLeft, 3); assert.equal(next.deckRemaining, 44); assert.deepEqual(next.hand.slice(0, 5), royal);
});

test("five joker slots require valid replacement; levels/jokers persist and all twelve blinds can be won", () => {
  const game = royalGame();
  for (let round = 1; round <= 12; round++) {
    assert.equal(game.view(0).round, round); assert.equal(game.view(0).ante, Math.ceil(round / 3));
    game.act(0, { type: "play", cards: royal });
    assert.equal(game.view(0).cleared, round);
    if (round === 12) break;
    const reward = game.view(0); assert.equal(reward.phase, "reward");
    assert.ok(reward.rewardChoices.every(choice => !reward.jokers.some(joker => joker.id === choice.id)));
    const chosen = reward.rewardChoices[0]!.id;
    if (reward.jokers.length === 5) {
      const before = game.view(0);
      assert.throws(() => game.act(0, { type: "choose_joker", jokerId: chosen }), /JOKER_REPLACEMENT_REQUIRED/);
      assert.deepEqual(game.view(0), before);
      game.act(0, { type: "choose_joker", jokerId: chosen, replaceJokerId: reward.jokers[0]!.id });
    } else game.act(0, { type: "choose_joker", jokerId: chosen });
    assert.equal(game.view(0).handLevels.straight_flush, 1 + round * 3);
    assert.ok(game.view(0).jokers.length <= 5);
  }
  const final = game.view(0); assert.equal(final.phase, "complete"); assert.equal(final.cleared, 12); assert.equal(final.history.length, 12);
  assert.deepEqual(game.outcome(), { kind: "win", winner: 0, reason: "all_blinds_cleared" });
  assert.deepEqual(final.legalActions, []); assert.equal(game.actor(), null); assert.equal(game.botAction(), null);
  assert.throws(() => game.act(0, { type: "skip_reward" }), /GAME_COMPLETE/);
});

test("four low-scoring hands lose and failure rejects further action", () => {
  const game = createBalatroGameWithDeckForTest(orderedBalatroDeck());
  for (let hand = 0; hand < 4; hand++) game.act(0, { type: "play", cards: [game.view(0).hand[0]!] });
  assert.deepEqual(game.outcome(), { kind: "win", winner: 1, reason: "hands_exhausted" });
  assert.equal(game.view(0).cleared, 0); assert.equal(game.view(0).handsLeft, 0); assert.equal(game.view(0).history.length, 4);
});

test("invalid cards, scoring contexts and actions reject atomically", () => {
  for (const cards of [[], ["AS", "AS"], ["as"], ["AS", "KS", "QS", "JS", "TS", "9S"], new Array(2)] as BalatroCard[][]) assert.throws(() => scoreBalatroHand(cards));
  assert.throws(() => scoreBalatroHand(["AS"], ["unknown"] as unknown as JokerId[]), /INVALID_SCORE_CONTEXT/);
  assert.throws(() => scoreBalatroHand(["AS"], ["spark", "spark"]), /INVALID_SCORE_CONTEXT/);
  assert.throws(() => scoreBalatroHand(["AS"], [], 0), /INVALID_SCORE_CONTEXT/);
  assert.throws(() => scoreBalatroHand(["AS"], [], 4, { pair: 35 }), /INVALID_SCORE_CONTEXT/);
  const game = royalGame(), before = game.view(0);
  for (const action of [{ type: "play", cards: ["2H"] }, { type: "play", cards: [] }, { type: "play", cards: ["AS"], score: 999 }, { type: "skip_reward" }, { type: "cheat" }]) {
    assert.throws(() => game.act(0, action as BalatroAction)); assert.deepEqual(game.view(0), before);
  }
  game.act(0, { type: "play", cards: royal }); const reward = game.view(0);
  for (const action of [{ type: "choose_joker", jokerId: "last" }, { type: "choose_joker", jokerId: reward.rewardChoices[0]!.id, replaceJokerId: "spark" }, { type: "skip_reward", upgradeHand: "invalid" }, { type: "skip_reward", jokerId: "spark" }]) {
    assert.throws(() => game.act(0, action as BalatroAction)); assert.deepEqual(game.view(0), reward);
  }
});

test("local hint scores only visible cards and never mutates the state", () => {
  const game = royalGame(), before = game.view(0), hint = game.botAction()!;
  assert.equal(hint.type, "play"); if (hint.type === "play") assert.deepEqual(new Set(hint.cards), new Set(royal));
  assert.deepEqual(game.view(0), before); game.act(0, hint);
  const reward = game.view(0), rewardHint = game.botAction()!; assert.equal(rewardHint.type, "choose_joker");
  assert.deepEqual(game.view(0), reward); game.act(0, rewardHint); assert.equal(game.view(0).round, 2);
});
