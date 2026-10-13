import assert from "node:assert/strict";
import test from "node:test";
import { validateHostedFinance } from "../src/finance-projection.js";
import type { HostedAgent, HostedFinance } from "../src/types.js";

test("a confirmed snapshot requires every real and mirrored reputation count, including explicit zeros", () => {
  const wallet = "0x" + "a".repeat(40), agent = { wallet, binding: { agentId: "2" } } as HostedAgent;
  const value: Extract<HostedFinance, { status: "confirmed" }> = { status: "confirmed", observedAt: "2026-10-11T00:00:00.000Z", chainId: "31337", agentId: "2", wallet,
    block: { number: 1, hash: "0x" + "b".repeat(64), timestamp: 1791676800 }, cashRaw: "40000", debtRaw: "0", scannedTaskCount: 0, ownedTaskCount: 0,
    credit: { score: "500", tier: "C", tierCapRaw: "200000", feeBps: "1500", eligible: true, rejection: null },
    policy: { maxCashPerTxRaw: "120000", maxDebtPerTxRaw: "120000", maxDebtPerDayRaw: "1000000", ownerFrozen: false },
    counts: { repayments: "0", defaults: "0", mirrorRepayments: "0", successes: "0", mirrorDefaults: "0" } };
  assert.deepEqual(validateHostedFinance(value, agent, "31337"), value);
  assert.throws(() => validateHostedFinance({ ...value, counts: {} }, agent, "31337"), /HOSTED_FINANCE_UNCONFIRMED/);
  for (const key of Object.keys(value.counts)) {
    const counts = { ...value.counts } as Record<string, string>; delete counts[key];
    assert.throws(() => validateHostedFinance({ ...value, counts }, agent, "31337"), /HOSTED_FINANCE_UNCONFIRMED/, key);
  }
});
