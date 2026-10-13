import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { Interface, Wallet, keccak256 } from "ethers";
import { normalizeContext, type Model } from "@earendil-works/pi-ai";
import { Agent } from "@earendil-works/pi-agent-core";
import { EMPTY_AUTH, accountInterface, paymentId, requestDigest, type ChatInput, type Quote } from "@agentfuel/sdk/protocol";
import type { Inference, PaymentHandle } from "@agentfuel/sdk";
import { assistantFromInference, toRelayMessages } from "../../packages/pi-loop/src/adapter.js";
import type { LoopConfig, LoopSession } from "../../packages/pi-loop/src/index.js";
import { PUBLIC_SAMPLE } from "../../packages/pi-loop/src/public-sample.js";
import { digest, ESCROW_ABI } from "../../services/arena/src/protocol.js";
import { submissionTypedData } from "../../services/arena/src/submission-auth.js";
import { auditSavedPi, type PiEvidenceReport } from "../live-pi-evidence.js";

const key = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const good = "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n";
const wrong = "print(0)\n";
const tool = { name: "test_public_sample", description: "Run the fixed public sample in Docker.", parameters: {
  type: "object", properties: { code: { type: "string", minLength: 1, maxLength: 65536 } }, required: ["code"], additionalProperties: false } };
const escrowInterface = new Interface(ESCROW_ABI);
const read = async (directory: string, path: string) => JSON.parse(await readFile(join(directory, path), "utf8"));
async function write(directory: string, path: string, value: unknown) {
  const target = join(directory, path); await mkdir(dirname(target), { recursive: true }); await writeFile(target, JSON.stringify(value, null, 2) + "\n");
}
async function edit(directory: string, path: string, change: (value: any) => void) { const value = await read(directory, path); change(value); await write(directory, path, value); }
async function replaceSettlerTransaction(directory: string, report: PiEvidenceReport, raw: string) {
  const hash = keccak256(raw);
  await edit(directory, "settlement-journal.json", value => { const entry = value[report.localChain.taskId]; entry.rawTx = raw; entry.txHash = hash; entry.settlement.txHash = hash; });
  await edit(directory, "arena-result.json", value => { value.settlement.txHash = hash; });
  await edit(directory, "session/session.json", value => { value.submission.result.settlement.txHash = hash; });
  await edit(directory, "settlement-transaction-receipt.json", value => { value.hash = hash; });
}

