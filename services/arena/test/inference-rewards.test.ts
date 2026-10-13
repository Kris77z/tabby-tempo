import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { INFERENCE_REWARD_POLICY, InferenceRewardLedger, type RewardDispatch, type RewardIdentity } from "../src/inference-rewards/index.js";
import { createKimiRewardDispatch } from "../src/inference-rewards/provider.js";
import { parseCreditCommand } from "../src/inference-rewards/http.js";

const players: [RewardIdentity, RewardIdentity] = [
  { agentId: "1998", wallet: "0x1111111111111111111111111111111111111111" },
  { agentId: "1999", wallet: "0x2222222222222222222222222222222222222222" },
];
const award = { grantId: "grant-1", matchId: "match-1", replayDigest: "a".repeat(64), players, winners: [0] as (0 | 1)[] };
const input = { redemptionId: "redeem-1", prompt: "Return OK.", maxCompletionTokens: 128 };
const answer = (extra: Record<string, unknown> = {}) => Response.json({ model: "kimi-k2.6",
  choices: [{ message: { role: "assistant", content: "OK" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 }, ...extra });
async function fixture(dispatch?: RewardDispatch) {
  const directory = await mkdtemp(join(tmpdir(), "arena-reward-test-"));
  const ledger = await InferenceRewardLedger.open(directory, { accounts: players, dispatch });
  return { directory, ledger, cleanup: async () => { await ledger.close(); await rm(directory, { recursive: true, force: true }); } };
}

test("trusted grants are persistent, unique by both match and grant, with fixed winning allocations", async () => {
  const f = await fixture();
  try {
    const grant = await f.ledger.grantTerminal(award);
    assert.deepEqual(grant.allocations, [4096, 0]);
    assert.deepEqual(await f.ledger.grantTerminal(award), grant);
    await assert.rejects(f.ledger.grantTerminal({ ...award, grantId: "other-grant" }), /GRANT_ID_BINDING_MISMATCH/);
    await assert.rejects(f.ledger.grantTerminal({ ...award, matchId: "other-match" }), /GRANT_ID_BINDING_MISMATCH/);
    await assert.rejects(f.ledger.grantTerminal({ ...award, winners: [1] }), /GRANT_ID_BINDING_MISMATCH/);
    const tie = await f.ledger.grantTerminal({ ...award, grantId: "tie", matchId: "tie-match", winners: [1, 0] });
    assert.deepEqual(tie.allocations, [2048, 2048]);
    assert.equal((await f.ledger.balance(players[0])).grantedTokens, 6144);
    assert.equal((await f.ledger.balance(players[1])).availableTokens, 2048);
    await f.ledger.close();
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players, recover: true });
    try { assert.deepEqual(await recovered.grantTerminal(award), grant); } finally { await recovered.close(); }
    assert.equal((await stat(f.directory)).mode & 0o777, 0o700);
    assert.equal((await stat(join(f.directory, "session.json"))).mode & 0o777, 0o600);
  } finally { await f.cleanup(); }
});

test("fixed accounts reject ownership changes and a live writer cannot be recovered", async () => {
  const f = await fixture();
  try {
    await assert.rejects(f.ledger.balance({ ...players[0], wallet: players[1].wallet }), /IDENTITY_NOT_AUTHORIZED/);
    await assert.rejects(f.ledger.grantTerminal({ ...award, players: [players[0], players[0]] }), /DISTINCT_PLAYERS/);
    await assert.rejects(InferenceRewardLedger.open(f.directory, { accounts: players, recover: true }), /SESSION_BUSY/);
    await f.ledger.close();
    await assert.rejects(InferenceRewardLedger.open(f.directory, { accounts: [players[0], { ...players[1], agentId: "2000" }] }), /LEDGER_BINDING_MISMATCH/);
  } finally { await f.cleanup(); }
});

