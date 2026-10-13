import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Transaction } from "ethers";
import { InferCredit, paymentId, requestDigest, sameAddress, type Inference, type PaymentHandle } from "../packages/sdk/src/index.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { createHand, replayHand, type Action, type HandResult, type HoldemHand, type PlayerView, type Seat } from "../services/arena/src/holdem/index.js";
import { read } from "../services/underwriter/test/fixture.js";
import { saveJson } from "./demo-common.js";
import { createHoldemFixture, REWARD_INFERENCE_PRICE, SPONSORED_REWARD, type HoldemFixture } from "./holdem-fixture.js";

type PublicResult = Pick<HandResult, "reason" | "winners" | "contestedPot" | "payouts" | "refunds" | "finalStacks">;
interface RewardTransfer { seat: Seat; agentId: string; amount: string; txHash: string; blockNumber: number }
interface RewardSession {
  version: 1; matchId: string; replayDigest: string; token: string; sponsor: string; account: string;
  wallets: [string, string]; reward: string; allocations: [string, string]; result: PublicResult;
  transfers: RewardTransfer[];
}
const seats = [0, 1] as const;
const resultForPublic = (result: HandResult): PublicResult => ({ reason: result.reason, winners: [...result.winners],
  contestedPot: result.contestedPot, payouts: [...result.payouts], refunds: [...result.refunds], finalStacks: [...result.finalStacks] });

/** Scripted local Agent: raises a pocket pair when allowed, otherwise checks or calls. This is not an LLM. */
export function controlledDecision(view: PlayerView): Action {
  if (view.handStatus !== "playing" || view.actor !== view.seat) throw new Error("STRATEGY_NOT_ACTOR");
  const raise = view.legalActions.find(action => action.type === "raise");
  if (view.holeCards[0]?.[0] === view.holeCards[1]?.[0] && raise?.type === "raise") return { type: "raise", to: Math.min(raise.minTo, raise.maxTo) };
  if (view.legalActions.some(action => action.type === "check")) return { type: "check" };
  if (view.legalActions.some(action => action.type === "call")) return { type: "call" };
  throw new Error("NO_CONTROLLED_ACTION");
}

/** Only the actor's view enters its strategy. Public steps contain no private cards or strategy input logs. */
export function playControlledHand(hand: HoldemHand) {
  const steps: { seat: Seat; street: string; action: Action; board: string[]; stacks: [number, number]; pot: number }[] = [];
  while (hand.view(0).handStatus === "playing") {
    if (steps.length >= 512) throw new Error("CONTROLLED_GAME_LIMIT");
    const actor = hand.view(0).actor;
    if (actor === null) throw new Error("PLAYING_HAND_HAS_NO_ACTOR");
    const actorView = hand.view(actor);
    const action = controlledDecision(actorView);
    steps.push({ seat: actor, street: actorView.street, action, board: [...actorView.board], stacks: [...actorView.stacks], pot: actorView.pot });
    hand.act(actor, action);
  }
  return steps;
}

