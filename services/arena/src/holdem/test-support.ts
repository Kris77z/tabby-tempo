// Controlled fixtures only. Production callers use createHand from index.ts.
import { makeTrustedHand, type HandConfig, type HoldemHand } from "./engine.js";
export { orderedDeck } from "./cards.js";
export function createHandWithDeckForTest(config: HandConfig, deck: unknown): HoldemHand {
  return makeTrustedHand(config, deck);
}
