import assert from "node:assert/strict";
import test from "node:test";
import { Wallet } from "ethers";
import { runProgrammingLoop, type LoopConfig } from "../src/index.js";

test("tier parameters reject reserved fields, null, primitives and arrays before opening a session or paying", async () => {
  const config: LoopConfig = { taskId: "1", agentId: "1", chainId: "31337", rpcUrl: "http://127.0.0.1:1", relayUrl: "http://127.0.0.1:1/v1/chat", arenaUrl: "http://127.0.0.1:1",
    account: "0x" + "11".repeat(20), asset: "0x" + "22".repeat(20), provider: "0x" + "33".repeat(20), escrowAddress: "0x" + "44".repeat(20),
    service: "infercredit/coder", model: "coder", tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxTotalPrice: "10000", maxPricePerCall: "10000", maxCompletionTokens: 2048, deadlineMs: Date.now() + 1000 };
  const signer = new Wallet("0x" + "02".padStart(64, "0"));
  for (const params of [null, [], { cheap: [] }, { cheap: null }, { cheap: "disabled" }, { other: {} },
    { cheap: { messages: [] } }, { cheap: { model: "spoof" } }, { cheap: { max_completion_tokens: 9999 } },
    { cheap: { thinking: null } }, { cheap: { thinking: "disabled" } }, { cheap: { thinking: [] } },
    { cheap: { thinking: { type: "disabled", keep: "all" } } }, { strong: { reasoning_effort: "max" } }]) {
    await assert.rejects(runProgrammingLoop("/not-opened-invalid-pi-config", { ...config, tierParameters: params } as unknown as LoopConfig, { signer }), /INVALID_TIER_PARAMETERS/);
  }
});
