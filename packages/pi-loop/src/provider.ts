import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Agent, runToolCall, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Json, RoutingTier } from "@agentfuel/sdk";
import { DockerExecutor } from "@agentfuel/arena/docker";
import type { ProblemId } from "@agentfuel/arena";
import { relayStreamFn } from "./adapter.js";
import { isFixedProblemId, publicSampleFor, testPublicSample, type SampleResult } from "./public-sample.js";
import { SessionStore } from "./session.js";

export type JsonObject = Record<string, Json>;
export interface SolveSpec {
  version: 1; problemId: ProblemId; tiers: RoutingTier[];
  maxRounds: number; maxToolCalls: number; maxCompletionTokens: number; deadlineMs: number;
}
export interface ProviderSolveState {
  version: 1; binding: string; spec: SolveSpec; phase: "Running" | "Delivered" | "Undelivered" | "Unknown" | "AwaitingFunds";
  reason?: string; messages: AgentMessage[];
  rounds: { tier: RoutingTier; model: string; body: JsonObject; state: "Dispatching" | "Responded"; response?: Record<string, Json>; appended: boolean }[];
  tools: { id: string; code: string; result?: SampleResult }[];
  candidate?: string; codeHash?: string;
}
export interface ProviderSolveOptions {
  routes: Record<RoutingTier, { name: string; model: string; baseUrl: string }>;
  invoke: (tier: RoutingTier, body: JsonObject, signal: AbortSignal) => Promise<Record<string, Json>>;
  beforeDispatch?: (body: JsonObject, round: number) => Promise<void>;
  /** Read a durably recorded response only; this callback must never dispatch a model call. */
  recoverResponse?: (body: JsonObject, round: number) => Promise<Record<string, Json> | undefined>;
  runner?: DockerExecutor; recoverLock?: boolean;
}
function object(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).sort().join(",") === keys.sort().join(","); }
function bounded(value: unknown, max: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 1 && value <= max; }
export function validateSolveSpec(value: unknown, forQuote = true): SolveSpec {
  if (!object(value) || !exact(value, ["version", "problemId", "tiers", "maxRounds", "maxToolCalls", "maxCompletionTokens", "deadlineMs"]) ||
    value.version !== 1 || !isFixedProblemId(value.problemId) || !bounded(value.maxRounds, 3) || !bounded(value.maxToolCalls, 4) || !bounded(value.maxCompletionTokens, 2048) ||
    !Array.isArray(value.tiers) || value.tiers.length !== value.maxRounds || value.tiers.some(tier => tier !== "cheap" && tier !== "strong") ||
    typeof value.deadlineMs !== "number" || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= 0) throw new Error("INVALID_SOLVE_SPEC");
  const now = Date.now(); if (forQuote && (value.deadlineMs <= now || value.deadlineMs > now + 300000)) throw new Error("INVALID_SOLVE_DEADLINE");
  return { version: 1, problemId: value.problemId, tiers: [...value.tiers] as RoutingTier[], maxRounds: value.maxRounds,
    maxToolCalls: value.maxToolCalls, maxCompletionTokens: value.maxCompletionTokens, deadlineMs: value.deadlineMs };
}
function routesFrom(value: ProviderSolveOptions["routes"]): ProviderSolveOptions["routes"] {
  if (!object(value) || !exact(value, ["cheap", "strong"])) throw new Error("INVALID_SOLVE_ROUTES");
  const route = (input: unknown) => {
    if (!object(input) || !exact(input, ["name", "model", "baseUrl"]) || typeof input.name !== "string" || !input.name.trim() ||
      typeof input.model !== "string" || !input.model.trim() || typeof input.baseUrl !== "string") throw new Error("INVALID_SOLVE_ROUTES");
    const url = new URL(input.baseUrl); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("INVALID_SOLVE_ROUTES");
    return { name: input.name, model: input.model, baseUrl: url.href.replace(/\/$/, "") };
  };
  return { cheap: route(value.cheap), strong: route(value.strong) };
}
function jsonValue(value: unknown): value is Json {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(jsonValue);
  return object(value) && Object.values(value).every(jsonValue);
}
export class InferenceFundingRequired extends Error { constructor(reason = "INFERENCE_FUNDING_REQUIRED") { super(reason); } }
class SolveStop extends Error { constructor(readonly code: string) { super(code); } }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const codeHash = (code: string) => createHash("sha256").update(code).digest("hex");

