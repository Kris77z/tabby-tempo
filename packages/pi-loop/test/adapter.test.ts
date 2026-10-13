import assert from "node:assert/strict";
import test from "node:test";
import { Agent, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { normalizeContext, Type, type AssistantMessage, type Message, type Model } from "@earendil-works/pi-ai";
import type { Inference, Json } from "@agentfuel/sdk";
import { assistantFromInference, relayStreamFn, toRelayMessages, type RelayCallHost } from "../src/adapter.js";

const model: Model<"agentfuel-relay"> = { id: "coder", name: "Relay coder", api: "agentfuel-relay", provider: "agentfuel",
  baseUrl: "http://relay.invalid/v1/chat", input: ["text"], reasoning: false, contextWindow: 262144, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const user: Message = { role: "user", content: "Solve the public sample", timestamp: 1 };
const sampleTool = { name: "test_public_sample", description: "Test Python code against a public sample",
  parameters: Type.Object({ code: Type.String() }) };
function inferred(result: Json): Inference {
  return { result, receipt: { model: "controlled-model" } as Inference["receipt"], handle: {} as Inference["handle"] };
}
function reply(content: string): Inference {
  return inferred({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    model: "controlled-model", usage: { prompt_tokens: 12, completion_tokens: 3, total_tokens: 15 } });
}
function calls(): Inference {
  return inferred({ choices: [{ message: { role: "assistant", content: null, reasoning_content: "Try both samples", tool_calls: [
    { id: "sample-1", type: "function", function: { name: sampleTool.name, arguments: '{"code":"print(1)"}' } },
    { id: "sample-2", type: "function", function: { name: sampleTool.name, arguments: '{"code":"print(2)"}' } },
  ] }, finish_reason: "tool_calls" }], usage: { prompt_tokens: 20, cached_tokens: 4, completion_tokens: 8, total_tokens: 28,
    prompt_tokens_details: { cached_tokens: 4, cache_write_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } } });
}
const assistant = (content: AssistantMessage["content"]) => ({ ...assistantFromInference(reply("previous"), model), content });

test("converts replayed systems, assistant reasoning, two tool IDs and text results", () => {
  const context = normalizeContext({ messages: [
    { role: "system", content: "Solve Python tasks", sections: { rules: "Use stdout" }, toolsAdded: [sampleTool], timestamp: 0 },
    user,
    assistant([{ type: "thinking", thinking: "Test samples" }, { type: "text", text: "Running" },
      { type: "toolCall", id: "a", name: sampleTool.name, arguments: { code: "print(1)" } },
      { type: "toolCall", id: "b", name: sampleTool.name, arguments: { code: "print(2)" } }]),
    { role: "toolResult", toolCallId: "a", toolName: sampleTool.name, content: [{ type: "text", text: "pass" }], isError: false, timestamp: 3 },
    { role: "toolResult", toolCallId: "b", toolName: sampleTool.name, content: [{ type: "text", text: "failed" }], isError: true, timestamp: 4 },
    { role: "system", content: "Return final code", timestamp: 5 },
  ] });
  const converted = toRelayMessages(context) as Record<string, Json>[];
  assert.equal(converted.length, 5);
  assert.equal(converted[0].role, "system");
  assert.match(String(converted[0].content), /Solve Python tasks/);
  assert.match(String(converted[0].content), /Use stdout/);
  assert.match(String(converted[0].content), /Return final code/);
  assert.deepEqual(converted[1], { role: "user", content: user.content });
  assert.deepEqual(converted[2], { role: "assistant", content: "Running", reasoning_content: "Test samples", tool_calls: [
    { id: "a", type: "function", function: { name: sampleTool.name, arguments: '{"code":"print(1)"}' } },
    { id: "b", type: "function", function: { name: sampleTool.name, arguments: '{"code":"print(2)"}' } },
  ] });
  assert.deepEqual(converted[3], { role: "tool", tool_call_id: "a", content: "pass" });
  assert.deepEqual(converted[4], { role: "tool", tool_call_id: "b", content: "Tool execution failed:\nfailed" });
});

test("rejects unsupported content and orphan, duplicate or incomplete tool IDs", () => {
  const call = assistant([{ type: "toolCall", id: "a", name: sampleTool.name, arguments: { code: "print(1)" } }]);
  const result: Message = { role: "toolResult", toolCallId: "a", toolName: sampleTool.name,
    content: [{ type: "text", text: "pass" }], isError: false, timestamp: 3 };
  const invalid: Message[][] = [
    [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "synthetic" }], timestamp: 1 }],
    [assistant([{ type: "thinking", thinking: "hidden", thinkingSignature: "opaque" }])],
    [result], [user, call], [user, call, user],
    [user, call, { ...result, toolCallId: "other" }],
    [user, call, { ...result, toolName: "other" }],
    [user, call, result, result],
    [user, assistant([...call.content, ...call.content]), result],
    [{ role: "system", content: [{ type: "image", mimeType: "image/png", data: "synthetic" }], timestamp: 0 } as unknown as Message, user],
  ];
  for (const messages of invalid) assert.throws(() => toRelayMessages(normalizeContext({ messages })));
  const repeated = toRelayMessages(normalizeContext({ messages: [user, call, result, call, result] })) as Record<string, Json>[];
  assert.equal(repeated.filter(message => message.role === "tool").length, 2);
});

