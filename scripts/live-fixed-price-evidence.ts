import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Interface, Transaction, verifyTypedData } from "ethers";
import { normalizeContext, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { accountInterface, requestDigest, paymentId, sameAddress } from "@agentfuel/sdk/protocol";
import { AUTH_TYPES } from "../services/underwriter/src/underwriter.js";
import { submissionTypedData } from "../services/arena/src/submission-auth.js";
import { digest } from "../services/arena/src/protocol.js";
import { assistantFromInference, toRelayMessages } from "../packages/pi-loop/src/adapter.js";
import { isFixedProblemId, publicSampleFor } from "../packages/pi-loop/src/public-sample.js";
import { hiddenTests } from "../services/arena/src/problems.js";
import type { FixedTaskSession } from "../packages/pi-loop/src/fixed-task.js";
import { verifyProviderPaid } from "./live-tiers-evidence.js";
import { saveJson } from "./demo-common.js";
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const manager = new Interface(["event LoanOpened(uint256 indexed taskId,uint256 indexed agentId,uint256 amount,uint8 tier)"]);
const escrow = new Interface(["event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)", "function settle(uint256,bool)"]);
const model: Model<"openai-completions"> = { id: "bounded-solver-v1", name: "Bounded provider solver", api: "openai-completions", provider: "agentfuel-provider", baseUrl: "https://unused.invalid/v1", input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: 2048 };

/** Pure offline consistency checks of raw signatures, receipts, upstream evidence and Pi journals. */
export async function auditSavedFixedPrice(outputDir: string) {
  const output = resolve(outputDir), json = async (path: string) => JSON.parse(await readFile(join(output, path), "utf8"));
  try {
    const report = await json("report.json"), session = await json("session/session.json") as FixedTaskSession;
    assert.equal(report.version, 1); assert.ok(["real-kimi-system-https-proxy", "real-kimi-via-configured-gateway", "controlled"].includes(report.upstreamMode));
    // Old default reports deliberately have no scenario field; keep their plan/binding intact.
    const scenario = report.plan.scenario;
    assert.ok(scenario === undefined || scenario === "strong-only" || scenario === "catalog-once");
    const problemId = report.plan.problemId ?? "sum-integers"; assert.ok(isFixedProblemId(problemId));
    if (scenario === undefined) assert.equal(report.plan.problemId, undefined);
    if (scenario === "catalog-once") assert.equal(report.plan.problemId, problemId);
    const sample = publicSampleFor(problemId);
    assert.deepEqual(report.plan.tiers, scenario === "strong-only" ? ["strong", "strong"] : scenario === "catalog-once" ? ["cheap"] : ["cheap", "strong", "strong"]);
    assert.equal(report.plan.maxRounds, scenario === "strong-only" ? 2 : scenario === "catalog-once" ? 1 : 3);
    assert.equal(report.plan.maxCompletionTokens, 2048); assert.equal(report.plan.maxToolCalls, 4); assert.equal(report.plan.deadlineMs, 300000);
    assert.equal(report.plan.modelRetries, 0); assert.equal(report.plan.fixedPriceRaw, "120000"); assert.equal(report.plan.rewardRaw, "150000");
    assert.deepEqual(session.config.solve.tiers, report.plan.tiers); assert.equal(session.config.solve.maxRounds, report.plan.maxRounds);
    assert.equal(session.config.solve.maxCompletionTokens, report.plan.maxCompletionTokens); assert.equal(session.config.solve.maxToolCalls, report.plan.maxToolCalls);
    assert.equal(session.config.solve.problemId, problemId); assert.equal(session.config.solve.deadlineMs, session.config.deadlineMs);
    const runner = await json("runner/session.json");
    assert.deepEqual(runner.client, session.config); assert.equal(runner.mode, report.mode);
    if (scenario === "strong-only" || scenario === "catalog-once") { assert.equal(report.mode, "local"); assert.equal(session.config.chainId, "31337"); }
    const chain = report.chain, handle = session.handle!, quote = handle.quote, receipt = session.inference!.receipt;
    const result = session.inference!.result as any, run = result.run, record = await json(`relay/${quote.paymentId}.json`), providerRun = await json(`relay/solve-runs/${quote.paymentId}/session.json`);
    assert.equal(session.phase, "Succeeded"); assert.equal(report.clientPhase, "Succeeded"); assert.equal(report.complete, true);
    assert.equal(session.config.chainId, chain.chainId); assert.equal(session.config.taskId, chain.taskId); assert.equal(session.config.agentId, chain.agentId);
    assert.ok(sameAddress(session.config.account, chain.account)); assert.ok(sameAddress(session.config.provider, chain.provider)); assert.ok(sameAddress(session.config.asset, chain.asset));
    assert.equal(handle.input.taskId, chain.taskId); assert.equal(handle.input.agentId, chain.agentId); assert.equal(handle.input.service, "infercredit/solve-fixed"); assert.equal(handle.input.model, "pi-fixed-v1");
    assert.deepEqual(handle.input.solve, session.config.solve); assert.deepEqual(handle.input.messages, [{ role: "user", content: sample.prompt }]);
    assert.equal(quote.requestDigest, requestDigest(handle.input)); assert.equal(quote.paymentId, paymentId(chain.taskId, quote.requestDigest, quote.serverNonce));
    assert.equal(quote.price, report.plan.fixedPriceRaw); assert.equal(session.reservedPrice, quote.price); assert.equal(quote.price, session.config.maxServicePrice);
    assert.equal(quote.chainId, chain.chainId); assert.equal(quote.agentId, chain.agentId); assert.equal(quote.taskId, chain.taskId); assert.equal(quote.service, handle.input.service); assert.equal(quote.model, handle.input.model);
    for (const field of ["account", "asset", "payTo"] as const) assert.ok(sameAddress(quote[field], field === "payTo" ? chain.provider : chain[field]));
    for (const field of ["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "chainId", "account", "asset", "payTo"] as const) assert.equal(receipt[field], quote[field]);
    assert.equal(receipt.tier, undefined); assert.equal(record.state, "Delivered"); assert.deepEqual(record.refunds, []); assert.ok(!record.expiredPayment);
    assert.deepEqual(record.quote, quote); assert.deepEqual(record.request, handle.input); assert.deepEqual(record.receipt, receipt); assert.deepEqual(record.result, result);
    assert.deepEqual(providerRun, run); assert.equal(run.phase, "Delivered"); assert.deepEqual(run.spec, session.config.solve);
    assert.equal(result.schema, 1); assert.equal(result.taskId, chain.taskId); assert.equal(result.codeHash, sha(result.code)); assert.equal(run.candidate, result.code); assert.equal(run.codeHash, result.codeHash);
    const paidRaw = await json(`receipts/${receipt.txHash}.json`); verifyProviderPaid(quote, receipt, paidRaw);
    const token = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
    const transfers = paidRaw.logs.filter((l: any) => sameAddress(l.address, chain.asset)).map((l: any) => { try { return token.parseLog(l); } catch { return null; } }).filter((e: any) => e?.name === "Transfer" && sameAddress(e.args.from, chain.account) && sameAddress(e.args.to, chain.provider));
    assert.equal(transfers.length, 1); assert.equal(transfers[0].args.value, BigInt(quote.price));
    const paid = Transaction.from(handle.submission!.rawTransaction!); assert.equal(paid.hash, receipt.txHash); assert.equal(handle.submission!.txHash, paid.hash); assert.equal(handle.submission!.nonce, paid.nonce);
    assert.ok(sameAddress(paid.from!, chain.agentAddress)); assert.ok(sameAddress(handle.submission!.from, paid.from!)); assert.ok(sameAddress(paid.to!, chain.account)); assert.equal(paid.chainId, BigInt(chain.chainId)); assert.equal(paid.value, 0n);
    const payCall = accountInterface.parseTransaction({ data: paid.data, value: paid.value })!; assert.equal(payCall.name, "payProvider"); assert.equal(payCall.args[0], BigInt(chain.agentId)); assert.ok(sameAddress(payCall.args[1], chain.provider)); assert.equal(payCall.args[2], BigInt(quote.price)); assert.equal(payCall.args[3], quote.paymentId);
    const auth = payCall.args[4], fields = AUTH_TYPES.CreditAuthorization.map(field => field.name), authorization = Object.fromEntries(fields.map(field => [field, auth[field]]));
    assert.ok(sameAddress(verifyTypedData({ name: "InferCredit", version: "1", chainId: chain.chainId, verifyingContract: chain.manager }, AUTH_TYPES, authorization, payCall.args[5]), chain.underwriter));
    assert.equal(auth.agentId, BigInt(chain.agentId)); assert.equal(auth.taskId, BigInt(chain.taskId)); assert.equal(auth.nonce, BigInt(handle.creditNonce));
    const evidence = await readFile(join(output, "underwriter", `${auth.evidenceHash}.json`), "utf8"); const { keccak256, toUtf8Bytes } = await import("ethers"); assert.equal(keccak256(toUtf8Bytes(evidence)), auth.evidenceHash);
    const financing = JSON.parse(evidence); assert.equal(financing.task.taskId, chain.taskId); assert.equal(financing.agent.agentId, chain.agentId); assert.equal(financing.authorization, undefined);
    const credit = BigInt(receipt.fromCredit), cash = BigInt(receipt.fromCash), fee = credit * auth.feeBps / 10000n;
    assert.ok(credit > 0n, "This validation must actually borrow"); assert.equal(cash + credit, BigInt(quote.price)); assert.equal(cash, BigInt(chain.before.cash)); assert.ok(credit <= auth.principalCap);
    const opened = paidRaw.logs.filter((l: any) => sameAddress(l.address, chain.manager)).map((l: any) => { try { return manager.parseLog(l); } catch { return null; } }).filter((e: any) => e?.name === "LoanOpened");
    assert.equal(opened.length, 1); assert.equal(opened[0].args.agentId, BigInt(chain.agentId)); assert.equal(opened[0].args.taskId, BigInt(chain.taskId)); assert.equal(opened[0].args.amount, credit); assert.equal(opened[0].args.tier, auth.riskTier);
    assert.equal(run.rounds.length, report.attempts.length); assert.ok(run.rounds.length > 0 && run.rounds.length <= report.plan.maxRounds); assert.ok(run.tools.length > 0 && run.tools.length <= report.plan.maxToolCalls);
    const assistants = run.messages.map((message: any, index: number) => ({ message, index })).filter((item: any) => item.message.role === "assistant"); assert.equal(assistants.length, run.rounds.length);
    let earlyPass = false;
    const ids = new Set<string>(), observations: { round: number; passed: boolean; code: string }[] = [];
    for (let i = 0; i < run.rounds.length; i++) {
      const round = run.rounds[i], attempt = report.attempts[i], physical = await json(`round-${i + 1}/request.json`), response = await json(`round-${i + 1}/response.json`);
      assert.equal(round.state, "Responded"); assert.equal(round.appended, true); assert.deepEqual(round.response, response); assert.deepEqual(round.body, physical);
      assert.equal(round.tier, session.config.solve.tiers[i]); assert.equal(round.model, report.plan.models[round.tier]); assert.equal(physical.model, round.model); assert.equal(physical.max_completion_tokens, report.plan.maxCompletionTokens);
      assert.deepEqual(physical.messages, toRelayMessages(normalizeContext({ messages: run.messages.slice(0, assistants[i].index) })));
      if (i === 0) {
        assert.ok(physical.messages.every((message: any) => message.role === "system" || message.role === "user"));
        assert.deepEqual(physical.messages.filter((message: any) => message.role === "user"), [{ role: "user", content: sample.prompt }]);
      }
      assert.equal(physical.tools.length, 1); assert.equal(physical.tools[0].function.name, "test_public_sample"); assert.equal(physical.stream, undefined); assert.equal(physical.agentId, undefined); assert.equal(physical.taskId, undefined);
      if (round.tier === "cheap") assert.deepEqual(physical.thinking, { type: "disabled" }); else assert.equal(physical.reasoning_effort, "low");
      assert.equal(attempt.round, i + 1); assert.equal(attempt.httpStatus, 200); assert.equal(attempt.state, "Responded"); assert.equal(attempt.paymentId, quote.paymentId); assert.equal(attempt.requestDigest, quote.requestDigest); assert.equal(attempt.requestedModel, physical.model);
      assert.equal(attempt.returnedModel, response.model); assert.equal(response.model, report.plan.responseModels[round.tier]); assert.deepEqual(attempt.usage, response.usage); assert.equal(attempt.finishReason, response.choices[0].finish_reason); assert.ok(["stop", "tool_calls"].includes(attempt.finishReason));
      const usage = response.usage; for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) assert.ok(Number.isSafeInteger(usage[field]) && usage[field] >= 0);
      assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens); assert.ok(usage.completion_tokens > 0 && usage.completion_tokens <= 2048);
      const expected = assistantFromInference({ result: response }, model), assistant = assistants[i].message as AssistantMessage;
      for (const field of ["content", "usage", "stopReason", "rawStopReason", "model", "responseModel", "responseId"] as const) assert.deepEqual(assistant[field], expected[field]);
      const calls = expected.content.filter(item => item.type === "toolCall"), following = run.messages.slice(assistants[i].index + 1, assistants[i + 1]?.index ?? run.messages.length);
      assert.ok(calls.length > 0); assert.equal(following.length, calls.length);
      for (let j = 0; j < calls.length; j++) {
        const call = calls[j], key = `${i + 1}:${call.id}`, journal = run.tools.filter((item: any) => item.id === key); assert.ok(!ids.has(key));
        assert.equal(call.name, "test_public_sample"); assert.deepEqual(Object.keys(call.arguments), ["code"]); const tool = following[j];
        if (journal.length === 0) {
          assert.ok(earlyPass, "Only calls after a passing sample can be blocked in a delivered run");
          assert.equal(tool.role, "toolResult"); assert.equal(tool.toolCallId, call.id); assert.equal(tool.toolName, call.name); assert.equal(tool.isError, true);
          assert.equal(tool.content.map((p: any) => p.text ?? "").join(""), "PUBLIC_SAMPLE_PASSED");
          continue;
        }
        ids.add(key); assert.equal(journal.length, 1); assert.equal(journal[0].code, call.arguments.code);
        assert.equal(tool.role, "toolResult"); assert.equal(tool.toolCallId, call.id); assert.equal(tool.toolName, call.name); assert.equal(tool.isError, false);
        assert.deepEqual(JSON.parse(tool.content.map((p: any) => p.text ?? "").join("")), journal[0].result);
        if (journal[0].result.passed) { assert.deepEqual(JSON.parse(journal[0].result.stdout.trim()), sample.expected); earlyPass = true; }
        observations.push({ round: i + 1, code: journal[0].code, passed: journal[0].result.passed });
      }
    }
    assert.equal(run.tools.length, ids.size); const last = run.rounds.at(-1); assert.equal(receipt.model, last.model); assert.equal(receipt.upstream, last.tier); assert.deepEqual(receipt.usage, last.response.usage);
    assert.ok(observations.some(o => o.passed && o.code === result.code)); assert.equal(session.candidate, result.code); assert.equal(session.qualificationCodeHash, result.codeHash); assert.equal(session.qualification!.passed, true); assert.deepEqual(JSON.parse(session.qualification!.stdout.trim()), sample.expected);
    const submission = session.submission!, arena = submission.result as any; assert.equal(submission.payload.code, result.code); assert.equal(submission.payload.taskId, chain.taskId);
    const typed = submissionTypedData({ rpcUrl: session.config.rpcUrl, chainId: chain.chainId, escrowAddress: chain.escrow, ipcDirectory: "/unused", tasks: { [chain.taskId]: { agentId: chain.agentId, problemId } } }, submission.payload);
    assert.ok(sameAddress(verifyTypedData(typed.domain, typed.types, typed.message, submission.payload.signature), chain.agentAddress));
    assert.equal(arena.verdict.passed, true); assert.equal(arena.verdict.mode, "docker"); assert.equal(arena.verdict.chainId, chain.chainId); assert.ok(sameAddress(arena.verdict.escrowAddress, chain.escrow)); assert.equal(arena.verdict.taskId, chain.taskId); assert.equal(arena.verdict.agentId, chain.agentId); assert.equal(arena.verdict.problemId, problemId); assert.equal(arena.verdict.runId, submission.runId);
    assert.equal(arena.tests.length, hiddenTests(problemId).length); arena.tests.forEach((t: any, i: number) => { assert.equal(t.case, i + 1); assert.equal(t.passed, true); assert.equal(t.failure, undefined); }); assert.equal(arena.verdict.evidenceHash, digest(JSON.stringify({ codeHash: digest(result.code), results: arena.tests })));
    const settlementJournal = await json("settlement-journal.json"), entry = settlementJournal[chain.taskId]; assert.deepEqual(entry.verdict, arena.verdict); assert.deepEqual(entry.settlement, arena.settlement); assert.equal(entry.verdictHash, digest(JSON.stringify(entry.verdict)));
    const signed = Transaction.from(entry.rawTx); assert.equal(signed.hash, entry.txHash); assert.equal(signed.hash, arena.settlement.txHash); assert.equal(signed.chainId, BigInt(chain.chainId)); assert.ok(sameAddress(signed.from!, chain.verifier)); assert.ok(sameAddress(signed.to!, chain.escrow));
    const settleCall = escrow.parseTransaction({ data: signed.data, value: signed.value })!; assert.equal(settleCall.name, "settle"); assert.equal(settleCall.args[0], BigInt(chain.taskId)); assert.equal(settleCall.args[1], true);
    const settledRaw = await json(`receipts/${entry.txHash}.json`); assert.equal(settledRaw.status, 1); assert.equal(settledRaw.hash, signed.hash); assert.equal(settledRaw.blockNumber, arena.settlement.blockNumber); assert.ok(sameAddress(settledRaw.from, chain.verifier)); assert.ok(sameAddress(settledRaw.to, chain.escrow));
    const settled = settledRaw.logs.filter((l: any) => sameAddress(l.address, chain.escrow)).map((l: any) => { try { return escrow.parseLog(l); } catch { return null; } }).filter((e: any) => e?.name === "TaskSettled"); assert.equal(settled.length, 1); assert.equal(settled[0].args.taskId, BigInt(chain.taskId)); assert.equal(settled[0].args.passed, true); assert.equal(settled[0].args.repaid, credit + fee); assert.equal(settled[0].args.slashed, 0n);
    assert.equal(BigInt(chain.after.providerTokenBalance) - BigInt(chain.before.providerTokenBalance), BigInt(quote.price)); assert.equal(chain.after.agentNonce, chain.before.agentNonce + 1); assert.equal(paid.nonce, chain.before.agentNonce);
    assert.equal(BigInt(chain.after.cash), BigInt(chain.before.cash) - cash + settled[0].args.agentResidual); assert.equal(chain.before.taskStatus, "2"); assert.equal(chain.after.taskStatus, "3"); assert.equal(chain.before.loan[4], "0"); assert.equal(chain.after.loan[4], "2"); assert.equal(chain.after.loan[1], "0"); assert.equal(chain.after.loan[2], "0"); assert.equal(chain.after.totalOutstanding, chain.before.totalOutstanding);
    const repairObserved = observations.some(a => !a.passed && observations.some(b => b.passed && b.round > a.round && b.code !== a.code));
    const summary = { version: 1, fullyVerified: true, scope: "saved-artifacts", checkedAt: new Date().toISOString(), chainId: chain.chainId, upstreamMode: report.upstreamMode, scenario: scenario ?? "default",
      ...(report.plan.problemId ? { problemId } : {}),
      rounds: run.rounds.length, toolCalls: run.tools.length, fixedPriceRaw: quote.price, fromCash: receipt.fromCash, fromCredit: receipt.fromCredit, feeBps: String(auth.feeBps), fee: fee.toString(),
      signedPaymentValidated: true, signedCreditAuthorizationValidated: true, rawProviderPaidValidated: true, rawLoanOpenedValidated: true, submissionSignatureValidated: true, signedSettlementValidated: true, rawTaskSettledValidated: true, repaid: (credit + fee).toString(),
      repairObserved, actualModelRequests: run.rounds.map((r: any) => ({ tier: r.tier, requestedModel: r.model, returnedModel: r.response.model, usage: r.response.usage })),
      limitations: ["Offline audit verifies saved-artifact consistency, not independent upstream provenance or current canonical chain state.", "Fixed bundle price is an operator price; receipt usage is only the last-round summary, and no Kimi bill is inferred.", ...(report.upstreamMode === "controlled" ? ["Controlled models do not verify real Kimi credit execution."] : []), ...(!repairObserved ? ["This run does not demonstrate repair after a failed public sample."] : [])] };
    await saveJson(join(output, "offline-fixed-audit.json"), summary); return summary;
  } catch (error) { await saveJson(join(output, "offline-fixed-audit.json"), { version: 1, fullyVerified: false, checkedAt: new Date().toISOString(), error: "FIXED_PRICE_EVIDENCE_INVALID" }); throw error; }
}
