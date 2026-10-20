import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile), projectRoot = fileURLToPath(new URL("../../", import.meta.url));
const script = fileURLToPath(new URL("../operating-report-demo.ts", import.meta.url));
const operatorScript = fileURLToPath(new URL("../operating-report.ts", import.meta.url));
const runScript = (path: string, ...args: string[]) => exec(process.execPath, ["--import", "tsx", path, ...args], { cwd: projectRoot });
const run = (...args: string[]) => runScript(script, ...args);
const sha256 = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");
const observation = { version: 1, source: "operator-declared", role: "platform", subjectId: "controlled-platform",
  period: { from: "2026-10-16T00:00:00.000Z", to: "2026-10-17T00:00:00.000Z" }, evidenceDigest: "a".repeat(64), receiptsRaw: "100000", refundsRaw: "0", costsRaw: "200000",
  cashRaw: "1000000", reservationsRaw: "100000", debtRaw: "100000", reserveCashRaw: "200000", subsidyGrantedRaw: "400000", subsidyAllocatedRaw: "150000", subsidyBudgetRaw: "1000000", burn: { amountRaw: "100000", windowMs: 86400000, taskCount: 2 }, subsidyBurn: { amountRaw: "50000", windowMs: 86400000 } };

test("operating demo is reproducible, keeps roles separate and distinguishes subsidy grants, allocation and budget", async () => {
  const before = (await readdir(tmpdir())).filter(name => name.startsWith("agentfuel-operating-demo-")).sort();
  const first = JSON.parse((await run()).stdout), second = JSON.parse((await run()).stdout); assert.deepEqual(first, second);
  assert.equal(first.contribution.agent.settlementOperatingRaw, "1205000"); assert.equal(first.contribution.agent.netServiceCostRaw, "180000"); assert.equal(first.contribution.agent.loanPrincipalRaw, "100000");
  assert.equal(first.contribution.platform.derivedProtocolFeeRaw, "100000"); assert.equal(first.contribution.suppliers.netReceiptsRaw, "180000");
  assert.equal(first.operatorDeclarations.platform.reportedContributionRaw, "-500000"); assert.equal(first.operatorDeclarations.supplier.reportedContributionRaw, "50000");
  assert.equal(first.operatorDeclarations.platform.subsidy.grantedRaw, "400000"); assert.equal(first.operatorDeclarations.platform.subsidy.explicitlyAllocatedRaw, "150000");
  assert.equal(first.operatorDeclarations.platform.subsidy.unallocatedGrantRaw, "250000"); assert.equal(first.operatorDeclarations.platform.subsidy.remainingBudgetRaw, "600000");
  assert.equal(first.contribution.subsidy.usdcAttributedConsumptionRaw, null); assert.equal(first.contribution.subsidy.rewardTokensRemaining, null); assert.equal(first.contribution.consolidation.roleTotalsAdditive, false);
  assert.equal(first.ownerHypothetical.scenario.source, "owner-hypothetical"); assert.equal(first.ownerHypothetical.platform.actualProfitRaw, null);
  assert.equal(first.runway.finite.status, "finite"); assert.equal(first.runway.zeroBurn.status, "zero-burn"); assert.equal(first.runway.zeroBurn.horizonMs, null); assert.equal(first.runway.unknown.status, "unknown");
  assert.equal(first.runway.subsidyBudget.horizonMs, "345600000"); assert.equal(first.runway.noSubsidyBurn.status, "unknown");
  assert.equal(first.duplicatePayment.netServiceCostRaw, "180000"); assert.equal(first.duplicatePayment.supplierReceiptsRaw, "180000"); assert.equal(first.invalidRefund.settlementOperatingRaw, null); assert.equal(first.unresolved.settlementOperatingRaw, null);
  for (const key of ["productionRead", "productionWrite", "profitCalibrated"]) assert.equal(first.scope[key], false);
  for (const key of ["modelCalls", "externalRpcCalls", "signedTransactions"]) assert.equal(first.scope[key], 0);
  assert.equal(first.scope.evidenceDigest, "reference-only-not-authenticated-invoice"); assert.equal(first.fixtureEvidence.originalJournalsUnchanged, true); assert.equal(first.fixtureEvidence.journalCount, 10);
  assert.deepEqual((await readdir(tmpdir())).filter(name => name.startsWith("agentfuel-operating-demo-")).sort(), before);
});

