import { shuffledDeck, validateDeck, type Card } from "./cards.js";
import { compareHandRanks, evaluateBestHand, type HandRank } from "./evaluator.js";

export type Seat = 0 | 1;
export type Street = "preflop" | "flop" | "turn" | "river";
export interface HandConfig { initialStack: number; smallBlind: number; bigBlind: number; button?: Seat; initialStacks?: [number, number] }
export interface ResolvedHandConfig { initialStack: number; smallBlind: number; bigBlind: number; button: Seat; initialStacks?: [number, number] }
export type Action = { type: "fold" | "check" | "call" | "all-in" } | { type: "raise"; to: number };
export type LegalAction = { type: "fold" | "check" }
  | { type: "call"; chips: number; allIn: boolean }
  | { type: "raise"; minTo: number; maxTo: number; allInOnly: boolean }
  | { type: "all-in"; to: number; kind: "call" | "raise" };
export interface HandResult {
  reason: "fold" | "showdown";
  winners: Seat[];
  contestedPot: number;
  payouts: [number, number];
  refunds: [number, number];
  finalStacks: [number, number];
  showdown?: [{ seat: 0; holeCards: Card[]; rank: HandRank }, { seat: 1; holeCards: Card[]; rank: HandRank }];
}
export interface PlayerView {
  seat: Seat;
  handStatus: "playing" | "complete";
  street: Street;
  button: Seat;
  smallBlind: number;
  bigBlind: number;
  actor: Seat | null;
  holeCards: Card[];
  board: Card[];
  stacks: [number, number];
  streetCommitted: [number, number];
  totalCommitted: [number, number];
  pot: number;
  legalActions: LegalAction[];
  result?: HandResult;
}
/** Contains secrets. Store only in the trusted referee, never in a player response. */
export interface TrustedReplay {
  version: 1;
  config: ResolvedHandConfig;
  deck: Card[];
  actions: { seat: Seat; action: Action }[];
}
export interface HoldemHand {
  view(seat: Seat): PlayerView;
  act(seat: Seat, action: Action): void;
  exportTrustedReplay(): TrustedReplay;
}

function assertSeat(seat: unknown): asserts seat is Seat {
  if (seat !== 0 && seat !== 1) throw new Error("INVALID_SEAT");
}
function positiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0;
}
function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every(key => allowed.includes(key));
}
function resolveConfig(input: HandConfig): ResolvedHandConfig {
  if (!input || typeof input !== "object" || Array.isArray(input) || !exactKeys(input as unknown as Record<string, unknown>, ["initialStack", "smallBlind", "bigBlind", "button", "initialStacks"])) throw new Error("INVALID_CONFIG");
  const { initialStack, smallBlind, bigBlind } = input;
  const button = input.button === undefined ? 0 : input.button;
  assertSeat(button);
  if (!positiveInteger(initialStack) || initialStack > Math.floor(Number.MAX_SAFE_INTEGER / 2)
    || !positiveInteger(smallBlind) || !positiveInteger(bigBlind) || smallBlind > bigBlind || bigBlind > initialStack) {
    throw new Error("INVALID_CONFIG: integer virtual chips, 0 < smallBlind <= bigBlind <= initialStack required");
  }
  if (input.initialStacks !== undefined && (!Array.isArray(input.initialStacks) || input.initialStacks.length !== 2
    || !input.initialStacks.every(positiveInteger) || !Number.isSafeInteger(input.initialStacks[0] + input.initialStacks[1])
    || input.initialStacks.some(stack => stack > initialStack))) throw new Error("INVALID_INITIAL_STACKS");
  return { initialStack, smallBlind, bigBlind, button, ...(input.initialStacks ? { initialStacks: pair(input.initialStacks) } : {}) };
}
function normalizeAction(input: Action): Action {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_ACTION");
  if (input.type === "raise") {
    if (!exactKeys(input as unknown as Record<string, unknown>, ["type", "to"]) || !positiveInteger(input.to)) throw new Error("INVALID_ACTION");
    return { type: "raise", to: input.to };
  }
  if (!["fold", "check", "call", "all-in"].includes(input.type) || !exactKeys(input as unknown as Record<string, unknown>, ["type"])) throw new Error("INVALID_ACTION");
  return { type: input.type };
}
const other = (seat: Seat): Seat => seat === 0 ? 1 : 0;
const pair = (values: [number, number]): [number, number] => [...values];

/** One odd chip goes to the winning seat left of the button. No side pots in heads-up. */
export function splitPot(pot: number, winners: readonly Seat[], button: Seat): [number, number] {
  assertSeat(button);
  if (!Number.isSafeInteger(pot) || pot < 0 || !Array.isArray(winners) || winners.length < 1 || winners.length > 2 || new Set(winners).size !== winners.length) throw new Error("INVALID_POT");
  winners.forEach(assertSeat);
  const payouts: [number, number] = [0, 0];
  const share = Math.floor(pot / winners.length);
  for (const seat of winners) payouts[seat] = share;
  if (pot % winners.length) payouts[winners.includes(other(button)) ? other(button) : button] += 1;
  return payouts;
}

