import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { saveJson } from "../demo-common.js";
import { buildHoldemMonadPlan, executeHoldemMonadDelivery, HOLDEM_MONAD_REWARD } from "../holdem-monad.js";
import { canonicalFixture, source } from "./holdem-monad-fixture.js";

test("trusted local source rejects controlled mode, incomplete games and changed replay digests", { timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-holdem-monad-source-")));
  const f = await canonicalFixture(directory);
  try {
    const reportPath = join(f.config.sourceDirectory, "report.json"), original = JSON.parse(await readFile(reportPath, "utf8"));
    await saveJson(reportPath, { ...original, upstreamMode: "controlled-upstream" });
    await assert.rejects(buildHoldemMonadPlan(f.config), /HOLDEM_COMPLETE_REAL_LOCAL_RUN_REQUIRED/);
    await saveJson(reportPath, { ...original, reward: { ...original.reward, replayDigest: "0".repeat(64) } });
    await assert.rejects(buildHoldemMonadPlan(f.config), /HOLDEM_SOURCE_REPLAY_DIGEST_MISMATCH/);
    await saveJson(reportPath, { ...original, game: { result: { ...original.game.result, winners: [0] } } });
    await assert.rejects(buildHoldemMonadPlan(f.config), /HOLDEM_SOURCE_RESULT_MISMATCH/);
    const other = join(directory, "unfinished"); await source(other, false);
    await assert.rejects(buildHoldemMonadPlan({ ...f.config, sourceDirectory: other }), /HOLDEM_COMPLETE_TRUSTED_REPLAY_REQUIRED/);
    assert.equal(await f.token.getFunction("balanceOf").staticCall(f.sponsor.address), 1000000n);
    await assert.rejects(executeHoldemMonadDelivery({ ...f.plan, chainId: "31337" as any }, f.runtime, f), /HOLDEM_FIXED_MONAD_BINDING_REQUIRED/);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});

test("Monad award+deposit reuses the accepted original signature and conserved cash with zero loans", { timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-holdem-monad-journal-")));
  const f = await canonicalFixture(directory);
  try {
    const sponsorSign = f.sponsor.signTransaction.bind(f.sponsor), playerSign = f.players[1].signTransaction.bind(f.players[1]);
    let sponsorSignatures = 0, playerSignatures = 0;
    f.sponsor.signTransaction = async request => { sponsorSignatures++; return sponsorSign(request); };
    f.players[1].signTransaction = async request => { playerSignatures++; return playerSign(request); };
    const lookup = f.provider.getTransaction.bind(f.provider), broadcast = f.provider.broadcastTransaction.bind(f.provider);
    let accepted = false;
    f.provider.getTransaction = async hash => { if (accepted) throw new Error("controlled lookup reply loss"); return lookup(hash); };
    f.provider.broadcastTransaction = async raw => { await broadcast(raw); accepted = true; throw new Error("controlled accepted reply loss"); };
    try { await assert.rejects(executeHoldemMonadDelivery(f.plan, f.runtime, f), /RECORDED_TRANSACTION_UNCONFIRMED_USE_SAME_OUTPUT/); }
    finally { f.provider.getTransaction = lookup; f.provider.broadcastTransaction = broadcast; }
    assert.equal(sponsorSignatures, 1); assert.equal(playerSignatures, 0);
    const journalPath = join(f.plan.journalDirectory, "transactions.json"), originalJournal = JSON.parse(await readFile(journalPath, "utf8"));
    const originalTx = Object.values(originalJournal)[0] as { txHash: string; rawTransaction: string };
    assert.equal(await f.token.getFunction("balanceOf").staticCall(f.players[1].address), HOLDEM_MONAD_REWARD);
    const result: any = await executeHoldemMonadDelivery(f.plan, f.runtime, f);
    assert.equal(result.phase, "RewardDeposited"); assert.equal(result.fullAcceptanceComplete, false);
    assert.equal(sponsorSignatures, 1); assert.equal(playerSignatures, 2);
    assert.equal(result.operations[0].txHash, originalTx.txHash); assert.equal(result.operations.length, 3);
    assert.equal(await f.token.getFunction("balanceOf").staticCall(f.sponsor.address), 900000n);
    assert.equal(await f.token.getFunction("balanceOf").staticCall(f.players[1].address), 0n);
    assert.equal(await f.account.getFunction("cash").staticCall(2n), HOLDEM_MONAD_REWARD);
    assert.equal(await f.manager.getFunction("totalOutstanding").staticCall(), 0n);
    assert.equal((await f.manager.getFunction("getLoan").staticCall(0n)).status, 0n);
    const sponsorNonce = await f.provider.getTransactionCount(f.sponsor.address), playerNonce = await f.provider.getTransactionCount(f.players[1].address);
    assert.deepEqual(await executeHoldemMonadDelivery(f.plan, f.runtime, f), result);
    assert.equal(sponsorSignatures, 1); assert.equal(playerSignatures, 2);
    assert.equal(await f.provider.getTransactionCount(f.sponsor.address), sponsorNonce);
    assert.equal(await f.provider.getTransactionCount(f.players[1].address), playerNonce);
    await assert.rejects(executeHoldemMonadDelivery({ ...f.plan, configDigest: "changed" }, f.runtime, f), /HOLDEM_DELIVERY_BINDING_MISMATCH/);
    const journal = JSON.parse(await readFile(journalPath, "utf8"));
    const id = Object.keys(journal)[0]; journal[id].txHash = "0x" + "0".repeat(64); await saveJson(journalPath, journal);
    await assert.rejects(executeHoldemMonadDelivery(f.plan, f.runtime, f), /HOLDEM_JOURNAL_BINDING_MISMATCH/);
    assert.equal(sponsorSignatures, 1); assert.equal(playerSignatures, 2);
    assert.equal((await stat(f.plan.journalDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(journalPath)).mode & 0o777, 0o600);
    const report = await readFile(join(f.config.sourceDirectory, "monad-delivery-report.json"), "utf8");
    assert.ok(!report.includes("rawTransaction")); assert.ok(!report.includes(f.sponsor.privateKey)); assert.ok(!report.includes("controlled.invalid"));
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
