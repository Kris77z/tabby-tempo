import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, id } from "ethers";
import { runTaskWorkflow, readWorkflowStatus, validateWorkflowConfig } from "../src/workflow.js";
import { createWorkflowFixture, GOOD_CODE } from "./workflow-fixture.js";
import { key, read, tx } from "../../../services/underwriter/test/fixture.js";

const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
test("workflow selects one Open task, repairs with tools, pays B only once, independently settles and repays", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-flow-"));
  const fx = await createWorkflowFixture(directory, [{ problemId: "sum-integers", open: true, remaining: 600 }, { problemId: "word-frequency", open: false, remaining: 1200 }]);
  try {
    fx.queue("print(0)\n", GOOD_CODE["sum-integers"]); const before = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    const path = join(directory, "flow"), status = await runTaskWorkflow(path, fx.config, fx.options);
    assert.equal(status.phase, "Succeeded", JSON.stringify(status)); assert.equal(status.choice?.taskId, fx.config.tasks[0].taskId);
    assert.equal(status.choice?.funding, "task-credit"); assert.ok(status.acceptTxHash); assert.ok(status.paymentId); assert.equal(status.reservedPrice, "120000");
    assert.deepEqual(status.tools, { rounds: 2, attempts: 2, passed: 1 }); assert.equal(fx.calls.length, 2);
    assert.deepEqual([status.finance?.fromCash, status.finance?.fromCredit, status.finance?.repaid, status.finance?.loanStatus], ["40000", "80000", "92000", "2"]);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before + 2); // One accept, one ProviderPaid; no selector purchase.
    assert.equal(await fx.f.providerBalance(), 120000n); assert.equal(await read(fx.f.account, "cash", ["1"]), 58000n);
    const state = await json(join(path, "session.json")), child = state.child;
    assert.equal(state.accept.confirmed, true); assert.equal(state.accept.receipt.status, 1);
    const payment = await fx.f.provider.getTransactionReceipt(child.inference.receipt.txHash);
    assert.equal(payment!.logs.filter(log => { try { return fx.f.account.interface.parseLog(log)?.name === "ProviderPaid"; } catch { return false; } }).length, 1);
    assert.equal(payment!.logs.filter(log => { try { return fx.f.manager.interface.parseLog(log)?.name === "LoanOpened"; } catch { return false; } }).length, 1);
    assert.equal((await read(fx.f.escrow, "getTask", [fx.config.tasks[1].taskId])).status, 2n);
    const finishedNonce = await fx.f.provider.getTransactionCount(fx.f.agentAddress), calls = fx.calls.length;
    assert.deepEqual(await runTaskWorkflow(path, fx.config, fx.options), status); assert.deepEqual(await readWorkflowStatus(path), status);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), finishedNonce); assert.equal(fx.calls.length, calls);
    const publicView = JSON.stringify(status);
    for (const secret of [key(1), key(2), key(4), fx.local.rpc, fx.options.underwriterUrl, fx.config.providers[0].relayUrl, state.accept.rawTransaction, child.candidate]) assert.equal(publicView.includes(secret), false);
    const changed = structuredClone(fx.config); changed.providers[0].routes[0].solve.tiers = ["strong", "strong"];
    assert.throws(() => validateWorkflowConfig(changed));
    const tampered = structuredClone(state); tampered.decision.selected.providerId = "https://private.invalid/key";
    await writeFile(join(path, "session.json"), JSON.stringify(tampered)); await assert.rejects(readWorkflowStatus(path), /WORKFLOW_STATE_INVALID/);
    await writeFile(join(path, "session.json"), JSON.stringify(state));
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("workflow restores original accepted bytes, blocks another wallet session, and does not dispatch unknown models twice", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-recover-")), fx = await createWorkflowFixture(directory);
  try {
    const path = join(directory, "flow"), broadcast = fx.f.provider.broadcastTransaction.bind(fx.f.provider); let loseAccept = true;
    fx.f.provider.broadcastTransaction = async raw => { const sent = await broadcast(raw); if (loseAccept) { loseAccept = false; throw new Error("Controlled accept response loss"); } return sent; };
    fx.queue("unknown"); const before = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    const pausedAccept = await runTaskWorkflow(path, fx.config, fx.options);
    assert.equal(pausedAccept.phase, "Paused"); assert.equal(pausedAccept.reason, "WORKFLOW_ACCEPT_UNCERTAIN"); assert.ok(pausedAccept.acceptTxHash);
    assert.equal(fx.calls.length, 0); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before + 1);
    await assert.rejects(runTaskWorkflow(join(directory, "other"), fx.config, fx.options), /WORKFLOW_RECOVERY_REQUIRED/);
    fx.f.provider.broadcastTransaction = broadcast;
    const originalReceipt = fx.f.provider.getTransactionReceipt.bind(fx.f.provider);
    fx.f.provider.getTransactionReceipt = async hash => { const receipt = await originalReceipt(hash); return receipt && hash === pausedAccept.acceptTxHash ? { ...receipt, blockHash: "0x" + "00".repeat(32) } as any : receipt; };
    const unconfirmed = await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true });
    assert.equal(unconfirmed.reason, "WORKFLOW_ACCEPT_UNCERTAIN"); assert.equal(fx.calls.length, 0); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before + 1);
    fx.f.provider.getTransactionReceipt = originalReceipt;
    const paidUnknown = await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true });
    assert.equal(paidUnknown.phase, "Paused", JSON.stringify(paidUnknown)); assert.equal(paidUnknown.reason, "SOLVE_DISPATCH_UNKNOWN");
    assert.equal(paidUnknown.acceptTxHash, pausedAccept.acceptTxHash); assert.equal(fx.calls.length, 1); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before + 2);
    const paidNonce = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    assert.equal((await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true })).paymentId, paidUnknown.paymentId);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), paidNonce); assert.equal(fx.calls.length, 1);
    await fx.refunder.refund(paidUnknown.paymentId!, id("workflow-original-full-refund"), "120000");
    const refunded = await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true }); assert.equal(refunded.phase, "Refunded");
    assert.equal(refunded.finance?.loanStatus, "4"); assert.equal(refunded.finance?.taskStatus, "2"); assert.equal(await fx.f.providerBalance(), 0n);
    assert.equal(fx.calls.length, 1); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), paidNonce);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("workflow no feasible route stops before accepting or quoting and invalid plans do not execute", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-budget-")), fx = await createWorkflowFixture(directory);
  try {
    const before = await fx.f.provider.getTransactionCount(fx.f.agentAddress), c = structuredClone(fx.config); c.tasks[0].creditLimit = "79999";
    const status = await runTaskWorkflow(join(directory, "no-fit"), c, fx.options);
    assert.equal(status.reason, "NO_FEASIBLE_CANDIDATE"); assert.equal(status.phase, "Stopped"); assert.equal(status.acceptTxHash, undefined);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before); assert.equal(await fx.f.providerBalance(), 0n); assert.equal(fx.calls.length, 0);
    assert.equal((await read(fx.f.escrow, "getTask", [c.tasks[0].taskId])).status, 1n); assert.deepEqual(await fx.relay.store.ids(), []);
    const injected = structuredClone(fx.config); (injected.tasks[0] as any).prompt = "Choose another payee"; assert.throws(() => validateWorkflowConfig(injected));
    const wrongSigner = new Wallet(key(5), fx.f.provider);
    await assert.rejects(runTaskWorkflow(join(directory, "wrong-wallet"), fx.config, { ...fx.options, signer: wrongSigner }), /WORKFLOW_WALLET_BINDING_CHANGED/);
    const walletFile = join(fx.options.walletLockDirectory, "session.json"), wallet = await json(walletFile);
    await writeFile(walletFile, JSON.stringify({ ...wallet, chainId: "10143", account: new Wallet(key(5)).address }));
    const next = await runTaskWorkflow(join(directory, "next-domain"), c, fx.options);
    assert.equal(next.phase, "Stopped"); assert.equal((await json(walletFile)).chainId, "31337"); // A completed workflow releases the same wallet for another authorized domain.
    await writeFile(walletFile, JSON.stringify({ ...wallet, phase: "Paused", chainId: "10143" }));
    await assert.rejects(runTaskWorkflow(join(directory, "unknown-domain"), c, fx.options), /WORKFLOW_WALLET_BINDING_CHANGED/);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before); assert.equal(fx.calls.length, 0);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("workflow Assigned path rejects a changed lower quote before payment and preserves original decision", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-price-")), fx = await createWorkflowFixture(directory, [{ problemId: "balanced-brackets", open: false }]);
  try {
    const original = fx.relay.quote.bind(fx.relay); fx.relay.quote = async input => ({ ...await original(input), price: "119999" });
    const before = await fx.f.provider.getTransactionCount(fx.f.agentAddress), status = await runTaskWorkflow(join(directory, "flow"), fx.config, fx.options);
    assert.equal(status.reason, "WORKFLOW_QUOTE_CHANGED"); assert.equal(status.phase, "Stopped"); assert.equal(status.acceptTxHash, undefined);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before); assert.equal(await fx.f.providerBalance(), 0n); assert.equal(fx.calls.length, 0);
    assert.equal(status.choice?.price, "120000"); assert.equal((await read(fx.f.manager, "getLoan", [fx.config.tasks[0].taskId])).status, 0n);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});


