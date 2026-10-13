import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Transaction } from "ethers";
import { accountInterface, paymentId, requestDigest, sameAddress, type Quote, type InferenceReceipt } from "@agentfuel/sdk/protocol";
import type { PaymentHandle } from "@agentfuel/sdk";
import type { PaymentRecord } from "../services/provider-relay/src/store.js";

export interface RawReceipt {
  status: number; to: string; hash: string; blockNumber: number; blockHash: string;
  logs: { address: string; topics: string[]; data: string }[];
}
export function verifyProviderPaid(quote: Quote, receipt: InferenceReceipt, raw: RawReceipt) {
  assert.equal(raw.status, 1); assert.equal(raw.hash, receipt.txHash); assert.ok(sameAddress(raw.to, quote.account));
  assert.equal(raw.blockNumber, receipt.blockNumber); assert.equal(raw.blockHash, receipt.blockHash);
  const events = raw.logs.filter(log => sameAddress(log.address, quote.account)).map(log => {
    try { return accountInterface.parseLog(log); } catch { return null; }
  }).filter(event => event?.name === "ProviderPaid" && event.args.paymentId === quote.paymentId);
  assert.equal(events.length, 1);
  const event = events[0]!;
  assert.equal(event.args.agentId, BigInt(quote.agentId)); assert.ok(sameAddress(event.args.provider, quote.payTo));
  assert.equal(event.args.fromCash, BigInt(receipt.fromCash)); assert.equal(event.args.fromCredit, BigInt(receipt.fromCredit));
  assert.equal(event.args.fromCash + event.args.fromCredit, BigInt(quote.price));
}

