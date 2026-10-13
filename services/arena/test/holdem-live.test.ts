import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { createHand, replayHand, type PlayerView } from "../src/holdem/index.js";
import { decisionRequest, HOLDEM_LIVE_LIMITS, parseLegalDecision, publicLiveHand, runLiveHand, type LiveHandSession } from "../src/holdem/live.js";

const response = (content: string, overrides: Record<string, unknown> = {}) => Response.json({ model: "kimi-k2.6",
  choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 }, ...overrides });
const config = (duration: number = HOLDEM_LIVE_LIMITS.deadlineDurationMs) => { const startedAtMs = Date.now(); return { matchId: "controlled-live", startedAtMs, deadlineMs: startedAtMs + duration }; };
function assertPublic(value: unknown): void {
  const text = JSON.stringify(value);
  for (const hidden of ["holeCards", '"deck":', '"showdown":', "rawText", "requestDigest", "messages", "reasoning_content", "provider-secret"])
    assert.equal(text.includes(hidden), false, `public value contains ${hidden}`);
}

test("strict decision parser accepts only legal action JSON without correction", () => {
  const hand = createHand({ initialStack: 1000, smallBlind: 5, bigBlind: 10 }), view = hand.view(0);
  assert.deepEqual(parseLegalDecision('{ "type": "call" }', view), { type: "call" });
  assert.deepEqual(parseLegalDecision('{"to":20,"type":"raise"}', view), { type: "raise", to: 20 });
  assert.deepEqual(parseLegalDecision('{"type":"all-in"}', view), { type: "all-in" });
  for (const text of ['{"type":"check"}', '{"type":"raise","to":19}', '{"type":"raise","to":1001}', '{"type":"call","reason":"good"}',
    '```json\n{"type":"call"}\n```', '[{"type":"call"}]', '{"type":"fold","type":"call"}', '{"type":"raise","to":2e1}', '{"type":"raise","to":20.0}'])
    assert.throws(() => parseLegalDecision(text, view), /HOLDEM_(INVALID|ILLEGAL)_DECISION/);
  assert.throws(() => decisionRequest(hand.view(1)), /HOLDEM_NOT_ACTOR/);
});

