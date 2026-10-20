import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir, realpath, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { Contract, Wallet } from "ethers";
import { canonical, paymentId, requestDigest, sameAddress, type ChatInput, type Json, type Quote } from "../packages/sdk/src/protocol.js";
import { createWorkflowFixture, GOOD_CODE } from "../packages/pi-loop/test/workflow-fixture.js";
import { publicSampleFor } from "../packages/pi-loop/src/public-sample.js";
import type { WorkflowConfig } from "../packages/pi-loop/src/workflow.js";
import { key, read, tx } from "../services/underwriter/test/fixture.js";
import { HostedTaskExecutor, type HostedTaskExecutorConfig } from "../services/hosted-agents/src/task-executor.js";
import { readHostedAccounting } from "../services/hosted-agents/src/accounting.js";
import { readHostedStrategyAdvice } from "../services/hosted-agents/src/strategy-history.js";
import type { HostedAgent, HostedExecution, HostedResult, HostedRun, HostedStrategy } from "../services/hosted-agents/src/types.js";
import { candidateHash, decideLocal, freezePolicy, policyHash, preflightLocal, type LocalCandidate, type LocalDecisionInput } from "./lib/bounded-economy-policy.js";

const [directoryArg, reportPath, mode] = process.argv.slice(2);
if (!directoryArg || !reportPath || !isAbsolute(directoryArg) || !isAbsolute(reportPath) || !["shadow", "execute-local"].includes(mode)) throw Error("USE_CHECK_BOUNDED_ECONOMY_LAUNCHER");
const directory = await realpath(directoryArg), startedAt = new Date().toISOString(), startedAtMs = Date.now();
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");
const hash = (value: unknown) => sha(canonical(JSON.parse(JSON.stringify(value)) as Json));
const stage = (message: string) => process.stderr.write(`bounded-economy: ${message}\n`);
const policy = freezePolicy({ version: 1, id: "bounded-local-cash-v1", chainId: "31337", maxTasks: 4, totalSpendRaw: "480000", maxPaymentRaw: "120000", reserveCashRaw: "120000", minProfitRaw: "20000", minMarginBps: "1000", coldStartCushionRaw: "60000", coldStartMaxPriceRaw: "120000", maxObservationAgeMs: 10000, startedAtMs, deadlineMs: startedAtMs + 240000, allowedProviderIds: ["trusted-fixed"] });
// This is a trusted task catalog, not a task sequence. The controller sees every
// still-open task each round and orders it by observed economics and history.
const definitions = [
  { problemId: "sum-integers" as const, reward: 335000n, open: true, agentId: null },
  { problemId: "balanced-brackets" as const, reward: 325000n, open: true, agentId: null },
  { problemId: "sum-integers" as const, reward: 330000n, open: true, agentId: null },
  { problemId: "balanced-brackets" as const, reward: 340000n, open: true, agentId: null },
  { problemId: "balanced-brackets" as const, reward: 330000n, open: true, agentId: null },
  { problemId: "sum-integers" as const, reward: 100000n, open: true, agentId: null },
  { problemId: "sum-integers" as const, reward: 360000n, open: true, agentId: null },
];
const sourcePaths = ["scripts/lib/bounded-economy-policy.ts", "scripts/bounded-economy-local.ts", "scripts/check-bounded-economy.mjs", "services/hosted-agents/src/task-executor.ts", "services/hosted-agents/src/accounting.ts", "services/hosted-agents/src/strategy-history.ts", "services/hosted-agents/src/strategy-advice.ts", "services/hosted-agents/src/strategy-types.ts", "services/hosted-agents/src/finance-projection.ts", "services/hosted-agents/src/finance-reader.ts", "packages/pi-loop/src/workflow.ts", "packages/pi-loop/src/selector.ts", "packages/pi-loop/src/economics.ts", "packages/pi-loop/test/workflow-fixture.ts", "services/provider-relay/src/fixed-price.ts", "services/provider-relay/src/relay.ts", "services/arena/src/settler-main.ts"];
const sources = async () => Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha(await readFile(new URL(`../${path}`, import.meta.url)))])));
let fx: Awaited<ReturnType<typeof createWorkflowFixture>> | undefined;
const report: Record<string, any> = { version: 1, suite: "local-bounded-economy", mode, status: "failed", startedAt,
  provenance: { chainId: "31337", environment: "owned-local-anvil", settlementAsset: "six-decimal-mock-USDC", model: "controlled-response-injection", evaluation: "real-pinned-Docker-public-and-hidden-tests", settlement: "independent-Arena-settler-process", controller: "bounded-deterministic-local-cash-only" },
  scope: { productionNetworkUsed: false, publicVendorCalls: false, autonomousPlannerExercised: false, creditOptionsExercised: false, nativeGasValuedInUSDC: false,
    limitations: ["Fixture setup deploys and funds local mock contracts before the measured shadow window.", "Trusted task catalog and allowlisted loopback provider; no permissionless market or LLM planning.", "Controlled delivery responses and Unknown fault; payments, hidden Docker verdicts and settlement are real local observations.", "Cash-only policy; borrowing alternatives, native gas valuation and success probabilities are not covered.",
      "The owned local wallet has one writer; preflight does not establish a concurrent production reserve guard.",
      "Recovery creates a new executor from durable intent in the same worker process; OS-process restart recovery is not exercised.", "No-comparable-history routes use an explicit fixed cold-start cushion and price cap, not a calibrated risk estimate."] },
  policy, policySha256: policyHash(policy), publishedTasks: [], rounds: [], predicates: {} };
