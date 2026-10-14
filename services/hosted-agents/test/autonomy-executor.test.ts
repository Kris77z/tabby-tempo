import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile, mkdir, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HostedAutonomyExecutor, validateHostedAutonomyConfig, openHostedPlannerConnection, createHostedPlannerRequest, reconcileHostedPlannerPayment, type HostedAutonomyConfig } from "../src/autonomy-executor.js";
import { keccak256, toUtf8Bytes, Wallet, type JsonRpcProvider } from "ethers";
import { accountInterface, managerInterface, EMPTY_AUTH, requestDigest, paymentId, canonical, type PaymentHandle, type Json } from "@agentfuel/sdk";
import {validateHostedActivity as importedValidate} from "../src/scene-types.js";
import type { AutonomyContext } from "../../../packages/pi-loop/src/autonomy.js";
import type { HostedExecution, HostedFinance } from "../src/types.js";
import type { HostedTaskExecutor } from "../src/task-executor.js";

const config: HostedAutonomyConfig = { maxTasks: 2, maxDecisions: 3, durationMs: 60000, plannerRelayUrl: "http://127.0.0.1:3010/v1/chat",
  plannerProvider: "0x1111111111111111111111111111111111111111", plannerPriceRaw: "10", plannerService: "planner", plannerModel: "cheap", plannerPhysicalModel: "physical-planner-v1" };
const finance: HostedFinance = { status: "confirmed", observedAt: new Date().toISOString(), chainId: "31337", agentId: "1", wallet: config.plannerProvider,
  block: { number: 1, hash: "0x01", timestamp: 1 }, cashRaw: "500", debtRaw: "20", scannedTaskCount: 2, ownedTaskCount: 0,
  credit: { score: "10", tier: "A", tierCapRaw: "500", feeBps: "100", eligible: true, rejection: null },
  policy: { maxCashPerTxRaw: "100", maxDebtPerTxRaw: "200", maxDebtPerDayRaw: "300", ownerFrozen: false },
  counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
function input(directory: string): HostedExecution { return { directory, keyFile: "/private/test-key", recover: false,
  agent: { id: "agent", owner: "owner", wallet: config.plannerProvider, name: "Agent", modelId: "cheap", strategy: "balanced", perRunBudgetRaw: "100", totalBudgetRaw: "500", allowCredit: true,
    spentRaw: "0", reservedRaw: "250", activeRequestId: "parent", status: "Ready", createdAt: "now", updatedAt: "now", binding: { chainId: "31337", agentId: "1", wallet: config.plannerProvider } },
  run: { requestId: "parent", agentId: "agent", action: "autonomous" as HostedExecution["run"]["action"], status: "Running", createdAt: "now", updatedAt: "now", reservedRaw: "250", chargedRaw: "0", recoverable: true } }; }
function task(execute: HostedTaskExecutor["execute"], read: () => Promise<HostedFinance> = async () => structuredClone(finance)) {
  const models = ["cheap", "strong"].map(id => ({ id, templates: { balanced: { tasks: [{ creditLimit: "200" }], providers: [{ routes: [{ solve: { tiers: [id] } }] }] } } }));
  return { config: { metered: { priceRaw: "80", creditsRaw: "200000", catalog: [
    { id: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
    { id: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" }] }, models }, finance: read, execute } as unknown as HostedTaskExecutor;
}
async function fixture(work: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), "af-hosted-autonomy-")); try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); } }

test("hosted autonomous run plans two sequential tasks with isolated budgets and durable snapshots", async () => fixture(async directory => {
  const children: HostedExecution[] = []; let plans = 0;
  const executor = new HostedAutonomyExecutor(task(async child => {
    children.push(structuredClone(child)); const state = JSON.parse(await readFile(join(directory, "autonomy-host", "session.json"), "utf8"));
    assert.equal(state.children[child.run.requestId].run.requestId, child.run.requestId);
    assert.equal(child.run.action, "metered-task"); assert.equal(child.agent.totalBudgetRaw, "500"); assert.equal(child.agent.spentRaw, children.length === 1 ? "30" : "110"); assert.equal(child.recover, false);
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "70" };
  }), config, { planner: async context => { plans++; assert.equal(context.observation.creditAvailableRaw, "180"); assert.equal(context.completedTasks, plans - 1);
    return { decision: { action: "run-task", modelId: plans === 1 ? "cheap" : "strong", funding: plans === 1 ? "credit" : "cash" }, chargedRaw: "10" }; } });
  const parent = input(directory); parent.agent.spentRaw = "20";
  const result = await executor.execute(parent);
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "160"); assert.equal((result as any).autonomousTasks, 2); assert.equal(result.success, true);
  assert.equal(children.length, 2); assert.notEqual(children[0].run.requestId, children[1].run.requestId); assert.equal(children[0].agent.allowCredit, true); assert.equal(children[1].agent.allowCredit, false);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), result); assert.equal(plans, 2); assert.equal(children.length, 2);
}));

