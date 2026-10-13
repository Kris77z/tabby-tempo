import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutonomyDecisionPrompt, parseAutonomyDecision, runAutonomy, type AutonomyConfig, type AutonomyDependencies, type AutonomyState } from "../src/autonomy.js";

const config = (patch: Partial<AutonomyConfig> = {}): AutonomyConfig => ({ version: 1, sessionId: "test-session", maxTasks: 2, maxSpendRaw: "100", deadlineMs: Date.now() + 60000,
  maxDecisions: 3, models: ["cheap", "strong"], funding: ["cash", "credit", "reward-tokens"], decisionReserveRaw: "5", ...patch });
const action = { action: "run-task", modelId: "cheap", funding: "credit" } as const;
const deps = (patch: Partial<AutonomyDependencies> = {}): AutonomyDependencies => ({
  observe: async () => ({ cashRaw: "10", debtRaw: "0", creditAvailableRaw: "100", inferenceCreditsAvailable: "4096", availableTasks: 2 }),
  decide: async () => ({ decision: action, chargedRaw: "2" }),
  execute: async () => ({ terminal: true, success: true, chargedRaw: "20" }),
  recover: async () => { throw new Error("Unexpected recovery"); }, ...patch,
});
async function fixture(work: (directory: string) => Promise<void>) { const directory = await mkdtemp(join(tmpdir(), "af-autonomy-")); try { await work(directory); } finally { await rm(directory, { force: true, recursive: true }); } }
const saved = async (directory: string): Promise<AutonomyState> => JSON.parse(await readFile(join(directory, "session.json"), "utf8"));

test("planner receives financial facts and loop enforces task count and cumulative spending", async () => fixture(async directory => {
  const contexts: any[] = [], childIds: string[] = [], limits: string[] = []; const input = config();
  const options = deps({ decide: async (context, id, bound) => { contexts.push(context); assert.ok(id); assert.equal(bound.maxSpendRaw, "5"); return { decision: JSON.stringify(action), chargedRaw: "2" }; },
    execute: async (decision, id, bound) => { childIds.push(id); limits.push(bound.maxSpendRaw); assert.deepEqual(decision, action);
      const journal = await saved(directory); assert.equal(journal.phase, "Executing"); assert.equal(journal.steps.at(-1)?.childId, id);
      return { terminal: true, success: true, chargedRaw: "20" }; } });
  const result = await runAutonomy(directory, input, options);
  assert.equal(result.phase, "Completed"); assert.equal(result.reason, "AUTONOMY_TASK_LIMIT"); assert.equal(result.chargedRaw, "44"); assert.equal(result.completedTasks, 2);
  assert.equal(new Set(childIds).size, 2); assert.deepEqual(limits, ["98", "76"]); assert.equal(contexts[1].completedTasks, 1); assert.equal(contexts[1].observation.debtRaw, "0");
  assert.match(createAutonomyDecisionPrompt(contexts[0])[0].content, /ONLY JSON/);
  assert.deepEqual(await runAutonomy(directory, input, options, true), result); assert.equal(childIds.length, 2);
  await assert.rejects(runAutonomy(directory, { ...input, maxTasks: 3 }, options), /CONFIG_MISMATCH/);
}));

test("strict decision parser prevents invented actions, model routes and funding", () => {
  for (const decision of [null, {}, { action: "game" }, { ...action, modelId: "arbitrary" }, { ...action, funding: "borrow-for-game" },
    { ...action, maxSpendRaw: "9999" }, { action: "stop", reason: "" }, "```json\n{}\n```", { action: "stop", reason: "ok", next: action }]) {
    assert.throws(() => parseAutonomyDecision(decision, config()), /INVALID_DECISION/);
  }
  assert.deepEqual(parseAutonomyDecision('{"action":"stop","reason":"No feasible task"}', config()), { action: "stop", reason: "No feasible task" });
});

test("unknown decision transport and crash markers never redispatch a paid planner call", async () => fixture(async directory => {
  let calls = 0; const input = config(), options = deps({ decide: async () => { calls++; throw new Error("socket lost after send"); } });
  let result = await runAutonomy(directory, input, options); assert.equal(result.reason, "AUTONOMY_DECISION_UNKNOWN");
  result = await runAutonomy(directory, input, options, true); assert.equal(result.phase, "Paused"); assert.equal(calls, 1);
  result.phase = "Deciding"; delete result.reason; await writeFile(join(directory, "session.json"), JSON.stringify(result));
  result = await runAutonomy(directory, input, options, true); assert.equal(result.reason, "AUTONOMY_DECISION_UNKNOWN"); assert.equal(calls, 1);
}));