try {
  report.sourceSha256 = await sources();
  stage("starting owned local services"); fx = await createWorkflowFixture(join(directory, "runtime"), definitions);
  const f = fx.f, provider = fx.config.providers[0], route = provider.routes[0];
  const endpoints = [fx.local.rpc, fx.options.arenaUrl!, fx.options.underwriterUrl!, provider.relayUrl];
  for (const endpoint of endpoints) { const u = new URL(endpoint); assert.equal(u.hostname, "127.0.0.1"); assert.equal(u.protocol, "http:"); assert.equal(u.username + u.password + u.search + u.hash, ""); }
  assert.equal(String((await f.provider.getNetwork()).chainId), "31337");
  const guardianKeyFile = join(directory, "guardian.key"), rpcUrlFile = join(directory, "rpc-url"), keyFile = join(directory, "actor.key");
  await writeFile(guardianKeyFile, key(1), { mode: 0o600 }); await writeFile(rpcUrlFile, fx.local.rpc, { mode: 0o600 }); await writeFile(keyFile, key(20), { mode: 0o600 });
  const template = structuredClone(fx.config); template.deadlineMs = policy.deadlineMs; template.allowCredit = false;
  const templates = Object.fromEntries(["conservative", "balanced", "aggressive"].map(strategy => [strategy, structuredClone(template)])) as Record<HostedStrategy, WorkflowConfig>;
  const config: HostedTaskExecutorConfig = { version: 1, identity: await f.identity.getAddress(), guardianKeyFile, initialCashRaw: "600000", rpcUrlFile, rpcTransport: "direct", publicRpcUrl: fx.local.rpc,
    walletDirectory: join(directory, "wallets"), arenaUrl: fx.options.arenaUrl!, underwriterUrl: fx.options.underwriterUrl!, timeoutMs: 5000, pollTimeoutMs: 30000,
    models: [{ id: "cheap", physicalModels: { cheap: "controlled-cheap", strong: "controlled-strong" }, templates }] };
  const now = new Date().toISOString(), wallet = new Wallet(key(20));
  let agent: HostedAgent = { id: randomUUID(), owner: new Wallet(key(60)).address, wallet: wallet.address, name: "Bounded local economy", modelId: "cheap", strategy: "balanced", perRunBudgetRaw: policy.maxPaymentRaw, totalBudgetRaw: policy.totalSpendRaw,
    allowCredit: false, createdAt: now, updatedAt: now, status: "Pending", spentRaw: "0", reservedRaw: "0" };
  const runs: HostedRun[] = [];
  let quoteCalls = 0;
  // Test-only fixed-service adapter reuses the genuine, persisted first quote for
  // identical requests. The existing executor therefore pays the exact quote
  // discovered by the controller, with no changes to its payment/recovery code.
  const quoteOriginal = fx.relay.quote.bind(fx.relay), quoteCache = new Map<string, Quote>();
  fx.relay.quote = async input => { quoteCalls++; const digest = requestDigest(input), cached = quoteCache.get(digest); if (cached) { fx!.relay.validate(input); return structuredClone(cached); }
    const quote = await quoteOriginal(input); quoteCache.set(digest, structuredClone(quote)); return quote; };
  const cash = async (id = agent.binding!.agentId) => String(await read(f.account, "cash", [id]));
  const snapshot = async (id: string, actor: string) => ({ cashRaw: await cash(id), walletTokenRaw: String(await read(f.token!, "balanceOf", [actor])), providerTokenRaw: String(await f.providerBalance()),
    agentNonce: await f.provider.getTransactionCount(actor), paymentEvents: (await f.account.queryFilter(f.account.filters.ProviderPaid(), 0, "latest")).length, modelCalls: fx!.calls.length });
  const receipt = async (txHash: string | undefined, contract?: Contract, eventName?: string) => {
    assert.ok(txHash); const r = await f.provider.getTransactionReceipt(txHash); assert.ok(r); assert.equal(r.status, 1);
    const events = contract && eventName ? r.logs.filter(log => sameAddress(log.address, String(contract.target))).map(log => { try { return contract.interface.parseLog(log); } catch { return null; } }).filter(e => e?.name === eventName) : [];
    if (eventName) assert.equal(events.length, 1);
    const values = events[0] ? Object.fromEntries(events[0].fragment.inputs.map((p, i) => [p.name, typeof events[0]!.args[i] === "bigint" ? String(events[0]!.args[i]) : events[0]!.args[i]])) : undefined;
    return { txHash: r.hash, blockHash: r.blockHash, blockNumber: r.blockNumber, status: r.status, ...(eventName ? { event: eventName, eventCount: events.length, values } : {}) };
  };
  const routeBinding = hash({ domain: { chainId: template.chainId, account: template.account.toLowerCase(), asset: template.asset.toLowerCase(), escrowAddress: template.escrowAddress.toLowerCase() }, provider: { ...provider, routes: [route] }, physicalModels: config.models[0].physicalModels, modelId: "cheap", funding: "cash" });
  const publishedEvents = await f.escrow.queryFilter(f.escrow.filters.TaskCreated(), 0, "latest");
  for (const task of template.tasks) {
    const state = await read(f.escrow, "getTask", [task.taskId]); assert.equal(state.status, 1n); assert.equal(state.reward, state.escrowBalance);
    const event = publishedEvents.find(e => "args" in e && String(e.args.taskId) === task.taskId); assert.ok(event);
    report.publishedTasks.push({ taskId: task.taskId, problemId: task.problemId, rewardRaw: String(state.reward), fundedEscrowRaw: String(state.escrowBalance), creation: await receipt(event.transactionHash, f.escrow, "TaskCreated") });
  }
  const inputBody = (task: WorkflowConfig["tasks"][number], agentId: string): ChatInput => ({ agentId, taskId: task.taskId, service: provider.service, model: provider.model, messages: [{ role: "user", content: publicSampleFor(task.problemId).prompt }], solve: { ...route.solve, problemId: task.problemId, deadlineMs: policy.deadlineMs } });
  const observe = async (agentId: string): Promise<LocalCandidate[]> => {
    const block = (await f.provider.getBlock("latest"))!, out: LocalCandidate[] = [];
    for (const task of template.tasks) {
      const state = await f.escrow.getFunction("getTask").staticCall(task.taskId, { blockTag: block.number });
      if (state.status !== 1n) continue;
      const body = inputBody(task, agentId), response = await fetch(provider.relayUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(5000), redirect: "error" });
      assert.equal(response.status, 402); const { quote } = await response.json() as { quote: Quote };
      assert.equal(quote.chainId, "31337"); assert.equal(quote.agentId, agentId); assert.equal(quote.taskId, task.taskId); assert.equal(quote.requestDigest, requestDigest(body));
      assert.equal(quote.paymentId, paymentId(quote.taskId, quote.requestDigest, quote.serverNonce));
      for (const [actual, expected] of [[quote.account, template.account], [quote.asset, template.asset], [quote.payTo, provider.payTo]]) assert.ok(sameAddress(actual, expected));
      assert.equal(quote.service, provider.service); assert.equal(quote.model, provider.model); assert.equal(quote.tier, undefined); assert.equal(quote.price, route.price);
      assert.ok(quote.createdBlock <= block.number); assert.ok(Number(quote.quoteExpiry) * 1000 > Date.now());
      out.push({ source: "local-chain-and-provider-quote", taskId: task.taskId, problemId: task.problemId, providerId: provider.id, tier: route.tier as "cheap", routeBinding,
        rewardRaw: String(state.reward), escrowBalanceRaw: String(state.escrowBalance), protocolFeeBps: String(state.protocolFeeBps), taskStatus: String(state.status), deadlineMs: Number(state.deadline) * 1000,
        observedAtMs: Date.now(), blockNumber: block.number, blockHash: block.hash!, quote: { priceRaw: quote.price, paymentId: quote.paymentId, requestDigest: quote.requestDigest, expiresAtMs: Number(quote.quoteExpiry) * 1000 } });
    }
    return out;
  };
  stage("observing funded tasks without business execution");
  const shadowBefore = await snapshot("1", f.agentAddress), quoteCallsBefore = quoteCalls;
  const shadowCandidates = await observe("1"), shadowInput: LocalDecisionInput = { policy, nowMs: Date.now(), cashRaw: shadowBefore.cashRaw, debtRaw: "0", spentRaw: "0", completedTasks: 0, unresolved: false, candidates: shadowCandidates, history: [] };
  const shadowDecision = decideLocal(shadowInput), shadowAfter = await snapshot("1", f.agentAddress); assert.deepEqual(shadowAfter, shadowBefore);
  assert.equal(shadowDecision.stopReason, "CASH_RESERVE");
  report.shadow = { setupTransactionsExcluded: true, before: shadowBefore, after: shadowAfter, quoteCallsBefore, quoteCallsAfter: quoteCalls, candidates: shadowCandidates, decisionAtMs: shadowInput.nowMs, decision: shadowDecision };
  report.predicates.shadowKeepsNoncePaymentsCashAndModelCallsUnchanged = true;
  report.predicates.actualCashShortfallStopsNewPayment = true;
  report.predicates.candidatesUseFundedChainStateAndGenuineProviderQuotes = true;
  if (mode === "execute-local") {
    stage("provisioning explicit local execution");
    await f.provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]); f.admin.reset();
    const mint = await tx(f.token!, f.admin, "mint", [wallet.address, 600000n]);
    const request = (action: "provision" | "task", reservedRaw = "0"): HostedExecution => { const requestId = randomUUID(); return { agent: structuredClone(agent), run: { requestId, agentId: agent.id, action, status: "Queued", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), reservedRaw, chargedRaw: "0", recoverable: false }, directory: join(directory, "agents", agent.id, "runs", requestId), keyFile, recover: false, deadlineMs: policy.deadlineMs }; };
    const execute = async (input: HostedExecution, selectedConfig = config) => {
      const result = await new HostedTaskExecutor(selectedConfig, { provider: f.provider }).execute(input);
      const run: HostedRun = { ...input.run, status: result.terminal ? result.success ? "Succeeded" : "Failed" : "Paused", chargedRaw: result.chargedRaw, result, updatedAt: new Date().toISOString(), recoverable: !result.terminal };
      const i = runs.findIndex(r => r.requestId === run.requestId); if (i < 0) runs.push(run); else runs[i] = run;
      agent.spentRaw = String(runs.reduce((v, r) => v + BigInt(r.chargedRaw), 0n)); return result;
    };
    const provision = await execute(request("provision")); assert.equal(provision.phase, "Ready"); agent.binding = provision.binding; agent.status = "Ready";
    assert.equal(await cash(), "600000");
    report.initialFunding = { startupCapitalRaw: "600000", ownerTopupsAfterProvisionRaw: "0", gameSubsidyRaw: "0", taskPublisherFundedRewardsRaw: String(definitions.reduce((n, d) => n + d.reward, 0n)), mint: await receipt(mint.hash), initialAgentId: agent.binding!.agentId };
    await writeFile(join(directory, "frozen-policy.json"), JSON.stringify({ policy, sha256: policyHash(policy) }), { flag: "wx", mode: 0o600 });
    const historyDigest = async () => {
      const entries: [string, string][] = [];
      const walk = async (path: string) => { for (const entry of (await readdir(path, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) { assert.equal(entry.isSymbolicLink(), false); const p = join(path, entry.name); if (entry.isDirectory()) await walk(p); else if (entry.isFile()) entries.push([p.slice(directory.length), sha(await readFile(p))]); } };
      await walk(join(directory, "agents", agent.id)); return hash(entries);
    };
    const historical = async () => {
      const before = { ...await snapshot(agent.binding!.agentId, wallet.address), historySha256: await historyDigest(), inputSha256: hash({ agent, runs }) };
      const finance = await new HostedTaskExecutor(config, { provider: f.provider }).finance(agent); assert.equal(finance.status, "confirmed");
      const advice = await readHostedStrategyAdvice({ directory, agent, runs, finance });
      const accounting = await readHostedAccounting({ directory, agent, runs });
      const after = { ...await snapshot(agent.binding!.agentId, wallet.address), historySha256: await historyDigest(), inputSha256: hash({ agent, runs }) }; assert.deepEqual(after, before);
      assert.ok(advice.history.entries.every(h => !h.prediction || h.prediction.routeBinding === routeBinding));
      return { finance, history: advice.history, accounting, readOnly: { before, after } };
    };
    const decisionInput = async (candidates: LocalCandidate[], evidence: Awaited<ReturnType<typeof historical>>): Promise<LocalDecisionInput> => {
      assert.equal(evidence.finance.status, "confirmed");
      return { policy, nowMs: Date.now(), cashRaw: evidence.finance.status === "confirmed" ? evidence.finance.cashRaw : "0", debtRaw: evidence.finance.status === "confirmed" ? evidence.finance.debtRaw : "0", spentRaw: agent.spentRaw,
        completedTasks: runs.filter(r => r.action === "task").length, unresolved: evidence.accounting.status !== "complete" || evidence.history.gaps.length > 0, candidates, history: evidence.history.entries };
    };
    stage("rejecting actual task state drift before payment");
    const probeEvidence = await historical(), probeCandidates = await observe(agent.binding!.agentId), probeValues = await decisionInput(probeCandidates, probeEvidence), probeDecision = decideLocal(probeValues);
    assert.equal(probeDecision.status, "selected");
    const probeSelected = probeCandidates.find(c => c.taskId === probeDecision.selectedTaskId)!;
    assert.equal(probeSelected.rewardRaw, "360000");
    const probeBefore = await snapshot(agent.binding!.agentId, wallet.address);
    f.agent.reset(); const competingAcceptance = await tx(f.escrow, f.agent, "acceptTask", [probeSelected.taskId, "1"]);
    const probeFresh = await observe(agent.binding!.agentId), probeFreshEvidence = await historical(), probeFreshValues = await decisionInput(probeFresh, probeFreshEvidence);
    assert.equal(String((await read(f.escrow, "getTask", [probeSelected.taskId])).status), "2");
    assert.throws(() => preflightLocal({ ...probeFreshValues, decision: probeDecision }), /SELECTED_BINDING_CHANGED/);
    const probeAfter = await snapshot(agent.binding!.agentId, wallet.address); assert.deepEqual(probeAfter, probeBefore);
    report.taskStateDriftProbe = { before: probeBefore, candidates: probeCandidates, decisionAtMs: probeValues.nowMs, freshDecisionAtMs: probeFreshValues.nowMs, decision: probeDecision,
      competingAcceptance: await receipt(competingAcceptance.hash, f.escrow, "TaskAccepted"), after: probeAfter, blockedCode: "SELECTED_BINDING_CHANGED", freshCandidates: probeFresh };
    report.predicates.actualTaskStateDriftStopsBeforePayment = true;
    let unknown: { input: HostedExecution; result: HostedResult; selectedConfig: HostedTaskExecutorConfig } | undefined;
    let previous: any;
    for (;;) {
      const evidence = await historical(), candidates = await observe(agent.binding!.agentId), values = await decisionInput(candidates, evidence), decision = decideLocal(values);
      const reversed = decideLocal({ ...values, candidates: [...candidates].reverse() }), rotated = decideLocal({ ...values, candidates: [...candidates.slice(2), ...candidates.slice(0, 2)] });
      assert.equal(reversed.selectedTaskId, decision.selectedTaskId); assert.equal(rotated.selectedTaskId, decision.selectedTaskId);
      const withoutFailures = decideLocal({ ...values, history: values.history.filter(h => h.outcome !== "failed") });
      const withoutSuccesses = decideLocal({ ...values, history: values.history.filter(h => h.outcome !== "succeeded") });
      if (previous) previous.nextChoice = { selectedTaskId: decision.selectedTaskId ?? null, stopReason: decision.stopReason ?? null, policyHash: decision.policyHash };
      if (decision.status === "stopped") {
        const before = await snapshot(agent.binding!.agentId, wallet.address), after = await snapshot(agent.binding!.agentId, wallet.address); assert.deepEqual(before, after);
        report.stop = { reason: decision.stopReason, decisionAtMs: values.nowMs, decision, before, after }; break;
      }
      const round = report.rounds.length + 1, selected = candidates.find(c => c.taskId === decision.selectedTaskId)!;
      const statusResponse = await fetch(`${new URL(provider.relayUrl).origin}/payments/${selected.quote.paymentId}?agentId=${agent.binding!.agentId}&requestDigest=${selected.quote.requestDigest}`, { signal: AbortSignal.timeout(5000), redirect: "error" });
      assert.equal(statusResponse.status, 200); const status = await statusResponse.json() as { state: string; paymentId: string }; assert.equal(status.state, "Quoted"); assert.equal(status.paymentId, selected.quote.paymentId);
      const original = await fx.relay.record(selected.quote.paymentId, agent.binding!.agentId, selected.quote.requestDigest); assert.equal(original.quote.price, selected.quote.priceRaw);
      assert.equal(original.quote.paymentId, selected.quote.paymentId); assert.equal(original.quote.requestDigest, selected.quote.requestDigest);
      const freshEvidence = await historical(), fresh = await observe(agent.binding!.agentId), freshValues = await decisionInput(fresh, freshEvidence);
      preflightLocal({ ...freshValues, decision });
      const chosenTask = template.tasks.find(task => task.taskId === selected.taskId)!;
      const selectedConfig = structuredClone(config); for (const m of selectedConfig.models) for (const w of Object.values(m.templates)) { w.tasks = [structuredClone(chosenTask)]; w.maxPrice = selected.quote.priceRaw; w.providers = [structuredClone(provider)]; }
      const input = request("task", selected.quote.priceRaw);
      // Durable intent precedes task acceptance, purchase, model dispatch or settlement.
      await writeFile(join(directory, `decision-${round}.json`), JSON.stringify({ version: 1, state: "pending", policy, policySha256: policyHash(policy), decision, selected, requestId: input.run.requestId, request: input }), { mode: 0o600, flag: "wx" });
      const before = await snapshot(agent.binding!.agentId, wallet.address);
      // Faults change delivery only. They never supply a task id to the controller.
      const selectedCohort = decision.candidates.find(c => c.taskId === selected.taskId)!;
      if (selected.problemId === "balanced-brackets" && selectedCohort.comparableCount > 0 && selectedCohort.failedComparableCount === 0) fx.queue("print('true')\n");
      else if (selected.problemId === "sum-integers" && selectedCohort.comparableCount > 0) fx.queue("unknown");
      else fx.queue(GOOD_CODE[chosenTask.problemId]);
      stage("executing selected local task");
      const result = await execute(input, selectedConfig), after = await snapshot(agent.binding!.agentId, wallet.address);
      await writeFile(join(directory, `completion-${round}.json`), JSON.stringify({ version: 1, requestId: input.run.requestId, terminal: result.terminal, result }), { mode: 0o600, flag: "wx" });
      assert.equal(result.taskId, selected.taskId); assert.equal(result.chargedRaw, selected.quote.priceRaw); assert.equal(result.paymentId, selected.quote.paymentId); assert.equal(result.fromCreditRaw, "0");
      assert.ok(BigInt(after.cashRaw) >= BigInt(policy.reserveCashRaw));
      const actuals = await historical();
      const entry = { round, candidates, decisionAtMs: values.nowMs, decision, counterfactual: { reversedSelectedTaskId: reversed.selectedTaskId, rotatedSelectedTaskId: rotated.selectedTaskId, withoutFailureSelectedTaskId: withoutFailures.selectedTaskId, withoutSuccessSelectedTaskId: withoutSuccesses.selectedTaskId },
        preflight: { freshDecisionAtMs: freshValues.nowMs, selectedCandidateHash: candidateHash(selected), freshCandidateHash: candidateHash(fresh.find(c => c.taskId === selected.taskId)!), quotedPaymentStatus: status.state }, before,
        execution: { requestId: input.run.requestId, taskId: result.taskId, phase: result.phase, reason: result.reason ?? null, chargedRaw: result.chargedRaw, paymentId: result.paymentId,
          payment: await receipt(result.paymentTxHash, f.account, "ProviderPaid"), settlement: result.settlement ? await receipt(result.settlement.txHash, f.escrow, "TaskSettled") : null },
        after, actuals: { history: actuals.history, accountingStatus: actuals.accounting.status, totals: actuals.accounting.totals, readOnly: actuals.readOnly } };
      report.rounds.push(entry); previous = entry;
      if (!result.terminal) { assert.equal(result.phase, "Paused"); assert.equal(result.reason, "SOLVE_DISPATCH_UNKNOWN"); unknown = { input, result, selectedConfig }; }
    }
    assert.equal(report.rounds.length, 4); assert.equal(report.stop.reason, "UNRESOLVED_PAYMENT_OR_HISTORY"); assert.ok(unknown);
    assert.equal(report.rounds[0].execution.phase, "Succeeded"); assert.equal(report.rounds[1].execution.phase, "Failed"); assert.equal(report.rounds[2].execution.phase, "Succeeded"); assert.equal(report.rounds[3].execution.phase, "Paused");
    assert.equal(report.rounds[2].candidates.find((c: LocalCandidate) => c.taskId === report.rounds[2].counterfactual.withoutFailureSelectedTaskId).problemId, "balanced-brackets");
    assert.notEqual(report.rounds[2].decision.selectedTaskId, report.rounds[2].counterfactual.withoutFailureSelectedTaskId);
    assert.notEqual(report.rounds[1].decision.selectedTaskId, report.rounds[1].counterfactual.withoutSuccessSelectedTaskId);
    assert.equal(report.rounds[1].decision.candidates.find((c: any) => c.taskId === report.rounds[1].decision.selectedTaskId).coldStart, false);
    const originalSession = JSON.parse(await readFile(join(unknown.input.directory, "task-executor/workflow/session.json"), "utf8")), beforeRecovery = await snapshot(agent.binding!.agentId, wallet.address), beforeQuoteCalls = quoteCalls;
    const originalIntent = await readFile(join(directory, "decision-4.json")), changedPolicy = freezePolicy({ ...policy, id: "bounded-local-v2-recovery-probe", minProfitRaw: "1" });
    const unresolvedEvidence = await historical(), unresolvedCandidates = await observe(agent.binding!.agentId), unresolvedValues = await decisionInput(unresolvedCandidates, unresolvedEvidence);
    const changedPolicyDecision = decideLocal({ ...unresolvedValues, policy: changedPolicy }); assert.equal(changedPolicyDecision.stopReason, "UNRESOLVED_PAYMENT_OR_HISTORY");
    const changedConfig = structuredClone(config); for (const m of changedConfig.models) for (const w of Object.values(m.templates)) w.tasks.reverse();
    const persistedIntent = JSON.parse(originalIntent.toString("utf8")) as { policySha256: string; requestId: string; request: HostedExecution };
    const persistedCompletion = JSON.parse(await readFile(join(directory, "completion-4.json"), "utf8")) as { requestId: string; terminal: boolean; result: HostedResult };
    assert.equal(persistedIntent.policySha256, policyHash(policy)); assert.equal(persistedIntent.requestId, persistedCompletion.requestId); assert.equal(persistedCompletion.terminal, false);
    assert.equal(persistedCompletion.result.paymentId, unknown.result.paymentId); assert.equal(persistedIntent.request.run.requestId, persistedIntent.requestId);
    const recoveryQuoteCalls = quoteCalls, recovered = await execute({ ...persistedIntent.request, recover: true }, changedConfig);
    const afterRecovery = await snapshot(agent.binding!.agentId, wallet.address), resumed = JSON.parse(await readFile(join(unknown.input.directory, "task-executor/workflow/session.json"), "utf8"));
    assert.equal(recovered.phase, "Paused"); assert.equal(recovered.paymentId, unknown.result.paymentId); assert.deepEqual(afterRecovery, beforeRecovery); assert.equal(quoteCalls, recoveryQuoteCalls);
    assert.equal(resumed.accept.rawTransaction, originalSession.accept.rawTransaction); assert.equal(resumed.handle.submission.rawTransaction, originalSession.handle.submission.rawTransaction);
    assert.deepEqual(await readFile(join(directory, "decision-4.json")), originalIntent);
    report.unknownRecovery = { originalRequestId: unknown.input.run.requestId, paymentId: unknown.result.paymentId, originalPolicySha256: policyHash(policy), changedPolicySha256: policyHash(changedPolicy), changedPolicyDecisionAtMs: unresolvedValues.nowMs, changedPolicyDecision,
      originalIntentSha256: sha(originalIntent), originalAcceptBytesSha256: sha(originalSession.accept.rawTransaction), originalPaymentBytesSha256: sha(originalSession.handle.submission.rawTransaction), phaseBefore: unknown.result.phase, phaseAfter: recovered.phase,
      before: beforeRecovery, after: afterRecovery, quoteCallsBeforeRecovery: recoveryQuoteCalls, quoteCallsAfterRecovery: quoteCalls, observationsQuoteCalls: recoveryQuoteCalls - beforeQuoteCalls, policyChangeIgnoredByOriginalRecovery: true, recoveryTargetReconstructedFromDurableIntent: true, recoveryMode: "same-worker-new-executor-from-durable-intent" };
    const final = await historical(); assert.equal(final.accounting.status, "partial"); assert.equal(final.accounting.totals.taskRevenueRaw, "675000"); assert.equal(final.accounting.totals.inferenceCostRaw, "480000"); assert.equal(final.accounting.totals.netOperatingRaw, null);
    assert.equal(final.accounting.totals.startupCapitalRaw, "600000"); assert.equal(final.accounting.totals.ownerCapitalRaw, "0"); assert.equal(final.accounting.totals.gameSubsidyRaw, "0");
    assert.equal(final.history.entries.find(h => h.outcome === "failed")!.realized.failureLossRaw, "120000"); assert.equal(await cash(), "795000");
    const ownEvents = (await f.account.queryFilter(f.account.filters.ProviderPaid(), 0, "latest")).filter(e => "args" in e && String(e.args.agentId) === agent.binding!.agentId); assert.equal(ownEvents.length, 4);
    report.journalSha256 = {};
    for (let round = 1; round <= report.rounds.length; round++) {
      const requestId = report.rounds[round - 1].execution.requestId;
      for (const relative of [`decision-${round}.json`, `completion-${round}.json`, `agents/${agent.id}/runs/${requestId}/task-executor/session.json`, `agents/${agent.id}/runs/${requestId}/task-executor/workflow/session.json`]) report.journalSha256[relative.startsWith("agents/") ? `${requestId}/${relative.split("/task-executor/")[1]}` : relative] = sha(await readFile(join(directory, relative)));
    }
    report.chain = { contracts: { identity: String(f.identity.target), asset: String(f.token!.target), manager: String(f.manager.target), account: String(f.account.target), escrow: String(f.escrow.target) },
      latestBlock: await f.provider.getBlockNumber(), providerPaidEventCount: ownEvents.length, finalAgentCashRaw: await cash(), providerNetReceivedRaw: String(await f.providerBalance()) };
    report.predicates = { ...report.predicates, realSuccessFeedsNextDecision: true, paidFailureChangesNextChoice: true, inputOrderDoesNotControlSelection: true, exactQuoteAndTaskRevalidatedBeforeExecution: true,
      limitsFrozenBeforeNewPayment: true, unknownStopsNewPayment: true, originalUnknownRecoveryPreservesRequestAndSignedBytes: true, noOwnerTopupsOrGameSubsidy: true, actualsReadDoesNotMutateHistory: true };
    // Only hashes of private journals and signed bytes are exported.
    const publicText = JSON.stringify(report);
    for (const secret of [key(1), key(2), key(3), key(4), key(20), key(60), ...endpoints, originalSession.accept.rawTransaction, originalSession.handle.submission.rawTransaction]) assert.equal(publicText.includes(secret), false);
  }
  report.artifactSha256 = {};
  for (const name of ["AgentAccount", "CreditManager", "TaskEscrow", "ERC8004Adapter", "MockERC20", "MockIdentityRegistry"]) report.artifactSha256[name] = sha(await readFile(new URL(`../contracts/out/${name}.sol/${name}.json`, import.meta.url)));
  assert.deepEqual(await sources(), report.sourceSha256, "controller and reused sources must stay frozen during acceptance");
  report.status = "passed";
} catch (error) {
  report.error = error instanceof assert.AssertionError ? "ASSERTION_FAILED" : /^[A-Z][A-Z0-9_]+$/.test((error as Error).message) ? (error as Error).message : "LOCAL_BOUNDED_ECONOMY_FAILED";
  if (error instanceof assert.AssertionError) report.assertion = { operator: error.operator, location: error.stack?.split("\n").find(line => line.includes("bounded-economy-local.ts"))?.trim() };
  process.exitCode = 1;
} finally {
  if (fx) { stage("stopping owned local services"); await fx.close(); }
  report.completedAt = new Date().toISOString(); report.durationMs = Date.now() - Date.parse(startedAt);
  await writeFile(reportPath, JSON.stringify(report), { mode: 0o600, flag: "wx" });
}
