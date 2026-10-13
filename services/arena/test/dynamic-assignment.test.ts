import assert from "node:assert/strict";
import test from "node:test";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Wallet } from "ethers";
import { createWorkflowFixture } from "../../../packages/pi-loop/test/workflow-fixture.js";
import { key, tx } from "../../underwriter/test/fixture.js";
import { authorizeSubmission, submissionTypedData } from "../src/submission-auth.js";
import { parseConfig, validateVerdict } from "../src/protocol.js";
import { readControllerToken, requestSettlement } from "../src/ipc.js";

test("dynamic Arena catalog resolves the actual registered Assigned Agent, rejects another signer/Open task and keeps the trusted problem", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-arena-dynamic-"));
  const fx = await createWorkflowFixture(directory, [{ problemId: "sum-integers", open: true, agentId: null }, { problemId: "unique-sorted", open: true, agentId: null }]);
  try {
    const actor = new Wallet(key(20), fx.f.provider); await fx.f.provider.send("anvil_setBalance", [actor.address, "0x3635c9adc5dea00000"]);
    const registration = await tx(fx.f.identity, actor, "register(string)", ["urn:agentfuel:test:dynamic"]);
    const event = registration.logs.map((log: any) => { try { return fx.f.identity.interface.parseLog(log); } catch { return null; } }).find((event: any) => event?.name === "Registered");
    const agentId = String(event.args.agentId), config = parseConfig(structuredClone(fx.arenaConfig));
    assert.equal(agentId, "2"); assert.equal(config.tasks[fx.config.tasks[0].taskId].agentId, undefined);
    const block = (await fx.f.provider.getBlock("latest"))!, payload = { taskId: fx.config.tasks[0].taskId, code: "print(0)", deadline: String(block.timestamp + 200) };
    assert.throws(() => submissionTypedData(config, payload), /TASK_AGENT_REQUIRED/);
    const typed = submissionTypedData(config, payload, agentId), signature = await actor.signTypedData(typed.domain, typed.types, typed.message);
    await assert.rejects(authorizeSubmission(fx.f.provider, config, { ...payload, signature }), /TASK_NOT_ASSIGNED/);
    await tx(fx.f.escrow, actor, "acceptTask", [payload.taskId, agentId]);
    await authorizeSubmission(fx.f.provider, config, { ...payload, signature });
    const other = new Wallet(key(2), fx.f.provider), forged = await other.signTypedData(typed.domain, typed.types, typed.message);
    await assert.rejects(authorizeSubmission(fx.f.provider, config, { ...payload, signature: forged }), /SUBMISSION_SIGNER_MISMATCH/);
    const otherAgent = submissionTypedData(config, payload, "1"), wrongAgent = await other.signTypedData(otherAgent.domain, otherAgent.types, otherAgent.message);
    await assert.rejects(authorizeSubmission(fx.f.provider, config, { ...payload, signature: wrongAgent }), /SUBMISSION_SIGNER_MISMATCH/);
    const verdict = { version: 1 as const, runId: randomUUID(), chainId: config.chainId, escrowAddress: config.escrowAddress, taskId: payload.taskId,
      agentId, problemId: "sum-integers" as const, passed: true, mode: "docker" as const, evidenceHash: "0".repeat(64) };
    assert.deepEqual(validateVerdict(verdict, config), verdict);
    assert.throws(() => validateVerdict({ ...verdict, problemId: "unique-sorted" }, config), /TASK_NOT_AUTHORIZED/);
    const before = await fx.f.provider.getTransactionCount(new Wallet(key(1)).address), token = await readControllerToken(config.ipcDirectory);
    await assert.rejects(requestSettlement(config.ipcDirectory, token, { ...verdict, agentId: "1" }), /TASK_AGENT_MISMATCH/);
    await assert.rejects(requestSettlement(config.ipcDirectory, token, { ...verdict, taskId: fx.config.tasks[1].taskId, problemId: "unique-sorted" }), /TASK_NOT_ASSIGNED/);
    assert.equal(await fx.f.provider.getTransactionCount(new Wallet(key(1)).address), before);
    assert.equal(fx.calls.length, 0);
  } finally { await fx.close(); await rm(directory, { recursive: true, force: true }); }
});