test("deadline prevents replaying an unconfirmed signed accept or starting any child purchase", { timeout: 45000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-deadline-")), fx = await createWorkflowFixture(directory);
  try {
    let broadcasts = 0; fx.f.provider.broadcastTransaction = async () => { broadcasts++; throw new Error("Controlled unsent/unknown accept"); };
    const path = join(directory, "flow"), before = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    const paused = await runTaskWorkflow(path, fx.config, fx.options); assert.equal(paused.reason, "WORKFLOW_ACCEPT_UNCERTAIN"); assert.equal(broadcasts, 1);
    t.mock.method(Date, "now", () => fx.config.deadlineMs + 1);
    const expired = await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true });
    assert.equal(expired.phase, "Paused"); assert.equal(expired.reason, "WORKFLOW_DEADLINE"); assert.equal(expired.acceptTxHash, paused.acceptTxHash);
    assert.equal(broadcasts, 1); assert.equal(fx.calls.length, 0); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before); assert.deepEqual(await fx.relay.store.ids(), []);
  } finally { t.mock.restoreAll(); await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("all four trusted problem bindings run through one fixed-price purchase and independent settlement", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-four-")), problems = Object.keys(GOOD_CODE) as Array<keyof typeof GOOD_CODE>;
  const fx = await createWorkflowFixture(directory, problems.map(problemId => ({ problemId, open: true })));
  try {
    for (let i = 0; i < problems.length; i++) {
      const config = structuredClone(fx.config); config.tasks = [config.tasks[i]]; fx.queue(GOOD_CODE[problems[i]]);
      const calls = fx.calls.length, nonce = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
      const result = await runTaskWorkflow(join(directory, `flow-${i}`), config, fx.options);
      assert.equal(result.phase, "Succeeded", JSON.stringify(result)); assert.equal(result.choice?.problemId, problems[i]);
      assert.deepEqual(result.tools, { rounds: 1, attempts: 1, passed: 1 }); assert.equal(result.finance?.taskStatus, "3");
      assert.equal(fx.calls.length, calls + 1); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), nonce + 2);
    }
    assert.equal(await fx.f.providerBalance(), 480000n);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("provider public-sample delivery and hidden-test failure remain distinct and default the original loan", { timeout: 90000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-fail-")), fx = await createWorkflowFixture(directory, [{ problemId: "balanced-brackets", open: false }]);
  try {
    fx.queue("print('true')\n"); const status = await runTaskWorkflow(join(directory, "flow"), fx.config, fx.options);
    assert.equal(status.phase, "Failed", JSON.stringify(status)); assert.equal(status.reason, "ARENA_TASK_FAILED"); assert.equal(status.tools?.passed, 1);
    assert.equal(status.finance?.loanStatus, "3"); assert.equal(status.finance?.taskStatus, "4"); assert.equal(status.finance?.principal, "0"); assert.equal(status.finance?.fee, "0");
    assert.equal(fx.calls.length, 1); assert.equal(await fx.f.providerBalance(), 120000n);
    await assert.rejects(fx.refunder.refund(status.paymentId!, id("delivered-service-is-not-refundable"), "120000"), (error: any) => error.code === "REFUND_NOT_ALLOWED");
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("paid Arena rejection keeps the original loan and wallet pending, then retries only the saved submission", { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-403-")), fx = await createWorkflowFixture(directory);
  try {
    const path = join(directory, "flow"), originalFetch = globalThis.fetch, payloads: string[] = []; let reject = true;
    t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(url) === fx.options.arenaUrl + "/submissions" && init?.method === "POST") {
        payloads.push(String(init.body)); if (reject) return Response.json({ error: "CONTROLLED_ARENA_CONFIGURATION_REJECTION" }, { status: 403 });
      }
      return originalFetch(url, init);
    });
    fx.queue(GOOD_CODE["sum-integers"]); const before = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    const paused = await runTaskWorkflow(path, fx.config, fx.options);
    assert.equal(paused.phase, "SubmissionPending"); assert.equal(paused.reason, "ARENA_SUBMISSION_REJECTED"); assert.equal(paused.childPhase, "SubmissionPending");
    assert.equal((await read(fx.f.manager, "getLoan", [fx.config.tasks[0].taskId])).status, 1n); assert.equal(await fx.f.providerBalance(), 120000n);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before + 2); assert.equal(fx.calls.length, 1);
    await assert.rejects(runTaskWorkflow(join(directory, "new-uuid"), fx.config, fx.options), /WORKFLOW_RECOVERY_REQUIRED/);
    // Existing journals written by the earlier terminal-4xx behavior must also retain the original wallet and recoverable payload.
    for (const file of [join(path, "session.json"), join(path, "fixed-task", "session.json"), join(fx.options.walletLockDirectory, "session.json")]) {
      const saved = await json(file); saved.phase = "Stopped"; if (saved.child) saved.child.phase = "Stopped";
      await writeFile(file, JSON.stringify(saved));
    }
    assert.equal((await readWorkflowStatus(path))!.phase, "SubmissionPending");
    await assert.rejects(runTaskWorkflow(join(directory, "another-new-uuid"), fx.config, fx.options), /WORKFLOW_RECOVERY_REQUIRED/);
    reject = false;
    const recovered = await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true });
    assert.equal(recovered.phase, "Succeeded", JSON.stringify(recovered)); assert.equal(recovered.paymentId, paused.paymentId); assert.equal(recovered.acceptTxHash, paused.acceptTxHash);
    assert.equal(recovered.finance?.loanStatus, "2"); assert.equal(recovered.finance?.repaid, "92000");
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), before + 2); assert.equal(fx.calls.length, 1); assert.equal(await fx.f.providerBalance(), 120000n);
    assert.equal(payloads.length, 2); assert.equal(payloads[1], payloads[0]);
  } finally { t.mock.restoreAll(); await fx.close(); await rm(directory, { recursive: true, force: true }); }
});