test("real response usage charges once, releases reservation, and survives a cached retry after restart", async () => {
  let calls = 0;
  const f = await fixture(async request => { calls++; assert.equal(request.model, "kimi-k2.6"); return answer(); });
  try {
    await f.ledger.grantTerminal(award);
    const result = await f.ledger.redeem(players[0], input);
    assert.equal(result.status, "Completed"); assert.equal(result.content, "OK"); assert.equal(result.chargedTokens, 12);
    assert.deepEqual(result.usage, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 });
    assert.equal((await f.ledger.balance(players[0])).availableTokens, 4084);
    assert.deepEqual(await f.ledger.redeem(players[0], input), result);
    assert.equal(await f.ledger.redemption(players[1], input.redemptionId), null);
    await assert.rejects(f.ledger.redeem(players[1], input), /REDEMPTION_ID_BINDING_MISMATCH/);
    await assert.rejects(f.ledger.redeem(players[0], { ...input, prompt: "Changed" }), /REDEMPTION_ID_BINDING_MISMATCH/);
    await f.ledger.close();
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players, dispatch: async () => { calls++; throw new Error("must not call"); } });
    try {
      assert.deepEqual(await recovered.redeem(players[0], input), result);
      assert.equal((await recovered.balance(players[0])).reservedTokens, 0);
    } finally { await recovered.close(); }
    assert.equal(calls, 1);
    assert.ok(!Object.hasOwn(result, "request")); assert.ok(!Object.hasOwn(result, "response"));
  } finally { await f.cleanup(); }
});

test("concurrent same-ID requests dispatch once and concurrent budget admission cannot overspend", async () => {
  let calls = 0, release!: (response: Response) => void;
  const response = new Promise<Response>(resolve => { release = resolve; });
  const f = await fixture(async () => { calls++; return response; });
  try {
    await f.ledger.grantTerminal(award);
    const large = { ...input, prompt: "a".repeat(2500), maxCompletionTokens: 512 };
    const first = f.ledger.redeem(players[0], large);
    // Wait for the intent through the serialized query, without racing dispatch completion.
    while (!(await f.ledger.redemption(players[0], large.redemptionId))) await new Promise(resolve => setImmediate(resolve));
    const duplicate = await f.ledger.redeem(players[0], large);
    assert.equal(duplicate.status, "DispatchIntent");
    assert.equal((await f.ledger.balance(players[0])).reservedTokens, 3268);
    await assert.rejects(f.ledger.redeem(players[0], { ...large, redemptionId: "second" }), /INSUFFICIENT_AVAILABLE/);
    release(answer()); assert.equal((await first).status, "Completed"); assert.equal(calls, 1);
  } finally { release(answer()); await f.cleanup(); }
});

test("unknown dispatch retains its reservation and neither retry nor reopen dispatches again", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; throw new Error("socket reply lost"); });
  try {
    await f.ledger.grantTerminal(award);
    const result = await f.ledger.redeem(players[0], input);
    assert.equal(result.status, "OutcomeUnknown"); assert.equal(result.chargedTokens, undefined);
    const balance = await f.ledger.balance(players[0]);
    assert.equal(balance.reservedTokens, Buffer.byteLength(input.prompt) + 256 + 128);
    assert.equal(balance.consumedTokens, 0);
    assert.deepEqual(await f.ledger.redeem(players[0], input), result);
    await f.ledger.close();
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players, dispatch: async () => { calls++; return answer(); } });
    try { assert.deepEqual(await recovered.redeem(players[0], input), result); } finally { await recovered.close(); }
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("missing or contradictory supplier usage never becomes free success", async () => {
  for (const usage of [undefined, { total_tokens: 12 }, { prompt_tokens: 10, completion_tokens: 2, total_tokens: 0 },
    { prompt_tokens: 10, completion_tokens: 2, total_tokens: 13 }, { prompt_tokens: -1, completion_tokens: 2, total_tokens: 1 }]) {
    const f = await fixture(async () => answer({ usage }));
    try {
      await f.ledger.grantTerminal(award);
      assert.equal((await f.ledger.redeem(players[0], input)).status, "OutcomeUnknown");
      assert.ok((await f.ledger.balance(players[0])).reservedTokens > 0);
      assert.equal((await f.ledger.balance(players[0])).consumedTokens, 0);
    } finally { await f.cleanup(); }
  }
});

test("usage overrun records actual consumed tokens and deficit, then blocks new requests", async () => {
  const f = await fixture(async () => answer({ usage: { prompt_tokens: 4998, completion_tokens: 2, total_tokens: 5000 } }));
  try {
    await f.ledger.grantTerminal(award);
    const result = await f.ledger.redeem(players[0], input);
    assert.equal(result.status, "UsageOverrun"); assert.equal(result.chargedTokens, 5000);
    const balance = await f.ledger.balance(players[0]);
    assert.equal(balance.availableTokens, 0); assert.equal(balance.deficitTokens, 904);
    assert.equal(balance.reservedTokens, 0); assert.equal(balance.consumedTokens, 5000); assert.equal(balance.blocked, true);
    await assert.rejects(f.ledger.redeem(players[0], { ...input, redemptionId: "again" }), /BLOCKED_BY_USAGE_OVERRUN/);
    await f.ledger.close();
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players });
    try { assert.deepEqual(await recovered.balance(players[0]), balance); } finally { await recovered.close(); }
  } finally { await f.cleanup(); }
});

