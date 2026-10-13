import type { Dashboard, EvidenceRow, Profile, TaskRow } from "./types";
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
const hash = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const contracts = { manager: addr(101), adapter: addr(102), account: addr(103), escrow: addr(104) };
export function fixtureDashboard(): Dashboard {
  const now = 1_790_828_000;
  const agents = [{ id: "1842", name: "Atlas · Research" }, { id: "2107", name: "Helix · Code" }, { id: "3091", name: "Delta · Monitor" }];
  const config = { chainId: "31337", network: "本地视觉演示", explorerUrl: "", asset: { address: addr(201), symbol: "USDC", decimals: 6 },
    contracts, agents, providers: [{ name: "Qwen", address: addr(301), service: "infercredit/coder", model: "coder", allowed: true }, { name: "Kimi", address: addr(302), service: "infercredit/coder", model: "coder", allowed: true }] };
  const profiles: Profile[] = agents.map((agent, i): Profile => {
    const rep = [2, 3, 1][i], defaults = i === 2 ? 1 : 0, tier = i === 1 ? "A" : i === 2 ? "C" : "B";
    const task: TaskRow = { id: String(21 + i), poster: addr(401), reward: "200000", escrowBalance: i === 0 ? "200000" : "0", netEscrow: "190000",
      agentId: agent.id, deadline: String(now + 86_400), protocolFeeBps: "500", status: i === 0 ? 2 : i === 1 ? 3 : 4,
      loan: { principal: i === 0 ? "80000" : "0", fee: i === 0 ? "6400" : "0", dueAt: String(now + 3_600), status: i === 0 ? 1 : i === 1 ? 2 : 3 },
      feedback: { successSent: i === 1, repaymentSent: i === 1, successPending: false, repaymentPending: false, defaultPending: false } };
    return { agent, cash: ["40000", "273600", "0"][i], debt: i === 0 ? "86400" : "0",
      credit: { agentId: agent.id, identity: { owner: addr(501 + i), wallet: addr(601 + i), version: "1", changed: i === 2 },
        truth: { repayment: String(rep), default: String(defaults) }, mirror: { repayment: String(rep), success: String(rep), default: String(defaults) },
        terms: { score: String(500 + 70 * rep - 400 * defaults), tier, riskTier: i === 1 ? 1 : i === 2 ? 3 : 2,
          feeBps: i === 1 ? "300" : i === 2 ? "1500" : "800", capUsdCents: i === 1 ? "200" : i === 2 ? "20" : "50" },
        managerFrozen: i === 2, accountFrozen: i === 2, drawPaused: false, eligible: i !== 2, rejection: i === 2 ? "PROTOCOL_DEFAULT" : null,
        tierCap: i === 1 ? "2000000" : i === 2 ? "200000" : "500000", block: { number: 12842, hash: hash(12842), timestamp: now },
        configuration: { chainId: "31337", settlementAsset: config.asset.address, assetDecimals: "6", tokenUsdPrice: "1000000000000000000", underwriter: addr(701), ltvBps: "7000", maxTotalOutstanding: "50000000", maxDrawPerEpoch: "20000000" },
        addresses: { ...contracts, identity: addr(801), reputation: addr(802) } },
      policy: { maxCashPerTx: "1000000", maxDebtPerTx: "1000000", maxDebtPerDay: "2000000", ownerFrozen: false }, tasks: [task],
      counts: { payments: rep + (i === 0 ? 1 : 0), draws: rep + (i === 0 ? 1 : 0), defaults },
      evidence: [{ hash: hash(900 + i), block: 12841, kind: "payment", taskId: task.id, paymentId: hash(1000 + i), provider: config.providers[0].address,
        fromCash: "40000", fromCredit: "80000", evidenceHash: hash(1100 + i), receiptStatus: 1,
        events: [{ contract: "AgentAccount", name: "ProviderPaid", values: { agentId: agent.id, fromCash: "40000", fromCredit: "80000" } },
          { contract: "CreditManager", name: "LoanOpened", values: { taskId: task.id, amount: "80000", tier: tier } }] },
      ...(i === 1 ? [{ hash: hash(910), block: 12842, kind: "settlement" as const, taskId: task.id, passed: true, receiptStatus: 1,
        events: [{ contract: "CreditManager", name: "LoanRepaid", values: { principal: "80000", fee: "6400" } },
          { contract: "TaskEscrow", name: "FeedbackSent", values: { taskId: task.id, feedbackType: "2" } }] } satisfies EvidenceRow] : [])] };
  });
  return { mode: "fixture", configured: true, config, profiles, openTasks: [{ ...profiles[0].tasks[0], id: "24", agentId: "0", status: 1,
    loan: { principal: "0", fee: "0", dueAt: "0", status: 0 } }], updatedAt: new Date(now * 1000).toISOString(), history: { fromBlock: 12000, toBlock: 12842 } };
}
