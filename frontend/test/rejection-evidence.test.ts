import assert from "node:assert/strict";
import test from "node:test";
import { Interface } from "ethers";
import { ACCOUNT_ABI } from "../lib/abi";
import { explainError } from "../lib/errors";
import { readRejectionEvidence } from "../lib/rejection-evidence";
import { rejectionFixture } from "./rejection-fixture";

test("actual mined rejection is verified with historical eth_call, without signatures or a new transaction", { timeout: 90_000 }, async () => {
  const local = await rejectionFixture();
  try {
    const nonce = await local.f.provider.send("eth_getTransactionCount", [local.f.agentAddress, "latest"]);
    const evidence = await readRejectionEvidence(local.config, local.statePath);
    assert.equal(evidence.hash, local.state.reverse.spendRejected.txHash);
    assert.equal(evidence.status, 0); assert.equal(evidence.logCount, 0); assert.equal(evidence.agentId, "1");
    assert.equal(evidence.from, local.f.agentAddress); assert.equal(evidence.payee, local.target); assert.equal(evidence.amount, "120000");
    assert.equal(evidence.revertData, local.state.reverse.spendRejected.revertData);
    assert.equal(explainError({ data: evidence.revertData }).code, "SpendRejected");
    assert.match(explainError({ data: evidence.revertData }).message, /白名单/);
    assert.equal(JSON.stringify(evidence).includes("PRIVATE_TEST_CANARY"), false);
    assert.equal("contexts" in evidence, false);
    assert.equal(await local.f.provider.send("eth_getTransactionCount", [local.f.agentAddress, "latest"]), nonce);
  } finally { await local.close(); }
});

test("wrong chain, a successful receipt, and mismatched state cannot become verified rejection evidence", { timeout: 90_000 }, async () => {
  const local = await rejectionFixture();
  try {
    await assert.rejects(readRejectionEvidence({ ...local.config, chainId: "10143" }, local.statePath), /UNVERIFIABLE/);
    const original = structuredClone(local.state);
    local.state.reverse.spendRejected.txHash = local.successful.hash;
    local.state.reverse.spendRejected.blockNumber = local.successful.blockNumber;
    await local.save(); await assert.rejects(readRejectionEvidence(local.config, local.statePath), /UNVERIFIABLE/);
    Object.assign(local.state, structuredClone(original)); local.state.agents.hero = "2";
    await local.save(); await assert.rejects(readRejectionEvidence(local.config, local.statePath), /UNVERIFIABLE/);
    Object.assign(local.state, structuredClone(original)); local.state.addresses.account = local.config.contracts.manager;
    await local.save(); await assert.rejects(readRejectionEvidence(local.config, local.statePath), /UNVERIFIABLE/);
    Object.assign(local.state, structuredClone(original)); local.state.reverse.spendRejected.blockNumber++;
    await local.save(); await assert.rejects(readRejectionEvidence(local.config, local.statePath), /UNVERIFIABLE/);
    Object.assign(local.state, structuredClone(original));
    local.state.reverse.spendRejected.revertData = new Interface(ACCOUNT_ABI).encodeErrorResult("SpendRejected", [1, local.f.payee, 1]);
    await local.save(); await assert.rejects(readRejectionEvidence(local.config, local.statePath), /UNVERIFIABLE/);
  } finally { await local.close(); }
});