class Hand implements HoldemHand {
  #config: ResolvedHandConfig;
  #deck: Card[];
  #cursor = 0;
  #hole: [Card[], Card[]] = [[], []];
  #board: Card[] = [];
  #street: Street = "preflop";
  #stacks: [number, number];
  #committed: [number, number] = [0, 0];
  #total: [number, number] = [0, 0];
  #refunds: [number, number] = [0, 0];
  #pending: [boolean, boolean] = [true, true];
  #acted: [boolean, boolean] = [false, false];
  #lastFullRaise: number;
  #actor: Seat | null;
  #result?: HandResult;
  #actions: TrustedReplay["actions"] = [];

  constructor(config: ResolvedHandConfig, deck: Card[]) {
    this.#config = config;
    this.#deck = deck;
    this.#stacks = config.initialStacks ? pair(config.initialStacks) : [config.initialStack, config.initialStack];
    this.#lastFullRaise = config.bigBlind;
    this.#actor = config.button;
    for (let round = 0; round < 2; round++) {
      this.#hole[other(config.button)].push(this.#draw());
      this.#hole[config.button].push(this.#draw());
    }
    this.#pay(config.button, Math.min(config.smallBlind, this.#stacks[config.button]));
    this.#pay(other(config.button), Math.min(config.bigBlind, this.#stacks[other(config.button)]));
    this.#reconcile(config.button);
  }

