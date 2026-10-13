import { randomInt } from "node:crypto";

export const BALATRO_RULES = "arena-balatro-v2" as const;
export const BALATRO_TARGETS = Object.freeze([300, 450, 600, 2000, 3000, 4000, 11000, 16500, 22000, 50000, 75000, 100000]);
export type BalatroCard = `${"2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "T" | "J" | "Q" | "K" | "A"}${"S" | "H" | "D" | "C"}`;
export type HandType = "high_card" | "pair" | "two_pair" | "three_of_a_kind" | "straight" | "flush" | "full_house" | "four_of_a_kind" | "straight_flush";
export type HandLevels = Record<HandType, number>;
export type JokerId = "spark" | "chips" | "pair" | "flush" | "red" | "faces" | "straight" | "amplifier" | "last";
export interface BalatroJoker { id: JokerId; name: string; description: string }
export interface BalatroScore {
  handType: HandType; handName: string; playedCards: BalatroCard[]; scoringCards: BalatroCard[];
  chips: number; mult: number; score: number; effects: string[];
}
export type BalatroAction =
  | { type: "play" | "discard"; cards: string[] }
  | { type: "choose_joker"; jokerId: string; replaceJokerId?: string; upgradeHand?: HandType }
  | { type: "skip_reward"; upgradeHand?: HandType };
