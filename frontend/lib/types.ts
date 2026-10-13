export type Contracts = { manager: string; adapter: string; account: string; escrow: string };
export type AgentIdentity = { id: string; name: string };
export type ProviderEntry = { name: string; address: string; relayUrl?: string; service?: string; model?: string; allowed?: boolean };
export type PublicConfig = {
  chainId: string; network: string; explorerUrl: string;
  asset: { address: string; symbol: string; decimals: number };
  contracts: Contracts; agents: AgentIdentity[]; providers: ProviderEntry[]; arenaUrl?: string; underwriterUrl?: string;
};
export type Deployment = PublicConfig & { rpcUrl: string; deploymentBlock: number; underwriterUrl: string };
export type CreditSnapshot = {
  agentId: string;
  identity: { owner: string; wallet: string; version: string; changed: boolean };
  truth: { repayment: string; default: string };
  mirror: { repayment: string; success: string; default: string };
  terms: { score: string; tier: "A" | "B" | "C"; riskTier: number; feeBps: string; capUsdCents: string };
  managerFrozen: boolean; accountFrozen: boolean; drawPaused: boolean; eligible: boolean; rejection: string | null;
  tierCap: string;
  block: { number: number; hash: string; timestamp: number };
  configuration: { chainId: string; settlementAsset: string; assetDecimals: string; tokenUsdPrice: string;
    underwriter: string; ltvBps: string; maxTotalOutstanding: string; maxDrawPerEpoch: string };
  addresses: Contracts & { identity: string; reputation: string };
};
export type TaskRow = {
  id: string; poster: string; reward: string; escrowBalance: string; netEscrow: string; agentId: string;
  deadline: string; protocolFeeBps: string; status: number;
  loan: { principal: string; fee: string; dueAt: string; status: number };
  feedback: { successSent: boolean; repaymentSent: boolean; successPending: boolean; repaymentPending: boolean; defaultPending: boolean };
};
export type EventDetail = { contract: string; name: string; values: Record<string, string> };
export type EvidenceRow = {
  hash: string; block: number; kind: "payment" | "settlement" | "task" | "default";
  taskId?: string; paymentId?: string; provider?: string; fromCash?: string; fromCredit?: string;
  passed?: boolean; evidenceHash?: string; receiptStatus: number; events: EventDetail[];
};
export type VerifiedRejectionEvidence = {
  verified: true; chainId: string; account: string; agentId: string; from: string; payee: string; amount: string;
  hash: string; block: number; status: 0; logCount: 0; revertData: string;
};
export type Profile = {
  agent: AgentIdentity; credit: CreditSnapshot; cash: string; debt: string;
  policy: { maxCashPerTx: string; maxDebtPerTx: string; maxDebtPerDay: string; ownerFrozen: boolean };
  tasks: TaskRow[]; evidence: EvidenceRow[];
  counts: { payments: number; draws: number; defaults: number };
};
export type Dashboard = {
  mode: "chain" | "fixture"; configured: boolean; message?: string; config?: PublicConfig;
  readStatus?: "loading" | "confirmed" | "unavailable";
  profiles: Profile[]; openTasks: TaskRow[]; updatedAt: string;
  history?: { fromBlock: number; toBlock: number; recent?: boolean };
};
export const TASK_STATUS = ["None", "Open", "Assigned", "Settled", "Failed", "Cancelled"];
export const LOAN_STATUS = ["None", "Active", "Repaid", "Defaulted", "ClosedByRefund"];