test("a nondeliverable response with authoritative usage is charged and cached as Failed", async () => {
  const f = await fixture(async () => answer({ choices: [{ message: { role: "assistant", content: "" }, finish_reason: "stop" }] }));
  try {
    await f.ledger.grantTerminal(award);
    assert.equal((await f.ledger.redeem(players[0], input)).status, "Failed");
    assert.equal((await f.ledger.balance(players[0])).consumedTokens, 12);
    assert.equal((await f.ledger.balance(players[0])).reservedTokens, 0);
  } finally { await f.cleanup(); }
});

test("durable response recovery settles without dispatch; persisted dispatch without response retains its reservation", async () => {
  for (const stage of ["ResponseRecorded", "DispatchIntent"] as const) {
    const f = await fixture(async () => answer());
    try {
      await f.ledger.grantTerminal(award); await f.ledger.redeem(players[0], input); await f.ledger.close();
      const path = join(f.directory, "session.json"); const state = JSON.parse(await readFile(path, "utf8"));
      const record = state.redemptions[0]; record.status = stage;
      delete record.chargedTokens; delete record.usage; delete record.content; delete record.finishReason;
      if (stage === "DispatchIntent") delete record.response;
      await writeFile(path, JSON.stringify(state));
      let calls = 0;
      const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players, dispatch: async () => { calls++; return answer(); } });
      try {
        const result = await recovered.redeem(players[0], input);
        assert.equal(result.status, stage === "ResponseRecorded" ? "Completed" : "OutcomeUnknown");
        assert.equal((await recovered.balance(players[0])).consumedTokens, stage === "ResponseRecorded" ? 12 : 0);
        assert.equal(calls, 0);
      } finally { await recovered.close(); }
    } finally { await f.cleanup(); }
  }
});

test("UTF-8 byte reservations cover multilingual prompts and malformed requests do not dispatch", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return answer(); });
  try {
    await f.ledger.grantTerminal(award);
    const result = await f.ledger.redeem(players[0], { ...input, prompt: "中文😀" });
    assert.equal(result.reservedTokens, 10 + 256 + 128);
    for (const bad of [{ ...input, prompt: "" }, { ...input, prompt: "字".repeat(3000) }, { ...input, maxCompletionTokens: 513 }])
      await assert.rejects(f.ledger.redeem(players[0], bad), /INVALID_INFERENCE_REQUEST/);
    await assert.rejects(f.ledger.redeem(players[1], { ...input, redemptionId: "no-award" }), /INSUFFICIENT_AVAILABLE/);
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});

test("fixed provider validates operator endpoints and makes exactly one bounded physical request", async () => {
  for (const baseUrl of ["http://api.moonshot.cn/v1", "https://attacker.invalid/v1", "https://api.moonshot.cn/v1?key=secret", "https://secret@api.moonshot.cn/v1"])
    assert.throws(() => createKimiRewardDispatch({ baseUrl, key: "test" }), /CONFIGURATION_REQUIRED/);
  let calls = 0;
  const dispatch = createKimiRewardDispatch({ baseUrl: "https://api.moonshot.cn/v1", key: "server-only", upstreamFetch: async (url, init) => {
    calls++; assert.equal(url, "https://api.moonshot.cn/v1/chat/completions"); assert.equal(init?.redirect, "error");
    assert.equal((init?.headers as Record<string, string>).authorization, "Bearer server-only");
    assert.equal(JSON.parse(init?.body as string).thinking.type, "disabled"); return answer();
  } });
  const f = await fixture(dispatch);
  try {
    await f.ledger.grantTerminal(award); await f.ledger.redeem(players[0], input);
    assert.equal(calls, 1); assert.equal(INFERENCE_REWARD_POLICY.inferenceRetries, 0);
    assert.ok(!(await readFile(join(f.directory, "session.json"), "utf8")).includes("server-only"));
  } finally { await f.cleanup(); }
});