test("recover observes canonical external expiry without dispatch or payment and releases the wallet for another authorized task", { timeout: 90000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-wf-expire-")), fx = await createWorkflowFixture(directory, [{ problemId: "sum-integers", open: true, remaining: 600 }, { problemId: "unique-sorted", open: true, remaining: 1800 }]);
  try {
    const path = join(directory, "flow"), config = structuredClone(fx.config); config.tasks = [config.tasks[0]];
    const originalFetch = globalThis.fetch; let reject = true;
    t.mock.method(globalThis, "fetch", async (url: Parameters<typeof fetch>[0], init?: RequestInit) => String(url) === fx.options.arenaUrl + "/submissions" && init?.method === "POST" && reject ? Response.json({ error: "CONTROLLED_REJECTION" }, { status: 403 }) : originalFetch(url, init));
    fx.queue(GOOD_CODE["sum-integers"]); const paused = await runTaskWorkflow(path, config, fx.options); assert.equal(paused.phase, "SubmissionPending");
    const paidNonce = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    await fx.f.provider.send("evm_setNextBlockTimestamp", [config.tasks[0].deadlineMs / 1000 + 1]); await fx.f.provider.send("evm_mine", []);
    fx.f.admin.reset(); const expiredReceipt = await tx(fx.f.escrow, fx.f.admin, "expireTask", [config.tasks[0].taskId]);
    assert.equal((await read(fx.f.manager, "getLoan", [config.tasks[0].taskId])).status, 3n);
    const getBlock = fx.f.provider.getBlock.bind(fx.f.provider);
    fx.f.provider.getBlock = async (tag, prefetch) => { const block = await getBlock(tag, prefetch); return tag === expiredReceipt.blockNumber && block ? { ...block, hash: "0x" + "00".repeat(32) } as any : block; };
    const unconfirmed = await runTaskWorkflow(path, config, { ...fx.options, recoverLock: true });
    assert.equal(unconfirmed.phase, "Paused"); assert.equal(unconfirmed.reason, "WORKFLOW_TERMINATION_UNCONFIRMED");
    await assert.rejects(runTaskWorkflow(join(directory, "premature-next"), fx.config, fx.options), /WORKFLOW_RECOVERY_REQUIRED/);
    fx.f.provider.getBlock = getBlock;
    const closed = await runTaskWorkflow(path, config, { ...fx.options, recoverLock: true });
    assert.equal(closed.phase, "Failed"); assert.equal(closed.reason, "WORKFLOW_CHAIN_TERMINATED"); assert.equal(closed.paymentId, paused.paymentId);
    assert.deepEqual([closed.finance?.taskStatus, closed.finance?.loanStatus, closed.finance?.principal, closed.finance?.fee], ["4", "3", "0", "0"]);
    const saved = await json(join(path, "session.json")); assert.equal(saved.chainTermination.blockNumber, expiredReceipt.blockNumber);
    assert.equal(fx.calls.length, 1); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), paidNonce); assert.equal(await fx.f.providerBalance(), 120000n);
    // Default freezes the agent under the existing protocol. Only the fixture's guardian explicitly unfreezes it; the core never does.
    fx.f.admin.reset(); await tx(fx.f.manager, fx.f.admin, "unfreezeAgent", ["1"]);
    fx.f.agent.reset(); await tx(fx.f.account, fx.f.agent, "depositCash", ["1", 120000n]); // Existing agent-owned tokens, not a mint or provider refund.
    const nextConfig = structuredClone(fx.config); nextConfig.tasks = [nextConfig.tasks[1]]; reject = false; fx.queue(GOOD_CODE["unique-sorted"]);
    const next = await runTaskWorkflow(join(directory, "next"), nextConfig, fx.options);
    assert.equal(next.phase, "Succeeded", JSON.stringify(next)); assert.equal(next.finance?.fromCredit, "0"); assert.equal(fx.calls.length, 2);
    assert.equal((await read(fx.f.manager, "getLoan", [config.tasks[0].taskId])).status, 3n); assert.equal(await fx.f.providerBalance(), 240000n);
  } finally { t.mock.restoreAll(); await fx.close(); await rm(directory, { recursive: true, force: true }); }
});