test("pending and unknown child uses the original ID and cumulative charge on resume", async () => fixture(async directory => {
  let executed = 0, recovered = 0, planned = 0, child = ""; const input = config({ maxTasks: 1 });
  const options = deps({ decide: async () => { planned++; return { decision: action, chargedRaw: "2" }; },
    execute: async (_action, id) => { executed++; child = id; return { terminal: false, success: false, chargedRaw: "7", reason: "INFERENCE_FUNDING_REQUIRED" }; },
    recover: async (id, bound) => { recovered++; assert.equal(id, child); assert.equal(bound.maxSpendRaw, "98");
      if (recovered === 1) throw new Error("unknown"); return { terminal: true, success: true, chargedRaw: "20" }; } });
  const first = await runAutonomy(directory, input, options); assert.equal(first.phase, "Paused"); assert.equal(first.chargedRaw, "9");
  const second = await runAutonomy(directory, input, options, true); assert.equal(second.reason, "AUTONOMY_CHILD_UNKNOWN");
  const final = await runAutonomy(directory, input, options, true); assert.equal(final.phase, "Completed"); assert.equal(final.chargedRaw, "22");
  assert.equal(executed, 1); assert.equal(planned, 1); assert.equal(recovered, 2);
}));

test("child failure stops subsequent tasks and decision rejection still accounts for planner charge", async t => {
  await t.test("failure", async () => fixture(async directory => {
    let calls = 0; const result = await runAutonomy(directory, config(), deps({ execute: async () => { calls++; return { terminal: true, success: false, chargedRaw: "7", reason: "VERIFICATION_FAILED" }; } }));
    assert.equal(result.phase, "Stopped"); assert.equal(result.reason, "VERIFICATION_FAILED"); assert.equal(result.chargedRaw, "9"); assert.equal(calls, 1);
  }));
  await t.test("invalid decision", async () => fixture(async directory => {
    const result = await runAutonomy(directory, config(), deps({ decide: async () => ({ decision: { ...action, modelId: "bad" }, chargedRaw: "3" }) }));
    assert.equal(result.reason, "AUTONOMY_INVALID_DECISION"); assert.equal(result.chargedRaw, "3"); assert.equal(result.startedTasks, 0);
  }));
});

test("bounds cover deadline, decision count, planner reservation and actual charge overruns", async t => {
  await t.test("deadline", async () => fixture(async directory => { const result = await runAutonomy(directory, config({ deadlineMs: 1 }), deps({ observe: async () => { throw new Error("must not observe"); } })); assert.equal(result.reason, "AUTONOMY_DEADLINE"); }));
  await t.test("decision count", async () => fixture(async directory => { const result = await runAutonomy(directory, config({ maxDecisions: 1 }), deps()); assert.equal(result.reason, "AUTONOMY_DECISION_LIMIT"); assert.equal(result.startedTasks, 1); }));
  await t.test("planner reservation", async () => fixture(async directory => { const result = await runAutonomy(directory, config({ maxSpendRaw: "4" }), deps()); assert.equal(result.reason, "AUTONOMY_BUDGET_LIMIT"); assert.equal(result.steps.length, 0); }));
  await t.test("planner overrun", async () => fixture(async directory => { const result = await runAutonomy(directory, config(), deps({ decide: async () => ({ decision: action, chargedRaw: "6" }) })); assert.equal(result.reason, "AUTONOMY_BUDGET_EXCEEDED"); assert.equal(result.startedTasks, 0); assert.equal(result.chargedRaw, "6"); }));
  await t.test("child overrun cannot be replayed", async () => fixture(async directory => { const input = config(); const result = await runAutonomy(directory, input, deps({ execute: async () => ({ terminal: true, success: true, chargedRaw: "99" }) }));
    assert.equal(result.reason, "AUTONOMY_BUDGET_EXCEEDED"); assert.equal(result.chargedRaw, "101"); assert.deepEqual(await runAutonomy(directory, input, deps(), true), result);
  }));
});

test("simultaneous invocations cannot dispatch duplicate child or planner", async () => fixture(async directory => {
  let release!: () => void, observed!: () => void; const entered = new Promise<void>(resolve => { observed = resolve; }); const gate = new Promise<void>(resolve => { release = resolve; });
  const input = config({ maxTasks: 1 }); const first = runAutonomy(directory, input, deps({ decide: async () => { observed(); await gate; return { decision: action, chargedRaw: "0" }; } }));
  await entered; try { await assert.rejects(runAutonomy(directory, input, deps(), true), /SESSION_BUSY/); } finally { release(); }
  assert.equal((await first).phase, "Completed");
}));

