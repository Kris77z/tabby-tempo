import { createHash } from "node:crypto";
import { join } from "node:path";
import { SessionStore } from "../../../../packages/pi-loop/src/session.js";
import { createHand, replayHand, type Action, type HandConfig, type HandResult, type PlayerView, type Seat, type Street, type TrustedReplay } from "./engine.js";

export const HOLDEM_LIVE_LIMITS = Object.freeze({ model: "kimi-k2.6", maxCalls: 20, maxCompletionTokens: 512,
  deadlineDurationMs: 600000, upstreamTimeoutMs: 55000, inferenceRetries: 0 });
export const HOLDEM_LIVE_HAND: Readonly<HandConfig> = Object.freeze({ initialStack: 1000, smallBlind: 5, bigBlind: 10 });

export type PublicHandResult = Pick<HandResult, "reason" | "winners" | "contestedPot" | "payouts" | "refunds" | "finalStacks">;
export interface PublicHandStep { seat: Seat; street: Street; action: Action; board: string[]; stacks: [number, number]; pot: number }
export interface DecisionRequest {
  model: string; stream: false; max_completion_tokens: 512; thinking: { type: "disabled" };
  messages: [{ role: "system"; content: string }, { role: "user"; content: string }];
}
/** Trusted operator presets. No arbitrary instruction or provider URL enters the hand. */
export interface LiveDecisionProfile { model: string; strategy: "conservative" | "balanced" | "aggressive" }
export type DecisionOutcome = "IntentPersisted" | "Applied" | "HTTPRejected" | "ResponseInvalid" | "OutcomeUnknown" | "DeadlineExpired";
export interface PrivateDecisionTurn {
  turn: number; seat: Seat; requestDigest: string; dispatchIntent: true; request: DecisionRequest;
  outcome: DecisionOutcome; response?: { httpStatus: number; rawText: string }; action?: Action; durationMs?: number;
}
/** Every private request contains the actor's own cards; the replay additionally contains the referee's deck. */
export interface LiveHandSession {
  version: 1; matchId: string; phase: "Running" | "Complete" | "Stopped"; reason?: string;
  startedAtMs: number; deadlineMs: number; limits: typeof HOLDEM_LIVE_LIMITS; replay: TrustedReplay; turns: PrivateDecisionTurn[];
  profiles?: [LiveDecisionProfile, LiveDecisionProfile];
}
export interface PublicDecisionAttempt {
  turn: number; seat: Seat; requestedModel: string; status?: number; outcome: DecisionOutcome; durationMs?: number;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}
export interface PublicLiveHand {
  matchId: string; phase: LiveHandSession["phase"]; reason?: string; steps: PublicHandStep[]; finalBoard: string[];
  result: PublicHandResult | null; attempts: PublicDecisionAttempt[]; replayVerified: true;
}

const INSTRUCTIONS = "You are the acting player in a free-entry heads-up no-limit Texas Hold'em hand. Your entire current player view is the next message. Choose one legal action using only that view. Return exactly one JSON object and no explanation, Markdown, reasoning, or tool call. For fold, check, call, or all-in, return {\"type\":\"ACTION\"} with no other keys. For raise, return {\"type\":\"raise\",\"to\":INTEGER}; to is your total commitment on this street, within legal minTo/maxTo (if allInOnly, use maxTo). Chips are virtual and not redeemable. Choose your own action; no outcome is predetermined.";