/** No chain/provider/model transport: signed bytes and encoded logs are explicitly synthetic. */
async function fixture(directory: string, codes = [wrong, good]) {
  const wallet = new Wallet(key(2)), verifier = new Wallet(key(1));
  const chain: PiEvidenceReport["localChain"] = { chainId: "31337", account: address(10), asset: address(11), provider: address(12), escrow: address(13),
    agentAddress: wallet.address, agentId: "1", taskId: "7", verifier: verifier.address, problemId: "sum-integers",
    providerBalanceBefore: "500", providerBalanceAfter: "500", agentNonceBefore: 5, agentNonceAfter: 5, loanStatus: "0" };
  const report: PiEvidenceReport = { version: 1, upstreamMode: "controlled-upstream", plan: { models: { cheap: "kimi-k2.6", strong: "kimi-k3" }, operatorPricesRaw: { cheap: "10000", strong: "30000" },
    maxRounds: 3, maxCompletionTokens: 2048, maxTotalPriceRaw: "70000", maxPricePerCallRaw: "30000", inferenceRetries: 0, preseededError: false,
    tierParameters: { cheap: { thinking: { type: "disabled" } }, strong: { reasoning_effort: "low" } } }, localChain: chain, attempts: [] };
  const config: LoopConfig = { taskId: chain.taskId, agentId: chain.agentId, rpcUrl: "http://127.0.0.1:8545", chainId: chain.chainId,
    account: chain.account, asset: chain.asset, provider: chain.provider, relayUrl: "http://127.0.0.1:8788/v1/chat", service: "infercredit/coder", model: "coder",
    tiers: ["cheap", "strong", "strong"], maxRounds: 3, maxToolCalls: 6, maxTotalPrice: "70000", maxPricePerCall: "30000", deadlineMs: 2000000000000,
    arenaUrl: "http://127.0.0.1:8790", escrowAddress: chain.escrow, maxCompletionTokens: 2048,
    tierParameters: { cheap: { thinking: { type: "disabled" } }, strong: { reasoning_effort: "low" } } };
  // Use Pi 1.0.1's real initial-system/tool declaration construction, not a guessed transcript shape.
  const agent = new Agent({ streamFn: () => { throw new Error("No transport in offline fixture"); }, initialState: {
    systemPrompt: "You solve exactly the assigned public programming task. The only tool is test_public_sample. No shell, file, network, wallet or settlement tool is available.",
    tools: [{ ...tool, label: "Test", execute: async () => { throw new Error("No tool execution in offline fixture"); } }] } });
  const session: LoopSession = { version: 1, binding: createHash("sha256").update(JSON.stringify(config)).digest("hex"), config, phase: "Succeeded", reservedPrice: "0", rounds: [], tools: [],
    messages: [...structuredClone(agent.state.messages), { role: "user", content: PUBLIC_SAMPLE.prompt, timestamp: 2 }] };
  const model: Model<"openai-completions"> = { id: config.model, name: config.model, api: "openai-completions", provider: "agentfuel-relay", baseUrl: config.relayUrl,
    input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 };
  for (let index = 0; index < codes.length; index++) {
    const round = index + 1, tier = config.tiers[index], physicalModel = report.plan.models[tier], price = report.plan.operatorPricesRaw[tier];
    const body = { ...config.tierParameters?.[tier], service: config.service, model: config.model, tier, messages: toRelayMessages(normalizeContext({ messages: session.messages })),
      tools: [{ type: "function", function: tool }], max_completion_tokens: 2048 };
    const input = { ...body, agentId: chain.agentId, taskId: "0" } as ChatInput;
    const requestHash = requestDigest(input), serverNonce = key(round + 100);
    const quote: Quote = { paymentId: paymentId("0", requestHash, serverNonce), requestDigest: requestHash, serverNonce, agentId: chain.agentId, taskId: "0", service: config.service,
      model: config.model, tier, price, payTo: chain.provider, asset: chain.asset, account: chain.account, chainId: chain.chainId, quoteExpiry: "2000000000", createdBlock: 10 + index };
    const rawTransaction = await wallet.signTransaction({ chainId: 31337, nonce: 5 + index, gasLimit: 250000, gasPrice: 1, to: chain.account,
      data: accountInterface.encodeFunctionData("payProvider", [chain.agentId, chain.provider, price, quote.paymentId, EMPTY_AUTH, "0x"]) });
    const txHash = keccak256(rawTransaction), blockHash = key(round + 200);
    const handle: PaymentHandle = { version: 1, relayUrl: config.relayUrl, input, quote, creditNonce: String(round), submission: { from: wallet.address, nonce: 5 + index, txHash, rawTransaction } };
    const response = { id: `completion_${round}`, model: physicalModel, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
      tool_calls: [{ id: "call_reused", type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code: codes[index] }) } }] } }],
      usage: { prompt_tokens: 100 + index, completion_tokens: 50, total_tokens: 150 + index } };
    const proof = { txHash, blockNumber: 20 + index, blockHash, timestamp: 1900000000 + index, fromCash: price, fromCredit: "0" };
    const receipt = { ...proof, paymentId: quote.paymentId, agentId: chain.agentId, taskId: "0", requestDigest: requestHash, service: config.service, tier, price,
      payTo: chain.provider, asset: chain.asset, account: chain.account, chainId: chain.chainId, upstream: "kimi", model: physicalModel, usage: response.usage };
    const inference: Inference = { result: response, receipt, handle };
    session.rounds.push({ body, handle, inference, appended: true }); session.messages.push(assistantFromInference(inference, model));
    const passed = codes[index] === good, sample = { passed, stdout: passed ? "9\n" : "0\n", ...(passed ? {} : { failure: "wrong-answer" }) };
    session.tools.push({ id: `${round}:call_reused`, code: codes[index], result: sample });
    session.messages.push({ role: "toolResult", toolCallId: "call_reused", toolName: "test_public_sample", content: [{ type: "text", text: JSON.stringify(sample) }], isError: false, timestamp: 3 + round });
    session.candidate = codes[index]; session.reservedPrice = (BigInt(session.reservedPrice) + BigInt(price)).toString();
    const event = accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [chain.agentId, chain.provider, quote.paymentId, price, 0]);
    await write(directory, `round-${round}/request.json`, { ...Object.fromEntries(Object.entries(input).filter(([field]) => !["service", "agentId", "taskId", "tier"].includes(field))), model: physicalModel });
    await write(directory, `round-${round}/response.json`, response);
    await write(directory, `round-${round}/transaction-receipt.json`, { status: 1, from: wallet.address, to: chain.account, hash: txHash, blockNumber: proof.blockNumber, blockHash, logs: [{ address: chain.account, ...event }] });
    await write(directory, `relay/${quote.paymentId}.json`, { quote, request: input, state: "Delivered", proof, result: response, receipt, refunds: [], expiredPayment: false,
      route: { version: 1, model: config.model, tier, upstreams: [{ name: "kimi", model: physicalModel, baseUrl: "https://api.moonshot.cn/v1" }] } });
    report.attempts.push({ round, requestedModel: physicalModel, requestDigest: requestHash, httpStatus: 200, finishReason: "tool_calls" });
  }
  chain.providerBalanceAfter = (500n + BigInt(session.reservedPrice)).toString(); chain.agentNonceAfter = 5 + codes.length;
  const payload = { taskId: chain.taskId, code: session.candidate!, deadline: "2000000000", signature: "" };
  const typed = submissionTypedData({ rpcUrl: config.rpcUrl, chainId: chain.chainId, escrowAddress: chain.escrow, ipcDirectory: "/unused", tasks: { [chain.taskId]: { agentId: chain.agentId, problemId: "sum-integers" } } }, payload);
  payload.signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
  const runId = "12345678-1234-1234-1234-123456789abc", tests = Array.from({ length: 5 }, (_, index) => ({ case: index + 1, passed: true }));
  const settleRaw = await verifier.signTransaction({ chainId: 31337, nonce: 0, gasPrice: 1, gasLimit: 250000, to: chain.escrow, data: escrowInterface.encodeFunctionData("settle", [chain.taskId, true]) });
  const arena = { verdict: { version: 1, runId, chainId: chain.chainId, escrowAddress: chain.escrow, taskId: chain.taskId, agentId: chain.agentId, problemId: "sum-integers", passed: true, mode: "docker",
    evidenceHash: digest(JSON.stringify({ codeHash: digest(payload.code), results: tests })) }, tests,
    settlement: { taskId: chain.taskId, runId, passed: true, txHash: keccak256(settleRaw), blockNumber: 50, feedback: [] } };
  session.submission = { payload, runId, result: arena };
  await write(directory, "settlement-journal.json", { [chain.taskId]: { verdict: arena.verdict, verdictHash: digest(JSON.stringify(arena.verdict)), rawTx: settleRaw, txHash: arena.settlement.txHash, settlement: arena.settlement } });
  const settledEvent = escrowInterface.encodeEventLog(escrowInterface.getEvent("TaskSettled")!, [chain.taskId, true, 0, 0, 142500]);
  await write(directory, "settlement-transaction-receipt.json", { status: 1, from: verifier.address, to: chain.escrow, hash: arena.settlement.txHash, blockNumber: 50, blockHash: key(300), logs: [{ address: chain.escrow, ...settledEvent }] });
  await write(directory, "arena-result.json", arena); await write(directory, "report.json", report); await write(directory, "session/session.json", session);
  return { session, report, wallet, verifier };
}

