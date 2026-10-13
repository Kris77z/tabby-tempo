import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fixtureHoldemReport, loadHoldemSnapshot, readHoldemReport, sanitizeHoldemDelivery, sanitizeHoldemPurchase, sanitizeHoldemReport } from "../lib/holdem-report";

function live(phase: string = "Complete") {
  const example = fixtureHoldemReport();
  return { ...example, mode: "holdem-live", phase, network: "local-anvil", upstreamMode: "controlled-upstream", evidence: { publicReplayVerified: phase === "Complete", chainEvidenceFile: "chain-evidence.json" }, strategyInference: { calls: 1, maxCalls: 20, vendorInvoiceVerified: false, attempts: [{ turn: 0, seat: 0, requestedModel: "kimi-k2.6", outcome: "Applied", status: 200, durationMs: 80, usage: { total_tokens: 14 } }] } };
}

test("public projection removes private cards, keys, prompts, signed bytes and arbitrary source text at every level", () => {
  const secret = "PRIVATE_SENTINEL_DO_NOT_PUBLISH", input = live();
  const contaminated = { ...input, apiKey: secret, scope: secret, reason: `Upstream failed with ${secret}`, private: { deck: secret }, limitations: [secret],
    game: { ...input.game, deck: [secret], holeCards: [secret], steps: input.game.steps.map(step => ({ ...step, holeCards: [secret], actorView: { key: secret }, action: { ...step.action, signature: secret } })), result: { ...input.game.result, showdown: secret } },
    reward: { ...input.reward!, rawTransaction: secret, source: secret, transfers: input.reward!.transfers.map(item => ({ ...item, signedBytes: secret })) },
    inference: { ...input.inference!, purchases: input.inference!.purchases.map(item => ({ ...item, controlledResponse: { content: secret }, receipt: { ...item.receipt, request: secret, authorization: secret } })) },
    strategyInference: { ...input.strategyInference, funding: secret, attempts: input.strategyInference.attempts.map(item => ({ ...item, prompt: secret, response: secret, usage: { ...item.usage, apiKey: secret } })) },
  };
  const output = sanitizeHoldemReport(contaminated), serialized = JSON.stringify(output);
  assert.equal(serialized.includes(secret), false);
  assert.equal(output.reason, undefined);
  assert.equal(output.strategy, "controlled-model");
  assert.deepEqual(Object.keys(output.game.steps[0]), ["seat", "street", "action", "board", "stacks", "pot"]);
  assert.equal(output.inference!.purchases[0].receipt.fromCredit, "0");
  assert.equal(output.strategyInference!.attempts[0].usage!.total_tokens, 14);
});

test("running, starting and stopped live reports support partial balances and never invent a terminal winner", () => {
  for (const phase of ["Starting", "Running", "Stopped", "PreflightFailed"]) {
    const input = live(phase);
    const output = sanitizeHoldemReport({ ...input, verified: false, game: { ...input.game, steps: phase === "Starting" || phase === "PreflightFailed" ? [] : input.game.steps.slice(0, 2), result: null, finalBoard: [] }, reward: null, inference: null, balances: { before: input.balances!.before, ...(phase === "Stopped" ? { afterGame: input.balances!.afterGame } : {}) } });
    assert.equal(output.phase, phase);
    assert.equal(output.game.result, null);
    assert.equal(output.reward, null);
    assert.equal(output.inference, null);
    assert.equal(output.balances!.afterPurchase, undefined);
  }
  const input = live("SettlementUncertain");
  const output = sanitizeHoldemReport({ ...input, verified: false, inference: null });
  assert.equal(output.game.result!.winners[0], 0);
  assert.equal(output.verified, false);
  assert.throws(() => sanitizeHoldemReport({ ...input, phase: "Stopped" }), /HOLDEM_REPORT_INVALID/);
});

test("network and model modes come from validated public facts; inconsistent receipts and malformed cards fail", () => {
  const input = live();
  assert.equal(sanitizeHoldemReport({ ...input, upstreamMode: "real-kimi-system-https-proxy" }).strategy, "real-model");
  assert.equal(sanitizeHoldemReport(input).network, "local-anvil");
  const monad = { ...input, network: "monad", chainEvidence: { chainId: "10143" }, inference: null };
  assert.equal(sanitizeHoldemReport(monad).network, "monad-testnet");
  assert.throws(() => sanitizeHoldemReport({ ...input, chainEvidence: { chainId: "10143" } }), /HOLDEM_REPORT_INVALID/);
  assert.throws(() => sanitizeHoldemReport({ ...input, game: { ...input.game, finalBoard: ["Ah", "Ah"] } }), /HOLDEM_REPORT_INVALID/);
  assert.throws(() => sanitizeHoldemReport({ ...input, phase: "SecretError" }), /HOLDEM_REPORT_INVALID/);
});

