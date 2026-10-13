import {
  collapseSystemMessages, createAssistantMessageEventStream, getCurrentTools, getSystemMessageText,
  type Api, type AssistantMessage, type Message, type Model, type TranscriptContext, type Usage,
} from "@earendil-works/pi-ai";
import type { StreamFn } from "@earendil-works/pi-agent-core";
import type { Inference, Json } from "@agentfuel/sdk";

export type ModelResponse = Pick<Inference, "result"> & { receipt?: Pick<Inference["receipt"], "model"> };
export interface RelayCallHost {
  invoke(body: { messages: Json[]; tools?: Json[] }): Promise<ModelResponse>;
}

function object(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  return value as Record<string, unknown>;
}

function jsonObject(value: unknown, label: string): Record<string, Json> {
  const record = object(value, label);
  const check = (item: unknown): item is Json => {
    if (item === null || typeof item === "string" || typeof item === "boolean") return true;
    if (typeof item === "number") return Number.isFinite(item);
    if (Array.isArray(item)) return item.every(check);
    return typeof item === "object" && item !== null && Object.values(item).every(check);
  };
  if (!check(record)) throw new Error(`${label} must contain JSON values only`);
  return record as Record<string, Json>;
}

function text(content: unknown, label: string): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) throw new Error(`${label} must contain text only`);
  return content.map(part => {
    const block = object(part, label);
    if (block.type !== "text" || typeof block.text !== "string") throw new Error(`${label} must contain text only`);
    return block.text;
  }).join("\n");
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} must be a nonempty string`);
  return value;
}

/** Convert the replayed Pi transcript without dropping unsupported content or unmatched tool calls. */
export function toRelayMessages(context: TranscriptContext): Json[] {
  const messages: Json[] = [];
  const pending = new Map<string, string>();
  const seen = new Set<string>();
  // Validate before replay: the replay helpers intentionally read only textual system content.
  for (const message of context.messages) if (message.role === "system") {
    text(message.content, "System message");
    if (message.sections && Object.values(message.sections).some(value => value !== null && typeof value !== "string")) {
      throw new Error("System sections must contain text only");
    }
  }
  for (const message of collapseSystemMessages(context).messages) {
    if (message.role === "toolResult") {
      const id = identifier(message.toolCallId, "toolResult.toolCallId");
      if (!pending.has(id) || pending.get(id) !== message.toolName) throw new Error(`Unmatched tool result ${id}`);
      pending.delete(id);
      const content = text(message.content, "Tool result");
      messages.push({ role: "tool", tool_call_id: id, content: message.isError ? `Tool execution failed:\n${content}` : content });
      continue;
    }
    if (pending.size) throw new Error("Tool calls must have results before another message");
    if (message.role === "system") {
      text(message.content, "System message");
      messages.push({ role: "system", content: getSystemMessageText(message) });
    } else if (message.role === "user") {
      messages.push({ role: "user", content: text(message.content, "User message") });
    } else if (message.role === "assistant") {
      // Provider IDs need only be unique within a tool batch; a later turn may reuse one.
      seen.clear();
      const plain: string[] = [];
      const thinking: string[] = [];
      const calls: Json[] = [];
      for (const block of message.content) {
        if (block.type === "text" && typeof block.text === "string") plain.push(block.text);
        else if (block.type === "thinking" && typeof block.thinking === "string" && !block.redacted && !block.thinkingSignature) {
          thinking.push(block.thinking);
        } else if (block.type === "toolCall") {
          const id = identifier(block.id, "toolCall.id");
          const name = identifier(block.name, "toolCall.name");
          if (seen.has(id)) throw new Error(`Duplicate tool call ${id}`);
          if (block.namespace || block.thoughtSignature) throw new Error("Namespaced or signed tool calls are unsupported");
          seen.add(id); pending.set(id, name);
          calls.push({ id, type: "function", function: { name, arguments: JSON.stringify(jsonObject(block.arguments, "Tool arguments")) } });
        } else throw new Error("Assistant message contains unsupported content");
      }
      const content = plain.join("\n");
      if (!content && !calls.length) throw new Error("Assistant message has no text or tool calls");
      messages.push({ role: "assistant", content: content || null,
        ...(thinking.length ? { reasoning_content: thinking.join("\n") } : {}), ...(calls.length ? { tool_calls: calls } : {}) });
    } else throw new Error(`Unsupported message role ${(message as Message).role}`);
  }
  if (pending.size) throw new Error("Tool calls are missing results");
  return messages;
}

function relayTools(context: TranscriptContext): Json[] {
  const seen = new Set<string>();
  return getCurrentTools(context.messages).map(tool => {
    const name = identifier(tool.name, "Tool name");
    if (seen.has(name)) throw new Error(`Duplicate tool definition ${name}`);
    seen.add(name);
    if (typeof tool.description !== "string" || tool.constrainedSampling) throw new Error("Unsupported tool definition");
    // Pi's declarations are JSON schemas; the round-trip removes TypeBox symbol metadata.
    const parameters = jsonObject(JSON.parse(JSON.stringify(tool.parameters)), "Tool schema");
    return { type: "function", function: { name, description: tool.description, parameters } };
  });
}

function count(value: unknown, label: string): number {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a nonnegative integer`);
  return value;
}