test("parses plain text and controlled tool calls with authoritative usage", () => {
  const plain = assistantFromInference(reply("print(1)"), model);
  assert.equal(plain.stopReason, "stop"); assert.equal(plain.responseModel, "controlled-model");
  assert.deepEqual(plain.content, [{ type: "text", text: "print(1)" }]);
  const tools = assistantFromInference(calls(), model);
  assert.equal(tools.stopReason, "toolUse");
  assert.deepEqual(tools.content, [{ type: "thinking", thinking: "Try both samples" },
    { type: "toolCall", id: "sample-1", name: sampleTool.name, arguments: { code: "print(1)" } },
    { type: "toolCall", id: "sample-2", name: sampleTool.name, arguments: { code: "print(2)" } }]);
  assert.deepEqual(tools.usage, { input: 14, output: 8, cacheRead: 4, cacheWrite: 2, reasoning: 3, totalTokens: 28,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
});

test("rejects malformed responses and preserves length instead of executing truncated calls", () => {
  for (const result of [
    {}, { choices: [] }, { choices: [{ message: { role: "assistant", content: null } }] },
    { choices: [{ message: { role: "assistant", content: "", reasoning_content: "thinking only" } }] },
    { choices: [{ message: { role: "assistant", content: [{ type: "image" }] } }] },
    { choices: [{ message: { role: "assistant", tool_calls: [{ id: "x", type: "function", function: { name: sampleTool.name, arguments: "bad JSON" } }] } }] },
    { choices: [{ message: { role: "assistant", tool_calls: [{ id: "x", type: "function", function: { name: sampleTool.name, arguments: "[]" } }] } }] },
    { choices: [{ message: { role: "assistant", content: "blocked" }, finish_reason: "content_filter" }] },
  ] as Json[]) assert.throws(() => assistantFromInference(inferred(result), model));
  const duplicate = calls();
  const response = duplicate.result as any;
  response.choices[0].message.tool_calls[1].id = "sample-1";
  assert.throws(() => assistantFromInference(duplicate, model), /Duplicate tool call/);
  const truncated = calls(); (truncated.result as any).choices[0].finish_reason = "length";
  assert.equal(assistantFromInference(truncated, model).stopReason, "length");
});

test("non-streaming bridge emits start/done and resolves its result", { timeout: 2000 }, async () => {
  let body!: Parameters<RelayCallHost["invoke"]>[0];
  const stream = await relayStreamFn({ invoke: async value => { body = value; return reply("print(1)"); } })(model,
    normalizeContext({ messages: [user], tools: [sampleTool] }));
  const events = []; for await (const event of stream) events.push(event);
  assert.deepEqual(events.map(event => event.type), ["start", "done"]);
  assert.equal((await stream.result()).stopReason, "stop");
  assert.deepEqual(body.tools, [{ type: "function", function: { name: sampleTool.name, description: sampleTool.description,
    parameters: { type: "object", properties: { code: { type: "string" } }, required: ["code"] } } }]);
  assert.deepEqual(body.messages, [{ role: "system", content: "" }, { role: "user", content: user.content }]);
});

test("host errors, malformed replies and aborts terminate without hanging or another call", { timeout: 2000 }, async () => {
  for (const invoke of [async () => { throw new Error("controlled host failure"); }, async () => inferred({})]) {
    const stream = await relayStreamFn({ invoke })(model, normalizeContext({ messages: [user] }));
    const events = []; for await (const event of stream) events.push(event);
    assert.equal(events.at(-1)!.type, "error");
    assert.equal((await stream.result()).stopReason, "error");
    assert.ok((await stream.result()).errorMessage);
  }
  const controller = new AbortController(); controller.abort();
  let called = 0;
  const stream = await relayStreamFn({ invoke: async () => { called++; return reply("ignored"); } })(model,
    normalizeContext({ messages: [user] }), { signal: controller.signal });
  for await (const event of stream) assert.equal(event.type, "error");
  assert.equal((await stream.result()).stopReason, "aborted"); assert.equal(called, 0);
  const mid = new AbortController();
  const active = await relayStreamFn({ invoke: async () => { called++; mid.abort(); return reply("delivered"); } })(model,
    normalizeContext({ messages: [user] }), { signal: mid.signal });
  for await (const _event of active) { /* consume the terminal event */ }
  assert.equal((await active.result()).stopReason, "aborted"); assert.equal(called, 1);
  const invalid = await relayStreamFn({ invoke: async () => { called++; return reply("ignored"); } })(model,
    normalizeContext({ messages: [{ role: "user", content: [{ type: "image", mimeType: "image/png", data: "synthetic" }], timestamp: 1 }] }));
  for await (const _event of invalid) { /* consume the terminal event */ }
  assert.equal((await invalid.result()).stopReason, "error"); assert.equal(called, 1);
});

test("Agent uses only the host, executes both tool IDs, then stops on ordinary text", { timeout: 3000 }, async () => {
  let defaults = 0;
  setDefaultStreamFn(() => { defaults++; throw new Error("Default provider must not run"); });
  try {
    const inputs: Parameters<RelayCallHost["invoke"]>[0][] = [];
    const executed: string[] = [];
    const agent = new Agent({ initialState: { model, tools: [{ ...sampleTool, label: "Public sample", execute: async id => {
      executed.push(id); return { content: [{ type: "text", text: "sample passes" }], details: {} };
    } }] }, toolExecution: "sequential", streamFn: relayStreamFn({ invoke: async body => {
      inputs.push(body); return inputs.length === 1 ? calls() : reply("print(1)");
    } }) });
    await agent.prompt("Solve the public sample");
    assert.deepEqual(executed, ["sample-1", "sample-2"]);
    assert.equal(inputs.length, 2); assert.equal(defaults, 0);
    const messages = inputs[1].messages as Record<string, Json>[];
    assert.deepEqual(messages.filter(message => message.role === "tool").map(message => message.tool_call_id), ["sample-1", "sample-2"]);
    assert.equal((agent.state.messages.at(-1) as AssistantMessage).stopReason, "stop");
    assert.equal(agent.state.isStreaming, false); assert.equal(agent.state.errorMessage, undefined);
  } finally { setDefaultStreamFn(undefined); }
});
