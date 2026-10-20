import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Contract, Wallet } from "ethers";
import { createWorkflowFixture, GOOD_CODE } from "../packages/pi-loop/test/workflow-fixture.js";
import { key, read, tx } from "../services/underwriter/test/fixture.js";
import { HostedTaskExecutor, type HostedTaskExecutorConfig } from "../services/hosted-agents/src/task-executor.js";
import { readHostedAccounting } from "../services/hosted-agents/src/accounting.js";
import { readHostedStrategyAdvice } from "../services/hosted-agents/src/strategy-history.js";
import { readHostedOperatingReport } from "../services/hosted-agents/src/operating-history.js";
import type { StrategyPreviewCandidate } from "../services/hosted-agents/src/strategy-types.js";
import type { HostedAgent, HostedExecution, HostedResult, HostedRun, HostedStrategy } from "../services/hosted-agents/src/types.js";
import type { WorkflowConfig } from "../packages/pi-loop/src/workflow.js";

const [directoryArg, reportPath] = process.argv.slice(2);
if (!directoryArg || !reportPath || !isAbsolute(directoryArg) || !isAbsolute(reportPath)) throw Error("USE_CHECK_ECONOMIC_LOOP_LAUNCHER");
const directory = await realpath(directoryArg);
const startedAt = new Date().toISOString();
const definitions = [
  { problemId: "sum-integers" as const, open: true, agentId: null, reward: 100000n },
  { problemId: "sum-integers" as const, open: true, agentId: null, reward: 200000n },
  { problemId: "unique-sorted" as const, open: true, agentId: null, reward: 200000n },
  { problemId: "sum-integers" as const, open: true, agentId: null, reward: 200000n },
  { problemId: "balanced-brackets" as const, open: true, agentId: null, reward: 200000n },
  { problemId: "sum-integers" as const, open: true, agentId: null, reward: 200000n },
];
let fx: Awaited<ReturnType<typeof createWorkflowFixture>> | undefined;
const report: Record<string, any> = { version: 1, suite: "local-economic-loop", status: "failed", startedAt,
  provenance: { chainId: "31337", environment: "owned-local-anvil", settlementAsset: "six-decimal-mock-USDC", model: "controlled-response-injection",
    evaluation: "real-pinned-Docker-public-and-hidden-tests", settlement: "independent-Arena-settler-process", admission: "successful-completion-bound; not expected value" },
  scope: { productionNetworkUsed: false, publicVendorCalls: false, nativeGasValuedInUSDC: false, nonzeroGameSubsidyExercised: false, autonomousPlannerExercised: false,
    limitations: ["Local MockERC20 and MockIdentityRegistry; no public Monad or live model-vendor evidence.", "Model outputs and dispatch-unknown faults are controlled; Docker verdicts, payments, settlement and refund are real local transactions.", "Owner supplies initial USDC and native gas; task publishers pre-fund rewards and the lending pool has initial liquidity.", "The host supplies an explicit task sequence; this is not an autonomous-planner or external-publisher acceptance.", "No game is run: game subsidy is exactly zero; nonzero subsidy accounting is covered by separate game integration tests."] }, scenarios: [], predicates: {} };
const stage = (name: string) => process.stderr.write(`economic-loop: ${name}\n`);
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const strategySources = ["services/hosted-agents/src/strategy-advice.ts", "services/hosted-agents/src/strategy-history.ts",
  "services/hosted-agents/src/strategy-types.ts", "services/hosted-agents/src/accounting.ts", "services/hosted-agents/src/finance-projection.ts",
  "services/hosted-agents/src/finance-reader.ts", "services/hosted-agents/src/task-executor.ts", "packages/pi-loop/src/workflow.ts",
  "packages/pi-loop/src/selector.ts", "packages/pi-loop/src/economics.ts"];
const strategySourceHashes = async () => Object.fromEntries(await Promise.all(strategySources.map(async path =>
  [path, sha(await readFile(new URL(`../${path}`, import.meta.url)))])));