test("hosted resume preserves original child snapshot and does not repeat planner or task", async () => fixture(async directory => {
  let plans = 0; const children: HostedExecution[] = [];
  const executor = new HostedAutonomyExecutor(task(async child => { children.push(child); return child.recover
    ? { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }
    : { phase: "Paused", terminal: false, success: false, chargedRaw: "30", reason: "INFERENCE_FUNDING_REQUIRED" }; }), { ...config, maxTasks: 1 },
    { planner: async () => { plans++; return { decision: { action: "run-task", modelId: "strong", funding: "credit" }, chargedRaw: "10" }; } });
  const parent = input(directory); const paused = await executor.execute(parent); assert.equal(paused.terminal, false); assert.equal(paused.chargedRaw, "40");
  const result = await executor.execute({ ...parent, recover: true, agent: { ...parent.agent, modelId: "cheap", perRunBudgetRaw: "90" } });
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90"); assert.equal(plans, 1); assert.equal(children.length, 2);
  assert.equal(children[1].run.requestId, children[0].run.requestId); assert.equal(children[1].agent.modelId, "strong"); assert.equal(children[1].agent.perRunBudgetRaw, "100");
}));

test("insufficient cash or total task budget stops before any paid planner or task", async t => {
  for (const reason of ["cash", "budget"] as const) await t.test(reason, async () => fixture(async directory => {
    const parent = input(directory); if (reason === "budget") parent.run.reservedRaw = "89";
    const executor = new HostedAutonomyExecutor(task(async () => { throw new Error("must not execute"); }, async () => ({ ...finance, cashRaw: reason === "cash" ? "0" : "500" })), config,
      { planner: async () => { throw new Error("must not plan"); } });
    const result = await executor.execute(parent); assert.equal(result.phase, "Stopped"); assert.equal(result.chargedRaw, "0"); assert.equal(result.reason, reason === "cash" ? "AUTONOMY_PLANNER_CASH_REQUIRED" : "AUTONOMY_TASK_BUDGET_REQUIRED");
  }));
});

test("unknown planner remains paused and unchanged on hosted recovery", async () => fixture(async directory => {
  let calls = 0; const executor = new HostedAutonomyExecutor(task(async () => { throw new Error("must not execute"); }), config, { planner: async () => { calls++; throw new Error("unknown dispatch"); } });
  const parent = input(directory); const first = await executor.execute(parent); assert.equal(first.reason, "AUTONOMY_DECISION_UNKNOWN"); assert.equal(first.terminal, false);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), first); assert.equal(calls, 1);
}));

test("model stop text stays private while public result uses a stable machine code", async () => fixture(async directory => {
  const reason = "当前任务不值得执行。模型建议等下一单，并保留所有资金。";
  const executor = new HostedAutonomyExecutor(task(async () => { throw new Error("must not execute"); }), config,
    { planner: async () => ({ decision: { action: "stop", reason }, chargedRaw: "10" }) });
  const result = await executor.execute(input(directory));
  assert.equal(result.terminal, true); assert.equal(result.success, true); assert.equal(result.reason, "AUTONOMY_MODEL_STOPPED");
  assert.match(result.reason!, /^[A-Z][A-Z0-9_]{0,100}$/); assert.equal(JSON.stringify(result).includes(reason), false);
}));