export interface BalatroOutcome { kind: "win"; winner: 0 | 1; reason: "all_blinds_cleared" | "hands_exhausted" }
export interface BalatroView {
  rules: typeof BALATRO_RULES; phase: "playing" | "reward" | "complete"; round: number; ante: number;
  blind: "small" | "big" | "boss"; antes: 4; rounds: 12; targets: number[]; target: number;
  roundScore: number; totalScore: number; cleared: number; handsLeft: number; discardsLeft: number;
  hand: BalatroCard[]; deckRemaining: number; jokers: BalatroJoker[]; jokerSlots: 5;
  rewardChoices: BalatroJoker[]; rewardUpgradeLevels: 3; handLevels: HandLevels;
  lastScore: BalatroScore | null; history: (BalatroScore & { round: number })[];
  legalActions: BalatroAction["type"][]; result: BalatroOutcome | null;
}
export class BalatroRuleError extends Error {
  constructor(public readonly code: string) { super(code); this.name = "BalatroRuleError"; }
}
interface HandValue { name: string; chips: number; mult: number; levelChips: number; levelMult: number }
// Source: https://token.jiqiren.ai/skills/games/balatro.md, checked 2026-10-04.
export const BALATRO_HANDS: Readonly<Record<HandType, Readonly<HandValue>>> = Object.freeze({
  high_card: Object.freeze({ name: "高牌", chips: 5, mult: 1, levelChips: 10, levelMult: 1 }),
  pair: Object.freeze({ name: "对子", chips: 10, mult: 2, levelChips: 15, levelMult: 1 }),
  two_pair: Object.freeze({ name: "两对", chips: 20, mult: 2, levelChips: 20, levelMult: 1 }),
  three_of_a_kind: Object.freeze({ name: "三条", chips: 30, mult: 3, levelChips: 20, levelMult: 2 }),
  straight: Object.freeze({ name: "顺子", chips: 30, mult: 4, levelChips: 30, levelMult: 3 }),
  flush: Object.freeze({ name: "同花", chips: 35, mult: 4, levelChips: 15, levelMult: 2 }),
  full_house: Object.freeze({ name: "葫芦", chips: 40, mult: 4, levelChips: 25, levelMult: 2 }),
  four_of_a_kind: Object.freeze({ name: "四条", chips: 60, mult: 7, levelChips: 30, levelMult: 3 }),
  straight_flush: Object.freeze({ name: "同花顺", chips: 100, mult: 8, levelChips: 40, levelMult: 4 }),
});
export const BALATRO_JOKERS: readonly Readonly<BalatroJoker>[] = Object.freeze([
  { id: "spark", name: "开场小丑", description: "每手增加 4 倍率" },
  { id: "chips", name: "筹码工匠", description: "每手增加 50 筹码" },
  { id: "pair", name: "成双", description: "打出的牌含重复点数：增加 8 倍率" },
  { id: "flush", name: "同色派对", description: "同花及同花顺增加 10 倍率" },
  { id: "red", name: "红色信号", description: "每张计分红牌增加 3 倍率" },
  { id: "faces", name: "皇家工匠", description: "每张计分 J、Q、K 增加 30 筹码" },
  { id: "straight", name: "一路顺风", description: "顺子及同花顺增加 12 倍率" },
  { id: "amplifier", name: "放大镜", description: "完成加法后将倍率乘以 1.5" },
  { id: "last", name: "压轴", description: "每关最后一次出牌将倍率乘以 2" },
].map(joker => Object.freeze(joker as BalatroJoker)));
const ranks = "23456789TJQKA";
const handTypes = Object.keys(BALATRO_HANDS) as HandType[];
const jokerIds = BALATRO_JOKERS.map(joker => joker.id);
export function isBalatroCard(card: unknown): card is BalatroCard { return typeof card === "string" && /^[2-9TJQKA][SHDC]$/.test(card); }
function rank(card: BalatroCard): number { return ranks.indexOf(card[0]!) + 2; }
function cardChips(card: BalatroCard): number { return rank(card) === 14 ? 11 : Math.min(rank(card), 10); }
function validateCards(cards: unknown): asserts cards is BalatroCard[] {
  if (!Array.isArray(cards) || cards.length < 1 || cards.length > 5 || new Set(cards).size !== cards.length || ![...cards].every(isBalatroCard)) throw new BalatroRuleError("INVALID_CARDS");
}
function isHandType(value: unknown): value is HandType { return typeof value === "string" && Object.hasOwn(BALATRO_HANDS, value); }
function initialLevels(): HandLevels { return Object.fromEntries(handTypes.map(type => [type, 1])) as HandLevels; }
export function orderedBalatroDeck(): BalatroCard[] { return [..."SHDC"].flatMap(suit => [...ranks].map(value => `${value}${suit}` as BalatroCard)); }
function validateDeck(deck: BalatroCard[]): BalatroCard[] {
  if (!Array.isArray(deck) || deck.length !== 52 || new Set(deck).size !== 52 || ![...deck].every(isBalatroCard)) throw new BalatroRuleError("INVALID_DECK");
  return [...deck];
}
function shuffled<T>(items: readonly T[]): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) { const j = randomInt(i + 1); [result[i], result[j]] = [result[j]!, result[i]!]; }
  return result;
}