test("a crash after execute journal only recovers original child even after deadline", async () => fixture(async directory => {
  let executions = 0; const input = config(); let now = 1;
  const first = await runAutonomy(directory, input, deps({ now: () => now, execute: async () => { executions++; throw new Error("crash"); } }));
  const id = first.steps[0].childId; now = input.deadlineMs + 1;
  const final = await runAutonomy(directory, input, deps({ now: () => now, recover: async childId => { assert.equal(childId, id); return { terminal: true, success: true, chargedRaw: "20" }; } }), true);
  assert.equal(final.reason, "AUTONOMY_DEADLINE"); assert.equal(final.completedTasks, 1); assert.equal(executions, 1);
}));

test("deadline reached during planner dispatch never starts the selected task", async () => fixture(async directory => {
  const input = config(); let now = input.deadlineMs - 1;
  const result = await runAutonomy(directory, input, deps({ now: () => now, decide: async () => { now = input.deadlineMs; return { decision: action, chargedRaw: "2" }; },
    execute: async () => { throw new Error("must not execute"); } }));
  assert.equal(result.reason, "AUTONOMY_DEADLINE"); assert.equal(result.startedTasks, 0); assert.equal(result.chargedRaw, "2");
}));

test("reward-funded tasks may continue with zero currency budget, and an explicit stop persists", async () => fixture(async directory => {
  const input = config({ maxSpendRaw: "0", decisionReserveRaw: "0" }); let decisions = 0;
  const result = await runAutonomy(directory, input, deps({ decide: async () => ({ decision: ++decisions === 1 ? { ...action, funding: "reward-tokens" } : { action: "stop", reason: "Inference credits exhausted" }, chargedRaw: "0" }),
    execute: async (_decision, _id, bound) => { assert.equal(bound.maxSpendRaw, "0"); return { terminal: true, success: true, chargedRaw: "0" }; } }));
  assert.equal(result.reason, "Inference credits exhausted"); assert.equal(result.completedTasks, 1); assert.equal(result.chargedRaw, "0");
  assert.deepEqual(await runAutonomy(directory, input, deps(), true), result);
}));

test("child charge regressions cannot reopen spent budget", async () => fixture(async directory => {
  const input = config(); const options = deps({ execute: async () => ({ terminal: false, success: false, chargedRaw: "20" }), recover: async () => ({ terminal: true, success: true, chargedRaw: "10" }) });
  await runAutonomy(directory, input, options); const result = await runAutonomy(directory, input, options, true);
  assert.equal(result.reason, "AUTONOMY_CHARGE_REGRESSION"); assert.equal(result.chargedRaw, "22"); assert.equal(result.completedTasks, 0);
  assert.deepEqual(await runAutonomy(directory, input, options, true), result);
}));

test("verified partial refunds lower net charges without replenishing the session spending ceiling", async () => fixture(async directory => {
  const input = config({ maxTasks: 2, maxSpendRaw: "100" }); let executions = 0;
  const options = deps({ execute: async (_action, _id, limits) => { executions++;
    if (executions === 1) return { terminal: false, success: false, chargedRaw: "60", refundedRaw: "0" };
    assert.equal(limits.maxSpendRaw, "36"); return { terminal: true, success: true, chargedRaw: "30", refundedRaw: "0" };
  }, recover: async () => ({ terminal: true, success: true, chargedRaw: "40", refundedRaw: "20" }) });
  assert.equal((await runAutonomy(directory, input, options)).chargedRaw, "62");
  const result = await runAutonomy(directory, input, options, true);
  assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "74"); assert.equal(result.completedTasks, 2);
}));

