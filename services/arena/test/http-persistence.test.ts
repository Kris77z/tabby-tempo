import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { JsonRpcProvider, Wallet } from "ethers";
import { fixture, key, startAnvil, stopAnvil } from "../../underwriter/test/fixture.js";
import { ArenaController } from "../src/controller.js";
import { createArenaHttpServer, type ArenaHttpJournal } from "../src/http.js";
import { digest, type ArenaConfig, type Evaluation } from "../src/protocol.js";
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
    assert.equal((await (await interrupted.get(runId)).json()).error, "ARENA_RECOVERY_REQUIRED"); const recovered = await interrupted.post(); assert.equal(recovered.status, 200); assert.equal((await recovered.json()).runId, runId); assert.equal(calls, 2); await service!.close();
    const admissionFailure = await start(undefined, "admission"); assert.equal((await admissionFailure.post()).status, 503); assert.equal(calls, 2); await service!.close();
    const resultFailure = await start(undefined, "settled"); const pending = await resultFailure.post(); const pendingId = (await pending.json()).runId;
    let view: any; for (let i = 0; i < 50; i++) { view = await (await resultFailure.get(pendingId)).json(); if (view.status !== "running") break; await new Promise(r => setTimeout(r, 10)); }
    assert.equal(view.status, "error"); assert.equal(view.error, "ARENA_DURABILITY_UNCONFIRMED"); assert.equal(view.result, undefined); assert.equal(resultFailure.journal().runs[0].status, "running"); assert.equal(calls, 3); assert.equal(controller.mock.callCount(), 3);
  } finally { await service?.close(); await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});

test("concurrent delayed HTTP saves retain other tasks' evaluation and settled evidence through recovery", { timeout: 15000 }, async t => {
  const deferred = () => { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; };
  const evaluatedWrite = deferred(), releaseEvaluation = deferred(), settledWrite = deferred(), releaseSettlement = deferred(), bEvaluated = deferred(), bReturning = deferred();
  const provider = new JsonRpcProvider("http://127.0.0.1:1", undefined, { cacheTimeout: -1 });
  const ids = [randomUUID(), randomUUID()];
  const config: ArenaConfig = { rpcUrl: "http://127.0.0.1:1", chainId: "31337", escrowAddress: new Wallet(key(9)).address,
    ipcDirectory: "/unused-controlled-persistence", tasks: { "1": { agentId: "1", problemId: "sum-integers" }, "2": { agentId: "1", problemId: "sum-integers" } } };
  const payloads = ids.map((_, index) => ({ taskId: String(index + 1), code: `controlled-code-${index}`, deadline: "1", signature: "0x" + "a".repeat(130) }));
  // These are already-admitted original submissions. No RPC, Docker, model or
  // transaction is used in this controlled scheduling/persistence regression.
  let journal: ArenaHttpJournal = { runs: ids.map((runId, index) => ({ runId, taskId: String(index + 1), status: "error", error: "SETTLEMENT_UNAVAILABLE" })),
    submissions: payloads.map((payload, index) => [payload.taskId, { runId: ids[index], requestHash: digest(JSON.stringify(payload)) }]) };
  let service: ReturnType<typeof createArenaHttpServer> | undefined, phase = 1, evaluations = 0, savedEvaluation = false, savedSettlement = false;
  const expected: Evaluation[] = ids.map((runId, index) => ({ verdict: { version: 1, runId, taskId: String(index + 1), agentId: "1", chainId: "31337",
    escrowAddress: config.escrowAddress, problemId: "sum-integers", passed: true, mode: "docker", evidenceHash: `controlled-evidence-${index}` }, tests: [{ case: 1, passed: true }] }));
  t.mock.method(ArenaController.prototype, "submit", async (input: Parameters<ArenaController["submit"]>[0]) => {
    const index = Number(input.taskId) - 1, evaluation = input.evaluation ?? expected[index];
    if (!input.evaluation) evaluations++;
    else assert.deepEqual(input.evaluation, expected[index], "restart must retain independently generated tests");
    await input.onEvaluated!(evaluation);
    assert.deepEqual(journal.runs.find(run => run.runId === input.runId)!.evaluation, expected[index], "settlement must wait for its evidence write");
    if (phase === 1) throw new Error("SETTLEMENT_UNAVAILABLE");
    if (index === 0) await bEvaluated.promise;
    else { bEvaluated.resolve(); await settledWrite.promise; bReturning.resolve(); }
    return { ...evaluation, settlement: { taskId: input.taskId, runId: input.runId!, passed: true,
      txHash: `controlled-no-transaction-${index}`, blockNumber: 1, feedback: [] } };
  });
  const start = async () => {
    service = createArenaHttpServer(config, [], provider, { initial: structuredClone(journal), save: async state => {
      const a = state.runs.find(run => run.runId === ids[0])!;
      if (phase === 1 && a.evaluation && !savedEvaluation) { evaluatedWrite.resolve(); await releaseEvaluation.promise; savedEvaluation = true; }
      if (savedEvaluation) assert.deepEqual(a.evaluation, expected[0], "a queued write must not erase another task's persisted evaluation");
      if (phase === 2 && a.status === "settled" && !savedSettlement) { settledWrite.resolve(); await releaseSettlement.promise; savedSettlement = true; }
      if (savedSettlement) assert.equal(a.status, "settled", "a later queued write must not erase another task's settlement");
      journal = structuredClone(state);
    } });
    service.server.listen(0, "127.0.0.1"); await once(service.server, "listening");
    const url = `http://127.0.0.1:${(service.server.address() as { port: number }).port}`;
    const get = async (index: number) => (await fetch(url + "/runs/" + ids[index])).json();
    return { get, post: (index: number) => fetch(url + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payloads[index]) }),
      wait: async (index: number, status: string) => { for (let i = 0; i < 200; i++) { const run = await get(index); if (run.status === status) return run; await new Promise(done => setTimeout(done, 5)); } throw new Error("TEST_RUN_TIMEOUT"); } };
  };
  try {
    let http = await start(); assert.equal((await http.post(0)).status, 200); await evaluatedWrite.promise;
    const b = http.post(1); await http.wait(1, "running"); // B's admission is queued behind A's delayed evidence write.
    releaseEvaluation.resolve(); assert.equal((await b).status, 200);
    await Promise.all([http.wait(0, "error"), http.wait(1, "error")]); await service!.close(); service = undefined;
    assert.equal(evaluations, 2); assert.deepEqual(journal.runs.map(run => run.evaluation), expected);
    phase = 2; http = await start(); await Promise.all([http.post(0), http.post(1)]);
    await settledWrite.promise; await bReturning.promise; await new Promise<void>(done => setImmediate(done));
    releaseSettlement.resolve(); await Promise.all([http.wait(0, "settled"), http.wait(1, "settled")]);
    assert.equal(evaluations, 2, "recovery must not require another independent execution");
    assert.deepEqual(journal.runs.map(run => run.evaluation), expected); assert.ok(journal.runs.every(run => run.status === "settled" && run.result?.tests.length === 1));
  } finally { releaseEvaluation.resolve(); releaseSettlement.resolve(); settledWrite.resolve(); bEvaluated.resolve(); await service?.close(); provider.destroy(); }
});