/** Card selection and score calculation contain no hidden-deck information. */
export function scoreBalatroHand(cards: BalatroCard[], jokers: JokerId[] = [], handsLeft = 4, levels: Partial<HandLevels> = {}): BalatroScore {
  validateCards(cards);
  if (!Array.isArray(jokers) || jokers.length > 5 || new Set(jokers).size !== jokers.length || ![...jokers].every(id => jokerIds.includes(id)) ||
    !Number.isInteger(handsLeft) || handsLeft < 1 || handsLeft > 4 || !levels || typeof levels !== "object" || Array.isArray(levels) ||
    Object.entries(levels).some(([type, level]) => !isHandType(type) || !Number.isInteger(level) || level < 1 || level > 34)) throw new BalatroRuleError("INVALID_SCORE_CONTEXT");
  const sorted = [...cards].sort((a, b) => rank(b) - rank(a));
  const groups = [...new Set(sorted.map(rank))].map(value => sorted.filter(card => rank(card) === value))
    .sort((a, b) => b.length - a.length || rank(b[0]!) - rank(a[0]!));
  const distinctRanks = [...new Set(sorted.map(rank))];
  const straight = cards.length === 5 && distinctRanks.length === 5 && (distinctRanks[0]! - distinctRanks[4]! === 4 || distinctRanks.join(",") === "14,5,4,3,2");
  const flush = cards.length === 5 && cards.every(card => card[1] === cards[0]![1]);
  let handType: HandType, scoringCards: BalatroCard[];
  if (straight && flush) { handType = "straight_flush"; scoringCards = sorted; }
  else if (groups[0]!.length === 4) { handType = "four_of_a_kind"; scoringCards = groups[0]!; }
  else if (groups[0]!.length === 3 && groups[1]?.length === 2) { handType = "full_house"; scoringCards = sorted; }
  else if (flush) { handType = "flush"; scoringCards = sorted; }
  else if (straight) { handType = "straight"; scoringCards = sorted; }
  else if (groups[0]!.length === 3) { handType = "three_of_a_kind"; scoringCards = groups[0]!; }
  else if (groups[0]!.length === 2 && groups[1]?.length === 2) { handType = "two_pair"; scoringCards = [...groups[0]!, ...groups[1]!]; }
  else if (groups[0]!.length === 2) { handType = "pair"; scoringCards = groups[0]!; }
  else { handType = "high_card"; scoringCards = [sorted[0]!]; }
  const value = BALATRO_HANDS[handType], level = levels[handType] ?? 1;
  let chips = value.chips + value.levelChips * (level - 1) + scoringCards.reduce((sum, card) => sum + cardChips(card), 0);
  let mult = value.mult + value.levelMult * (level - 1), multiplier = 1;
  const effects: string[] = [], multipliedEffects: string[] = [];
  if (level > 1) effects.push(`${value.name} Lv.${level}`);
  for (const id of jokers) {
    let addChips = 0, addMult = 0, factor = 1;
    switch (id) {
      case "spark": addMult = 4; break;
      case "chips": addChips = 50; break;
      case "pair": if (groups.some(group => group.length >= 2)) addMult = 8; break;
      case "flush": if (flush) addMult = 10; break;
      case "red": addMult = scoringCards.filter(card => card[1] === "H" || card[1] === "D").length * 3; break;
      case "faces": addChips = scoringCards.filter(card => "JQK".includes(card[0])).length * 30; break;
      case "straight": if (straight) addMult = 12; break;
      case "amplifier": factor = 1.5; break;
      case "last": if (handsLeft === 1) factor = 2; break;
    }
    chips += addChips; mult += addMult; multiplier *= factor;
    const name = BALATRO_JOKERS.find(joker => joker.id === id)!.name;
    if (addChips) effects.push(`${name} +${addChips} 筹码`);
    if (addMult) effects.push(`${name} +${addMult} 倍率`);
    if (factor !== 1) multipliedEffects.push(`${name} ×${factor} 倍率`);
  }
  mult *= multiplier;
  return { handType, handName: value.name, playedCards: [...cards], scoringCards: [...scoringCards], chips, mult, score: Math.floor(chips * mult), effects: [...effects, ...multipliedEffects] };
}