test("confirmed child refund reduces parent net charge and reaches a terminal result", async () => fixture(async directory => {
  let plans = 0;
  const executor = new HostedAutonomyExecutor(task(async child => child.recover
    ? { phase: "Refunded", terminal: true, success: false, chargedRaw: "0", refundedRaw: "80", reason: "SERVICE_UNDELIVERED_REFUNDED" }
    : { phase: "Paused", terminal: false, success: false, chargedRaw: "80", refundedRaw: "0", reason: "SERVICE_PENDING" }), config,
    { planner: async () => { plans++; return { decision: { action: "run-task", modelId: "cheap", funding: "credit" }, chargedRaw: "10" }; } });
  const parent = input(directory); assert.equal((await executor.execute(parent)).chargedRaw, "90");
  const result = await executor.execute({ ...parent, recover: true });
  assert.equal(result.terminal, true); assert.equal(result.success, false); assert.equal(result.chargedRaw, "10"); assert.equal(result.reason, "SERVICE_UNDELIVERED_REFUNDED"); assert.equal(plans, 1);
  assert.deepEqual(await executor.execute({ ...parent, recover: true }), result);
}));

test("planner configuration requires an explicit physical response model", () => {
  assert.equal(validateHostedAutonomyConfig(config).plannerPhysicalModel, "physical-planner-v1");
  for (const model of [undefined, "", "invalid physical model"]) assert.throws(() => validateHostedAutonomyConfig({ ...config, plannerPhysicalModel: model } as HostedAutonomyConfig), /HOSTED_AUTONOMY_CONFIG_INVALID/);
});

test("platform model IDs need not equal internal gateway route IDs", async () => fixture(async directory => {
  const adapter = task(async child => { assert.equal(child.agent.modelId, "kimi-k2.6"); return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }; });
  adapter.config.models = [{ ...adapter.config.models[0], id: "kimi-k2.6" }];
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1 }, { planner: async context => {
    assert.deepEqual(context.models, ["kimi-k2.6"]); return { decision: { action: "run-task", modelId: "kimi-k2.6", funding: "credit" }, chargedRaw: "10" };
  } });
  const result = await executor.execute(input(directory)); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90");
}));

test("pausing the hosted agent prevents the next child even when a planner response arrives", async () => fixture(async directory => {
  let allowed = true, calls = 0;
  const executor = new HostedAutonomyExecutor(task(async () => { calls++; throw new Error("must not execute"); }), config, {
    shouldContinue: async () => allowed,
    planner: async () => { allowed = false; return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" }; },
  });
  const result = await executor.execute(input(directory));
  assert.equal(result.terminal, true); assert.equal(result.reason, "HOSTED_AGENT_PAUSED"); assert.equal(result.chargedRaw, "10"); assert.equal(calls, 0);
}));

test("default planner connection discovers Anvil chain 31337 and releases its provider", async () => {
  const calls: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body.method);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0x7a69" : null }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const connection = await openHostedPlannerConnection(`http://127.0.0.1:${(server.address() as { port: number }).port}`, "31337", "direct");
  try {
    assert.equal((await connection.provider.getNetwork()).chainId, 31337n);
    assert.ok(calls.includes("eth_chainId"));
    await assert.rejects(openHostedPlannerConnection("http://127.0.0.1", "31337", "system-https-proxy"), /HOSTED_PLANNER_NETWORK_INVALID/);
  } finally {
    connection.close(); assert.equal(connection.provider.destroyed, true);
    await new Promise<void>(resolve => { server.close(() => resolve()); server.closeIdleConnections(); });
  }
});

test("Kimi planner disables thinking within its completion budget and supports a configured Magpie response model", () => {
  const configured = validateHostedAutonomyConfig({ ...config, plannerPhysicalModel: "cheap/kimi-k2.6", plannerResponseModel: "kimi-k2.6" });
  assert.equal(configured.plannerPhysicalModel, "cheap/kimi-k2.6"); assert.equal(configured.plannerResponseModel, "kimi-k2.6");
  const body = createHostedPlannerRequest(configured, {
    observation: { cashRaw: "500", debtRaw: "0", creditAvailableRaw: "200", inferenceCreditsAvailable: "0" },
    completedTasks: 0, startedTasks: 0, decisions: 0, remainingTasks: 2, remainingSpendRaw: "250", deadlineMs: Date.now() + 60000, models: ["kimi-k2.6"], funding: ["cash", "credit"],
  });
  assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.max_completion_tokens, 512); assert.equal(body.model, config.plannerModel);
  assert.throws(() => validateHostedAutonomyConfig({ ...config, plannerResponseModel: "invalid response model" }), /HOSTED_AUTONOMY_CONFIG_INVALID/);
});

