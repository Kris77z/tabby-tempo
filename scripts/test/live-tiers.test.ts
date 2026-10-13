import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { completionSummary, loadProbeUpstream, publicPricing, tierPrices } from "../verify-live-tiers.js";
import { Wallet, keccak256 } from "ethers";
import { accountInterface, EMPTY_AUTH, paymentId, requestDigest, type ChatInput, type InferenceReceipt, type Quote } from "@agentfuel/sdk/protocol";
import { verifyProbeEvidence, verifyProviderPaid, type ProbeArtifact, type RawReceipt } from "../live-tiers-evidence.js";

test("live tier completion distinguishes a final OK from truncated reasoning-only HTTP success", () => {
  const success = completionSummary({ model: "kimi-k3", choices: [{ finish_reason: "stop", message: { content: "OK", reasoning_content: "small thought" } }], usage: { total_tokens: 30 } });
  assert.equal(success.taskCompleted, true); assert.equal(success.returnedOK, true); assert.equal(success.reasoningCharacterCount, 13);
  const reasoningOnly = completionSummary({ model: "kimi-k3", choices: [{ finish_reason: "length", message: { content: "", reasoning_content: "not a final answer" } }], usage: { completion_tokens: 128 } });
  assert.equal(reasoningOnly.taskCompleted, false); assert.equal(reasoningOnly.hasFinalContent, false); assert.equal(reasoningOnly.finishReason, "length");
  assert.deepEqual(reasoningOnly.usage, { completion_tokens: 128 });
  assert.equal(completionSummary({ choices: [{ finish_reason: "length", message: { content: "OK" } }] }).taskCompleted, false);
  assert.ok(BigInt(tierPrices.cheap) < BigInt(tierPrices.strong));
  assert.equal(publicPricing.currency, "CNY"); assert.equal(publicPricing.strong.output, "100.00");
});

test("raw ProviderPaid verification rejects changed event amounts, provider, duplicate events and failed transactions", () => {
  const quote = { paymentId: "0x" + "01".repeat(32), agentId: "1", price: "10000", account: "0x" + "11".repeat(20), payTo: "0x" + "44".repeat(20) } as Quote;
  const receipt = { txHash: "0x" + "22".repeat(32), blockNumber: 7, blockHash: "0x" + "33".repeat(32), fromCash: "10000", fromCredit: "0" } as InferenceReceipt;
  const event = (provider: string, amount: bigint) => ({ address: quote.account, ...accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [1n, provider, quote.paymentId, amount, 0n]) });
  const raw: RawReceipt = { status: 1, to: quote.account, hash: receipt.txHash, blockNumber: 7, blockHash: receipt.blockHash, logs: [event(quote.payTo, 10000n)] };
  verifyProviderPaid(quote, receipt, raw);
  for (const changed of [{ ...raw, status: 0 }, { ...raw, logs: [event(quote.payTo, 9999n)] },
    { ...raw, logs: [event("0x" + "55".repeat(20), 10000n)] }, { ...raw, logs: [raw.logs[0], raw.logs[0]] }]) {
    assert.throws(() => verifyProviderPaid(quote, receipt, changed));
  }
});