export interface ProbeArtifact {
  handle: PaymentHandle; response: any; receipt: InferenceReceipt; record: PaymentRecord; rawReceipt?: RawReceipt;
}
export function verifyProbeEvidence(report: any, artifacts: { cheap: ProbeArtifact; strong: ProbeArtifact }) {
  const tiers: Record<string, unknown> = {};
  const prices: bigint[] = [], nonces: number[] = [];
  let rawEventCount = 0;
  for (const tier of ["cheap", "strong"] as const) {
    const { handle, response, receipt, record, rawReceipt } = artifacts[tier]; const quote = handle.quote;
    const expectedModel = report.plan.models[tier], expectedPrice = report.plan.operatorPricesRaw[tier];
    assert.equal(handle.input.tier, tier); assert.equal(quote.tier, tier); assert.equal(receipt.tier, tier);
    assert.equal(quote.price, expectedPrice); assert.equal(receipt.price, quote.price);
    assert.equal(quote.chainId, "31337"); assert.equal(receipt.chainId, quote.chainId);
    assert.equal(receipt.agentId, quote.agentId); assert.equal(receipt.taskId, quote.taskId); assert.equal(receipt.service, quote.service);
    for (const field of ["asset", "account", "payTo"] as const) assert.ok(sameAddress(receipt[field], quote[field]));
    assert.equal(quote.requestDigest, requestDigest(handle.input)); assert.equal(receipt.requestDigest, quote.requestDigest);
    assert.equal(quote.paymentId, paymentId(quote.taskId, quote.requestDigest, quote.serverNonce)); assert.equal(receipt.paymentId, quote.paymentId);
    assert.equal(receipt.model, expectedModel); assert.equal(response.model, expectedModel); assert.equal(receipt.upstream, "kimi");
    assert.deepEqual(receipt.usage, response.usage); assert.equal(handle.input.max_completion_tokens, 128);
    const choice = response.choices[0]; assert.equal(choice.finish_reason, "stop"); assert.equal(choice.message.content.trim(), "OK");
    if (tier === "cheap") { assert.deepEqual(handle.input.thinking, { type: "disabled" }); assert.equal(handle.input.reasoning_effort, undefined); }
    else { assert.equal(handle.input.reasoning_effort, "low"); assert.equal(handle.input.thinking, undefined); }
    assert.equal(BigInt(receipt.fromCash) + BigInt(receipt.fromCredit), BigInt(quote.price)); assert.equal(receipt.fromCredit, "0");
    assert.equal(record.state, "Delivered"); assert.deepEqual(record.quote, quote); assert.deepEqual(record.request, handle.input);
    assert.deepEqual(record.result, response); assert.deepEqual(record.receipt, receipt); assert.equal(record.route?.tier, tier);
    assert.equal(record.route?.upstreams[0].model, expectedModel); assert.equal(record.route?.upstreams[0].name, "kimi");
    assert.deepEqual(report.tiers[tier].quote, quote); assert.deepEqual(report.tiers[tier].receipt, receipt);
    assert.deepEqual(report.tiers[tier].usage, response.usage); assert.equal(report.tiers[tier].returnedModel, response.model);
    const attempt = report.attempts.filter((entry: any) => entry.requestedModel === expectedModel);
    assert.equal(attempt.length, 1); assert.equal(attempt[0].httpStatus, 200);
    assert.ok(handle.submission?.rawTransaction);
    const transaction = Transaction.from(handle.submission!.rawTransaction);
    assert.equal(transaction.hash, receipt.txHash); assert.equal(handle.submission!.txHash, receipt.txHash);
    assert.equal(transaction.chainId, 31337n); assert.ok(sameAddress(transaction.to!, quote.account));
    assert.ok(sameAddress(transaction.from!, handle.submission!.from)); assert.equal(transaction.nonce, handle.submission!.nonce);
    const call = accountInterface.parseTransaction({ data: transaction.data, value: transaction.value })!;
    assert.equal(call.name, "payProvider"); assert.equal(call.args[0], BigInt(quote.agentId)); assert.ok(sameAddress(call.args[1], quote.payTo));
    assert.equal(call.args[2], BigInt(quote.price)); assert.equal(call.args[3], quote.paymentId);
    if (rawReceipt) { verifyProviderPaid(quote, receipt, rawReceipt); rawEventCount++; }
    prices.push(BigInt(receipt.price)); nonces.push(transaction.nonce);
    tiers[tier] = { price: receipt.price, requestedModel: expectedModel, returnedModel: response.model, paymentId: quote.paymentId,
      signedTransactionHash: transaction.hash, signedTransactionNonce: transaction.nonce, requestQuoteReceiptBindingValidated: true,
      usageMatchesResponse: true, taskCompleted: true, providerPaidEventValidatedFromRawReceipt: Boolean(rawReceipt) };
  }
  assert.ok(prices[0] < prices[1]);
  const funding = report.localPaymentEvidence;
  assert.equal(BigInt(funding.afterProviderBalance) - BigInt(funding.beforeProviderBalance), prices[0] + prices[1]);
  assert.equal(BigInt(funding.providerReceivedRaw), prices[0] + prices[1]);
  assert.equal(funding.agentNonceAfter - funding.agentNonceBefore, 2);
  assert.deepEqual(nonces.sort((a, b) => a - b), [funding.agentNonceBefore, funding.agentNonceBefore + 1]);
  assert.deepEqual(funding.deliveredPaymentIds, [artifacts.cheap.handle.quote.paymentId, artifacts.strong.handle.quote.paymentId]);
  assert.equal(funding.cacheReplayAddedPayments, 0); assert.equal(funding.cacheReplayAddedInferenceRequests, 0);
  assert.equal(report.paidInferenceAttempts, 2); assert.equal(report.attempts.length, 2);
  return { version: 1, checkedAt: new Date().toISOString(), savedEvidenceConsistencyValidated: true, actualPriceSpreadValidated: true,
    actualQuoteReceiptTotalRaw: (prices[0] + prices[1]).toString(), signedPaymentTransactionsValidated: 2, rawProviderPaidEventsValidated: rawEventCount, tiers,
    limitations: rawEventCount < 2 ? ["Original Anvil process has stopped and raw transaction receipts were not saved for this run. ProviderPaid events cannot now be independently re-read; saved Relay proofs and signed transactions are consistent, but they are not raw chain receipts.",
      "Provider balance and nonce observations are preserved run metadata; the original Anvil state is unavailable for independent re-query."] : [] };
}
export async function auditSavedProbe(output: string) {
  const json = async (name: string) => JSON.parse(await readFile(join(output, name), "utf8"));
  const report = await json("report.json");
  const artifacts = {} as { cheap: ProbeArtifact; strong: ProbeArtifact };
  for (const tier of ["cheap", "strong"] as const) {
    const handle = await json(`handle-${tier}.json`);
    let rawReceipt: RawReceipt | undefined;
    try { rawReceipt = await json(`transaction-receipt-${tier}.json`); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    artifacts[tier] = { handle, response: await json(`response-${tier}.json`), receipt: await json(`receipt-${tier}.json`),
      record: await json(`relay/${handle.quote.paymentId}.json`), rawReceipt };
  }
  const audit = verifyProbeEvidence(report, artifacts);
  await writeFile(join(output, "offline-audit.json"), JSON.stringify(audit, null, 2) + "\n", { mode: 0o600 });
  return audit;
}