test("real planner prompt separates paid planning, package purchase, borrowing fee and token rates", async () => fixture(async directory => {
  const selected = input(directory); selected.agent.perRunBudgetRaw = "120000"; selected.agent.totalBudgetRaw = "300000"; selected.run.reservedRaw = "300000";
  const adapter = task(async child => {
    assert.equal(child.agent.allowCredit, true); assert.equal(child.agent.modelId, "strong");
    return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "120000" };
  }, async () => ({ ...finance, cashRaw: "50000", debtRaw: "0", credit: { ...finance.credit, tierCapRaw: "200000", feeBps: "1500" },
    policy: { ...finance.policy, maxCashPerTxRaw: "120000", maxDebtPerTxRaw: "120000", maxDebtPerDayRaw: "300000" } }));
  adapter.config.metered!.priceRaw = "120000";
  for (const model of adapter.config.models) model.templates.balanced.tasks[0].creditLimit = "80000";
  const configured = { ...config, maxTasks: 1, plannerPriceRaw: "10000" };
  const executor = new HostedAutonomyExecutor(adapter, configured, { planner: async context => {
    const request = createHostedPlannerRequest(configured, context);
    const messages = request.messages as { content: string }[];
    const sent = JSON.parse(messages[1].content);
    assert.equal(sent.observation.cashRaw, "50000"); assert.equal(sent.observation.executionCosts.planningCashRaw, "10000");
    assert.equal(sent.observation.executionCosts.taskPackagePriceRaw, "120000"); assert.equal(sent.observation.executionCosts.taskPackageCreditsRaw, "200000");
    assert.equal(sent.fundingQuote.cashAfterPlanningRaw, "40000"); assert.equal(sent.fundingQuote.budgetAfterPlanningRaw, "290000");
    assert.deepEqual(sent.fundingQuote.options, [
      { funding: "cash", feasible: false, fromCashRaw: "120000", fromCreditRaw: "0", borrowerFeeRaw: "0" },
      { funding: "credit", feasible: true, fromCashRaw: "40000", fromCreditRaw: "80000", borrowerFeeRaw: "12000" },
    ]);
    assert.deepEqual(sent.observation.executionCosts.tokenRates, [
      { tier: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
      { tier: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" },
    ]);
    assert.deepEqual(sent.models, ["cheap", "strong"]); assert.match(messages[0].content, /cash FIRST/); assert.match(messages[0].content, /neither the planner charge nor the package price/);
    return { decision: { action: "run-task", modelId: "strong", funding: "credit" }, chargedRaw: "10000" };
  } });
  const result = await executor.execute(selected); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "130000");
}));

test("custom gateway catalog IDs preserve cheap and strong workflow tier pricing", async () => fixture(async directory => {
  let planned = false;
  const adapter = task(async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }));
  adapter.config.metered!.catalog[0].id = "economy-custom";
  adapter.config.metered!.catalog[1].id = "premium-custom";
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1 }, { planner: async context => {
    planned = true;
    assert.deepEqual(context.observation.executionCosts?.tokenRates, [
      { tier: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" },
      { tier: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" },
    ]);
    return { decision: { action: "run-task", modelId: "cheap", funding: "cash" }, chargedRaw: "10" };
  } });
  const result = await executor.execute(input(directory));
  assert.equal(planned, true); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90");
}));

