import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Contract, keccak256, toUtf8Bytes, type TransactionReceipt } from "ethers";
import { canonical, paymentId, requestDigest, sameAddress } from "../packages/sdk/src/protocol.js";
import { artifact, reportDemoFailure, saveJson } from "./demo-common.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";
import { modelCatalogDigest } from "../services/hosted-agents/src/metered-task.js";
import { allowanceCertificateDigest, validOperatorCompensation, validOperatorResolution } from "../services/provider-relay/src/store.js";

import { validGatewayClosure } from "../services/hosted-agents/src/inference-closure.js";
import { creditTerms } from "../services/underwriter/src/rules.js";
import { parseAutonomyDecision } from "../packages/pi-loop/src/autonomy.js";

// Completion audit is separate from the retained pre-compensation observed audit.
// Read-only audit. No signer, key-file reader, model call, replay or transaction send.
// Private journals are inputs only; the public report is built from explicit fields.
const directory = resolve(process.argv[2] ?? "demo-output/monad-hosted-20261012/runtime");
const inputDigests = new Map<string, string>();
const readJson = async (file: string): Promise<any> => {
  const bytes = await readFile(file, "utf8"), digest = createHash("sha256").update(bytes).digest("hex");
  if (inputDigests.has(file)) assert.equal(inputDigests.get(file), digest, "AUDIT_JOURNAL_CHANGED_DURING_READ");
  inputDigests.set(file, digest); return JSON.parse(bytes);
};
const address = (actual: string, expected: string) => assert.ok(sameAddress(actual, expected), "AUDIT_ADDRESS_MISMATCH");
const sha = (value: any) => createHash("sha256").update(canonical(value)).digest("hex");
const labels = ["cheap", "strong", "autonomy"] as const;
type Label = typeof labels[number];
type Entry = { label: Label; path: string; state: any };

