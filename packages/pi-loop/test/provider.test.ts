import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { DockerExecutor, type Execution } from "@agentfuel/arena/docker";
import type { Json } from "@agentfuel/sdk";
import { runProviderSolver, validateSolveSpec, type ProviderSolveOptions, type ProviderSolveState, type SolveSpec } from "../src/provider.js";
import { SessionStore } from "../src/session.js";
import { PUBLIC_SAMPLE, publicSampleFor } from "../src/public-sample.js";
import { problemCatalog } from "@agentfuel/arena";

const good = "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n", wrong = "print(0)\n";
const routes: ProviderSolveOptions["routes"] = { cheap: { name: "controlled-cheap", model: "controlled-cheap", baseUrl: "https://cheap.invalid/v1" }, strong: { name: "controlled-strong", model: "controlled-strong", baseUrl: "https://strong.invalid/v1" } };
const spec = (patch: Partial<SolveSpec> = {}): SolveSpec => ({ version: 1, problemId: "sum-integers", tiers: ["cheap", "strong", "strong"], maxRounds: 3, maxToolCalls: 4,
  maxCompletionTokens: 2048, deadlineMs: Date.now() + 20000, ...patch });
function response(code: string, model: string, id = "call_same"): Record<string, Json> {
  return { model, choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null,
    tool_calls: [{ id, type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code }) } }] } }],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
}
class ControlledRunner extends DockerExecutor {
  calls: string[] = []; readyCalls = 0;
  override async ready() { this.readyCalls++; }
  override async execute(code: string, input: string, signal?: AbortSignal): Promise<Execution> {
    assert.equal(input, PUBLIC_SAMPLE.input); assert.equal(signal?.aborted, false); this.calls.push(code);
    return { stdout: code === good ? "9\n" : "0\n", exitCode: 0 };
  }
}
async function directoryTest(work: (directory: string) => Promise<void>) {
  const directory = await mkdtemp(join(tmpdir(), "af-provider-solve-"));
  try { await work(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}
const saved = async (directory: string): Promise<ProviderSolveState> => JSON.parse(await readFile(join(directory, "session.json"), "utf8"));

test("solve spec is strict, bounded and expiry is allowed only for recovery validation", () => {
  const valid = spec(); assert.deepEqual(validateSolveSpec(valid), valid);
  for (const value of [null, [], { ...valid, extra: true }, { ...valid, problemId: "arbitrary-program" }, { ...valid, problemId: "constructor" }, { ...valid, version: 2 },
    { ...valid, tiers: ["cheap", "other", "strong"] }, { ...valid, tiers: ["cheap"] }, { ...valid, maxRounds: 4 },
    { ...valid, maxToolCalls: 5 }, { ...valid, maxToolCalls: 0 }, { ...valid, maxCompletionTokens: 2049 }, { ...valid, maxRounds: 1.5 },
    { ...valid, deadlineMs: 0 }, { ...valid, deadlineMs: Date.now() + 310000 }, { ...valid, deadlineMs: Date.now() - 1 }]) assert.throws(() => validateSolveSpec(value));
  assert.ok(validateSolveSpec({ ...valid, deadlineMs: 1 }, false));
  for (const problem of problemCatalog()) assert.equal(validateSolveSpec({ ...valid, problemId: problem.id }).problemId, problem.id);
});

test("all four fixed tasks select only their public sample; resume cannot switch the paid problem", async t => {
  for (const problem of problemCatalog()) await t.test(problem.id, async () => directoryTest(async directory => {
    const sample = publicSampleFor(problem.id), input = spec({ problemId: problem.id, maxRounds: 1, tiers: ["cheap"] }); let calls = 0, tools = 0;
    const runner = new class extends DockerExecutor {
      override async ready() {}
      override async execute(code: string, stdin: string): Promise<Execution> {
        tools++; assert.equal(code, "complete controlled code"); assert.equal(stdin, sample.input);
        return { stdout: JSON.stringify(sample.expected) + "\n", exitCode: 0 };
      }
    };
    const options: ProviderSolveOptions = { routes, runner, invoke: async (tier, body) => {
      calls++; const request = body as any;
      assert.deepEqual(request.messages.filter((m: any) => m.role === "user"), [{ role: "user", content: sample.prompt }]);
      assert.equal(request.tools.length, 1); assert.equal(request.tools[0].function.name, "test_public_sample");
      assert.deepEqual(Object.keys(request.tools[0].function.parameters.properties), ["code"]);
      assert.equal(request.tools[0].function.parameters.additionalProperties, false);
      return response("complete controlled code", routes[tier].model);
    } };
    const result = await runProviderSolver(directory, input, options); assert.equal(result.phase, "Delivered"); assert.equal(result.spec.problemId, problem.id);
    assert.equal((await runProviderSolver(directory, input, options)).phase, "Delivered"); assert.equal(calls, 1); assert.equal(tools, 1);
    const other = problemCatalog().find(p => p.id !== problem.id)!;
    await assert.rejects(runProviderSolver(directory, { ...input, problemId: other.id }, options), /SOLVE_CONFIG_MISMATCH/); assert.equal(calls, 1);
  }));
});

test("provider Pi repairs via fixed public feedback and uses only the controlled transport", async () => directoryTest(async directory => {
  const runner = new ControlledRunner(), input = spec(), requests: any[] = []; let defaults = 0;
  setDefaultStreamFn(() => { defaults++; throw new Error("No default model runtime allowed"); });
  try {
    const options: ProviderSolveOptions = { routes, runner, invoke: async (tier, body, signal) => {
      requests.push(body); assert.equal(signal.aborted, false); assert.deepEqual(Object.keys(body).sort(), tier === "cheap" ? ["max_completion_tokens", "messages", "model", "thinking", "tools"] : ["max_completion_tokens", "messages", "model", "reasoning_effort", "tools"]);
      assert.deepEqual((body.tools as any[]).map(tool => tool.function.name), ["test_public_sample"]);
      return response(requests.length === 1 ? wrong : good, routes[tier].model);
    } };
    const state = await runProviderSolver(directory, input, options);
    assert.equal(state.phase, "Delivered"); assert.equal(state.reason, undefined); assert.equal(state.rounds.length, 2);
    assert.deepEqual(state.tools.map(tool => [tool.id, tool.result?.passed]), [["1:call_same", false], ["2:call_same", true]]);
    assert.equal(state.candidate, good); assert.equal(state.codeHash, createHash("sha256").update(good).digest("hex")); assert.equal(defaults, 0);
    assert.equal(requests[1].messages.at(-1).tool_call_id, "call_same"); assert.ok(requests[1].messages.at(-1).content.includes('"passed":false'));
    assert.deepEqual(runner.calls, [wrong, good]); assert.deepEqual(state.rounds.map(round => [round.tier, round.state, round.appended]), [["cheap", "Responded", true], ["strong", "Responded", true]]);
    assert.deepEqual(await runProviderSolver(directory, input, options), JSON.parse(JSON.stringify(state))); assert.equal(requests.length, 2); assert.equal(runner.calls.length, 2);
    assert.equal(JSON.stringify(state).includes("PaymentHandle"), false); assert.equal(JSON.stringify(state).includes("receipt"), false);
    await assert.rejects(runProviderSolver(directory, { ...input, maxCompletionTokens: 1024 }, options), /SOLVE_CONFIG_MISMATCH/);
    await assert.rejects(runProviderSolver(directory, input, { ...options, routes: { ...routes, strong: { ...routes.strong, model: "different-strong" } } }), /SOLVE_CONFIG_MISMATCH/);
    await assert.rejects(runProviderSolver(directory, input, { ...options, routes: { ...routes, cheap: { ...routes.cheap, key: "synthetic-secret" } } } as ProviderSolveOptions), /INVALID_SOLVE_ROUTES/);
  } finally { setDefaultStreamFn(undefined); }
}));

test("first sample pass ends before further calls; unsuccessful output and limits stay undelivered", async t => {
  await t.test("early pass blocks later tool execution in the same batch", async () => directoryTest(async directory => {
    const runner = new ControlledRunner(); let count = 0;
    const state = await runProviderSolver(directory, spec(), { routes, runner, invoke: async tier => { count++; const value = response(good, routes[tier].model) as any;
      value.choices[0].message.tool_calls.push((response(wrong, routes[tier].model, "later") as any).choices[0].message.tool_calls[0]); return value; } });
    assert.equal(state.phase, "Delivered"); assert.equal(count, 1); assert.deepEqual(runner.calls, [good]); assert.equal(state.tools.length, 1); assert.equal(state.candidate, good);
  }));
  await t.test("round limit", async () => directoryTest(async directory => {
    let count = 0; const state = await runProviderSolver(directory, spec({ maxRounds: 1, tiers: ["cheap"] }), { routes, runner: new ControlledRunner(), invoke: async tier => { count++; return response(wrong, routes[tier].model); } });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "ROUND_LIMIT"); assert.equal(count, 1); assert.equal(state.candidate, undefined);
  }));
  await t.test("tool limit across a batch", async () => directoryTest(async directory => {
    const runner = new ControlledRunner(); const state = await runProviderSolver(directory, spec({ maxToolCalls: 1 }), { routes, runner, invoke: async tier => {
      const value = response(wrong, routes[tier].model) as any; value.choices[0].message.tool_calls.push((response(good, routes[tier].model, "second") as any).choices[0].message.tool_calls[0]); return value; } });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "TOOL_LIMIT"); assert.deepEqual(runner.calls, [wrong]); assert.equal(state.tools.length, 1);
  }));
  await t.test("plain success claim", async () => directoryTest(async directory => {
    const runner = new ControlledRunner(); const state = await runProviderSolver(directory, spec(), { routes, runner, invoke: async tier => ({ model: routes[tier].model,
      choices: [{ finish_reason: "stop", message: { role: "assistant", content: "The task is solved." } }] }) });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "NO_PUBLIC_TEST"); assert.equal(runner.calls.length, 0);
  }));
  await t.test("malformed response is known undelivered", async () => directoryTest(async directory => {
    const state = await runProviderSolver(directory, spec(), { routes, runner: new ControlledRunner(), invoke: async () => ({}) });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "MODEL_RESPONSE_ERROR"); assert.equal(state.rounds[0].state, "Responded");
  }));
  await t.test("unavailable or forbidden tool never executes", async () => directoryTest(async directory => {
    const runner = new ControlledRunner(); const state = await runProviderSolver(directory, spec(), { routes, runner, invoke: async tier => {
      const value = response(good, routes[tier].model) as any; value.choices[0].message.tool_calls[0].function.name = "shell"; return value; } });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "MODEL_TOOL_INVALID"); assert.equal(runner.calls.length, 0);
  }));
});