test("only configured public report.json is readable, including realpath private-directory protection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "holdem-public-reader-"));
  try {
    const input = live(), publicPath = join(directory, "report.json"), privateDir = join(directory, ".private");
    await writeFile(publicPath, JSON.stringify(input));
    assert.equal((await readHoldemReport(publicPath)).matchId, "fixture-heads-up");
    await mkdir(privateDir);
    await writeFile(join(privateDir, "report.json"), JSON.stringify(input));
    await mkdir(join(directory, "link"));
    await symlink(join(privateDir, "report.json"), join(directory, "link", "report.json"));
    await assert.rejects(readHoldemReport(join(privateDir, "report.json")), /HOLDEM_REPORT_INVALID/);
    await assert.rejects(readHoldemReport(join(directory, "link", "report.json")), /HOLDEM_REPORT_INVALID/);
    await assert.rejects(readHoldemReport(join(directory, "session.json")), /HOLDEM_REPORT_INVALID/);
    await assert.rejects(readHoldemReport("report.json"), /HOLDEM_REPORT_INVALID/);
    await writeFile(publicPath, "invalid JSON");
    const failed = await loadHoldemSnapshot(publicPath);
    assert.equal(failed.source, "report");
    assert.equal(failed.report, null);
    assert.equal(failed.error!.code, "HOLDEM_REPORT_UNAVAILABLE");
    assert.equal(JSON.stringify(failed).includes(directory), false);
    const fixture = await loadHoldemSnapshot("");
    assert.equal(fixture.source, "fixture");
    assert.equal(fixture.report!.strategy, "scripted");
  } finally { await rm(directory, { recursive: true, force: true }); }
});

function linkedMonad() {
  const example = live(), input = { ...example, upstreamMode: "real-kimi-system-https-proxy", reward: { ...example.reward!, replayDigest: "a".repeat(64) } };
  const sourceBytes = JSON.stringify(input), reportDigest = createHash("sha256").update(sourceBytes).digest("hex"), report = sanitizeHoldemReport(input);
  const tx = `0x${"b".repeat(64)}`;
  const before = { blockNumber: 1, walletsToken: ["200000", "0"], cash: ["0", "0"], providerToken: "0", totalOutstanding: "0" };
  const deliveryInput = { version: 1, mode: "holdem-monad", phase: "RewardDeposited", chainId: "10143", stageComplete: true, fullAcceptanceComplete: false,
    plan: { chainId: "10143", source: { matchId: report.matchId, reportDigest, replayDigest: report.reward!.replayDigest, network: "local-anvil", upstreamMode: "real-kimi-system-https-proxy", wallets: ["PRIVATE_WALLET"] }, asset: { symbol: "USDC", decimals: 6 }, entryFee: "0", reward: "100000", allocations: ["100000", "0"], players: [{ seat: 0, agentId: "1842" }, { seat: 1, agentId: "1843" }], signatureRoles: { privateKey: "PRIVATE_SENTINEL" } },
    balances: { before, afterAward: { ...before, blockNumber: 2, walletsToken: ["300000", "0"] }, afterDeposit: { ...before, blockNumber: 3, cash: ["100000", "0"] } },
    operations: ["reward", "approve", "deposit"].map(kind => ({ kind, seat: 0, amount: "100000", txHash: tx, blockNumber: 3, raw: "PRIVATE_SENTINEL", receipt: { hash: tx, blockNumber: 3, status: 1, signedBytes: "PRIVATE_SENTINEL" }, transaction: { hash: tx, chainId: "10143", raw: "PRIVATE_SENTINEL" } })),
    verification: { rewardConserved: true, newBorrowingRaw: "0", totalOutstandingUnchanged: true } };
  const deliveryBytes = JSON.stringify(deliveryInput), deliveryDigest = createHash("sha256").update(deliveryBytes).digest("hex"), delivery = sanitizeHoldemDelivery(deliveryInput, report, reportDigest);
  const purchaseInput = { version: 1, mode: "holdem-monad-purchase", phase: "Complete", stage: "RewardInferenceComplete", chainId: "10143", upstreamMode: "real-kimi-system-https-proxy", source: { matchId: report.matchId, reportDigest, replayDigest: report.reward!.replayDigest, deliveryReportDigest: deliveryDigest }, model: "kimi-k2.6", priceRaw: "10000", taskId: "0", maxPurchasesPerAwardedSeat: 1, physicalInferenceAttempts: 1,
    purchases: [{ seat: 0, agentId: "1842", awardRaw: "100000", cashBefore: "100000", cashAfter: "90000", state: "Delivered", taskCompleted: true, privatePrompt: "PRIVATE_SENTINEL", response: "PRIVATE_SENTINEL", receipt: { txHash: tx, blockNumber: 4, chainId: "10143", agentId: "1842", taskId: "0", fromCash: "10000", fromCredit: "0", signature: "PRIVATE_SENTINEL" }, usage: { total_tokens: 25, privateApiKey: "PRIVATE_SENTINEL" } }],
    verification: { fromCredit: "0", newBorrowingRaw: "0", zeroDebt: true, cashConserved: true, totalPaidRaw: "10000" }, evidence: { paymentReceiptsCanonical: true } };
  return { sourceBytes, report, reportDigest, deliveryInput, deliveryBytes, deliveryDigest, delivery, purchaseInput };
}