test("new priced observations preserve old decision journals and only affect the next decision", async () => fixture(async directory => {
  const input = config({ maxSpendRaw: "200" }); let executed = 0;
  const first = await runAutonomy(directory, input, deps({ decide: async () => ({ decision: { ...action, funding: "cash" }, chargedRaw: "2" }),
    execute: async () => { executed++; return { terminal: false, success: false, chargedRaw: "0" }; } }));
  const old = structuredClone(first.steps[0]); let newPlans = 0;
  const result = await runAutonomy(directory, input, deps({
    observe: async () => ({ cashRaw: "50", debtRaw: "0", creditAvailableRaw: "100", inferenceCreditsAvailable: "0", executionCosts: {
      planningCashRaw: "2", taskPackagePriceRaw: "60", taskPackageCreditsRaw: "200000", taskPerRunLimitRaw: "100", taskCreditLimitRaw: "100", borrowerFeeBps: "1500",
      modelTiers: [{ modelId: "cheap", tiers: ["cheap"] }, { modelId: "strong", tiers: ["strong"] }], tokenRates: [
        { tier: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" }, { tier: "strong", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6" }],
    } }),
    recover: async id => { assert.equal(id, old.childId); return { terminal: true, success: true, chargedRaw: "20" }; },
    decide: async context => { newPlans++; assert.equal(context.fundingQuote?.cashAfterPlanningRaw, "48"); assert.equal(context.fundingQuote?.options[0].feasible, false);
      assert.equal(context.fundingQuote?.options[1].feasible, true); return { decision: action, chargedRaw: "2" }; },
    execute: async () => { executed++; return { terminal: true, success: true, chargedRaw: "20" }; },
  }), true);
  assert.equal(newPlans, 1); assert.equal(executed, 2); assert.deepEqual(result.steps[0].context, old.context); assert.deepEqual(result.steps[0].decision, old.decision);
  assert.equal(result.steps[0].context.observation.executionCosts, undefined); assert.equal(result.phase, "Completed");
}));

test("unknown paid decision is never redispatched; explicit full refund retains its decision and gross budget", async () => fixture(async directory => {
  const input = config({ maxSpendRaw: "100", decisionReserveRaw: "10" }); let plans = 0, reconciles = 0, cleared = false;
  const ids: string[] = [], limits: string[] = [];
  const options = deps({ decide: async (_context, id) => { ids.push(id); if (++plans === 1) throw new Error("paid upstream uncertain"); return { decision: action, chargedRaw: "10" }; },
    recoverDecision: async (_context, id) => { reconciles++; assert.equal(id, ids[0]); return cleared
      ? { status: "refunded-undelivered", chargedRaw: "0", refundedRaw: "10", evidence: { paymentId: "same-payment", resolutionId: "operator", evidenceDigest: "digest" } }
      : { status: "unknown", chargedRaw: "10", refundedRaw: "0" }; },
    execute: async (_action, _id, bound) => { limits.push(bound.maxSpendRaw); return { terminal: true, success: true, chargedRaw: "20" }; } });
  const first = await runAutonomy(directory, input, options); assert.equal(first.chargedRaw, "10"); assert.equal(first.reason, "AUTONOMY_DECISION_UNKNOWN");
  await runAutonomy(directory, input, options, true); assert.equal(plans, 1); assert.equal(reconciles, 2);
  cleared = true; const done = await runAutonomy(directory, input, options, true);
  assert.equal(done.phase, "Completed"); assert.equal(done.completedTasks, 2); assert.equal(done.chargedRaw, "60");
  assert.equal(done.steps.length, 3); assert.equal(done.steps[0].decision, undefined); assert.equal(done.steps[0].decisionRefundedRaw, "10");
  assert.equal(new Set(ids).size, 3); assert.deepEqual(limits, ["80", "50"]);
}));

test("decision refund without explicit clearance stays paused; verified clearance after original deadline never dispatches", async () => fixture(async directory => {
  const input = config(); let plans = 0, clear = false, now = 1;
  const options = deps({ now: () => now, decide: async () => { plans++; throw new Error("unknown"); },
    recoverDecision: async () => ({ status: clear ? "refunded-undelivered" : "unknown", chargedRaw: "0", refundedRaw: "5",
      ...(clear ? { evidence: { paymentId: "payment", resolutionId: "resolution", evidenceDigest: "evidence" } } : {}) }) });
  const paused = await runAutonomy(directory, input, options); assert.equal(paused.phase, "Paused");
  now = input.deadlineMs + 1; clear = true;
  const stopped = await runAutonomy(directory, input, options, true); assert.equal(stopped.reason, "AUTONOMY_DEADLINE"); assert.equal(plans, 1); assert.equal(stopped.steps.length, 1);
}));

test("decision parser accepts only a complete single json fence and preserves field allowlists", () => {
  assert.deepEqual(parseAutonomyDecision('```json\n{"action":"run-task","modelId":"cheap","funding":"credit"}\n```', config()), action);
  for (const text of ['preface\n```json\n{}\n```', '```json\n{}\n```\nafter', '```\n{}\n```', '```js\n{}\n```', '```json\n{}\n```\n```json\n{}\n```',
    '```json\n{"action":"run-task","modelId":"cheap","funding":"credit","extra":1}\n```']) assert.throws(() => parseAutonomyDecision(text, config()), /INVALID_DECISION/);
});