/** A provider-owned fixed-price service. This module has no payment, credit or settlement entry point. */
export async function runProviderSolver(directory: string, input: SolveSpec, options: ProviderSolveOptions): Promise<ProviderSolveState> {
  const spec = validateSolveSpec(input, false), routes = routesFrom(options.routes), binding = hash({ spec, routes });
  const sample = publicSampleFor(spec.problemId);
  const store = new SessionStore<ProviderSolveState>(directory); await store.start(options.recoverLock);
  const runner = options.runner ?? new DockerExecutor();
  let state: ProviderSolveState; let durabilityError: unknown;
  const save = async () => {
    if (durabilityError) throw durabilityError;
    try { await store.write(state); } catch (error) { durabilityError = error; throw error; }
  };
  const time = () => { if (Date.now() >= spec.deadlineMs) throw new SolveStop("SESSION_DEADLINE"); };
  const stop = async (reason: string) => { state.phase = "Undelivered"; state.reason = reason; delete state.candidate; delete state.codeHash; await save(); };
  try {
    const previous = await store.read();
    if (previous && (previous.version !== 1 || previous.binding !== binding || !isDeepStrictEqual(previous.spec, spec))) throw new Error("SOLVE_CONFIG_MISMATCH");
    state = previous ?? { version: 1, binding, spec, phase: "Running", messages: [], rounds: [], tools: [] };
    if (!Array.isArray(state.rounds) || state.rounds.length > spec.maxRounds || !Array.isArray(state.tools) || state.tools.length > spec.maxToolCalls ||
      !Array.isArray(state.messages) || !["Running", "Delivered", "Undelivered", "Unknown", "AwaitingFunds"].includes(state.phase)) throw new Error("INVALID_SOLVE_STATE");
    if (new Set(state.tools.map(tool => tool.id)).size !== state.tools.length || state.tools.some(tool => typeof tool.id !== "string" ||
      !/^[1-3]:.+$/.test(tool.id) || typeof tool.code !== "string" || !tool.code.length || Buffer.byteLength(tool.code) > 65536 ||
      (tool.result && (typeof tool.result.passed !== "boolean" || typeof tool.result.stdout !== "string")))) throw new Error("INVALID_SOLVE_STATE");
    for (const [index, round] of state.rounds.entries()) {
      if (round.tier !== spec.tiers[index] || round.model !== routes[round.tier].model || round.body.model !== round.model || round.body.max_completion_tokens !== spec.maxCompletionTokens ||
        !["Dispatching", "Responded"].includes(round.state) || typeof round.appended !== "boolean" ||
        (round.appended && (round.state !== "Responded" || !round.response)) || (round.state === "Responded" && !round.response) ||
        (!round.appended && index !== state.rounds.length - 1)) throw new Error("INVALID_SOLVE_STATE");
    }
    if (state.candidate !== undefined || state.phase === "Delivered") {
      const passed = state.tools.find(tool => tool.code === state.candidate && tool.result?.passed === true);
      if (!state.candidate || !passed || state.codeHash !== codeHash(state.candidate)) throw new Error("INVALID_SOLVE_STATE");
    }
    if (state.phase === "AwaitingFunds") { state.phase = "Running"; delete state.reason; await save(); }
    if (state.phase === "Delivered") return structuredClone(state);
    if (state.phase === "Undelivered") return structuredClone(state);
    // A separate gateway may have persisted delivery before the solver saved its own response.
    // Only a read-only lookup bound to this exact round/body can bridge that gap; never resend.
    const unresolvedIndex = state.rounds.findIndex(round => round.state === "Dispatching" && !round.response);
    if (unresolvedIndex !== -1) {
      const unresolved = state.rounds[unresolvedIndex];
      const recovered = await options.recoverResponse?.(structuredClone(unresolved.body), unresolvedIndex);
      if (recovered !== undefined) {
        if (!object(recovered) || !jsonValue(recovered) || recovered.model !== unresolved.model) throw new Error("INVALID_RECOVERED_RESPONSE");
        unresolved.response = structuredClone(recovered); unresolved.state = "Responded";
        state.phase = "Running"; delete state.reason; await save();
      } else {
        state.phase = "Unknown"; state.reason = "UPSTREAM_DISPATCH_UNKNOWN"; await save(); return structuredClone(state);
      }
    }
    if (state.phase === "Unknown") return structuredClone(state);
    await save();
    const schema = Type.Object({ code: Type.String({ minLength: 1, maxLength: 65536 }) }, { additionalProperties: false });
    const tool: AgentTool<typeof schema, SampleResult> = { name: "test_public_sample", label: "Test the fixed public sample",
      description: `Run Python code in isolated Docker against only ${sample.input.trim()} -> ${JSON.stringify(sample.expected)}. This does not submit or settle the task.`, parameters: schema, replay: "safe", executionMode: "sequential",
      execute: async (id, { code }, signal) => {
        const key = `${state.rounds.filter(round => round.appended).length}:${id}`, prior = state.tools.find(attempt => attempt.id === key);
        if (prior && prior.code !== code) throw new SolveStop("TOOL_ID_REUSED");
        if (prior?.result) return { content: [{ type: "text", text: JSON.stringify(prior.result) }], details: prior.result, ...(prior.result.passed ? { terminate: true } : {}) };
        time(); if (!prior && state.tools.length >= spec.maxToolCalls) throw new SolveStop("TOOL_LIMIT");
        const attempt = prior ?? { id: key, code }; if (!prior) state.tools.push(attempt); await save();
        await runner.ready(); time();
        const timeout = AbortSignal.timeout(Math.max(1, spec.deadlineMs - Date.now()));
        const result = await testPublicSample(runner, code, signal ? AbortSignal.any([signal, timeout]) : timeout, spec.problemId); attempt.result = result;
        if (result.passed) { time(); state.candidate = code; state.codeHash = codeHash(code); }
        await save();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, ...(result.passed ? { terminate: true } : {}) };
      } };
    const model: Model<"openai-completions"> = { id: "bounded-solver-v1", name: "Bounded provider solver", api: "openai-completions", provider: "agentfuel-provider",
      baseUrl: routes.cheap.baseUrl, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: spec.maxCompletionTokens };
    let invocationError: string | undefined, toolError: string | undefined;
    const host = { invoke: async (body: { messages: Json[]; tools?: Json[] }) => {
      let round = state.rounds.find(item => !item.appended);
      if (round && (!isDeepStrictEqual(round.body.messages, body.messages) || !isDeepStrictEqual(round.body.tools, body.tools))) throw new SolveStop("SOLVE_REQUEST_MISMATCH");
      if (round?.state === "Responded" && round.response) return { result: structuredClone(round.response) };
      time(); if (state.rounds.length >= spec.maxRounds) throw new SolveStop("ROUND_LIMIT");
      const tier = spec.tiers[state.rounds.length];
      round = { tier, model: routes[tier].model, body: { ...body, model: routes[tier].model, max_completion_tokens: spec.maxCompletionTokens,
        ...(tier === "cheap" ? { thinking: { type: "disabled" } } : { reasoning_effort: "low" }) }, state: "Dispatching", appended: false };
      try { await options.beforeDispatch?.(structuredClone(round.body), state.rounds.length); }
      catch (error) {
        // Admission happens before the dispatch marker. Preserve it as a resumable pause,
        // including host/configuration failures, instead of Pi reporting a model response error.
        state.phase = "AwaitingFunds";
        const reason = error instanceof Error ? error.message : undefined;
        state.reason = typeof reason === "string" && /^[A-Z_0-9]{1,80}$/.test(reason) ? reason : "INFERENCE_ADMISSION_FAILED";
        await save(); throw error;
      }
      state.rounds.push(round); await save(); time();
      const current = round, controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), Math.max(1, spec.deadlineMs - Date.now()));
      let abort!: () => void;
      try {
        const response = await Promise.race([options.invoke(tier, structuredClone(current.body), controller.signal), new Promise<never>((_, reject) => {
          abort = () => reject(new SolveStop("UPSTREAM_DISPATCH_UNKNOWN")); controller.signal.addEventListener("abort", abort, { once: true });
        })]);
        if (!object(response) || !jsonValue(response)) throw new SolveStop("MODEL_RESPONSE_ERROR");
        current.response = structuredClone(response); current.state = "Responded";
      } catch (error) {
        invocationError = error instanceof SolveStop && error.code === "MODEL_RESPONSE_ERROR" ? "MODEL_RESPONSE_ERROR" : "UPSTREAM_DISPATCH_UNKNOWN";
        if (invocationError === "UPSTREAM_DISPATCH_UNKNOWN") { state.phase = "Unknown"; state.reason = invocationError; await save(); }
        throw new SolveStop(invocationError);
      } finally { clearTimeout(timer); controller.signal.removeEventListener("abort", abort); }
      await save(); return { result: structuredClone(current.response!) };
    } };
    const finish = async (message: AssistantMessage) => {
      if (durabilityError) throw durabilityError;
      if (state.phase === "Unknown" || state.phase === "AwaitingFunds") return { action: "end" as const };
      if (state.candidate) { state.phase = "Delivered"; delete state.reason; await save(); return { action: "end" as const }; }
      const reason = invocationError ?? (Date.now() >= spec.deadlineMs ? "SESSION_DEADLINE" : toolError ?? (message.stopReason === "length" ? "TRUNCATED_TOOL_CALL" :
        message.stopReason === "error" || message.stopReason === "aborted" ? "MODEL_RESPONSE_ERROR" : !message.content.some(part => part.type === "toolCall") ? "NO_PUBLIC_TEST" :
        state.tools.length >= spec.maxToolCalls ? "TOOL_LIMIT" : state.rounds.length >= spec.maxRounds ? "ROUND_LIMIT" : undefined));
      if (reason) { await stop(reason); return { action: "end" as const }; }
      return { action: "continue" as const };
    };
    const agent = new Agent({ streamFn: relayStreamFn(host), toolExecution: "sequential", initialState: { model,
      systemPrompt: "You solve exactly the assigned public programming task. The only tool is test_public_sample. No shell, file, network, wallet or settlement tool is available.",
      tools: [tool], ...(state.messages.length ? { messages: structuredClone(state.messages) } : {}) },
      beforeToolCall: async ({ assistantMessage, toolCall }) => {
        const previousTool = state.tools.find(attempt => attempt.id === `${state.rounds.filter(round => round.appended).length}:${toolCall.id}`);
        // A completed sample is locally replayable even after the deadline, without another execution.
        if (previousTool?.result && !durabilityError && assistantMessage.stopReason !== "length") return undefined;
        const reason = durabilityError ? "SOLVE_STORAGE_ERROR" : state.candidate ? "PUBLIC_SAMPLE_PASSED" : assistantMessage.stopReason === "length" ? "TRUNCATED_TOOL_CALL" :
          Date.now() >= spec.deadlineMs ? "SESSION_DEADLINE" : state.tools.length >= spec.maxToolCalls && !previousTool ? "TOOL_LIMIT" : toolError;
        if (reason) { if (reason !== "PUBLIC_SAMPLE_PASSED") toolError = reason; return { block: true, reason, terminate: true }; }
        return undefined;
      }, finishTurn: ({ message }) => finish(message) });
    agent.subscribe(async event => {
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) return;
      state.messages = structuredClone(agent.state.messages);
      if (event.message.role === "assistant") {
        const round = state.rounds.find(item => !item.appended); if (!round?.response) throw new SolveStop("ASSISTANT_WITHOUT_RESPONSE"); round.appended = true;
        for (const call of event.message.content.filter(part => part.type === "toolCall")) {
          if (call.name !== "test_public_sample" || Object.keys(call.arguments).join(",") !== "code" || typeof call.arguments.code !== "string" || !call.arguments.code.length || Buffer.byteLength(call.arguments.code) > 65536) toolError = "MODEL_TOOL_INVALID";
        }
      } else if (event.message.role === "toolResult" && event.message.isError && !state.candidate) toolError ??= "PUBLIC_TOOL_ERROR";
      await save();
    });
    let assistantIndex = state.messages.length - 1;
    while (assistantIndex >= 0 && state.messages[assistantIndex].role === "toolResult") assistantIndex--;
    const tail = state.messages[assistantIndex];
    if (tail?.role === "assistant") {
      for (const call of tail.content.filter(part => part.type === "toolCall")) {
        if (state.messages.slice(assistantIndex + 1).some(message => message.role === "toolResult" && message.toolCallId === call.id)) continue;
        const outcome = await runToolCall(call, { tools: [tool], assistantMessage: tail, context: { messages: agent.state.messages, tools: [tool] }, beforeToolCall: agent.beforeToolCall });
        agent.state.messages = [...agent.state.messages, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: outcome.result.content, isError: outcome.isError, timestamp: Date.now() }];
        if (outcome.isError && !state.candidate) toolError ??= "PUBLIC_TOOL_ERROR";
        state.messages = structuredClone(agent.state.messages); await save();
      }
      if (!state.rounds.some(round => !round.appended) && (await finish(tail)).action === "end") return structuredClone(state);
    }
    // A cached response can be replayed after expiry; tool execution and new dispatch still check the original deadline.
    if (Date.now() >= spec.deadlineMs && !state.rounds.some(round => !round.appended && round.response)) { await stop("SESSION_DEADLINE"); return structuredClone(state); }
    if (!state.messages.length) await agent.prompt(sample.prompt); else await agent.continue();
    if (durabilityError) throw durabilityError;
    if (state.phase === "Running") await stop(invocationError ?? (agent.state.errorMessage ? "MODEL_RESPONSE_ERROR" : "NO_PUBLIC_TEST"));
    return structuredClone(state);
  } catch (error) {
    if (durabilityError) throw durabilityError;
    if (state! && error instanceof SolveStop) { if (state.phase !== "Unknown") await stop(error.code); return structuredClone(state); }
    throw error;
  } finally { await store.close(); }
}