test("actor-only model decisions use real shuffle, durable intent, legal replay and private permissions", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-live-rule-")); let calls = 0;
  const runConfig = config();
  try {
    const session = await runLiveHand(directory, runConfig, { dispatch: async (request, signal, turn) => {
      calls++; assert.equal(signal.aborted, false); assert.equal(request.model, "kimi-k2.6"); assert.equal(request.max_completion_tokens, 512);
      assert.deepEqual(request.thinking, { type: "disabled" }); assert.equal(request.stream, false);
      assert.equal("tools" in request, false); assert.equal("tool_choice" in request, false); assert.equal(request.messages.length, 2);
      const saved = JSON.parse(await readFile(join(directory, "game/session.json"), "utf8")) as LiveHandSession;
      assert.equal(saved.turns.at(-1)!.dispatchIntent, true); assert.equal(saved.turns.at(-1)!.outcome, "IntentPersisted");
      assert.equal(saved.turns.at(-1)!.turn, calls); assert.deepEqual(saved.turns.at(-1)!.request, request);
      const current = replayHand(saved.replay); const actorView = JSON.parse(request.messages[1].content) as PlayerView;
      assert.deepEqual(actorView, current.view(turn.seat)); assert.equal(actorView.actor, turn.seat); assert.equal(actorView.holeCards.length, 2);
      assert.equal("deck" in actorView, false); assert.equal("result" in actorView, false);
      for (const card of current.view(turn.seat === 0 ? 1 : 0).holeCards) assert.equal(actorView.holeCards.includes(card), false);
      const type = actorView.legalActions.some(action => action.type === "check") ? "check" : "call";
      return response(JSON.stringify({ type }), { model: "provider-secret", reasoning_content: "provider-secret" });
    } });
    assert.equal(session.phase, "Complete"); assert.equal(calls, 8); assert.equal(session.turns.length, calls);
    assert.equal(session.replay.deck.length, 52); assert.equal(new Set(session.replay.deck).size, 52);
    assert.equal(replayHand(session.replay).view(0).handStatus, "complete");
    const publicValue = publicLiveHand(session); assertPublic(publicValue); assert.equal(publicValue.result!.reason, "showdown"); assert.equal(publicValue.finalBoard.length, 5);
    assert.deepEqual(publicValue.attempts[0].usage, { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 });
    assert.equal((await stat(join(directory, "game"))).mode & 0o777, 0o700); assert.equal((await stat(join(directory, "game/session.json"))).mode & 0o777, 0o600);
    const replayed = await runLiveHand(directory, runConfig, { dispatch: async () => { throw new Error("NO_SECOND_DISPATCH"); } });
    assert.deepEqual(replayed, session);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("HTTP error, unknown delivery and invalid model response stop with no fold, winner or retry", async () => {
  const cases = [
    { dispatch: async () => Response.json({ error: "private error" }, { status: 503 }), outcome: "HTTPRejected", reason: "HOLDEM_UPSTREAM_HTTP_ERROR_NO_RETRY" },
    { dispatch: async () => { throw new Error("provider-secret"); }, outcome: "OutcomeUnknown", reason: "UNKNOWN_HTTP_RESULT_NO_REDISPATCH" },
    { dispatch: async () => response('{"type":"check"}'), outcome: "ResponseInvalid", reason: "HOLDEM_INVALID_OR_ILLEGAL_RESPONSE" },
    { dispatch: async () => response('{"type":"call","extra":true}'), outcome: "ResponseInvalid", reason: "HOLDEM_INVALID_OR_ILLEGAL_RESPONSE" },
    { dispatch: async () => response('{"type":"call"}', { choices: [{ finish_reason: "length", message: { role: "assistant", content: '{"type":"call"}' } }] }), outcome: "ResponseInvalid", reason: "HOLDEM_INVALID_OR_ILLEGAL_RESPONSE" },
    { dispatch: async () => response('{"type":"call"}', { choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"type":"call"}', tool_calls: [] } }] }), outcome: "ResponseInvalid", reason: "HOLDEM_INVALID_OR_ILLEGAL_RESPONSE" },
  ];
  for (const entry of cases) {
    const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-live-stop-")); let calls = 0; const runConfig = config();
    try {
      const session = await runLiveHand(directory, runConfig, { dispatch: async () => { calls++; return entry.dispatch(); } });
      assert.equal(session.phase, "Stopped"); assert.equal(session.reason, entry.reason); assert.equal(calls, 1);
      assert.equal(session.turns[0].outcome, entry.outcome); assert.deepEqual(session.replay.actions, []);
      assert.equal(publicLiveHand(session).result, null); assertPublic(publicLiveHand(session));
      await runLiveHand(directory, runConfig, { dispatch: async () => { calls++; throw new Error("NO_REDISPATCH"); } }); assert.equal(calls, 1);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }
});

test("twenty requests are a hard cap and deadline expiration applies no late response", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-live-cap-")); let calls = 0;
  try {
    const session = await runLiveHand(directory, config(), { dispatch: async request => {
      calls++; const view = JSON.parse(request.messages[1].content) as PlayerView;
      const raise = view.legalActions.find(action => action.type === "raise")!;
      assert.equal(raise.type, "raise"); return response(JSON.stringify({ type: "raise", to: raise.type === "raise" ? raise.minTo : 0 }));
    } });
    assert.equal(session.phase, "Stopped"); assert.equal(session.reason, "HOLDEM_CALL_LIMIT_REACHED"); assert.equal(calls, 20);
    assert.equal(session.replay.actions.length, 20); assert.equal(publicLiveHand(session).result, null);
  } finally { await rm(directory, { recursive: true, force: true }); }
  const lateDirectory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-live-late-"));
  try {
    const session = await runLiveHand(lateDirectory, config(80), { dispatch: async () => { await delay(100); return response('{"type":"call"}'); } });
    assert.equal(session.phase, "Stopped"); assert.equal(session.reason, "HOLDEM_DEADLINE_REACHED"); assert.equal(session.turns[0].outcome, "DeadlineExpired");
    assert.deepEqual(session.replay.actions, []); assert.equal(publicLiveHand(session).result, null);
  } finally { await rm(lateDirectory, { recursive: true, force: true }); }
});

test("persisted unknown dispatch stops offline before any new inference", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-live-recovery-")); const runConfig = config();
  try {
    const session = await runLiveHand(directory, runConfig, { dispatch: async () => { throw new Error("lost connection"); } });
    session.phase = "Running"; delete session.reason; session.turns[0].outcome = "IntentPersisted";
    const store = new SessionStore<LiveHandSession>(join(directory, "game")); await store.start(); try { await store.write(session); } finally { await store.close(); }
    let calls = 0;
    const recovered = await runLiveHand(directory, runConfig, { dispatch: async () => { calls++; return response('{"type":"call"}'); } });
    assert.equal(calls, 0); assert.equal(recovered.phase, "Stopped"); assert.equal(recovered.reason, "UNKNOWN_HTTP_RESULT_NO_REDISPATCH");
    assert.equal(recovered.turns[0].outcome, "OutcomeUnknown"); assert.deepEqual(recovered.replay.actions, []);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
