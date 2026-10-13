import assert from "node:assert/strict";
import test from "node:test";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Wallet } from "ethers";
import { fixture, key, read, startAnvil, stopAnvil } from "../../../services/underwriter/test/fixture.js";
import { Relay } from "../../../services/provider-relay/src/relay.js";
import { createHttpServer } from "../../../services/provider-relay/src/http.js";
import { Refunder } from "../../../services/provider-relay/src/refunder.js";
import type { RelayConfig } from "../../../services/provider-relay/src/config.js";
import { createArenaHttpServer } from "../../../services/arena/src/http.js";
import { DockerExecutor, type Execution } from "@agentfuel/arena/docker";
import type { ArenaConfig } from "../../../services/arena/src/protocol.js";
import { runProgrammingLoop, type LoopConfig, type LoopSession } from "../src/index.js";
import { SessionStore } from "../src/session.js";

const good = "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n";
const wrong = "print(0)\n";
const sampleOnly = "print(9)\n";
function response(code: string, id = "call_same") { return { model: "controlled", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id, type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }; }

test("Pi cash loop repairs, independently settles, stops at limits and resumes without a second payment or model call", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-pi-"));
  let anvil: ChildProcess | undefined, settler: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined, relay: Relay | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined, arena: ReturnType<typeof createArenaHttpServer> | undefined;
  let queue: any[] = []; const calls: any[] = []; const configFile = join(directory, "arena.json");
  try {
    const local = await startAnvil(); anvil = local.child; f = await fixture(local.rpc, join(directory, "evidence"), 6);
    const taskIds: string[] = [];
    for (let i = 0; i < 14; i++) { f.agent.reset(); taskIds.push(String(await f.task())); }
    const arenaConfig: ArenaConfig = { rpcUrl: local.rpc, chainId: "31337", escrowAddress: await f.escrow.getAddress(), ipcDirectory: join(directory, "ipc"), tasks: Object.fromEntries(taskIds.map(id => [id, { agentId: "1", problemId: "sum-integers" }])) };
    await writeFile(configFile, JSON.stringify(arenaConfig), { mode: 0o600 });
    settler = spawn(process.execPath, ["--import", "tsx", new URL("../../../services/arena/src/settler-main.ts", import.meta.url).pathname], { cwd: new URL("../../..", import.meta.url).pathname, env: { ...process.env, ARENA_CONFIG: configFile, ARENA_VERIFIER_PRIVATE_KEY: key(1) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000); const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); }; settler!.stdout!.on("data", data => { if (String(data).includes('"ready":true')) finish(); }); settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("error", finish); settler!.once("exit", () => finish(new Error("SETTLER_EXITED"))); });
    arena = createArenaHttpServer(arenaConfig, [], f.provider); arena.server.listen(0, "127.0.0.1"); await once(arena.server, "listening");
    const arenaUrl = `http://127.0.0.1:${(arena.server.address() as { port: number }).port}`;
    const cheap = [{ name: "controlled-cheap", model: "local-cheap", baseUrl: "https://cheap.invalid/v1", key: "synthetic-upstream-secret" }];
    const strong = [{ name: "controlled-strong", model: "local-strong", baseUrl: "https://strong.invalid/v1", key: "synthetic-upstream-secret" }];
    const relayConfig: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: "infercredit/coder", model: "coder", price: 10000n, upstreams: cheap, tiers: { cheap: { price: 10000n, upstreams: cheap }, strong: { price: 30000n, upstreams: strong } } }, dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788 };
    relay = new Relay(relayConfig, { provider: f.provider, upstreamFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body);
      assert.equal(body.taskId, undefined); assert.equal(JSON.stringify(body).includes(key(2)), false); assert.equal(JSON.stringify(body).includes("synthetic-upstream-secret"), false);
      assert.deepEqual(body.tools.map((tool: any) => tool.function.name), ["test_public_sample"]);
      assert.equal(body.max_completion_tokens, 256); assert.ok(queue.length, "No unplanned upstream request");
      return Response.json(queue.shift());
    } });
    await relay.initialize(); server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
    const config = (taskId: string, patch: Partial<LoopConfig> = {}): LoopConfig => ({ taskId, agentId: "1", rpcUrl: local.rpc, chainId: "31337", account: relayConfig.account, asset: relayConfig.asset, provider: f!.payee, relayUrl, service: "infercredit/coder", model: "coder", tiers: ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxTotalPrice: "40000", maxPricePerCall: "30000", deadlineMs: Date.now() + 90000, arenaUrl, escrowAddress: arenaConfig.escrowAddress, maxCompletionTokens: 256, ...patch });
    const options = { signer: new Wallet(key(2), f.provider), timeoutMs: 5000, pollTimeoutMs: 15000 };
    const checkAssigned = async (taskId: string) => { assert.equal((await read(f!.escrow, "getTask", [taskId])).status, 2n); assert.equal((await read(f!.manager, "getLoan", [taskId])).status, 0n); };
    queue = [response(wrong), response(good)]; const initialBalance = await f.providerBalance(), initialNonce = await f.provider.getTransactionCount(f.agentAddress);
    const successConfig = config(taskIds[0], { tierParameters: { cheap: { thinking: { type: "disabled" } }, strong: { reasoning_effort: "low" } } }); const successDir = join(directory, "success"); const success = await runProgrammingLoop(successDir, successConfig, options);
    assert.equal(success.phase, "Succeeded", JSON.stringify(success)); assert.deepEqual(success.tools.map(t => t.result?.passed), [false, true]);
    assert.equal(success.reservedPrice, "40000"); assert.deepEqual(success.rounds.map(r => [r.handle?.input.taskId, r.inference?.receipt.tier, r.inference?.receipt.price, r.inference?.receipt.model]), [["0", "cheap", "10000", "local-cheap"], ["0", "strong", "30000", "local-strong"]]);
    assert.equal(await f.providerBalance(), initialBalance + 40000n); assert.equal(await f.provider.getTransactionCount(f.agentAddress), initialNonce + 2);
    assert.equal((await read(f.escrow, "getTask", [taskIds[0]])).status, 3n); assert.equal((await read(f.manager, "getLoan", [taskIds[0]])).status, 0n);
    assert.equal(calls[1].messages.at(-1).tool_call_id, "call_same"); assert.equal(calls[1].messages.at(-1).content.includes('"passed":false'), true);
    assert.deepEqual(calls[0].thinking, { type: "disabled" }); assert.equal(calls[1].reasoning_effort, "low");
    const finishedNonce = await f.provider.getTransactionCount(f.agentAddress); assert.deepEqual(await runProgrammingLoop(successDir, successConfig, options), JSON.parse(JSON.stringify(success))); assert.equal(calls.length, 2); assert.equal(await f.provider.getTransactionCount(f.agentAddress), finishedNonce);
    const persisted = await readFile(join(successDir, "session.json"), "utf8"); assert.equal(persisted.includes(key(1)), false); assert.equal(persisted.includes(key(2)), false); assert.equal(persisted.includes("synthetic-upstream-secret"), false);

    queue = [response(wrong)]; const budget = await runProgrammingLoop(join(directory, "budget"), config(taskIds[1], { maxTotalPrice: "10000" }), options);
    assert.equal(budget.phase, "Stopped"); assert.equal(budget.reason, "BUDGET_LIMIT"); assert.equal(budget.reservedPrice, "10000"); assert.equal(budget.rounds.length, 1); assert.equal(budget.submission, undefined); await checkAssigned(taskIds[1]);
    queue = [response(wrong)]; const rounds = await runProgrammingLoop(join(directory, "rounds"), config(taskIds[2], { maxRounds: 1, tiers: ["cheap"] }), options);
    assert.equal(rounds.reason, "ROUND_LIMIT"); assert.equal(rounds.submission, undefined); await checkAssigned(taskIds[2]);
    queue = [{ choices: [{ message: { role: "assistant", content: "I claim success." }, finish_reason: "stop" }] }];
    const plain = await runProgrammingLoop(join(directory, "plain"), config(taskIds[3]), options); assert.equal(plain.reason, "NO_PUBLIC_TEST"); assert.equal(plain.submission, undefined); await checkAssigned(taskIds[3]);
    queue = [response(sampleOnly)]; const rejected = await runProgrammingLoop(join(directory, "hidden-fail"), config(taskIds[4]), options);
    assert.equal(rejected.tools[0].result?.passed, true); assert.equal(rejected.phase, "Failed"); assert.equal(rejected.reason, "ARENA_TASK_FAILED"); assert.equal((await read(f.escrow, "getTask", [taskIds[4]])).status, 4n);

    // Persist Delivered, then simulate losing delivery. Resume must retrieve this paid cache; it cannot run the model twice.
    const originalWrite = relay.store.write.bind(relay.store); let crash = true; let lostTier = "strong";
    relay.store.write = async record => { await originalWrite(record); if (crash && record.state === "Delivered" && record.quote.tier === lostTier) { crash = false; throw new Error("Controlled lost delivery"); } };
    queue = [response(wrong), response(good)]; const recoverConfig = config(taskIds[5]); const recoverDir = join(directory, "recovery"); const paused = await runProgrammingLoop(recoverDir, recoverConfig, options);
    assert.equal(paused.phase, "Paused"); assert.equal(paused.reservedPrice, "40000"); assert.ok(paused.rounds[1].handle); assert.equal(paused.rounds[1].inference, undefined); await checkAssigned(taskIds[5]);
    const paidBalance = await f.providerBalance(), paidNonce = await f.provider.getTransactionCount(f.agentAddress), paidCalls = calls.length;
    const recovered = await runProgrammingLoop(recoverDir, recoverConfig, options); assert.equal(recovered.phase, "Succeeded", JSON.stringify(recovered)); assert.equal(calls.length, paidCalls); assert.equal(await f.providerBalance(), paidBalance); assert.equal(await f.provider.getTransactionCount(f.agentAddress), paidNonce);

    // Same paid cache is claimable after the deadline, while tools, new payment, and submission remain forbidden.
    crash = true; lostTier = "cheap"; queue = [response(good)]; const expiredConfig = config(taskIds[6], { deadlineMs: Date.now() + 1300 }); const expiredDir = join(directory, "expired-paid");
    const expiredPending = await runProgrammingLoop(expiredDir, expiredConfig, options); assert.equal(expiredPending.phase, "Paused");
    await delay(Math.max(1, expiredConfig.deadlineMs - Date.now() + 10)); const expiredNonce = await f.provider.getTransactionCount(f.agentAddress), expiredCalls = calls.length;
    const expired = await runProgrammingLoop(expiredDir, expiredConfig, options); assert.equal(expired.reason, "SESSION_DEADLINE"); assert.ok(expired.rounds[0].inference); assert.equal(expired.submission, undefined); assert.equal(calls.length, expiredCalls); assert.equal(await f.provider.getTransactionCount(f.agentAddress), expiredNonce); await checkAssigned(taskIds[6]);
    relay.store.write = originalWrite;

    const originalQuote = relay.quote.bind(relay); relay.quote = async input => { const quote = await originalQuote(input); await delay(200); return quote; };
    const noPayBalance = await f.providerBalance(), noPayNonce = await f.provider.getTransactionCount(f.agentAddress), noPayCalls = calls.length;
    const deadline = await runProgrammingLoop(join(directory, "deadline-unpaid"), config(taskIds[7], { deadlineMs: Date.now() + 100 }), options);
    assert.equal(deadline.reason, "SESSION_DEADLINE"); assert.equal(await f.providerBalance(), noPayBalance); assert.equal(await f.provider.getTransactionCount(f.agentAddress), noPayNonce); assert.equal(calls.length, noPayCalls); await checkAssigned(taskIds[7]); relay.quote = originalQuote;

    // Crash between receiving a durable result and appending the Pi assistant. The saved inference is replayed locally.
    const originalSave = SessionStore.prototype.write; let resultCrash = true;
    SessionStore.prototype.write = async function (value: unknown) { await originalSave.call(this, value); const session = value as LoopSession; if (resultCrash && session.rounds?.[0]?.inference && !session.rounds[0].appended) { resultCrash = false; throw new Error("Controlled transcript crash"); } };
    queue = [response(good)]; const transcriptConfig = config(taskIds[8]); const transcriptDir = join(directory, "transcript");
    try { const interrupted = await runProgrammingLoop(transcriptDir, transcriptConfig, options); assert.equal(interrupted.phase, "Paused"); assert.ok(interrupted.rounds[0].inference); }
    finally { SessionStore.prototype.write = originalSave; }
    const transcriptNonce = await f.provider.getTransactionCount(f.agentAddress), transcriptCalls = calls.length;
    const transcript = await runProgrammingLoop(transcriptDir, transcriptConfig, options); assert.equal(transcript.phase, "Succeeded"); assert.equal(calls.length, transcriptCalls); assert.equal(await f.provider.getTransactionCount(f.agentAddress), transcriptNonce);

    // A truncated tool call must stay rejected after a crash between assistant persistence and the tool batch.
    let assistantCrash = true; const truncated = response(good); truncated.choices[0].finish_reason = "length";
    const truncatedConfig = config(taskIds[9], { maxRounds: 1, tiers: ["cheap"] }); const truncatedDir = join(directory, "truncated"); queue = [truncated];
    SessionStore.prototype.write = async function(value: unknown) { if (!assistantCrash) throw new Error("Controlled assistant persistence crash"); await originalSave.call(this, value); const session = value as LoopSession; if (session.messages?.at(-1)?.role === "assistant") { assistantCrash = false; throw new Error("Controlled assistant persistence crash"); } };
    try { await assert.rejects(runProgrammingLoop(truncatedDir, truncatedConfig, options), /Controlled assistant persistence crash/); }
    finally { SessionStore.prototype.write = originalSave; }
    const truncatedCalls = calls.length; const truncatedResume = await runProgrammingLoop(truncatedDir, truncatedConfig, options);
    assert.equal(truncatedResume.tools.length, 0); assert.equal(truncatedResume.submission, undefined); assert.equal(calls.length, truncatedCalls); await checkAssigned(taskIds[9]);

    // HTTP 503 after forwarding a real accepted submission cannot be interpreted as task failure. Exact payload replay is idempotent.
    const payloads: string[] = []; let losePost = true; let wrongDomainOnce = true;
    const proxy = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = Buffer.concat(chunks).toString("utf8");
      if (req.method === "POST") payloads.push(body);
      const response = await fetch(arenaUrl + req.url, req.method === "POST" ? { method: "POST", headers: { "content-type": "application/json" }, body } : {});
      let output = await response.text();
      if (req.method === "GET" && wrongDomainOnce) { const run = JSON.parse(output); if (run.status === "settled") { wrongDomainOnce = false; run.result.verdict.chainId = "999"; output = JSON.stringify(run); } }
      if (req.method === "POST" && losePost) { losePost = false; res.writeHead(503, { "content-type": "application/json" }); res.end('{"error":"lost accepted response"}'); }
      else { res.writeHead(response.status, { "content-type": "application/json" }); res.end(output); }
    }); proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
    try {
      queue = [response(good)]; const httpConfig = config(taskIds[10], { arenaUrl: `http://127.0.0.1:${(proxy.address() as { port: number }).port}`, deadlineMs: Date.now() + 8000 }); const httpDir = join(directory, "http-uncertain");
      const uncertain = await runProgrammingLoop(httpDir, httpConfig, options); assert.equal(uncertain.phase, "SubmissionPending"); assert.equal(uncertain.reason, "SUBMISSION_UNCERTAIN"); assert.ok(uncertain.submission?.payload.signature);
      const httpNonce = await f.provider.getTransactionCount(f.agentAddress), httpCalls = calls.length;
      const mismatched = await runProgrammingLoop(httpDir, httpConfig, options); assert.equal(mismatched.phase, "SubmissionPending"); assert.equal(mismatched.reason, "ARENA_RESULT_MISMATCH"); assert.ok(mismatched.submission?.runId);
      await delay(Math.max(1, httpConfig.deadlineMs - Date.now() + 10));
      const reconciled = await runProgrammingLoop(httpDir, httpConfig, options); assert.equal(reconciled.phase, "Succeeded"); assert.equal(payloads.length, 2); assert.equal(payloads[0], payloads[1]); assert.equal(await f.provider.getTransactionCount(f.agentAddress), httpNonce); assert.equal(calls.length, httpCalls);
    } finally { await new Promise<void>(resolve => proxy.close(() => resolve())); }

    const multiple = response(wrong); multiple.choices[0].message.tool_calls.push({ ...response(good, "call_2").choices[0].message.tool_calls[0] }, { ...response(good, "call_3").choices[0].message.tool_calls[0] }); queue = [multiple];
    let executed = 0; class CountingRunner extends DockerExecutor { override async execute(code: string, input: string, signal?: AbortSignal) { executed++; return super.execute(code, input, signal); } }
    const tools = await runProgrammingLoop(join(directory, "tool-cap"), config(taskIds[11], { maxToolCalls: 1 }), { ...options, runner: new CountingRunner() });
    assert.equal(tools.reason, "TOOL_LIMIT"); assert.equal(executed, 1); assert.equal(tools.tools.length, 1); assert.equal(tools.submission, undefined);
    const toolResults = tools.messages.filter(m => m.role === "toolResult"); assert.deepEqual(toolResults.map(m => m.toolCallId), ["call_same", "call_2", "call_3"]); assert.deepEqual(toolResults.map(m => m.isError), [false, true, true]); await checkAssigned(taskIds[11]);

    const slowConfig = config(taskIds[12], { deadlineMs: Date.now() + 1300 }); let slowExecuted = 0;
    class SlowReady extends DockerExecutor { override async ready() { await delay(Math.max(1, slowConfig.deadlineMs - Date.now() + 10)); } override async execute(): Promise<Execution> { slowExecuted++; throw new Error("Must not execute after slow ready"); } }
    queue = [response(good)]; const slow = await runProgrammingLoop(join(directory, "slow-ready"), slowConfig, { ...options, runner: new SlowReady() });
    assert.equal(slow.reason, "SESSION_DEADLINE"); assert.equal(slowExecuted, 0); assert.equal(slow.submission, undefined); await checkAssigned(taskIds[12]);

    queue = [response("while True: pass\n")]; const cancelled = await runProgrammingLoop(join(directory, "cancel-running"), config(taskIds[13], { deadlineMs: Date.now() + 2500 }), options);
    assert.equal(cancelled.reason, "SESSION_DEADLINE"); assert.equal(cancelled.tools[0].result?.failure, "cancelled"); assert.equal(cancelled.submission, undefined); await checkAssigned(taskIds[13]);
    assert.equal(queue.length, 0);
  } finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); relay?.close(); await arena?.close();
    if (settler) await stopAnvil(settler); await f?.close(); if (anvil) await stopAnvil(anvil); await rm(directory, { recursive: true, force: true });
  }
});
