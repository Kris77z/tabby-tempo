import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Transaction, Wallet } from "ethers";
import { InferCredit, accountInterface, paymentId, requestDigest, sameAddress, type Inference, type InferenceReceipt, type PaymentHandle } from "../packages/sdk/src/index.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import type { PaymentRecord } from "../services/provider-relay/src/store.js";
import { replayHand, type Seat } from "../services/arena/src/holdem/index.js";
import { publicHandResult } from "../services/arena/src/holdem/live.js";
import { atomicJson } from "../services/arena/src/protocol.js";
import { buildHoldemMonadPlan, HOLDEM_MONAD_INFERENCE_PRICE, loadHoldemMonadConfig, preflightHoldemMonad,
  type HoldemMonadConfig, type HoldemMonadPlan, type HoldemMonadRuntime } from "./holdem-monad.js";
import { MONAD_CHAIN_ID, MONAD_USDC, readSecret } from "./demo-monad-config.js";
import { json, reportDemoFailure } from "./demo-common.js";
import { monadProvider, proxyUpstreamFetch, readRpcUrlFile, systemHttpsProxy, type RpcTransport } from "./demo-rpc.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";
import { verifyProviderPaid, type RawReceipt } from "./live-tiers-evidence.js";

const seats = [0, 1] as const;
export const HOLDEM_PURCHASE_POLICY = Object.freeze({ service: "holdem-reward", model: "kimi-k2.6", priceRaw: "10000", taskId: "0",
  maxCompletionTokens: 128, quoteTtl: 300, confirmations: 1, upstreamTimeoutMs: 55000, sdkTimeoutMs: 90000,
  maxPurchasesPerAwardedSeat: 1, maxPhysicalRequests: 2, inferenceRetries: 0, tools: false, thinking: { type: "disabled" as const } });
const CONFIRMATION = "Reward-funded inference confirmed.";
const PURCHASE_BODY = { service: HOLDEM_PURCHASE_POLICY.service, model: HOLDEM_PURCHASE_POLICY.model, stream: false,
  max_completion_tokens: HOLDEM_PURCHASE_POLICY.maxCompletionTokens, thinking: HOLDEM_PURCHASE_POLICY.thinking,
  messages: [{ role: "user", content: `Return exactly this English sentence and nothing else: ${CONFIRMATION}` }] };