async function main() {
  const ready = await readJson(join(directory, "ready.json")), bootstrap = await readJson(join(directory, "..", "bootstrap.json"));
  const journal = await readJson(join(directory, "acceptance.json"));
  assert.equal(ready.chainId, "10143"); assert.equal(bootstrap.chainId, "10143");
  const database = await readJson(join(directory, "hosted", "database", "session.json"));
  const tasks: Entry[] = [], aborted: Entry[] = [], planners: Entry[] = [];
  async function collect(path: string, label: Label) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await collect(file, label);
      else if (entry.name === "session.json" && (basename(path) === "task-executor" || basename(dirname(path)) === "planner")) {
        const state = await readJson(file);
        if (basename(path) === "task-executor" && state.result?.taskId) {
          if (state.result.phase === "Succeeded") { assert.equal(state.result.success, true); tasks.push({ label, path, state }); }
          else { assert.equal(state.result.phase, "Failed", "AUDIT_NONTERMINAL_TASK"); assert.equal(state.result.success, false); aborted.push({ label, path, state }); }
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
  assert.equal(tasks.length, 5); assert.deepEqual(tasks.map(t => t.state.result.taskId).sort(), ["12", "13", "15", "16", "17"]);
  assert.deepEqual(labels.map(label => tasks.filter(t => t.label === label).length), [1, 1, 3]);
  assert.equal(aborted.length, 1); assert.equal(aborted[0].state.result.taskId, "14"); assert.equal(aborted[0].label, "autonomy");
  assert.equal(planners.length, 6); assert.ok(planners.every(p => p.label === "autonomy"));
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
    const taskReports: any[] = [], abortedReports: any[] = [], plannerReports: any[] = [], depositReports: any[] = [];
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
      const accepted = await receipt(result.acceptTxHash, contracts.escrow, agent.agent.wallet);
      const accepts = events(accepted, escrow, "TaskAccepted").filter(e => e.args.taskId === BigInt(taskId)); assert.equal(accepts.length, 1);
      assert.equal(accepts[0].args.agentId, BigInt(agentId)); address(accepts[0].args.wallet, agent.agent.wallet);
      assert.ok(accepted.blockNumber <= payment.paid.blockNumber);
      assert.equal(result.paymentTxHash, payment.paid.hash); assert.equal(result.paymentId, payment.public.paymentId);
      assert.equal(result.fromCashRaw, payment.public.fromCashRaw); assert.equal(result.fromCreditRaw, payment.public.fromCreditRaw);
      assert.equal(result.chargedRaw, payment.public.priceRaw); assert.equal(result.refundedRaw, "0");
      const allowance = purchase.inference.result, savedReceipt = purchase.inference.receipt;
      const relay = await readJson(join(directory, "allowance", `${payment.public.paymentId}.json`));
      assert.equal(relay.state, "Delivered"); assert.equal(relay.operatorCompensation, undefined); assert.equal(relay.refunds.length, 0);
      assert.deepEqual(relay.quote, purchase.handle.quote); assert.deepEqual(relay.request, purchase.handle.input);
      assert.deepEqual(relay.result, allowance); assert.deepEqual(relay.receipt, savedReceipt);
      assert.equal(allowance.kind, "inference-allowance"); assert.equal(allowance.taskId, taskId); assert.equal(allowance.agentId, agentId); assert.equal(allowance.paymentId, payment.public.paymentId);
      assert.equal(allowance.creditsRaw, purchase.config.creditsRaw); assert.equal(allowance.modelCatalogDigest, modelCatalogDigest(purchase.config.catalog));
      assert.deepEqual(purchase.handle.input.allowance, { creditsRaw: allowance.creditsRaw, modelCatalogDigest: allowance.modelCatalogDigest });
      assert.equal(savedReceipt.upstream, "allowance-ledger"); assert.equal(savedReceipt.model, "inference-allowance-v1"); assert.equal(savedReceipt.usage.llmInvocations, 0);
      assert.equal(ledger.closure, undefined);
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
        acceptance: proof(accepted), payment: payment.public, settlement: { ...proof(settled), passed: true, principalRepaidRaw: String(repaid.principal), feeRepaidRaw: String(repaid.fee), repaidRaw: String(settlement.repaid), slashedRaw: "0", residualRaw: String(settlement.toAgent) },
        loan: { status: "Repaid", principalOutstandingRaw: "0", feeOutstandingRaw: "0" }, allowance: { creditsRaw: grant.credits, spentCreditsRaw: String(spent), catalogDigest: allowance.modelCatalogDigest }, models });
    }
    for (const { state, label, path } of aborted) {
      const result = state.result, taskId = result.taskId, agent = journal.agents[label], agentId = agent.financeAfter.agentId;
      assert.equal(result.reason, "WORKFLOW_REFUNDED_TASK_TERMINATED"); assert.equal(result.chargedRaw, "0"); assert.equal(result.refundedRaw, "120000");
      assert.equal(state.snapshot.workflow.agentId, agentId); address(state.snapshot.wallet, agent.agent.wallet);
      const purchase = await readJson(join(path, "workflow", "metered", "allowance-purchase", "session.json"));
      const ledger = await readJson(join(path, "workflow", "metered", "inference-ledger", "session.json"));
      const paid = await checkPayment(purchase, label, taskId, true), id = paid.public.paymentId;
      assert.equal(result.paymentId, id); assert.equal(result.paymentTxHash, paid.paid.hash);
      assert.equal(paid.public.priceRaw, "120000"); assert.equal(paid.public.fromCashRaw, "40000"); assert.equal(paid.public.fromCreditRaw, "80000");
      const relay = await readJson(join(directory, "allowance", `${id}.json`));
      assert.equal(relay.state, "Refunded"); assert.ok(validOperatorCompensation(relay), "AUDIT_INVALID_COMPENSATION");
      assert.ok(validGatewayClosure(ledger, relay.operatorCompensation.closure), "AUDIT_LEDGER_NOT_SEALED");
      assert.equal(relay.operatorCompensation.certificateDigest, allowanceCertificateDigest(ledger.closure));
      assert.deepEqual(relay.quote, purchase.handle.quote); assert.deepEqual(relay.request, purchase.handle.input);
      assert.deepEqual(relay.result, purchase.inference.result); assert.deepEqual(relay.receipt, purchase.inference.receipt);
      assert.equal(relay.proof.txHash, paid.paid.hash); assert.equal(relay.proof.blockHash, paid.paid.blockHash); assert.equal(relay.proof.blockNumber, paid.paid.blockNumber);
      assert.equal(ledger.binding.agentId, agentId); assert.equal(ledger.binding.taskId, taskId); address(ledger.binding.wallet, agent.agent.wallet);
      assert.equal(ledger.grants[0].source.txHash, paid.paid.hash); assert.equal(ledger.grants[0].credits, purchase.inference.result.creditsRaw);
      assert.equal(purchase.inference.result.creditsRaw, purchase.config.creditsRaw);
      assert.equal(purchase.inference.result.modelCatalogDigest, modelCatalogDigest(purchase.config.catalog));
      assert.deepEqual(purchase.handle.input.allowance, { creditsRaw: purchase.config.creditsRaw, modelCatalogDigest: modelCatalogDigest(purchase.config.catalog) });
      assert.deepEqual(ledger.catalog, [...purchase.config.catalog].sort((a: any, b: any) => a.id.localeCompare(b.id)));
      assert.equal(purchase.inference.receipt.usage.llmInvocations, 0);
      const [task, loan] = await Promise.all([at(escrow, "getTask", [taskId]), at(manager, "getLoan", [taskId])]);
      assert.equal(task.agentId, BigInt(agentId)); assert.equal(task.status, 4n); assert.equal(task.escrowBalance, 0n); assert.equal(task.reward, 150000n);
      assert.equal(loan.agentId, BigInt(agentId)); assert.equal(loan.status, 4n); assert.equal(loan.principal + loan.fee, 0n);
      const accepted = await receipt(result.acceptTxHash, contracts.escrow, agent.agent.wallet);
      const accepts = events(accepted, escrow, "TaskAccepted").filter(e => e.args.taskId === BigInt(taskId)); assert.equal(accepts.length, 1);
      assert.equal(accepts[0].args.agentId, BigInt(agentId)); address(accepts[0].args.wallet, agent.agent.wallet);
      const opened = events(paid.paid, manager, "LoanOpened").filter(e => e.args.taskId === BigInt(taskId)); assert.equal(opened.length, 1);
      assert.equal(opened[0].args.agentId, BigInt(agentId)); assert.equal(opened[0].args.amount, 80000n);
      assert.equal(relay.refunds.length, 1); const refund = relay.refunds[0]; assert.equal(refund.state, "Confirmed"); assert.equal(refund.amount, "120000");
      const refunded = await receipt(refund.transaction.txHash, contracts.manager, await at(manager, "relayRefunder"));
      assert.ok(accepted.blockNumber <= paid.paid.blockNumber && paid.paid.blockNumber <= refunded.blockNumber);
      const refunds = events(refunded, manager, "RefundProcessed"); assert.equal(refunds.length, 1);
      const r = refunds[0].args; assert.equal(r.paymentId, id); assert.equal(r.refundId, refund.id); assert.equal(r.amount, 120000n);
      assert.equal(r.debtReduced, 92000n); assert.equal(r.toCash, 40000n); assert.equal(await at(account, "refundConsumed", [refund.id]), true);
      const closed = events(refunded, manager, "LoanClosedByRefund"); assert.equal(closed.length, 1);
      assert.equal(closed[0].args.taskId, BigInt(taskId)); assert.equal(closed[0].args.principalForgiven, 80000n); assert.equal(closed[0].args.feeForgiven, 12000n);
      const beforeRefund = await at(manager, "getLoan", [taskId], refunded.blockNumber - 1);
      assert.equal(beforeRefund.status, 1n); assert.equal(beforeRefund.principal, 80000n); assert.equal(beforeRefund.fee, 12000n);
      assert.equal(beforeRefund.fee, beforeRefund.principal * paid.feeBps / 10000n);
      assert.equal(events(refunded, manager, "LoanRepaid").length, 0); assert.equal(events(refunded, manager, "LoanDefaulted").length, 0);
      const operation = await readJson(join(directory, "allowance-resolution", id, "session.json"));
      assert.equal(operation.abortCompleted, true); assert.deepEqual(operation.closure, ledger.closure);
      assert.equal(operation.evidenceDigest, keccak256(toUtf8Bytes(canonical(operation.evidence))));
      assert.equal(operation.evidence.paymentId, id); assert.equal(operation.evidence.paymentTxHash, paid.paid.hash);
      assert.equal(operation.evidence.agentId, agentId); assert.equal(operation.evidence.taskId, taskId); assert.equal(operation.evidence.ledgerDigest, ledger.closure.expectedLedgerDigest);
      assert.deepEqual(operation.evidence.unknownCalls, ledger.invocations.map((call: any) => ({ id: call.id, requestDigest: call.requestDigest,
        state: call.state, httpStatus: call.response?.status ?? null, responseDigest: call.response ? sha(call.response) : null })));
      assert.equal(operation.evidenceDigest, relay.operatorCompensation.evidenceDigest); assert.equal(operation.resolutionId, relay.operatorCompensation.resolutionId);
      assert.equal(operation.refundId, refund.id); assert.equal(operation.parentRequestId, "910f477d-8bed-4e80-b4cd-69fffcbb8e78");
      const stopped = await receipt(operation.abortResult.txHash, contracts.escrow, verifier);
      assert.ok(stopped.blockNumber >= refunded.blockNumber); assert.equal(operation.abortResult.blockHash, stopped.blockHash); assert.equal(operation.abortResult.blockNumber, stopped.blockNumber);
      const settlements = events(stopped, escrow, "TaskSettled"); assert.equal(settlements.length, 1); const settled = settlements[0].args;
      assert.equal(settled.taskId, BigInt(taskId)); assert.equal(settled.passed, false); assert.equal(settled.repaid, 0n); assert.equal(settled.slashed, 0n); assert.equal(settled.toAgent, 0n);
      assert.equal(events(stopped, manager, "LoanRepaid").length, 0); assert.equal(events(stopped, manager, "LoanDefaulted").length, 0);
      const token = new Contract(bootstrap.asset.address, ["event Transfer(address indexed from,address indexed to,uint256 value)"], rpc);
      const returned = events(stopped, token, "Transfer").filter(e => sameAddress(e.args.from, contracts.escrow) && sameAddress(e.args.to, task.poster));
      assert.equal(returned.length, 1); assert.equal(returned[0].args.value, task.reward); assert.equal(operation.abortResult.rewardReturnedRaw, String(task.reward));
      const unknown = ledger.invocations.map((call: any) => {
        assert.equal(call.state, "Unknown"); assert.equal(call.result, undefined); assert.equal(call.requestDigest, sha(call.request));
        const model = ledger.catalog.find((m: any) => m.id === call.modelId); assert.ok(model); assert.equal(call.request.model, model.model);
        return { invocationId: call.id, state: "Unknown", modelId: call.modelId, requestModel: call.request.model, requestDigest: call.requestDigest,
          reason: call.error ?? null, responseStatus: call.response?.status ?? null, responseDigest: call.response ? sha(call.response) : null, usage: null, supplierCostKnown: false };
      });
      abortedReports.push({ label, taskId, agentId, taskStatus: "Failed", loanStatus: "ClosedByRefund", countedAsRepayment: false, countedAsDefault: false,
        acceptance: proof(accepted), payment: paid.public, originalAllowanceDelivered: true, originalReceiptDigest: sha(relay.receipt),
        allowance: { creditsRaw: ledger.grants[0].credits, grantPaymentId: id, grantTxHash: paid.paid.hash, catalogDigest: purchase.inference.result.modelCatalogDigest },
        sealedLedger: ledger.closure, operatorCompensation: relay.operatorCompensation, unknownInvocations: unknown,
        refund: { ...proof(refunded), refundId: refund.id, amountRaw: String(r.amount), debtReducedRaw: String(r.debtReduced), toCashRaw: String(r.toCash), principalClosedRaw: "80000", feeClosedRaw: "12000" },
        termination: { ...proof(stopped), passed: false, repaidRaw: "0", slashedRaw: "0", residualRaw: "0", poster: task.poster, rewardReturnedRaw: String(task.reward) } });
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
    const oldParentId = "910f477d-8bed-4e80-b4cd-69fffcbb8e78", recoveredParentId = "f9e2498c-da47-4911-a8f3-60cb68d2e13a", newParentId = journal.runs.autonomy.input.requestId;
    assert.notEqual(newParentId, oldParentId); assert.notEqual(newParentId, recoveredParentId); assert.equal(parentReports.size, 3, "AUDIT_UNEXPECTED_AUTONOMY_PARENT");
    const oldRun = database.runs.find((run: any) => run.requestId === oldParentId), newRun = database.runs.find((run: any) => run.requestId === newParentId);
    assert.ok(oldRun && newRun); assert.equal(oldRun.action, "autonomous"); assert.equal(newRun.action, "autonomous");
    assert.equal(oldRun.agentId, journal.agents.autonomy.agent.id); assert.equal(newRun.agentId, oldRun.agentId);
    assert.equal(oldRun.status, "Failed"); assert.equal(oldRun.result.success, false); assert.equal(oldRun.result.terminal, true);
    assert.equal(oldRun.result.chargedRaw, "10000"); assert.equal(oldRun.result.refundedRaw, "130000"); assert.equal(oldRun.result.autonomousTasks, 0);
    assert.equal(oldRun.result.reason, "WORKFLOW_REFUNDED_TASK_TERMINATED");
    assert.deepEqual(journal.runs["autonomy-aborted"].result.result, oldRun.result);
    assert.equal(newRun.status, "Succeeded"); assert.equal(newRun.result.success, true); assert.equal(newRun.result.autonomousTasks, 2);
    assert.deepEqual(journal.runs.autonomy.result.result, newRun.result);
    const oldParent = parentReports.get(oldParentId), newParent = parentReports.get(newParentId); assert.ok(oldParent && newParent);
    assert.equal(oldParent.phase, "Stopped"); assert.equal(oldParent.completedTasks, 0); assert.equal(oldParent.decisions, 2);
    assert.equal(oldParent.netChargedRaw, "10000"); assert.equal(oldParent.grossSpendRaw, "140000");
    assert.equal(newParent.phase, "Completed"); assert.equal(newParent.completedTasks, 2); assert.equal(newParent.decisions, 2);
    assert.equal(newParent.netChargedRaw, "260000"); assert.equal(newParent.grossSpendRaw, "260000");
    Object.assign(oldParent, { status: "Failed", refundedRaw: "130000", successfulTaskIds: [], failedTaskIds: ["14"] });
    Object.assign(newParent, { status: "Succeeded", refundedRaw: "0", successfulTaskIds: ["16", "17"], failedTaskIds: [] });
    const recoveredEntry = journal.runs["autonomy-single-completed"]; assert.equal(recoveredEntry?.input.requestId, recoveredParentId);
    const recoveredRun = database.runs.find((run: any) => run.requestId === recoveredParentId), recoveredParent = parentReports.get(recoveredParentId);
    assert.ok(recoveredEntry && recoveredRun && recoveredParent); assert.equal(recoveredRun.agentId, oldRun.agentId);
    assert.equal(recoveredRun.status, "Failed"); assert.equal(recoveredRun.reason, "AUTONOMY_INVALID_DECISION"); assert.equal(recoveredRun.result.autonomousTasks, 1);
    assert.equal(recoveredRun.chargedRaw, "140000"); assert.equal(recoveredRun.result.refundedRaw, "0"); assert.deepEqual(recoveredEntry.result.result, recoveredRun.result);
    assert.equal(recoveredParent.phase, "Stopped"); assert.equal(recoveredParent.completedTasks, 1); assert.equal(recoveredParent.decisions, 2);
    assert.equal(recoveredParent.netChargedRaw, "140000"); assert.equal(recoveredParent.grossSpendRaw, "140000");
    Object.assign(recoveredParent, { status: "Failed", reason: recoveredRun.reason, refundedRaw: "0", successfulTaskIds: ["15"], failedTaskIds: [] });
    const parentPath = join(directory, "hosted", "agents", journal.agents.autonomy.agent.id, "runs", recoveredParentId);
    const recoveredLoop = await readJson(join(parentPath, "autonomy-loop", "session.json"));
    const recoveredHost = await readJson(join(parentPath, "autonomy-host", "session.json"));
    const beforeRecovery = recoveredEntry.beforeCachedDecisionRecovery, recovery = recoveredRun.terminalRecovery;
    assert.equal(beforeRecovery?.requestId, recoveredParentId); assert.equal(beforeRecovery.status, "Failed"); assert.equal(beforeRecovery.action, "autonomous");
    assert.equal(beforeRecovery.reason, "AUTONOMY_INVALID_DECISION"); assert.equal(beforeRecovery.chargedRaw, "10000"); assert.equal(beforeRecovery.result.autonomousTasks, 0);
    assert.equal(beforeRecovery.result.success, false); assert.equal(beforeRecovery.result.terminal, true); assert.equal(beforeRecovery.terminalRecovery, undefined);
    assert.equal(recovery?.kind, "cached-planner"); assert.equal(recovery.previousReason, beforeRecovery.reason); assert.equal(recovery.rebasedChargedRaw, beforeRecovery.chargedRaw);
    assert.deepEqual(recovery.previousResult, beforeRecovery.result);
    assert.equal(recoveredEntry.result.terminalRecovery, undefined, "Public frontend responses must omit internal recovery metadata");
    assert.equal(recoveredHost.input.run.requestId, recoveredParentId); assert.equal(recoveredHost.input.run.terminalRecovery, undefined);
    assert.equal(recoveredHost.controller.maxSpendRaw, beforeRecovery.reservedRaw); assert.equal(recoveredRun.reservedRaw, beforeRecovery.reservedRaw);
    assert.deepEqual(recoveredHost.controller, recoveredLoop.config); assert.ok(Date.parse(recovery.at) < recoveredLoop.config.deadlineMs);
    const firstStep = recoveredLoop.steps[0], firstPlanner = planners.find(p => basename(p.path) === firstStep.decisionId && dirname(dirname(p.path)) === parentPath);
    assert.ok(firstPlanner); assert.deepEqual(firstPlanner.state.context, firstStep.context);
    assert.equal(firstStep.context.deadlineMs, recoveredLoop.config.deadlineMs); assert.equal(firstStep.context.remainingSpendRaw, beforeRecovery.reservedRaw);
    assert.equal(firstStep.decisionChargedRaw, beforeRecovery.chargedRaw); assert.equal(firstPlanner.state.handle.quote.price, beforeRecovery.chargedRaw);
    const originalDecisionText = firstPlanner.state.inference.result.choices[0].message.content;
    assert.match(originalDecisionText, /^\s*```json\r?\n[\s\S]*\r?\n```\s*$/);
    assert.deepEqual(parseAutonomyDecision(originalDecisionText, recoveredLoop.config), firstStep.decision);
    assert.equal(plannerReports.filter(p => p.payment.paymentId === firstPlanner.state.handle.quote.paymentId).length, 1);
    Object.assign(recoveredParent, { cachedDecisionRecovery: { kind: recovery.kind, at: recovery.at, previousStatus: beforeRecovery.status,
      previousReason: recovery.previousReason, previousResult: recovery.previousResult, rebasedChargedRaw: recovery.rebasedChargedRaw,
      decisionId: firstStep.decisionId, paymentId: firstPlanner.state.handle.quote.paymentId, responseDigest: sha(firstPlanner.state.inference.result),
      preservedDeadlineMs: recoveredLoop.config.deadlineMs, preservedBudgetRaw: beforeRecovery.reservedRaw, originalPlannerReused: true } });
    assert.equal(recoveredLoop.startedTasks, 1); assert.equal(recoveredLoop.config.sessionId, recoveredParentId);
    assert.equal(recoveredLoop.reason, "AUTONOMY_INVALID_DECISION"); assert.ok(head.timestamp * 1000 >= recoveredLoop.config.deadlineMs, "AUDIT_OLD_PARENT_DEADLINE_NOT_EXPIRED");
    assert.equal(recoveredLoop.steps[0].outcome.success, true); assert.equal(recoveredLoop.steps[0].outcome.chargedRaw, "120000");
    const task15 = tasks.find(t => t.path === join(parentPath, "children", recoveredLoop.steps[0].childId, "task-executor")); assert.equal(task15?.state.result.taskId, "15");
    const rejectedStep = recoveredLoop.steps[1]; assert.equal(rejectedStep.decision, undefined); assert.equal(rejectedStep.childId, undefined); assert.equal(rejectedStep.outcome, undefined);
    const rejectedPlanner = planners.find(p => basename(p.path) === rejectedStep.decisionId && dirname(dirname(p.path)) === parentPath); assert.ok(rejectedPlanner);
    assert.equal(rejectedStep.decisionChargedRaw, "10000"); assert.deepEqual(rejectedPlanner.state.context, rejectedStep.context);
    const rejectedText = rejectedPlanner.state.inference.result.choices[0].message.content;
    // Preserve this delivered but rejected stop request; it is neither an unknown call nor a task success.
    const stop = JSON.parse(rejectedText.trim().replace(/^```json\r?\n([\s\S]*?)\r?\n```$/, "$1"));
    assert.equal(stop.action, "stop"); assert.ok(typeof stop.reason === "string" && stop.reason.length > 240);
    Object.assign(recoveredParent, { rejectedDecision: { decisionId: rejectedStep.decisionId, paymentId: rejectedPlanner.state.handle.quote.paymentId,
      action: "stop", reasonLength: stop.reason.length, responseDigest: sha(rejectedPlanner.state.inference.result), chargedRaw: "10000", classification: "DeliveredParserRejected" } });
    const newParentPath = join(directory, "hosted", "agents", journal.agents.autonomy.agent.id, "runs", newParentId);
    const newLoop = await readJson(join(newParentPath, "autonomy-loop", "session.json")), host = await readJson(join(newParentPath, "autonomy-host", "session.json"));
    assert.deepEqual(host.controller, newLoop.config); assert.equal(newRun.terminalRecovery, undefined);
    assert.equal(newLoop.config.maxSpendRaw, "300000"); assert.equal(newRun.reservedRaw, "300000");
    assert.equal(host.input.agent.spentRaw, "150000"); assert.equal(host.input.agent.totalBudgetRaw, "450000");
    const budgetChange = journal.completionBudget; assert.ok(budgetChange, "AUDIT_BUDGET_CHANGE_EVIDENCE_MISSING");
    assert.equal(budgetChange.before.id, journal.agents.autonomy.agent.id); assert.equal(budgetChange.after.id, budgetChange.before.id);
    assert.equal(budgetChange.before.totalBudgetRaw, "300000"); assert.equal(budgetChange.before.spentRaw, "150000");
    assert.equal(budgetChange.settings.totalBudgetRaw, "450000"); assert.equal(budgetChange.after.totalBudgetRaw, "450000");
    assert.equal(budgetChange.after.spentRaw, "150000"); assert.equal(budgetChange.after.reservedRaw, "0"); assert.equal(budgetChange.after.activeRequestId, undefined);
    for (const key of ["name", "modelId", "strategy", "perRunBudgetRaw", "allowCredit"]) {
      assert.equal(budgetChange.settings[key], budgetChange.before[key]); assert.equal(budgetChange.after[key], budgetChange.settings[key]);
      assert.equal(host.input.agent[key], budgetChange.after[key]);
    }
    assert.equal(host.input.agent.totalBudgetRaw, budgetChange.after.totalBudgetRaw);
    assert.equal(recoveredHost.input.agent.totalBudgetRaw, budgetChange.before.totalBudgetRaw);
    const budgetReport = { beforeRaw: budgetChange.before.totalBudgetRaw, afterRaw: budgetChange.after.totalBudgetRaw,
      spentAtChangeRaw: budgetChange.before.spentRaw, newParentReservedRaw: newRun.reservedRaw, source: "Persisted authenticated hosted PATCH response", preservedPriorParentBudgetRaw: recoveredRun.reservedRaw };
    assert.equal(newLoop.startedTasks, 2); assert.equal(newLoop.config.sessionId, newParentId);
    const orderedTasks = newLoop.steps.map((step: any) => {
      assert.equal(step.decision.action, "run-task"); assert.equal(step.outcome.terminal, true); assert.equal(step.outcome.success, true);
      assert.equal(step.outcome.chargedRaw, "120000"); assert.equal(step.outcome.refundedRaw ?? "0", "0");
      assert.equal(step.context.deadlineMs, newLoop.config.deadlineMs); assert.equal(step.childLimits.deadlineMs, newLoop.config.deadlineMs);
      assert.equal(host.children[step.childId].deadlineMs, newLoop.config.deadlineMs);
      assert.equal(step.decisionChargedRaw, "10000"); assert.equal(step.decisionRefundedRaw ?? "0", "0");
      const child = tasks.find(t => t.path === join(newParentPath, "children", step.childId, "task-executor")); assert.ok(child, "AUDIT_PARENT_CHILD_MISMATCH");
      assert.equal(child.state.snapshot.request, step.childId); return child.state.result.taskId;
    });
    assert.deepEqual(orderedTasks, ["16", "17"], "AUDIT_CONTINUOUS_TWO_TASKS_REQUIRED");
    assert.ok(taskReports.find(t => t.taskId === "16").settlement.blockNumber <= taskReports.find(t => t.taskId === "17").acceptance.blockNumber);
    assert.equal(plannerReports.filter(p => p.status === "UnknownRefunded").length, 1); assert.equal(plannerReports.length, 6);
    // Audit every successful deposit through its actual transaction; only those
    // after the initial finance snapshot enter the continuation cash waterfall.
    for (const label of labels) {
      const agent = journal.agents[label], agentId = agent.financeAfter.agentId;
      const deposits = database.runs.filter((run: any) => run.agentId === agent.agent.id && run.action === "deposit");
      for (const deposit of deposits) {
        assert.equal(deposit.status, "Succeeded"); assert.equal(deposit.result.success, true);
        const tx = await receipt(deposit.result.txHash, contracts.account, agent.agent.wallet);
        const credited = events(tx, account, "CashCredited").filter(e => e.args.agentId === BigInt(agentId)); assert.equal(credited.length, 1);
        assert.equal(credited[0].args.amount, BigInt(deposit.amountRaw)); address(credited[0].args.from, agent.agent.wallet);
        const transaction = await rpc.getTransaction(tx.hash); assert.ok(transaction); assert.equal(transaction.chainId, 10143n);
        const decoded = account.interface.parseTransaction({ data: transaction.data, value: transaction.value }); assert.equal(decoded?.name, "depositCash");
        assert.equal(decoded!.args[0], BigInt(agentId)); assert.equal(decoded!.args[1], BigInt(deposit.amountRaw));
        depositReports.push({ label, agentId, requestId: deposit.requestId, amountRaw: deposit.amountRaw, afterInitialSnapshot: tx.blockNumber > agent.financeBefore.block.number, ...proof(tx) });
      }
    }
    const continuation = depositReports.filter(d => d.afterInitialSnapshot).sort((a, b) => a.blockNumber - b.blockNumber); assert.equal(continuation.length, 2);
    assert.equal(continuation[0].label, "autonomy"); assert.equal(continuation[0].amountRaw, "10000");
    assert.equal(continuation[0].requestId, journal.runs["autonomy-continuation-deposit"].input.requestId);
    assert.equal(continuation[1].label, "autonomy"); assert.equal(continuation[1].amountRaw, "2000");
    assert.equal(continuation[1].requestId, journal.runs["autonomy-completion-deposit"].input.requestId);
    const continuationBefore = journal.agents.autonomy.continuationBefore; assert.equal(continuationBefore.status, "confirmed"); assert.equal(continuationBefore.cashRaw, "50000"); assert.equal(continuationBefore.debtRaw, "0");
    await checkBlock(continuationBefore.block.number, continuationBefore.block.hash);
    assert.equal(String(await at(account, "cash", [journal.agents.autonomy.financeAfter.agentId], continuationBefore.block.number)), continuationBefore.cashRaw);
    assert.ok(continuation[0].blockNumber <= continuationBefore.block.number);
    const firstRecoveredPlanner = plannerReports.find(p => p.payment.paymentId === firstPlanner.state.handle.quote.paymentId);
    assert.ok(firstRecoveredPlanner && firstRecoveredPlanner.payment.blockNumber > continuationBefore.block.number);
    const completionBefore = journal.agents.autonomy.completionBefore; assert.equal(completionBefore.status, "confirmed"); assert.equal(completionBefore.cashRaw, "50000"); assert.equal(completionBefore.debtRaw, "0");
    await checkBlock(completionBefore.block.number, completionBefore.block.hash);
    assert.equal(String(await at(account, "cash", [journal.agents.autonomy.financeAfter.agentId], completionBefore.block.number)), completionBefore.cashRaw);
    assert.equal(completionBefore.counts.repayments, "1"); assert.equal(completionBefore.credit.score, "570"); assert.equal(completionBefore.credit.tier, "C");
    assert.ok(continuation[1].blockNumber <= completionBefore.block.number);
    assert.ok(continuation[1].blockNumber > plannerReports.find(p => p.decisionId === rejectedStep.decisionId).payment.blockNumber);
    const firstNewPlanner = plannerReports.find(p => p.parentRequestId === newParentId); assert.ok(firstNewPlanner && firstNewPlanner.payment.blockNumber > completionBefore.block.number);
    const next = await at(escrow, "nextTaskId"); assert.ok(next <= 201n, "AUDIT_LEDGER_LIMIT");
    let outstanding = 0n; const activeLoans: any[] = [];
    for (let id = 1n; id < next; id++) { const loan = await at(manager, "getLoan", [id]); if (loan.status === 1n) { outstanding += loan.principal + loan.fee; activeLoans.push({ taskId: String(id), agentId: String(loan.agentId), debtRaw: String(loan.principal + loan.fee) }); } }
    const totalOutstanding = await at(manager, "totalOutstanding"); assert.equal(totalOutstanding, outstanding);
    const agents: any[] = [];
    for (const label of labels) {
      const entry = journal.agents[label], before = entry.financeBefore, after = entry.financeAfter, id = after.agentId;
      const hostedAgent = database.agents.find((a: any) => a.id === entry.agent.id); assert.ok(hostedAgent);
      const recordedSpend = database.runs.filter((r: any) => r.agentId === entry.agent.id).reduce((sum: bigint, r: any) => {
        assert.ok(["Succeeded", "Failed"].includes(r.status)); return sum + BigInt(r.chargedRaw);
      }, 0n);
      assert.equal(hostedAgent.spentRaw, String(recordedSpend)); assert.equal(hostedAgent.reservedRaw, "0"); assert.equal(hostedAgent.activeRequestId, undefined);
      if (label === "autonomy") { assert.equal(recordedSpend, 410000n); assert.equal(hostedAgent.totalBudgetRaw, "450000"); }
      address(after.wallet, entry.agent.wallet); assert.equal(before.agentId, id); await checkBlock(after.block.number, after.block.hash); await checkBlock(before.block.number, before.block.hash);
      // The deployed adapter artifact has unnamed return values (owner, wallet).
      const identity = await at(adapter, "resolveAgent", [id]); address(identity[0], entry.agent.wallet); address(identity[1], entry.agent.wallet);
      const [cash, repayments, defaults] = await Promise.all([at(account, "cash", [id]), at(manager, "repaymentCount", [id]), at(manager, "defaultCount", [id])]);
      const registry = new Contract(reputation, (await artifact("IReputationRegistry")).abi, rpc);
      const summaries = await Promise.all(["repayment", "task-success", "default"].map(tag => at(registry, "getSummary", [id, [contracts.adapter], "infercredit", tag])));
      const mirror = { repayment: BigInt(summaries[0].count), success: BigInt(summaries[1].count), default: BigInt(summaries[2].count) };
      const terms = creditTerms(mirror, repayments);
      assert.equal(String(mirror.repayment), after.counts.mirrorRepayments); assert.equal(String(mirror.success), after.counts.successes); assert.equal(String(mirror.default), after.counts.mirrorDefaults);
      assert.equal(String(terms.score), after.credit.score); assert.equal(terms.tier, after.credit.tier);
      assert.equal(String(cash), after.cashRaw); assert.equal(String(repayments), after.counts.repayments); assert.equal(String(defaults), after.counts.defaults);
      assert.equal(String(await at(account, "cash", [id], before.block.number)), before.cashRaw);
      assert.equal(String(await at(account, "cash", [id], after.block.number)), after.cashRaw);
      assert.equal(String(await at(manager, "repaymentCount", [id], before.block.number)), before.counts.repayments);
      assert.equal(String(await at(manager, "defaultCount", [id], before.block.number)), before.counts.defaults);
      const owned = taskReports.filter(t => t.label === label), failed = abortedReports.filter(t => t.label === label), planning = plannerReports.filter(t => t.label === label);
      const extraDeposit = depositReports.filter(d => d.label === label && d.afterInitialSnapshot).reduce((s, d) => s + BigInt(d.amountRaw), 0n);
      const expected = BigInt(before.cashRaw) + extraDeposit + owned.reduce((s, t) => s + BigInt(t.settlement.residualRaw) - BigInt(t.payment.fromCashRaw), 0n)
        + failed.reduce((s, t) => s + BigInt(t.refund.toCashRaw) - BigInt(t.payment.fromCashRaw), 0n)
        - planning.reduce((s, t) => s + BigInt(t.payment.fromCashRaw) - BigInt(t.refundedRaw), 0n);
      assert.equal(cash, expected, "AUDIT_CASH_WATERFALL_MISMATCH"); assert.equal(repayments, BigInt(before.counts.repayments) + BigInt(owned.length));
      assert.equal(defaults, BigInt(before.counts.defaults)); assert.equal(after.debtRaw, "0"); assert.ok(!activeLoans.some(l => l.agentId === id));
      assert.equal(after.ownedTaskCount, before.ownedTaskCount + owned.length + failed.length);
      if (label !== "autonomy") assert.equal(cash, 58000n); assert.equal(defaults, 0n); assert.equal(repayments, label === "autonomy" ? 3n : 1n);
      if (label === "autonomy") { assert.equal(after.credit.score, "710"); assert.equal(after.credit.tier, "A"); }
      agents.push({ label, agentId: id, wallet: entry.agent.wallet, cashBeforeRaw: before.cashRaw, cashAfterRaw: String(cash), debtRaw: "0", repayments: String(repayments), defaults: String(defaults),
        additionalDepositsRaw: String(extraDeposit), creditScore: String(terms.score), creditTier: terms.tier,
        reputation: { client: contracts.adapter, repayments: String(mirror.repayment), successes: String(mirror.success), defaults: String(mirror.default) },
        apiSnapshot: { source: "acceptance.json financeAfter (real hosted API response)", block: after.block, cashRaw: after.cashRaw, debtRaw: after.debtRaw, matchesFreshFixedBlock: true } });
    }
    assert.ok(taskReports.some(t => t.models.some((m: any) => m.responseModel === "kimi-k2.6"))); assert.ok(taskReports.some(t => t.models.some((m: any) => m.responseModel === "kimi-k3")));
    // Recheck every receipt/API block after all reads; do not publish a mixed-fork audit.
    for (const [number, hash] of checkedBlocks) assert.equal((await rpc.getBlock(number))?.hash, hash, "AUDIT_REORG_DURING_READ");
    for (const [file, digest] of inputDigests) assert.equal(createHash("sha256").update(await readFile(file, "utf8")).digest("hex"), digest, "AUDIT_JOURNAL_CHANGED_DURING_READ");
    assert.equal(BigInt(await rpc.send("eth_chainId", [])), 10143n);
    const publicDirectory = resolve("frontend/acceptance/monad-hosted-20261012"); await mkdir(publicDirectory, { recursive: true });
    const output = join(publicDirectory, "final-canonical-audit.json");
    await saveJson(output, { version: 1, passed: true, overallAcceptancePassed: true, observedAt: new Date().toISOString(), chainId: "10143", block: { number: head.number, hash: head.hash, timestamp: head.timestamp },
      boundary: "Read-only Monad testnet audit; prepaid allowance payments are distinct from provider-reported model token usage. No claim of vendor per-token onchain settlement.",
      contracts: { account: contracts.account, manager: contracts.manager, escrow: contracts.escrow, adapter: contracts.adapter, identity: bootstrap.identity, reputation, verifier },
      agents, tasks: taskReports, abortedTasks: abortedReports, deposits: depositReports, budgetChange: budgetReport, planners: plannerReports, autonomyParents: [...parentReports.values()],
      plannerCounts: { paidCalls: plannerReports.length, deliveredCalls: plannerReports.filter(p => p.status === "Delivered").length,
        unknownRefundedCalls: plannerReports.filter(p => p.status === "UnknownRefunded").length, dispatchAttempts: plannerReports.reduce((sum, p) => sum + p.dispatchAttempts.length, 0) }, global: { totalOutstandingRaw: String(totalOutstanding), scannedTaskCount: Number(next - 1n), activeLoans },
      checks: { canonicalReceipts: true, exactPaymentEvents: true, exactLoanRepaymentEvents: true, taskOwnership: true, settledLoans: true, cashWaterfall: true, apiBalances: true, originalResponseModelsAndUsage: true,
        unknownPlannerEvidencePreserved: true, unknownTaskEvidencePreserved: true, allowanceCompensationPreservesOriginalDelivery: true, canonicalFullRefunds: true,
        posterRewardReturned: true, abortedTaskIsNotRepayment: true, continuousNewParentTwoTasks: true, extraDepositReconciled: true, reputationMatchesCanonicalRegistry: true,
        grossDecisionBudgets: true, cachedPlannerReusedWithoutNewPayment: true, terminalRecoveryRebooksChargeOnce: true,
        originalDeadlineAndBudgetPreserved: true, readOnly: true, roleKeysRead: false, canonicalBlocksRechecked: checkedBlocks.size } });
    console.log(JSON.stringify({ passed: true, blockNumber: head.number, tasks: taskReports.map(t => t.taskId), output }));
  } finally { connection.close(); }
}
await main().catch(error => {
  reportDemoFailure(error);
  // Location-only diagnostics keep private RPC URLs and journal payloads out of logs.
  console.error(JSON.stringify({ auditFailure: error?.name, code: error?.code,
    location: String(error?.stack ?? "").split("\n").filter(line => line.includes("monad-hosted-completion-audit.ts")).slice(0, 2),
    ...(error?.name === "AssertionError" ? { operator: error.operator,
      actual: ["string", "number", "boolean", "bigint"].includes(typeof error.actual) ? String(error.actual).slice(0, 100) : typeof error.actual,
      expected: ["string", "number", "boolean", "bigint"].includes(typeof error.expected) ? String(error.expected).slice(0, 100) : typeof error.expected } : {}) }));
  process.exitCode = 1;
});