const STRATEGIES = Object.freeze({
  conservative: "Prefer preserving your stack. Avoid marginal calls and speculative raises; fold weak hands when facing meaningful pressure.",
  balanced: "Balance stack preservation and value. Use the visible pot, legal bet sizes and your cards to choose calls, value raises and occasional pressure.",
  aggressive: "Prefer applying pressure through legal bets and raises when justified by your cards and the visible situation; still evaluate the risk of losing your stack.",
});
export function decisionRequest(view: PlayerView, profile?: LiveDecisionProfile): DecisionRequest {
  if (view.handStatus !== "playing" || view.actor !== view.seat || view.legalActions.length === 0 || view.result !== undefined) throw new Error("HOLDEM_NOT_ACTOR");
  if (profile && (!/^[A-Za-z0-9._-]{1,64}$/.test(profile.model) || !Object.hasOwn(STRATEGIES, profile.strategy))) throw new Error("HOLDEM_INVALID_PROFILE");
  const examples = view.legalActions.map(action => action.type === "raise"
    ? { type: "raise", to: action.allInOnly ? action.maxTo : action.minTo } : { type: action.type });
  const format = `\nThe legalActions objects include descriptive cost/range metadata; they are NOT response objects. Never copy chips, allIn, kind, minTo, maxTo, or allInOnly into your response.\nValid response format examples for this turn: ${examples.map(example => JSON.stringify(example)).join(" or ")}. These are syntax examples, not recommended actions. A raise example uses the minimum permitted size (or the required all-in size); any integer size allowed by the original minTo/maxTo rules remains available. Choose your action independently.`;
  return { model: profile?.model ?? HOLDEM_LIVE_LIMITS.model, stream: false, max_completion_tokens: HOLDEM_LIVE_LIMITS.maxCompletionTokens,
    thinking: { type: "disabled" }, messages: [{ role: "system", content: (profile ? `${INSTRUCTIONS}\nStrategy preset: ${profile.strategy}. ${STRATEGIES[profile.strategy]}` : INSTRUCTIONS) + format }, { role: "user", content: JSON.stringify(view) }] };
}

