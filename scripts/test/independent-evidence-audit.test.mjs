import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { independentEvidenceHash, projectIndependentEconomyPublicReport, validateIndependentEconomyReport,
  validateIndependentShadowReport } from "../lib/independent-economy-evidence.mjs";

// The retained reports come from the installed external consumer's actual
// Anvil/Docker acceptance. Mutations below must fail on semantics even when
// related hashes, repeated fields and headline booleans are changed together.
const executionPath = process.env.AF_ECON_AUDIT_EXECUTION_REPORT
  ?? new URL("../../docs/acceptance/tempo-local-20261020/independent.json", import.meta.url);
const shadowPath = process.env.AF_ECON_AUDIT_SHADOW_REPORT
  ?? new URL("../../docs/acceptance/tempo-local-20261020/independent-shadow.json", import.meta.url);
const load = mode => JSON.parse(readFileSync(mode === "shadow" ? shadowPath : executionPath, "utf8"));
function reject(mutate, label) {
  const report = load(); mutate(report);
  assert.throws(() => validateIndependentEconomyReport(report), label);
}
const roundByRequest = (report, requestId) => report.rounds.find(round => round.requestId === requestId);

test("audit: retained external execution and shadow reports are independently valid with limited local scope", () => {
  const execution = load(), shadow = load("shadow");
  validateIndependentEconomyReport(execution); validateIndependentShadowReport(shadow);
  assert.equal(execution.provenance.consumer, "external-directory-installed-sdk");
  assert.equal(execution.scope.publicVendorCalls, false);
  assert.equal(execution.scope.productionNetworkUsed, false);
  assert.deepEqual(new Set(execution.interruptions.map(row => row.checkpoint)),
    new Set(["before-payment", "after-payment", "after-settlement", "after-unknown"]));
  assert.ok(execution.rounds.some(round => round.outcome === "failed"));
  assert.ok(execution.rounds.some(round => round.outcome === "refunded"));
});

test("audit: restart evidence requires every actual payment, settlement and Unknown process boundary", () => {
  reject(report => { report.interruptions[0].checkpoint = "after-observation"; }, "arbitrary checkpoints cannot establish the required crash windows");
  reject(report => { report.interruptions[0].afterPid = report.interruptions[0].beforePid; }, "same-process reconstruction is not process recovery");
  reject(report => { report.interruptions[0].originalProcessExited = false; }, "the old writer must have exited");
  reject(report => { report.interruptions[0].signal = "SIGTERM"; }, "graceful shutdown cannot replace abrupt crash evidence");
});

test("audit: matching original and recovered fields cannot jointly fabricate the remaining authorization", () => {
  for (const [field, change] of [
    ["spentRaw", value => String(BigInt(value) + 1n)],
    ["reservedRaw", value => String(BigInt(value) + 1n)],
    ["completedTasks", value => value + 1],
  ]) reject(report => {
    const interruption = report.interruptions[0], changed = change(interruption.original[field]);
    interruption.original[field] = changed; interruption.recovered[field] = changed;
  }, `${field} must agree with actual prior rounds, rather than only with its duplicate`);
  reject(report => {
    report.policy.totalSpendRaw = String(BigInt(report.policy.totalSpendRaw) + 1n);
    report.policySha256 = independentEvidenceHash(report.policy);
    for (const interruption of report.interruptions) {
      interruption.original.policySha256 = report.policySha256;
      interruption.recovered.policySha256 = report.policySha256;
    }
  }, "rehashing a changed policy must still retain the round's original policy binding");
});

test("audit: round durable identity binds the original request, payment, policy and charged budget", () => {
  for (const mutate of [
    report => { report.rounds[0].bindings.requestId = report.rounds[1].requestId; },
    report => { report.rounds[0].bindings.paymentId = report.rounds[1].quote.paymentId; },
    report => { report.rounds[0].bindings.policySha256 = "0".repeat(64); },
    report => { report.rounds[0].bindings.spentRaw = "0"; },
    report => { report.rounds[0].bindings.reservedRaw = "1"; },
    report => { report.rounds[0].bindings.completedTasks += 1; },
  ]) reject(mutate, "durable accounting identity must agree with the original round");
});

test("audit: chain payment amounts and transaction identities cannot be relabeled while keeping a passed headline", () => {
  reject(report => { report.rounds[0].payment.values.amount = String(BigInt(report.rounds[0].chargedRaw) + 1n); }, "event amount retains original quote price");
  reject(report => { report.rounds[0].payment.txHash = report.rounds[1].payment.txHash; }, "one transaction identity cannot represent two original payments");
  reject(report => { report.rounds[0].settlement.txHash = report.rounds[1].settlement.txHash; }, "one transaction identity cannot represent two independent task settlements");
  reject(report => { report.rounds[0].payment.values.agentId = "999999"; }, "payment retains original Agent");
  reject(report => { report.rounds[0].settlement.values.taskId = report.rounds[1].taskId; }, "settlement retains original task");
  reject(report => { report.rounds[0].acceptance.values.taskId = report.rounds[1].taskId; }, "cash payment's acceptance proof retains its original task");
  reject(report => { report.rounds[0].acceptance.values.agentId = "999999"; }, "acceptance retains the paying Agent");
  reject(report => { report.rounds[0].acceptance.blockNumber = report.rounds[0].payment.blockNumber + 1; }, "original acceptance precedes cash payment");
});