test("offline Pi audit binds two paid models, tool feedback, code signature and independent settlement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-audit-"));
  try {
    await fixture(directory); const audit = await auditSavedPi(directory);
    assert.equal(audit.fullyVerified, true); assert.equal(audit.verificationScope, "saved-artifacts"); assert.equal(audit.rounds, 2);
    assert.equal(audit.totalPriceRaw, "40000"); assert.equal(audit.twoTierModelsVerified, false); assert.equal(audit.twoTierBindingsValidated, true); assert.equal(audit.naturalRepairObserved, true);
    assert.equal(audit.upstreamMode, "controlled-upstream");
    assert.equal(audit.outcome, "repair-after-feedback"); assert.equal(audit.rawProviderPaidEventsValidated, 2);
    assert.ok(audit.limitations[0].includes("does not query"));
    // A failure must invalidate an old success file, not leave it as apparently current evidence.
    await edit(directory, "report.json", value => { value.plan.preseededError = true; }); await assert.rejects(auditSavedPi(directory));
    assert.equal((await read(directory, "offline-pi-audit.json")).fullyVerified, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("one-round successful sample is not reported as repair or both-tier verification", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-audit-one-"));
  try { await fixture(directory, [good]); const audit = await auditSavedPi(directory); assert.equal(audit.rounds, 1); assert.equal(audit.naturalRepairObserved, false);
    assert.equal(audit.twoTierModelsVerified, false); assert.equal(audit.outcome, "single-round-success"); }
  finally { await rm(directory, { recursive: true, force: true }); }
});

test("offline Pi audit rejects changed price, usage, tool ID/code, signer/domain and raw events", async t => {
  const cases: [string, (directory: string, data: Awaited<ReturnType<typeof fixture>>) => Promise<void>][] = [
    ["quote price", async directory => edit(directory, "session/session.json", value => { value.rounds[0].handle.quote.price = "9999"; })],
    ["receipt usage", async directory => edit(directory, "session/session.json", value => { value.rounds[0].inference.receipt.usage.completion_tokens++; })],
    ["physical request", async directory => edit(directory, "round-1/request.json", value => { value.model = "kimi-k3"; })],
    ["tool result ID", async directory => edit(directory, "session/session.json", value => { value.messages.find((m: any) => m.role === "toolResult").toolCallId = "another_id"; })],
    ["journal code", async directory => edit(directory, "session/session.json", value => { value.tools[1].code = "print(9)\n"; })],
    ["submission code", async directory => edit(directory, "session/session.json", value => { value.submission.payload.code = "print(9)\n"; })],
    ["wrong agent signer", async (directory, { session }) => {
      const payload = session.submission!.payload, config = session.config;
      const typed = submissionTypedData({ rpcUrl: config.rpcUrl, chainId: config.chainId, escrowAddress: config.escrowAddress, ipcDirectory: "/unused", tasks: { [config.taskId]: { agentId: config.agentId, problemId: "sum-integers" } } }, payload);
      const signature = await new Wallet(key(3)).signTypedData(typed.domain, typed.types, typed.message);
      await edit(directory, "session/session.json", value => { value.submission.payload.signature = signature; });
    }],
    ["wrong signature domain", async (directory, { session, wallet }) => {
      const payload = session.submission!.payload, config = session.config;
      const typed = submissionTypedData({ rpcUrl: config.rpcUrl, chainId: "1", escrowAddress: config.escrowAddress, ipcDirectory: "/unused", tasks: { [config.taskId]: { agentId: config.agentId, problemId: "sum-integers" } } }, payload);
      const signature = await wallet.signTypedData(typed.domain, typed.types, typed.message);
      await edit(directory, "session/session.json", value => { value.submission.payload.signature = signature; });
    }],
    ["verdict domain", async directory => {
      await edit(directory, "arena-result.json", value => { value.verdict.chainId = "1"; });
      await edit(directory, "session/session.json", value => { value.submission.result.verdict.chainId = "1"; });
    }],
    ["failed Arena test", async directory => {
      await edit(directory, "arena-result.json", value => { value.tests[0].passed = false; });
      await edit(directory, "session/session.json", value => { value.submission.result.tests[0].passed = false; });
    }],
    ["failed final public sample despite a success claim", async directory => edit(directory, "session/session.json", value => {
      const failed = { passed: false, stdout: "0\n", failure: "wrong-answer" };
      value.tools[1].result = failed; value.messages.at(-1).content = [{ type: "text", text: JSON.stringify(failed) }];
    })],
    ["ProviderPaid amount", async (directory, { session, report }) => {
      const event = accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [report.localChain.agentId, report.localChain.provider, session.rounds[0].handle!.quote.paymentId, 9999, 0]);
      await edit(directory, "round-1/transaction-receipt.json", value => { value.logs[0] = { address: report.localChain.account, ...event }; });
    }],
    ["ProviderPaid duplicate", async directory => edit(directory, "round-1/transaction-receipt.json", value => { value.logs.push(value.logs[0]); })],
    ["wrong escrow receipt", async directory => edit(directory, "settlement-transaction-receipt.json", value => { value.to = address(99); })],
    ["non-independent settlement sender", async (directory, { report }) => edit(directory, "settlement-transaction-receipt.json", value => { value.from = report.localChain.agentAddress; })],
    ["TaskSettled false", async (directory, { report }) => {
      const event = escrowInterface.encodeEventLog(escrowInterface.getEvent("TaskSettled")!, [report.localChain.taskId, false, 0, 0, 0]);
      await edit(directory, "settlement-transaction-receipt.json", value => { value.logs[0] = { address: report.localChain.escrow, ...event }; });
    }],
    ["unconfirmed settlement", async directory => edit(directory, "settlement-transaction-receipt.json", value => { value.status = 0; })],
    ["journal verdict hash", async (directory, { report }) => edit(directory, "settlement-journal.json", value => { value[report.localChain.taskId].verdictHash = "0".repeat(64); })],
    ["signed settle wrong task", async (directory, { report, verifier }) => {
      const raw = await verifier.signTransaction({ chainId: 31337, nonce: 0, gasPrice: 1, gasLimit: 250000, to: report.localChain.escrow,
        data: escrowInterface.encodeFunctionData("settle", ["8", true]) });
      await replaceSettlerTransaction(directory, report, raw);
    }],
    ["signed settle wrong signer", async (directory, { report, wallet }) => {
      const raw = await wallet.signTransaction({ chainId: 31337, nonce: 0, gasPrice: 1, gasLimit: 250000, to: report.localChain.escrow,
        data: escrowInterface.encodeFunctionData("settle", [report.localChain.taskId, true]) });
      await replaceSettlerTransaction(directory, report, raw);
    }],
    ["truncated response", async directory => edit(directory, "round-1/response.json", value => { value.choices[0].finish_reason = "length"; })],
    ["stopped session", async directory => edit(directory, "session/session.json", value => { value.phase = "Stopped"; })],
    ["failed report", async directory => edit(directory, "report.json", value => { value.status = "Failed"; })],
    ["nonzero retry plan", async directory => edit(directory, "report.json", value => { value.plan.inferenceRetries = 1; })],
    ["unaccounted nonce", async directory => edit(directory, "report.json", value => { value.localChain.agentNonceAfter++; })],
    ["secret in public receipt", async directory => edit(directory, "session/session.json", value => { value.rounds[0].inference.receipt.apiKey = "synthetic-secret"; })],
  ];
  for (const [name, mutate] of cases) await t.test(name, async () => {
    const directory = await mkdtemp(join(tmpdir(), "af-pi-audit-tamper-"));
    try { const data = await fixture(directory); await mutate(directory, data); await assert.rejects(auditSavedPi(directory)); assert.equal((await read(directory, "offline-pi-audit.json")).fullyVerified, false); }
    finally { await rm(directory, { recursive: true, force: true }); }
  });
});

test("full plan metadata is retained without rejecting its extra fields", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-audit-plan-"));
  try {
    await fixture(directory, [good]); await edit(directory, "report.json", value => {
      Object.assign(value.plan, { chainId: "31337", asset: "local mock-USDC", assetDecimals: 6, tiers: ["cheap", "strong", "strong"], deadlineDurationMs: 300000,
        apiSource: "https://platform.kimi.com/docs/api/chat.md", limitation: "Operator mock-USDC quote budget excludes gas." });
    }); assert.equal((await auditSavedPi(directory)).fullyVerified, true);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("offline auditor CLI exits nonzero for failed evidence", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-audit-cli-"));
  try {
    await fixture(directory, [good]); await edit(directory, "session/session.json", value => { value.phase = "Failed"; });
    const result = spawnSync(process.execPath, ["--import", "tsx", "scripts/live-pi-evidence.ts", directory], { cwd: new URL("../..", import.meta.url).pathname, encoding: "utf8" });
    assert.equal(result.status, 1); assert.ok(result.stderr.includes("Pi evidence audit failed")); assert.equal((await read(directory, "offline-pi-audit.json")).fullyVerified, false);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
