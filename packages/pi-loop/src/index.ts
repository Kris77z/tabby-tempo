import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { JsonRpcProvider, type Signer } from "ethers";
import { Agent, runToolCall, type AgentMessage, type AgentTool } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { type Submission } from "@agentfuel/arena/submission-auth";
import { InferCredit, PaymentError, type Inference, type Json, type PaymentHandle, type RoutingTier } from "@agentfuel/sdk";
import { relayStreamFn } from "./adapter.js";
import { PUBLIC_SAMPLE, testPublicSample, type SampleResult } from "./public-sample.js";
import { SessionStore } from "./session.js";
import { submitProgrammingCandidate } from "./submission.js";
export { SessionStore, PUBLIC_SAMPLE, testPublicSample };

export interface LoopConfig {
  taskId: string; agentId: string; rpcUrl: string; chainId: string; account: string; asset: string; provider: string;
  relayUrl: string; service: string; model: string; tiers: RoutingTier[];
  maxRounds: number; maxToolCalls: number; maxTotalPrice: string; maxPricePerCall: string; deadlineMs: number;
  arenaUrl: string; escrowAddress: string; maxCompletionTokens: number;
  tierParameters?: Partial<Record<RoutingTier, { thinking?: { type: "disabled" }; reasoning_effort?: "low" }>>;
}
type RelayBody = Record<string, Json> & { service: string; model: string; messages: Json[]; tier: RoutingTier };
export interface Round { body: RelayBody; handle?: PaymentHandle; inference?: Inference; appended: boolean }
export interface ToolAttempt { id: string; code: string; result?: SampleResult }
export interface LoopSession {
  version: 1; binding: string; config: LoopConfig; phase: "Running" | "Paused" | "Stopped" | "ReadyToSubmit" | "SubmissionPending" | "Succeeded" | "Failed";
  reason?: string; reservedPrice: string; messages: AgentMessage[]; rounds: Round[]; tools: ToolAttempt[];
  candidate?: string; submission?: { payload: Submission; runId?: string; result?: Json };
}
export interface LoopOptions { signer: Signer; runner?: DockerExecutor; recoverLock?: boolean; timeoutMs?: number; pollTimeoutMs?: number }

function stop(code: string): never { throw new PaymentError(code, code); }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function validateConfig(c: LoopConfig) {
  const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
  for (const key of ["taskId", "agentId", "chainId", "maxTotalPrice", "maxPricePerCall"] as const) if (!/^(0|[1-9][0-9]*)$/.test(c[key])) throw new Error("INVALID_LOOP_CONFIG");
  if (c.taskId === "0" || c.chainId === "0" || BigInt(c.maxTotalPrice) <= 0n || BigInt(c.maxPricePerCall) <= 0n ||
    !Number.isSafeInteger(c.maxRounds) || c.maxRounds < 1 || c.maxRounds > 16 || c.tiers.length !== c.maxRounds || c.tiers.some(t => t !== "cheap" && t !== "strong") ||
    !Number.isSafeInteger(c.maxToolCalls) || c.maxToolCalls < 1 || c.maxToolCalls > 32 || !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs <= 0 ||
    !Number.isSafeInteger(c.maxCompletionTokens) || c.maxCompletionTokens < 1 || c.maxCompletionTokens > 4096) throw new Error("INVALID_LOOP_CONFIG");
  for (const url of [c.rpcUrl, c.relayUrl, c.arenaUrl]) { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("INVALID_LOOP_URL"); }
  if (c.tierParameters !== undefined && !object(c.tierParameters)) throw new Error("INVALID_TIER_PARAMETERS");
  for (const [tier, params] of Object.entries(c.tierParameters ?? {})) {
    if (!["cheap", "strong"].includes(tier) || !object(params) || Object.keys(params).some(k => !["thinking", "reasoning_effort"].includes(k)) ||
      (params.thinking !== undefined && (!object(params.thinking) || params.thinking.type !== "disabled" || Object.keys(params.thinking).join(",") !== "type")) ||
      (params.reasoning_effort !== undefined && params.reasoning_effort !== "low")) throw new Error("INVALID_TIER_PARAMETERS");
  }
}