test("planner reconciliation reads the original payment only and requires canonical refund plus operator evidence", async () => {
  const account = "0x2222222222222222222222222222222222222222", manager = "0x3333333333333333333333333333333333333333";
  const txHash = `0x${"11".repeat(32)}`, refundHash = `0x${"22".repeat(32)}`, refundId = `0x${"33".repeat(32)}`, blockHash = `0x${"44".repeat(32)}`;
  const context: AutonomyContext = { observation: { cashRaw: "50", debtRaw: "0", creditAvailableRaw: "80", inferenceCreditsAvailable: "0" }, completedTasks: 0, startedTasks: 0,
    decisions: 0, remainingTasks: 2, remainingSpendRaw: "300", deadlineMs: Date.now() + 60000, models: ["cheap"], funding: ["cash", "credit"] };
  const body = { ...createHostedPlannerRequest(config, context), agentId: "1", taskId: "0" }, digest = requestDigest(body), nonce = `0x${"55".repeat(32)}`, id = paymentId("0", digest, nonce);
  const handle: PaymentHandle = { version: 1, relayUrl: config.plannerRelayUrl, input: body, creditNonce: "1", submission: { from: config.plannerProvider, nonce: 7, txHash },
    quote: { paymentId: id, agentId: "1", taskId: "0", requestDigest: digest, serverNonce: nonce, service: config.plannerService, model: config.plannerModel,
      price: "10", payTo: config.plannerProvider, asset: account, chainId: "31337", account, quoteExpiry: "100000", createdBlock: 1 } };
  const paidEvent = accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [1, config.plannerProvider, id, 10, 0]);
  const refundEvent = managerInterface.encodeEventLog(managerInterface.getEvent("RefundProcessed")!, [id, refundId, 10, 0, 10]);
  let refunded = 0n, canonicalRefund = true, gets = 0;
  const provider = { send: async () => "0x7a69", getBlock: async () => ({ number: 5, hash: blockHash }),
    getTransaction: async (hash: string) => { assert.equal(hash, txHash); return { to: account, from: config.plannerProvider, nonce: 7, value: 0n,
      data: accountInterface.encodeFunctionData("payProvider", [1, config.plannerProvider, 10, id, EMPTY_AUTH, "0x"]) }; },
    getTransactionReceipt: async (hash: string) => ({ hash, status: 1, blockNumber: hash === txHash ? 2 : 4, blockHash: hash === refundHash && !canonicalRefund ? "bad" : blockHash,
      logs: hash === txHash ? [{ address: account, ...paidEvent }] : [{ address: manager, ...refundEvent }] }),
    call: async ({ data }: { data: string }) => { const method = accountInterface.parseTransaction({ data })!.name;
      if (method === "getPayment") return accountInterface.encodeFunctionResult("getPayment", [[1, 0, 10, 0, refunded]]);
      assert.equal(method, "creditManager"); return accountInterface.encodeFunctionResult("creditManager", [manager]); },
  } as unknown as JsonRpcProvider;
  const attempts = [{ upstream: "real", model: "real", startedAt: 1, state: "Unknown", httpStatus: 503 }];
  const resolution = { version: 1, paymentId: id, resolutionId: refundId, evidenceDigest: nonce, expectedAttemptsDigest: keccak256(toUtf8Bytes(canonical(attempts as unknown as Json))), reason: "operator-accepted-nondelivery-cost", resolvedAt: 1 };
  const view: any = { state: "Processing", paymentId: id, refundedAmount: "0", upstreamAttempts: attempts };
  const read = (async (url: string | URL | Request, init?: RequestInit) => { gets++; assert.equal(init?.method, "GET"); assert.equal(new URL(String(url)).pathname, `/payments/${id}`); return Response.json(view); }) as typeof fetch;
  const expected = { config, context, chainId: "31337", account, asset: account, agentId: "1", wallet: config.plannerProvider };
  const recover = () => reconcileHostedPlannerPayment(handle, expected, provider, read);
  assert.deepEqual(await recover(), { status: "unknown", chargedRaw: "10", refundedRaw: "0" });
  refunded = 10n; Object.assign(view, { state: "Refunded", refundedAmount: "10", confirmedRefunds: [{ refundId, amount: "10", txHash: refundHash }] });
  assert.equal((await recover()).status, "unknown", "refund alone cannot clear uncertainty");
  view.operatorResolution = resolution; canonicalRefund = false;
  assert.equal((await recover()).status, "unknown", "noncanonical refund cannot clear uncertainty");
  canonicalRefund = true; assert.deepEqual(await recover(), { status: "refunded-undelivered", chargedRaw: "0", refundedRaw: "10", evidence: { paymentId: id, resolutionId: refundId, evidenceDigest: nonce } });
  view.operatorResolution = { ...resolution, expectedAttemptsDigest: nonce };
  assert.equal((await recover()).status, "unknown", "changed attempt evidence cannot clear uncertainty");
  assert.equal(gets, 5);
});

