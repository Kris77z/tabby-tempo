import { Interface, type TransactionReceipt } from "ethers";

export interface GameAwardEventBinding {
  role: "reward" | "approve" | "deposit"; contract: string; sender: string; recipient: string; agentId: string; amount: bigint;
}
const token = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)", "event Approval(address indexed owner,address indexed spender,uint256 value)"]);
const account = new Interface(["event CashCredited(uint256 indexed agentId,address indexed from,uint256 amount)"]);
const same = (left: string, right: string) => left.toLowerCase() === right.toLowerCase();

/** A Tempo fee Transfer shares the token emitter, but has a different receiver.
 * Match the business counterparties first, then reject duplicate/conflicting amounts. */
export function assertGameAwardEvent(receipt: Pick<TransactionReceipt, "logs">, expected: GameAwardEventBinding) {
  const eventName = expected.role === "reward" ? "Transfer" : expected.role === "approve" ? "Approval" : "CashCredited";
  const abi = expected.role === "deposit" ? account : token;
  const matches = receipt.logs.filter(log => same(log.address, expected.contract)).flatMap(log => {
    try {
      const event = abi.parseLog(log);
      if (event?.name !== eventName) return [];
      const bound = expected.role === "deposit" ? event.args[0] === BigInt(expected.agentId) && same(event.args[1], expected.sender)
        : same(event.args[0], expected.sender) && same(event.args[1], expected.recipient);
      return bound ? [event] : [];
    } catch { return []; }
  });
  if (matches.length !== 1 || matches[0].args[2] !== expected.amount) throw new Error("HOSTED_GAME_AWARD_EVENT_MISMATCH");
}
