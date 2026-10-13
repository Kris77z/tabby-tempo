import { randomInt } from "node:crypto";

export type Rank = "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A";
export type Suit = "c" | "d" | "h" | "s";
export type Card = `${Rank}${Suit}`;
const ranks = "23456789TJQKA";
const suits = "cdhs";

export function orderedDeck(): Card[] {
  return [...suits].flatMap(suit => [...ranks].map(rank => `${rank}${suit}` as Card));
}

export function isCard(card: unknown): card is Card {
  return typeof card === "string" && card.length === 2 && ranks.includes(card[0]!) && suits.includes(card[1]!);
}

export function validateDeck(deck: unknown): Card[] {
  if (!Array.isArray(deck) || deck.length !== 52 || ![...deck].every(isCard) || new Set(deck).size !== 52) {
    throw new Error("INVALID_DECK: expected all 52 distinct cards");
  }
  return [...deck];
}

/** Unbiased Fisher–Yates shuffle using Node's cryptographic RNG. */
export function shuffledDeck(): Card[] {
  const deck = orderedDeck();
  for (let i = deck.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [deck[i], deck[j]] = [deck[j]!, deck[i]!];
  }
  return deck;
}

export function cardRank(card: Card): number {
  return ranks.indexOf(card[0]!) + 2;
}