test("credit commands cannot choose an identity, model, key, or URL; default output limit is bounded", () => {
  assert.deepEqual(parseCreditCommand({ action: "redeem", redemptionId: "unique-1", prompt: "OK" }),
    { action: "redeem", redemptionId: "unique-1", prompt: "OK", maxCompletionTokens: 128 });
  assert.deepEqual(parseCreditCommand({ action: "query", redemptionId: "unique-1" }), { action: "query", redemptionId: "unique-1" });
  for (const field of ["wallet", "agentId", "seat", "model", "key", "baseUrl", "winner", "allocations"])
    assert.throws(() => parseCreditCommand({ action: "redeem", redemptionId: "unique-1", prompt: "OK", [field]: "untrusted" }), /COMMAND_INVALID/);
  for (const value of [null, [], {}, { action: "query", redemptionId: "../escape" }, { action: "redeem", redemptionId: "a", prompt: "OK", maxCompletionTokens: 0 }])
    assert.throws(() => parseCreditCommand(value), /COMMAND_INVALID/);
});

test("explicit recovery reclaims a dead writer and corrupted recorded charges are rejected", async () => {
  const f = await fixture(async () => answer());
  try {
    await f.ledger.grantTerminal(award); await f.ledger.redeem(players[0], input); await f.ledger.close();
    await mkdir(join(f.directory, ".writer"));
    await writeFile(join(f.directory, ".writer", "owner.json"), JSON.stringify({ pid: 2147483647, token: "dead-writer" }));
    await assert.rejects(InferenceRewardLedger.open(f.directory, { accounts: players }), /RECOVERY_REQUIRED/);
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players, recover: true });
    try { assert.equal((await recovered.balance(players[0])).consumedTokens, 12); } finally { await recovered.close(); }
    const path = join(f.directory, "session.json"); const state = JSON.parse(await readFile(path, "utf8"));
    state.redemptions[0].chargedTokens = 2; state.redemptions[0].usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };
    await writeFile(path, JSON.stringify(state));
    await assert.rejects(InferenceRewardLedger.open(f.directory, { accounts: players }), /RECEIPT_MISMATCH/);
  } finally { await f.cleanup(); }
});

test("close drains an admitted redemption before releasing its durable writer", async () => {
  let release!: (response: Response) => void;
  const f = await fixture(async () => new Promise<Response>(resolve => { release = resolve; }));
  try {
    await f.ledger.grantTerminal(award);
    const result = f.ledger.redeem(players[0], input);
    const closing = f.ledger.close();
    await assert.rejects(f.ledger.redeem(players[0], { ...input, redemptionId: "later" }), /LEDGER_CLOSED/);
    while (!release) await new Promise(resolve => setImmediate(resolve));
    await assert.rejects(InferenceRewardLedger.open(f.directory, { accounts: players, recover: true }), /SESSION_BUSY/);
    release(answer()); assert.equal((await result).status, "Completed"); await closing;
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players });
    try { assert.equal((await recovered.balance(players[0])).consumedTokens, 12); } finally { await recovered.close(); }
  } finally { if (release) release(answer()); await f.cleanup(); }
});

test("task tool calls share rewards, meter actual usage, bind payload and survive restart without another dispatch", async () => {
  let calls = 0;
  const f = await fixture(async () => { calls++; return answer({ choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id: "sample", type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code: "print(9)" }) } }] } }] }); });
  const task = { redemptionId: "task:round:0", request: { model: "kimi-k2.6", messages: [{ role: "user", content: "Solve sum." }],
    max_completion_tokens: 256, tools: [{ type: "function", function: { name: "test_public_sample" } }] } };
  try {
    await assert.rejects(f.ledger.redeemChat(players[0], task), /INSUFFICIENT_AVAILABLE/); assert.equal(calls, 0);
    await f.ledger.grantTerminal(award);
    const record = await f.ledger.redeemChat(players[0], task);
    assert.equal(record.status, "Completed"); assert.equal(record.chargedTokens, 12);
    assert.ok(await f.ledger.taskResponse(players[0], task.redemptionId));
    assert.equal(await f.ledger.taskResponse(players[1], task.redemptionId), undefined);
    assert.equal(await f.ledger.taskUsage(players[0], "task:round:"), 12);
    assert.equal((await f.ledger.balance(players[0])).availableTokens, 4084);
    await assert.rejects(f.ledger.redeemChat(players[0], { ...task, request: { ...task.request, model: "another-model" } }), /INVALID_TASK/);
    await assert.rejects(f.ledger.redeemChat(players[0], { ...task, request: { ...task.request, messages: [{ role: "user", content: "Changed" }] } }), /BINDING_MISMATCH/);
    await f.ledger.close();
    const recovered = await InferenceRewardLedger.open(f.directory, { accounts: players, dispatch: async () => { throw new Error("must not dispatch"); } });
    try { assert.deepEqual(await recovered.redeemChat(players[0], task), record); } finally { await recovered.close(); }
    assert.equal(calls, 1);
  } finally { await f.cleanup(); }
});
