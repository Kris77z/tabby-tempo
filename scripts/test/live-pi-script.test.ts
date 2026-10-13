import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { livePiPlan, main } from "../verify-live-pi.js";

test("live Pi plan is bounded, secret-free and requires explicit fresh-output execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-live-pi-plan-")); const secret = "synthetic-plan-api-key";
  const keyPath = join(directory, "key.txt"), configPath = join(directory, "private.json");
  await writeFile(keyPath, secret, { mode: 0o600 }); await writeFile(configPath, JSON.stringify({ upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: keyPath } }), { mode: 0o600 });
  const originalLog = console.log; const output: string[] = []; console.log = value => { output.push(String(value)); };
  try {
    await main(["--config", configPath]); const plan = JSON.parse(output[0]); assert.equal(plan.mode, "plan-only");
    assert.equal(plan.maxRounds, 3); assert.equal(plan.maxCompletionTokens, 2048); assert.equal(plan.maxTotalPriceRaw, "70000"); assert.equal(plan.inferenceRetries, 0); assert.equal(plan.preseededError, false);
    assert.deepEqual(plan.tiers, ["cheap", "strong", "strong"]); assert.equal(output[0].includes(secret), false); assert.equal(output[0].includes(keyPath), false);
    await assert.rejects(main(["--config", configPath, "--execute"]), /ABSOLUTE_NEW_OUTPUT_REQUIRED/);
    await assert.rejects(main(["--config", configPath, "--execute", "--output", directory]), { code: "EEXIST" });
    await assert.rejects(main(["--audit-output", directory, "--execute"]), /AUDIT_ONLY_ARGUMENTS_REQUIRED/);
    assert.equal(await readFile(keyPath, "utf8"), secret); assert.equal(livePiPlan.maxPricePerCallRaw, "30000");
  } finally { console.log = originalLog; await rm(directory, { recursive: true, force: true }); }
});

test("controlled dry harness saves real local chain and Pi session shapes accepted by the offline audit", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-live-pi-dry-")); const keyPath = join(directory, "key.txt"), configPath = join(directory, "private.json"), output = join(directory, "output");
  await writeFile(keyPath, "synthetic-dry-key", { mode: 0o600 }); await writeFile(configPath, JSON.stringify({ upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: keyPath } }), { mode: 0o600 });
  let requests = 0;
  try {
    await main(["--config", configPath, "--output", output, "--execute"], async (_url, init) => { requests++; const body = JSON.parse(String(init?.body));
      return Response.json({ model: body.model, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "dry_call", type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code: "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n" }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } });
    });
    const report = JSON.parse(await readFile(join(output, "report.json"), "utf8")); assert.equal(report.status, "TaskSucceeded"); assert.equal(report.upstreamMode, "controlled-upstream");
    assert.equal(report.savedEvidenceAudit.fullyVerified, true); assert.equal(requests, 1); assert.equal(report.paidInferenceAttempts, 1); assert.equal(report.realRepairValidated, false);
    assert.equal(report.localChain.providerBalanceAfter, "10000"); assert.equal(report.localChain.loanStatus, "0"); assert.equal(report.localChain.taskStatusAfter, "3");
    assert.equal(report.sourceHashes["packages/pi-loop/src/index.ts"].length, 64); assert.equal(report.sourceHashes["scripts/verify-live-pi.ts"].length, 64);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
