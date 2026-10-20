import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("../strategy-advice-demo.ts", import.meta.url));
const run = (...args: string[]) => exec(process.execPath, ["--import", "tsx", script, ...args], { cwd: projectRoot });

test("offline review command is reproducible and reports the decision-to-actual-to-next-choice loop", async () => {
  const first = JSON.parse((await run()).stdout), second = JSON.parse((await run()).stdout);
  assert.deepEqual(first, second);
  assert.deepEqual(first.costDeviation, { originalExecutionCostRaw: "80000", actualExecutionCostRaw: "120000", observedCostBufferRaw: "40000", beforeProvider: "route-a", afterProvider: "route-b" });
  assert.equal(first.paidFailure.actualLossRaw, "70000"); assert.equal(first.paidFailure.beforeProvider, "route-c"); assert.equal(first.paidFailure.afterProvider, "route-b");
  assert.equal(first.scope.currentQuoteEvidence, false); assert.equal(first.scope.successProbabilityEstimated, false);
  assert.equal(first.scope.modelCalls, 0); assert.equal(first.scope.externalRpcCalls, 0); assert.equal(first.scope.productionRead, false); assert.equal(first.scope.productionWrite, false);
  assert.equal(first.fixtureEvidence.originalJournalsUnchanged, true); assert.equal(first.checksPassed.length, 9);
});

test("optional review report includes source hashes and refuses to replace an existing report", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-strategy-report-test-")), path = join(directory, "review.json");
  try {
    const output = JSON.parse((await run("--report", path)).stdout), bytes = await readFile(path), report = JSON.parse(bytes.toString());
    assert.equal(output.report.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(report.costDeviation.originalPrediction.source, "original-workflow-admission");
    for (const [relative, hash] of Object.entries(report.sourceSha256)) assert.equal(hash, createHash("sha256").update(await readFile(join(projectRoot, relative))).digest("hex"));
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    await assert.rejects(run("--report", path), error => String((error as { stderr?: unknown }).stderr).includes("EEXIST"));
    assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(run("--report", "relative.json"), error => String((error as { stderr?: unknown }).stderr).includes("absolute path"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
