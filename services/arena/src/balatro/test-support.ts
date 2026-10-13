import { BalatroGame, type BalatroCard, type JokerId } from "./rules.js";

/** Trusted fixtures are never fields of a user/session request. */
export function createBalatroGameWithDeckForTest(deck: BalatroCard[], rewardOrder?: JokerId[]): BalatroGame {
  return new BalatroGame({ deckFactory: () => [...deck], ...(rewardOrder ? { rewardFactory: available => rewardOrder.filter(id => available.includes(id)).slice(0, 3) } : {}) });
}
