import assert from "node:assert/strict";
import test from "node:test";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet, id } from "ethers";
import { canonical, type Json } from "../../packages/sdk/src/protocol.js";
import { createWorkflowFixture } from "../../packages/pi-loop/test/workflow-fixture.js";
import { runTaskWorkflow } from "../../packages/pi-loop/src/workflow.js";
import { key, read } from "../../services/underwriter/test/fixture.js";
import { settleAbortedTask, verifyAbortPreconditions, validateAbortLedger, type AbortConfig } from "../monad-abort-settler.js";

test("operator abort requires sealed original ledger and canonical full refund; original transaction recovery neither penalizes nor repeats inference", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "abort-settler-")), fx = await createWorkflowFixture(directory);
  try {
    const path = join(directory, "workflow"); fx.queue("unknown");
    const paused = await runTaskWorkflow(path, fx.config, fx.options); assert.equal(paused.phase, "Paused");
    const saved = JSON.parse(await readFile(join(path, "session.json"), "utf8")), paymentTxHash = saved.handle.submission.txHash;
    const c: AbortConfig = { version: 1, chainId: "31337", rpcUrlFile: join(directory, "rpc"), rpcTransport: "direct", verifierKeyFile: join(directory, "key"), journalDirectory: join(directory, "abort"),
      account: await fx.f.account.getAddress(), manager: await fx.f.manager.getAddress(), escrow: await fx.f.escrow.getAddress(), asset: fx.config.asset, agentId: "1", taskId: fx.config.tasks[0].taskId,
      wallet: fx.f.agentAddress, paymentId: paused.paymentId!, paymentTxHash, refundTxHash: id("placeholder"), refundId: id("abort-refund"), ledgerFile: join(directory, "ledger.json"), resolutionId: randomUUID(), evidenceDigest: id("operator-evidence"), reason: "task-abort/provider-unknown", maxFeePerGas: "250000000000" };
    const ledger: any = { version: 1, binding: { agentId: c.agentId, taskId: c.taskId, wallet: c.wallet }, grants: [{ id: c.paymentId, credits: "200000", source: { kind: "chain-payment", paymentId: c.paymentId, txHash: c.paymentTxHash } }], invocations: [{ id: "round:0", state: "Unknown" }] };
    ledger.closure = { version: 1, resolutionId: c.resolutionId, evidenceDigest: c.evidenceDigest, reason: "operator-accepted-unknown-cost", paymentId: c.paymentId,
      expectedLedgerDigest: createHash("sha256").update(canonical(ledger as Json)).digest("hex"), binding: ledger.binding, sealedAt: Date.now() };
    await writeFile(c.ledgerFile, JSON.stringify(ledger)); const verifier = new Wallet(key(1), fx.f.provider);
    await assert.rejects(verifyAbortPreconditions(c, fx.f.provider, verifier.address), /FINANCIAL_PRECONDITION/);
    const wrong = structuredClone(ledger); wrong.invocations[0].state = "Completed"; assert.throws(() => validateAbortLedger(c, wrong), /NOT_SEALED/);
    const refund = await fx.refunder.refund(c.paymentId, c.refundId, "120000"); c.refundTxHash = refund.txHash!;
    await verifyAbortPreconditions(c, fx.f.provider, verifier.address);
    const original = fx.f.provider.getBlock.bind(fx.f.provider), refundReceipt = await fx.f.provider.getTransactionReceipt(c.refundTxHash);
    fx.f.provider.getBlock = async (tag, prefetch) => { const b = await original(tag, prefetch); return tag === refundReceipt!.blockNumber && b ? { ...b, hash: id("wrong-block") } as any : b; };
    await assert.rejects(verifyAbortPreconditions(c, fx.f.provider, verifier.address), /UNCONFIRMED/); fx.f.provider.getBlock = original;
    const nonce = await fx.f.provider.getTransactionCount(verifier.address), agentNonce = await fx.f.provider.getTransactionCount(c.wallet);
    const receiptRead = fx.f.provider.getTransactionReceipt.bind(fx.f.provider); let loseReceipt = true;
    fx.f.provider.getTransactionReceipt = async hash => { if (hash !== c.paymentTxHash && hash !== c.refundTxHash && loseReceipt) { loseReceipt = false; throw new Error("controlled receipt loss"); } return receiptRead(hash); };
    await assert.rejects(settleAbortedTask(c, fx.f.provider, verifier), /RECORDED_TRANSACTION_UNCONFIRMED/);
    fx.f.provider.getTransactionReceipt = receiptRead;
    const result = await settleAbortedTask(c, fx.f.provider, verifier, true);
    assert.equal(result.rewardReturnedRaw, "150000"); assert.equal((await read(fx.f.manager, "getLoan", [c.taskId])).status, 4n);
    assert.equal((await read(fx.f.escrow, "getTask", [c.taskId])).status, 4n);
    assert.equal(await read(fx.f.manager, "defaultCount", ["1"]), 0n);
    assert.deepEqual(await settleAbortedTask(c, fx.f.provider, verifier, true), result);
    assert.equal(await fx.f.provider.getTransactionCount(verifier.address), nonce + 1);
    const terminated = await runTaskWorkflow(path, fx.config, { ...fx.options, recoverLock: true });
    assert.equal(terminated.phase, "Failed"); assert.equal(terminated.reason, "WORKFLOW_REFUNDED_TASK_TERMINATED");
    assert.deepEqual([terminated.finance?.taskStatus, terminated.finance?.loanStatus, terminated.finance?.principal, terminated.finance?.fee], ["4", "4", "0", "0"]);
    assert.equal(fx.calls.length, 1); assert.equal(await fx.f.provider.getTransactionCount(c.wallet), agentNonce);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});