  #draw(): Card { return this.#deck[this.#cursor++]!; }
  #bet(): number { return Math.max(...this.#committed); }
  #toCall(seat: Seat): number { return this.#bet() - this.#committed[seat]; }
  #pay(seat: Seat, chips: number): void {
    this.#stacks[seat] -= chips;
    this.#committed[seat] += chips;
    this.#total[seat] += chips;
  }
  #canRaise(seat: Seat): boolean {
    return !this.#acted[seat] && this.#stacks[other(seat)] > 0 && this.#committed[seat] + this.#stacks[seat] > this.#bet();
  }
  #legal(seat: Seat): LegalAction[] {
    if (this.#actor !== seat || this.#result) return [];
    const call = this.#toCall(seat);
    const actions: LegalAction[] = [{ type: "fold" }];
    if (call === 0) actions.push({ type: "check" });
    else actions.push({ type: "call", chips: Math.min(call, this.#stacks[seat]), allIn: this.#stacks[seat] <= call });
    if (this.#canRaise(seat)) {
      const maxTo = this.#committed[seat] + this.#stacks[seat];
      const minTo = this.#bet() + this.#lastFullRaise;
      actions.push({ type: "raise", minTo, maxTo, allInOnly: maxTo < minTo });
      actions.push({ type: "all-in", to: maxTo, kind: "raise" });
    } else if (call > 0 && this.#stacks[seat] <= call) {
      actions.push({ type: "all-in", to: this.#committed[seat] + this.#stacks[seat], kind: "call" });
    }
    return actions;
  }

  view(seat: Seat): PlayerView {
    assertSeat(seat);
    return {
      seat, handStatus: this.#result ? "complete" : "playing", street: this.#street,
      button: this.#config.button, smallBlind: this.#config.smallBlind, bigBlind: this.#config.bigBlind,
      actor: this.#actor, holeCards: [...this.#hole[seat]], board: [...this.#board],
      stacks: pair(this.#stacks), streetCommitted: pair(this.#committed), totalCommitted: pair(this.#total),
      pot: this.#result ? 0 : this.#total[0] + this.#total[1], legalActions: this.#legal(seat),
      ...(this.#result ? { result: structuredClone(this.#result) } : {}),
    };
  }

  act(seat: Seat, input: Action): void {
    assertSeat(seat);
    if (this.#result) throw new Error("HAND_COMPLETE");
    if (this.#actor !== seat) throw new Error("OUT_OF_TURN");
    const action = normalizeAction(input);
    const call = this.#toCall(seat);
    let effective = action;
    if (action.type === "all-in") {
      const to = this.#committed[seat] + this.#stacks[seat];
      effective = to > this.#bet() ? { type: "raise", to } : { type: "call" };
    }
    if (effective.type === "check" && call !== 0) throw new Error("CANNOT_CHECK");
    if (effective.type === "call" && call === 0) throw new Error("NOTHING_TO_CALL");
    if (effective.type === "raise") {
      if (!this.#canRaise(seat)) throw new Error("RAISE_NOT_OPEN");
      const maximum = this.#committed[seat] + this.#stacks[seat];
      if (effective.to <= this.#bet() || effective.to > maximum) throw new Error("INVALID_RAISE_SIZE");
      if (effective.to - this.#bet() < this.#lastFullRaise && effective.to !== maximum) throw new Error("MINIMUM_RAISE");
    }
    // The journal only records successfully validated actions.
    this.#actions.push({ seat, action });
    if (effective.type === "fold") {
      this.#refundUncalled();
      this.#finish("fold", [other(seat)]);
      return;
    }
    if (effective.type === "raise") {
      const increment = effective.to - this.#bet();
      if (increment >= this.#lastFullRaise) {
        this.#lastFullRaise = increment;
        this.#acted = [false, false];
      }
      this.#pay(seat, effective.to - this.#committed[seat]);
      this.#pending[other(seat)] = true;
    } else if (effective.type === "call") this.#pay(seat, Math.min(call, this.#stacks[seat]));
    this.#acted[seat] = true;
    this.#pending[seat] = false;
    this.#reconcile(other(seat));
  }

  #refundUncalled(): void {
    const delta = this.#committed[0] - this.#committed[1];
    if (delta === 0) return;
    const seat: Seat = delta > 0 ? 0 : 1;
    const refund = Math.abs(delta);
    this.#committed[seat] -= refund;
    this.#total[seat] -= refund;
    this.#stacks[seat] += refund;
    this.#refunds[seat] += refund;
  }
  #dealNextStreet(): void {
    this.#draw(); // burn card, private to the referee
    if (this.#street === "preflop") {
      this.#street = "flop";
      this.#board.push(this.#draw(), this.#draw(), this.#draw());
    } else {
      this.#street = this.#street === "flop" ? "turn" : "river";
      this.#board.push(this.#draw());
    }
    this.#committed = [0, 0];
    this.#lastFullRaise = this.#config.bigBlind;
    this.#acted = [false, false];
    this.#pending = [true, true];
  }
  #reconcile(next: Seat): void {
    if (this.#stacks[0] === 0 || this.#stacks[1] === 0) {
      const responding: Seat | undefined = this.#stacks[0] > 0 ? 0 : this.#stacks[1] > 0 ? 1 : undefined;
      if (responding !== undefined && this.#toCall(responding) > 0) {
        this.#actor = responding;
        return;
      }
      this.#refundUncalled();
      while (this.#street !== "river") this.#dealNextStreet();
      this.#showdown();
      return;
    }
    if (!this.#pending[0] && !this.#pending[1]) {
      if (this.#street === "river") this.#showdown();
      else {
        this.#dealNextStreet();
        this.#actor = other(this.#config.button);
      }
    } else this.#actor = this.#pending[next] ? next : other(next);
  }
  #showdown(): void {
    const first = evaluateBestHand([...this.#hole[0], ...this.#board]);
    const second = evaluateBestHand([...this.#hole[1], ...this.#board]);
    const comparison = compareHandRanks(first, second);
    this.#finish("showdown", comparison === 0 ? [0, 1] : comparison > 0 ? [0] : [1]);
    this.#result!.showdown = [
      { seat: 0, holeCards: [...this.#hole[0]], rank: first },
      { seat: 1, holeCards: [...this.#hole[1]], rank: second },
    ];
  }
  #finish(reason: HandResult["reason"], winners: Seat[]): void {
    const contestedPot = this.#total[0] + this.#total[1];
    const payouts = splitPot(contestedPot, winners, this.#config.button);
    this.#stacks[0] += payouts[0];
    this.#stacks[1] += payouts[1];
    this.#actor = null;
    this.#result = { reason, winners, contestedPot, payouts, refunds: pair(this.#refunds), finalStacks: pair(this.#stacks) };
  }

  exportTrustedReplay(): TrustedReplay {
    return { version: 1, config: structuredClone(this.#config), deck: [...this.#deck], actions: structuredClone(this.#actions) };
  }
}

/** Production entry point. There is deliberately no deck or RNG parameter. */
export function createHand(config: HandConfig): HoldemHand {
  return new Hand(resolveConfig(config), shuffledDeck());
}

/** Internal trusted/test entry point; excluded from the public index. */
export function makeTrustedHand(config: HandConfig, deck: unknown): HoldemHand {
  return new Hand(resolveConfig(config), validateDeck(deck));
}

/** Restores a trusted journal by replaying the same validation as live actions. */
export function replayHand(input: unknown): HoldemHand {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("INVALID_REPLAY");
  const replay = input as Record<string, unknown>;
  if (!exactKeys(replay, ["version", "config", "deck", "actions"]) || replay.version !== 1 || !Array.isArray(replay.actions)) throw new Error("INVALID_REPLAY");
  const hand = makeTrustedHand(replay.config as HandConfig, replay.deck);
  for (const entry of replay.actions) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry) || !exactKeys(entry, ["seat", "action"])) throw new Error("INVALID_REPLAY");
    hand.act(entry.seat, entry.action);
  }
  return hand;
}
