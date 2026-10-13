import test from "node:test";
import assert from "node:assert/strict";
import { readPending, savePending, replayInput, type PendingCommand } from "../lib/hosted-client";

test("creation recovery preserves name-only and legacy settings without accepting partial configuration", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const owner = "0x1234", input = { name: "Agent", requestId: "12345678-1234-4123-8123-123456789abc" };
  const command: PendingCommand = { owner, kind: "create", input };
  savePending(command, owner); assert.deepEqual(readPending(owner), command);
  const legacy: PendingCommand = { ...command, input: { ...input, modelId: "kimi-k2.6", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: true } };
  savePending(legacy, owner); assert.deepEqual(readPending(owner), legacy);
  savePending({ ...command, input: { ...input, allowCredit: true } } as any, owner); assert.equal(readPending(owner), null);
  savePending(command, owner); assert.equal(readPending("0x5678"), null);
  savePending(null, owner); assert.equal(readPending(owner), null);
});


test("goal pending recovery preserves exact text and UUID under its owner without accepting invalid goals", t => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, "localStorage"), data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => data.set(key, value), removeItem: (key: string) => data.delete(key),
  } });
  t.after(() => { if (previous) Object.defineProperty(globalThis, "localStorage", previous); else Reflect.deleteProperty(globalThis, "localStorage"); });
  const owner = "0xabcd", input = { action: "goal" as const, requestId: "12345678-1234-4123-8123-123456789abc", goal: "  帮我做方案\nKeep whitespace and 中文。  " };
  const command: PendingCommand = { owner, kind: "run", agentId: "agent-1", input };
  savePending(command, owner); assert.deepEqual(readPending(owner), command); assert.equal(readPending("0xefab"), null);
  assert.deepEqual(replayInput({ ...input, agentId: "agent-1", status: "Paused", mission: { stage: "paused", phases: [], calls: [] } } as any), input);
  for (const goal of [undefined, "", "  ", "x".repeat(12001), "bad\u0000text"]) {
    savePending({ ...command, input: { ...input, goal } } as any, owner); assert.equal(readPending(owner), null);
  }
  savePending({ ...command, input: { ...input, action: "task" } } as any, owner); assert.equal(readPending(owner), null);
  savePending({ ...command, input: { ...input, privateKey: "NOT_ALLOWED" } } as any, owner); assert.deepEqual(readPending(owner), command);
});
