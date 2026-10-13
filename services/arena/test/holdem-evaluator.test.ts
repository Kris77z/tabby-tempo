import assert from "node:assert/strict";
import test from "node:test";
import { compareHandRanks, evaluateBestHand, HAND_CATEGORIES, splitPot, type Card } from "../src/holdem/index.js";

const cards = (input: string): Card[] => input.split(" ") as Card[];
const rank = (input: string) => evaluateBestHand(cards(input));

test("all nine categories rank in order; kickers and suits obey poker ordering", () => {
  const examples = [
    "As Kd Qh 9c 3s", "As Ad Qh 9c 3s", "As Ad Qh Qc 3s", "As Ad Ah 9c 3s",
    "9s 8d 7h 6c 5s", "As Js 9s 6s 3s", "As Ad Ah 9c 9s", "As Ad Ah Ac 3s", "9s 8s 7s 6s 5s",
  ].map(rank);
  assert.deepEqual(examples.map(example => example.category), HAND_CATEGORIES);
  for (let i = 1; i < examples.length; i++) assert.equal(compareHandRanks(examples[i]!, examples[i - 1]!), 1);
  assert.equal(compareHandRanks(rank("As Ad Kh 9c 3s"), rank("Ah Ac Qh Jc Ts")), 1);
  assert.equal(compareHandRanks(rank("As Ad Kh 9c 3s"), rank("Ah Ac Kd 9s 3c")), 0);
});

test("ace-low wheel is five-high, including a wheel straight flush", () => {
  assert.deepEqual(rank("As 2d 3h 4c 5s Kd Qh").score, [4, 5]);
  assert.equal(compareHandRanks(rank("2s 3d 4h 5c 6s"), rank("As 2d 3h 4c 5s")), 1);
  assert.deepEqual(rank("As 2s 3s 4s 5s Kd Qh").score, [8, 5]);
  assert.equal(rank("As Kd Qh Jc 2s").category, "high-card");
});

test("seven choose five finds double-trip full house and the highest pair/kickers", () => {
  assert.deepEqual(rank("As Ad Ah Ks Kd Kh 2c").score, [6, 14, 13]);
  assert.deepEqual(rank("As Ad Kh Kc Qs Qd 2c").score, [2, 14, 13, 12]);
  assert.deepEqual(rank("As Ad Kh Qc Js 9d 2c").score, [1, 14, 13, 12, 11]);
  assert.deepEqual(rank("As Ad Ah Ac Ks Qd 2c").score, [7, 14, 13]);
});

test("best flush uses five highest cards and a board-only royal flush ties", () => {
  assert.deepEqual(rank("As Qs 9s 8s 7s 3s 2d").score, [5, 14, 12, 9, 8, 7]);
  const board = "Ts Js Qs Ks As";
  assert.equal(compareHandRanks(rank(`2c 3d ${board}`), rank(`4c 5d ${board}`)), 0);
  assert.equal(rank(`2c 3d ${board}`).bestFive.length, 5);
});

test("evaluator rejects duplicates, malformed cards and wrong hand lengths", () => {
  for (const input of ["As As 3h 4c 5s", "1s 2d 3h 4c 5s", "AS 2d 3h 4c 5s", "As 2d 3h 4c", "As 2d 3h 4c 5s 6d 7h 8c"]) {
    assert.throws(() => rank(input), /INVALID_HAND/);
  }
  const sparse = cards("As 2d 3h 4c 5s");
  delete sparse[0];
  assert.throws(() => evaluateBestHand(sparse), /INVALID_HAND/);
});

test("ties split evenly; an odd chip goes left of button independently of winner order", () => {
  assert.deepEqual(splitPot(8, [0, 1], 0), [4, 4]);
  assert.deepEqual(splitPot(9, [1, 0], 0), [4, 5]);
  assert.deepEqual(splitPot(9, [0, 1], 1), [5, 4]);
  assert.deepEqual(splitPot(9, [0], 1), [9, 0]);
  assert.deepEqual(splitPot(0, [0, 1], 0), [0, 0]);
  for (const winners of [[], [0, 0], [2]]) assert.throws(() => splitPot(9, winners as (0 | 1)[], 0), /INVALID/);
  assert.throws(() => splitPot(1.5, [0], 0), /INVALID/);
});