const physicalRequest = () => { const { service: _service, ...body } = PURCHASE_BODY; return body; };
const sha = (bytes: string) => createHash("sha256").update(bytes).digest("hex");
const failureCode = (error: unknown) => { const code = (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof code === "string" && /^[A-Z_0-9]+$/.test(code) ? code : "HOLDEM_PURCHASE_UNCERTAIN"; };

interface DeliveryOperation {
  id: string; kind: "reward" | "approve" | "deposit"; seat: Seat; amount: string; txHash: string; blockNumber: number; blockHash: string;
  receipt: unknown; transaction: { hash: string; from: string; to: string; data: string; chainId: string; value: string; nonce: number };
}
interface DeliveryReport { version: 1; mode: "holdem-monad"; phase: "RewardDeposited"; chainId: "10143"; stageComplete: true;
  plan: Omit<HoldemMonadPlan, "sourceDirectory" | "journalDirectory">; operations: DeliveryOperation[];
  balances: { before: { cash: [string, string] }; afterDeposit: { blockNumber: number; blockHash: string; cash: [string, string] } };
}
export interface HoldemPurchasePlan {
  version: 1; mode: "holdem-monad-purchase"; chainId: "10143"; delivery: HoldemMonadPlan; deliveryReport: DeliveryReport; deliveryReportDigest: string;
  journalDirectory: string; policy: typeof HOLDEM_PURCHASE_POLICY;
}
export interface PurchaseSnapshot { blockNumber: number; blockHash: string; cash: [string, string]; providerToken: string;
  totalOutstanding: string; task0LoanStatus: string }
interface PhysicalAttempt { dispatchIntent: true; requestDigest: string; request: unknown; response?: { status: number; rawText: string };
  outcome: "IntentPersisted" | "Delivered" | "HTTPRejected" | "Unknown"; durationMs?: number }
interface PurchaseEntry { seat: Seat; agentId: string; wallet: string; awardRaw: string; cashBefore: string;
  dispatchIntent: true; state: "Unknown" | "Delivered" | "Stopped"; handle?: PaymentHandle; inference?: Inference; physicalAttempt?: PhysicalAttempt;
  paidReceipt?: InferenceReceipt; rawReceipt?: unknown; error?: string }
interface PurchaseSession { version: 1; binding: HoldemPurchasePlan; upstreamMode: "real-kimi-system-https-proxy" | "controlled-upstream";
  before: PurchaseSnapshot; after?: PurchaseSnapshot; entries: PurchaseEntry[]; cashConserved?: true; paymentReceiptsCanonical?: true; report?: PurchaseReport }
type PublicReceipt = Pick<InferenceReceipt, "paymentId" | "agentId" | "taskId" | "requestDigest" | "service" | "price" | "asset" | "chainId" | "account" | "payTo" | "txHash" | "blockNumber" | "blockHash" | "fromCash" | "fromCredit" | "model" | "upstream">;
export interface PurchaseReport {
  version: 1; mode: "holdem-monad-purchase"; stage: "Plan" | "RewardInferenceComplete" | "Stopped"; phase: "Plan" | "Complete" | "Stopped";
  chainId: "10143"; upstreamMode: PurchaseSession["upstreamMode"]; readOnly: boolean;
  source: HoldemMonadPlan["source"] & { deliveryReportDigest: string }; model: string; priceRaw: "10000"; taskId: "0"; maxPurchasesPerAwardedSeat: 1;
  purchases: { seat: Seat; agentId: string; wallet: string; awardRaw: string; cashBefore: string; cashAfter?: string; state: PurchaseEntry["state"];
    receipt?: PublicReceipt; model?: string; usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    finishReason?: string | null; taskCompleted?: boolean; error?: string }[];
  strategyCallsSeparate: true; physicalInferenceAttempts: number; before?: PurchaseSnapshot; after?: PurchaseSnapshot;
  verification: { sourceBound: true; rewardAndDepositReceiptsCanonical: boolean; fromCredit: "0"; newBorrowingRaw: "0"; zeroDebt: boolean;
    totalPaidRaw: string; cashConserved: boolean }; evidence: { paymentReceiptsCanonical: boolean }; ready?: boolean; error?: string;
  limitations: string[];
}

async function privateFile(path: string) {
  const meta = await lstat(path);
  if (!meta.isFile() || meta.isSymbolicLink() || (meta.mode & 0o777) !== 0o600 || (process.getuid && meta.uid !== process.getuid())) throw new Error("HOLDEM_PURCHASE_PRIVATE_SOURCE_REQUIRED");
  return readFile(path, "utf8");
}
const publicDeliveryPlan = (plan: HoldemMonadPlan) => { const { sourceDirectory: _source, journalDirectory: _journal, ...value } = plan; return value; };
async function sourceUnchanged(plan: HoldemPurchasePlan) {
  const sourceBytes = await privateFile(join(plan.delivery.sourceDirectory, "report.json")), source = JSON.parse(sourceBytes);
  const hand = replayHand(JSON.parse(await privateFile(join(plan.delivery.sourceDirectory, ".private", "trusted-replay.json"))));
  const view = hand.view(0);
  if (source.version !== 1 || source.mode !== "holdem-live" || source.phase !== "Complete" || source.verified !== true || source.network !== "local-anvil"
    || source.upstreamMode !== "real-kimi-system-https-proxy" || source.matchId !== plan.delivery.source.matchId || sha(sourceBytes) !== plan.delivery.source.reportDigest
    || sha(await privateFile(join(plan.delivery.sourceDirectory, "monad-delivery-report.json"))) !== plan.deliveryReportDigest
    || view.handStatus !== "complete" || !view.result || sha(JSON.stringify(hand.exportTrustedReplay())) !== plan.delivery.source.replayDigest) throw new Error("HOLDEM_PURCHASE_SOURCE_CHANGED_AFTER_PLAN");
  assert.deepEqual(publicHandResult(view.result), plan.delivery.result, "HOLDEM_PURCHASE_SOURCE_RESULT_MISMATCH");
}

/** Local file/source binding is checked before an RPC is opened, and again before a payment is signed. */
export async function buildHoldemMonadPurchasePlan(config: HoldemMonadConfig) {
  const { plan: delivery, monadConfig } = await buildHoldemMonadPlan(config);
  const deliveryBytes = await privateFile(join(config.sourceDirectory, "monad-delivery-report.json"));
  const report = JSON.parse(deliveryBytes) as DeliveryReport;
  if (report.version !== 1 || report.mode !== "holdem-monad" || report.phase !== "RewardDeposited" || report.stageComplete !== true
    || report.chainId !== "10143" || !Array.isArray(report.operations)) throw new Error("HOLDEM_CONFIRMED_REWARD_DEPOSIT_REQUIRED");
  assert.deepEqual(report.plan, publicDeliveryPlan(delivery), "HOLDEM_PURCHASE_DELIVERY_SOURCE_MISMATCH");
  const saved = JSON.parse(await privateFile(join(delivery.journalDirectory, "session.json")));
  assert.deepEqual(saved.binding, delivery, "HOLDEM_PURCHASE_DELIVERY_SESSION_MISMATCH");
  assert.deepEqual(saved.report, report, "HOLDEM_PURCHASE_DELIVERY_REPORT_MISMATCH");
  assert.deepEqual(saved.operations, report.operations, "HOLDEM_PURCHASE_DELIVERY_OPERATIONS_MISMATCH");
  const plan: HoldemPurchasePlan = { version: 1, mode: "holdem-monad-purchase", chainId: "10143", delivery, deliveryReport: report,
    deliveryReportDigest: sha(deliveryBytes), journalDirectory: join(config.sourceDirectory, ".private", "monad-purchase"), policy: HOLDEM_PURCHASE_POLICY };
  return { plan, monadConfig };
}

/** Require direct successful calldata, expected events, and the current canonical block for every reward/deposit. */
export async function verifyHoldemAwardDeposits(plan: HoldemPurchasePlan, runtime: HoldemMonadRuntime) {
  const { delivery, deliveryReport } = plan;
  if (plan.chainId !== "10143" || BigInt(await runtime.provider.send("eth_chainId", [])) !== MONAD_CHAIN_ID || delivery.asset.address !== MONAD_USDC
    || await runtime.token.getAddress() !== delivery.asset.address || await runtime.account.getAddress() !== delivery.contracts.account
    || await runtime.manager.getAddress() !== delivery.contracts.manager || JSON.stringify(plan.policy) !== JSON.stringify(HOLDEM_PURCHASE_POLICY)) throw new Error("HOLDEM_PURCHASE_FIXED_BINDING_REQUIRED");
  assert.deepEqual(deliveryReport.plan, publicDeliveryPlan(delivery), "HOLDEM_PURCHASE_DELIVERY_SOURCE_MISMATCH");
  const winners = seats.filter(seat => delivery.allocations[seat] !== "0");
  if (deliveryReport.operations.length !== winners.length * 3) throw new Error("HOLDEM_PURCHASE_DELIVERY_OPERATIONS_REQUIRED");
  for (const seat of winners) {
    const player = delivery.players[seat], award = delivery.allocations[seat];
    for (const kind of ["reward", "approve", "deposit"] as const) {
      const matches = deliveryReport.operations.filter(item => item.kind === kind && item.seat === seat);
      if (matches.length !== 1) throw new Error("HOLDEM_PURCHASE_DELIVERY_OPERATIONS_REQUIRED");
      const operation = matches[0], contract = kind === "deposit" ? runtime.account : runtime.token;
      const from = kind === "reward" ? delivery.sponsor : player.wallet;
      const data = kind === "reward" ? contract.interface.encodeFunctionData("transfer", [player.wallet, BigInt(award)])
        : kind === "approve" ? contract.interface.encodeFunctionData("approve", [delivery.contracts.account, BigInt(award)])
        : contract.interface.encodeFunctionData("depositCash", [BigInt(player.agentId), BigInt(award)]);
      const receipt = await runtime.provider.getTransactionReceipt(operation.txHash), transaction = await runtime.provider.getTransaction(operation.txHash);
      if (!receipt || receipt.status !== 1 || !transaction || transaction.chainId !== MONAD_CHAIN_ID || !sameAddress(transaction.from, from)
        || !sameAddress(transaction.to!, await contract.getAddress()) || transaction.data !== data || transaction.value !== 0n
        || operation.amount !== award || operation.id !== `holdem:${delivery.source.matchId}:${delivery.source.replayDigest}:${kind}:${seat}`
        || receipt.blockNumber !== operation.blockNumber || receipt.blockHash !== operation.blockHash
        || (await runtime.provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error("HOLDEM_PURCHASE_NONCANONICAL_DELIVERY_RECEIPT");
      assert.deepEqual(JSON.parse(json(receipt.toJSON())), operation.receipt, "HOLDEM_PURCHASE_DELIVERY_RECEIPT_CHANGED");
      const events = receipt.logs.filter(log => sameAddress(log.address, contract.target as string)).flatMap(log => {
        try { const event = contract.interface.parseLog(log); return event ? [event] : []; } catch { return []; }
      });
      const eventMatches = events.filter(event => kind === "reward" ? event.name === "Transfer" && sameAddress(event.args.from, delivery.sponsor)
        && sameAddress(event.args.to, player.wallet) && event.args[2] === BigInt(award)
        : kind === "approve" ? event.name === "Approval" && sameAddress(event.args.owner, player.wallet) && sameAddress(event.args.spender, delivery.contracts.account) && event.args[2] === BigInt(award)
        : event.name === "CashCredited" && event.args.agentId === BigInt(player.agentId) && sameAddress(event.args.from, player.wallet) && event.args.amount === BigInt(award));
      if (eventMatches.length !== 1) throw new Error("HOLDEM_PURCHASE_DELIVERY_EVENT_MISMATCH");
    }
    if (BigInt(deliveryReport.balances.afterDeposit.cash[seat]) - BigInt(deliveryReport.balances.before.cash[seat]) !== BigInt(award)) throw new Error("HOLDEM_PURCHASE_AWARD_CASH_MISMATCH");
  }
  const afterDeposit = deliveryReport.balances.afterDeposit;
  if ((await runtime.provider.getBlock(afterDeposit.blockNumber))?.hash !== afterDeposit.blockHash) throw new Error("HOLDEM_PURCHASE_DELIVERY_SNAPSHOT_REORG");
  for (const seat of seats) if (String(await runtime.account.getFunction("cash").staticCall(delivery.players[seat].agentId, { blockTag: afterDeposit.blockNumber })) !== afterDeposit.cash[seat]) throw new Error("HOLDEM_PURCHASE_DELIVERY_SNAPSHOT_MISMATCH");
}

async function snapshot(plan: HoldemPurchasePlan, runtime: HoldemMonadRuntime): Promise<PurchaseSnapshot> {
  const block = await runtime.provider.getBlock("latest"); if (!block?.hash) throw new Error("HOLDEM_PURCHASE_SNAPSHOT_REQUIRED");
  const values = await Promise.all([...plan.delivery.players.map(player => runtime.account.getFunction("cash").staticCall(player.agentId, { blockTag: block.number })),
    runtime.token.getFunction("balanceOf").staticCall(plan.delivery.provider, { blockTag: block.number }),
    runtime.manager.getFunction("totalOutstanding").staticCall({ blockTag: block.number }), runtime.manager.getFunction("getLoan").staticCall(0n, { blockTag: block.number })]);
  return { blockNumber: block.number, blockHash: block.hash, cash: [String(values[0]), String(values[1])], providerToken: String(values[2]),
    totalOutstanding: String(values[3]), task0LoanStatus: String(values[4].status) };
}
function checkHandle(plan: HoldemPurchasePlan, entry: PurchaseEntry, handle: PaymentHandle) {
  const { quote, input } = handle, expected = { ...PURCHASE_BODY, agentId: entry.agentId, taskId: "0" };
  assert.deepEqual(input, expected, "HOLDEM_PURCHASE_REQUEST_MISMATCH");
  if (handle.version !== 1 || quote.agentId !== entry.agentId || quote.taskId !== "0" || quote.chainId !== "10143" || quote.price !== HOLDEM_PURCHASE_POLICY.priceRaw
    || quote.service !== HOLDEM_PURCHASE_POLICY.service || quote.model !== HOLDEM_PURCHASE_POLICY.model || quote.tier !== undefined
    || !sameAddress(quote.account, plan.delivery.contracts.account) || !sameAddress(quote.asset, MONAD_USDC) || !sameAddress(quote.payTo, plan.delivery.provider)
    || quote.requestDigest !== requestDigest(input) || quote.paymentId !== paymentId("0", quote.requestDigest, quote.serverNonce)) throw new Error("HOLDEM_PURCHASE_UNTRUSTED_HANDLE");
  if (handle.submission?.rawTransaction) {
    const transaction = Transaction.from(handle.submission.rawTransaction);
    if (transaction.hash !== handle.submission.txHash || transaction.from !== entry.wallet || transaction.chainId !== MONAD_CHAIN_ID || transaction.to !== plan.delivery.contracts.account
      || transaction.nonce !== handle.submission.nonce) throw new Error("HOLDEM_PURCHASE_SIGNED_HANDLE_MISMATCH");
  }
}
async function verifyInference(plan: HoldemPurchasePlan, runtime: HoldemMonadRuntime, entry: PurchaseEntry, inference: Inference) {
  if (!entry.handle) throw new Error("HOLDEM_PURCHASE_HANDLE_REQUIRED");
  checkHandle(plan, entry, entry.handle); assert.deepEqual(inference.handle, entry.handle, "HOLDEM_PURCHASE_INFERENCE_HANDLE_MISMATCH");
  const quote = entry.handle.quote, receipt = inference.receipt;
  for (const key of ["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "chainId"] as const) assert.equal(receipt[key], quote[key], "HOLDEM_PURCHASE_RECEIPT_MISMATCH");
  for (const key of ["asset", "account", "payTo"] as const) assert.ok(sameAddress(receipt[key], quote[key]), "HOLDEM_PURCHASE_RECEIPT_MISMATCH");
  if (receipt.fromCash !== HOLDEM_PURCHASE_POLICY.priceRaw || receipt.fromCredit !== "0" || receipt.txHash !== entry.handle.submission?.txHash
    || receipt.model !== HOLDEM_PURCHASE_POLICY.model || receipt.upstream !== "kimi") throw new Error("HOLDEM_PURCHASE_CASH_ONLY_RECEIPT_REQUIRED");
  const raw = await runtime.provider.getTransactionReceipt(receipt.txHash), transaction = await runtime.provider.getTransaction(receipt.txHash);
  if (!raw || raw.status !== 1 || (await runtime.provider.getBlock(raw.blockNumber))?.hash !== raw.blockHash || !transaction
    || transaction.chainId !== MONAD_CHAIN_ID || !sameAddress(transaction.from, entry.wallet)) throw new Error("HOLDEM_PURCHASE_NONCANONICAL_PAYMENT_RECEIPT");
  verifyProviderPaid(quote, receipt, raw.toJSON() as RawReceipt);
  const call = accountInterface.parseTransaction({ data: transaction.data, value: transaction.value });
  if (!call || call.name !== "payProvider" || call.args[0] !== BigInt(entry.agentId) || !sameAddress(call.args[1], quote.payTo)
    || call.args[2] !== HOLDEM_MONAD_INFERENCE_PRICE || call.args[3] !== quote.paymentId || call.args[4].taskId !== 0n || call.args[5] !== "0x") throw new Error("HOLDEM_PURCHASE_PAYMENT_CALLDATA_MISMATCH");
  const payment = await runtime.account.getFunction("getPayment").staticCall(quote.paymentId);
  if (payment.agentId !== BigInt(entry.agentId) || payment.taskId !== 0n || payment.fromCash !== HOLDEM_MONAD_INFERENCE_PRICE || payment.fromCredit !== 0n || payment.refundedAmount !== 0n) throw new Error("HOLDEM_PURCHASE_PAYMENT_RECORD_MISMATCH");
  assert.deepEqual(receipt.usage, (inference.result as any)?.usage ?? null, "HOLDEM_PURCHASE_USAGE_MISMATCH");
  return raw;
}
function summary(inference: Inference) {
  const body = inference.result as any, choice = body?.choices?.[0];
  const usage: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number } = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) if (Number.isSafeInteger(body?.usage?.[key]) && body.usage[key] >= 0) usage[key] = body.usage[key];
  const taskCompleted = body?.model === HOLDEM_PURCHASE_POLICY.model && body.choices?.length === 1 && choice?.finish_reason === "stop"
    && choice.message?.role === "assistant" && typeof choice.message?.content === "string" && choice.message.content.trim() === CONFIRMATION
    && choice.message.tool_calls === undefined && choice.message.function_call === undefined;
  return { model: body?.model === HOLDEM_PURCHASE_POLICY.model ? HOLDEM_PURCHASE_POLICY.model : "unverified", usage,
    finishReason: ["stop", "length", "tool_calls", "content_filter"].includes(choice?.finish_reason) ? choice.finish_reason as string : null, taskCompleted };
}
function safeReceipt(receipt: InferenceReceipt): PublicReceipt {
  const { paymentId, agentId, taskId, requestDigest, service, price, asset, chainId, account, payTo, txHash, blockNumber, blockHash, fromCash, fromCredit, model, upstream } = receipt;
  return { paymentId, agentId, taskId, requestDigest, service, price, asset, chainId, account, payTo, txHash, blockNumber, blockHash, fromCash, fromCredit, model, upstream };
}
function reportFor(plan: HoldemPurchasePlan, session?: PurchaseSession): PurchaseReport {
  const complete = Boolean(session?.entries.length && session.entries.length === plan.delivery.result.winners.length
    && session.entries.every(entry => entry.state === "Delivered" && entry.inference && summary(entry.inference).taskCompleted) && session.cashConserved && session.paymentReceiptsCanonical);
  const entries = session?.entries ?? [];
  return { version: 1, mode: "holdem-monad-purchase", stage: !session ? "Plan" : complete ? "RewardInferenceComplete" : "Stopped",
    phase: !session ? "Plan" : complete ? "Complete" : "Stopped", chainId: "10143", upstreamMode: session?.upstreamMode ?? "real-kimi-system-https-proxy", readOnly: !session,
    source: { ...plan.delivery.source, deliveryReportDigest: plan.deliveryReportDigest }, model: HOLDEM_PURCHASE_POLICY.model, priceRaw: "10000", taskId: "0", maxPurchasesPerAwardedSeat: 1,
    purchases: entries.map(entry => ({ seat: entry.seat, agentId: entry.agentId, wallet: entry.wallet, awardRaw: entry.awardRaw, cashBefore: entry.cashBefore,
      ...(session?.after ? { cashAfter: session.after.cash[entry.seat] } : {}), state: entry.state, ...(entry.error ? { error: entry.error } : {}),
      ...(entry.paidReceipt ? { receipt: safeReceipt(entry.paidReceipt) } : {}), ...(entry.inference ? { receipt: safeReceipt(entry.inference.receipt), ...summary(entry.inference) } : {}) })),
    strategyCallsSeparate: true, physicalInferenceAttempts: entries.filter(entry => entry.physicalAttempt?.dispatchIntent).length,
    ...(session ? { before: session.before, ...(session.after ? { after: session.after } : {}) } : {}),
    verification: { sourceBound: true, rewardAndDepositReceiptsCanonical: Boolean(session), fromCredit: "0", newBorrowingRaw: "0",
      zeroDebt: Boolean(session && session.before.task0LoanStatus === "0" && session.before.totalOutstanding === "0" && session.after?.task0LoanStatus === "0" && session.after.totalOutstanding === "0"),
      totalPaidRaw: entries.reduce((total, entry) => total + BigInt(entry.paidReceipt?.fromCash ?? "0"), 0n).toString(), cashConserved: Boolean(session?.cashConserved) },
    evidence: { paymentReceiptsCanonical: Boolean(session?.paymentReceiptsCanonical) }, limitations: [
      "This stage buys one fixed short confirmation per awarded seat with already deposited testnet USDC cash; game strategy calls are a separate sponsor expense.",
      "One physical Kimi call per awarded seat, one route, no tools, no retry. The operator quote is not the vendor invoice.",
      "Existing Delivered cache is revalidated against canonical payment receipts without another signature or model call; unknown dispatch stays stopped.",
      "Public evidence contains whitelisted receipt and token usage only; private signed handles, physical requests/responses and raw receipts remain in the source's 0700/0600 journal.",
    ] };
}

/** Test transport is injectable here; the CLI always uses the real fixed Kimi route via the system HTTPS proxy. */
export async function executeHoldemMonadPurchase(plan: HoldemPurchasePlan, runtime: HoldemMonadRuntime, players: [Wallet, Wallet], upstream: Awaited<ReturnType<typeof loadProbeUpstream>>,
  options: { controlledUpstream?: typeof fetch; recover?: boolean; upstreamFetch?: typeof fetch } = {}) {
  if (plan.journalDirectory !== join(plan.delivery.sourceDirectory, ".private", "monad-purchase") || seats.some(seat => players[seat].address !== plan.delivery.players[seat].wallet)
    || upstream.name !== "kimi" || upstream.baseUrl !== "https://api.moonshot.cn/v1") throw new Error("HOLDEM_PURCHASE_SINGLE_SOURCE_BINDING_REQUIRED");
  await verifyHoldemAwardDeposits(plan, runtime);
  await sourceUnchanged(plan);
  const store = new SessionStore<PurchaseSession>(plan.journalDirectory); await store.start(options.recover);
  let session: PurchaseSession | undefined, relay: Relay | undefined, server: ReturnType<typeof createHttpServer> | undefined, client: InferCredit | undefined;
  let active: PurchaseEntry | undefined;
  const savePrivate = (name: string, value: unknown) => atomicJson(join(plan.journalDirectory, name), value);
  const persist = async () => { await store.write(session!); await atomicJson(join(plan.delivery.sourceDirectory, "monad-purchase-report.json"), reportFor(plan, session)); };
  try {
    const existing = await store.read();
    const mode = options.controlledUpstream ? "controlled-upstream" : "real-kimi-system-https-proxy";
    if (existing) { assert.deepEqual(existing.binding, plan, "HOLDEM_PURCHASE_JOURNAL_BINDING_MISMATCH"); if (existing.upstreamMode !== mode) throw new Error("HOLDEM_PURCHASE_UPSTREAM_MODE_MISMATCH");
      session = existing; delete session.cashConserved; delete session.paymentReceiptsCanonical; }
    else {
      const before = await snapshot(plan, runtime);
      if (before.task0LoanStatus !== "0" || before.totalOutstanding !== "0") throw new Error("HOLDEM_PURCHASE_ZERO_DEBT_REQUIRED");
      assert.deepEqual(before.cash, plan.deliveryReport.balances.afterDeposit.cash, "HOLDEM_PURCHASE_REWARD_CASH_ALREADY_CHANGED");
      session = { version: 1, binding: plan, upstreamMode: mode, before, entries: [] }; await persist();
    }
    const relayDirectory = join(plan.journalDirectory, "relay"); await mkdir(relayDirectory, { recursive: true, mode: 0o700 }); await chmod(relayDirectory, 0o700);
    const relayConfig: RelayConfig = { rpcUrl: "http://127.0.0.1:0", chainId: MONAD_CHAIN_ID, account: plan.delivery.contracts.account, asset: MONAD_USDC, assetDecimals: 6,
      payTo: plan.delivery.provider, service: { id: HOLDEM_PURCHASE_POLICY.service, model: HOLDEM_PURCHASE_POLICY.model, price: HOLDEM_MONAD_INFERENCE_PRICE,
        upstreams: [{ ...upstream, model: HOLDEM_PURCHASE_POLICY.model }] }, dataDir: relayDirectory, quoteTtl: 300, confirmations: 1, upstreamTimeout: HOLDEM_PURCHASE_POLICY.upstreamTimeoutMs, host: "127.0.0.1", port: 0 };
    const upstreamFetch: typeof fetch = async (url, init) => {
      if (!active?.handle || active.physicalAttempt || session!.entries.filter(entry => entry.physicalAttempt).length >= plan.delivery.result.winners.length
        || String(url) !== `${upstream.baseUrl}/chat/completions`) throw new Error("HOLDEM_PURCHASE_PHYSICAL_REQUEST_LIMIT");
      const request = JSON.parse(String(init?.body)); assert.deepEqual(request, physicalRequest(), "HOLDEM_PURCHASE_PHYSICAL_REQUEST_MISMATCH");
      checkHandle(plan, active, active.handle);
      const record = await relay!.store.read(active.handle.quote.paymentId);
      if (record.state !== "Processing" || record.quote.paymentId !== active.handle.quote.paymentId) throw new Error("HOLDEM_PURCHASE_PHYSICAL_DISPATCH_BINDING_REQUIRED");
      active.physicalAttempt = { dispatchIntent: true, requestDigest: sha(JSON.stringify(request)), request, outcome: "IntentPersisted" };
      await persist(); await savePrivate(`seat-${active.seat}-request.json`, request);
      const started = Date.now();
      try {
        const response = await (options.controlledUpstream ?? options.upstreamFetch!)(url, init), rawText = await response.text();
        active.physicalAttempt.response = { status: response.status, rawText }; active.physicalAttempt.outcome = response.ok ? "Delivered" : "HTTPRejected";
        await savePrivate(`seat-${active.seat}-response.json`, { status: response.status, rawText });
        return new Response(rawText, { status: response.status, headers: response.headers });
      } catch { active.physicalAttempt.outcome = "Unknown"; throw new Error("HOLDEM_PURCHASE_UNKNOWN_PHYSICAL_RESULT"); }
      finally { active.physicalAttempt.durationMs = Date.now() - started; await persist(); }
    };
    relay = new Relay(relayConfig, { provider: runtime.provider, upstreamFetch }); await relay.initialize();
    if (!await runtime.account.getFunction("providerWhitelist").staticCall(plan.delivery.provider)) throw new Error("HOLDEM_PURCHASE_PROVIDER_NOT_WHITELISTED");
    server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
    for (const seat of plan.delivery.result.winners) {
      active = session.entries.find(entry => entry.seat === seat);
      try {
        if (active) {
          if (!active.handle) throw new Error("HOLDEM_PURCHASE_UNKNOWN_NO_REDISPATCH");
          checkHandle(plan, active, active.handle);
          const cached: PaymentRecord = await relay.store.read(active.handle.quote.paymentId);
          if (cached.state !== "Delivered" || !cached.result || !cached.receipt) throw new Error("HOLDEM_PURCHASE_UNKNOWN_NO_REDISPATCH");
          assert.deepEqual(cached.request, active.handle.input); assert.deepEqual(cached.quote, active.handle.quote);
          active.inference = { result: cached.result, receipt: cached.receipt, handle: structuredClone(active.handle) };
        } else {
          const player = plan.delivery.players[seat];
          active = { seat, agentId: player.agentId, wallet: player.wallet, awardRaw: plan.delivery.allocations[seat], cashBefore: session.before.cash[seat], dispatchIntent: true, state: "Unknown" };
          if (BigInt(active.awardRaw) < HOLDEM_MONAD_INFERENCE_PRICE || BigInt(await runtime.account.getFunction("cash").staticCall(active.agentId)) < HOLDEM_MONAD_INFERENCE_PRICE) throw new Error("HOLDEM_PURCHASE_REWARD_CASH_REQUIRED");
          session.entries.push(active); await persist();
          client = new InferCredit({ agentId: active.agentId, chainId: MONAD_CHAIN_ID, account: plan.delivery.contracts.account, asset: MONAD_USDC,
            provider: plan.delivery.provider, maxPrice: HOLDEM_MONAD_INFERENCE_PRICE, signer: players[seat], timeoutMs: HOLDEM_PURCHASE_POLICY.sdkTimeoutMs,
            onHandle: async handle => { checkHandle(plan, active!, handle); active!.handle = handle; await persist(); },
            beforePayment: async handle => { checkHandle(plan, active!, handle); await sourceUnchanged(plan); } });
          active.inference = await client.fetch(url, { body: structuredClone(PURCHASE_BODY) });
          client.close(); client = undefined;
        }
        const raw = await verifyInference(plan, runtime, active, active.inference);
        active.paidReceipt = active.inference.receipt; active.rawReceipt = raw.toJSON(); await savePrivate(`seat-${seat}-payment-receipt.json`, active.rawReceipt);
        active.state = summary(active.inference).taskCompleted ? "Delivered" : "Stopped";
        if (active.state !== "Delivered") active.error = "HOLDEM_PURCHASE_CONFIRMATION_NOT_COMPLETED"; else delete active.error;
        await persist();
        if (active.state !== "Delivered") break;
      } catch (error) {
        active!.state = "Unknown"; active!.error = failureCode(error);
        // A failed model response can still be an already-confirmed cash payment. Publish its verified receipt, never retry it.
        if (active?.handle?.submission?.txHash) {
          try {
            const proof = await relay.proof(active.handle.quote, active.handle.submission.txHash);
            const { quote } = active.handle;
            const paid: InferenceReceipt = { ...proof, paymentId: quote.paymentId, agentId: quote.agentId, taskId: quote.taskId,
              requestDigest: quote.requestDigest, service: quote.service, price: quote.price, asset: quote.asset, chainId: quote.chainId,
              account: quote.account, payTo: quote.payTo, model: HOLDEM_PURCHASE_POLICY.model, upstream: "kimi", usage: null };
            const raw = await verifyInference(plan, runtime, active, { result: {}, receipt: paid, handle: active.handle });
            active.paidReceipt = paid; active.rawReceipt = raw.toJSON(); await savePrivate(`seat-${seat}-payment-receipt.json`, active.rawReceipt);
          } catch { /* Unconfirmed or inconsistent paid evidence is not represented as a canonical receipt. */ }
        }
        await persist(); break;
      }
    }
    session.after = await snapshot(plan, runtime);
    const paid = session.entries.filter(entry => entry.paidReceipt), totalPaid = HOLDEM_MONAD_INFERENCE_PRICE * BigInt(paid.length);
    for (const seat of seats) assert.equal(BigInt(session.before.cash[seat]) - BigInt(session.after.cash[seat]), paid.some(entry => entry.seat === seat) ? HOLDEM_MONAD_INFERENCE_PRICE : 0n, "HOLDEM_PURCHASE_CASH_FLOW_MISMATCH");
    assert.equal(BigInt(session.after.providerToken) - BigInt(session.before.providerToken), totalPaid, "HOLDEM_PURCHASE_PROVIDER_FLOW_MISMATCH");
    assert.equal(session.after.totalOutstanding, session.before.totalOutstanding); assert.equal(session.after.task0LoanStatus, "0");
    session.cashConserved = true; session.paymentReceiptsCanonical = true;
    session.report = reportFor(plan, session); await persist(); return structuredClone(session.report);
  } catch (error) {
    if (!session) throw error;
    session.after = await snapshot(plan, runtime).catch(() => undefined);
    const report = reportFor(plan, session); report.stage = "Stopped"; report.phase = "Stopped"; report.error = failureCode(error);
    report.verification.cashConserved = false; report.evidence.paymentReceiptsCanonical = false; session.report = report;
    await store.write(session); await atomicJson(join(plan.delivery.sourceDirectory, "monad-purchase-report.json"), report); return structuredClone(report);
  } finally {
    client?.close(); server?.closeAllConnections(); if (server?.listening) await new Promise<void>(done => server!.close(() => done())); relay?.close(); await store.close();
  }
}

export async function runHoldemMonadPurchase(config: HoldemMonadConfig, options: { execute?: boolean; recover?: boolean; rpcUrlFile?: string; rpcTransport?: RpcTransport } = {}) {
  const { plan, monadConfig } = await buildHoldemMonadPurchasePlan(config);
  const connection = await monadProvider(options.rpcUrlFile ? await readRpcUrlFile(options.rpcUrlFile) : monadConfig.rpcUrl, options.rpcTransport ?? "direct");
  let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  try {
    const { report: preflight, runtime } = await preflightHoldemMonad(plan.delivery, config, monadConfig, connection.provider);
    await verifyHoldemAwardDeposits(plan, runtime);
    if (!options.execute) { const report = reportFor(plan); report.ready = preflight.ready;
      report.verification.rewardAndDepositReceiptsCanonical = true; return report; }
    if (!preflight.ready) throw new Error("HOLDEM_PURCHASE_PREFLIGHT_NOT_READY");
    const upstream = await loadProbeUpstream(config.monadConfigFile);
    const players = await Promise.all(config.players.map(async player => new Wallet(await readSecret(player.keyFile), connection.provider))) as [Wallet, Wallet];
    const upstreamFetch: typeof fetch = async (input, init) => {
      transport ??= proxyUpstreamFetch(await systemHttpsProxy(), HOLDEM_PURCHASE_POLICY.upstreamTimeoutMs);
      return transport.fetch(input, init);
    };
    return await executeHoldemMonadPurchase(plan, runtime, players, upstream, { upstreamFetch, recover: options.recover });
  } finally { transport?.close(); connection.close(); }
}
export async function main(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: "string" }, execute: { type: "boolean", default: false }, recover: { type: "boolean", default: false },
    "rpc-url-file": { type: "string" }, "rpc-transport": { type: "string", default: "direct" }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log("holdem-monad-purchase --config /absolute/private/holdem.json [--rpc-url-file /absolute/private/rpc-url --rpc-transport direct|system-https-proxy --execute --recover]. Default: read-only confirmed reward/deposit plan. At most one cash-funded Kimi call per winner; unknown dispatch is never repeated."); return; }
  if (!values.config) throw new Error("HOLDEM_PURCHASE_CONFIG_REQUIRED");
  if (!["direct", "system-https-proxy"].includes(values["rpc-transport"])) throw new Error("INVALID_RPC_TRANSPORT");
  if (values.recover && !values.execute) throw new Error("HOLDEM_RECOVER_REQUIRES_EXECUTE");
  const report = await runHoldemMonadPurchase(await loadHoldemMonadConfig(values.config), { execute: values.execute, recover: values.recover,
    rpcUrlFile: values["rpc-url-file"], rpcTransport: values["rpc-transport"] as RpcTransport });
  console.log(json(report)); return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).then(report => {
  if (report && report.stage === "Stopped") process.exitCode = 1;
}).catch(error => { reportDemoFailure(error); process.exitCode = 1; });