test("a parser-rejected paid decision recovers only its cached response without another planner charge or ID", async () => fixture(async directory => {
  const input = config({ maxTasks: 1 }); let planned = 0, cached = 0, executed = 0;
  const options = deps({ decide: async () => { planned++; return { decision: "old-parser-rejected", chargedRaw: "2" }; },
    recoverCachedDecision: async (_context, id) => { cached++; assert.equal(id, (await saved(directory)).steps[0].decisionId); return { decision: '```json\n{"action":"run-task","modelId":"cheap","funding":"credit"}\n```', chargedRaw: "2" }; },
    execute: async (_action, _id, limits) => { executed++; assert.equal(limits.maxSpendRaw, "98"); return { terminal: true, success: true, chargedRaw: "20" }; } });
  const first = await runAutonomy(directory, input, options); assert.equal(first.reason, "AUTONOMY_INVALID_DECISION"); assert.equal(first.chargedRaw, "2");
  assert.deepEqual(await runAutonomy(directory, input, options), first);
  const result = await runAutonomy(directory, input, options, true); assert.equal(result.phase, "Completed"); assert.equal(result.chargedRaw, "22");
  assert.equal(result.steps.length, 1); assert.equal(result.steps[0].decisionId, first.steps[0].decisionId); assert.equal(planned, 1); assert.equal(cached, 1); assert.equal(executed, 1);
  await runAutonomy(directory, input, options, true); assert.equal(executed, 1);
}));

test("cached parser recovery cannot change charged amount or extend its original deadline", async () => fixture(async directory => {
  const input = config(); let now = 1, calls = 0;
  const options = deps({ now: () => now, decide: async () => ({ decision: "invalid", chargedRaw: "2" }), recoverCachedDecision: async () => { calls++; return { decision: action, chargedRaw: "1" }; } });
  const first = await runAutonomy(directory, input, options);
  assert.deepEqual(await runAutonomy(directory, input, options, true), first); assert.equal(calls, 1);
  now = input.deadlineMs; assert.deepEqual(await runAutonomy(directory, input, options, true), first); assert.equal(calls, 1);
}));

test("safe model stop accepts bounded long explanations, truncates storage and keeps exact schema", async () => fixture(async directory => {
  const long = "Funding requires checking the principal credit limit. ".repeat(10);
  assert.ok(long.length > 240);
  assert.deepEqual(parseAutonomyDecision({ action: "stop", reason: long }, config()), { action: "stop", reason: long.trim().slice(0, 240) });
  assert.equal(parseAutonomyDecision({ action: "stop", reason: "x".repeat(4096) }, config()).action, "stop");
  for (const value of [{ action: "stop", reason: " " }, { action: "stop", reason: "x".repeat(4097) }, { action: "stop", reason: 1 },
    { action: "stop", reason: "safe", modelId: "cheap" }, { ...action, reason: "ignored" }]) assert.throws(() => parseAutonomyDecision(value, config()), /INVALID_DECISION/);
  let executions = 0;
  const result = await runAutonomy(directory, config(), deps({ decide: async () => ({ decision: JSON.stringify({ action: "stop", reason: long }), chargedRaw: "2" }),
    execute: async () => { executions++; throw new Error("stop must not dispatch"); } }));
  assert.equal(result.phase, "Stopped"); assert.equal(result.reason, long.trim().slice(0, 240)); assert.equal(result.chargedRaw, "2"); assert.equal(executions, 0);
  assert.equal((await saved(directory)).steps[0].decision?.action, "stop"); assert.equal(JSON.stringify(await saved(directory)).includes(long), false);
}));

test("planner prompt distinguishes cash-first credit principal, fee repayment and inference accounting units", () => {
  const prompt = createAutonomyDecisionPrompt({ observation: { cashRaw: "50000", debtRaw: "0", creditAvailableRaw: "80000", inferenceCreditsAvailable: "200000" },
    completedTasks: 0, startedTasks: 0, decisions: 0, remainingTasks: 2, remainingSpendRaw: "260000", deadlineMs: Date.now() + 60000, models: ["cheap", "strong"], funding: ["cash", "credit"] })[0].content;
  for (const wording of ["AFTER planning", "feasible=true", "borrowed PRINCIPAL fromCreditRaw", "does not consume the upfront planner/package spending budget", "never USDC cash or debt", "at most 240 characters", "No model choice is mandated"]) assert.ok(prompt.includes(wording));
});
