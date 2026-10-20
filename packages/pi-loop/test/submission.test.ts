import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { Interface, type JsonRpcProvider, type Signer } from "ethers";
import { submitProgrammingCandidate, type SubmissionConfig, type SubmissionState } from "../src/submission.js";

const escrowAddress = "0x1111111111111111111111111111111111111111";
const txHash = `0x${"22".repeat(32)}`;
const escrow = new Interface(["event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)"]);
type Body = Record<string, unknown>;
async function fixture(options: { status?: (get: number) => string; post?: Body | ((runId: string) => Body); postStatus?: number; invalidJson?: boolean; expired?: boolean; wrongGetId?: boolean } = {}) {
  const originalRunId = randomUUID(), originalPayload = { taskId: "20", code: "print('original accepted candidate')", deadline: "1", signature: `0x${"ab".repeat(65)}` };
  let state: SubmissionState = { phase: "SubmissionPending", reason: "ARENA_SETTLEMENT_UNCERTAIN", candidate: "a different candidate must never replace the signed payload",
    submission: { payload: structuredClone(originalPayload), runId: originalRunId } };
  const requests: { method: string; path: string; body?: string }[] = [], snapshots: string[] = [];
  let gets = 0, posts = 0, signatures = 0, writes = 0;
  const result = { verdict: { taskId: "20", agentId: "2366", runId: originalRunId, passed: true, mode: "docker", chainId: "42431", escrowAddress, problemId: "sum-integers" },
    settlement: { taskId: "20", runId: originalRunId, passed: true, txHash } };
  const server = createServer(async (request, response) => {
    const method = request.method!, path = request.url!;
    const chunks: Buffer[] = []; for await (const part of request) chunks.push(Buffer.from(part));
    const body = Buffer.concat(chunks).toString("utf8"); requests.push({ method, path, ...(body ? { body } : {}) });
    response.setHeader("content-type", "application/json");
    if (method === "GET" && path === `/runs/${originalRunId}`) {
      const status = (options.status ?? (get => get === 1 ? "error" : "settled"))(++gets);
      response.end(JSON.stringify({ runId: options.wrongGetId ? "another-run" : originalRunId, taskId: "20", status, ...(status === "settled" ? { result } : {}) })); return;
    }
    if (method === "POST" && path === "/submissions") {
      assert.equal(JSON.parse(snapshots.at(-1)!).submission.recovery.attempts, 1, "durable recovery reservation precedes POST");
      posts++; response.statusCode = options.postStatus ?? 200;
      const value = typeof options.post === "function" ? options.post(originalRunId) : options.post;
      response.end(options.invalidJson ? "{" : JSON.stringify(value ?? { runId: originalRunId, taskId: "20", status: "running" })); return;
    }
    response.statusCode = 404; response.end("{}");
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config: SubmissionConfig = { taskId: "20", agentId: "2366", rpcUrl: "http://127.0.0.1:1", chainId: "42431", escrowAddress,
    arenaUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, deadlineMs: Date.now() + (options.expired ? -60000 : 60000) };
  const rpc = { send: async (method: string) => { assert.equal(method, "eth_chainId"); return "0xa5bf"; },
    getBlock: async () => { throw new Error("an accepted submission must not obtain a new signing window"); },
    getTransactionReceipt: async (hash: string) => { assert.equal(hash, txHash); return { status: 1, logs: [{ address: escrowAddress,
      ...escrow.encodeEventLog(escrow.getEvent("TaskSettled")!, [20, true, 92000, 0, 58000]) }] }; },
    broadcastTransaction: async () => { writes++; throw new Error("submission recovery cannot broadcast a transaction"); },
  } as unknown as JsonRpcProvider;
  const signer = { signTypedData: async () => { signatures++; throw new Error("must retain original signature"); } } as unknown as Signer;
  const invoke = (opt: { permit?: boolean; cold?: boolean; saveFails?: boolean; assertAllowed?: () => void | Promise<void> } = { permit: true }) => {
    if (opt.cold) state = JSON.parse(JSON.stringify(state));
    return submitProgrammingCandidate(state, config, { rpc, signer, timeoutMs: 1000, pollTimeoutMs: 1000,
      ...(opt.permit ? { submissionRecovery: { maxAttempts: 1 as const, assertAllowed: opt.assertAllowed ?? (() => {}) } } : {}),
      save: async () => { if (opt.saveFails) throw new Error("CONTROLLED_PERSISTENCE_FAILURE"); snapshots.push(JSON.stringify(state)); } });
  };
  return { get state() { return state; }, config, invoke, originalPayload, originalRunId, requests, snapshots, get gets() { return gets; }, get posts() { return posts; },
    get signatures() { return signatures; }, get writes() { return writes; }, close: async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}

test("an errored original Arena run resumes its exact saved signature and payload, then polls the same run to settlement", async () => {
  const f = await fixture({ status: get => get === 1 ? "error" : get === 2 ? "running" : "settled" });
  try {
    const original = JSON.stringify(f.state.submission!.payload); await f.invoke();
    assert.equal(f.state.phase, "Succeeded"); assert.equal(f.state.reason, undefined); assert.equal(f.state.submission!.runId, f.originalRunId);
    assert.equal(f.posts, 1); assert.equal(f.gets, 3); assert.equal(f.signatures, 0); assert.equal(f.writes, 0);
    const post = f.requests.find(request => request.method === "POST")!;
    assert.equal(post.body, original); assert.deepEqual(JSON.parse(post.body!), f.originalPayload);
    assert.equal(JSON.stringify(f.state.submission!.payload), original); assert.ok(f.snapshots.length > 0);
    assert.ok(f.requests.filter(request => request.method === "GET").every(request => request.path === `/runs/${f.originalRunId}`));
  } finally { await f.close(); }
});

test("a repeatedly errored run retains one cumulative recovery POST across repeat calls and cold reopen", async () => {
  const f = await fixture({ status: () => "error" });
  try {
    await f.invoke(); assert.equal(f.posts, 1); assert.equal(f.gets, 2); assert.equal(f.state.phase, "SubmissionPending");
    assert.equal(f.state.reason, "ARENA_SETTLEMENT_UNCERTAIN"); assert.equal(f.state.submission!.runId, f.originalRunId);
    assert.equal(f.state.submission!.result, undefined); assert.deepEqual(f.state.submission!.payload, f.originalPayload); assert.equal(f.signatures, 0);
    await f.invoke(); await f.invoke({ permit: true, cold: true }); assert.equal(f.posts, 1); assert.equal(f.gets, 4);
    assert.ok(f.requests.filter(request => request.method === "POST").every(request => request.body === JSON.stringify(f.originalPayload)));
  } finally { await f.close(); }
});

test("a recovery response must explicitly bind both the original run and configured task", async t => {
  for (const scenario of ["different-run", "different-task", "missing-run", "missing-task"] as const) await t.test(scenario, async () => {
    const f = await fixture({ post: runId => ({ ...(scenario !== "missing-run" ? { runId: scenario === "different-run" ? "replacement" : runId } : {}),
      ...(scenario !== "missing-task" ? { taskId: scenario === "different-task" ? "21" : "20" } : {}) }) });
    try {
      await f.invoke(); assert.equal(f.state.phase, "SubmissionPending"); assert.equal(f.state.reason, "ARENA_RESULT_MISMATCH"); assert.equal(f.posts, 1); assert.equal(f.gets, 1);
      assert.equal(f.state.submission!.runId, f.originalRunId); assert.deepEqual(f.state.submission!.payload, f.originalPayload); assert.equal(f.signatures, 0);
    } finally { await f.close(); }
  });
});

test("rejected or uncertain recovery POSTs preserve the original submission without another poll or signature", async t => {
  for (const [status, reason] of [[400, "ARENA_SUBMISSION_REJECTED"], [409, "SUBMISSION_CONFLICT_UNCERTAIN"], [429, "SUBMISSION_UNCERTAIN"], [503, "SUBMISSION_UNCERTAIN"]] as const) await t.test(String(status), async () => {
    const f = await fixture({ postStatus: status, post: { error: "CONTROLLED_ERROR" } });
    try { await f.invoke(); assert.equal(f.state.reason, reason); assert.equal(f.state.phase, "SubmissionPending"); assert.equal(f.posts, 1); assert.equal(f.gets, 1);
      assert.equal(f.state.submission!.runId, f.originalRunId); assert.deepEqual(f.state.submission!.payload, f.originalPayload); assert.equal(f.signatures, 0); }
    finally { await f.close(); }
  });
  const f = await fixture({ invalidJson: true });
  try { await f.invoke(); assert.equal(f.state.reason, "SUBMISSION_UNCERTAIN"); assert.equal(f.posts, 1); assert.equal(f.gets, 1); assert.equal(f.signatures, 0); }
  finally { await f.close(); }
});

test("an already accepted run can recover after its old deadline without changing that deadline or re-signing", async () => {
  const f = await fixture({ expired: true });
  try {
    await f.invoke(); assert.equal(f.state.phase, "Succeeded"); assert.equal(f.posts, 1); assert.equal(f.signatures, 0);
    assert.deepEqual(f.state.submission!.payload, f.originalPayload); assert.equal(f.state.submission!.payload.deadline, "1");
  } finally { await f.close(); }
});

test("an expired submission without an accepted run ID cannot gain a new HTTP submission or signing window", async () => {
  const f = await fixture({ expired: true });
  try { delete f.state.submission!.runId; await assert.rejects(f.invoke(), /SESSION_DEADLINE/); assert.equal(f.posts, 0); assert.equal(f.gets, 0); assert.equal(f.signatures, 0); }
  finally { await f.close(); }
});

test("a mismatched run GET cannot trigger recovery of another run", async () => {
  const f = await fixture({ wrongGetId: true });
  try { await f.invoke(); assert.equal(f.state.reason, "ARENA_RESULT_MISMATCH"); assert.equal(f.posts, 0); assert.equal(f.state.submission!.runId, f.originalRunId); }
  finally { await f.close(); }
});


test("default recovery observes the errored run without another POST even with recoverable signed bytes", async () => {
  const f = await fixture({ status: () => "error" });
  try { await f.invoke({ permit: false }); assert.equal(f.posts, 0); assert.equal(f.gets, 1); assert.equal(f.state.reason, "ARENA_SETTLEMENT_UNCERTAIN"); assert.equal(f.state.submission!.recovery, undefined); }
  finally { await f.close(); }
});

test("failed reservation persistence and a seal during save both prevent any recovery dispatch", async () => {
  const f = await fixture({ status: () => "error" });
  try {
    await assert.rejects(f.invoke({ permit: true, saveFails: true }), /CONTROLLED_PERSISTENCE_FAILURE/); assert.equal(f.posts, 0);
    delete f.state.submission!.recovery;
    let guards = 0;
    await f.invoke({ permit: true, assertAllowed: () => { if (++guards === 2) throw new Error("WINDOW_SEALED"); } });
    assert.equal(guards, 2); assert.equal(f.posts, 0); assert.equal(f.state.submission!.recovery!.attempts, 1);
    await f.invoke({ permit: true, cold: true }); assert.equal(f.posts, 0, "reserved attempt cannot be reclaimed after a seal");
  } finally { await f.close(); }
});

test("terminal states and changed recovery bindings cannot cause a new POST", async t => {
  for (const phase of ["Succeeded", "Failed", "Refunded", "Stopped", "Cancelled", "Sealed"]) await t.test(phase, async () => {
    const f = await fixture();
    try { f.state.phase = phase; await f.invoke(); assert.equal(f.posts, 0); assert.equal(f.gets, 0); assert.equal(f.signatures, 0); }
    finally { await f.close(); }
  });
  const f = await fixture({ status: () => "error" });
  try {
    await f.invoke(); assert.equal(f.posts, 1);
    f.config.taskId = "21"; await assert.rejects(f.invoke(), /ARENA_RESULT_MISMATCH/); assert.equal(f.posts, 1);
    f.config.taskId = "20"; f.state.submission!.runId = "different-run";
    // The GET is bounded to the saved run; it cannot authorize an unrelated recovery.
    await f.invoke(); assert.equal(f.posts, 1);
    f.state.submission!.runId = f.originalRunId; f.config.agentId = "another-agent";
    await f.invoke(); assert.equal(f.state.reason, "ARENA_RECOVERY_BINDING_INVALID"); assert.equal(f.posts, 1);
  } finally { await f.close(); }
});


test("a malformed existing recovery reservation is never treated as a fresh allowance", async t => {
  for (const recovery of [null, false, {}, { binding: "changed", attempts: 0 }]) await t.test(JSON.stringify(recovery), async () => {
    const f = await fixture({ status: () => "error" });
    try { (f.state.submission as any).recovery = recovery; await f.invoke(); assert.equal(f.posts, 0); assert.equal(f.state.reason, "ARENA_RECOVERY_BINDING_INVALID"); }
    finally { await f.close(); }
  });
});