test("saved Responded result and completed public tool are replayed locally after commit failures", async t => {
  for (const barrier of ["response", "tool"] as const) await t.test(barrier, async () => directoryTest(async directory => {
    const runner = new ControlledRunner(), input = spec(); let count = 0, crash = true;
    const options: ProviderSolveOptions = { routes, runner, invoke: async tier => { count++; return response(good, routes[tier].model); } };
    const original = SessionStore.prototype.write;
    SessionStore.prototype.write = async function(value: unknown) {
      await original.call(this, value); const state = value as ProviderSolveState;
      if (crash && state.rounds?.[0] && (barrier === "response" ? state.rounds[0].state === "Responded" && !state.rounds[0].appended : state.tools[0]?.result?.passed && !state.messages.some(message => message.role === "toolResult"))) {
        crash = false; throw new Error("controlled durable commit interruption");
      }
    };
    try { await assert.rejects(runProviderSolver(directory, input, options), /controlled durable commit interruption/); }
    finally { SessionStore.prototype.write = original; }
    assert.equal((await saved(directory)).phase, "Running");
    const recovered = await runProviderSolver(directory, input, options); assert.equal(recovered.phase, "Delivered"); assert.equal(count, 1); assert.deepEqual(runner.calls, [good]);
    assert.equal(recovered.messages.at(-1)?.role, "toolResult"); assert.equal((recovered.messages.at(-1) as any).isError, false);
  }));
});