test("offline audit derives price spread and payment attribution from saved evidence instead of summary flags", async () => {
  const wallet = new Wallet("0x" + "02".padStart(64, "0"));
  const artifacts = {} as { cheap: ProbeArtifact; strong: ProbeArtifact };
  const report: any = { plan: { models: { cheap: "kimi-k2.6", strong: "kimi-k3" }, operatorPricesRaw: tierPrices }, tiers: {}, attempts: [], paidInferenceAttempts: 2,
    localPaymentEvidence: { beforeProviderBalance: "0", afterProviderBalance: "40000", providerReceivedRaw: "40000", agentNonceBefore: 3, agentNonceAfter: 5,
      deliveredPaymentIds: [], cacheReplayAddedPayments: 0, cacheReplayAddedInferenceRequests: 0 } };
  let nonce = 3;
  for (const tier of ["cheap", "strong"] as const) {
    const input: ChatInput = { agentId: "1", taskId: "0", service: "infercredit/coder", model: "coder", tier, max_completion_tokens: 128,
      ...(tier === "cheap" ? { thinking: { type: "disabled" } } : { reasoning_effort: "low" }), messages: [{ role: "user", content: "Return exactly OK." }] };
    const digest = requestDigest(input), serverNonce = "0x" + (tier === "cheap" ? "01" : "02").repeat(32);
    const quote: Quote = { paymentId: paymentId("0", digest, serverNonce), requestDigest: digest, serverNonce, agentId: "1", taskId: "0", service: input.service, model: input.model,
      tier, price: tierPrices[tier], account: "0x" + "11".repeat(20), asset: "0x" + "55".repeat(20), payTo: "0x" + "44".repeat(20), chainId: "31337", quoteExpiry: "9999999999", createdBlock: 1 };
    const rawTransaction = await wallet.signTransaction({ chainId: 31337n, nonce, gasPrice: 1n, gasLimit: 250000n, to: quote.account,
      data: accountInterface.encodeFunctionData("payProvider", [1n, quote.payTo, quote.price, quote.paymentId, EMPTY_AUTH, "0x"]) });
    const response = { model: report.plan.models[tier], choices: [{ finish_reason: "stop", message: { content: "OK" } }], usage: { prompt_tokens: 11, completion_tokens: 4, total_tokens: 15 } };
    const receipt: InferenceReceipt = { ...quote, txHash: keccak256(rawTransaction), blockNumber: 7 + nonce, blockHash: "0x" + "33".repeat(32), timestamp: 123,
      fromCash: quote.price, fromCredit: "0", upstream: "kimi", model: response.model, usage: response.usage };
    const handle = { version: 1 as const, relayUrl: "http://localhost/v1/chat", input, quote, creditNonce: "1", submission: { from: wallet.address, nonce, rawTransaction, txHash: receipt.txHash } };
    artifacts[tier] = { handle, receipt, response, record: { quote, request: input, state: "Delivered", result: response, receipt, refunds: [],
      route: { version: 1, tier, model: "coder", upstreams: [{ name: "kimi", model: response.model, baseUrl: "https://api.moonshot.cn/v1" }] } } };
    report.tiers[tier] = { quote, receipt, usage: response.usage, returnedModel: response.model };
    report.attempts.push({ requestedModel: response.model, httpStatus: 200 }); report.localPaymentEvidence.deliveredPaymentIds.push(quote.paymentId); nonce++;
  }
  const audit = verifyProbeEvidence(report, artifacts);
  assert.equal(audit.actualPriceSpreadValidated, true); assert.equal(audit.signedPaymentTransactionsValidated, 2);
  assert.equal(audit.rawProviderPaidEventsValidated, 0); assert.equal(audit.limitations.length, 2);
  const changed = structuredClone(artifacts); changed.strong.receipt.price = "10000";
  assert.throws(() => verifyProbeEvidence(report, changed));
  const badUsage = structuredClone(artifacts); badUsage.cheap.receipt.usage = { total_tokens: 999 };
  assert.throws(() => verifyProbeEvidence(report, badUsage));
  const badFunding = structuredClone(report); badFunding.localPaymentEvidence.afterProviderBalance = "39999";
  assert.throws(() => verifyProbeEvidence(badFunding, artifacts));
});

test("live tier config reads only private Kimi files and rejects unknown or credential-bearing endpoints", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-live-tiers-config-"));
  try {
    const secretFile = join(directory, "api-key.txt"); const configFile = join(directory, "config.json");
    await writeFile(secretFile, "synthetic-probe-secret", { mode: 0o600 });
    const upstream = { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", model: "kimi-k2.6", apiKeyFile: secretFile };
    await writeFile(configFile, JSON.stringify({ upstream }), { mode: 0o600 });
    const loaded = await loadProbeUpstream(configFile); assert.equal(loaded.baseUrl, upstream.baseUrl); assert.equal(loaded.key, "synthetic-probe-secret");
    for (const baseUrl of ["https://gateway.llmgtw.io/v1", "https://api.moonshot.cn/v1?key=synthetic", "https://secret@api.moonshot.cn/v1", "https://api.moonshot.cn/other"]) {
      await writeFile(configFile, JSON.stringify({ upstream: { ...upstream, baseUrl } }));
      await assert.rejects(loadProbeUpstream(configFile));
    }
    await assert.rejects(loadProbeUpstream("config.json"), /ABSOLUTE_PRIVATE_PATH_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
