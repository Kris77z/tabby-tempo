import assert from "node:assert/strict";
import test from "node:test";
import { Interface, type TransactionReceipt } from "ethers";
import { assertGameAwardEvent, type GameAwardEventBinding } from "../src/game-award-events.js";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const token = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)", "event Approval(address indexed owner,address indexed spender,uint256 value)"]);
const account = new Interface(["event CashCredited(uint256 indexed agentId,address indexed from,uint256 amount)"]);
const expected: GameAwardEventBinding = { role: "reward", contract: addr(1), sender: addr(2), recipient: addr(3), agentId: "50", amount: 100000n };
const log = (abi: Interface, name: string, args: unknown[], emitter = addr(1)) => ({ address: emitter, ...abi.encodeEventLog(abi.getEvent(name)!, args) });
const receipt = (...logs: ReturnType<typeof log>[]) => ({ logs }) as unknown as Pick<TransactionReceipt, "logs">;
test("Tempo business reward Transfer remains valid beside the actual fee receiver shape", () => {
  assertGameAwardEvent(receipt(log(token, "Transfer", [addr(2), addr(3), 100000n]),
    log(token, "Transfer", [addr(2), "0xfeEC000000000000000000000000000000000000", 172n])), expected);
});
test("duplicate business transfers and conflicting amounts cannot be hidden by a matching transfer", () => {
  const correct = log(token, "Transfer", [addr(2), addr(3), 100000n]);
  for (const conflicting of [correct, log(token, "Transfer", [addr(2), addr(3), 99999n])]) assert.throws(() => assertGameAwardEvent(receipt(correct, conflicting), expected), /EVENT_MISMATCH/);
  assert.throws(() => assertGameAwardEvent(receipt(log(token, "Transfer", [addr(2), addr(3), 99999n])), expected), /EVENT_MISMATCH/);
});
test("fee-only, wrong emitter or another recipient never establishes a game reward", () => {
  for (const wrong of [log(token, "Transfer", [addr(2), addr(4), 100000n]), log(token, "Transfer", [addr(2), addr(3), 100000n], addr(9))])
    assert.throws(() => assertGameAwardEvent(receipt(wrong), expected), /EVENT_MISMATCH/);
});
test("approval and deposit match their own identity and amount while token fee logs remain separate", () => {
  assertGameAwardEvent(receipt(log(token, "Approval", [addr(2), addr(3), 100000n]), log(token, "Transfer", [addr(2), addr(4), 172n])), { ...expected, role: "approve" });
  const deposit = { ...expected, role: "deposit", contract: addr(5) } as GameAwardEventBinding;
  assertGameAwardEvent(receipt(log(account, "CashCredited", [50n, addr(2), 100000n], addr(5)), log(token, "Transfer", [addr(2), addr(4), 172n])), deposit);
  assert.throws(() => assertGameAwardEvent(receipt(log(account, "CashCredited", [51n, addr(2), 100000n], addr(5))), deposit), /EVENT_MISMATCH/);
});