test("unknown dispatch stays unknown and never causes a second request", async t => {
  await t.test("request throws after durable dispatch marker", async () => directoryTest(async directory => {
    let count = 0; const runner = new ControlledRunner(), input = spec();
    const options: ProviderSolveOptions = { routes, runner, invoke: async () => { count++; throw new Error("connection lost"); } };
    const first = await runProviderSolver(directory, input, options); assert.equal(first.phase, "Unknown"); assert.equal(first.reason, "UPSTREAM_DISPATCH_UNKNOWN"); assert.equal(first.rounds[0].state, "Dispatching");
    assert.equal((await runProviderSolver(directory, input, options)).phase, "Unknown"); assert.equal(count, 1); assert.equal(runner.calls.length, 0);
  }));
  await t.test("recovery cannot tell whether a prepared request was sent", async () => directoryTest(async directory => {
    const runner = new ControlledRunner(), input = spec(); let count = 0, crash = true;
    const options: ProviderSolveOptions = { routes, runner, invoke: async tier => { count++; return response(good, routes[tier].model); } };
    const original = SessionStore.prototype.write;
    SessionStore.prototype.write = async function(value: unknown) { await original.call(this, value); const state = value as ProviderSolveState;
      if (crash && state.rounds?.[0]?.state === "Dispatching") { crash = false; throw new Error("controlled dispatch commit interruption"); } };
    try { await assert.rejects(runProviderSolver(directory, input, options), /controlled dispatch commit interruption/); }
    finally { SessionStore.prototype.write = original; }
    const recovered = await runProviderSolver(directory, input, options); assert.equal(recovered.phase, "Unknown"); assert.equal(recovered.reason, "UPSTREAM_DISPATCH_UNKNOWN"); assert.equal(count, 0); assert.equal(runner.calls.length, 0);
  }));
});

