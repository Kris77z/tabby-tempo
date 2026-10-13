import { cardRank, isCard, type Card } from "./cards.js";

export const HAND_CATEGORIES = ["high-card", "one-pair", "two-pair", "three-of-a-kind", "straight", "flush", "full-house", "four-of-a-kind", "straight-flush"] as const;
export interface HandRank {
  category: typeof HAND_CATEGORIES[number];
  /** Lexicographic order, larger is stronger; suits never break ties. */
  score: number[];
  bestFive: Card[];
}

export function compareHandRanks(left: HandRank, right: HandRank): -1 | 0 | 1 {
  for (let i = 0; i < Math.max(left.score.length, right.score.length); i++) {
    const delta = (left.score[i] ?? 0) - (right.score[i] ?? 0);
    if (delta !== 0) return delta > 0 ? 1 : -1;
  }
  return 0;
}

function rankFive(cards: Card[]): HandRank {
  const values = cards.map(cardRank).sort((a, b) => b - a);
  const counts = new Map<number, number>();
  for (const value of values) counts.set(value, (counts.get(value) ?? 0) + 1);
  const groups = [...counts].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const unique = [...counts.keys()].sort((a, b) => b - a);
  const straight = unique.length === 5 && unique[0]! - unique[4]! === 4 ? unique[0]!
    : unique.join(",") === "14,5,4,3,2" ? 5 : 0;
  const flush = cards.every(card => card[1] === cards[0]![1]);
  let score: number[];
  if (flush && straight) score = [8, straight];
  else if (groups[0]![1] === 4) score = [7, groups[0]![0], groups[1]![0]];
  else if (groups[0]![1] === 3 && groups[1]![1] === 2) score = [6, groups[0]![0], groups[1]![0]];
  else if (flush) score = [5, ...values];
  else if (straight) score = [4, straight];
  else if (groups[0]![1] === 3) score = [3, groups[0]![0], ...groups.slice(1).map(group => group[0])];
  else if (groups[0]![1] === 2 && groups[1]![1] === 2) score = [2, groups[0]![0], groups[1]![0], groups[2]![0]];
  else if (groups[0]![1] === 2) score = [1, groups[0]![0], ...groups.slice(1).map(group => group[0])];
  else score = [0, ...values];
  return { category: HAND_CATEGORIES[score[0]!]!, score, bestFive: [...cards] };
}

/** Enumerates every five-card subset, including board-only hands and the ace-low wheel. */
export function evaluateBestHand(cards: readonly Card[]): HandRank {
  if (!Array.isArray(cards) || cards.length < 5 || cards.length > 7 || ![...cards].every(isCard) || new Set(cards).size !== cards.length) {
    throw new Error("INVALID_HAND: expected 5 to 7 distinct cards");
  }
  let best: HandRank | undefined;
  for (let a = 0; a < cards.length - 4; a++)
    for (let b = a + 1; b < cards.length - 3; b++)
      for (let c = b + 1; c < cards.length - 2; c++)
        for (let d = c + 1; d < cards.length - 1; d++)
          for (let e = d + 1; e < cards.length; e++) {
            const rank = rankFive([cards[a]!, cards[b]!, cards[c]!, cards[d]!, cards[e]!]);
            if (!best || compareHandRanks(rank, best) > 0) best = rank;
          }
  return best!;
}