/** One explicitly assigned task; all inference uses the SDK's cash-only taskId=0 path. */
export async function runProgrammingLoop(directory: string, config: LoopConfig, options: LoopOptions): Promise<LoopSession> {
  validateConfig(config);
  const store = new SessionStore<LoopSession>(directory); await store.start(options.recoverLock);
  const rpc = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  const runner = options.runner ?? new DockerExecutor();
  let state: LoopSession;
  const assertTime = () => { if (Date.now() >= config.deadlineMs) stop("SESSION_DEADLINE"); };
  const save = () => store.write(state);
  try {
    const prior = await store.read();
    if (prior && (prior.version !== 1 || prior.binding !== hash(config) || !isDeepStrictEqual(prior.config, config))) throw new Error("SESSION_CONFIG_MISMATCH");
    state = prior ?? { version: 1, binding: hash(config), config: structuredClone(config), phase: "Running", reservedPrice: "0", messages: [], rounds: [], tools: [] };
    if (state.reservedPrice !== state.rounds.reduce((sum, r) => sum + BigInt(r.handle?.quote.price ?? "0"), 0n).toString() || BigInt(state.reservedPrice) > BigInt(config.maxTotalPrice)) throw new Error("SESSION_BUDGET_INVALID");
    if (["Succeeded", "Failed", "Stopped"].includes(state.phase)) return structuredClone(state);
    await save();
    if (state.submission || state.phase === "ReadyToSubmit") { await submit(); return structuredClone(state); }
    let invocationError: string | undefined;
    const schema = Type.Object({ code: Type.String({ minLength: 1, maxLength: 65536 }) }, { additionalProperties: false });
    const tool: AgentTool<typeof schema, SampleResult> = { name: "test_public_sample", label: "Test the fixed public sample", description: "Run Python code in isolated Docker against only [4,8,-3] -> 9. This does not submit or settle the task.", parameters: schema, replay: "safe", executionMode: "sequential",
      execute: async (id, { code }, signal) => {
        // Providers may reuse a tool-call ID in another turn; journal identity also includes the paid round.
        const key = `${state.rounds.filter(r => r.appended).length}:${id}`;
        const previous = state.tools.find(t => t.id === key);
        if (previous && previous.code !== code) stop("TOOL_ID_REUSED");
        if (previous?.result) return { content: [{ type: "text", text: JSON.stringify(previous.result) }], details: previous.result };
        assertTime();
        if (!previous && state.tools.length >= config.maxToolCalls) stop("TOOL_LIMIT");
        const attempt = previous ?? { id: key, code }; if (!previous) state.tools.push(attempt);
        delete state.candidate; await save(); // Safe replay after a crash can repeat this public test, never settlement.
        await runner.ready();
        assertTime();
        const deadlineSignal = AbortSignal.timeout(Math.max(1, config.deadlineMs - Date.now()));
        const result = await testPublicSample(runner, code, signal ? AbortSignal.any([signal, deadlineSignal]) : deadlineSignal); attempt.result = result;
        if (result.passed) state.candidate = code;
        await save();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      } };
    const model: Model<"openai-completions"> = { id: config.model, name: config.model, api: "openai-completions", provider: "agentfuel-relay", baseUrl: config.relayUrl, input: ["text"], reasoning: false,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 32768, maxTokens: config.maxCompletionTokens };
    const host = { invoke: async (body: { messages: Json[]; tools?: Json[] }): Promise<Inference> => {
      let round = state.rounds.find(r => !r.appended);
      try {
        if (round && (!isDeepStrictEqual(round.body.messages, body.messages) || !isDeepStrictEqual(round.body.tools, body.tools))) stop("SESSION_REQUEST_MISMATCH");
        if (round?.inference) return structuredClone(round.inference);
        if (!round) {
          assertTime(); if (state.rounds.length >= config.maxRounds) stop("ROUND_LIMIT");
          if (BigInt(state.reservedPrice) >= BigInt(config.maxTotalPrice)) stop("BUDGET_LIMIT");
          const tier = config.tiers[state.rounds.length];
          round = { body: { ...config.tierParameters?.[tier], ...body, service: config.service, model: config.model, tier, max_completion_tokens: config.maxCompletionTokens }, appended: false };
          state.rounds.push(round); await save();
        }
        const current = round;
        const remaining = BigInt(config.maxTotalPrice) - BigInt(state.reservedPrice);
        const cap = current.handle ? BigInt(current.handle.quote.price) : (remaining < BigInt(config.maxPricePerCall) ? remaining : BigInt(config.maxPricePerCall));
        if (cap <= 0n) stop("BUDGET_LIMIT");
        const infer = new InferCredit({ agentId: config.agentId, rpcUrl: config.rpcUrl, chainId: BigInt(config.chainId), account: config.account, asset: config.asset, provider: config.provider, maxPrice: cap, signer: options.signer,
          timeoutMs: options.timeoutMs ?? 10000,
          onHandle: async handle => {
            if (handle.input.taskId !== "0" || handle.quote.tier !== current.body.tier) stop("SESSION_HANDLE_MISMATCH");
            if (current.handle && current.handle.quote.paymentId !== handle.quote.paymentId) stop("SESSION_HANDLE_MISMATCH");
            const price = BigInt(handle.quote.price);
            if (!current.handle) { if (price > remaining || price > BigInt(config.maxPricePerCall)) stop("BUDGET_LIMIT"); state.reservedPrice = (BigInt(state.reservedPrice) + price).toString(); }
            current.handle = structuredClone(handle); await save(); // A failed durable write rejects before payment.
          }, beforePayment: () => { assertTime(); if (!current.handle) stop("HANDLE_NOT_PERSISTED"); } });
        try {
          const result = current.handle ? await infer.resume(structuredClone(current.handle)) : await infer.fetch(config.relayUrl, { body: current.body });
          if (result.receipt.taskId !== "0" || result.receipt.tier !== current.body.tier || result.receipt.price !== current.handle?.quote.price || result.receipt.paymentId !== current.handle.quote.paymentId) stop("SESSION_RECEIPT_MISMATCH");
          current.inference = result; await save(); return structuredClone(result);
        } finally { infer.close(); }
      } catch (error) { invocationError = error instanceof PaymentError ? error.code : "LOOP_UNAVAILABLE"; throw error; }
    } };
    const finish = async (message: AssistantMessage) => {
      const calls = message.content.filter(c => c.type === "toolCall");
      if (state.candidate) { state.phase = "ReadyToSubmit"; await save(); return { action: "end" as const }; }
      let reason: string | undefined;
      if (Date.now() >= config.deadlineMs) reason = "SESSION_DEADLINE";
      else if (!calls.length) reason = "NO_PUBLIC_TEST";
      else if (state.tools.length >= config.maxToolCalls) reason = "TOOL_LIMIT";
      else if (state.rounds.length >= config.maxRounds) reason = "ROUND_LIMIT";
      else if (BigInt(state.reservedPrice) >= BigInt(config.maxTotalPrice)) reason = "BUDGET_LIMIT";
      if (reason) { state.phase = "Stopped"; state.reason = reason; await save(); return { action: "end" as const }; }
      return { action: "continue" as const };
    };
    const agent = new Agent({ streamFn: relayStreamFn(host), toolExecution: "sequential", initialState: { model, systemPrompt: "You solve exactly the assigned public programming task. The only tool is test_public_sample. No shell, file, network, wallet or settlement tool is available.", tools: [tool], ...(state.messages.length ? { messages: structuredClone(state.messages) } : {}) },
      beforeToolCall: async ({ assistantMessage }) => assistantMessage.stopReason === "length" ? { block: true, reason: "TRUNCATED_TOOL_CALL", terminate: true } : Date.now() >= config.deadlineMs ? { block: true, reason: "SESSION_DEADLINE", terminate: true } : undefined,
      finishTurn: ({ message }) => finish(message) });
    agent.subscribe(async event => {
      if (event.type !== "message_end") return;
      if (event.message.role === "assistant" && ["error", "aborted"].includes(event.message.stopReason)) return; // Keep the resumable user/tool transcript.
      state.messages = structuredClone(agent.state.messages);
      if (event.message.role === "assistant") { const round = state.rounds.find(r => !r.appended); if (!round?.inference) stop("ASSISTANT_WITHOUT_RECEIPT"); round.appended = true; }
      await save();
    });
    // Pi.continue() cannot replay missing calls from an assistant tail. Reconcile each ID through Pi's own validation path.
    let assistantIndex = state.messages.length - 1;
    while (assistantIndex >= 0 && state.messages[assistantIndex].role === "toolResult") assistantIndex--;
    const tail = state.messages[assistantIndex];
    if (tail?.role === "assistant") {
      const assistant = tail as AssistantMessage;
      for (const call of assistant.content.filter(c => c.type === "toolCall")) {
        if (state.messages.slice(assistantIndex + 1).some(m => m.role === "toolResult" && m.toolCallId === call.id)) continue;
        const outcome = await runToolCall(call, { tools: [tool], assistantMessage: assistant, context: { messages: agent.state.messages, tools: [tool] }, beforeToolCall: agent.beforeToolCall });
        agent.state.messages = [...agent.state.messages, { role: "toolResult", toolCallId: call.id, toolName: call.name, content: outcome.result.content, isError: outcome.isError, timestamp: Date.now() }];
        state.messages = structuredClone(agent.state.messages); await save();
      }
      // A later round may already have consumed the remaining reservation. Claim that exact pending result
      // before applying new-round limits to this earlier completed turn.
      if (!state.rounds.some(r => !r.appended)) {
        const decision = await finish(assistant);
        if (decision.action === "end") { if ((state as LoopSession).phase === "ReadyToSubmit") await submit(); return structuredClone(state); }
      }
    }
    if (!state.messages.length) await agent.prompt(PUBLIC_SAMPLE.prompt); else await agent.continue();
    if (invocationError || agent.state.errorMessage) {
      state.reason = invocationError ?? "MODEL_RESPONSE_ERROR";
      state.phase = invocationError === "PAYMENT_REVERTED" ? "Stopped" : state.rounds.some(r => !r.appended && r.handle) ? "Paused" : "Stopped"; await save();
    }
    if ((state as LoopSession).phase === "ReadyToSubmit") await submit();
    return structuredClone(state);

    async function submit() { await submitProgrammingCandidate(state, config, { ...options, rpc, save }); }
  } catch (error) {
    if (state! && error instanceof PaymentError) { state.reason = error.code; state.phase = error.code === "PAYMENT_REVERTED" ? "Stopped" : state.submission ? "SubmissionPending" : state.rounds.some(r => !r.appended && r.handle) ? "Paused" : "Stopped"; await store.write(state); return structuredClone(state); }
    throw error;
  } finally { rpc.destroy(); await store.close(); }
}