test("hosted paid unknown planner is reconciled without replay and reports refunds separately", async () => fixture(async directory => {
  let plans = 0, cleared = false;
  const executor = new HostedAutonomyExecutor(task(async () => ({ phase: "Succeeded", terminal: true, success: true, chargedRaw: "70" })), config, {
    planner: async () => { if (++plans === 1) throw new Error("unknown paid"); return { decision: { action: "run-task", modelId: "cheap", funding: "credit" }, chargedRaw: "10" }; },
    recoverPlanner: async () => cleared ? { status: "refunded-undelivered", chargedRaw: "0", refundedRaw: "10", evidence: { paymentId: "same", resolutionId: "operator", evidenceDigest: "digest" } }
      : { status: "unknown", chargedRaw: "10", refundedRaw: "0" },
  });
  const parent = input(directory); assert.equal((await executor.execute(parent)).chargedRaw, "10");
  await executor.execute({ ...parent, recover: true }); assert.equal(plans, 1);
  cleared = true; const result = await executor.execute({ ...parent, recover: true });
  assert.equal(result.phase, "Completed"); assert.equal(result.autonomousTasks, 2); assert.equal(result.chargedRaw, "160"); assert.equal(result.refundedRaw, "10"); assert.equal(plans, 3);
}));

test("cached planner recovery requires canonical paid receipt, no child and original deadline; never invokes SDK or model", async () => fixture(async directory => {
  const wallet = Wallet.createRandom(), account = "0x2222222222222222222222222222222222222222", txHash = `0x${"66".repeat(32)}`, blockHash = `0x${"77".repeat(32)}`;
  let originalPlans = 0, tasks = 0, valid = true, clock = Date.now();
  const parent = input(directory); parent.agent.wallet = wallet.address; parent.agent.binding!.wallet = wallet.address; parent.keyFile = join(directory, "wallet.key");
  await writeFile(parent.keyFile, wallet.privateKey, { mode: 0o600 }); parent.keyFile = await realpath(parent.keyFile);
  const adapter = task(async () => { tasks++; return { phase: "Succeeded", terminal: true, success: true, chargedRaw: "80" }; });
  Object.assign(adapter.config.models[0].templates.balanced, { chainId: "31337", account, asset: account });
  let handle: PaymentHandle;
  const provider = { send: async (method: string) => { assert.equal(method, "eth_chainId"); return "0x7a69"; },
    getBlock: async () => ({ number: 2, hash: valid ? blockHash : `0x${"00".repeat(32)}`, timestamp: 1000 }),
    getTransaction: async (hash: string) => { assert.equal(hash, txHash); return { to: account, from: wallet.address, nonce: 7, value: 0n,
      data: accountInterface.encodeFunctionData("payProvider", [1, config.plannerProvider, 10, handle.quote.paymentId, EMPTY_AUTH, "0x"]) }; },
    getTransactionReceipt: async (hash: string) => ({ hash, status: 1, blockNumber: 2, blockHash,
      logs: [{ address: account, ...accountInterface.encodeEventLog(accountInterface.getEvent("ProviderPaid")!, [1, config.plannerProvider, handle.quote.paymentId, 10, 0]) }] }),
    call: async ({ data }: { data: string }) => { assert.equal(accountInterface.parseTransaction({ data })!.name, "getPayment"); return accountInterface.encodeFunctionResult("getPayment", [[1, 0, 10, 0, 0]]); },
  } as unknown as JsonRpcProvider;
  const executor = new HostedAutonomyExecutor(adapter, { ...config, maxTasks: 1 }, { provider, now: () => clock,
    planner: async () => { originalPlans++; return { decision: "old parser rejection", chargedRaw: "10" }; } });
  const first = await executor.execute(parent); assert.equal(first.reason, "AUTONOMY_INVALID_DECISION");
  const loopFile = join(directory, "autonomy-loop", "session.json"), loop = JSON.parse(await readFile(loopFile, "utf8")), step = loop.steps[0];
  const body = { ...createHostedPlannerRequest(config, step.context), agentId: "1", taskId: "0" }, digest = requestDigest(body), nonce = `0x${"88".repeat(32)}`;
  const quote = { paymentId: paymentId("0", digest, nonce), agentId: "1", taskId: "0", requestDigest: digest, serverNonce: nonce, service: config.plannerService, model: config.plannerModel,
    price: "10", payTo: config.plannerProvider, asset: account, chainId: "31337", account, quoteExpiry: "2000", createdBlock: 1 };
  handle = { version: 1, relayUrl: config.plannerRelayUrl, input: body, quote, creditNonce: "1", submission: { from: wallet.address, nonce: 7, txHash } };
  const state = { version: 1, context: step.context, handle, inference: { handle, receipt: { ...quote, txHash, blockNumber: 2, blockHash, timestamp: 1000, fromCash: "10", fromCredit: "0", model: config.plannerPhysicalModel, usage: null, upstream: "cheap" },
    result: { model: config.plannerPhysicalModel, choices: [{ message: { content: '```json\n{"action":"run-task","modelId":"cheap","funding":"credit"}\n```' } }] } } };
  const plannerPath = join(directory, "planner", step.decisionId); await mkdir(plannerPath, { recursive: true }); await writeFile(join(plannerPath, "session.json"), JSON.stringify(state));
  const failed: HostedExecution = { ...parent, recover: true, agent: { ...parent.agent, spentRaw: "10" }, run: { ...parent.run, status: "Failed", chargedRaw: "10", reason: first.reason, result: first } };
  assert.equal(await executor.canRecoverTerminal(failed), true);
  const originalDigest = state.handle.quote.requestDigest; state.handle.quote.requestDigest = `0x${"00".repeat(32)}`;
  await writeFile(join(plannerPath, "session.json"), JSON.stringify(state)); assert.equal(await executor.canRecoverTerminal(failed), false);
  state.handle.quote.requestDigest = originalDigest; await writeFile(join(plannerPath, "session.json"), JSON.stringify(state));
  valid = false; assert.equal(await executor.canRecoverTerminal(failed), false); valid = true;
  clock = loop.config.deadlineMs; assert.equal(await executor.canRecoverTerminal(failed), false); clock--;
  loop.steps[0].childId = "existing-child"; await writeFile(loopFile, JSON.stringify(loop)); assert.equal(await executor.canRecoverTerminal(failed), false);
  delete loop.steps[0].childId; await writeFile(loopFile, JSON.stringify(loop));
  const result = await executor.execute({ ...failed, agent: parent.agent, run: { ...failed.run, status: "Queued" } });
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "90"); assert.equal(tasks, 1); assert.equal(originalPlans, 1);
  const final = JSON.parse(await readFile(loopFile, "utf8")); assert.equal(final.steps[0].decisionId, step.decisionId); assert.equal(final.steps.length, 1);
}));


