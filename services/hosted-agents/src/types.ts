import type { GoalView } from "./goal-types.js";
/** Owner-controlled configuration, never wallet keys, RPCs, provider URLs or reward recipients. */
export type HostedStrategy = "conservative" | "balanced" | "aggressive";
export interface AgentSettings { name: string; modelId: string; strategy: HostedStrategy; perRunBudgetRaw: string; totalBudgetRaw: string; allowCredit: boolean }
/** Name-only creation defers all execution settings; full settings retain legacy request replay. */
export type AgentCreation = Pick<AgentSettings, "name"> | AgentSettings;
export interface HostedBinding { chainId: string; agentId: string; wallet: string }
export interface HostedAgent extends AgentSettings {
  id: string; owner: string; wallet: string; createdAt: string; updatedAt: string;
  status: "Pending" | "Ready" | "Paused"; binding?: HostedBinding;
  spentRaw: string; reservedRaw: string; activeRequestId?: string;
  /** Absent on legacy Agents whose settings were confirmed at creation. */
  configurationRequired?: boolean;
}
export type HostedAction = "provision" | "deposit" | "task" | "game" | "credits" | "reward-task" | "metered-task" | "autonomous" | "goal";
export interface HostedRun {
  testSponsorship?: { grantId: string; digest: string; ordinal: number };
  requestId: string; agentId: string; action: HostedAction; fundingFor?: string; rewardKind?: "usdc" | "llm-credits"; amountRaw?: string;
  goal?: string; mission?: GoalView; stopRequested?: boolean;
  status: "Queued" | "Running" | "Paused" | "Succeeded" | "Failed";
  createdAt: string; updatedAt: string; reservedRaw: string; chargedRaw: string; recoverable: boolean;
  reason?: string; result?: HostedResult;
  terminalRecovery?: { kind: "cached-planner"; at: string; rebasedChargedRaw: string; previousReason: string; previousResult: HostedResult };
}
/** Explicit public projection: adapters must not return private state; mission text is bounded and explicitly projected. */
export interface HostedResult {
  mission?: GoalView;
  autonomousTasks?: number;
  phase: string; terminal: boolean; success: boolean; chargedRaw: string; reason?: string;
  binding?: HostedBinding; taskId?: string; paymentId?: string; txHash?: string; matchId?: string;
  cashRaw?: string; principalRaw?: string; feeRaw?: string; rewardRaw?: string;
  creditsGranted?: number; creditsUsed?: number;
  chainId?: string; acceptTxHash?: string; paymentTxHash?: string;
  fromCashRaw?: string; fromCreditRaw?: string; refundedRaw?: string;
  settlement?: HostedSettlement;
}
export interface HostedBlock { number: number; hash: string; timestamp: number }
export interface HostedSettlement {
  txHash: string; block: HostedBlock; passed: boolean; loanStatus: string;
  repaidRaw: string; slashedRaw: string; residualRaw: string;
}
/** A checked, point-in-time projection for the selected hosted chain identity. */
export type HostedFinance = { status: "unavailable"; observedAt: string; reason: string } | {
  status: "confirmed"; observedAt: string; chainId: string; agentId: string; wallet: string; block: HostedBlock;
  cashRaw: string; debtRaw: string; scannedTaskCount: number; ownedTaskCount: number;
  credit: { score: string; tier: "A" | "B" | "C"; tierCapRaw: string; feeBps: string; eligible: boolean; rejection: string | null };
  policy: { maxCashPerTxRaw: string; maxDebtPerTxRaw: string; maxDebtPerDayRaw: string; ownerFrozen: boolean };
  counts: { repayments: string; defaults: string; mirrorRepayments: string; successes: string; mirrorDefaults: string };
};
export interface HostedExecution {
  progress?: (view: GoalView) => Promise<void>;
  deadlineMs?: number; agent: HostedAgent; run: HostedRun; directory: string; keyFile: string; recover: boolean;
}
export interface HostedCapabilities {
  goals?: { maxPhases: number; chainLookup?:{chainId:string;maxTargets:number}; specialists?:{id:string;serviceId:string;name:string;output:"text"|"json"}[]; models: { id: string; pricePerCallRaw: string }[] };
  inference?: { priceRaw: string; creditsRaw: string; models: { id: string; inputMicroCreditsPerToken: string; outputMicroCreditsPerToken: string }[] };
  autonomy?: { maxTasks: number; durationMs: number; plannerPriceRaw: string };
}
export interface HostedExecutor {
  capabilities?: HostedCapabilities;
  execute(input: HostedExecution): Promise<HostedResult>;
  finance?(agent: HostedAgent): Promise<HostedFinance>;
  /** Read-only proof that a specifically failed run can use its original paid response. */
  canRecoverTerminal?(input: HostedExecution): Promise<boolean>;
}
export interface HostedCatalogModel { id: string; label: string }
export interface HostedConfig {
  testSponsorshipFile?: string;
  directory: string; origin: string; chainId: "31337" | "10143" | "42431"; models: HostedCatalogModel[];
  maxAgentsPerOwner: number; maxTotalBudgetRaw: string; maxPerRunBudgetRaw: string;
}
export interface HostedSponsorship { used: number; limit: number; remaining: number; globalLimit: 100;
  testAuthorization?: { id: string; maxTotalGames: number; expiresAt: string; active: boolean; additionalUsed: number;
    actorRewards: { hostedAgentId: string; rewardKind: "usdc" | "llm-credits" }[] } }
export class HostedError extends Error { constructor(readonly code: string, readonly status = 400) { super(code); } }
