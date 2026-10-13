import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { Contract, type TransactionReceipt } from "ethers";
import { canonical, paymentId, requestDigest, sameAddress } from "../packages/sdk/src/protocol.js";
import { validOperatorResolution } from "../services/provider-relay/src/store.js";
import { artifact, reportDemoFailure, saveJson } from "./demo-common.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";

// An observed-state audit, deliberately separate from the all-four-success gate.
// No signer, journal mutation, HTTP business request, replay or model invocation.
const directory = resolve(process.argv[2] ?? "demo-output/monad-hosted-20261012/runtime");
const json = async (path: string): Promise<any> => JSON.parse(await readFile(path, "utf8"));
const same = (a: string, b: string) => assert.ok(sameAddress(a, b), "OBSERVED_ADDRESS_MISMATCH");
const digest = (value: any) => createHash("sha256").update(canonical(value)).digest("hex");
async function main() {
  const ready = await json(join(directory, "ready.json")), bootstrap = await json(join(directory, "..", "bootstrap.json")), acceptance = await json(join(directory, "acceptance.json"));
  assert.equal(ready.chainId, "10143"); assert.equal(bootstrap.chainId, "10143");
  const taskFiles: { label: string; path: string; state: any }[] = [], plannerFiles: { path: string; state: any }[] = [];
  async function collect(path: string, label: string) {
    for (const child of await readdir(path, { withFileTypes: true })) {
      const file = join(path, child.name);
      if (child.isDirectory()) await collect(file, label);
      else if (child.name === "session.json" && ["task-executor", "planner"].includes(basename(path) === "task-executor" ? basename(path) : basename(dirname(path)))) {
        const state = await json(file);
        if (basename(path) === "task-executor" && state.result?.taskId) taskFiles.push({ label, path, state });
        else if (basename(dirname(path)) === "planner") plannerFiles.push({ path, state });
      }
    }
  }
  for (const label of ["cheap", "strong", "autonomy"]) await collect(join(directory, "hosted", "agents", acceptance.agents[label].agent.id), label);
  assert.deepEqual(taskFiles.map(t => t.state.result.taskId).sort(), ["12", "13", "14"]); assert.equal(plannerFiles.length, 2);
  const connection = await monadProvider(await readRpcUrlFile(ready.rpcUrlFile ?? bootstrap.rpcUrlFile), "direct"), rpc = connection.provider;
  try {
    assert.equal(BigInt(await rpc.send("eth_chainId", [])), 10143n);
    const latest = await rpc.getBlock("latest"); assert.ok(latest?.hash); const block = latest;
    const addresses = bootstrap.contracts;
    const account = new Contract(addresses.account, (await artifact("AgentAccount")).abi, rpc), manager = new Contract(addresses.manager, (await artifact("CreditManager")).abi, rpc);
    const escrow = new Contract(addresses.escrow, (await artifact("TaskEscrow")).abi, rpc);
    const at = (contract: Contract, name: string, args: unknown[] = [], number = block.number) => contract.getFunction(name).staticCall(...args, { blockTag: number });
    same(await at(account, "creditManager"), addresses.manager); same(await at(manager, "agentAccount"), addresses.account); same(await at(manager, "taskEscrow"), addresses.escrow);
    same(await at(account, "settlementAsset"), bootstrap.asset.address);
    const verifier = await at(escrow, "verifier"), refunder = await at(manager, "relayRefunder");
    const blocks = new Map<number, string>([[block.number, block.hash!]]);
    const proof = (receipt: TransactionReceipt) => ({ txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, from: receipt.from, to: receipt.to });
    async function receipt(hash: string, to: string, from: string) {
      const r = await rpc.getTransactionReceipt(hash); assert.ok(r, "OBSERVED_RECEIPT_MISSING"); assert.equal(r.status, 1); assert.equal(r.hash, hash);
      assert.ok(r.blockNumber <= block.number); same(r.to!, to); same(r.from, from); assert.equal((await rpc.getBlock(r.blockNumber))?.hash, r.blockHash);
      blocks.set(r.blockNumber, r.blockHash); return r;
    }
    function events(r: TransactionReceipt, contract: Contract, name: string) {
      return r.logs.filter(l => sameAddress(l.address, String(contract.target))).flatMap(l => { try { const e = contract.interface.parseLog(l); return e?.name === name ? [e.args] : []; } catch { return []; } });
    }
    const paidIds = new Set<string>();
    async function payment(handle: any, label: string, expectedTask: string, refunded = false) {
      const q = handle.quote, agent = acceptance.agents[label], id = agent.financeBefore.agentId;
      assert.equal(q.agentId, id); assert.equal(q.taskId, expectedTask); assert.equal(q.chainId, "10143");
      same(q.account, addresses.account); same(q.asset, bootstrap.asset.address); same(q.payTo, bootstrap.payTo);
      assert.equal(handle.input.agentId, id); assert.equal(handle.input.taskId, expectedTask); assert.equal(requestDigest(handle.input), q.requestDigest);
      assert.equal(paymentId(q.taskId, q.requestDigest, q.serverNonce), q.paymentId); assert.ok(!paidIds.has(q.paymentId)); paidIds.add(q.paymentId);
      const r = await receipt(handle.submission.txHash, addresses.account, agent.agent.wallet), record = await at(account, "getPayment", [q.paymentId]);
      const matches = events(r, account, "ProviderPaid").filter(e => e.paymentId === q.paymentId); assert.equal(matches.length, 1); const event = matches[0];
      assert.equal(record.agentId, BigInt(id)); assert.equal(event.agentId, record.agentId); same(event.provider, q.payTo);
      assert.equal(record.fromCash, event.fromCash); assert.equal(record.fromCredit, event.fromCredit); assert.equal(record.fromCash + record.fromCredit, BigInt(q.price));
      assert.equal(record.taskId, record.fromCredit > 0n ? BigInt(expectedTask) : 0n); assert.equal(record.refundedAmount, refunded ? BigInt(q.price) : 0n);
      const tx = await rpc.getTransaction(r.hash); assert.ok(tx); assert.equal(tx.chainId, 10143n);
      const decoded = account.interface.parseTransaction({ data: tx.data, value: tx.value }); assert.equal(decoded?.name, "payProvider"); const args = decoded!.args;
      assert.equal(args[0], BigInt(id)); same(args[1], q.payTo); assert.equal(args[2], BigInt(q.price)); assert.equal(args[3], q.paymentId);
      if (record.fromCredit > 0n) { assert.equal(args[4].agentId, BigInt(id)); assert.equal(args[4].taskId, BigInt(expectedTask)); }
      return { r, record, feeBps: args[4].feeBps as bigint, public: { ...proof(r), paymentId: q.paymentId, agentId: id, taskId: expectedTask,
        fromCashRaw: String(record.fromCash), fromCreditRaw: String(record.fromCredit), priceRaw: q.price, refundedRaw: String(record.refundedAmount), requestDigest: q.requestDigest } };
    }
    const tasks: any[] = [];
    for (const entry of taskFiles.sort((a, b) => Number(a.state.result.taskId) - Number(b.state.result.taskId))) {
      const result = entry.state.result, id = result.taskId, agent = acceptance.agents[entry.label], agentId = agent.financeBefore.agentId;
      const task = await at(escrow, "getTask", [id]), loan = await at(manager, "getLoan", [id]); assert.equal(task.agentId, BigInt(agentId)); assert.equal(loan.agentId, task.agentId);
      const accepted = await receipt(result.acceptTxHash, addresses.escrow, agent.agent.wallet);
      const accept = events(accepted, escrow, "TaskAccepted"); assert.equal(accept.length, 1); assert.equal(accept[0].taskId, BigInt(id)); assert.equal(accept[0].agentId, task.agentId); same(accept[0].wallet, agent.agent.wallet);
      const purchase = await json(join(entry.path, "workflow/metered/allowance-purchase/session.json")), ledger = await json(join(entry.path, "workflow/metered/inference-ledger/session.json"));
      const paid = await payment(purchase.handle, entry.label, id); assert.equal(paid.public.priceRaw, "120000"); assert.equal(paid.record.fromCash, 40000n); assert.equal(paid.record.fromCredit, 80000n);
      assert.equal(result.paymentTxHash, paid.r.hash); assert.equal(result.paymentId, paid.public.paymentId);
      const grantReceipt = purchase.inference.receipt; assert.equal(grantReceipt.txHash, paid.r.hash); assert.equal(grantReceipt.blockHash, paid.r.blockHash);
      assert.equal(grantReceipt.taskId, id); assert.equal(grantReceipt.paymentId, paid.public.paymentId); assert.equal(grantReceipt.upstream, "allowance-ledger");
      assert.equal(purchase.inference.result.kind, "inference-allowance"); assert.equal(purchase.inference.result.taskId, id); assert.equal(purchase.inference.result.agentId, agentId);
      assert.equal(ledger.binding.taskId, id); assert.equal(ledger.binding.agentId, agentId); same(ledger.binding.wallet, agent.agent.wallet);
      assert.equal(ledger.grants.length, 1); assert.equal(ledger.grants[0].source.paymentId, paid.public.paymentId); assert.equal(ledger.grants[0].source.txHash, paid.r.hash);
      const opened = events(paid.r, manager, "LoanOpened"); assert.equal(opened.length, 1); assert.equal(opened[0].taskId, BigInt(id)); assert.equal(opened[0].amount, 80000n);
      const modelCalls = ledger.invocations.map((v: any) => {
        const model = ledger.catalog.find((m: any) => m.id === v.modelId); assert.ok(model); assert.equal(v.request.model, model.model);
        assert.equal(v.requestDigest, digest(v.request));
        if (id === "14") { assert.equal(v.state, "Unknown"); assert.equal(v.response.status, 503); assert.equal(v.result, undefined); }
        else { assert.equal(v.state, "Completed"); assert.equal(v.response.status, 200); assert.deepEqual(v.result.response, v.response.body);
          const u = v.response.body.usage; assert.equal(v.response.body.model, model.responseModel ?? model.model); assert.equal(u.total_tokens, u.prompt_tokens + u.completion_tokens);
          assert.deepEqual(v.result.usage, { promptTokens: u.prompt_tokens, completionTokens: u.completion_tokens });
          assert.equal(v.result.chargedCredits, String(BigInt(u.prompt_tokens) * BigInt(model.inputMicroCreditsPerToken) + BigInt(u.completion_tokens) * BigInt(model.outputMicroCreditsPerToken))); }
        return { invocationId: v.id, state: v.state, requestModel: v.request.model, httpStatus: v.response.status, responseModel: v.state === "Completed" ? v.response.body.model : null,
          usage: v.state === "Completed" ? v.result.usage : null, requestDigest: v.requestDigest, responseDigest: digest(v.response.body) };
      });
      assert.equal(modelCalls.length, 1);
      let settlement: any = null;
      if (id !== "14") {
        assert.equal(result.phase, "Succeeded"); assert.equal(task.status, 3n); assert.equal(task.escrowBalance, 0n); assert.equal(loan.status, 2n); assert.equal(loan.principal + loan.fee, 0n);
        const r = await receipt(result.settlement.txHash, addresses.escrow, verifier), settled = events(r, escrow, "TaskSettled"), repaid = events(r, manager, "LoanRepaid");
        assert.equal(r.blockHash, result.settlement.block.hash); assert.equal(settled.length, 1); assert.equal(repaid.length, 1);
        assert.equal(settled[0].taskId, BigInt(id)); assert.equal(settled[0].passed, true); assert.equal(settled[0].repaid, 92000n); assert.equal(settled[0].slashed, 0n); assert.equal(settled[0].toAgent, 58000n);
        assert.equal(repaid[0].taskId, BigInt(id)); assert.equal(repaid[0].principal, 80000n); assert.equal(repaid[0].fee, 12000n);
        assert.equal(settled[0].toAgent + settled[0].repaid, BigInt(task.reward) - BigInt(task.reward) * BigInt(task.protocolFeeBps) / 10000n);
        settlement = { ...proof(r), principalRepaidRaw: "80000", feeRepaidRaw: "12000", repaidRaw: "92000", residualRaw: "58000", passed: true };
      } else {
        assert.equal(result.phase, "Paused"); assert.equal(result.reason, "UPSTREAM_DISPATCH_UNKNOWN"); assert.equal(task.status, 2n); assert.equal(task.escrowBalance, task.reward);
        assert.equal(loan.status, 1n); assert.equal(loan.principal, 80000n); assert.equal(loan.fee, 12000n); assert.equal(result.settlement, undefined);
      }
      tasks.push({ taskId: id, agentId, status: id === "14" ? "Assigned" : "Settled", accepted: proof(accepted), payment: paid.public, settlement,
        loan: { status: id === "14" ? "Active" : "Repaid", principalRaw: String(loan.principal), feeRaw: String(loan.fee), dueAt: String(loan.loanDueAt) },
        allowanceDelivered: true, modelCalls, journalDigest: digest(entry.state), ledgerDigest: digest(ledger) });
    }
    const task15 = await at(escrow, "getTask", ["15"]), loan15 = await at(manager, "getLoan", ["15"]);
    assert.equal(task15.status, 1n); assert.equal(task15.agentId, 0n); assert.equal(task15.escrowBalance, task15.reward); assert.equal(loan15.status, 0n);
    tasks.push({ taskId: "15", status: "Open", agentId: "0", started: false, loan: { status: "None", principalRaw: "0", feeRaw: "0" } });
    const planners: any[] = [];
    for (const entry of plannerFiles) {
      const state = entry.state, relay = await json(join(directory, "planner", `${state.handle.quote.paymentId}.json`)), refunded = !state.inference;
      const paid = await payment(state.handle, "autonomy", "0", refunded); assert.equal(paid.record.fromCash, 10000n); assert.equal(paid.record.fromCredit, 0n);
      assert.deepEqual(relay.quote, state.handle.quote); assert.deepEqual(relay.request, state.handle.input); assert.equal(relay.proof.txHash, paid.r.hash); assert.equal(relay.proof.blockHash, paid.r.blockHash);
      assert.equal(relay.upstreamAttempts.length, 1);
      const loop = await json(join(dirname(dirname(entry.path)), "autonomy-loop/session.json")), step = loop.steps.find((s: any) => s.decisionId === basename(entry.path)); assert.ok(step);
      assert.equal(loop.completedTasks, 0); assert.equal(loop.startedTasks, 1); assert.equal(loop.phase, "Paused"); assert.equal(loop.reason, "UPSTREAM_DISPATCH_UNKNOWN");
      assert.equal(loop.steps.length, 2); assert.equal(loop.chargedRaw, "130000");
      let refund: any = null;
      if (refunded) {
        assert.equal(relay.state, "Refunded"); assert.ok(validOperatorResolution(relay)); assert.equal(relay.upstreamAttempts[0].state, "Unknown"); assert.equal(relay.upstreamAttempts[0].httpStatus, 503);
        assert.equal(state.recovery.status, "refunded-undelivered"); assert.deepEqual(step.decisionRecovery, state.recovery); assert.equal(step.decisionRefundedRaw, "10000"); assert.equal(step.decisionChargedRaw, "0");
        assert.equal(relay.refunds.length, 1); const original = relay.refunds[0]; assert.equal(original.state, "Confirmed"); assert.equal(original.amount, "10000");
        const r = await receipt(original.transaction.txHash, addresses.manager, refunder), e = events(r, manager, "RefundProcessed"); assert.equal(e.length, 1);
        assert.equal(e[0].paymentId, paid.public.paymentId); assert.equal(e[0].refundId, original.id); assert.equal(e[0].amount, 10000n); assert.equal(e[0].debtReduced, 0n); assert.equal(e[0].toCash, 10000n);
        assert.equal(await at(account, "refundConsumed", [original.id]), true);
        refund = { ...proof(r), refundId: original.id, amountRaw: "10000", debtReducedRaw: "0", toCashRaw: "10000" };
      } else {
        assert.equal(relay.state, "Delivered"); assert.deepEqual(relay.result, state.inference.result); assert.equal(state.inference.result.model, "kimi-k2.6");
        assert.equal(step.decisionChargedRaw, "10000"); assert.equal(relay.upstreamAttempts[0].state, "Delivered");
      }
      const resolution = relay.operatorResolution;
      planners.push({ decisionId: basename(entry.path), status: refunded ? "UnknownRefunded" : "Delivered", payment: paid.public, refund,
        operatorResolution: resolution ? { version: resolution.version, paymentId: resolution.paymentId, resolutionId: resolution.resolutionId, reason: resolution.reason,
          expectedAttemptsDigest: resolution.expectedAttemptsDigest, evidenceDigest: resolution.evidenceDigest, resolvedAt: resolution.resolvedAt } : null,
        attempts: relay.upstreamAttempts.map((a: any) => ({ upstream: a.upstream, model: a.model, state: a.state, httpStatus: a.httpStatus, reason: a.reason ?? null, startedAt: a.startedAt })),
        responseModel: refunded ? null : state.inference.result.model, usage: refunded ? null : state.inference.result.usage, journalDigest: digest(state) });
    }
    assert.equal(planners.filter(p => p.status === "UnknownRefunded").length, 1); assert.equal(planners.filter(p => p.status === "Delivered").length, 1);
    const next = await at(escrow, "nextTaskId"); assert.ok(next <= 201n); let sum = 0n; const activeLoans: any[] = [];
    for (let id = 1n; id < next; id++) { const loan = await at(manager, "getLoan", [id]); if (loan.status === 1n) { sum += loan.principal + loan.fee; activeLoans.push({ taskId: String(id), agentId: String(loan.agentId), debtRaw: String(loan.principal + loan.fee) }); } }
    assert.equal(await at(manager, "totalOutstanding"), sum);
    const agents: any[] = [];
    for (const label of ["cheap", "strong", "autonomy"]) {
      const entry = acceptance.agents[label], id = entry.financeBefore.agentId, cash = await at(account, "cash", [id]);
      const debt = activeLoans.filter(l => l.agentId === id).reduce((s, l) => s + BigInt(l.debtRaw), 0n);
      assert.equal(cash, label === "autonomy" ? 0n : 58000n); assert.equal(debt, label === "autonomy" ? 92000n : 0n);
      assert.equal(await at(manager, "repaymentCount", [id]), label === "autonomy" ? 0n : 1n); assert.equal(await at(manager, "defaultCount", [id]), 0n);
      if (label !== "autonomy") { assert.equal(entry.financeAfter.status, "confirmed"); assert.equal(entry.financeAfter.cashRaw, String(cash)); assert.equal(entry.financeAfter.debtRaw, "0"); }
      else assert.equal(BigInt(entry.financeBefore.cashRaw) - planners.reduce((s, p) => s + BigInt(p.payment.fromCashRaw) - BigInt(p.payment.refundedRaw), 0n) - 40000n, cash);
      agents.push({ label, agentId: id, wallet: entry.agent.wallet, cashRaw: String(cash), debtRaw: String(debt), repayments: label === "autonomy" ? "0" : "1", defaults: "0" });
    }
    for (const [number, hash] of blocks) assert.equal((await rpc.getBlock(number))?.hash, hash, "OBSERVED_REORG_DURING_AUDIT");
    const output = resolve("frontend/acceptance/monad-hosted-20261012/observed-audit.json"); await mkdir(dirname(output), { recursive: true });
    await saveJson(output, { version: 1, overallAcceptancePassed: false, checksPass: true, observedAt: new Date().toISOString(), chainId: "10143", block: { number: block.number, hash: block.hash, timestamp: block.timestamp },
      meaning: "checksPass means the observed evidence and balances are consistent; the four-task acceptance did not pass. Task 14 vendor cost/delivery remains unknown. No refund of its delivered allowance is inferred.",
      outcome: { succeededTasks: ["12", "13"], assignedWithUnknownInference: ["14"], unstartedTasks: ["15"], autonomousCompletedTasks: 0 },
      contracts: { ...addresses, verifier, refunder }, agents, tasks, planners, counts: { plannerPaidCalls: 2, plannerDeliveredCalls: 1, plannerUnknownRefundedCalls: 1, taskModelCalls: 3, taskModelUnknownCalls: 1 },
      totalOutstandingRaw: String(sum), activeLoans, replay: { performedByThisAudit: false }, checks: { canonicalReceipts: true, exactAcceptPaymentSettlementAndRefundEvents: true, fixedBlockBalances: true, originalUnknownEvidencePreserved: true, readOnly: true, roleKeysRead: false } });
    console.log(JSON.stringify({ overallAcceptancePassed: false, checksPass: true, block: block.number, totalOutstandingRaw: String(sum), output }));
  } finally { connection.close(); }
}
await main().catch(error => { reportDemoFailure(error); process.exitCode = 1; });