test("activity callbacks remain outside snapshots and child facts reach the parent after recovery",async()=>fixture(async directory=>{
 const events:import("../src/scene-types.js").HostedActivityInput[]=[];let plans=0;
 const executor=new HostedAutonomyExecutor(task(async child=>{assert.equal(typeof child.activity,"function");await child.activity?.({scene:"settlement",state:"confirmed",evidence:{taskId:"42",txHash:`0x${"ab".repeat(32)}`,passed:true}});return {phase:"Succeeded",terminal:true,success:true,chargedRaw:"80"};},async()=>({...finance,block:{...finance.block,hash:`0x${"ab".repeat(32)}`}})),{...config,maxTasks:1},{planner:async()=>{plans++;return {decision:{action:"run-task",modelId:"cheap",funding:"credit"},chargedRaw:"10"};}});
 const parent={...input(directory),activity:async(event:import("../src/scene-types.js").HostedActivityInput)=>{events.push(importedValidate(event));}};
 const result=await executor.execute(parent);assert.equal(result.success,true);assert.ok(events.some(e=>e.scene==="settlement"&&e.evidence?.taskId==="42"));assert.ok(events.some(e=>e.scene==="decision"&&e.state==="selected"));
 const saved=JSON.parse(await readFile(join(directory,"autonomy-host/session.json"),"utf8"));assert.equal(saved.input.activity,undefined);assert.ok(Object.values(saved.children).every((child:any)=>child.activity===undefined));
 assert.deepEqual(await executor.execute({...parent,recover:true}),result);assert.equal(plans,1);
}));


test("runtime pause is distinct from a model stop in public decisions",async()=>fixture(async directory=>{
 const events:import("../src/scene-types.js").HostedActivityInput[]=[];
 const executor=new HostedAutonomyExecutor(task(async()=>{throw Error("must not execute");},async()=>({...finance,block:{...finance.block,hash:`0x${"ab".repeat(32)}`}})),config,{shouldContinue:async()=>false});
 const result=await executor.execute({...input(directory),activity:async event=>{events.push(importedValidate(event));}});assert.equal(result.reason,"HOSTED_AGENT_PAUSED");assert.ok(events.some(e=>e.reason==="HOSTED_AGENT_PAUSED"));assert.equal(events.some(e=>e.reason==="AUTONOMY_MODEL_STOPPED"),false);
}));
