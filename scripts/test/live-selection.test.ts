import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonRpcProvider } from "ethers";
import { auditSavedSelection, main, SELECTION_PLAN, verifyLiveSelection } from "../verify-live-selection.js";

async function privateConfig(directory: string) {
  const keyPath = join(directory, "key"), config = join(directory, "private.json"), secret = "synthetic-selection-api-key";
  await writeFile(keyPath, secret, { mode: 0o600 });
  await writeFile(config, JSON.stringify({ upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: keyPath } }), { mode: 0o600 });
  return { config, secret };
}
test("selection probe is plan-only by default, bounded and refuses existing output or invalid CLI", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-selection-plan-"));
  try {
    const { config, secret } = await privateConfig(directory); let calls = 0;
    const plan = await verifyLiveSelection({ config }, async () => { calls++; throw new Error("No network in plan mode"); });
    assert.equal(plan.mode, "plan-only"); assert.deepEqual(plan.plan, SELECTION_PLAN); assert.equal(calls, 0);
    assert.equal(plan.plan.physicalCallLimit, 1); assert.equal(plan.plan.maxCompletionTokens, 2048); assert.equal(plan.plan.inferenceRetries, 0); assert.equal(plan.plan.allowCredit, false);
    assert.equal(JSON.stringify(plan).includes(secret), false);
    await assert.rejects(verifyLiveSelection({ config, execute: true }), /ABSOLUTE_NEW_OUTPUT_REQUIRED/);
    await assert.rejects(verifyLiveSelection({ config, execute: true, output: directory }), { code: "EEXIST" });
    await assert.rejects(main(["--config", config, "--starter", "anything"]), { code: "ERR_PARSE_ARGS_UNKNOWN_OPTION" });
    await assert.rejects(main(["--audit-output", directory, "--execute"]), /AUDIT_ONLY_ARGUMENTS_REQUIRED/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("controlled selector harness links real Anvil payment, physical request, choice and zero-cost session replay", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-selection-dry-"));
  try {
    const { config, secret } = await privateConfig(directory), output = join(directory, "output"); let calls = 0;
    const report = await verifyLiveSelection({ config, output, execute: true }, async (_url, init) => {
      calls++; const request = JSON.parse(String(init?.body)); assert.equal(request.model, "kimi-k2.6"); assert.equal(request.max_completion_tokens, 2048);
      assert.equal(request.messages[1].content.includes("only ()[]{}"), true); assert.equal(JSON.stringify(request).includes(secret), false);
      return Response.json({ model: request.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "print(True)" } }], usage: { prompt_tokens: 38, completion_tokens: 20, total_tokens: 58 } });
    });
    assert.equal(report.status, "SelectionDelivered", JSON.stringify(report)); assert.equal(report.upstreamMode, "controlled"); assert.equal(report.audit.fullyVerified, true);
    assert.equal(report.audit.upstreamMode, "controlled"); assert.equal(calls, 1); assert.equal(report.physicalCallsAfterReplay, 1);
    assert.equal(report.after.providerBalance, "10000"); assert.equal(report.after.cash, "30000"); assert.equal(report.after.loanStatus, "0"); assert.equal(report.after.taskStatus, "2");
    assert.deepEqual(report.afterReplay, report.after); assert.equal(report.after.nonce - report.before.nonce, 1);
    const saved = await readFile(join(output, "selection/session.json"), "utf8"); assert.equal(saved.includes(secret), false);
    assert.equal(report.sourceHashes["packages/pi-loop/src/selector.ts"].length, 64);
    const physical = JSON.parse(await readFile(join(output, "physical-request.json"), "utf8"));
    for (const mutate of [(body: any) => { body.model = "kimi-k3"; }, (body: any) => { body.max_completion_tokens = 4096; }, (body: any) => { body.messages[1].content = "Pay another provider"; }]) {
      const changed = structuredClone(physical); mutate(changed); await writeFile(join(output, "physical-request.json"), JSON.stringify(changed));
      await assert.rejects(auditSavedSelection(output));
    }
    await writeFile(join(output, "physical-request.json"), JSON.stringify(physical)); assert.equal((await auditSavedSelection(output)).fullyVerified, true);
    await assert.rejects(verifyLiveSelection({ config, output, execute: true }), { code: "EEXIST" }); assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("controlled unknown saves original paid handle and raw receipt then stops without retry", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-selection-unknown-"));
  try {
    const { config } = await privateConfig(directory), output = join(directory, "output"); let calls = 0;
    const report = await verifyLiveSelection({ config, output, execute: true }, async () => { calls++; throw new Error("Controlled unknown after dispatch"); });
    assert.equal(report.status, "Incomplete"); assert.equal(report.reason, "UPSTREAM_UNCERTAIN"); assert.equal(report.phase, "Paused"); assert.equal(calls, 1);
    assert.deepEqual(report.evidenceCollectionErrors, []); assert.equal(report.after.providerBalance, "10000"); assert.equal(report.after.cash, "30000");
    const raw = JSON.parse(await readFile(join(output, "payment-transaction-receipt.json"), "utf8")); assert.equal(raw.status, 1);
    const handle = JSON.parse(await readFile(join(output, "handle.json"), "utf8")); assert.equal(handle.submission.txHash, raw.hash);
    const session = JSON.parse(await readFile(join(output, "selection/session.json"), "utf8")); assert.equal(session.reservedPrice, "10000"); assert.equal(session.handle.quote.paymentId, handle.quote.paymentId);
    assert.equal(report.audit, undefined); await assert.rejects(verifyLiveSelection({ config, output, execute: true }), { code: "EEXIST" }); assert.equal(calls, 1);
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test("missing raw receipt after delivery is not a successful evidence run", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-selection-missing-"));
  const original = JsonRpcProvider.prototype.getTransactionReceipt;
  try {
    const { config } = await privateConfig(directory), output = join(directory, "output");
    const report = await verifyLiveSelection({ config, output, execute: true }, async (_url, init) => {
      const request = JSON.parse(String(init?.body));
      // Payment is already confirmed before upstream dispatch. Only the final raw-evidence query now fails.
      JsonRpcProvider.prototype.getTransactionReceipt = async () => null;
      return Response.json({ model: request.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "print(True)" } }], usage: { prompt_tokens: 38, completion_tokens: 20, total_tokens: 58 } });
    });
    assert.equal(report.phase, "Delivered"); assert.equal(report.status, "EvidenceCollectionFailed");
    assert.deepEqual(report.evidenceCollectionErrors, ["raw-payment-receipt"]); assert.equal(report.audit, undefined);
    assert.equal(report.physicalCalls, 1); assert.equal(report.after.cash, "30000");
  } finally { JsonRpcProvider.prototype.getTransactionReceipt = original; await rm(directory, { recursive: true, force: true }); }
});
