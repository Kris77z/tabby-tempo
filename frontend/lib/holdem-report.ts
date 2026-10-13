// Node-only reader. Page and route imports enforce the server-only boundary.
import { readFile, realpath, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { basename, isAbsolute, normalize, sep } from "node:path";
import type { HoldemAction, HoldemBalance, HoldemMonadBalance, HoldemMonadDelivery, HoldemMonadPurchase, HoldemPhase, HoldemReport, HoldemResult, HoldemSeat, HoldemSnapshot, HoldemStreet, HoldemUsage } from "./holdem-types";

function invalid(): never { throw new Error("HOLDEM_REPORT_INVALID"); }
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : invalid();
const integer = (value: unknown, max = Number.MAX_SAFE_INTEGER): number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : invalid();
const raw = (value: unknown): string => typeof value === "string" && /^(0|[1-9]\d{0,77})$/.test(value) ? value : invalid();
const hash = (value: unknown): string => typeof value === "string" && /^0x[\da-f]{64}$/i.test(value) ? value : invalid();
const identifier = (value: unknown, max = 128): string => typeof value === "string" && value.length <= max && /^[A-Za-z0-9_./:-]+$/.test(value) ? value : invalid();
const list = (value: unknown, max: number): unknown[] => Array.isArray(value) && value.length <= max ? value : invalid();
const seat = (value: unknown): HoldemSeat => value === 0 || value === 1 ? value : invalid();
const pair = <T>(value: unknown, read: (item: unknown) => T): [T, T] => { const items = list(value, 2); return items.length === 2 ? [read(items[0]), read(items[1])] : invalid(); };
const cards = (value: unknown): string[] => {
  const result = list(value, 5).map(card => typeof card === "string" && /^[2-9TJQKA][cdhs]$/.test(card) ? card : invalid());
  return new Set(result).size === result.length ? result : invalid();
};
const street = (value: unknown): HoldemStreet => value === "preflop" || value === "flop" || value === "turn" || value === "river" ? value : invalid();
function action(value: unknown): HoldemAction {
  const item = record(value);
  if (item.type === "raise") return { type: "raise", to: integer(item.to) };
  return item.type === "fold" || item.type === "check" || item.type === "call" || item.type === "all-in" ? { type: item.type } : invalid();
}
function usage(value: unknown): HoldemUsage | undefined {
  if (value === undefined) return undefined;
  const item = record(value), output: HoldemUsage = {};
  for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"] as const) if (item[key] !== undefined) output[key] = integer(item[key]);
  return output;
}
function result(value: unknown): HoldemResult | null {
  if (value === null || value === undefined) return null;
  const item = record(value);
  if (item.reason !== "fold" && item.reason !== "showdown") invalid();
  const winners = list(item.winners, 2).map(seat);
  if (!winners.length || new Set(winners).size !== winners.length) invalid();
  return { reason: item.reason as HoldemResult["reason"], winners, contestedPot: integer(item.contestedPot), payouts: pair(item.payouts, integer), refunds: pair(item.refunds, integer), finalStacks: pair(item.finalStacks, integer) };
}
function balance(value: unknown): HoldemBalance {
  const item = record(value);
  return { sponsor: raw(item.sponsor), wallets: pair(item.wallets, raw), cash: pair(item.cash, raw), provider: raw(item.provider), totalOutstanding: raw(item.totalOutstanding) };
}

/** Build a new public object at every level. Never spread source records or expose model request/response text. */
export function sanitizeHoldemReport(value: unknown): HoldemReport {
  const input = record(value), live = input.mode === "holdem-live";
  const phases: HoldemPhase[] = ["Starting", "Running", "Complete", "Stopped", "PreflightFailed", "SettlementUncertain"];
  const phase = live && phases.includes(input.phase as HoldemPhase) ? input.phase as HoldemPhase : !live && input.verified === true ? "Complete" : invalid();
  const game = record(input.game), chips = record(game.chips);
  const steps = list(game.steps, 512).map(value => {
    const item = record(value);
    return { seat: seat(item.seat), street: street(item.street), action: action(item.action), board: cards(item.board), stacks: pair(item.stacks, integer), pot: integer(item.pot) };
  });
  const gameResult = result(game.result);
  if (phase !== "Complete" && phase !== "SettlementUncertain" && gameResult !== null) invalid();
  if (phase === "Complete" && gameResult === null) invalid();
  const chainEvidence = input.chainEvidence === undefined ? {} : record(input.chainEvidence);
  let chainId = chainEvidence.chainId === undefined ? undefined : raw(chainEvidence.chainId);
  const strategy = !live ? "scripted" : input.upstreamMode === "real-kimi-system-https-proxy" ? "real-model" : input.upstreamMode === "controlled-upstream" ? "controlled-model" : invalid();
  const output: HoldemReport = {
    matchId: identifier(input.matchId), verified: input.verified === true, phase, network: "unknown", strategy,
    game: { entryFee: raw(game.entryFee), strategyInferenceCalls: integer(game.strategyInferenceCalls), chips: { initialPerSeat: integer(chips.initialPerSeat), smallBlind: integer(chips.smallBlind), bigBlind: integer(chips.bigBlind) }, steps, finalBoard: cards(game.finalBoard), result: gameResult },
    reward: null, inference: null, evidence: { publicReplayVerified: false, chainEvidenceRecorded: chainEvidence.file === "chain-evidence.json" }, verification: {},
  };
  // Expose a reason code only; error messages may contain upstream credentials or private prompts.
  if (typeof input.reason === "string" && /^[A-Z][A-Z0-9_]{0,79}$/.test(input.reason)) output.reason = input.reason;
  if (live && input.strategyInference !== undefined) {
    const info = record(input.strategyInference);
    output.strategyInference = { calls: integer(info.calls ?? info.paidInferenceAttempts, 512), maxCalls: integer(info.maxCalls, 512), vendorInvoiceVerified: info.vendorInvoiceVerified === true,
      attempts: list(info.attempts, 512).map(value => {
        const item = record(value);
        const outcomes = ["IntentPersisted", "Applied", "HTTPRejected", "ResponseInvalid", "OutcomeUnknown", "DeadlineExpired"] as const;
        if (!outcomes.includes(item.outcome as typeof outcomes[number])) invalid();
        return { turn: integer(item.turn, 512), seat: seat(item.seat), requestedModel: identifier(item.requestedModel, 80), outcome: item.outcome as typeof outcomes[number],
          ...(item.status !== undefined ? { status: integer(item.status, 599) } : {}), ...(item.durationMs !== undefined ? { durationMs: integer(item.durationMs) } : {}), ...(item.usage !== undefined ? { usage: usage(item.usage) } : {}) };
      }) };
  }
  if (input.reward !== null && input.reward !== undefined) {
    if (phase !== "Complete" && phase !== "SettlementUncertain") invalid();
    const reward = record(input.reward);
    output.reward = { rawAmount: raw(reward.rawAmount), decimals: integer(reward.decimals, 36), allocations: pair(reward.allocations, raw),
      transfers: list(reward.transfers, 2).map(value => { const item = record(value); return { seat: seat(item.seat), agentId: raw(item.agentId), amount: raw(item.amount), txHash: hash(item.txHash), blockNumber: integer(item.blockNumber) }; }) };
    if (typeof reward.replayDigest === "string" && /^[\da-f]{64}$/i.test(reward.replayDigest)) output.reward.replayDigest = reward.replayDigest;
    if (typeof reward.repeatedSettlementPaidAgain === "boolean") output.reward.repeatedSettlementPaidAgain = reward.repeatedSettlementPaidAgain;
  }
  if (input.inference !== null && input.inference !== undefined) {
    if (phase !== "Complete" && phase !== "SettlementUncertain") invalid();
    const inference = record(input.inference);
    output.inference = { rawPricePerWinner: raw(inference.rawPricePerWinner), taskId: raw(inference.taskId), calls: integer(inference.calls), purchases: list(inference.purchases, 2).map(value => {
      const item = record(value), receipt = record(item.receipt), receiptChainId = raw(receipt.chainId);
      if (chainId !== undefined && chainId !== receiptChainId) invalid();
      chainId = receiptChainId;
      return { seat: seat(item.seat), agentId: raw(item.agentId), award: raw(item.award), deposited: raw(item.deposited), depositTxHash: hash(item.depositTxHash),
        receipt: { txHash: hash(receipt.txHash), blockNumber: integer(receipt.blockNumber), fromCash: raw(receipt.fromCash), fromCredit: raw(receipt.fromCredit), taskId: raw(receipt.taskId), chainId: receiptChainId,
          ...(receipt.model !== undefined ? { model: identifier(receipt.model, 80) } : {}), ...(receipt.usage !== undefined ? { usage: usage(receipt.usage) } : {}) } };
    }) };
  }
  if (input.balances !== undefined) {
    const values = record(input.balances);
    output.balances = {};
    for (const key of ["before", "afterGame", "afterAward", "afterPurchase"] as const) if (values[key] !== undefined) output.balances[key] = balance(values[key]);
  }
  if (input.evidence !== undefined) {
    const evidence = record(input.evidence);
    output.evidence.publicReplayVerified = evidence.publicReplayVerified === true;
    output.evidence.chainEvidenceRecorded ||= evidence.chainEvidenceFile === "chain-evidence.json";
  } else output.evidence.publicReplayVerified = !live && input.verified === true;
  if (input.verification !== undefined) {
    const verification = record(input.verification);
    for (const key of ["gameWalletSpend", "fromCredit", "loanPrincipal", "totalOutstanding"] as const) if (verification[key] !== undefined) output.verification[key] = raw(verification[key]);
    if (typeof verification.rewardConserved === "boolean") output.verification.rewardConserved = verification.rewardConserved;
  }
  if (chainId === undefined && input.network === "local-anvil") chainId = "31337";
  if (chainId !== undefined) output.chainId = chainId;
  output.network = chainId === "31337" ? "local-anvil" : chainId === "10143" ? "monad-testnet" : chainId === "143" ? "monad-mainnet" : "unknown";
  return output;
}

export function fixtureHoldemReport(): HoldemReport {
  const board = ["4h", "7h", "8c", "3c", "7d"];
  const tx = (n: string) => `0x${n.repeat(64)}`;
  return sanitizeHoldemReport({ verified: true, matchId: "fixture-heads-up", game: { entryFee: "0", strategyInferenceCalls: 0, chips: { initialPerSeat: 1000, smallBlind: 5, bigBlind: 10 },
    steps: [
      { seat: 0, street: "preflop", action: { type: "call" }, board: [], stacks: [995, 990], pot: 15 },
      { seat: 1, street: "preflop", action: { type: "check" }, board: [], stacks: [990, 990], pot: 20 },
      ...(["flop", "turn", "river"] as const).flatMap((street, i) => ([1, 0] as const).map(seat => ({ seat, street, action: { type: "check" }, board: board.slice(0, i + 3), stacks: [990, 990], pot: 20 }))),
    ], finalBoard: board, result: { reason: "showdown", winners: [0], contestedPot: 20, payouts: [20, 0], refunds: [0, 0], finalStacks: [1010, 990] } },
    reward: { rawAmount: "100000", decimals: 6, allocations: ["100000", "0"], transfers: [{ seat: 0, agentId: "1", amount: "100000", txHash: tx("1"), blockNumber: 30 }], repeatedSettlementPaidAgain: false },
    inference: { rawPricePerWinner: "10000", taskId: "0", calls: 1, purchases: [{ seat: 0, agentId: "1", award: "100000", deposited: "100000", depositTxHash: tx("2"), receipt: { txHash: tx("3"), blockNumber: 32, fromCash: "10000", fromCredit: "0", taskId: "0", chainId: "31337", model: "controlled-reward-physical", usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } } }] },
    balances: { before: { sponsor: "90000000", wallets: ["960000", "0"], cash: ["40000", "0"], provider: "0", totalOutstanding: "0" }, afterGame: { sponsor: "90000000", wallets: ["960000", "0"], cash: ["40000", "0"], provider: "0", totalOutstanding: "0" }, afterAward: { sponsor: "89900000", wallets: ["1060000", "0"], cash: ["40000", "0"], provider: "0", totalOutstanding: "0" }, afterPurchase: { sponsor: "89900000", wallets: ["960000", "0"], cash: ["130000", "0"], provider: "10000", totalOutstanding: "0" } },
    chainEvidence: { file: "chain-evidence.json", chainId: "31337" }, verification: { gameWalletSpend: "0", fromCredit: "0", loanPrincipal: "0", totalOutstanding: "0", rewardConserved: true } });
}

