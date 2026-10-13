import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { getAddress, Interface, Transaction, verifyTypedData } from "ethers";
import { getCurrentTools, normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { accountInterface, paymentId, requestDigest, sameAddress, EMPTY_AUTH, uint, type ChatInput } from "@agentfuel/sdk/protocol";
import type { LoopSession } from "../packages/pi-loop/src/index.js";
import { assistantFromInference, toRelayMessages } from "../packages/pi-loop/src/adapter.js";
import { PUBLIC_SAMPLE } from "../packages/pi-loop/src/public-sample.js";
import { submissionTypedData } from "../services/arena/src/submission-auth.js";
import { digest, ESCROW_ABI } from "../services/arena/src/protocol.js";
import type { Acceptance } from "../services/arena/src/controller.js";
import type { PaymentRecord } from "../services/provider-relay/src/store.js";
import { verifyProviderPaid, type RawReceipt } from "./live-tiers-evidence.js";

export interface PiEvidenceReport {
  version: 1;
  upstreamMode: "controlled-upstream" | "real-kimi-system-https-proxy";
  status?: string;
  evidenceCollectionErrors?: string[];
  plan: {
    models: { cheap: "kimi-k2.6"; strong: "kimi-k3" };
    operatorPricesRaw: { cheap: "10000"; strong: "30000" };
    maxRounds: 3; maxCompletionTokens: 2048; maxTotalPriceRaw: "70000"; maxPricePerCallRaw: "30000"; inferenceRetries: 0; preseededError: false;
    tierParameters: { cheap: { thinking: { type: "disabled" } }; strong: { reasoning_effort: "low" } };
  };
  localChain: {
    chainId: "31337"; account: string; asset: string; provider: string; escrow: string;
    agentAddress: string; agentId: string; taskId: string; verifier: string; problemId: "sum-integers";
    providerBalanceBefore: string; providerBalanceAfter: string;
    agentNonceBefore: number | string; agentNonceAfter: number | string; loanStatus: "0";
    cashBefore?: string; cashAfter?: string; taskStatusBefore?: string; taskStatusAfter?: string;
  };
  attempts: { round: number; requestedModel: string; requestDigest: string; httpStatus: number; finishReason: string }[];
}
export interface PiAuditSummary {
  version: 1; fullyVerified: true; verificationScope: "saved-artifacts"; checkedAt: string;
  rounds: number; totalPriceRaw: string; signedPaymentsValidated: number; rawProviderPaidEventsValidated: number;
  rawTaskSettledEventValidated: true; submissionSignatureValidated: true; twoTierModelsVerified: boolean;
  signedSettlementTransactionValidated: true;
  upstreamMode: PiEvidenceReport["upstreamMode"]; twoTierBindingsValidated: boolean;
  naturalRepairObserved: boolean; outcome: "single-round-success" | "repair-after-feedback" | "multi-round-success";
  limitations: string[];
}
type ReceiptWithSender = RawReceipt & { from: string };
const escrowInterface = new Interface(ESCROW_ABI);
const hostPrompt = "You solve exactly the assigned public programming task. The only tool is test_public_sample. No shell, file, network, wallet or settlement tool is available.";
const configHash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const json = async <T>(output: string, name: string): Promise<T> => JSON.parse(await readFile(join(output, name), "utf8"));
function nonce(value: number | string): number {
  if (typeof value === "string") { uint(value, "nonce"); value = Number(value); }
  assert.ok(Number.isSafeInteger(value) && value >= 0, "Invalid saved nonce"); return value;
}
function text(value: unknown): string {
  if (typeof value === "string") return value;
  assert.ok(Array.isArray(value), "Text content required");
  return value.map(part => { assert.equal(part.type, "text"); assert.equal(typeof part.text, "string"); return part.text; }).join("\n");
}
function assertNoSecrets(value: unknown): void {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    assert.ok(!/^(key|apiKey|api_key|privateKey|private_key|sessionKey|authorization)$/i.test(key), "Public evidence contains a secret field");
    assertNoSecrets(child);
  }
}