test("Monad delivery and purchase whitelist output and bind exact source and delivery digests", () => {
  const data = linkedMonad();
  const purchase = sanitizeHoldemPurchase(data.purchaseInput, data.report, data.reportDigest, data.delivery, data.deliveryDigest);
  assert.equal(JSON.stringify(data.delivery).includes("PRIVATE_"), false);
  assert.equal(JSON.stringify(purchase).includes("PRIVATE_"), false);
  assert.equal(purchase.phase, "Complete");
  assert.equal(purchase.purchases[0].receipt!.fromCredit, "0");
  assert.throws(() => sanitizeHoldemDelivery(data.deliveryInput, { ...data.report, matchId: "foreign-match" }, data.reportDigest), /HOLDEM_REPORT_INVALID/);
  assert.throws(() => sanitizeHoldemDelivery(data.deliveryInput, data.report, "c".repeat(64)), /HOLDEM_REPORT_INVALID/);
  assert.throws(() => sanitizeHoldemPurchase(data.purchaseInput, data.report, data.reportDigest, data.delivery, "c".repeat(64)), /HOLDEM_REPORT_INVALID/);
  assert.throws(() => sanitizeHoldemPurchase({ ...data.purchaseInput, purchases: data.purchaseInput.purchases.map(item => ({ ...item, state: "Unknown" })) }, data.report, data.reportDigest, data.delivery, data.deliveryDigest), /HOLDEM_REPORT_INVALID/);
  const unknown = sanitizeHoldemPurchase({ ...data.purchaseInput, phase: "Stopped", purchases: data.purchaseInput.purchases.map(item => ({ ...item, state: "Unknown", taskCompleted: false, cashAfter: undefined })) }, data.report, data.reportDigest, data.delivery, data.deliveryDigest);
  assert.equal(unknown.phase, "Stopped");
  assert.equal(unknown.purchases[0].state, "Unknown");
});

test("optional Monad files fail separately without replacing the valid game report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "holdem-monad-public-")), data = linkedMonad();
  try {
    const source = join(directory, "report.json"), delivery = join(directory, "monad-delivery-report.json"), purchase = join(directory, "monad-purchase-report.json");
    await writeFile(source, data.sourceBytes); await writeFile(delivery, data.deliveryBytes); await writeFile(purchase, JSON.stringify(data.purchaseInput));
    const complete = await loadHoldemSnapshot(source, delivery, purchase);
    assert.equal(complete.report!.matchId, data.report.matchId);
    assert.equal(complete.delivery!.phase, "RewardDeposited");
    assert.equal(complete.purchase!.phase, "Complete");
    await writeFile(delivery, JSON.stringify({ ...data.deliveryInput, plan: { ...data.deliveryInput.plan, source: { ...data.deliveryInput.plan.source, matchId: "foreign-match" } } }));
    const failed = await loadHoldemSnapshot(source, delivery, purchase);
    assert.equal(failed.report!.matchId, data.report.matchId);
    assert.equal(failed.delivery, undefined); assert.equal(failed.purchase, undefined);
    assert.match(failed.deliveryError!, /不一致/); assert.match(failed.purchaseError!, /不一致/);
    assert.equal(JSON.stringify(failed).includes(directory), false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
