import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseTaskRunnerSnapshot } from "../src/task-runner/types.js";
import { createTaskRunnerFixture, waitTaskRunnerHttp } from "./task-runner-fixture.js";
import { GOOD_CODE } from "./workflow-fixture.js";

test("HTTP preset completes Open selection, canonical acceptance, one SDK/Pi purchase and independent Docker/Arena repayment; recover adds no payment/model", { timeout: 120000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-task-http-chain-")), runtime = await createTaskRunnerFixture(directory, undefined, { maxCompletionTokens: 2048, workflowTimeoutMs: 180000 }), requestId = randomUUID();
  const post = (command: unknown) => fetch(runtime.apiUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(command) });
  try {
    const taskId = runtime.fx.config.tasks[0].taskId;
    assert.equal(runtime.loaded.profiles[0].workflow.maxCompletionTokens, 2048);
    assert.equal(runtime.loaded.profiles[0].preset.timeoutMs, 180000);
    assert.equal(runtime.loaded.profiles[0].preset.pollTimeoutMs, 180000);
    assert.ok(runtime.loaded.profiles[0].workflow.deadlineMs > Date.now() + 170000);
    assert.equal((await runtime.fx.f.escrow.getFunction("getTask").staticCall(taskId)).status, 1n);
    runtime.fx.queue(GOOD_CODE["sum-integers"]);
    const started = await post({ action: "start", requestId, profileId: "local-fixed-b" }); assert.equal(started.status, 202); parseTaskRunnerSnapshot(await started.json());
    const complete = await waitTaskRunnerHttp(runtime.apiUrl, requestId); assert.equal(complete.run!.status, "Succeeded", JSON.stringify(complete));
    const workflow = complete.run!.workflow!; assert.equal(workflow.choice!.taskId, taskId); assert.equal(workflow.choice!.funding, "task-credit");
    assert.ok(workflow.acceptTxHash); assert.ok(workflow.paymentId); assert.deepEqual(workflow.tools, { rounds: 1, attempts: 1, passed: 1 });
    assert.deepEqual(workflow.finance, { taskStatus: "3", loanStatus: "2", principal: "0", fee: "0", fromCash: "40000", fromCredit: "80000", repaid: "92000", slashed: "0", residual: "58000" });
    assert.equal(runtime.fx.calls.length, 1);
    assert.equal(runtime.fx.calls[0].max_completion_tokens, 2048);
    const privateSession = JSON.parse(await readFile(join(runtime.loaded.config.dataDirectory, "runs", requestId, "session.json"), "utf8"));
    const result = privateSession.child.submission.result; assert.equal(result.verdict.mode, "docker"); assert.equal(result.verdict.passed, true); assert.equal(result.tests.length, 5);
    const paid = await runtime.fx.f.provider.getTransactionReceipt(privateSession.child.inference.receipt.txHash), accepted = await runtime.fx.f.provider.getTransactionReceipt(workflow.acceptTxHash!);
    const settled = await runtime.fx.f.provider.getTransactionReceipt(result.settlement.txHash); assert.equal(paid!.status, 1); assert.equal(accepted!.status, 1); assert.equal(settled!.status, 1);
    const nonce = await runtime.fx.f.provider.getTransactionCount(runtime.fx.options.signer.address), cash = await runtime.fx.f.account.getFunction("cash").staticCall("1"), providerBalance = await runtime.fx.f.providerBalance();
    assert.equal(cash, 58000n); assert.equal(providerBalance, 120000n);
    assert.equal((await post({ action: "recover", requestId })).status, 202);
    const recovered = await waitTaskRunnerHttp(runtime.apiUrl, requestId); assert.equal(recovered.run!.workflow!.paymentId, workflow.paymentId); assert.equal(runtime.fx.calls.length, 1);
    assert.equal(await runtime.fx.f.provider.getTransactionCount(runtime.fx.options.signer.address), nonce); assert.equal(await runtime.fx.f.account.getFunction("cash").staticCall("1"), cash); assert.equal(await runtime.fx.f.providerBalance(), providerBalance);
    assert.equal(JSON.stringify(complete).includes(runtime.fx.options.signer.privateKey), false); assert.equal(JSON.stringify(complete).includes("rawTransaction"), false); assert.equal(JSON.stringify(complete).includes("rpcUrl"), false);
  } finally { await runtime.close(); await rm(directory, { recursive: true, force: true }); }
});