interface TrustedFixtures { deckFactory?: () => BalatroCard[]; rewardFactory?: (available: JokerId[]) => JokerId[] }
/** Private decks stay in this referee; factories are trusted fixtures, never client request fields. */
export class BalatroGame {
  #deckFactory: () => BalatroCard[];
  #rewardFactory: (available: JokerId[]) => JokerId[];
  #deck: BalatroCard[] = [];
  #hand: BalatroCard[] = [];
  #jokers: JokerId[] = [];
  #rewardChoices: JokerId[] = [];
  #levels = initialLevels();
  #round = 1;
  #roundScore = 0;
  #totalScore = 0;
  #cleared = 0;
  #handsLeft = 4;
  #discardsLeft = 3;
  #phase: BalatroView["phase"] = "playing";
  #lastScore: BalatroScore | null = null;
  #history: (BalatroScore & { round: number })[] = [];
  #result: BalatroOutcome | null = null;
  constructor(fixtures: TrustedFixtures = {}) {
    this.#deckFactory = fixtures.deckFactory ?? (() => shuffled(orderedBalatroDeck()));
    this.#rewardFactory = fixtures.rewardFactory ?? (available => shuffled(available).slice(0, 3));
    this.#startRound();
  }
  #startRound(): void {
    this.#deck = validateDeck(this.#deckFactory()); this.#hand = this.#deck.splice(0, 8);
    this.#handsLeft = 4; this.#discardsLeft = 3; this.#roundScore = 0; this.#phase = "playing"; this.#rewardChoices = [];
  }
  actor(): 0 | null { return this.#result ? null : 0; }
  outcome(): BalatroOutcome | null { return this.#result ? { ...this.#result } : null; }
  view(seat: 0 | 1 | null): BalatroView {
    if (seat !== 0 && seat !== 1 && seat !== null) throw new BalatroRuleError("INVALID_SEAT");
    const owned = (id: JokerId) => ({ ...BALATRO_JOKERS.find(joker => joker.id === id)! });
    return structuredClone({
      rules: BALATRO_RULES, phase: this.#phase, round: this.#round, ante: Math.ceil(this.#round / 3),
      blind: (["small", "big", "boss"] as const)[(this.#round - 1) % 3]!, antes: 4, rounds: 12,
      targets: [...BALATRO_TARGETS], target: BALATRO_TARGETS[this.#round - 1]!, roundScore: this.#roundScore,
      totalScore: this.#totalScore, cleared: this.#cleared, handsLeft: this.#handsLeft, discardsLeft: this.#discardsLeft,
      hand: seat === 0 ? this.#hand : [], deckRemaining: this.#deck.length, jokers: this.#jokers.map(owned), jokerSlots: 5,
      rewardChoices: this.#rewardChoices.map(owned), rewardUpgradeLevels: 3, handLevels: this.#levels,
      lastScore: this.#lastScore, history: this.#history, legalActions: seat === 0 && !this.#result ? this.#phase === "reward"
        ? ["choose_joker", "skip_reward"] : ["play", ...(this.#discardsLeft > 0 ? ["discard"] : [])] : [], result: this.#result,
    } as BalatroView);
  }
  act(seat: 0 | 1, action: BalatroAction): void {
    if (seat !== 0 && seat !== 1) throw new BalatroRuleError("INVALID_SEAT");
    if (this.#result) throw new BalatroRuleError("GAME_COMPLETE");
    if (seat !== 0) throw new BalatroRuleError("OUT_OF_TURN");
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new BalatroRuleError("INVALID_ACTION");
    if (action.type === "play" || action.type === "discard") {
      if (Object.keys(action).sort().join(",") !== "cards,type") throw new BalatroRuleError("INVALID_ACTION");
      if (this.#phase !== "playing") throw new BalatroRuleError("REWARD_REQUIRED");
      validateCards(action.cards);
      if (action.cards.some(card => !this.#hand.includes(card))) throw new BalatroRuleError("CARD_NOT_IN_HAND");
      if (action.type === "discard" && this.#discardsLeft === 0) throw new BalatroRuleError("NO_DISCARDS_LEFT");
      const score = action.type === "play" ? scoreBalatroHand(action.cards, this.#jokers, this.#handsLeft, this.#levels) : null;
      // Compute random reward before mutation so a trusted fixture failure cannot partially apply a play.
      let rewards: JokerId[] = [];
      if (score && this.#roundScore + score.score >= BALATRO_TARGETS[this.#round - 1]! && this.#round < 12) {
        const available = jokerIds.filter(id => !this.#jokers.includes(id));
        rewards = this.#rewardFactory([...available]);
        if (!Array.isArray(rewards) || rewards.length !== 3 || new Set(rewards).size !== 3 || ![...rewards].every(id => available.includes(id))) throw new BalatroRuleError("INVALID_REWARDS");
      }
      this.#hand = this.#hand.filter(card => !action.cards.includes(card));
      this.#hand.push(...this.#deck.splice(0, 8 - this.#hand.length));
      if (score) {
        this.#handsLeft--; this.#lastScore = score; this.#history.push({ round: this.#round, ...score });
        this.#roundScore += score.score; this.#totalScore += score.score;
        if (this.#roundScore >= BALATRO_TARGETS[this.#round - 1]!) {
          this.#cleared++;
          if (this.#round === 12) { this.#phase = "complete"; this.#result = { kind: "win", winner: 0, reason: "all_blinds_cleared" }; }
          else { this.#phase = "reward"; this.#rewardChoices = [...rewards]; }
        } else if (this.#handsLeft === 0) { this.#phase = "complete"; this.#result = { kind: "win", winner: 1, reason: "hands_exhausted" }; }
      } else this.#discardsLeft--;
      return;
    }
    if (action.type !== "choose_joker" && action.type !== "skip_reward") throw new BalatroRuleError("INVALID_ACTION");
    const allowed = action.type === "choose_joker" ? ["type", "jokerId", "replaceJokerId", "upgradeHand"] : ["type", "upgradeHand"];
    if (Object.keys(action).some(key => !allowed.includes(key))) throw new BalatroRuleError("INVALID_ACTION");
    if (this.#phase !== "reward") throw new BalatroRuleError("NOT_IN_REWARD_PHASE");
    const upgrade = "upgradeHand" in action ? action.upgradeHand : this.#lastScore!.handType;
    if (!isHandType(upgrade)) throw new BalatroRuleError("INVALID_UPGRADE_HAND");
    const nextJokers = [...this.#jokers];
    if (action.type === "choose_joker") {
      if (!this.#rewardChoices.includes(action.jokerId as JokerId)) throw new BalatroRuleError("JOKER_NOT_OFFERED");
      if (nextJokers.length === 5) {
        const index = nextJokers.indexOf(action.replaceJokerId as JokerId);
        if (index === -1) throw new BalatroRuleError("JOKER_REPLACEMENT_REQUIRED");
        nextJokers[index] = action.jokerId as JokerId;
      } else {
        if ("replaceJokerId" in action) throw new BalatroRuleError("UNEXPECTED_JOKER_REPLACEMENT");
        nextJokers.push(action.jokerId as JokerId);
      }
    }
    const nextDeck = validateDeck(this.#deckFactory());
    // A whole new standard deck starts each blind; acquired construction persists.
    this.#jokers = nextJokers; this.#levels[upgrade] += 3; this.#round++;
    this.#deck = nextDeck; this.#hand = this.#deck.splice(0, 8); this.#handsLeft = 4; this.#discardsLeft = 3;
    this.#roundScore = 0; this.#phase = "playing"; this.#rewardChoices = [];
  }
  /** Local hint chooses a highest-scoring visible-card subset; it never reads the future deck. */
  botAction(): BalatroAction | null {
    if (this.#result) return null;
    if (this.#phase === "reward") {
      const preferences: JokerId[] = ["amplifier", "red", "straight", "pair", "flush", "chips", "faces", "spark", "last"];
      const chosen = preferences.find(id => this.#rewardChoices.includes(id))!;
      return { type: "choose_joker", jokerId: chosen, ...(this.#jokers.length === 5 ? { replaceJokerId: this.#jokers[0]! } : {}) };
    }
    let best: BalatroCard[] = [], bestScore = -Infinity;
    for (let mask = 1; mask < 1 << this.#hand.length; mask++) {
      const cards = this.#hand.filter((_, index) => mask & (1 << index));
      if (cards.length > 5) continue;
      const score = scoreBalatroHand(cards, this.#jokers, this.#handsLeft, this.#levels).score;
      if (score > bestScore || (score === bestScore && cards.length < best.length)) { best = cards; bestScore = score; }
    }
    return { type: "play", cards: best };
  }
}
export function createBalatroGame(): BalatroGame { return new BalatroGame(); }
