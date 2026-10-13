import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Interface } from "ethers";
import { createHostedTaskFixture } from "./task-fixture.js";
import { readHostedFinance } from "../src/finance-reader.js";

test("hosted finance follows the actual hosted identity, complete debt ledger, Underwriter changes and canonical settlement proof", { timeout: 90000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-finance-"))), f = await createHostedTaskFixture(directory);
  try {
    const actor = await f.actor(33), other = await f.actor(34);
    actor.agent.binding = (await f.executor.execute(actor.input("provision"))).binding;
    other.agent.binding = (await f.executor.execute(other.input("provision"))).binding;
    const before = await f.executor.finance(actor.agent); assert.equal(before.status, "confirmed", JSON.stringify(before));
    if (before.status !== "confirmed") throw new Error("Expected confirmed snapshot");
    assert.equal(before.agentId, "2"); assert.equal(before.wallet, actor.wallet.address); assert.equal(before.cashRaw, "40000"); assert.equal(before.debtRaw, "0");
    assert.equal(before.credit.score, "500"); assert.equal(before.credit.tier, "C"); assert.equal(before.counts.repayments, "0");
    f.fx.queue(f.GOOD_CODE["sum-integers"]);
    const result = await f.executor.execute(actor.input("task")); assert.equal(result.phase, "Succeeded", JSON.stringify(result));
    assert.equal(result.fromCashRaw, "40000"); assert.equal(result.fromCreditRaw, "80000"); assert.equal(result.refundedRaw, "0");
    assert.equal(result.settlement?.repaidRaw, "92000"); assert.equal(result.settlement?.residualRaw, "58000"); assert.equal(result.settlement?.loanStatus, "2");
    assert.equal(result.txHash, result.settlement?.txHash); assert.notEqual(result.txHash, result.acceptTxHash); assert.notEqual(result.paymentTxHash, result.acceptTxHash);
    const receipt = await f.fx.f.provider.getTransactionReceipt(result.settlement!.txHash);
    assert.equal(receipt?.status, 1); assert.equal(receipt?.blockHash, result.settlement!.block.hash);
    assert.ok(receipt?.logs.some(log => log.address.toLowerCase() === f.config.models[0].templates.balanced.escrowAddress.toLowerCase()));
    const after = await f.executor.finance(actor.agent); assert.equal(after.status, "confirmed", JSON.stringify(after));
    if (after.status !== "confirmed") throw new Error("Expected confirmed snapshot");
    assert.equal(after.cashRaw, "58000"); assert.equal(after.debtRaw, "0"); assert.equal(after.counts.repayments, "1"); assert.equal(after.counts.mirrorRepayments, "1");
    assert.equal(after.counts.successes, "1"); assert.equal(after.credit.score, "570"); assert.equal(after.credit.tier, "C"); assert.equal(after.ownedTaskCount, 1);
    assert.ok(after.block.number >= result.settlement!.block.number);
    // An unresolved paid request creates real debt for a different hosted identity.
    f.fx.queue("unknown"); const pending = await f.executor.execute(other.input("task")); assert.equal(pending.phase, "Paused", JSON.stringify(pending));
    assert.equal(pending.settlement, undefined); assert.equal(pending.txHash, undefined); assert.ok(pending.paymentTxHash); assert.ok(pending.acceptTxHash);
    const nonce = await f.fx.f.provider.getTransactionCount(other.wallet.address), calls = f.fx.calls.length;
    const outstanding = await f.executor.finance(other.agent); assert.equal(outstanding.status, "confirmed", JSON.stringify(outstanding));
    if (outstanding.status !== "confirmed") throw new Error("Expected confirmed snapshot");
    assert.equal(outstanding.agentId, "3"); assert.equal(outstanding.cashRaw, "0"); assert.equal(outstanding.debtRaw, "92000"); assert.equal(outstanding.counts.repayments, "0");
    assert.equal((await f.executor.finance(actor.agent)).status, "confirmed");
    assert.equal(await f.fx.f.provider.getTransactionCount(other.wallet.address), nonce); assert.equal(f.fx.calls.length, calls, "Financial reads never execute a model or transaction");
    const badBinding = await f.executor.finance({ ...actor.agent, binding: { ...other.agent.binding!, wallet: actor.wallet.address } });
    assert.equal(badBinding.status, "unavailable"); assert.ok(!("cashRaw" in badBinding)); assert.ok(!("debtRaw" in badBinding));
    const unavailable = await readHostedFinance(f.config, actor.agent, { provider: f.fx.f.provider, fetcher: (async () => Response.json({ error: "unavailable" }, { status: 503 })) as typeof fetch });
    assert.deepEqual([unavailable.status, "debtRaw" in unavailable], ["unavailable", false]);
    const reorg = await readHostedFinance(f.config, actor.agent, { provider: f.fx.f.provider, fetcher: (async (url, options) => {
      const c = await (await fetch(url, options)).json(); c.block.hash = "0x" + "0".repeat(64); return Response.json(c);
    }) as typeof fetch });
    assert.equal(reorg.status, "unavailable"); if (reorg.status === "unavailable") assert.equal(reorg.reason, "HOSTED_FINANCE_SNAPSHOT_REORG");
    const rpc = f.fx.f.provider, originalCall = rpc.call.bind(rpc), next = new Interface(["function nextTaskId() view returns(uint256)"]);
    rpc.call = async transaction => String(transaction.data).startsWith(next.getFunction("nextTaskId")!.selector)
      ? next.encodeFunctionResult("nextTaskId", [202n]) : originalCall(transaction);
    try {
      const limited = await f.executor.finance(actor.agent); assert.equal(limited.status, "unavailable");
      if (limited.status === "unavailable") assert.equal(limited.reason, "HOSTED_FINANCE_LEDGER_LIMIT"); assert.ok(!("debtRaw" in limited));
    } finally { rpc.call = originalCall; }
    for (const secret of [directory, f.fx.local.rpc, f.config.underwriterUrl]) assert.equal(JSON.stringify(after).includes(secret), false);
  } finally { await f.close(); await rm(directory, { recursive: true, force: true }); }
});
