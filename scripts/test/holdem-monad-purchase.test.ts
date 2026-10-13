import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../packages/pi-loop/src/session.js";
import { canonicalFixture } from "./holdem-monad-fixture.js";
import { executeHoldemMonadDelivery } from "../holdem-monad.js";
import { buildHoldemMonadPurchasePlan, executeHoldemMonadPurchase, HOLDEM_PURCHASE_POLICY, main, verifyHoldemAwardDeposits } from "../holdem-monad-purchase.js";

const upstream = { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", key: "controlled-purchase-secret" };
const completion = () => Response.json({ model: "kimi-k2.6", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Reward-funded inference confirmed." } }],
  usage: { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 } });
async function prepared(name: string) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), name))), f = await canonicalFixture(directory);
  await executeHoldemMonadDelivery(f.plan, f.runtime, f);
  const { plan } = await buildHoldemMonadPurchasePlan(f.config);
  return { directory, f, plan };
}
function noPrivate(value: unknown) {
  const body = JSON.stringify(value);
  for (const key of ["rawTransaction", "controlled-purchase-secret", "rawText", "keyFile", "messages", "holeCards", '"deck":', "controlled.invalid"])
    assert.equal(body.includes(key), false, `public report includes ${key}`);
}

test("purchase policy is bounded and unsupported CLI recovery cannot dispatch", async () => {
  assert.equal(HOLDEM_PURCHASE_POLICY.service, "holdem-reward"); assert.equal(HOLDEM_PURCHASE_POLICY.model, "kimi-k2.6");
  assert.equal(HOLDEM_PURCHASE_POLICY.priceRaw, "10000"); assert.equal(HOLDEM_PURCHASE_POLICY.taskId, "0");
  assert.equal(HOLDEM_PURCHASE_POLICY.maxCompletionTokens, 128); assert.equal(HOLDEM_PURCHASE_POLICY.maxPurchasesPerAwardedSeat, 1);
  assert.equal(HOLDEM_PURCHASE_POLICY.quoteTtl, 300); assert.equal(HOLDEM_PURCHASE_POLICY.inferenceRetries, 0); assert.equal(HOLDEM_PURCHASE_POLICY.tools, false);
  await assert.rejects(main([]), /HOLDEM_PURCHASE_CONFIG_REQUIRED/);
  await assert.rejects(main(["--config", "/unused", "--recover"]), /HOLDEM_RECOVER_REQUIRES_EXECUTE/);
});

