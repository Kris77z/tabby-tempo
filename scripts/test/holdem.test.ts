import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "../../packages/pi-loop/src/session.js";
import { createHand, replayHand, type Card } from "../../services/arena/src/holdem/index.js";
import { createHandWithDeckForTest, orderedDeck } from "../../services/arena/src/holdem/test-support.js";
import { read } from "../../services/underwriter/test/fixture.js";
import { createHoldemFixture, REWARD_INFERENCE_PRICE, SPONSORED_REWARD } from "../holdem-fixture.js";
import { buyRewardInference, holdemBalances, playControlledHand, runHoldemDemo, settleSponsoredHand } from "../holdem-demo.js";

function withoutSecrets(value: unknown) {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!["deck", "holeCards", "showdown", "rawTransaction"].includes(key), `Public report contains private ${key}`);
    withoutSecrets(child);
  }
}

test("unfinished and altered replays cannot win sponsor rewards; unknown transfers retain their original signature", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-reward-"));
  const local = await createHoldemFixture(directory);
  try {
    const hand = createHand({ initialStack: 1000, smallBlind: 5, bigBlind: 10 });
    const before = await holdemBalances(local);
    await assert.rejects(settleSponsoredHand(local, "unfinished", hand.exportTrustedReplay()), /REWARD_REQUIRES_COMPLETE_HAND/);
    assert.deepEqual(await holdemBalances(local), before); assert.equal(local.calls.length, 0);
    hand.act(0, { type: "fold" });
    const replay = hand.exportTrustedReplay(); assert.deepEqual(hand.view(0).result?.winners, [1]);
    const altered = structuredClone(replay); altered.actions[0].seat = 1;
    await assert.rejects(settleSponsoredHand(local, "altered", altered), /OUT_OF_TURN/);
    await assert.rejects(settleSponsoredHand(local, "altered", { ...replay, result: { winners: [0] } }));
    assert.deepEqual(await holdemBalances(local), before);

    const sign = local.sponsor.signTransaction.bind(local.sponsor); let signatures = 0;
    local.sponsor.signTransaction = async request => { signatures++; return sign(request); };
    const lookup = local.f.provider.getTransaction.bind(local.f.provider);
    const broadcast = local.f.provider.broadcastTransaction.bind(local.f.provider); let broadcastAccepted = false;
    local.f.provider.getTransaction = async hash => { if (broadcastAccepted) throw new Error("controlled receipt lookup loss"); return lookup(hash); };
    local.f.provider.broadcastTransaction = async raw => { await broadcast(raw); broadcastAccepted = true; throw new Error("controlled accepted broadcast reply loss"); };
    try { await assert.rejects(settleSponsoredHand(local, "unknown-original", replay), /RECORDED_TRANSACTION_UNCONFIRMED_USE_SAME_OUTPUT/); }
    finally { local.f.provider.getTransaction = lookup; local.f.provider.broadcastTransaction = broadcast; }
    assert.equal(signatures, 1); assert.equal(broadcastAccepted, true);
    const afterUnknown = await holdemBalances(local);
    assert.equal(before.sponsor - afterUnknown.sponsor, SPONSORED_REWARD);
    const journalBefore = JSON.parse(await readFile(local.rewardJournal.path, "utf8"));
    const originalEntry = Object.values(journalBefore)[0] as { rawTransaction: string; txHash: string };
    assert.ok(originalEntry.rawTransaction.startsWith("0x"));

    const reward = await settleSponsoredHand(local, "unknown-original", replay);
    assert.equal(signatures, 1); assert.deepEqual(reward.allocations, ["0", SPONSORED_REWARD.toString()]);
    assert.deepEqual(await holdemBalances(local), afterUnknown);
    assert.equal(reward.transfers[0].txHash, originalEntry.txHash);
    const afterReward = await holdemBalances(local); const sponsorNonce = await local.f.provider.getTransactionCount(local.sponsor.address);
    assert.equal(before.sponsor - afterReward.sponsor, SPONSORED_REWARD);
    assert.equal(afterReward.wallets[1] - before.wallets[1], SPONSORED_REWARD);
    const repeat = await settleSponsoredHand(local, "unknown-original", replay);
    assert.deepEqual(repeat, reward); assert.equal(signatures, 1); assert.deepEqual(await holdemBalances(local), afterReward);
    assert.equal(await local.f.provider.getTransactionCount(local.sponsor.address), sponsorNonce);
    await assert.rejects(settleSponsoredHand(local, "different-match", replay), /REWARD_OUTPUT_BINDING_MISMATCH/);
    await assert.rejects(buyRewardInference(local, 0, SPONSORED_REWARD), /INFERENCE_REQUIRES_CONFIRMED_AWARD/);

    const bought = await buyRewardInference(local, 1, SPONSORED_REWARD);
    assert.equal(bought.receipt.taskId, "0"); assert.equal(bought.receipt.fromCredit, "0"); assert.equal(bought.receipt.fromCash, REWARD_INFERENCE_PRICE.toString());
    const afterPurchase = await holdemBalances(local); const winnerNonce = await local.f.provider.getTransactionCount(local.signers[1].address);
    assert.equal(afterPurchase.wallets[1], before.wallets[1]); assert.equal(afterPurchase.cash[1] - before.cash[1], SPONSORED_REWARD - REWARD_INFERENCE_PRICE);
    assert.equal(afterPurchase.provider - before.provider, REWARD_INFERENCE_PRICE); assert.equal(afterPurchase.totalOutstanding, 0n);
    assert.equal((await read(local.f.manager, "getLoan", [0n])).status, 0n);
    assert.deepEqual(await buyRewardInference(local, 1, SPONSORED_REWARD), bought);
    assert.deepEqual(await holdemBalances(local), afterPurchase); assert.equal(local.calls.length, 1);
    assert.equal(await local.f.provider.getTransactionCount(local.signers[1].address), winnerNonce);
    const audit = JSON.parse(await readFile(join(local.privateDirectory, "trusted-replay.json"), "utf8"));
    assert.deepEqual(replayHand(audit).view(0).result, hand.view(0).result);
    assert.equal((await stat(join(local.privateDirectory, "trusted-replay.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(local.privateDirectory)).mode & 0o777, 0o700);
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});

test("a draw splits sponsor rewards; cached delivery recovers and unknown paid inference never redispatches", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-draw-"));
  const local = await createHoldemFixture(directory, { loseResponseOnCall: 2 });
  try {
    const top: Card[] = ["2c", "3c", "4d", "5d", "6h", "Ts", "Js", "Qs", "7h", "Ks", "8h", "As"];
    const hand = createHandWithDeckForTest({ initialStack: 1000, smallBlind: 5, bigBlind: 10 }, [...top, ...orderedDeck().filter(card => !top.includes(card))]);
    const before = await holdemBalances(local); playControlledHand(hand);
    assert.deepEqual(hand.view(0).result?.winners, [0, 1]);
    assert.deepEqual(await holdemBalances(local), before); assert.equal(local.calls.length, 0);
    const reward = await settleSponsoredHand(local, "royal-board-draw", hand.exportTrustedReplay());
    assert.deepEqual(reward.allocations, ["50000", "50000"]); assert.equal(reward.transfers.length, 2);
    const afterReward = await holdemBalances(local);
    assert.deepEqual(await settleSponsoredHand(local, "royal-board-draw", hand.exportTrustedReplay()), reward);
    assert.deepEqual(await holdemBalances(local), afterReward);
    for (const seat of [0, 1] as const) assert.equal(afterReward.wallets[seat] - before.wallets[seat], 50000n);
    const originalWrite = local.relay.store.write.bind(local.relay.store); let replyLoss = true;
    local.relay.store.write = async record => { await originalWrite(record); if (replyLoss && record.state === "Delivered") { replyLoss = false; throw new Error("controlled reply loss after Delivered commit"); } };
    try { await assert.rejects(buyRewardInference(local, 0, 50000n)); }
    finally { local.relay.store.write = originalWrite; }
    const paidCache = await holdemBalances(local); assert.equal(local.calls.length, 1);
    const recovered = await buyRewardInference(local, 0, 50000n);
    assert.equal(recovered.receipt.fromCredit, "0"); assert.equal(recovered.receipt.taskId, "0");
    assert.deepEqual(await holdemBalances(local), paidCache); assert.equal(local.calls.length, 1);
    await assert.rejects(buyRewardInference(local, 1, 50000n));
    const unknownPaid = await holdemBalances(local); const unknownNonce = await local.f.provider.getTransactionCount(local.signers[1].address);
    const unknownSession = JSON.parse(await readFile(join(local.privateDirectory, "inference-seat-1", "session.json"), "utf8"));
    assert.equal(unknownSession.dispatchIntent, true); assert.ok(unknownSession.handle.submission.rawTransaction);
    assert.equal(unknownSession.inference, undefined); assert.equal(local.calls.length, 2);
    for (let retry = 0; retry < 2; retry++) await assert.rejects(buyRewardInference(local, 1, 50000n), /REWARD_INFERENCE_UNKNOWN_NO_REDISPATCH/);
    assert.deepEqual(await holdemBalances(local), unknownPaid); assert.equal(local.calls.length, 2);
    assert.equal(await local.f.provider.getTransactionCount(local.signers[1].address), unknownNonce);
    const after = await holdemBalances(local);
    assert.equal(before.sponsor - after.sponsor, SPONSORED_REWARD);
    assert.deepEqual(after.wallets, before.wallets); assert.equal(after.cash[0] - before.cash[0], 40000n); assert.equal(after.cash[1] - before.cash[1], 40000n);
    assert.equal(after.provider - before.provider, 20000n); assert.equal(after.totalOutstanding, 0n); assert.equal(local.calls.length, 2);
    assert.ok(local.calls.every(call => !JSON.stringify(call.request).includes("holeCards")));
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});

test("random local demo reports conserved reward flow and publishes no private deck or player logs", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-report-")); const output = join(directory, "evidence");
  try {
    const report = await runHoldemDemo(output);
    assert.equal(report.verified, true); assert.equal(report.game.strategyInferenceCalls, 0); assert.equal(report.game.entryFee, "0");
    assert.equal(report.reward.rawAmount, SPONSORED_REWARD.toString()); assert.equal(report.reward.repeatedSettlementPaidAgain, false);
    assert.equal(report.inference.calls, report.game.result.winners.length); assert.equal(report.verification.fromCredit, "0");
    assert.deepEqual(report.balances.before, report.balances.afterGame);
    withoutSecrets(report);
    const publicFile = JSON.parse(await readFile(join(output, "report.json"), "utf8")); withoutSecrets(publicFile);
    const chain = JSON.parse(await readFile(join(output, "chain-evidence.json"), "utf8")); withoutSecrets(chain);
    assert.equal(chain.chainId, "31337"); assert.equal(chain.rewards.length, report.game.result.winners.length);
    assert.equal(chain.deposits.length, report.inference.calls); assert.equal(chain.inferencePayments.length, report.inference.calls);
    for (const entry of [...chain.rewards, ...chain.deposits, ...chain.inferencePayments]) {
      assert.equal(entry.receipt.status, 1); assert.equal(entry.transaction.hash, entry.receipt.hash); assert.ok(entry.receipt.logs.length);
    }
    assert.ok(report.limitations.some(value => value.includes("Anvil closes at exit")));
    const replay = JSON.parse(await readFile(join(output, ".private", "trusted-replay.json"), "utf8"));
    assert.equal(replay.deck.length, 52); assert.equal(replayHand(replay).view(0).handStatus, "complete");
    assert.equal((await stat(join(output, ".private", "trusted-replay.json"))).mode & 0o777, 0o600);
    await assert.rejects(runHoldemDemo(output), /HOLDEM_OUTPUT_MUST_BE_NEW/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("persisted dispatch intent without a payment handle pauses before any new deposit or inference", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-intent-")); const local = await createHoldemFixture(directory);
  try {
    const hand = createHand({ initialStack: 1000, smallBlind: 5, bigBlind: 10 }); hand.act(0, { type: "fold" });
    const reward = await settleSponsoredHand(local, "unknown-dispatch", hand.exportTrustedReplay());
    const store = new SessionStore(join(local.privateDirectory, "inference-seat-1")); await store.start();
    try { await store.write({ matchId: reward.matchId, replayDigest: reward.replayDigest, amount: SPONSORED_REWARD.toString(), dispatchIntent: true }); }
    finally { await store.close(); }
    const before = await holdemBalances(local); const nonce = await local.f.provider.getTransactionCount(local.signers[1].address);
    for (let retry = 0; retry < 2; retry++) await assert.rejects(buyRewardInference(local, 1, SPONSORED_REWARD), /REWARD_INFERENCE_UNKNOWN_NO_REDISPATCH/);
    assert.deepEqual(await holdemBalances(local), before); assert.equal(local.calls.length, 0);
    assert.equal(await local.f.provider.getTransactionCount(local.signers[1].address), nonce);
  } finally { await local.close(); await rm(directory, { recursive: true, force: true }); }
});
