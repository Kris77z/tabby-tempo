import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Contract, type TransactionReceipt } from "ethers";
import { canonical, paymentId, requestDigest, sameAddress } from "../packages/sdk/src/protocol.js";
import { artifact, reportDemoFailure, saveJson } from "./demo-common.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";
import { modelCatalogDigest } from "../services/hosted-agents/src/metered-task.js";
import { validOperatorResolution } from "../services/provider-relay/src/store.js";

// Read-only audit. No signer, key-file reader, model call, replay or transaction send.
// Private journals are inputs only; the public report is built from explicit fields.
const directory = resolve(process.argv[2] ?? "demo-output/monad-hosted-20261012/runtime");
const readJson = async (file: string): Promise<any> => JSON.parse(await readFile(file, "utf8"));
const address = (actual: string, expected: string) => assert.ok(sameAddress(actual, expected), "AUDIT_ADDRESS_MISMATCH");
const sha = (value: any) => createHash("sha256").update(canonical(value)).digest("hex");
const labels = ["cheap", "strong", "autonomy"] as const;
type Label = typeof labels[number];
type Entry = { label: Label; path: string; state: any };

async function main() {
  const ready = await readJson(join(directory, "ready.json")), bootstrap = await readJson(join(directory, "..", "bootstrap.json"));
  const journal = await readJson(join(directory, "acceptance.json"));
  assert.equal(ready.chainId, "10143"); assert.equal(bootstrap.chainId, "10143");
  const tasks: Entry[] = [], planners: Entry[] = [];
  async function collect(path: string, label: Label) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await collect(file, label);
      else if (entry.name === "session.json" && (basename(path) === "task-executor" || basename(dirname(path)) === "planner")) {
        const state = await readJson(file);
        if (basename(path) === "task-executor" && state.result?.taskId) {
          assert.equal(state.result.phase, "Succeeded"); assert.equal(state.result.success, true); tasks.push({ label, path, state });
        } else if (basename(dirname(path)) === "planner") { assert.ok(state.handle, "AUDIT_PLANNER_INCOMPLETE"); planners.push({ label, path, state }); }
      }
    }
  }
  for (const label of labels) {
    const entry = journal.agents[label], run = journal.runs[label];
    assert.equal(run?.result?.status, "Succeeded", `AUDIT_${label}_INCOMPLETE`);
    assert.equal(entry.financeBefore?.status, "confirmed"); assert.equal(entry.financeAfter?.status, "confirmed");
    assert.equal(entry.financeAfter.chainId, "10143");
    if (label === "autonomy") assert.equal(run.result.result.autonomousTasks, 2);
    // Include earlier parents too: an expired/refunded planner is still an actual
    // paid attempt and must not disappear if acceptance continues in a new parent.
    await collect(join(directory, "hosted", "agents", entry.agent.id, "runs"), label);
  }
  assert.equal(tasks.length, 4); assert.deepEqual(tasks.map(t => t.state.result.taskId).sort(), ["12", "13", "14", "15"]);
  assert.deepEqual(labels.map(label => tasks.filter(t => t.label === label).length), [1, 1, 2]);
  assert.ok(planners.length >= 2); assert.ok(planners.every(p => p.label === "autonomy"));
  const connection = await monadProvider(await readRpcUrlFile(ready.rpcUrlFile ?? bootstrap.rpcUrlFile), "direct"), rpc = connection.provider;
  try {
    assert.equal(BigInt(await rpc.send("eth_chainId", [])), 10143n);
    const latest = await rpc.getBlock("latest"); assert.ok(latest?.hash, "AUDIT_HEAD_MISSING"); const head = latest;
    const contracts = bootstrap.contracts;
    const account = new Contract(contracts.account, (await artifact("AgentAccount")).abi, rpc);
    const manager = new Contract(contracts.manager, (await artifact("CreditManager")).abi, rpc);
    const escrow = new Contract(contracts.escrow, (await artifact("TaskEscrow")).abi, rpc);
    const at = (contract: Contract, method: string, args: unknown[] = [], block = head.number) => contract.getFunction(method).staticCall(...args, { blockTag: block });
    const verifier = await at(escrow, "verifier");
    address(await at(account, "creditManager"), contracts.manager); address(await at(manager, "agentAccount"), contracts.account);
    address(await at(manager, "taskEscrow"), contracts.escrow); address(await at(account, "settlementAsset"), bootstrap.asset.address);
    const adapter = new Contract(contracts.adapter, (await artifact("ERC8004Adapter")).abi, rpc);
    address(await at(account, "adapter"), contracts.adapter); address(await at(adapter, "identity"), "0x8004A818BFB912233c491871b3d84c89A494BD9e");
    const reputation = await at(adapter, "reputation"); address(reputation, "0x8004B663056A597Dffe9eCcC1965A193B7388713");
    const checkedBlocks = new Map<number, string>([[head.number, head.hash!]]);
    async function checkBlock(number: number, hash: string) {
      assert.ok(number <= head.number, "AUDIT_RECEIPT_AFTER_SNAPSHOT");
      const block = await rpc.getBlock(number); assert.equal(block?.hash, hash, "AUDIT_NONCANONICAL_BLOCK"); checkedBlocks.set(number, hash); return block!;
    }
    async function receipt(hash: string, to: string, from: string) {
      const result = await rpc.getTransactionReceipt(hash); assert.ok(result, "AUDIT_RECEIPT_MISSING");
      assert.equal(result.hash, hash); assert.equal(result.status, 1); address(result.to!, to); address(result.from, from);
      await checkBlock(result.blockNumber, result.blockHash); return result;
    }
    function events(result: TransactionReceipt, contract: Contract, name: string) {
      return result.logs.filter(log => sameAddress(log.address, String(contract.target))).flatMap(log => {
        try { const parsed = contract.interface.parseLog(log); return parsed?.name === name ? [parsed] : []; } catch { return []; }
      });
    }
    const proof = (r: TransactionReceipt) => ({ txHash: r.hash, blockNumber: r.blockNumber, blockHash: r.blockHash, from: r.from, to: r.to });
    const usedPayments = new Set<string>();
    async function checkPayment(state: any, label: Label, taskId: string, refunded = false) {
      const handle = state.handle, saved = state.inference?.receipt, quote = handle.quote;
      const agent = journal.agents[label], id = agent.financeAfter.agentId;
      assert.equal(quote.chainId, "10143"); assert.equal(quote.agentId, id); assert.equal(quote.taskId, taskId);
      address(quote.account, contracts.account); address(quote.asset, bootstrap.asset.address); address(quote.payTo, bootstrap.payTo);
      assert.equal(handle.input.agentId, id); assert.equal(handle.input.taskId, taskId);
      assert.equal(requestDigest(handle.input), quote.requestDigest); assert.equal(paymentId(taskId, quote.requestDigest, quote.serverNonce), quote.paymentId);
      if (saved) {
        for (const key of ["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "asset", "chainId", "account", "payTo"]) assert.equal(saved[key], quote[key], `AUDIT_RECEIPT_${key}`);
        assert.equal(saved.txHash, handle.submission.txHash);
      } else assert.equal(refunded, true, "AUDIT_DELIVERY_RECEIPT_MISSING");
      assert.ok(!usedPayments.has(quote.paymentId), "AUDIT_DUPLICATE_PAYMENT"); usedPayments.add(quote.paymentId);
      const paid = await receipt(handle.submission.txHash, contracts.account, agent.agent.wallet);
      if (saved) { assert.equal(paid.blockHash, saved.blockHash); assert.equal(paid.blockNumber, saved.blockNumber); }
      const matches = events(paid, account, "ProviderPaid").filter(e => e.args.paymentId === quote.paymentId); assert.equal(matches.length, 1);
      const event = matches[0].args, record = await at(account, "getPayment", [quote.paymentId]);
      assert.equal(event.agentId, BigInt(id)); address(event.provider, quote.payTo);
      assert.equal(event.fromCash, record.fromCash); assert.equal(event.fromCredit, record.fromCredit); assert.equal(record.agentId, BigInt(id));
      assert.equal(record.fromCash + record.fromCredit, BigInt(quote.price)); assert.equal(record.refundedAmount, refunded ? BigInt(quote.price) : 0n);
      assert.equal(record.taskId, record.fromCredit > 0n ? BigInt(taskId) : 0n);
      if (saved) { assert.equal(String(record.fromCash), saved.fromCash); assert.equal(String(record.fromCredit), saved.fromCredit); }
      const tx = await rpc.getTransaction(paid.hash); assert.ok(tx); assert.equal(tx.chainId, 10143n);
      const decoded = account.interface.parseTransaction({ data: tx.data, value: tx.value }); assert.equal(decoded?.name, "payProvider");
      const args = decoded!.args; assert.equal(args[0], BigInt(id)); address(args[1], quote.payTo); assert.equal(args[2], BigInt(quote.price)); assert.equal(args[3], quote.paymentId);
      if (record.fromCredit > 0n) { assert.equal(args[4].agentId, BigInt(id)); assert.equal(args[4].taskId, BigInt(taskId)); }
      return { paid, record, feeBps: args[4].feeBps as bigint, public: { ...proof(paid), paymentId: quote.paymentId, taskId, onchainPaymentTaskId: String(record.taskId),
        agentId: id, service: quote.service, priceRaw: quote.price, fromCashRaw: String(record.fromCash), fromCreditRaw: String(record.fromCredit), provider: quote.payTo,
        requestDigest: quote.requestDigest, taskBinding: record.fromCredit > 0n ? "credit authorization and payment record" : "SDK request digest and quote (cash record taskId is 0)" } };
    }
    const taskReports: any[] = [], plannerReports: any[] = [];
    for (const entry of tasks.sort((a, b) => Number(a.state.result.taskId) - Number(b.state.result.taskId))) {
      const { state, label, path } = entry, result = state.result, taskId = result.taskId;
      const agent = journal.agents[label], agentId = agent.financeAfter.agentId;
      assert.equal(state.snapshot.workflow.agentId, agentId); address(state.snapshot.wallet, agent.agent.wallet);
      assert.equal(state.snapshot.workflow.chainId, "10143"); address(state.snapshot.workflow.escrowAddress, contracts.escrow); address(state.snapshot.workflow.account, contracts.account);
      if (label !== "autonomy") assert.deepEqual(result, journal.runs[label].result.result);
      const [task, loan] = await Promise.all([at(escrow, "getTask", [taskId]), at(manager, "getLoan", [taskId])]);
      assert.equal(task.agentId, BigInt(agentId)); assert.equal(task.status, 3n); assert.equal(task.escrowBalance, 0n);
      assert.equal(loan.status, 2n); assert.equal(loan.agentId, BigInt(agentId)); assert.equal(loan.principal + loan.fee, 0n);
      const purchase = await readJson(join(path, "workflow", "metered", "allowance-purchase", "session.json"));
      const ledger = await readJson(join(path, "workflow", "metered", "inference-ledger", "session.json"));
      const payment = await checkPayment(purchase, label, taskId);
      assert.equal(result.paymentTxHash, payment.paid.hash); assert.equal(result.paymentId, payment.public.paymentId);
      assert.equal(result.fromCashRaw, payment.public.fromCashRaw); assert.equal(result.fromCreditRaw, payment.public.fromCreditRaw);
      assert.equal(result.chargedRaw, payment.public.priceRaw); assert.equal(result.refundedRaw, "0");
      const allowance = purchase.inference.result, savedReceipt = purchase.inference.receipt;
      assert.equal(allowance.kind, "inference-allowance"); assert.equal(allowance.taskId, taskId); assert.equal(allowance.agentId, agentId); assert.equal(allowance.paymentId, payment.public.paymentId);
      assert.equal(allowance.creditsRaw, purchase.config.creditsRaw); assert.equal(allowance.modelCatalogDigest, modelCatalogDigest(purchase.config.catalog));
      assert.deepEqual(purchase.handle.input.allowance, { creditsRaw: allowance.creditsRaw, modelCatalogDigest: allowance.modelCatalogDigest });
      assert.equal(savedReceipt.upstream, "allowance-ledger"); assert.equal(savedReceipt.model, "inference-allowance-v1"); assert.equal(savedReceipt.usage.llmInvocations, 0);
      assert.equal(ledger.binding.taskId, taskId); assert.equal(ledger.binding.agentId, agentId); address(ledger.binding.wallet, agent.agent.wallet);
      assert.deepEqual(ledger.catalog, [...purchase.config.catalog].sort((a: any, b: any) => a.id.localeCompare(b.id)));
      assert.equal(ledger.grants.length, 1); const grant = ledger.grants[0];
      assert.equal(grant.source.kind, "chain-payment"); assert.equal(grant.source.paymentId, payment.public.paymentId); assert.equal(grant.source.txHash, payment.paid.hash); assert.equal(grant.credits, allowance.creditsRaw);
      assert.ok(ledger.invocations.length > 0); let spent = 0n;
      const models = ledger.invocations.map((invocation: any) => {
        assert.equal(invocation.state, "Completed"); assert.equal(invocation.response.status, 200);
        const model = ledger.catalog.find((m: any) => m.id === invocation.modelId); assert.ok(model);
        const body = invocation.response.body, usage = body.usage;
        assert.equal(invocation.request.model, model.model); assert.equal(body.model, model.responseModel ?? model.model);
        assert.equal(invocation.requestDigest, sha(invocation.request)); assert.deepEqual(invocation.result.response, body);
        for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) assert.ok(Number.isSafeInteger(usage[key]) && usage[key] >= 0);
        assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens); assert.ok(usage.total_tokens > 0);
        assert.deepEqual(invocation.result.usage, { promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens });
        const charge = BigInt(usage.prompt_tokens) * BigInt(model.inputMicroCreditsPerToken) + BigInt(usage.completion_tokens) * BigInt(model.outputMicroCreditsPerToken);
        assert.equal(String(charge), invocation.result.chargedCredits); assert.ok(charge <= BigInt(invocation.reservedCredits)); spent += charge;
        return { invocationId: invocation.id, tier: invocation.modelId, requestModel: invocation.request.model, responseModel: body.model,
          promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens, totalTokens: usage.total_tokens, chargedCredits: String(charge),
          requestDigest: invocation.requestDigest, responseDigest: sha(body) };
      });
      assert.ok(spent <= BigInt(grant.credits));
      const settled = await receipt(result.settlement.txHash, contracts.escrow, verifier);
      assert.equal(result.settlement.block.hash, settled.blockHash); assert.equal(result.settlement.block.number, settled.blockNumber);
      assert.ok(payment.paid.blockNumber <= settled.blockNumber);
      const settlements = events(settled, escrow, "TaskSettled").filter(e => e.args.taskId === BigInt(taskId)); assert.equal(settlements.length, 1);
      const repayments = events(settled, manager, "LoanRepaid").filter(e => e.args.taskId === BigInt(taskId)); assert.equal(repayments.length, 1);
      const opened = events(payment.paid, manager, "LoanOpened").filter(e => e.args.taskId === BigInt(taskId)); assert.equal(opened.length, 1);
      assert.equal(opened[0].args.agentId, BigInt(agentId)); assert.equal(opened[0].args.amount, payment.record.fromCredit);
      const preLoan = await at(manager, "getLoan", [taskId], settled.blockNumber - 1), repaid = repayments[0].args, settlement = settlements[0].args;
      assert.equal(preLoan.status, 1n); assert.equal(preLoan.agentId, BigInt(agentId)); assert.equal(preLoan.principal, payment.record.fromCredit);
      assert.equal(preLoan.fee, preLoan.principal * payment.feeBps / 10000n);
      assert.equal(repaid.principal, preLoan.principal); assert.equal(repaid.fee, preLoan.fee);
      assert.equal(settlement.passed, true); assert.equal(settlement.slashed, 0n); assert.equal(settlement.repaid, repaid.principal + repaid.fee);
      const protocolFee = BigInt(task.reward) * BigInt(task.protocolFeeBps) / 10000n;
      assert.equal(settlement.toAgent, task.reward - protocolFee - settlement.repaid);
      assert.equal(result.settlement.repaidRaw, String(settlement.repaid)); assert.equal(result.settlement.residualRaw, String(settlement.toAgent)); assert.equal(result.settlement.slashedRaw, "0");
      taskReports.push({ label, taskId, agentId, wallet: agent.agent.wallet, taskStatus: "Settled", rewardRaw: String(task.reward), protocolFeeRaw: String(protocolFee),
        payment: payment.public, settlement: { ...proof(settled), passed: true, principalRepaidRaw: String(repaid.principal), feeRepaidRaw: String(repaid.fee), repaidRaw: String(settlement.repaid), slashedRaw: "0", residualRaw: String(settlement.toAgent) },
        loan: { status: "Repaid", principalOutstandingRaw: "0", feeOutstandingRaw: "0" }, allowance: { creditsRaw: grant.credits, spentCreditsRaw: String(spent), catalogDigest: allowance.modelCatalogDigest }, models });
    }
    const parentReports = new Map<string, any>();
    for (const planner of planners) {
      const state = planner.state, decisionId = basename(planner.path), parentPath = dirname(dirname(planner.path));
      const parentId = basename(parentPath), loop = await readJson(join(parentPath, "autonomy-loop", "session.json"));
      const step = loop.steps.find((s: any) => s.decisionId === decisionId); assert.ok(step, "AUDIT_PLANNER_STEP_MISSING");
      assert.deepEqual(step.context, state.context); assert.ok(loop.steps.length <= loop.config.maxDecisions);
      const gross = BigInt(loop.chargedRaw) + loop.steps.reduce((sum: bigint, s: any) => sum + BigInt(s.decisionRefundedRaw ?? "0") + BigInt(s.outcome?.refundedRaw ?? "0"), 0n);
      assert.ok(gross <= BigInt(loop.config.maxSpendRaw));
      parentReports.set(parentId, { requestId: parentId, phase: loop.phase, decisions: loop.steps.length, maxDecisions: loop.config.maxDecisions,
        completedTasks: loop.completedTasks, netChargedRaw: loop.chargedRaw, grossSpendRaw: String(gross), maxSpendRaw: loop.config.maxSpendRaw });
      const relay = await readJson(join(directory, "planner", `${state.handle.quote.paymentId}.json`));
      assert.deepEqual(relay.quote, state.handle.quote); assert.deepEqual(relay.request, state.handle.input);
      assert.ok(Array.isArray(relay.upstreamAttempts) && relay.upstreamAttempts.length > 0);
      const refunded = !state.inference, checked = await checkPayment(state, planner.label, "0", refunded);
      assert.equal(checked.record.fromCredit, 0n);
      assert.equal(relay.proof.txHash, checked.paid.hash); assert.equal(relay.proof.blockHash, checked.paid.blockHash); assert.equal(relay.proof.blockNumber, checked.paid.blockNumber);
      const attempts = relay.upstreamAttempts.map((a: any) => ({ upstream: a.upstream, model: a.model, startedAt: a.startedAt, state: a.state,
        ...(a.httpStatus !== undefined ? { httpStatus: a.httpStatus } : {}), ...(a.reason !== undefined ? { reason: a.reason } : {}) }));
      if (refunded) {
        assert.equal(relay.state, "Refunded"); assert.ok(validOperatorResolution(relay), "AUDIT_OPERATOR_RESOLUTION_INVALID");
        assert.equal(state.recovery?.status, "refunded-undelivered"); assert.equal(state.recovery.chargedRaw, "0"); assert.equal(state.recovery.refundedRaw, checked.public.priceRaw);
        assert.deepEqual(step.decisionRecovery, state.recovery); assert.equal(step.decisionChargedRaw, "0"); assert.equal(step.decisionRefundedRaw, checked.public.priceRaw);
        assert.equal(step.decision, undefined); assert.equal(step.childId, undefined); assert.equal(step.outcome, undefined);
        const resolution = relay.operatorResolution;
        assert.deepEqual(state.recovery.evidence, { paymentId: checked.public.paymentId, resolutionId: resolution.resolutionId, evidenceDigest: resolution.evidenceDigest });
        assert.equal(relay.refunds.length, 1); const refund = relay.refunds[0];
        assert.equal(refund.state, "Confirmed"); assert.equal(refund.amount, checked.public.priceRaw);
        const refunder = await at(manager, "relayRefunder"), refundedReceipt = await receipt(refund.transaction.txHash, contracts.manager, refunder);
        assert.ok(refundedReceipt.blockNumber >= checked.paid.blockNumber);
        const refunds = events(refundedReceipt, manager, "RefundProcessed"); assert.equal(refunds.length, 1);
        const event = refunds[0].args; assert.equal(event.paymentId, checked.public.paymentId); assert.equal(event.refundId, refund.id);
        assert.equal(event.amount, BigInt(checked.public.priceRaw)); assert.equal(event.debtReduced, 0n); assert.equal(event.toCash, event.amount);
        assert.equal(await at(account, "refundConsumed", [refund.id]), true);
        plannerReports.push({ label: planner.label, parentRequestId: parentId, decisionId, status: "UnknownRefunded", payment: checked.public,
          chargedRaw: "0", refundedRaw: refund.amount, dispatchAttempts: attempts, responseModel: null, usage: null,
          operatorResolution: { version: resolution.version, paymentId: resolution.paymentId, resolutionId: resolution.resolutionId,
            expectedAttemptsDigest: resolution.expectedAttemptsDigest, evidenceDigest: resolution.evidenceDigest, reason: resolution.reason, resolvedAt: resolution.resolvedAt },
          refund: { ...proof(refundedReceipt), refundId: refund.id, amountRaw: String(event.amount), debtReducedRaw: "0", toCashRaw: String(event.toCash) } });
        continue;
      }
      assert.equal(relay.state, "Delivered"); assert.equal(relay.operatorResolution, undefined); assert.equal(relay.refunds.length, 0);
      assert.deepEqual(relay.result, state.inference.result); assert.deepEqual(relay.receipt, state.inference.receipt);
      assert.equal(step.decisionChargedRaw, checked.public.priceRaw); assert.equal(step.decisionRefundedRaw ?? "0", "0");
      const body = state.inference.result, usage = body.usage; assert.equal(body.model, "kimi-k2.6"); assert.deepEqual(state.inference.receipt.usage, usage);
      for (const key of ["prompt_tokens", "completion_tokens", "total_tokens"]) assert.ok(Number.isSafeInteger(usage[key]) && usage[key] >= 0);
      assert.equal(usage.total_tokens, usage.prompt_tokens + usage.completion_tokens); assert.ok(usage.total_tokens > 0);
      plannerReports.push({ label: planner.label, parentRequestId: parentId, decisionId, status: "Delivered", payment: checked.public,
        chargedRaw: checked.public.priceRaw, refundedRaw: "0", dispatchAttempts: attempts, responseModel: body.model, promptTokens: usage.prompt_tokens, completionTokens: usage.completion_tokens,
        totalTokens: usage.total_tokens, responseDigest: sha(body) });
    }
    const next = await at(escrow, "nextTaskId"); assert.ok(next <= 201n, "AUDIT_LEDGER_LIMIT");
    let outstanding = 0n; const activeLoans: any[] = [];
    for (let id = 1n; id < next; id++) { const loan = await at(manager, "getLoan", [id]); if (loan.status === 1n) { outstanding += loan.principal + loan.fee; activeLoans.push({ taskId: String(id), agentId: String(loan.agentId), debtRaw: String(loan.principal + loan.fee) }); } }
    const totalOutstanding = await at(manager, "totalOutstanding"); assert.equal(totalOutstanding, outstanding);
    const agents: any[] = [];
    for (const label of labels) {
      const entry = journal.agents[label], before = entry.financeBefore, after = entry.financeAfter, id = after.agentId;
      address(after.wallet, entry.agent.wallet); assert.equal(before.agentId, id); await checkBlock(after.block.number, after.block.hash); await checkBlock(before.block.number, before.block.hash);
      const identity = await at(adapter, "resolveAgent", [id]); address(identity.owner, entry.agent.wallet); address(identity.wallet, entry.agent.wallet);
      const [cash, repayments, defaults] = await Promise.all([at(account, "cash", [id]), at(manager, "repaymentCount", [id]), at(manager, "defaultCount", [id])]);
      assert.equal(String(cash), after.cashRaw); assert.equal(String(repayments), after.counts.repayments); assert.equal(String(defaults), after.counts.defaults);
      assert.equal(String(await at(account, "cash", [id], before.block.number)), before.cashRaw);
      assert.equal(String(await at(account, "cash", [id], after.block.number)), after.cashRaw);
      assert.equal(String(await at(manager, "repaymentCount", [id], before.block.number)), before.counts.repayments);
      assert.equal(String(await at(manager, "defaultCount", [id], before.block.number)), before.counts.defaults);
      const owned = taskReports.filter(t => t.label === label), planning = plannerReports.filter(t => t.label === label);
      const expected = BigInt(before.cashRaw) + owned.reduce((s, t) => s + BigInt(t.settlement.residualRaw) - BigInt(t.payment.fromCashRaw), 0n) - planning.reduce((s, t) => s + BigInt(t.payment.fromCashRaw) - BigInt(t.refundedRaw), 0n);
      assert.equal(cash, expected, "AUDIT_CASH_WATERFALL_MISMATCH"); assert.equal(repayments, BigInt(before.counts.repayments) + BigInt(owned.length));
      assert.equal(defaults, BigInt(before.counts.defaults)); assert.equal(after.debtRaw, "0"); assert.ok(!activeLoans.some(l => l.agentId === id));
      assert.equal(after.ownedTaskCount, before.ownedTaskCount + owned.length);
      agents.push({ label, agentId: id, wallet: entry.agent.wallet, cashBeforeRaw: before.cashRaw, cashAfterRaw: String(cash), debtRaw: "0", repayments: String(repayments), defaults: String(defaults),
        apiSnapshot: { source: "acceptance.json financeAfter (real hosted API response)", block: after.block, cashRaw: after.cashRaw, debtRaw: after.debtRaw, matchesFreshFixedBlock: true } });
    }
    assert.ok(taskReports.some(t => t.models.some((m: any) => m.responseModel === "kimi-k2.6"))); assert.ok(taskReports.some(t => t.models.some((m: any) => m.responseModel === "kimi-k3")));
    // Recheck every receipt/API block after all reads; do not publish a mixed-fork audit.
    for (const [number, hash] of checkedBlocks) assert.equal((await rpc.getBlock(number))?.hash, hash, "AUDIT_REORG_DURING_READ");
    assert.equal(BigInt(await rpc.send("eth_chainId", [])), 10143n);
    const publicDirectory = resolve("frontend/acceptance/monad-hosted-20261012"); await mkdir(publicDirectory, { recursive: true });
    const output = join(publicDirectory, "canonical-audit.json");
    await saveJson(output, { version: 1, passed: true, observedAt: new Date().toISOString(), chainId: "10143", block: { number: head.number, hash: head.hash, timestamp: head.timestamp },
      boundary: "Read-only Monad testnet audit; prepaid allowance payments are distinct from provider-reported model token usage. No claim of vendor per-token onchain settlement.",
      contracts: { account: contracts.account, manager: contracts.manager, escrow: contracts.escrow, adapter: contracts.adapter, identity: bootstrap.identity, reputation, verifier },
      agents, tasks: taskReports, planners: plannerReports, autonomyParents: [...parentReports.values()],
      plannerCounts: { paidCalls: plannerReports.length, deliveredCalls: plannerReports.filter(p => p.status === "Delivered").length,
        unknownRefundedCalls: plannerReports.filter(p => p.status === "UnknownRefunded").length, dispatchAttempts: plannerReports.reduce((sum, p) => sum + p.dispatchAttempts.length, 0) }, global: { totalOutstandingRaw: String(totalOutstanding), scannedTaskCount: Number(next - 1n), activeLoans },
      checks: { canonicalReceipts: true, exactPaymentEvents: true, exactLoanRepaymentEvents: true, taskOwnership: true, settledLoans: true, cashWaterfall: true, apiBalances: true, originalResponseModelsAndUsage: true,
        unknownPlannerEvidencePreserved: true, canonicalFullRefunds: true, grossDecisionBudgets: true, readOnly: true, roleKeysRead: false, canonicalBlocksRechecked: checkedBlocks.size } });
    console.log(JSON.stringify({ passed: true, blockNumber: head.number, tasks: taskReports.map(t => t.taskId), output }));
  } finally { connection.close(); }
}
await main().catch(error => { reportDemoFailure(error); process.exitCode = 1; });