/** One local sponsor, one output journal. A game result is recomputed from the private deck and legal action sequence. */
export async function settleSponsoredHand(local: HoldemFixture, matchId: string, input: unknown): Promise<RewardSession> {
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(matchId)) throw new Error("INVALID_MATCH_ID");
  const verifiedHand = replayHand(input);
  const view = verifiedHand.view(0);
  if (view.handStatus !== "complete" || !view.result) throw new Error("REWARD_REQUIRES_COMPLETE_HAND");
  const replay = verifiedHand.exportTrustedReplay();
  const replayDigest = createHash("sha256").update(JSON.stringify(replay)).digest("hex");
  const allocations: [string, string] = ["0", "0"];
  const share = SPONSORED_REWARD / BigInt(view.result.winners.length);
  for (const seat of view.result.winners) allocations[seat] = share.toString();
  if (allocations.reduce((sum, amount) => sum + BigInt(amount), 0n) !== SPONSORED_REWARD) throw new Error("REWARD_SPLIT_REMAINDER");
  const expected: RewardSession = { version: 1, matchId, replayDigest, token: await local.f.token!.getAddress(), sponsor: local.sponsor.address,
    account: await local.f.account.getAddress(), wallets: [local.signers[0].address, local.signers[1].address], reward: SPONSORED_REWARD.toString(),
    allocations, result: resultForPublic(view.result), transfers: [] };
  const store = new SessionStore<RewardSession>(join(local.privateDirectory, "reward-settlement"));
  await store.start();
  try {
    let session = await store.read();
    if (session && JSON.stringify({ ...session, transfers: [] }) !== JSON.stringify(expected)) throw new Error("REWARD_OUTPUT_BINDING_MISMATCH");
    if (!session) {
      session = expected;
      // The complete deck is exported for trusted post-game auditing only.
      await saveJson(join(local.privateDirectory, "trusted-replay.json"), replay);
      await store.write(session);
    }
    for (const seat of seats) {
      const amount = BigInt(allocations[seat]);
      if (amount === 0n) continue;
      const id = `holdem:${matchId}:${replayDigest}:reward:${seat}`;
      const data = local.f.token!.interface.encodeFunctionData("transfer", [local.signers[seat].address, amount]);
      if (local.rewardJournal.has(id)) {
        // Check persisted bytes before any rebroadcast; the original journal cannot be redirected.
        const entries = JSON.parse(await readFile(local.rewardJournal.path, "utf8"));
        const original = Transaction.from(entries[id].rawTransaction);
        if (original.from !== local.sponsor.address || original.to !== expected.token || original.data !== data || original.chainId !== 31337n) throw new Error("REWARD_JOURNAL_BINDING_MISMATCH");
      }
      await local.rewardJournal.send(id, local.sponsor, { to: expected.token, data, chainId: 31337n });
      const receipt = await local.rewardJournal.receipt(id);
      const event = receipt.logs.filter(log => log.address.toLowerCase() === expected.token.toLowerCase()).map(log => {
        try { return local.f.token!.interface.parseLog(log); } catch { return null; }
      }).find(event => event?.name === "Transfer" && event.args.from === local.sponsor.address
        && event.args.to === local.signers[seat].address && event.args[2] === amount);
      if (!event) throw new Error("REWARD_TRANSFER_RECEIPT_MISMATCH");
      const transfer: RewardTransfer = { seat, agentId: String(seat + 1), amount: amount.toString(), txHash: receipt.hash, blockNumber: receipt.blockNumber };
      const saved = session.transfers.find(item => item.seat === seat);
      if (saved && JSON.stringify(saved) !== JSON.stringify(transfer)) throw new Error("REWARD_RECEIPT_CHANGED");
      if (!saved) { session.transfers.push(transfer); await store.write(session); }
    }
    return structuredClone(session);
  } finally { await store.close(); }
}