const operatingSources = ["services/hosted-agents/src/operating-types.ts", "services/hosted-agents/src/operating-report.ts",
  "services/hosted-agents/src/operating-history.ts"];
const operatingSourceHashes = async () => Object.fromEntries(await Promise.all([...strategySources, ...operatingSources].map(async path =>
  [path, sha(await readFile(new URL(`../${path}`, import.meta.url)))])));
try {
  report.strategySourceSha256 = await strategySourceHashes();
  report.operatingSourceSha256 = await operatingSourceHashes();
  stage("starting owned local services");
  fx = await createWorkflowFixture(join(directory, "runtime"), definitions);
  const f = fx.f;
  for (const endpoint of [fx.local.rpc, fx.options.arenaUrl, fx.options.underwriterUrl, fx.config.providers[0].relayUrl]) assert.equal(new URL(endpoint!).hostname, "127.0.0.1");
  const guardianKeyFile = join(directory, "guardian.key"), rpcUrlFile = join(directory, "rpc-url"), keyFile = join(directory, "actor.key");
  await writeFile(guardianKeyFile, key(1), { mode: 0o600 }); await writeFile(rpcUrlFile, fx.local.rpc, { mode: 0o600 }); await writeFile(keyFile, key(20), { mode: 0o600 });
  const template = structuredClone(fx.config); template.deadlineMs = Date.now() + 320000;
  const templates = Object.fromEntries(["conservative", "balanced", "aggressive"].map(strategy => [strategy, structuredClone(template)])) as Record<HostedStrategy, WorkflowConfig>;
  const config: HostedTaskExecutorConfig = { version: 1, identity: await f.identity.getAddress(), guardianKeyFile, initialCashRaw: "40000", rpcUrlFile, rpcTransport: "direct", publicRpcUrl: fx.local.rpc,
    walletDirectory: join(directory, "wallets"), arenaUrl: fx.options.arenaUrl!, underwriterUrl: fx.options.underwriterUrl, timeoutMs: 5000, pollTimeoutMs: 30000,
    models: [{ id: "cheap", physicalModels: { cheap: "controlled-cheap", strong: "controlled-strong" }, templates }] };
  const wallet = new Wallet(key(20)), now = new Date().toISOString();
  await f.provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
  f.admin.reset(); const initialMint = await tx(f.token!, f.admin, "mint", [wallet.address, 40000n]);
  const agent: HostedAgent = { id: randomUUID(), owner: new Wallet(key(60)).address, wallet: wallet.address, name: "Economic loop", modelId: "cheap", strategy: "balanced",
    perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true, createdAt: now, updatedAt: now, status: "Pending", spentRaw: "0", reservedRaw: "0" };
  const runs: HostedRun[] = [];
  const input = (action: "provision" | "task"): HostedExecution => {
    const requestId = randomUUID();
    return { agent: structuredClone(agent), run: { requestId, agentId: agent.id, action, status: "Queued", createdAt: now, updatedAt: now, reservedRaw: action === "task" ? "120000" : "0", chargedRaw: "0", recoverable: false },
      directory: join(directory, "agents", agent.id, "runs", requestId), keyFile, recover: false };
  };
  const recordRun = (request: HostedExecution, result: HostedResult) => {
    const run: HostedRun = { ...request.run, status: result.terminal ? result.success ? "Succeeded" : "Failed" : "Paused", chargedRaw: result.chargedRaw, result, updatedAt: new Date().toISOString(), recoverable: !result.terminal };
    const index = runs.findIndex(run => run.requestId === request.run.requestId); if (index >= 0) runs[index] = run; else runs.push(run);
    agent.spentRaw = runs.reduce((sum, run) => sum + BigInt(run.chargedRaw), 0n).toString();
  };
  const execute = async (request: HostedExecution, resultConfig = config) => {
    const result = await new HostedTaskExecutor(resultConfig, { provider: f.provider }).execute(request); recordRun(request, result); return result;
  };
  const forTask = (index: number) => {
    const selected = structuredClone(config);
    for (const model of selected.models) for (const workflow of Object.values(model.templates)) workflow.tasks = [workflow.tasks[index]];
    return selected;
  };
  const cash = async () => String(await read(f.account, "cash", [agent.binding!.agentId]));
  const snapshot = async () => ({ cashRaw: await cash(), walletTokenRaw: String(await read(f.token!, "balanceOf", [wallet.address])), providerTokenRaw: String(await f.providerBalance()),
    agentNonce: await f.provider.getTransactionCount(wallet.address), modelCalls: fx!.calls.length });
  const receipt = async (hash: string | undefined, contract?: Contract, eventName?: string) => {
    assert.ok(hash); const receipt = await f.provider.getTransactionReceipt(hash); assert.ok(receipt); assert.equal(receipt.status, 1);
    const events = contract && eventName ? receipt.logs.filter(log => log.address.toLowerCase() === contract.target.toString().toLowerCase()).map(log => { try { return contract.interface.parseLog(log); } catch { return null; } }).filter(event => event?.name === eventName) : [];
    if (eventName) assert.equal(events.length, 1, `expected one ${eventName}`);
    const values = events[0] ? Object.fromEntries(events[0].fragment.inputs.map((parameter, index) => [parameter.name, typeof events[0]!.args[index] === "bigint" ? String(events[0]!.args[index]) : events[0]!.args[index]])) : undefined;
    return { txHash: receipt.hash, blockHash: receipt.blockHash, blockNumber: receipt.blockNumber, status: receipt.status, ...(eventName ? { event: eventName, eventCount: events.length, values } : {}) };
  };
  const accounting = async () => readHostedAccounting({ directory, agent, runs });
  // Read the fresh local execution history; never manufacture new admissions or
  // mutate the original requests to make the advisory projection look complete.
  const historyDigest = async () => {
    const files: [string, string][] = [];
    const walk = async (path: string) => {
      for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const child = join(path, entry.name);
        assert.equal(entry.isSymbolicLink(), false);
        if (entry.isDirectory()) await walk(child);
        else if (entry.isFile()) files.push([child.slice(directory.length), sha(await readFile(child))]);
      }
    };
    await walk(join(directory, "agents", agent.id));
    return sha(JSON.stringify(files));
  };
  const advisoryRead = async (label: string) => {
    const before = { ...await snapshot(), quoteCalls, historySha256: await historyDigest(), inputsSha256: sha(JSON.stringify({ agent, runs })) };
    const finance = await new HostedTaskExecutor(config, { provider: f.provider }).finance(agent);
    assert.equal(finance.status, "confirmed");
    const history = await readHostedStrategyAdvice({ directory, agent, runs, finance });
    assert.equal(history.history.gaps.includes("STRATEGY_ADMISSION_BINDING_MISMATCH"), false);
    const candidates: StrategyPreviewCandidate[] = ["sum-integers", "balanced-brackets"].map((problemId, index) => ({
      taskId: String(9001 + index), problemId, providerId: template.providers[0].id, tier: "cheap", funding: "cash",
      routeBinding: history.history.entries.find(entry => entry.prediction?.problemId === problemId && entry.prediction.funding === "cash")?.prediction?.routeBinding,
      executionCostRaw: "120000", planningCostRaw: "0", borrowerFeeBps: "1500", creditLimitRaw: "0",
      rewardRaw: "200000", escrowBalanceRaw: "200000", protocolFeeBps: "0", deadlineMs: Date.now() + 60000,
    }));
    const advice = await readHostedStrategyAdvice({ directory, agent, runs, finance,
      preview: { policy: { reserveCashRaw: "120000", minProfitRaw: "1", minMarginBps: "1000" }, candidates } });
    const operating = await readHostedOperatingReport({ directory, agent, runs, finance,
      preview: { reserveCashRaw: "120000", burn: { amountRaw: "120000", windowMs: 86400000, taskCount: 1 } } });
    const after = { ...await snapshot(), quoteCalls, historySha256: await historyDigest(), inputsSha256: sha(JSON.stringify({ agent, runs })) };
    assert.deepEqual(after, before);
    assert.equal(advice.mode, "advisory-only");
    assert.equal(advice.cash.creditIncluded, false);
    assert.ok(advice.candidates.every(candidate => candidate.source === "owner-hypothetical"));
    (report.strategyAdvice ??= []).push({ label, before, after, advice });
    assert.equal(operating.mode, "read-only");
    assert.equal(operating.scope, "owner-agent-contribution");
    assert.equal(operating.agent.settlementOperatingRaw, advice.history.netOperatingRaw);
    assert.equal(operating.agent.actualProfitRaw, null);
    assert.equal(operating.platform.treasuryReceiptsRaw, null);
    assert.equal(operating.suppliers.actualProfitRaw, null);
    assert.equal(operating.consolidation.roleTotalsAdditive, false);
    assert.equal(operating.subsidy.gameUsdcGrantedRaw, "0");
    assert.equal(operating.subsidy.usdcAttributedConsumptionRaw, null);
    assert.equal(operating.cash.creditIncluded, false);
    if (label === "after-three-settled-tasks") {
      assert.equal(operating.suppliers.netReceiptsRaw, "360000");
      assert.equal(operating.runway.status, "finite");
      assert.equal(operating.runway.horizonMs, "105264000");
      assert.equal(operating.runway.fullTasks, "1");
    } else if (label === "while-original-payment-is-unknown") {
      assert.equal(operating.runway.status, "unknown");
      assert.equal(operating.runway.horizonMs, null);
    } else if (label === "after-original-full-refund") {
      assert.equal(operating.platform.creditFeeSettledRaw, "13800");
      assert.deepEqual([operating.suppliers.grossReceiptsRaw, operating.suppliers.refundsRaw, operating.suppliers.netReceiptsRaw], ["600000", "120000", "480000"]);
      assert.equal(operating.suppliers.unattributedNetServiceCostRaw, "0");
      assert.equal(operating.runway.horizonMs, "18864000");
      assert.equal(operating.runway.fullTasks, "0");
    }
    (report.operatingReports ??= []).push({ label, before, after, operating });
    return advice;
  };
  const ledgerHashes: Record<string, string> = {};
  const remember = async (request: HostedExecution, label: string) => { ledgerHashes[label] = sha(await readFile(join(request.directory, "task-executor", "session.json"))); };
  let quoteCalls = 0; const quote = fx.relay.quote.bind(fx.relay); fx.relay.quote = async request => { quoteCalls++; return quote(request); };
  const provisionRequest = input("provision"), provision = await execute(provisionRequest); assert.equal(provision.phase, "Ready"); agent.binding = provision.binding; agent.status = "Ready";
  assert.equal(await cash(), "40000"); assert.equal(await read(f.token!, "balanceOf", [wallet.address]), 0n);
  report.initialFunding = { startupCapitalRaw: "40000", ownerTopupsAfterProvisionRaw: "0", gameSubsidyRaw: "0", taskPublisherFundedRewardsRaw: definitions.reduce((sum, d) => sum + d.reward, 0n).toString(),
    mint: await receipt(initialMint.hash), initialAgentId: agent.binding!.agentId };
  const taskCreationEvents = await f.escrow.queryFilter(f.escrow.filters.TaskCreated(), 0, "latest");
  assert.equal(taskCreationEvents.length, definitions.length);
  report.publishedTasks = [];
  for (let index = 0; index < definitions.length; index++) {
    const task = await read(f.escrow, "getTask", [template.tasks[index].taskId]);
    assert.equal(task.reward, definitions[index].reward); assert.equal(task.escrowBalance, definitions[index].reward); assert.equal(task.status, 1n);
    report.publishedTasks.push({ taskId: template.tasks[index].taskId, problemId: definitions[index].problemId, rewardRaw: String(task.reward), fundedEscrowRaw: String(task.escrowBalance), creation: await receipt(taskCreationEvents[index].transactionHash, f.escrow, "TaskCreated") });
  }
  await remember(provisionRequest, "provision");

  stage("rejecting unprofitable funded task");
  const rejectionRequest = input("task"), beforeRejected = { ...await snapshot(), quoteCalls }, rejected = await execute(rejectionRequest, forTask(0));
  assert.equal(rejected.phase, "Stopped"); assert.equal(rejected.reason, "ECONOMICS_NOT_WORTHWHILE"); assert.equal(rejected.chargedRaw, "0"); assert.equal(rejected.paymentId, undefined);
  assert.deepEqual({ ...await snapshot(), quoteCalls }, beforeRejected);
  assert.equal((await read(f.escrow, "getTask", [template.tasks[0].taskId])).status, 1n);
  const rejectedJournal = JSON.parse(await readFile(join(rejectionRequest.directory, "task-executor", "session.json"), "utf8"));
  const economicReason = rejectedJournal.admission.candidates[0].economics;
  assert.equal(economicReason.netRewardRaw, "-32000");
  report.scenarios.push({ name: "reject-loss-before-payment", requestId: rejectionRequest.run.requestId, taskId: template.tasks[0].taskId, phase: rejected.phase, reason: rejected.reason,
    economics: economicReason, before: beforeRejected, after: { ...await snapshot(), quoteCalls } });
  await remember(rejectionRequest, "rejected"); report.predicates.rejectLossWithZeroPayment = true;

  stage("earning and reinvesting without topups");
  const profitScenarios = [];
  for (let index = 1; index <= 3; index++) {
    const request = input("task"), before = await snapshot();
    if (index === 3) { request.agent.allowCredit = false; assert.ok(BigInt(before.cashRaw) >= 120000n); }
    fx.queue(GOOD_CODE[definitions[index].problemId]);
    const result = await execute(request, forTask(index)); assert.equal(result.phase, "Succeeded"); assert.equal(result.chargedRaw, "120000"); assert.equal(result.settlement?.passed, true);
    const after = await snapshot(), principal = BigInt(result.fromCreditRaw!), fee = principal * 1500n / 10000n;
    assert.equal(result.settlement!.repaidRaw, (principal + fee).toString()); assert.equal(result.principalRaw, "0"); assert.equal(result.feeRaw, "0");
    assert.equal(BigInt(after.cashRaw) - BigInt(before.cashRaw), 200000n - 120000n - fee);
    assert.equal(BigInt(after.providerTokenRaw) - BigInt(before.providerTokenRaw), 120000n);
    if (index === 3) { assert.equal(result.fromCreditRaw, "0"); assert.equal(result.fromCashRaw, "120000"); }
    const entry = { name: `profitable-task-${index}`, requestId: request.run.requestId, taskId: result.taskId, before, after, chargedRaw: result.chargedRaw,
      taskRevenueRaw: "200000", fromCashRaw: result.fromCashRaw, fromCreditRaw: result.fromCreditRaw, borrowingFeeRaw: fee.toString(), netOperatingRaw: (80000n - fee).toString(),
      repaidRaw: result.settlement!.repaidRaw, residualRaw: result.settlement!.residualRaw, loanStatus: result.settlement!.loanStatus,
      payment: await receipt(result.paymentTxHash, f.account, "ProviderPaid"), settlement: await receipt(result.settlement!.txHash, f.escrow, "TaskSettled"),
      funding: index === 3 ? "cash-only-from-retained-earnings; credit-disabled" : "initial-or-earned-cash-plus-task-credit" };
    profitScenarios.push(entry); report.scenarios.push(entry); await remember(request, `profitable-${index}`);
  }
  const beforeFailureAccounting = await accounting(); assert.equal(beforeFailureAccounting.status, "complete");
  assert.deepEqual([beforeFailureAccounting.totals.taskRevenueRaw, beforeFailureAccounting.totals.inferenceCostRaw, beforeFailureAccounting.totals.borrowingFeeRaw, beforeFailureAccounting.totals.startupCapitalRaw, beforeFailureAccounting.totals.gameSubsidyRaw], ["600000", "360000", "13800", "40000", "0"]);
  assert.equal(await cash(), "266200");
  report.accountingBeforeFailure = beforeFailureAccounting; report.predicates.realCreditExecutionSettlementRepayment = true; report.predicates.earningsFundNextTaskWithCreditDisabledAndZeroTopups = true;
  const profitableAdvice = await advisoryRead("after-three-settled-tasks");
  assert.equal(profitableAdvice.cash.cashRaw, "266200");
  assert.equal(profitableAdvice.cash.spendableCashRaw, "146200");
  assert.ok(profitableAdvice.history.entries.some(entry => entry.outcome === "succeeded" && entry.prediction !== null && entry.executionCostDeviationRaw === "0"));
  assert.equal(profitableAdvice.recommendation.status, "preview");
  assert.equal(profitableAdvice.recommendation.taskId, "9001");

  stage("retaining a paid hidden test failure");
  const failedRequest = input("task"), beforeFailed = await snapshot(); failedRequest.agent.allowCredit = false;
  // This passes the public balanced-brackets sample and fails independent hidden tests.
  fx.queue("print('true')\n"); const failed = await execute(failedRequest, forTask(4));
  assert.equal(failed.phase, "Failed"); assert.equal(failed.reason, "ARENA_TASK_FAILED"); assert.equal(failed.chargedRaw, "120000"); assert.equal(failed.settlement!.passed, false);
  assert.equal(failed.fromCreditRaw, "0"); assert.equal(BigInt(await cash()), BigInt(beforeFailed.cashRaw) - 120000n);
  const afterFailedAccounting = await accounting(), failedEntry = afterFailedAccounting.entries.find(entry => entry.requestId === failedRequest.run.requestId)!;
  assert.equal(afterFailedAccounting.status, "complete"); assert.equal(failedEntry.inferenceCostRaw, "120000"); assert.equal(failedEntry.taskRevenueRaw, "0");
  report.scenarios.push({ name: "paid-hidden-test-failure", requestId: failedRequest.run.requestId, taskId: failed.taskId, before: beforeFailed, after: await snapshot(),
    phase: failed.phase, reason: failed.reason, chargedRaw: failed.chargedRaw, taskRevenueRaw: failedEntry.taskRevenueRaw, borrowingFeeRaw: failedEntry.borrowingFeeRaw,
    payment: await receipt(failed.paymentTxHash, f.account, "ProviderPaid"), settlement: await receipt(failed.settlement!.txHash, f.escrow, "TaskSettled") });
  await remember(failedRequest, "failed"); report.predicates.failedCostRetainedWithoutInventedIncome = true;
  const failedAdvice = await advisoryRead("after-paid-failure");
  assert.equal(failedAdvice.cash.cashRaw, "146200");
  assert.equal(failedAdvice.cash.spendableCashRaw, "26200");
  assert.equal(failedAdvice.history.entries.find(entry => entry.requestId === failedRequest.run.requestId)?.realized.failureLossRaw, "120000");
  assert.ok(failedAdvice.candidates.every(candidate => candidate.status !== "eligible"));

  stage("resuming the original unknown payment");
  const unknownRequest = input("task"); unknownRequest.agent.allowCredit = false;
  fx.queue("unknown"); const unknownConfig = forTask(5), unknown = await execute(unknownRequest, unknownConfig);
  assert.equal(unknown.phase, "Paused"); assert.equal(unknown.reason, "SOLVE_DISPATCH_UNKNOWN"); assert.equal(unknown.chargedRaw, "120000");
  const beforeRecovery = await snapshot(), originalSession = JSON.parse(await readFile(join(unknownRequest.directory, "task-executor/workflow/session.json"), "utf8"));
  const pendingAccounting = await accounting(); assert.equal(pendingAccounting.status, "partial"); assert.equal(pendingAccounting.totals.netOperatingRaw, null);
  const unknownAdvice = await advisoryRead("while-original-payment-is-unknown");
  assert.equal(unknownAdvice.recommendation.status, "blocked");
  assert.equal(unknownAdvice.cash.unresolvedLiabilities, true);
  assert.equal(unknownAdvice.history.netOperatingRaw, null);
  const recovered = await execute({ ...unknownRequest, recover: true }, unknownConfig); assert.equal(recovered.phase, "Paused"); assert.equal(recovered.paymentId, unknown.paymentId);
  assert.deepEqual(await snapshot(), beforeRecovery);
  const resumedSession = JSON.parse(await readFile(join(unknownRequest.directory, "task-executor/workflow/session.json"), "utf8"));
  assert.equal(resumedSession.accept.rawTransaction, originalSession.accept.rawTransaction); assert.equal(resumedSession.handle.submission.rawTransaction, originalSession.handle.submission.rawTransaction);
  const unknownEntry = { name: "unknown-original-request-recovery", requestId: unknownRequest.run.requestId, taskId: unknown.taskId, paymentId: unknown.paymentId,
    phaseBefore: unknown.phase, phaseAfter: recovered.phase, reason: recovered.reason, chargedRaw: recovered.chargedRaw, beforeRecovery, afterRecovery: await snapshot(),
    pendingAccountingStatus: pendingAccounting.status, pendingNetOperatingRaw: pendingAccounting.totals.netOperatingRaw,
    originalAcceptBytesSha256: sha(originalSession.accept.rawTransaction), originalPaymentBytesSha256: sha(originalSession.handle.submission.rawTransaction),
    payment: await receipt(unknown.paymentTxHash, f.account, "ProviderPaid") };
  report.scenarios.push(unknownEntry); report.predicates.unknownResumeUsesOriginalBytesWithoutDuplicatePaymentOrDispatch = true;
  stage("refunding the original unknown payment");
  const refundId = "0x" + sha("economic-loop-original-full-refund");
  const refund = await fx.refunder.refund(unknown.paymentId!, refundId, "120000");
  const refunded = await execute({ ...unknownRequest, recover: true }, unknownConfig); assert.equal(refunded.phase, "Refunded"); assert.equal(refunded.chargedRaw, "0"); assert.equal(refunded.refundedRaw, "120000");
  assert.equal((await snapshot()).agentNonce, beforeRecovery.agentNonce); assert.equal(fx.calls.length, beforeRecovery.modelCalls);
  assert.equal(await cash(), "146200");
  report.scenarios.push({ name: "original-unknown-full-refund", requestId: unknownRequest.run.requestId, paymentId: unknown.paymentId, phase: refunded.phase,
    chargedRaw: refunded.chargedRaw, refundedRaw: refunded.refundedRaw, after: await snapshot(), taskIsNotSuccessful: true, refund: await receipt(refund.txHash, f.manager, "RefundProcessed") });
  await remember(unknownRequest, "unknown-refunded");
  report.accounting = await accounting(); assert.equal(report.accounting.status, "complete");
  assert.deepEqual([report.accounting.totals.taskRevenueRaw, report.accounting.totals.inferenceCostRaw, report.accounting.totals.borrowingFeeRaw, report.accounting.totals.netOperatingRaw,
    report.accounting.totals.startupCapitalRaw, report.accounting.totals.ownerCapitalRaw, report.accounting.totals.gameSubsidyRaw], ["600000", "480000", "13800", "106200", "40000", "0", "0"]);
  assert.equal(BigInt(await cash()), BigInt(report.accounting.totals.startupCapitalRaw) + BigInt(report.accounting.totals.netOperatingRaw));
  assert.equal(report.accounting.entries.find((entry: any) => entry.requestId === failedRequest.run.requestId).inferenceCostRaw, "120000");
  report.predicates.incomeCostCapitalAndSubsidySeparated = true; report.predicates.cashReconcilesToCapitalPlusOperatingResult = true;
  const refundedAdvice = await advisoryRead("after-original-full-refund");
  assert.equal(refundedAdvice.history.netOperatingRaw, "106200");
  assert.equal(refundedAdvice.cash.unresolvedLiabilities, false);
  report.predicates.readOnlyStrategyAdvicePreservesHistoryCashNonceAndModelCalls = true;
  report.predicates.strategyAdviceRetainsPaidFailureAndBlocksUnknown = true;
  report.predicates.roleAccountsReconcileSupplierReceiptsAndRefunds = true;
  report.predicates.readOnlyRunwaySeparatesActualResultsFromAssumptions = true;
  const lastNonce = await f.provider.getTransactionCount(wallet.address), lastCalls = fx.calls.length;
  assert.deepEqual(await execute({ ...unknownRequest, recover: true }, unknownConfig), refunded);
  assert.equal(await f.provider.getTransactionCount(wallet.address), lastNonce); assert.equal(fx.calls.length, lastCalls);
  const allPaymentEvents = await f.account.queryFilter(f.account.filters.ProviderPaid(), 0, "latest");
  const ownPaymentEvents = allPaymentEvents.filter(event => "args" in event && String(event.args.agentId) === agent.binding!.agentId);
  assert.equal(ownPaymentEvents.length, 5); // Three successes, one failed deliverable, one refunded unknown.
  report.chain = { contracts: { identity: await f.identity.getAddress(), asset: await f.token!.getAddress(), manager: await f.manager.getAddress(), account: await f.account.getAddress(), escrow: await f.escrow.getAddress() },
    latestBlock: await f.provider.getBlockNumber(), providerPaidEventCount: ownPaymentEvents.length, finalAgentCashRaw: await cash(), providerNetReceivedRaw: String(await f.providerBalance()) };
  assert.equal(report.chain.providerNetReceivedRaw, "480000");
  report.journalSha256 = ledgerHashes;
  report.artifactSha256 = {};
  for (const name of ["AgentAccount", "CreditManager", "TaskEscrow", "ERC8004Adapter", "MockERC20", "MockIdentityRegistry"]) report.artifactSha256[name] = sha(await readFile(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url)));
  // No export of private journals, endpoint URLs, code responses or signed bytes.
  const publicText = JSON.stringify(report);
  for (const secret of [key(1), key(2), key(3), key(4), key(20), fx.local.rpc, fx.options.arenaUrl!, fx.options.underwriterUrl!, fx.config.providers[0].relayUrl, originalSession.accept.rawTransaction, originalSession.handle.submission.rawTransaction]) assert.equal(publicText.includes(secret), false);
  assert.deepEqual(await strategySourceHashes(), report.strategySourceSha256, "advisory sources must remain stable during acceptance");
  assert.deepEqual(await operatingSourceHashes(), report.operatingSourceSha256, "operating sources must remain stable during acceptance");
  report.status = "passed";
} catch (error) {
  report.error = error instanceof assert.AssertionError ? "ASSERTION_FAILED" : /^[A-Z][A-Z0-9_]+$/.test((error as Error).message) ? (error as Error).message : "LOCAL_ECONOMIC_LOOP_FAILED";
  if (error instanceof assert.AssertionError) report.assertion = { operator: error.operator, location: error.stack?.split("\n").find(line => line.includes("economic-loop-local.ts"))?.trim() };
  process.exitCode = 1;
} finally {
  if (fx) { stage("stopping owned local services"); await fx.close(); }
  report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - Date.parse(startedAt);
  await writeFile(reportPath, JSON.stringify(report), { mode: 0o600, flag: "wx" });
}