test("audit: Unknown remains a paid liability until the original full refund and task termination precede continuation", () => {
  reject(report => { report.unknown.after.modelCalls += 1; });
  reject(report => { report.unknown.after.paymentEvents += 1; });
  reject(report => { report.unknown.resolution.receipt.values.paymentId = report.rounds[0].quote.paymentId; });
  reject(report => { report.unknown.resolution.amountRaw = "0"; });
  reject(report => { report.unknown.resolution.terminalTaskStatus = "2"; });
  reject(report => { report.unknown.resolution.terminalEscrowBalanceRaw = "1"; });
  reject(report => {
    const continuation = roundByRequest(report, report.unknown.continuedRequestId);
    continuation.payment.blockNumber = report.unknown.resolution.receipt.blockNumber;
  });
  reject(report => {
    const original = roundByRequest(report, report.unknown.requestId);
    report.final.spentRaw = String(BigInt(report.final.spentRaw) - BigInt(original.refundedRaw));
  }, "refund cannot silently replenish the original gross authorization budget");
});

test("audit: actual history and input order independently determine the next choice", () => {
  reject(report => { report.rounds[1].observation.history = []; });
  reject(report => { report.rounds[0].counterfactual.reversedSelectedTaskId = report.rounds[1].taskId; });
  reject(report => {
    const round = report.rounds.find(round => round.observation.history.some(row => row.outcome === "failed")
      && round.counterfactual.withoutFailuresSelectedTaskId !== round.taskId);
    assert.ok(round); round.counterfactual.withoutFailuresSelectedTaskId = round.taskId;
  });
  reject(report => {
    const round = report.rounds.find(round => round.observation.history.some(row => row.outcome === "succeeded")
      && round.counterfactual.withoutSuccessesSelectedTaskId !== round.taskId);
    assert.ok(round); round.counterfactual.withoutSuccessesSelectedTaskId = round.taskId;
  });
});

test("audit: public projection drops private material at every report, receipt and restart layer", () => {
  const paths = [[], ["provenance"], ["provenance", "source"], ["publication"], ["publication", "tasks", 0],
    ["publication", "tasks", 0, "creation"], ["publication", "tasks", 0, "creation", "values"],
    ["rounds", 0], ["rounds", 0, "quote"], ["rounds", 0, "bindings"], ["rounds", 0, "acceptance"],
    ["rounds", 0, "acceptance", "values"], ["rounds", 0, "payment"],
    ["rounds", 0, "payment", "values"], ["rounds", 0, "settlement"], ["rounds", 0, "settlement", "values"],
    ["interruptions", 0], ["interruptions", 0, "original"], ["interruptions", 0, "recovered"], ["unknown"],
    ["unknown", "resolution"], ["unknown", "resolution", "receipt"], ["unknown", "resolution", "receipt", "values"], ["final"], ["cleanup"]];
  for (const path of paths) {
    const report = load(), target = path.reduce((value, key) => value[key], report), marker = "AUDIT_SECRET_CANARY_NEVER_PUBLIC";
    assert.ok(target, `actual fixture contains ${path.join(".")}`);
    Object.assign(target, { privateKey: marker, privateResponse: marker, rawTransaction: marker, signature: marker,
      rpcUrl: `http://user:${marker}@private.invalid`, journalPath: `/tmp/${marker}` });
    const projected = projectIndependentEconomyPublicReport(report), bytes = JSON.stringify(projected);
    assert.equal(bytes.includes(marker), false, `private content leaked at ${path.join(".")}`);
    for (const key of ["privateKey", "privateResponse", "rawTransaction", "signature", "rpcUrl", "journalPath"])
      assert.equal(bytes.includes(`"${key}":`), false, `private field ${key} leaked at ${path.join(".")}`);
  }
  const shadow = load("shadow"); shadow.shadow.privateResponse = "AUDIT_SECRET_SHADOW";
  shadow.shadow.observation.privateResponse = "AUDIT_SECRET_SHADOW";
  assert.equal(JSON.stringify(projectIndependentEconomyPublicReport(shadow)).includes("AUDIT_SECRET_SHADOW"), false);
});

test("audit: projection remains deterministic and read-only", () => {
  const report = load(), original = structuredClone(report);
  const first = projectIndependentEconomyPublicReport(report), second = projectIndependentEconomyPublicReport(report);
  assert.deepEqual(first, second); assert.deepEqual(report, original);
});