export async function buyRewardInference(local: HoldemFixture, seat: Seat, amount: bigint) {
  if (amount < REWARD_INFERENCE_PRICE) throw new Error("REWARD_TOO_SMALL_FOR_INFERENCE");
  const reward = JSON.parse(await readFile(join(local.privateDirectory, "reward-settlement", "session.json"), "utf8")) as RewardSession;
  if (reward.allocations[seat] !== amount.toString() || !reward.transfers.some(item => item.seat === seat && item.amount === amount.toString())
    || reward.wallets[seat] !== local.signers[seat].address || reward.account !== local.config.account) throw new Error("INFERENCE_REQUIRES_CONFIRMED_AWARD");
  type InferenceSession = { matchId: string; replayDigest: string; amount: string; dispatchIntent: boolean; depositTxHash?: string; handle?: PaymentHandle; inference?: Inference };
  const store = new SessionStore<InferenceSession>(join(local.privateDirectory, `inference-seat-${seat}`));
  await store.start();
  let client: InferCredit | undefined;
  try {
    let saved = await store.read();
    if (saved && (saved.amount !== amount.toString() || saved.matchId !== reward.matchId || saved.replayDigest !== reward.replayDigest)) throw new Error("INFERENCE_REWARD_BINDING_MISMATCH");
    saved ??= { matchId: reward.matchId, replayDigest: reward.replayDigest, amount: amount.toString(), dispatchIntent: false };
    await store.write(saved);
    if (saved.dispatchIntent && !saved.handle && !saved.inference) throw new Error("REWARD_INFERENCE_UNKNOWN_NO_REDISPATCH");
    // Deposit only the sponsor's award; the local fixture's existing balances are tracked separately.
    const depositId = `holdem:${reward.matchId}:${reward.replayDigest}:reward-deposit:${seat}`;
    const request = { to: await local.f.account.getAddress(), chainId: 31337n,
      data: local.f.account.interface.encodeFunctionData("depositCash", [BigInt(seat + 1), amount]) };
    if (local.rewardJournal.has(depositId)) {
      const entries = JSON.parse(await readFile(local.rewardJournal.path, "utf8"));
      const original = Transaction.from(entries[depositId].rawTransaction);
      if (original.from !== local.signers[seat].address || original.to !== request.to || original.data !== request.data || original.chainId !== 31337n) throw new Error("DEPOSIT_JOURNAL_BINDING_MISMATCH");
    }
    await local.rewardJournal.send(depositId, local.signers[seat], request);
    const deposit = await local.rewardJournal.receipt(depositId);
    if (saved.depositTxHash && saved.depositTxHash !== deposit.hash) throw new Error("DEPOSIT_RECEIPT_CHANGED");
    saved.depositTxHash = deposit.hash; await store.write(saved);
    if (!saved.inference) {
      if (saved.dispatchIntent) {
        if (!saved.handle) throw new Error("REWARD_INFERENCE_UNKNOWN_NO_REDISPATCH");
        const statusUrl = new URL(local.relayUrl); statusUrl.pathname = `/payments/${saved.handle.quote.paymentId}`;
        statusUrl.search = new URLSearchParams({ agentId: String(seat + 1), requestDigest: saved.handle.quote.requestDigest }).toString();
        let status: { paymentId: string; state: string; result: Inference["result"]; receipt: Inference["receipt"] };
        try {
          const response = await fetch(statusUrl, { signal: AbortSignal.timeout(5000) });
          if (!response.ok) throw new Error(); status = await response.json() as typeof status;
        } catch { throw new Error("REWARD_INFERENCE_STATUS_UNCERTAIN"); }
        if (status.paymentId !== saved.handle.quote.paymentId) throw new Error("REWARD_INFERENCE_STATUS_MISMATCH");
        if (status.state !== "Delivered") throw new Error("REWARD_INFERENCE_UNKNOWN_NO_REDISPATCH");
        saved.inference = { result: status.result, receipt: status.receipt, handle: structuredClone(saved.handle) };
      } else {
        if (saved.handle) throw new Error("REWARD_INFERENCE_UNKNOWN_NO_REDISPATCH");
        client = new InferCredit({ agentId: String(seat + 1), chainId: 31337n, account: local.config.account, asset: local.config.asset,
          provider: local.config.payTo, maxPrice: REWARD_INFERENCE_PRICE, signer: local.signers[seat], timeoutMs: 5000,
          onHandle: async handle => { saved!.handle = handle; await store.write(saved!); } });
        saved.dispatchIntent = true; await store.write(saved);
        saved.inference = await client.fetch(local.relayUrl, { body: { service: local.config.service.id,
          model: local.config.service.model, messages: [{ role: "user", content: "Confirm this local reward-funded inference request." }], max_completion_tokens: 32 } });
      }
    }
    // Validate the cache against the original quote and actual local payment before accepting recovery.
    const inference = saved.inference;
    if (!saved.handle) throw new Error("REWARD_INFERENCE_HANDLE_MISSING");
    const quote = saved.handle.quote;
    if (quote.agentId !== String(seat + 1) || quote.taskId !== "0" || quote.chainId !== "31337" || quote.price !== REWARD_INFERENCE_PRICE.toString()
      || quote.service !== local.config.service.id || quote.model !== local.config.service.model
      || !sameAddress(quote.account, local.config.account) || !sameAddress(quote.asset, local.config.asset) || !sameAddress(quote.payTo, local.config.payTo)
      || quote.requestDigest !== requestDigest(saved.handle.input) || quote.paymentId !== paymentId("0", quote.requestDigest, quote.serverNonce)
      || ["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "chainId"].some(field => (inference.receipt as any)[field] !== (quote as any)[field])
      || ["account", "asset", "payTo"].some(field => !sameAddress((inference.receipt as any)[field], (quote as any)[field]))
      || inference.receipt.txHash !== saved.handle.submission?.txHash) throw new Error("REWARD_INFERENCE_RECEIPT_MISMATCH");
    assert.deepEqual(inference.handle, saved.handle);
    const payment = await read(local.f.account, "getPayment", [inference.receipt.paymentId]);
    assert.equal(inference.receipt.taskId, "0"); assert.equal(inference.receipt.fromCredit, "0");
    assert.equal(payment.taskId, 0n); assert.equal(payment.fromCredit, 0n); assert.equal(payment.fromCash, REWARD_INFERENCE_PRICE);
    const rawPaymentReceipt = await local.f.provider.getTransactionReceipt(inference.receipt.txHash);
    if (!rawPaymentReceipt || rawPaymentReceipt.status !== 1 || rawPaymentReceipt.blockHash !== inference.receipt.blockHash
      || rawPaymentReceipt.blockNumber !== inference.receipt.blockNumber) throw new Error("REWARD_INFERENCE_CHAIN_RECEIPT_MISMATCH");
    const paid = rawPaymentReceipt.logs.filter(log => sameAddress(log.address, local.config.account)).map(log => {
      try { return local.f.account.interface.parseLog(log); } catch { return null; }
    }).filter(event => event?.name === "ProviderPaid");
    if (paid.length !== 1 || paid[0]!.args.agentId !== BigInt(seat + 1) || paid[0]!.args.paymentId !== inference.receipt.paymentId
      || !sameAddress(paid[0]!.args.provider, local.config.payTo) || paid[0]!.args.fromCash !== REWARD_INFERENCE_PRICE || paid[0]!.args.fromCredit !== 0n) throw new Error("REWARD_INFERENCE_PAID_EVENT_MISMATCH");
    if ((await local.f.provider.getBlock(rawPaymentReceipt.blockNumber))?.hash !== rawPaymentReceipt.blockHash) throw new Error("REWARD_INFERENCE_BLOCK_MISMATCH");
    await store.write(saved);
    return { seat, agentId: String(seat + 1), award: amount.toString(), deposited: amount.toString(), depositTxHash: deposit.hash,
      receipt: inference.receipt, controlledResponse: inference.result };
  } finally { client?.close(); await store.close(); }
}

export async function holdemBalances(local: HoldemFixture) {
  return { sponsor: await read(local.f.token!, "balanceOf", [local.sponsor.address]),
    wallets: await Promise.all(seats.map(seat => read(local.f.token!, "balanceOf", [local.signers[seat].address]))) as [bigint, bigint],
    cash: await Promise.all(seats.map(seat => read(local.f.account, "cash", [BigInt(seat + 1)]))) as [bigint, bigint],
    provider: await local.f.providerBalance(), totalOutstanding: await read(local.f.manager, "totalOutstanding") };
}

async function chainTransactionEvidence(local: HoldemFixture, txHash: string) {
  const transaction = await local.f.provider.getTransaction(txHash);
  const receipt = await local.f.provider.getTransactionReceipt(txHash);
  if (!transaction || !receipt || receipt.status !== 1) throw new Error("CHAIN_EVIDENCE_RECEIPT_MISSING");
  return { transaction: { hash: transaction.hash, from: transaction.from, to: transaction.to, data: transaction.data,
    value: transaction.value.toString(), nonce: transaction.nonce, chainId: transaction.chainId.toString() }, receipt: receipt.toJSON() };
}

export async function runHoldemDemo(outputPath: string) {
  const output = resolve(outputPath);
  try { await mkdir(output, { mode: 0o700 }); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error("HOLDEM_OUTPUT_MUST_BE_NEW"); throw error;
  }
  const local = await createHoldemFixture(output);
  try {
    const before = await holdemBalances(local);
    const hand = createHand({ initialStack: 1000, smallBlind: 5, bigBlind: 10 });
    const steps = playControlledHand(hand);
    const afterGame = await holdemBalances(local); assert.deepEqual(afterGame, before); assert.equal(local.calls.length, 0);
    const matchId = `local-${randomUUID()}`;
    const settlement = await settleSponsoredHand(local, matchId, hand.exportTrustedReplay());
    const afterAward = await holdemBalances(local);
    const sponsorNonce = await local.f.provider.getTransactionCount(local.sponsor.address);
    const repeatedSettlement = await settleSponsoredHand(local, matchId, hand.exportTrustedReplay());
    assert.deepEqual(repeatedSettlement, settlement); assert.deepEqual(await holdemBalances(local), afterAward);
    assert.equal(await local.f.provider.getTransactionCount(local.sponsor.address), sponsorNonce);
    assert.equal(before.sponsor - afterAward.sponsor, SPONSORED_REWARD);
    const purchases = [];
    for (const seat of seats) {
      const award = BigInt(settlement.allocations[seat]);
      assert.equal(afterAward.wallets[seat] - before.wallets[seat], award);
      if (award) purchases.push(await buyRewardInference(local, seat, award));
    }
    const afterPurchase = await holdemBalances(local);
    const totalPrice = REWARD_INFERENCE_PRICE * BigInt(purchases.length);
    for (const seat of seats) {
      const award = BigInt(settlement.allocations[seat]); const spent = award ? REWARD_INFERENCE_PRICE : 0n;
      assert.equal(afterPurchase.wallets[seat], before.wallets[seat]);
      assert.equal(afterPurchase.cash[seat] - before.cash[seat], award - spent);
    }
    assert.equal(afterPurchase.provider - before.provider, totalPrice);
    assert.equal(afterPurchase.cash[0] + afterPurchase.cash[1] - before.cash[0] - before.cash[1] + totalPrice, SPONSORED_REWARD);
    assert.equal(before.totalOutstanding, 0n); assert.equal(afterPurchase.totalOutstanding, 0n);
    assert.equal((await read(local.f.manager, "getLoan", [0n])).status, 0n);
    assert.equal(local.calls.length, purchases.length);
    const chainEvidence = { chainId: "31337", assetDecimals: 6, addresses: { token: local.config.asset, account: local.config.account,
      manager: await local.f.manager.getAddress(), sponsor: local.sponsor.address, wallets: [local.signers[0].address, local.signers[1].address], provider: local.config.payTo },
      rewards: await Promise.all(settlement.transfers.map(async transfer => ({ ...transfer, ...await chainTransactionEvidence(local, transfer.txHash) }))),
      deposits: await Promise.all(purchases.map(async purchase => ({ seat: purchase.seat, agentId: purchase.agentId, amount: purchase.deposited,
        ...await chainTransactionEvidence(local, purchase.depositTxHash) }))),
      inferencePayments: await Promise.all(purchases.map(async purchase => ({ seat: purchase.seat, agentId: purchase.agentId, paymentId: purchase.receipt.paymentId,
        amount: purchase.receipt.price, ...await chainTransactionEvidence(local, purchase.receipt.txHash) }))) };
    await saveJson(join(output, "chain-evidence.json"), chainEvidence);
    const report = { verified: true, scope: "Local Anvil/mock USDC; free scripted heads-up game -> sponsor reward -> AgentAccount cash -> SDK/Relay controlled HTTP inference",
      matchId, game: { entryFee: "0", strategyInferenceCalls: 0, strategies: ["scripted pocket-pair raise, otherwise check/call", "scripted pocket-pair raise, otherwise check/call"],
        dealing: "cryptographically shuffled 52-card deck", chips: { unit: "nonredeemable virtual chips", initialPerSeat: 1000, smallBlind: 5, bigBlind: 10 },
        steps, finalBoard: hand.view(0).board, result: settlement.result },
      reward: { rawAmount: SPONSORED_REWARD.toString(), decimals: 6, source: "local mock-USDC sponsor wallet", allocations: settlement.allocations,
        transfers: settlement.transfers, replayDigest: settlement.replayDigest, repeatedSettlementPaidAgain: false },
      inference: { rawPricePerWinner: REWARD_INFERENCE_PRICE.toString(), taskId: "0", calls: local.calls.length, purchases },
      balances: { before, afterGame, afterAward, afterPurchase },
      chainEvidence: { file: "chain-evidence.json", chainId: "31337", asset: local.config.asset, account: local.config.account },
      verification: { gameWalletSpend: "0", sponsorReward: SPONSORED_REWARD.toString(), fromCredit: "0", loanPrincipal: "0", totalOutstanding: "0", rewardConserved: true },
      limitations: ["This is local synthetic test USDC, with no public network, real funds or real model calls.",
        "The game's Agents run deterministic local strategies for free; only post-award inference is priced.",
        "Virtual game chips cannot be redeemed, and the sponsor reward is a fixed promotional allocation independent of the pot.",
        "The base fixture preloads seat 0 with cash; the report proves award, deposit and inference using balance changes.",
        "Trusted replay and signed transaction journals stay in the private 0700 directory with 0600 files; report omits hole cards and deck.",
        "Duplicate settlement is tested on the same live Anvil and output. Anvil closes at exit, so this output cannot resume the original chain in a later process.",
        "An unknown sponsor transaction reuses its originally journaled signed bytes; it never signs a replacement reward.",
        "Post-award inference recovery only reads a verified Delivered Relay cache. Unknown dispatch or paid delivery pauses without another model request." ] };
    await saveJson(join(output, "report.json"), report);
    return report;
  } finally { await local.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error("Usage: tsx scripts/holdem-demo.ts --output /absolute/new-evidence");
  const report = await runHoldemDemo(process.argv[3]);
  console.log(JSON.stringify({ verified: report.verified, result: report.game.result, modelCalls: report.inference.calls, output: resolve(process.argv[3]) }));
}