test("deadline stops new dispatch, checks after runner readiness and aborts in-flight work", async t => {
  await t.test("already expired", async () => directoryTest(async directory => {
    let count = 0; const state = await runProviderSolver(directory, spec({ deadlineMs: Date.now() - 1 }), { routes, runner: new ControlledRunner(), invoke: async () => { count++; return {}; } });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "SESSION_DEADLINE"); assert.equal(count, 0);
  }));
  await t.test("slow readiness cannot start execution", async () => directoryTest(async directory => {
    const input = spec({ deadlineMs: Date.now() + 500 }), runner = new class extends ControlledRunner { override async ready() { await delay(Math.max(1, input.deadlineMs - Date.now() + 5)); } };
    const state = await runProviderSolver(directory, input, { routes, runner, invoke: async tier => response(good, routes[tier].model) });
    assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "SESSION_DEADLINE"); assert.equal(runner.calls.length, 0);
  }));
  await t.test("transport ignoring abort is still bounded and remains unknown", async () => directoryTest(async directory => {
    const input = spec({ deadlineMs: Date.now() + 500 }); let signal: AbortSignal | undefined, count = 0;
    const options: ProviderSolveOptions = { routes, runner: new ControlledRunner(), invoke: async (_tier, _body, abort) => { signal = abort; count++; return new Promise(() => {}); } };
    const state = await runProviderSolver(directory, input, options); assert.equal(state.phase, "Unknown"); assert.equal(signal?.aborted, true); assert.equal(count, 1);
    assert.equal((await runProviderSolver(directory, input, options)).phase, "Unknown"); assert.equal(count, 1);
  }));
  await t.test("running public execution sees the deadline abort", async () => directoryTest(async directory => {
    const input = spec({ deadlineMs: Date.now() + 500 }); let aborted = false;
    const runner = new class extends ControlledRunner { override async execute(_code: string, _input: string, signal?: AbortSignal): Promise<Execution> {
      await new Promise<void>(resolve => { if (signal?.aborted) resolve(); else signal!.addEventListener("abort", () => resolve(), { once: true }); }); aborted = signal!.aborted;
      return { stdout: "", exitCode: null, failure: "cancelled" };
    } };
    // A referenced timer also bounds this synthetic runner; production Docker has its process timeout.
    const timer = setTimeout(() => {}, 1500);
    try { const state = await runProviderSolver(directory, input, { routes, runner, invoke: async tier => response(good, routes[tier].model) });
      assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "SESSION_DEADLINE"); assert.equal(aborted, true); }
    finally { clearTimeout(timer); }
  }));
});