test("purchase accepts only bound confirmed reward and deposit receipts", { timeout: 120000 }, async () => {
  const { directory, f, plan } = await prepared("agentfuel-holdem-purchase-binding-");
  try {
    await verifyHoldemAwardDeposits(plan, f.runtime);
    const changed = structuredClone(plan); changed.deliveryReport.operations[0].amount = "10001";
    await assert.rejects(verifyHoldemAwardDeposits(changed, f.runtime), /HOLDEM_PURCHASE_NONCANONICAL_DELIVERY_RECEIPT/);
    const reorg = structuredClone(plan); reorg.deliveryReport.operations[0].blockHash = "0x" + "0".repeat(64);
    await assert.rejects(verifyHoldemAwardDeposits(reorg, f.runtime), /HOLDEM_PURCHASE_NONCANONICAL_DELIVERY_RECEIPT/);
    const redirect = structuredClone(plan); redirect.delivery.players[1].agentId = "1";
    await assert.rejects(verifyHoldemAwardDeposits(redirect, f.runtime), /HOLDEM_PURCHASE_DELIVERY_SOURCE_MISMATCH/);
    assert.equal(await f.account.getFunction("cash").staticCall(2n), 100000n);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("one winner buys once with cash; Delivered cache restores without another signature or physical call", { timeout: 120000 }, async () => {
  const { directory, f, plan } = await prepared("agentfuel-holdem-purchase-delivered-"); let calls = 0, signatures = 0;
  const sign = f.players[1].signTransaction.bind(f.players[1]); f.players[1].signTransaction = async request => { signatures++; return sign(request); };
  try {
    const report = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async (url, init) => {
      calls++; assert.equal(String(url), "https://api.moonshot.cn/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${upstream.key}`);
      const body = JSON.parse(String(init?.body)); assert.equal(body.model, "kimi-k2.6"); assert.equal(body.max_completion_tokens, 128);
      assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.stream, false); assert.equal(body.tools, undefined);
      assert.equal(body.agentId, undefined); assert.equal(body.taskId, undefined); assert.equal(body.service, undefined);
      const saved = JSON.parse(await readFile(join(plan.journalDirectory, "session.json"), "utf8"));
      assert.equal(saved.entries.length, 1); assert.equal(saved.entries[0].dispatchIntent, true);
      assert.equal(saved.entries[0].physicalAttempt.dispatchIntent, true); assert.ok(saved.entries[0].handle.submission.rawTransaction);
      return completion();
    } });
    assert.equal(report.stage, "RewardInferenceComplete"); assert.equal(report.phase, "Complete"); assert.equal(report.upstreamMode, "controlled-upstream");
    assert.equal(report.source.matchId, plan.delivery.source.matchId); assert.equal(report.chainId, "10143"); assert.equal(report.physicalInferenceAttempts, 1);
    assert.equal(report.purchases[0].seat, 1); assert.equal(report.purchases[0].agentId, "2"); assert.equal(report.purchases[0].cashBefore, "100000"); assert.equal(report.purchases[0].cashAfter, "90000");
    assert.equal(report.purchases[0].receipt!.taskId, "0"); assert.equal(report.purchases[0].receipt!.fromCredit, "0"); assert.equal(report.purchases[0].receipt!.fromCash, "10000");
    assert.equal(report.purchases[0].taskCompleted, true); assert.deepEqual(report.purchases[0].usage, { prompt_tokens: 15, completion_tokens: 6, total_tokens: 21 });
    assert.equal(report.verification.zeroDebt, true); assert.equal(report.verification.cashConserved, true); assert.equal(report.verification.totalPaidRaw, "10000");
    assert.equal(report.evidence.paymentReceiptsCanonical, true); assert.equal(calls, 1); assert.equal(signatures, 1); noPrivate(report);
    assert.equal(await f.account.getFunction("cash").staticCall(2n), 90000n); assert.equal(await f.token.getFunction("balanceOf").staticCall(f.plan.provider), 10000n);
    const nonce = await f.provider.getTransactionCount(f.players[1].address);
    const recovered = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async () => { calls++; throw new Error("NO_NEW_MODEL_CALL"); } });
    assert.equal(recovered.stage, "RewardInferenceComplete"); assert.equal(recovered.physicalInferenceAttempts, 1); assert.equal(calls, 1); assert.equal(signatures, 1);
    assert.equal(await f.provider.getTransactionCount(f.players[1].address), nonce);
    const raw = JSON.parse(await readFile(join(plan.journalDirectory, "seat-1-payment-receipt.json"), "utf8")); assert.equal(raw.status, 1); assert.equal(raw.hash, report.purchases[0].receipt!.txHash);
    assert.equal((await stat(plan.journalDirectory)).mode & 0o777, 0o700); assert.equal((await stat(join(plan.journalDirectory, "session.json"))).mode & 0o777, 0o600);
    noPrivate(JSON.parse(await readFile(join(f.config.sourceDirectory, "monad-purchase-report.json"), "utf8")));
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("unknown paid upstream remains stopped and cannot sign or request a second time", { timeout: 120000 }, async () => {
  const { directory, f, plan } = await prepared("agentfuel-holdem-purchase-unknown-"); let calls = 0, signatures = 0;
  const sign = f.players[1].signTransaction.bind(f.players[1]); f.players[1].signTransaction = async request => { signatures++; return sign(request); };
  try {
    const report = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async () => { calls++; throw new Error("LOST_RESPONSE"); } });
    assert.equal(report.stage, "Stopped"); assert.equal(report.purchases[0].state, "Unknown"); assert.equal(report.physicalInferenceAttempts, 1); assert.equal(calls, 1); assert.equal(signatures, 1);
    assert.equal(report.purchases[0].receipt!.fromCash, "10000"); assert.equal(report.purchases[0].receipt!.fromCredit, "0");
    assert.equal(report.verification.totalPaidRaw, "10000"); assert.equal(report.verification.zeroDebt, true);
    assert.equal(await f.account.getFunction("cash").staticCall(2n), 90000n);
    const again = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async () => { calls++; return completion(); } });
    assert.equal(again.stage, "Stopped"); assert.equal(again.purchases[0].error, "HOLDEM_PURCHASE_UNKNOWN_NO_REDISPATCH"); assert.equal(calls, 1); assert.equal(signatures, 1);
    assert.equal(await f.account.getFunction("cash").staticCall(2n), 90000n); noPrivate(again);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a lost SDK delivery reply recovers the Delivered cache without another model request or payment", { timeout: 120000 }, async () => {
  const { directory, f, plan } = await prepared("agentfuel-holdem-purchase-reply-loss-"); let calls = 0, signatures = 0, lost = false;
  const sign = f.players[1].signTransaction.bind(f.players[1]); f.players[1].signTransaction = async request => { signatures++; return sign(request); };
  const originalFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (input, init) => {
      const response = await originalFetch(input, init);
      if (!lost && response.ok && new Headers(init?.headers).has("x-payment-id")) { lost = true; throw new Error("LOST_DELIVERED_SDK_REPLY"); }
      return response;
    };
    const first = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async () => { calls++; return completion(); } });
    globalThis.fetch = originalFetch;
    assert.equal(lost, true); assert.equal(first.stage, "Stopped"); assert.equal(first.purchases[0].state, "Unknown");
    assert.equal(first.verification.totalPaidRaw, "10000"); assert.equal(calls, 1); assert.equal(signatures, 1);
    const recovered = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async () => { calls++; throw new Error("NO_RETRY"); } });
    assert.equal(recovered.stage, "RewardInferenceComplete"); assert.equal(recovered.purchases[0].taskCompleted, true); assert.equal(calls, 1); assert.equal(signatures, 1);
    assert.equal(recovered.physicalInferenceAttempts, 1); assert.equal(recovered.purchases[0].cashAfter, "90000"); noPrivate(recovered);
  } finally { globalThis.fetch = originalFetch; await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("persisted intent without a handle cannot create a quote, payment or model dispatch", { timeout: 120000 }, async () => {
  const { directory, f, plan } = await prepared("agentfuel-holdem-purchase-intent-");
  try {
    const store = new SessionStore<any>(plan.journalDirectory); await store.start();
    try { await store.write({ version: 1, binding: plan, upstreamMode: "controlled-upstream",
      before: { blockNumber: plan.deliveryReport.balances.afterDeposit.blockNumber, blockHash: plan.deliveryReport.balances.afterDeposit.blockHash,
        cash: ["0", "100000"], providerToken: "0", totalOutstanding: "0", task0LoanStatus: "0" },
      entries: [{ seat: 1, agentId: "2", wallet: f.players[1].address, awardRaw: "100000", cashBefore: "100000", dispatchIntent: true, state: "Unknown" }] }); }
    finally { await store.close(); }
    let calls = 0;
    const nonce = await f.provider.getTransactionCount(f.players[1].address);
    const report = await executeHoldemMonadPurchase(plan, f.runtime, f.players, upstream, { controlledUpstream: async () => { calls++; return completion(); } });
    assert.equal(report.stage, "Stopped"); assert.equal(report.purchases[0].error, "HOLDEM_PURCHASE_UNKNOWN_NO_REDISPATCH"); assert.equal(calls, 0);
    assert.equal(report.physicalInferenceAttempts, 0); assert.equal(report.verification.totalPaidRaw, "0"); assert.equal(report.purchases[0].cashAfter, "100000");
    assert.equal(await f.provider.getTransactionCount(f.players[1].address), nonce); assert.equal(await f.account.getFunction("cash").staticCall(2n), 100000n);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