function usageFromResult(value: unknown): Usage {
  const usage = value === undefined || value === null ? {} : object(value, "Usage");
  const promptDetails = usage.prompt_tokens_details === undefined ? {} : object(usage.prompt_tokens_details, "Prompt token details");
  const completionDetails = usage.completion_tokens_details === undefined ? {} : object(usage.completion_tokens_details, "Completion token details");
  const prompt = count(usage.prompt_tokens, "prompt_tokens");
  const output = count(usage.completion_tokens, "completion_tokens");
  const cacheRead = count(promptDetails.cached_tokens ?? usage.cached_tokens, "cached_tokens");
  const cacheWrite = count(promptDetails.cache_write_tokens, "cache_write_tokens");
  return { input: Math.max(0, prompt - cacheRead - cacheWrite), output, cacheRead, cacheWrite,
    ...(completionDetails.reasoning_tokens !== undefined ? { reasoning: count(completionDetails.reasoning_tokens, "reasoning_tokens") } : {}),
    totalTokens: usage.total_tokens === undefined ? prompt + output : count(usage.total_tokens, "total_tokens"),
    // Framework-required placeholders only. The SDK receipt/quote holds the actual settlement bill.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

function emptyMessage(model: Model<Api>): AssistantMessage {
  return { role: "assistant", content: [], api: model.api, provider: model.provider, model: model.id,
    usage: usageFromResult(undefined), stopReason: "pending", timestamp: Date.now() };
}

/** Parse a single non-streaming OpenAI-compatible response returned by the paid SDK call. */
export function assistantFromInference(inference: ModelResponse, model: Model<Api>): AssistantMessage {
  const result = object(inference.result, "Inference result");
  if (!Array.isArray(result.choices) || result.choices.length !== 1) throw new Error("Inference must contain exactly one choice");
  const choice = object(result.choices[0], "Inference choice");
  const source = object(choice.message, "Assistant response");
  if (source.role !== "assistant") throw new Error("Inference choice must be an assistant message");
  if (source.content !== undefined && source.content !== null && typeof source.content !== "string") throw new Error("Assistant response must contain text only");
  if (source.reasoning_content !== undefined && source.reasoning_content !== null && typeof source.reasoning_content !== "string") {
    throw new Error("Assistant reasoning must contain text only");
  }
  const message = emptyMessage(model);
  if (source.reasoning_content) message.content.push({ type: "thinking", thinking: source.reasoning_content as string });
  if (source.content) message.content.push({ type: "text", text: source.content as string });
  if (source.tool_calls !== undefined && source.tool_calls !== null && !Array.isArray(source.tool_calls)) throw new Error("tool_calls must be an array");
  const seen = new Set<string>();
  for (const item of (source.tool_calls ?? []) as unknown[]) {
    const call = object(item, "Tool call");
    const fn = object(call.function, "Tool function");
    const id = identifier(call.id, "Tool call id");
    const name = identifier(fn.name, "Tool function name");
    if (call.type !== "function" || typeof fn.arguments !== "string") throw new Error("Unsupported tool call format");
    if (seen.has(id)) throw new Error(`Duplicate tool call ${id}`);
    seen.add(id);
    let args: unknown;
    try { args = JSON.parse(fn.arguments); } catch { throw new Error(`Invalid JSON arguments for tool ${name}`); }
    message.content.push({ type: "toolCall", id, name, arguments: jsonObject(args, "Tool arguments") });
  }
  const hasTools = seen.size > 0;
  if (!source.content && !hasTools) throw new Error("Assistant response has no text or tool calls");
  const reason = choice.finish_reason;
  if (reason !== undefined && reason !== "stop" && reason !== "length" && reason !== "tool_calls") throw new Error(`Unsupported finish reason ${String(reason)}`);
  if (reason === "tool_calls" && !hasTools) throw new Error("tool_calls finish reason has no tool calls");
  message.stopReason = reason === "length" ? "length" : hasTools ? "toolUse" : "stop";
  if (typeof reason === "string") message.rawStopReason = reason;
  message.usage = usageFromResult(result.usage);
  const responseModel = typeof result.model === "string" ? result.model : inference.receipt?.model;
  if (responseModel) message.responseModel = responseModel;
  if (typeof result.id === "string") message.responseId = result.id;
  return message;
}

/** The sole model transport: no Pi provider runtime or network fallback is used. */
export function relayStreamFn(host: RelayCallHost): StreamFn {
  return (model, context, options) => {
    const stream = createAssistantMessageEventStream();
    void (async () => {
      try {
        if (options?.signal?.aborted) throw new Error("Operation aborted");
        const messages = toRelayMessages(context);
        const tools = relayTools(context);
        stream.push({ type: "start", partial: emptyMessage(model) });
        const inference = await host.invoke({ messages, ...(tools.length ? { tools } : {}) });
        if (options?.signal?.aborted) throw new Error("Operation aborted");
        const message = assistantFromInference(inference, model);
        stream.push({ type: "done", reason: message.stopReason as "stop" | "length" | "toolUse", message });
      } catch (error) {
        const reason = options?.signal?.aborted ? "aborted" : "error";
        stream.push({ type: "error", reason, error: { ...emptyMessage(model), stopReason: reason,
          errorMessage: error instanceof Error ? error.message : String(error) } });
      } finally {
        stream.end();
      }
    })();
    return stream;
  };
}