test("truncated assistant stays blocked when recovered before tool outcomes", async () => directoryTest(async directory => {
  const input = spec(), runner = new ControlledRunner(); let count = 0, crash = true;
  const options: ProviderSolveOptions = { routes, runner, invoke: async tier => { count++; const value = response(good, routes[tier].model) as any; value.choices[0].finish_reason = "length"; return value; } };
  const original = SessionStore.prototype.write;
  SessionStore.prototype.write = async function(value: unknown) { await original.call(this, value); const state = value as ProviderSolveState;
    if (crash && state.messages?.at(-1)?.role === "assistant") { crash = false; throw new Error("controlled assistant commit interruption"); } };
  try { await assert.rejects(runProviderSolver(directory, input, options), /controlled assistant commit interruption/); }
  finally { SessionStore.prototype.write = original; }
  const state = await runProviderSolver(directory, input, options); assert.equal(state.phase, "Undelivered"); assert.equal(state.reason, "TRUNCATED_TOOL_CALL"); assert.equal(runner.calls.length, 0); assert.equal(count, 1);
}));

test("insufficient allowance pauses before dispatch and resumes the same round after funding", async () => directoryTest(async directory => {
  const { InferenceFundingRequired } = await import("../src/provider.js");
  const input = spec(), runner = new ControlledRunner(); let funded = false, calls = 0;
  const options: ProviderSolveOptions = { routes, runner, beforeDispatch: async (_body, round) => {
    assert.equal(round, 0); if (!funded) throw new InferenceFundingRequired();
  }, invoke: async tier => { calls++; return response(good, routes[tier].model); } };
  const paused = await runProviderSolver(directory, input, options);
  assert.equal(paused.phase, "AwaitingFunds"); assert.equal(paused.rounds.length, 0); assert.equal(calls, 0);
  assert.equal((await runProviderSolver(directory, input, options)).phase, "AwaitingFunds");
  funded = true;
  const complete = await runProviderSolver(directory, input, options);
  assert.equal(complete.phase, "Delivered"); assert.equal(calls, 1); assert.equal(runner.calls.length, 1);
}));

test("refueling between rounds preserves prior response and tool feedback", async () => directoryTest(async directory => {
  const { InferenceFundingRequired } = await import("../src/provider.js");
  const input = spec(), runner = new ControlledRunner(); let funded = false, calls = 0;
  const options: ProviderSolveOptions = { routes, runner, beforeDispatch: async (_body, round) => { if (round === 1 && !funded) throw new InferenceFundingRequired(); },
    invoke: async tier => { calls++; return response(calls === 1 ? wrong : good, routes[tier].model); } };
  const paused = await runProviderSolver(directory, input, options);
  assert.equal(paused.phase, "AwaitingFunds"); assert.equal(paused.rounds.length, 1); assert.equal(calls, 1);
  funded = true; const complete = await runProviderSolver(directory, input, options);
  assert.equal(complete.phase, "Delivered"); assert.equal(calls, 2); assert.deepEqual(runner.calls, [wrong, good]);
}));


