import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ROOT, inferenceCode } from "../demo-common.js";

const execute = promisify(execFile);
const load = async (path: string) => JSON.parse(await readFile(path, "utf8"));

test("Model code extraction preserves bad code and refuses absent code", () => {
  assert.equal(inferenceCode({ choices: [{ message: { content: "```python\nprint('PASS')\n```" } }] }), "print('PASS')");
  assert.equal(inferenceCode({ choices: [{ message: { content: "while True: pass" } }] }), "while True: pass");
  assert.throws(() => inferenceCode({ choices: [] }), /INFERENCE_HAS_NO_CODE/);
});

test("One command executes real local credit flywheel and saves mined evidence", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-demo-test-"));
  const output = join(directory, "run");
  try {
    const { stdout, stderr } = await execute(process.execPath, ["--import", "tsx", join(ROOT, "scripts/demo.ts"), "--mode", "local", "--output", output],
      { cwd: ROOT, timeout: 160000, maxBuffer: 200000 });
    assert.equal(stderr, ""); assert.match(stdout, /DEMO_RESULT /);
    assert.match(stdout, /LIVE tx1=0x[0-9a-f]{64} tx2=0x[0-9a-f]{64}/);
    const report = await load(join(output, "evidence/demo.json"));
    assert.equal(report.summary.completed, true); assert.equal(report.summary.manualAcceptance, false);
    assert.equal(report.summary.realMonadBroadcast, false); assert.equal(report.summary.paidModelCall, false);
    assert.equal(report.summary.upstreamCalls, 7); assert.equal(report.summary.providerPaid, "840000");
    assert.deepEqual(report.rounds.filter((round: any) => round.role === "hero").map((round: any) =>
      [round.principal, round.fee, round.cashAfter, round.score, round.tier]), [
      ["80000", "12000", "58000", "570", "C"], ["62000", "9300", "78700", "640", "B"], ["41300", "3304", "105396", "710", "A"],
    ]);
    assert.equal(report.beforeLive.repayments, "2"); assert.equal(report.afterLive.repayments, "3");
    assert.equal(report.rounds.filter((round: any) => round.passed).length, 6);
    assert.equal(report.rounds.filter((round: any) => !round.passed).length, 1);
    const receipts = await load(join(output, "evidence/chain-receipts.json"));
    const receipt = (hash: string) => { const found = receipts.find((entry: any) => entry.hash === hash); assert.ok(found); return found; };
    const hero = report.rounds.filter((round: any) => round.role === "hero");
    // Third create/accept really follow the two preloaded repayments.
    assert.ok(receipt(hero[2].tx1).blockNumber > receipt(hero[1].tx4).blockNumber);
    for (const round of report.rounds) {
      for (const phase of ["tx1", "tx2", "tx3", "tx4"]) assert.equal(receipt(round[phase]).status, 1);
      const settlement = await load(join(output, `evidence/settlement-${round.taskId}.json`));
      assert.equal(settlement.receipt.status, 1);
      assert.ok(settlement.events.some((event: any) => event.name === (round.passed ? "LoanRepaid" : "LoanDefaulted")));
      assert.equal(settlement.events.filter((event: any) => event.name === "NewFeedback").length, round.passed ? 2 : 1);
      const requiredTypes = round.passed ? [1, 2] : [3];
      assert.ok(requiredTypes.every(type => round.feedback.some((feedback: any) => feedback.type === type && feedback.sent && !feedback.pending)));
      assert.equal(round.reputationSummary.count, round.passed ? String(round.ordinal) : "1");
      const inference = await load(join(output, `evidence/inference-${round.taskId}.json`));
      assert.equal(inference.simulated, true);
      assert.equal(inference.submittedCode, inferenceCode(inference.result));
      if (!round.passed) assert.equal(inference.submittedCode, "print('PASS')");
    }
    for (const reverse of Object.values(report.reverse) as any[]) {
      assert.equal(reverse.status, 0); assert.equal(reverse.logCount, 0);
      assert.equal(receipt(reverse.txHash).status, 0); assert.equal(receipt(reverse.txHash).logs.length, 0);
    }
    assert.equal(report.reverse.spendRejected.reason, "1"); assert.equal(report.reverse.identityChanged.protocolFrozen, true);
    assert.equal(BigInt(report.assetLedger.manager), BigInt(report.assetLedger.vault) + BigInt(report.assetLedger.backstop));
    assert.equal(report.assetLedger.account, "210792"); assert.equal(report.assetLedger.escrow, "150000");
    const manifest = await load(join(output, "manifest.json"));
    assert.equal(manifest.chainId, "31337"); assert.equal(manifest.asset.decimals, 6); assert.equal(manifest.agents.length, 3);
    assert.match(manifest.network, /MOCK registries.*FAKE inference/);
    assert.equal(manifest.providers[0].service, "infercredit/coder"); assert.equal(manifest.providers[0].model, "coder");
    assert.doesNotMatch(JSON.stringify(manifest), /privateKey|syntheticPrivateKey|ipcDirectory|token\.txt/);
    assert.equal((await stat(join(output, "private/roles.local.json"))).mode & 0o777, 0o600);
    assert.equal((await readdir(join(output, "private"))).filter(name => /^payment-\d+\.json$/.test(name)).length, 7);
    assert.equal(Object.keys(await load(join(output, "private/arena-settlements.json"))).length, 7);
    // The command shuts down its own listener/Anvil; no global process/container scan.
    await assert.rejects(fetch(manifest.rpcUrl, { signal: AbortSignal.timeout(500) }));
    await assert.rejects(fetch(manifest.arenaUrl + "/problems", { signal: AbortSignal.timeout(500) }));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
