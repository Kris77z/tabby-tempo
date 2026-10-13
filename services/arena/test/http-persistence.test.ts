import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { fixture, key, startAnvil, stopAnvil } from "../../underwriter/test/fixture.js";
import { ArenaController } from "../src/controller.js";
import { createArenaHttpServer, type ArenaHttpJournal } from "../src/http.js";
import { digest, type ArenaConfig } from "../src/protocol.js";
import { submissionTypedData } from "../src/submission-auth.js";

// Only the HTTP persistence seam is controlled here. Original Arena tests cover real independent settlement.
test("durable HTTP admission/results survive restart and never turn a save failure into delivered success", { timeout: 30000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-arena-http-")), local = await startAnvil();
  const f = await fixture(local.rpc, directory, 6);
  let service: ReturnType<typeof createArenaHttpServer> | undefined;
  try {
    const taskId = String(await f.task()); const config: ArenaConfig = { rpcUrl: local.rpc, chainId: "31337", escrowAddress: await f.escrow.getAddress(), ipcDirectory: join(directory, "ipc"), tasks: { [taskId]: { agentId: "1", problemId: "sum-integers" } } };
    const payload = { taskId, code: "print(9)", deadline: String((await f.provider.getBlock("latest"))!.timestamp + 300), signature: "" };
    const typed = submissionTypedData(config, payload); payload.signature = await new Wallet(key(2)).signTypedData(typed.domain, typed.types, typed.message);
    let calls = 0;
    const controller = t.mock.method(ArenaController.prototype, "submit", async ({ runId }: { runId?: string }) => { calls++; return { verdict: { version: 1 as const, runId: runId!, chainId: "31337", escrowAddress: config.escrowAddress, taskId, agentId: "1", problemId: "sum-integers", passed: true, mode: "docker" as const, evidenceHash: "controlled-persistence-only" }, tests: [], settlement: { taskId, runId: runId!, passed: true, txHash: "controlled-no-transaction", blockNumber: 1, feedback: [] } }; });
    const start = async (initial?: ArenaHttpJournal, fail?: "admission" | "settled") => {
      let journal = initial, saves = 0;
      service = createArenaHttpServer(config, [], f.provider, { initial, save: async state => { saves++; if (fail === "admission" || fail === "settled" && state.runs.some(r => r.status === "settled")) throw new Error("controlled write failure"); journal = structuredClone(state); } });
      service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
      const url = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
      const post = () => fetch(url + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      return { post, get: (id: string) => fetch(url + "/runs/" + id), journal: () => journal!, saves: () => saves };
    };
    const admitted = await start(); const first = await admitted.post(); assert.equal(first.status, 202); const runId = (await first.json()).runId;
    for (let i = 0; i < 50 && admitted.journal().runs[0].status !== "settled"; i++) await new Promise(r => setTimeout(r, 10));
    assert.equal(admitted.journal().runs[0].status, "settled"); assert.equal(calls, 1); const saved = admitted.journal(); await service!.close();
    const restored = await start(saved); assert.equal((await (await restored.get(runId)).json()).status, "settled"); const replay = await restored.post(); assert.equal(replay.status, 200); assert.equal((await replay.json()).runId, runId); assert.equal(calls, 1); await service!.close();
    const interrupted = await start({ runs: [{ runId, taskId, status: "running" }], submissions: [[taskId, { runId, requestHash: digest(JSON.stringify(payload)) }]] });
    assert.equal((await (await interrupted.get(runId)).json()).error, "ARENA_RECOVERY_REQUIRED"); assert.equal((await interrupted.post()).status, 200); assert.equal(calls, 1); await service!.close();
    const admissionFailure = await start(undefined, "admission"); assert.equal((await admissionFailure.post()).status, 503); assert.equal(calls, 1); await service!.close();
    const resultFailure = await start(undefined, "settled"); const pending = await resultFailure.post(); const pendingId = (await pending.json()).runId;
    let view: any; for (let i = 0; i < 50; i++) { view = await (await resultFailure.get(pendingId)).json(); if (view.status !== "running") break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(view.status, "error"); assert.equal(view.error, "ARENA_DURABILITY_UNCONFIRMED"); assert.equal(view.result, undefined); assert.equal(resultFailure.journal().runs[0].status, "running"); assert.equal(calls, 2); assert.equal(controller.mock.callCount(), 2);
  } finally { await service?.close(); await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});