test("durable gateway response resumes an unknown solver round without a second provider request", async () => directoryTest(async directory => {
  const { InferenceGateway } = await import("../../../services/hosted-agents/src/inference-gateway.js");
  let dispatches = 0, invocations = 0, admissions = 0;
  const catalog = [routes.cheap, routes.strong].map(route => ({ id: route.model, model: route.model,
    route: "https://gateway.invalid/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 2048 }));
  let gateway = await InferenceGateway.open(join(directory, "gateway"), { agentId: "1", taskId: "1", wallet: `0x${"11".repeat(20)}` }, catalog,
    async model => { dispatches++; return { status: 200, body: response(good, model.model) }; });
  await gateway.grant("grant", "100000", { kind: "game", rewardId: "grant" });
  const runner = new ControlledRunner(), input = spec();
  const options: ProviderSolveOptions = { routes, runner, beforeDispatch: async () => { admissions++; },
    invoke: async (_tier, body) => { invocations++; await gateway.invoke("round:0", body); throw new Error("crash after durable gateway response"); },
    recoverResponse: async (body, round) => gateway.readResult(`round:${round}`, body)?.response as Record<string, Json> | undefined };
  try {
    const first = await runProviderSolver(join(directory, "solver"), input, options); assert.equal(first.phase, "Unknown");
    await gateway.close(); gateway = await InferenceGateway.open(join(directory, "gateway"), { agentId: "1", taskId: "1", wallet: `0x${"11".repeat(20)}` }, catalog,
      async () => { throw new Error("must never dispatch on recovery"); });
    const recovered = await runProviderSolver(join(directory, "solver"), input, options);
    assert.equal(recovered.phase, "Delivered"); assert.equal(recovered.candidate, good); assert.equal(recovered.rounds.length, 1);
    assert.equal(dispatches, 1); assert.equal(invocations, 1); assert.equal(admissions, 1); assert.deepEqual(runner.calls, [good]);
    assert.equal(gateway.balance().spentCredits, "50");
  } finally { await gateway.close(); }
}));

test("read-only recovery without a durable result preserves unknown and cannot dispatch", async () => directoryTest(async directory => {
  let calls = 0, lookups = 0; const input = spec(), runner = new ControlledRunner();
  const options: ProviderSolveOptions = { routes, runner, invoke: async () => { calls++; throw new Error("timeout"); },
    recoverResponse: async () => { lookups++; return undefined; } };
  assert.equal((await runProviderSolver(directory, input, options)).phase, "Unknown");
  assert.equal((await runProviderSolver(directory, input, options)).phase, "Unknown");
  assert.equal(calls, 1); assert.equal(lookups, 1); assert.equal(runner.calls.length, 0);
}));


test("ordinary pre-dispatch admission errors pause with their exact safe reason and resume without a phantom model request", async () => directoryTest(async directory => {
  let unavailable = true, calls = 0; const input = spec(), runner = new ControlledRunner();
  const options: ProviderSolveOptions = { routes, runner, beforeDispatch: async () => { if (unavailable) throw new Error("REWARD_INVALID_TASK_REQUEST"); },
    invoke: async tier => { calls++; return response(good, routes[tier].model); } };
  const paused = await runProviderSolver(directory, input, options);
  assert.equal(paused.phase, "AwaitingFunds"); assert.equal(paused.reason, "REWARD_INVALID_TASK_REQUEST"); assert.equal(paused.rounds.length, 0); assert.equal(calls, 0);
  unavailable = false; const resumed = await runProviderSolver(directory, input, options);
  assert.equal(resumed.phase, "Delivered"); assert.equal(resumed.rounds.length, 1); assert.equal(calls, 1);
}));