/** No coercion, Markdown stripping, repair, default fold, or second model request. */
export function parseLegalDecision(content: unknown, view: PlayerView): Action {
  if (typeof content !== "string" || content.length > 8192) throw new Error("HOLDEM_INVALID_DECISION");
  let value: unknown;
  try { value = JSON.parse(content); } catch { throw new Error("HOLDEM_INVALID_DECISION"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("HOLDEM_INVALID_DECISION");
  const action = value as Record<string, unknown>;
  // The small grammar also rejects duplicate keys and JSON numbers that are not integer literals.
  const simple = /^\s*\{\s*"type"\s*:\s*"(fold|check|call|all-in)"\s*\}\s*$/;
  const raise = /^\s*\{\s*(?:"type"\s*:\s*"raise"\s*,\s*"to"\s*:\s*[1-9][0-9]*|"to"\s*:\s*[1-9][0-9]*\s*,\s*"type"\s*:\s*"raise")\s*\}\s*$/;
  if (!simple.test(content) && !raise.test(content)) throw new Error("HOLDEM_INVALID_DECISION");
  const option = view.legalActions.find(candidate => candidate.type === action.type);
  if (view.handStatus !== "playing" || view.actor !== view.seat || !option) throw new Error("HOLDEM_ILLEGAL_DECISION");
  if (action.type === "raise") {
    if (option.type !== "raise" || !Number.isSafeInteger(action.to) || typeof action.to !== "number"
      || action.to > option.maxTo || (option.allInOnly ? action.to !== option.maxTo : action.to < option.minTo)) throw new Error("HOLDEM_ILLEGAL_DECISION");
    return { type: "raise", to: action.to };
  }
  return { type: action.type as "fold" | "check" | "call" | "all-in" };
}

function completionContent(rawText: string, expectedModel?: string): unknown {
  let body: any;
  try { body = JSON.parse(rawText); } catch { throw new Error("HOLDEM_INVALID_RESPONSE"); }
  if (expectedModel !== undefined && body?.model !== expectedModel || !Array.isArray(body?.choices) || body.choices.length !== 1 || body.choices[0]?.finish_reason !== "stop"
    || body.choices[0]?.message?.role !== "assistant" || body.choices[0]?.message?.tool_calls !== undefined
    || body.choices[0]?.message?.function_call !== undefined) throw new Error("HOLDEM_INVALID_RESPONSE");
  return body.choices[0].message.content;
}

export function publicHandResult(result: HandResult): PublicHandResult {
  return { reason: result.reason, winners: [...result.winners], contestedPot: result.contestedPot,
    payouts: [...result.payouts], refunds: [...result.refunds], finalStacks: [...result.finalStacks] };
}
function publicAttempt(turn: PrivateDecisionTurn): PublicDecisionAttempt {
  const attempt: PublicDecisionAttempt = { turn: turn.turn, seat: turn.seat, requestedModel: turn.request.model, outcome: turn.outcome,
    ...(turn.response ? { status: turn.response.httpStatus } : {}), ...(turn.durationMs === undefined ? {} : { durationMs: turn.durationMs }) };
  if (turn.response) {
    try {
      const usage = JSON.parse(turn.response.rawText)?.usage;
      if (usage && typeof usage === "object") {
        const safe: NonNullable<PublicDecisionAttempt["usage"]> = {};
        for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const)
          if (Number.isSafeInteger(usage[key]) && usage[key] >= 0) safe[key] = usage[key];
        if (Object.keys(safe).length) attempt.usage = safe;
      }
    } catch { /* An invalid private response contributes no public provider text. */ }
  }
  return attempt;
}

/** Recompute public steps from trusted legal actions; never expose the player's complete view or showdown. */
export function publicLiveHand(session: LiveHandSession): PublicLiveHand {
  const hand = replayHand({ ...session.replay, actions: [] });
  const steps: PublicHandStep[] = [];
  for (const entry of session.replay.actions) {
    const view = hand.view(entry.seat);
    steps.push({ seat: entry.seat, street: view.street, action: structuredClone(entry.action), board: [...view.board], stacks: [...view.stacks], pot: view.pot });
    hand.act(entry.seat, entry.action);
  }
  const final = hand.view(0);
  if (session.phase === "Complete" && (final.handStatus !== "complete" || !final.result)) throw new Error("HOLDEM_TERMINAL_REPLAY_MISMATCH");
  return { matchId: session.matchId, phase: session.phase, ...(session.reason ? { reason: session.reason } : {}), steps,
    finalBoard: [...final.board], result: session.phase === "Complete" && final.result ? publicHandResult(final.result) : null,
    attempts: session.turns.map(publicAttempt), replayVerified: true };
}

/** One durable intent per HTTP dispatch. Existing journals are inspected, never resumed with new model calls. */
export async function runLiveHand(directory: string, config: { matchId: string; startedAtMs: number; deadlineMs: number; profiles?: [LiveDecisionProfile, LiveDecisionProfile]; recover?: boolean }, dependencies: {
  dispatch: (request: DecisionRequest, signal: AbortSignal, turn: Readonly<PrivateDecisionTurn>) => Promise<Response>;
  onProgress?: (snapshot: PublicLiveHand) => Promise<void>;
}): Promise<LiveHandSession> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(config.matchId) || !Number.isSafeInteger(config.startedAtMs) || !Number.isSafeInteger(config.deadlineMs)
    || config.deadlineMs - config.startedAtMs > HOLDEM_LIVE_LIMITS.deadlineDurationMs || config.deadlineMs < config.startedAtMs) throw new Error("HOLDEM_INVALID_LIVE_CONFIG");
  const store = new SessionStore<LiveHandSession>(join(directory, "game"));
  if (config.profiles) {
    if (!Array.isArray(config.profiles) || config.profiles.length !== 2) throw new Error("HOLDEM_INVALID_PROFILE");
    for (const profile of config.profiles) decisionRequest(createHand({ ...HOLDEM_LIVE_HAND }).view(0), profile);
  }
  await store.start(config.recover);
  let session: LiveHandSession | undefined;
  const publish = async () => { if (dependencies.onProgress) await dependencies.onProgress(publicLiveHand(session!)); };
  try {
    session = await store.read();
    if (session) {
      if (session.matchId !== config.matchId || JSON.stringify(session.limits) !== JSON.stringify(HOLDEM_LIVE_LIMITS)
        || JSON.stringify(session.profiles) !== JSON.stringify(config.profiles)) throw new Error("HOLDEM_OUTPUT_BINDING_MISMATCH");
      replayHand(session.replay);
      if (session.phase === "Running") {
        session.phase = "Stopped";
        session.reason = session.turns.some(turn => turn.outcome === "IntentPersisted") ? "UNKNOWN_HTTP_RESULT_NO_REDISPATCH" : "EXISTING_GAME_NO_REDISPATCH";
        for (const turn of session.turns) if (turn.outcome === "IntentPersisted") turn.outcome = "OutcomeUnknown";
        await store.write(session);
      }
      await publish(); return structuredClone(session);
    }
    const hand = createHand({ ...HOLDEM_LIVE_HAND });
    session = { version: 1, matchId: config.matchId, phase: "Running", startedAtMs: config.startedAtMs, deadlineMs: config.deadlineMs,
      limits: HOLDEM_LIVE_LIMITS, replay: hand.exportTrustedReplay(), turns: [], ...(config.profiles ? { profiles: structuredClone(config.profiles) } : {}) };
    await store.write(session); await publish();
    const stop = async (reason: string) => { session!.phase = "Stopped"; session!.reason = reason; await store.write(session!); await publish(); };
    while (hand.view(0).handStatus === "playing") {
      if (Date.now() >= session.deadlineMs) { await stop("HOLDEM_DEADLINE_REACHED"); break; }
      if (session.turns.length >= HOLDEM_LIVE_LIMITS.maxCalls) { await stop("HOLDEM_CALL_LIMIT_REACHED"); break; }
      const seat = hand.view(0).actor;
      if (seat === null) throw new Error("HOLDEM_PLAYING_WITHOUT_ACTOR");
      const view = hand.view(seat), request = decisionRequest(view, session.profiles?.[seat]);
      const turn: PrivateDecisionTurn = { turn: session.turns.length + 1, seat, requestDigest: createHash("sha256").update(JSON.stringify(request)).digest("hex"),
        dispatchIntent: true, request, outcome: "IntentPersisted" };
      session.turns.push(turn);
      // SessionStore fsyncs file and directory before the sponsor-funded request can leave the process.
      await store.write(session); await publish();
      const started = Date.now();
      let response: Response;
      try {
        const timeout = Math.min(HOLDEM_LIVE_LIMITS.upstreamTimeoutMs, session.deadlineMs - Date.now());
        if (timeout <= 0) { turn.outcome = "DeadlineExpired"; await stop("HOLDEM_DEADLINE_REACHED"); break; }
        response = await dependencies.dispatch(structuredClone(request), AbortSignal.timeout(timeout), structuredClone(turn));
        turn.response = { httpStatus: response.status, rawText: await response.text() };
        turn.durationMs = Date.now() - started;
        await store.write(session);
      } catch {
        turn.durationMs = Date.now() - started; turn.outcome = "OutcomeUnknown";
        await stop("UNKNOWN_HTTP_RESULT_NO_REDISPATCH"); break;
      }
      if (Date.now() >= session.deadlineMs) { turn.outcome = "DeadlineExpired"; await stop("HOLDEM_DEADLINE_REACHED"); break; }
      if (!response.ok) { turn.outcome = "HTTPRejected"; await stop("HOLDEM_UPSTREAM_HTTP_ERROR_NO_RETRY"); break; }
      try {
        const action = parseLegalDecision(completionContent(turn.response.rawText, session.profiles ? request.model : undefined), view);
        hand.act(seat, action); turn.action = action; turn.outcome = "Applied"; session.replay = hand.exportTrustedReplay();
      } catch {
        turn.outcome = "ResponseInvalid"; await stop("HOLDEM_INVALID_OR_ILLEGAL_RESPONSE"); break;
      }
      if (hand.view(0).handStatus === "complete") session.phase = "Complete";
      await store.write(session); await publish();
    }
    return structuredClone(session);
  } finally { await store.close(); }
}