function allowedPath(path: string, filename: string): boolean {
  return isAbsolute(path) && basename(path) === filename && !normalize(path).split(sep).some(part => part === ".private");
}
async function readPublicJson(path: string, filename: string): Promise<{ value: unknown; digest: string }> {
  if (!allowedPath(path, filename)) invalid();
  const actual = await realpath(path);
  if (!allowedPath(actual, filename)) invalid();
  const info = await stat(actual);
  if (!info.isFile() || info.size > 2_000_000) invalid();
  const content = await readFile(actual, "utf8");
  return { value: JSON.parse(content), digest: createHash("sha256").update(content).digest("hex") };
}
export async function readHoldemReport(path: string): Promise<HoldemReport> {
  return sanitizeHoldemReport((await readPublicJson(path, "report.json")).value);
}
function monadBalance(value: unknown): HoldemMonadBalance {
  const item = record(value);
  return { blockNumber: integer(item.blockNumber), cash: pair(item.cash, raw), walletsToken: pair(item.walletsToken, raw), providerToken: raw(item.providerToken), totalOutstanding: raw(item.totalOutstanding) };
}
export function sanitizeHoldemDelivery(value: unknown, report: HoldemReport, reportDigest: string): HoldemMonadDelivery {
  const input = record(value), plan = record(input.plan), source = record(plan.source), asset = record(plan.asset);
  if (input.version !== 1 || input.mode !== "holdem-monad" || input.phase !== "RewardDeposited" || input.chainId !== "10143" || input.stageComplete !== true || input.fullAcceptanceComplete !== false ||
    source.matchId !== report.matchId || source.reportDigest !== reportDigest || typeof source.replayDigest !== "string" || !/^[\da-f]{64}$/i.test(source.replayDigest) || source.replayDigest !== report.reward?.replayDigest || source.network !== "local-anvil" || report.strategy !== "real-model" || report.phase !== "Complete" || !report.verified ||
    source.upstreamMode !== "real-kimi-system-https-proxy" || asset.symbol !== "USDC" || asset.decimals !== 6 || plan.chainId !== "10143" || plan.entryFee !== "0") invalid();
  const allocations = pair(plan.allocations, raw);
  if (JSON.stringify(allocations) !== JSON.stringify(report.reward?.allocations) || plan.reward !== report.reward?.rawAmount) invalid();
  const balances = record(input.balances), verification = record(input.verification);
  return { phase: "RewardDeposited", chainId: "10143", matchId: report.matchId, decimals: 6, rewardRaw: raw(plan.reward), allocations,
    players: list(plan.players, 2).map(value => { const item = record(value); return { seat: seat(item.seat), agentId: raw(item.agentId) }; }),
    operations: list(input.operations, 6).map(value => {
      const item = record(value), receipt = record(item.receipt), transaction = record(item.transaction);
      if ((item.kind !== "reward" && item.kind !== "approve" && item.kind !== "deposit") || receipt.status !== 1 || receipt.hash !== item.txHash || receipt.blockNumber !== item.blockNumber || transaction.chainId !== "10143" || transaction.hash !== item.txHash) invalid();
      return { kind: item.kind as "reward" | "approve" | "deposit", seat: seat(item.seat), amount: raw(item.amount), txHash: hash(item.txHash), blockNumber: integer(item.blockNumber) };
    }), balances: { before: monadBalance(balances.before), afterAward: monadBalance(balances.afterAward), afterDeposit: monadBalance(balances.afterDeposit) },
    verification: { rewardConserved: verification.rewardConserved === true, newBorrowingRaw: raw(verification.newBorrowingRaw), totalOutstandingUnchanged: verification.totalOutstandingUnchanged === true } };
}
export function sanitizeHoldemPurchase(value: unknown, report: HoldemReport, reportDigest: string, delivery: HoldemMonadDelivery, deliveryDigest: string): HoldemMonadPurchase {
  const input = record(value), source = record(input.source);
  if (input.version !== 1 || input.mode !== "holdem-monad-purchase" || !["Complete", "Plan", "Stopped"].includes(String(input.phase)) || input.chainId !== "10143" || input.taskId !== "0" ||
    source.matchId !== report.matchId || source.reportDigest !== reportDigest || source.replayDigest !== report.reward?.replayDigest || source.deliveryReportDigest !== deliveryDigest || input.maxPurchasesPerAwardedSeat !== 1) invalid();
  const strategy = input.upstreamMode === "real-kimi-system-https-proxy" ? "real-model" : input.upstreamMode === "controlled-upstream" ? "controlled-model" : invalid();
  const verification = record(input.verification), evidence = input.evidence === undefined ? {} : record(input.evidence);
  const output: HoldemMonadPurchase = { phase: input.phase as HoldemMonadPurchase["phase"], chainId: "10143", matchId: report.matchId, strategy, model: identifier(input.model, 80), priceRaw: raw(input.priceRaw), physicalInferenceAttempts: integer(input.physicalInferenceAttempts, 2),
    purchases: list(input.purchases, 2).map(value => {
      const item = record(value), player = delivery.players.find(player => player.seat === item.seat);
      if (!player || item.agentId !== player.agentId || !["Delivered", "Unknown", "Stopped"].includes(String(item.state))) invalid();
      const purchase: HoldemMonadPurchase["purchases"][number] = { seat: seat(item.seat), agentId: raw(item.agentId), awardRaw: raw(item.awardRaw), cashBefore: raw(item.cashBefore), ...(item.cashAfter !== undefined ? { cashAfter: raw(item.cashAfter) } : {}), state: item.state as "Delivered" | "Unknown" | "Stopped" };
      if (item.receipt !== undefined) {
        const receipt = record(item.receipt);
        if (receipt.chainId !== "10143" || receipt.taskId !== "0" || receipt.agentId !== item.agentId) invalid();
        purchase.receipt = { txHash: hash(receipt.txHash), blockNumber: integer(receipt.blockNumber), fromCash: raw(receipt.fromCash), fromCredit: raw(receipt.fromCredit), taskId: "0", ...(receipt.model !== undefined ? { model: identifier(receipt.model, 80) } : {}) };
      }
      if (item.usage !== undefined) purchase.usage = usage(item.usage);
      if (typeof item.taskCompleted === "boolean") purchase.taskCompleted = item.taskCompleted;
      return purchase;
    }), verification: { zeroDebt: verification.zeroDebt === true, cashConserved: verification.cashConserved === true, paymentReceiptsCanonical: evidence.paymentReceiptsCanonical === true } };
  if (output.phase === "Complete" && (!output.purchases.length || output.purchases.some(item => item.state !== "Delivered" || !item.receipt || item.taskCompleted !== true || item.cashAfter === undefined))) invalid();
  for (const key of ["before", "after"] as const) if (input[key] !== undefined) {
    const item = record(input[key]); output[key] = { cash: pair(item.cash, raw), providerToken: raw(item.providerToken), totalOutstanding: raw(item.totalOutstanding) };
  }
  for (const key of ["fromCredit", "newBorrowingRaw", "totalPaidRaw"] as const) if (verification[key] !== undefined) output.verification[key] = raw(verification[key]);
  return output;
}
export async function loadHoldemSnapshot(path = process.env.HOLDEM_REPORT_PATH, deliveryPath = process.env.HOLDEM_DELIVERY_REPORT_PATH, purchasePath = process.env.HOLDEM_PURCHASE_REPORT_PATH): Promise<HoldemSnapshot> {
  const loadedAt = new Date().toISOString();
  if (!path) return { source: "fixture", loadedAt, report: fixtureHoldemReport() };
  let main: { value: unknown; digest: string }, report: HoldemReport;
  try { main = await readPublicJson(path, "report.json"); report = sanitizeHoldemReport(main.value); }
  catch { return { source: "report", loadedAt, report: null, error: { code: "HOLDEM_REPORT_UNAVAILABLE", message: "公开德州报告无法读取或格式不受支持。请检查服务端 HOLDEM_REPORT_PATH 后重试。" } }; }
  const snapshot: HoldemSnapshot = { source: "report", loadedAt, report };
  const [deliveryFile, purchaseFile] = await Promise.allSettled([deliveryPath ? readPublicJson(deliveryPath, "monad-delivery-report.json") : Promise.resolve(undefined), purchasePath ? readPublicJson(purchasePath, "monad-purchase-report.json") : Promise.resolve(undefined)]);
  if (deliveryPath) {
    try { if (deliveryFile.status !== "fulfilled" || !deliveryFile.value) invalid(); snapshot.delivery = sanitizeHoldemDelivery(deliveryFile.value.value, report, main.digest); }
    catch { snapshot.deliveryError = deliveryFile.status === "rejected" && (deliveryFile.reason as NodeJS.ErrnoException)?.code === "ENOENT" ? "Monad 奖励证据尚未生成。文件到位后可刷新读取。" : "Monad 奖励证据不可读取、格式不受支持或与当前牌局不一致。"; }
  }
  if (purchasePath) {
    try {
      if (!snapshot.delivery || deliveryFile.status !== "fulfilled" || !deliveryFile.value || purchaseFile.status !== "fulfilled" || !purchaseFile.value) invalid();
      snapshot.purchase = sanitizeHoldemPurchase(purchaseFile.value.value, report, main.digest, snapshot.delivery, deliveryFile.value.digest);
    } catch { snapshot.purchaseError = purchaseFile.status === "rejected" && (purchaseFile.reason as NodeJS.ErrnoException)?.code === "ENOENT" ? "Monad 推理购买证据尚未生成。文件到位后可刷新读取。" : "Monad 推理购买证据不可读取、格式不受支持或与当前牌局及奖励报告不一致。"; }
  }
  return snapshot;
}
