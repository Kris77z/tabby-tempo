import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { atomicJson } from "../services/arena/src/protocol.js";
import { replayHand } from "../services/arena/src/holdem/index.js";
import { HOLDEM_LIVE_HAND, HOLDEM_LIVE_LIMITS, publicLiveHand, runLiveHand, type LiveHandSession, type PublicDecisionAttempt, type PublicHandResult, type PublicHandStep } from "../services/arena/src/holdem/live.js";
import { read } from "../services/underwriter/test/fixture.js";
import { buyRewardInference, holdemBalances, settleSponsoredHand } from "./holdem-demo.js";
import { createHoldemFixture, REWARD_INFERENCE_PRICE, SPONSORED_REWARD, type HoldemFixture } from "./holdem-fixture.js";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";

export const holdemLivePlan = {
  ...HOLDEM_LIVE_LIMITS, thinking: { type: "disabled" as const }, hand: HOLDEM_LIVE_HAND,
  entryFee: "0", strategyInferenceFunding: "sponsor upstream account", vendorInvoiceVerified: false,
  chainId: "31337", settlementAsset: "local mock-USDC", assetDecimals: 6, transport: "system-https-proxy",
  sponsoredRewardRaw: SPONSORED_REWARD.toString(), rewardInferencePriceRaw: REWARD_INFERENCE_PRICE.toString(),
  postRewardInference: "controlled loopback HTTP", tools: false, credit: false, predeterminedWinner: false, seededDeck: false,
};
interface LiveReport {
  version: 1; mode: "holdem-live"; network: "local-anvil"; matchId: string; startedAt: string; finishedAt?: string;
  upstreamMode: "controlled-upstream" | "real-kimi-system-https-proxy";
  phase: "Starting" | "Running" | "Complete" | "Stopped" | "PreflightFailed" | "SettlementUncertain"; reason?: string; error?: string;
  verified: boolean; plan: typeof holdemLivePlan;
  game: { entryFee: "0"; strategyInferenceCalls: number; strategies: [string, string]; dealing: string;
    chips: { unit: string; initialPerSeat: number; smallBlind: number; bigBlind: number };
    steps: PublicHandStep[]; finalBoard: string[]; result: PublicHandResult | null };
  strategyInference: { funding: "sponsor upstream account"; calls: number; paidInferenceAttempts: number; maxCalls: number;
    attempts: PublicDecisionAttempt[]; vendorInvoiceVerified: false };
  reward: null | { rawAmount: string; decimals: 6; source: string; allocations: [string, string];
    transfers: Awaited<ReturnType<typeof settleSponsoredHand>>["transfers"]; replayDigest: string; repeatedSettlementPaidAgain: false };
  inference: null | { mode: "controlled-reward-inference"; rawPricePerWinner: string; taskId: "0"; calls: number; purchases: Awaited<ReturnType<typeof buyRewardInference>>[] };
  balances?: { before: Awaited<ReturnType<typeof holdemBalances>>; afterGame?: Awaited<ReturnType<typeof holdemBalances>>;
    afterAward?: Awaited<ReturnType<typeof holdemBalances>>; afterPurchase?: Awaited<ReturnType<typeof holdemBalances>> };
  localChain?: { chainId: "31337"; assetDecimals: 6; addresses: { token: string; account: string; manager: string; sponsor: string; wallets: [string, string]; provider: string } };
  verification: { gameWalletSpend: "0"; fromCredit: "0"; loanPrincipal: "0"; totalOutstanding: string; rewardConserved?: true };
  evidence: { publicReplayVerified: boolean; chainEvidenceFile?: "chain-evidence.json" }; sourceHashes?: Record<string, string>;
  evidenceCollectionErrors: string[]; limitations: string[];
}
const failureCode = (error: unknown) => {
  const code = (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof code === "string" && /^[A-Z_0-9]+$/.test(code) ? code : "HOLDEM_INFRASTRUCTURE_UNCERTAIN";
};
const seats = [0, 1] as const;

async function transactionEvidence(local: HoldemFixture, txHash: string) {
  const transaction = await local.f.provider.getTransaction(txHash), receipt = await local.f.provider.getTransactionReceipt(txHash);
  if (!transaction || !receipt || receipt.status !== 1) throw new Error("HOLDEM_CHAIN_EVIDENCE_MISSING");
  return { transaction: { hash: transaction.hash, from: transaction.from, to: transaction.to, data: transaction.data,
    value: transaction.value.toString(), nonce: transaction.nonce, chainId: transaction.chainId.toString() }, receipt: receipt.toJSON() };
}

/** Test-only controlled transport injection is not exposed by any CLI flag. */
export async function main(args: string[], controlledUpstream?: typeof fetch): Promise<LiveReport | undefined> {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: "string" }, output: { type: "string" }, execute: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log("holdem-live --config /absolute/private/demo.json [--output /absolute/new-evidence --execute]. Default: bounded plan with no network/model calls. Strategy requests are sponsor funded. Complete hands receive local test-USDC reward and controlled reward-funded inference. Existing evidence is never rerun."); return; }
  if (!values.config) throw new Error("CONFIG_REQUIRED");
  const upstream = await loadProbeUpstream(values.config);
  if (!values.execute) { console.log(JSON.stringify({ mode: "plan-only", ...holdemLivePlan })); return; }
  if (!values.output || !isAbsolute(values.output)) throw new Error("ABSOLUTE_NEW_OUTPUT_REQUIRED");
  const output = values.output; await mkdir(output, { mode: 0o700 });
  const privateDirectory = join(output, ".private");
  const save = async (name: string, value: unknown) => {
    const serializable = JSON.parse(JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item));
    await atomicJson(join(output, name), serializable);
  };
  const startedAtMs = Date.now(), matchId = `live-${randomUUID()}`;
  const report: LiveReport = { version: 1, mode: "holdem-live", network: "local-anvil", matchId, startedAt: new Date(startedAtMs).toISOString(),
    upstreamMode: controlledUpstream ? "controlled-upstream" : "real-kimi-system-https-proxy", phase: "Starting", verified: false, plan: holdemLivePlan,
    game: { entryFee: "0", strategyInferenceCalls: 0, strategies: [HOLDEM_LIVE_LIMITS.model, HOLDEM_LIVE_LIMITS.model],
      dealing: "cryptographically shuffled 52-card deck", chips: { unit: "nonredeemable virtual chips", initialPerSeat: HOLDEM_LIVE_HAND.initialStack,
        smallBlind: HOLDEM_LIVE_HAND.smallBlind, bigBlind: HOLDEM_LIVE_HAND.bigBlind }, steps: [], finalBoard: [], result: null },
    strategyInference: { funding: "sponsor upstream account", calls: 0, paidInferenceAttempts: 0, maxCalls: HOLDEM_LIVE_LIMITS.maxCalls, attempts: [], vendorInvoiceVerified: false },
    reward: null, inference: null, verification: { gameWalletSpend: "0", fromCredit: "0", loanPrincipal: "0", totalOutstanding: "0" },
    evidence: { publicReplayVerified: false }, evidenceCollectionErrors: [], limitations: [
      "Strategy decisions use the sponsor's upstream account; attempt/token evidence is separate from game chips, player cash, and loans. The vendor bill is not verified.",
      "Only the actor's player view enters each model request; no opponent hole cards, deck, answer injection, tool calls, or predetermined winner.",
      "A rejected/invalid response, unknown HTTP outcome, 20-call cap, or ten-minute deadline stops the hand without winner substitution or reward.",
      "Reward is local Anvil/synthetic test-USDC, not public-network funding; the post-award inference is controlled loopback HTTP and is disclosed separately.",
      "Virtual chips cannot be redeemed. The fixed sponsor reward is independent of the pot; free entry has no player payment or borrowing.",
      "Private durable session/request/response and trusted replay use 0700 directories and 0600 files. Public report contains only public cards/actions and whitelisted response metadata.",
      "An existing output is never rerun. Unknown inference stays stopped; there is no automatic upstream retry. Local Anvil closes at exit and cannot resume later.",
    ] };
  let local: HoldemFixture | undefined, transport: ReturnType<typeof proxyUpstreamFetch> | undefined, session: LiveHandSession | undefined;
  await save("report.json", report);
  try {
    report.sourceHashes = {};
    for (const path of ["scripts/holdem-live.ts", "scripts/holdem-demo.ts", "scripts/holdem-fixture.ts", "scripts/demo-rpc.ts", "services/arena/src/holdem/live.ts", "services/arena/src/holdem/engine.ts", "services/arena/src/holdem/cards.ts", "services/arena/src/holdem/evaluator.ts"])
      report.sourceHashes[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
    if (!controlledUpstream) transport = proxyUpstreamFetch(await systemHttpsProxy(), HOLDEM_LIVE_LIMITS.upstreamTimeoutMs);
    // The existing cash-only reward fixture does not receive or bill strategy calls.
    local = await createHoldemFixture(output);
    report.localChain = { chainId: "31337", assetDecimals: 6, addresses: { token: local.config.asset, account: local.config.account,
      manager: await local.f.manager.getAddress(), sponsor: local.sponsor.address, wallets: [local.signers[0].address, local.signers[1].address], provider: local.config.payTo } };
    report.balances = { before: await holdemBalances(local) };
    session = await runLiveHand(privateDirectory, { matchId, startedAtMs, deadlineMs: startedAtMs + HOLDEM_LIVE_LIMITS.deadlineDurationMs }, {
      dispatch: async (request, signal) => (controlledUpstream ?? transport!.fetch)(`${upstream.baseUrl}/chat/completions`, {
        method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${upstream.key}` }, body: JSON.stringify(request), signal }),
      onProgress: async snapshot => {
        report.phase = snapshot.phase; report.reason = snapshot.reason;
        report.game.steps = snapshot.steps; report.game.finalBoard = snapshot.finalBoard; report.game.result = snapshot.result;
        report.game.strategyInferenceCalls = snapshot.attempts.length;
        report.strategyInference.calls = snapshot.attempts.length; report.strategyInference.paidInferenceAttempts = snapshot.attempts.length;
        report.strategyInference.attempts = snapshot.attempts; report.evidence.publicReplayVerified = snapshot.replayVerified;
        await save("report.json", report);
      },
    });
    report.balances.afterGame = await holdemBalances(local);
    assert.deepEqual(report.balances.afterGame, report.balances.before); assert.equal(local.calls.length, 0);
    assert.equal(report.balances.afterGame.totalOutstanding, 0n);
    if (session.phase === "Complete") {
      const trusted = replayHand(session.replay);
      assert.equal(trusted.view(0).handStatus, "complete");
      const settlement = await settleSponsoredHand(local, matchId, session.replay);
      report.reward = { rawAmount: SPONSORED_REWARD.toString(), decimals: 6, source: "local mock-USDC sponsor wallet", allocations: settlement.allocations,
        transfers: settlement.transfers, replayDigest: settlement.replayDigest, repeatedSettlementPaidAgain: false };
      report.balances.afterAward = await holdemBalances(local);
      const sponsorNonce = await local.f.provider.getTransactionCount(local.sponsor.address);
      assert.deepEqual(await settleSponsoredHand(local, matchId, session.replay), settlement);
      assert.deepEqual(await holdemBalances(local), report.balances.afterAward);
      assert.equal(await local.f.provider.getTransactionCount(local.sponsor.address), sponsorNonce);
      assert.equal(report.balances.before.sponsor - report.balances.afterAward.sponsor, SPONSORED_REWARD);
      report.inference = { mode: "controlled-reward-inference", rawPricePerWinner: REWARD_INFERENCE_PRICE.toString(), taskId: "0", calls: 0, purchases: [] };
      await save("report.json", report);
      for (const seat of seats) {
        const award = BigInt(settlement.allocations[seat]);
        assert.equal(report.balances.afterAward.wallets[seat] - report.balances.before.wallets[seat], award);
        if (award) report.inference.purchases.push(await buyRewardInference(local, seat, award));
        report.inference.calls = local.calls.length; await save("report.json", report);
      }
      report.balances.afterPurchase = await holdemBalances(local);
      const prices = REWARD_INFERENCE_PRICE * BigInt(report.inference.purchases.length);
      for (const seat of seats) {
        const award = BigInt(settlement.allocations[seat]);
        assert.equal(report.balances.afterPurchase.wallets[seat], report.balances.before.wallets[seat]);
        assert.equal(report.balances.afterPurchase.cash[seat] - report.balances.before.cash[seat], award - (award ? REWARD_INFERENCE_PRICE : 0n));
      }
      assert.equal(report.balances.afterPurchase.provider - report.balances.before.provider, prices);
      assert.equal(report.balances.afterPurchase.cash[0] + report.balances.afterPurchase.cash[1] - report.balances.before.cash[0] - report.balances.before.cash[1] + prices, SPONSORED_REWARD);
      assert.equal(report.balances.afterPurchase.totalOutstanding, 0n); assert.equal((await read(local.f.manager, "getLoan", [0n])).status, 0n);
      assert.equal(local.calls.length, report.inference.purchases.length);
      const chainEvidence = { ...report.localChain,
        rewards: await Promise.all(settlement.transfers.map(async transfer => ({ ...transfer, ...await transactionEvidence(local!, transfer.txHash) }))),
        deposits: await Promise.all(report.inference.purchases.map(async purchase => ({ seat: purchase.seat, agentId: purchase.agentId, amount: purchase.deposited,
          ...await transactionEvidence(local!, purchase.depositTxHash) }))),
        inferencePayments: await Promise.all(report.inference.purchases.map(async purchase => ({ seat: purchase.seat, agentId: purchase.agentId,
          paymentId: purchase.receipt.paymentId, amount: purchase.receipt.price, ...await transactionEvidence(local!, purchase.receipt.txHash) }))) };
      await save("chain-evidence.json", chainEvidence); report.evidence.chainEvidenceFile = "chain-evidence.json";
      report.verification.rewardConserved = true; report.verified = true;
    } else {
      assert.equal(report.game.result, null); assert.equal(report.reward, null); assert.equal(report.inference, null);
      assert.deepEqual(await holdemBalances(local), report.balances.before); assert.equal(local.calls.length, 0);
    }
  } catch (error) {
    report.error = failureCode(error);
    report.phase = session?.phase === "Complete" || report.game.result !== null ? "SettlementUncertain" : report.phase === "Starting" ? "PreflightFailed" : "Stopped";
    report.reason = report.error; report.verified = false;
  } finally {
    try {
      if (session) {
        const saved = JSON.parse(await readFile(join(privateDirectory, "game", "session.json"), "utf8")) as LiveHandSession;
        assert.deepEqual(publicLiveHand(saved), publicLiveHand(session)); report.evidence.publicReplayVerified = true;
      }
    } catch { report.evidenceCollectionErrors.push("saved-game-session"); report.verified = false; }
    report.finishedAt = new Date().toISOString();
    try { await save("report.json", report); }
    finally { transport?.close(); await local?.close(); }
  }
  console.log(JSON.stringify({ reportPath: join(output, "report.json"), phase: report.phase, verified: report.verified, result: report.game.result,
    strategyInferenceAttempts: report.strategyInference.calls, rewardInferenceCalls: report.inference?.calls ?? 0 }));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(report => {
  if (report && (!report.verified || report.error || report.evidenceCollectionErrors.length)) process.exitCode = 1;
}).catch(error => { console.error(JSON.stringify({ error: failureCode(error), instruction: "Preserve evidence. Inspect unknown outcomes offline; do not rerun model requests." })); process.exitCode = 1; });