test("operating demo writes a source-hashed exclusive 0600 report and rejects relative/overwriting output", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-operating-report-test-")), path = join(directory, "review.json");
  try {
    const result = JSON.parse((await run("--report", path)).stdout), bytes = await readFile(path), report = JSON.parse(bytes.toString());
    assert.equal(result.report.sha256, sha256(bytes)); assert.equal((await stat(path)).mode & 0o777, 0o600);
    for (const [relative, hash] of Object.entries(report.sourceSha256)) assert.equal(hash, sha256(await readFile(join(projectRoot, relative))));
    await assert.rejects(run("--report", path), error => String((error as { stderr?: unknown }).stderr).includes("EEXIST")); assert.deepEqual(await readFile(path), bytes);
    await assert.rejects(run("--report", "relative.json"), error => String((error as { stderr?: unknown }).stderr).includes("absolute path"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operator CLI evaluates only the explicit declaration file and never treats its digest as verified invoice", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-operator-report-test-")), input = join(directory, "input.json"), path = join(directory, "report.json");
  try {
    const original = JSON.stringify(observation); await writeFile(input, original);
    const first = JSON.parse((await runScript(operatorScript, "--input", input, "--report", path)).stdout), bytes = await readFile(path), saved = JSON.parse(bytes.toString());
    const second = JSON.parse((await runScript(operatorScript, "--input", input)).stdout); assert.deepEqual(saved, second);
    assert.equal(first.inputSha256, sha256(original)); assert.equal(first.report.sha256, sha256(bytes)); assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(first.evaluation.source, "operator-declared"); assert.equal(first.evaluation.reportedContributionRaw, "-500000"); assert.equal(first.evaluation.actualProfitRaw, null);
    assert.equal(first.evaluation.subsidy.remainingBudgetRaw, "600000"); assert.equal(first.evaluation.runway.horizonMs, "518400000"); assert.equal(first.evaluation.runway.fullTasks, "12");
    assert.equal(first.scope.operatorDeclarationVerified, false); assert.equal(first.scope.evidenceDigest, "reference-only-not-authenticated-invoice"); assert.equal(first.scope.productionRead, false);
    for (const [relative, hash] of Object.entries(saved.sourceSha256)) assert.equal(hash, sha256(await readFile(join(projectRoot, relative))));
    await assert.rejects(runScript(operatorScript, "--input", input, "--report", path), error => (error as { stderr?: string }).stderr === "OPERATING_REPORT_EXISTS\n");
    assert.equal(await readFile(input, "utf8"), original); assert.deepEqual(await readFile(path), bytes);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("operator CLI bounds file reads and rejects malformed/private data using safe errors", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-operator-rejection-test-")), input = join(directory, "input.json"), linked = join(directory, "linked.json");
  const rejects = (path: string, code: string) => assert.rejects(runScript(operatorScript, "--input", path), error => (error as { stderr?: string }).stderr === `${code}\n`);
  try {
    for (const value of [{ ...observation, source: "owner-hypothetical" }, { ...observation, privateKey: "SECRET" }, { ...observation, period: { ...observation.period, privateResponse: "SECRET" } },
      { ...observation, refundsRaw: "100001" }, { ...observation, costsRaw: 200000 }, { ...observation, subsidyAllocatedRaw: "400001" }]) {
      await writeFile(input, JSON.stringify(value)); await rejects(input, "OPERATING_INPUT_INVALID");
    }
    await writeFile(input, "SECRET malformed JSON"); await rejects(input, "OPERATING_INPUT_JSON_INVALID");
    await writeFile(input, Buffer.from([0xff, 0xfe])); await rejects(input, "OPERATING_INPUT_JSON_INVALID");
    await writeFile(input, "x".repeat(1024 * 1024 + 1)); await rejects(input, "OPERATING_INPUT_TOO_LARGE");
    await writeFile(input, JSON.stringify(observation)); await symlink(input, linked); await rejects(linked, "OPERATING_INPUT_UNREADABLE");
    await rejects(directory, "OPERATING_INPUT_REGULAR_FILE_REQUIRED"); await rejects(join(directory, "missing.json"), "OPERATING_INPUT_UNREADABLE");
    await assert.rejects(runScript(operatorScript, "--input", "relative.json"), error => (error as { stderr?: string }).stderr === "OPERATING_USAGE_INVALID\n");
    assert.deepEqual((await readdir(directory)).sort(), ["input.json", "linked.json"]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