async function verifySavedPi(output: string): Promise<PiAuditSummary> {
  const report = await json<PiEvidenceReport>(output, "report.json");
  const session = await json<LoopSession>(output, "session/session.json");
  const arena = await json<Acceptance>(output, "arena-result.json");
  const settlementJournal = await json<Record<string, { verdict: Acceptance["verdict"]; verdictHash: string; rawTx: string; txHash: string; settlement?: Acceptance["settlement"] }>>(output, "settlement-journal.json");
  const settlementReceipt = await json<ReceiptWithSender>(output, "settlement-transaction-receipt.json");
  const { plan, localChain: chain } = report, config = session.config;
  assert.equal(report.version, 1); assert.equal(session.version, 1);
  assert.ok(["controlled-upstream", "real-kimi-system-https-proxy"].includes(report.upstreamMode));
  if (report.status !== undefined) assert.equal(report.status, "TaskSucceeded");
  if (report.evidenceCollectionErrors !== undefined) assert.deepEqual(report.evidenceCollectionErrors, []);
  assert.deepEqual(plan.models, { cheap: "kimi-k2.6", strong: "kimi-k3" }); assert.deepEqual(plan.operatorPricesRaw, { cheap: "10000", strong: "30000" });
  assert.equal(plan.maxRounds, 3); assert.equal(plan.maxCompletionTokens, 2048); assert.equal(plan.maxTotalPriceRaw, "70000");
  assert.equal(plan.maxPricePerCallRaw, "30000"); assert.equal(plan.inferenceRetries, 0); assert.equal(plan.preseededError, false);
  assert.deepEqual(plan.tierParameters, { cheap: { thinking: { type: "disabled" } }, strong: { reasoning_effort: "low" } });
  assert.equal(chain.chainId, "31337"); assert.equal(chain.loanStatus, "0"); assert.equal(chain.problemId, PUBLIC_SAMPLE.problemId);
  uint(chain.agentId, "agentId"); assert.ok(uint(chain.taskId, "taskId") > 0n);
  for (const field of ["account", "asset", "provider", "escrow", "agentAddress", "verifier"] as const) getAddress(chain[field]);
  assert.equal(config.chainId, chain.chainId); assert.equal(config.agentId, chain.agentId); assert.equal(config.taskId, chain.taskId);
  for (const field of ["account", "asset", "provider"] as const) assert.ok(sameAddress(config[field], chain[field]));
  assert.ok(sameAddress(config.escrowAddress, chain.escrow)); assert.ok(!sameAddress(chain.verifier, chain.agentAddress), "Verifier must be independent of agent");
  assert.equal(session.binding, configHash(config)); assert.equal(session.phase, "Succeeded"); assert.equal(session.reason, undefined);
  assert.equal(config.maxRounds, plan.maxRounds); assert.equal(config.maxCompletionTokens, plan.maxCompletionTokens);
  assert.equal(config.maxTotalPrice, plan.maxTotalPriceRaw); assert.equal(config.maxPricePerCall, plan.maxPricePerCallRaw); assert.deepEqual(config.tierParameters, plan.tierParameters);
  assert.deepEqual(config.tiers, ["cheap", "strong", "strong"]);
  assert.ok(session.rounds.length >= 1 && session.rounds.length <= plan.maxRounds);
  assert.ok(session.tools.length >= 1 && session.tools.length <= config.maxToolCalls);
  assert.equal(report.attempts.length, session.rounds.length, "Unaccounted upstream attempt");
  assertNoSecrets(report); assertNoSecrets(session); assertNoSecrets(arena); assertNoSecrets(settlementJournal);
  const assistants = session.messages.flatMap((message, index) => message.role === "assistant" ? [{ message, index }] : []);
  assert.equal(assistants.length, session.rounds.length, "Paid rounds and assistant transcript differ");
  const initial = session.messages.slice(0, assistants[0].index);
  assert.equal(initial.length, 2, "Unexpected preseeded transcript"); assert.equal(initial[0].role, "system"); assert.equal(initial[1].role, "user");
  assert.equal(text(initial[0].content), hostPrompt); assert.equal(text(initial[1].content), PUBLIC_SAMPLE.prompt);
  assert.equal((initial[0] as { sections?: unknown }).sections, undefined);
  const payments = new Set<string>(), transactionHashes = new Set<string>(), journalIds = new Set<string>();
  const tiers = new Set<string>(); let total = 0n; const nonces: number[] = [];
  const observations: { round: number; code: string; passed: boolean }[] = [];
  for (let index = 0; index < session.rounds.length; index++) {
    const roundNumber = index + 1, round = session.rounds[index], tier = config.tiers[index];
    assert.equal(round.appended, true); assert.ok(round.handle && round.inference, "Round missing durable paid result");
    const { handle, inference } = round, { quote, input } = handle, receipt = inference.receipt;
    const physicalRequest = await json<Record<string, unknown>>(output, `round-${roundNumber}/request.json`);
    const response = await json<any>(output, `round-${roundNumber}/response.json`);
    const rawReceipt = await json<ReceiptWithSender>(output, `round-${roundNumber}/transaction-receipt.json`);
    assert.match(quote.paymentId, /^0x[0-9a-f]{64}$/);
    const record = await json<PaymentRecord>(output, `relay/${quote.paymentId}.json`);
    assertNoSecrets(physicalRequest); assertNoSecrets(response); assertNoSecrets(receipt); assertNoSecrets(record);
    assert.equal(handle.version, 1); assert.equal(handle.relayUrl, config.relayUrl); assert.deepEqual(inference.handle, handle);
    assert.deepEqual(input, { ...round.body, agentId: chain.agentId, taskId: "0" } as ChatInput);
    assert.equal(input.tier, tier); assert.equal(quote.tier, tier); assert.equal(receipt.tier, tier);
    assert.equal(quote.taskId, "0"); assert.equal(quote.agentId, chain.agentId);
    assert.equal(quote.service, config.service); assert.equal(quote.model, config.model); assert.equal(quote.chainId, chain.chainId);
    assert.equal(quote.price, plan.operatorPricesRaw[tier]); assert.equal(receipt.price, quote.price);
    assert.ok(BigInt(quote.price) <= BigInt(config.maxPricePerCall));
    for (const field of ["account", "asset"] as const) assert.ok(sameAddress(quote[field], chain[field]));
    assert.ok(sameAddress(quote.payTo, chain.provider));
    assert.equal(quote.requestDigest, requestDigest(input)); assert.equal(quote.paymentId, paymentId("0", quote.requestDigest, quote.serverNonce));
    for (const field of ["paymentId", "agentId", "taskId", "requestDigest", "service", "chainId", "account", "asset", "payTo"] as const) assert.equal(receipt[field], quote[field]);
    assert.ok(!payments.has(quote.paymentId), "Repeated paymentId"); payments.add(quote.paymentId);
    assert.equal(receipt.fromCash, quote.price); assert.equal(receipt.fromCredit, "0");
    assert.deepEqual(inference.result, response); assert.equal(receipt.model, plan.models[tier]); assert.equal(response.model, plan.models[tier]);
    assert.deepEqual(receipt.usage, response.usage); assert.ok(response.usage && typeof response.usage === "object");
    for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) assert.ok(Number.isSafeInteger(response.usage[field]) && response.usage[field] >= 0, `Invalid ${field}`);
    assert.equal(response.usage.total_tokens, response.usage.prompt_tokens + response.usage.completion_tokens);
    assert.ok(response.usage.completion_tokens > 0 && response.usage.completion_tokens <= plan.maxCompletionTokens);
    assert.equal(input.max_completion_tokens, plan.maxCompletionTokens); assert.equal(input.stream, undefined);
    if (tier === "cheap") { assert.deepEqual(input.thinking, { type: "disabled" }); assert.equal(input.reasoning_effort, undefined); }
    else { assert.equal(input.reasoning_effort, "low"); assert.equal(input.thinking, undefined); }
    const { service: _service, agentId: _agent, taskId: _task, tier: _tier, ...upstreamBody } = input;
    assert.deepEqual(physicalRequest, { ...upstreamBody, model: plan.models[tier] });
    const prefix = session.messages.slice(0, assistants[index].index);
    assert.deepEqual(round.body.messages, toRelayMessages(normalizeContext({ messages: prefix })));
    const tools = getCurrentTools(prefix).map(tool => ({ type: "function", function: { name: tool.name, description: tool.description, parameters: tool.parameters } }));
    assert.equal(tools.length, 1); assert.equal(tools[0].function.name, "test_public_sample"); assert.deepEqual(round.body.tools, tools);
    const schema = tools[0].function.parameters as Record<string, any>;
    assert.equal(schema.type, "object"); assert.equal(schema.additionalProperties, false); assert.deepEqual(schema.required, ["code"]);
    assert.deepEqual(schema.properties, { code: { type: "string", minLength: 1, maxLength: 65536 } });
    assert.equal(record.state, "Delivered"); assert.deepEqual(record.refunds, []); assert.ok(record.expiredPayment === false || record.expiredPayment === undefined);
    assert.deepEqual(record.quote, quote); assert.deepEqual(record.request, input); assert.deepEqual(record.result, response); assert.deepEqual(record.receipt, receipt);
    assert.deepEqual(record.proof, Object.fromEntries(["txHash", "blockNumber", "blockHash", "timestamp", "fromCash", "fromCredit"].map(field => [field, receipt[field as keyof typeof receipt]])));
    assert.equal(record.route?.version, 1); assert.equal(record.route.model, config.model); assert.equal(record.route.tier, tier);
    assert.ok(record.route.upstreams.some(upstream => upstream.name === receipt.upstream && upstream.model === receipt.model));
    assert.ok(handle.submission?.rawTransaction, "Signed payment transaction required");
    const transaction = Transaction.from(handle.submission.rawTransaction);
    assert.equal(transaction.hash, receipt.txHash); assert.equal(handle.submission.txHash, receipt.txHash);
    assert.ok(!transactionHashes.has(receipt.txHash)); transactionHashes.add(receipt.txHash);
    assert.equal(transaction.chainId, BigInt(chain.chainId)); assert.equal(transaction.value, 0n);
    assert.ok(sameAddress(transaction.to!, chain.account)); assert.ok(sameAddress(transaction.from!, chain.agentAddress));
    assert.ok(sameAddress(handle.submission.from, chain.agentAddress)); assert.equal(transaction.nonce, handle.submission.nonce);
    const call = accountInterface.parseTransaction({ data: transaction.data, value: transaction.value }); assert.ok(call);
    assert.equal(call.name, "payProvider"); assert.equal(call.args[0], BigInt(chain.agentId)); assert.ok(sameAddress(call.args[1], chain.provider));
    assert.equal(call.args[2], BigInt(quote.price)); assert.equal(call.args[3], quote.paymentId); assert.equal(call.args[5], "0x");
    for (const [key, value] of Object.entries(EMPTY_AUTH)) assert.equal(call.args[4][key], typeof value === "number" ? BigInt(value) : value);
    assert.ok(sameAddress(rawReceipt.from, chain.agentAddress)); verifyProviderPaid(quote, receipt, rawReceipt);
    const providerPaid = rawReceipt.logs.filter(log => sameAddress(log.address, chain.account)).map(log => { try { return accountInterface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "ProviderPaid");
    assert.equal(providerPaid.length, 1, "Unexpected additional payment event");
    const attempt = report.attempts[index]; assert.equal(attempt.round, roundNumber); assert.equal(attempt.httpStatus, 200);
    assert.equal(attempt.requestedModel, plan.models[tier]); assert.equal(attempt.requestDigest, quote.requestDigest);
    assert.equal(response.choices.length, 1); assert.equal(attempt.finishReason, response.choices[0].finish_reason);
    assert.ok(["stop", "tool_calls"].includes(attempt.finishReason), "Truncated or failed inference is not a successful run");
    const model: Model<"openai-completions"> = { id: config.model, name: config.model, api: "openai-completions", provider: "agentfuel-relay", baseUrl: config.relayUrl,
      input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: config.maxCompletionTokens };
    const expected = assistantFromInference(inference, model), actual = assistants[index].message as AssistantMessage;
    for (const field of ["content", "usage", "stopReason", "rawStopReason", "api", "provider", "model", "responseModel", "responseId"] as const) assert.deepEqual(actual[field], expected[field]);
    const calls = expected.content.filter(part => part.type === "toolCall"); assert.ok(calls.length > 0, "Successful loop must run the public sample");
    const following = session.messages.slice(assistants[index].index + 1, assistants[index + 1]?.index ?? session.messages.length);
    assert.equal(following.length, calls.length, "Missing or extra tool result");
    for (let toolIndex = 0; toolIndex < calls.length; toolIndex++) {
      const toolCall = calls[toolIndex], result = following[toolIndex]; assert.equal(toolCall.name, "test_public_sample");
      assert.deepEqual(Object.keys(toolCall.arguments), ["code"]); assert.ok(typeof toolCall.arguments.code === "string");
      assert.ok(toolCall.arguments.code.length >= 1 && toolCall.arguments.code.length <= 65536);
      const key = `${roundNumber}:${toolCall.id}`; assert.ok(!journalIds.has(key)); journalIds.add(key);
      const journal = session.tools.filter(tool => tool.id === key); assert.equal(journal.length, 1); assert.equal(journal[0].code, toolCall.arguments.code);
      assert.ok(journal[0].result && typeof journal[0].result.passed === "boolean");
      assert.equal(result.role, "toolResult"); assert.ok(result.role === "toolResult");
      assert.equal(result.toolCallId, toolCall.id); assert.equal(result.toolName, toolCall.name); assert.equal(result.isError, false);
      assert.deepEqual(JSON.parse(text(result.content)), journal[0].result);
      if (journal[0].result.passed) { assert.equal(journal[0].result.failure, undefined); assert.equal(JSON.parse(journal[0].result.stdout.trim()), PUBLIC_SAMPLE.expected); }
      else assert.equal(typeof journal[0].result.failure, "string");
      observations.push({ round: roundNumber, code: journal[0].code, passed: journal[0].result.passed });
    }
    tiers.add(tier); total += BigInt(quote.price); nonces.push(transaction.nonce);
  }
  assert.equal(session.tools.length, journalIds.size); assert.equal(session.reservedPrice, total.toString()); assert.ok(total <= BigInt(plan.maxTotalPriceRaw));
  assert.equal(uint(chain.providerBalanceAfter, "providerBalanceAfter") - uint(chain.providerBalanceBefore, "providerBalanceBefore"), total);
  const before = nonce(chain.agentNonceBefore), after = nonce(chain.agentNonceAfter); assert.equal(after - before, session.rounds.length);
  assert.deepEqual(nonces.sort((a, b) => a - b), session.rounds.map((_, index) => before + index));
  const last = observations.at(-1)!; assert.equal(last.passed, true); assert.equal(session.candidate, last.code);
  assert.ok(session.submission && session.submission.runId); const { payload, runId } = session.submission;
  assert.equal(payload.code, session.candidate); assert.equal(payload.taskId, chain.taskId); uint(payload.deadline, "deadline");
  const typed = submissionTypedData({ rpcUrl: config.rpcUrl, chainId: chain.chainId, escrowAddress: chain.escrow, ipcDirectory: "/unused",
    tasks: { [chain.taskId]: { agentId: chain.agentId, problemId: PUBLIC_SAMPLE.problemId } } }, payload);
  assert.ok(sameAddress(verifyTypedData(typed.domain, typed.types, typed.message, payload.signature), chain.agentAddress), "Submission signer mismatch");
  assert.deepEqual(session.submission.result, arena); const { verdict, tests, settlement } = arena;
  assert.equal(verdict.version, 1); assert.equal(verdict.chainId, chain.chainId); assert.ok(sameAddress(verdict.escrowAddress, chain.escrow));
  assert.equal(verdict.taskId, chain.taskId); assert.equal(verdict.agentId, chain.agentId); assert.equal(verdict.problemId, PUBLIC_SAMPLE.problemId);
  assert.equal(verdict.runId, runId); assert.match(runId, /^[a-f0-9-]{36}$/); assert.equal(verdict.mode, "docker"); assert.equal(verdict.passed, true);
  // The fixed problem has five Arena cases. Audit their recorded outcomes, without re-running hidden tests.
  assert.equal(tests.length, 5); tests.forEach((test, index) => { assert.equal(test.case, index + 1); assert.equal(test.passed, true); assert.equal(test.failure, undefined); });
  assert.equal(verdict.evidenceHash, digest(JSON.stringify({ codeHash: digest(payload.code), results: tests })));
  assert.equal(settlement.taskId, chain.taskId); assert.equal(settlement.runId, runId); assert.equal(settlement.passed, true);
  assert.deepEqual(Object.keys(settlementJournal), [chain.taskId]); const journal = settlementJournal[chain.taskId]; assert.ok(journal);
  assert.deepEqual(journal.verdict, verdict); assert.equal(journal.verdictHash, digest(JSON.stringify(journal.verdict))); assert.deepEqual(journal.settlement, settlement);
  const settleTransaction = Transaction.from(journal.rawTx);
  assert.equal(settleTransaction.hash, journal.txHash); assert.equal(settleTransaction.hash, settlement.txHash);
  assert.equal(settleTransaction.chainId, BigInt(chain.chainId)); assert.equal(settleTransaction.value, 0n);
  assert.ok(sameAddress(settleTransaction.from!, chain.verifier)); assert.ok(sameAddress(settleTransaction.to!, chain.escrow));
  const settleCall = escrowInterface.parseTransaction({ data: settleTransaction.data, value: settleTransaction.value }); assert.ok(settleCall);
  assert.equal(settleCall.name, "settle"); assert.equal(settleCall.args[0], BigInt(chain.taskId)); assert.equal(settleCall.args[1], true);
  assert.equal(settlementReceipt.status, 1); assert.equal(settlementReceipt.hash, settlement.txHash); assert.equal(settlementReceipt.blockNumber, settlement.blockNumber);
  assert.ok(sameAddress(settlementReceipt.to, chain.escrow)); assert.ok(sameAddress(settlementReceipt.from, chain.verifier));
  const events = settlementReceipt.logs.filter(log => sameAddress(log.address, chain.escrow)).map(log => { try { return escrowInterface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "TaskSettled");
  assert.equal(events.length, 1); assert.equal(events[0]!.args.taskId, BigInt(chain.taskId)); assert.equal(events[0]!.args.passed, true);
  // This is the cash-only spike: settlement must not repay or slash a credit loan.
  assert.equal(events[0]!.args.repaid, 0n); assert.equal(events[0]!.args.slashed, 0n);
  if (chain.cashBefore !== undefined || chain.cashAfter !== undefined) {
    assert.ok(chain.cashBefore !== undefined && chain.cashAfter !== undefined);
    assert.equal(uint(chain.cashAfter, "cashAfter"), uint(chain.cashBefore, "cashBefore") - total + events[0]!.args.agentResidual);
  }
  if (chain.taskStatusBefore !== undefined || chain.taskStatusAfter !== undefined) { assert.equal(chain.taskStatusBefore, "2"); assert.equal(chain.taskStatusAfter, "3"); }
  const naturalRepairObserved = observations.some(failed => !failed.passed && observations.some(passed => passed.passed && passed.round > failed.round && passed.code !== failed.code));
  return { version: 1, fullyVerified: true, verificationScope: "saved-artifacts", checkedAt: new Date().toISOString(), rounds: session.rounds.length,
    totalPriceRaw: total.toString(), signedPaymentsValidated: session.rounds.length, rawProviderPaidEventsValidated: session.rounds.length,
    rawTaskSettledEventValidated: true, signedSettlementTransactionValidated: true, submissionSignatureValidated: true, upstreamMode: report.upstreamMode,
    twoTierBindingsValidated: tiers.has("cheap") && tiers.has("strong"), twoTierModelsVerified: report.upstreamMode === "real-kimi-system-https-proxy" && tiers.has("cheap") && tiers.has("strong"), naturalRepairObserved,
    outcome: session.rounds.length === 1 ? "single-round-success" : naturalRepairObserved ? "repair-after-feedback" : "multi-round-success",
    limitations: ["This offline audit validates consistency of saved raw receipts, signed transactions and run artifacts. It does not query the original local chain or model provider. Saved balance, nonce, loan-status and verifier observations cannot be independently re-read after that chain stops.",
      "Upstream mode is saved run metadata; upstream provenance cannot be independently authenticated by this offline audit.",
      ...(report.upstreamMode === "controlled-upstream" ? ["Controlled upstream results do not demonstrate real Kimi model calls or real-model repair."] : []),
      ...(session.rounds.length === 1 ? ["A single-round success does not demonstrate repair across rounds or use of both model tiers."] : [])] };
}

/** Entirely offline. A failed audit overwrites any earlier success report and rejects. */
export async function auditSavedPi(outputDir: string): Promise<PiAuditSummary> {
  const output = resolve(outputDir), auditPath = join(output, "offline-pi-audit.json");
  try {
    const summary = await verifySavedPi(output);
    await writeFile(auditPath, JSON.stringify(summary, null, 2) + "\n", { mode: 0o600 }); return summary;
  } catch (error) {
    await writeFile(auditPath, JSON.stringify({ version: 1, fullyVerified: false, verificationScope: "saved-artifacts", checkedAt: new Date().toISOString(), error: "PI_EVIDENCE_INVALID" }, null, 2) + "\n", { mode: 0o600 });
    throw error;
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2];
  if (!output) { process.stderr.write("Usage: tsx scripts/live-pi-evidence.ts OUTPUT_DIR\n"); process.exitCode = 1; }
  else auditSavedPi(output).then(summary => process.stdout.write(JSON.stringify(summary) + "\n")).catch(() => { process.stderr.write("Pi evidence audit failed: PI_EVIDENCE_INVALID\n"); process.exitCode = 1; });
}
