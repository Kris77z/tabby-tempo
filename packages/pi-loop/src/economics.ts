import { Transaction } from "ethers";
import { accountInterface, PaymentError, type PaymentHandle } from "@agentfuel/sdk";
/** Host-owned admission rules. Raw amounts all use the task settlement asset. */
export interface TaskEconomicsPolicy {
  version: 1; minNetRewardRaw: string; planningCostRaw: string; borrowerFeeBps: string;
  /** Omit for a fixed route's actual price. Packages use their full upfront price; subsidized tokens use zero. */
  executionCostRaw?: string;
}
export interface TaskRevenue { rewardRaw: string; escrowBalanceRaw: string; protocolFeeBps: string }
export interface TaskEconomics {
  basis: "successful-completion-bound"; scope: "settlement-asset-only";
  rewardRaw: string; protocolFeeRaw: string; netRevenueRaw: string; executionCostRaw: string; planningCostRaw: string;
  fromCashRaw: string; fromCreditRaw: string; borrowerFeeRaw: string; netRewardRaw: string;
  reason?: "ECONOMICS_REVENUE_UNKNOWN" | "ECONOMICS_ESCROW_UNFUNDED" | "ECONOMICS_NOT_WORTHWHILE";
}
const amount = (value: unknown): bigint => {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) >= 1n << 256n) throw new Error("INVALID_TASK_ECONOMICS");
  return BigInt(value);
};
export function validateTaskEconomicsPolicy(value: TaskEconomicsPolicy): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || value.version !== 1
    || Object.keys(value).some(key => !["version", "minNetRewardRaw", "planningCostRaw", "borrowerFeeBps", "executionCostRaw"].includes(key))) throw new Error("INVALID_TASK_ECONOMICS");
  amount(value.minNetRewardRaw); amount(value.planningCostRaw);
  if (amount(value.borrowerFeeBps) > 65535n) throw new Error("INVALID_TASK_ECONOMICS");
  if (value.executionCostRaw !== undefined) amount(value.executionCostRaw);
}
/** A successful-completion upper bound using conservative costs, never a probability-weighted expected return.
 * Chain fees (including PathUSD gas on Tempo) and subsidized token opportunity cost have no trusted conversion here and are outside this scope. */
export function assessTaskEconomics(policy: TaskEconomicsPolicy, revenue: TaskRevenue | undefined, routePriceRaw: string, cashRaw: string): TaskEconomics {
  validateTaskEconomicsPolicy(policy);
  const price = amount(policy.executionCostRaw ?? routePriceRaw), cash = amount(cashRaw), planning = amount(policy.planningCostRaw);
  const fromCash = cash < price ? cash : price, fromCredit = price - fromCash;
  const borrowerFee = fromCredit * amount(policy.borrowerFeeBps) / 10000n; // CreditManager.draw floors on actual principal.
  let reward = 0n, protocol = 0n, reason: TaskEconomics["reason"];
  if (!revenue) reason = "ECONOMICS_REVENUE_UNKNOWN";
  else {
    if (typeof revenue !== "object" || Array.isArray(revenue) || Object.keys(revenue).sort().join(",") !== "escrowBalanceRaw,protocolFeeBps,rewardRaw") throw new Error("INVALID_TASK_ECONOMICS");
    reward = amount(revenue.rewardRaw);
    const fee = amount(revenue.protocolFeeBps), escrow = amount(revenue.escrowBalanceRaw);
    if (fee > 10000n) throw new Error("INVALID_TASK_ECONOMICS");
    protocol = reward * fee / 10000n; // TaskEscrow settlement uses Solidity integer division.
    if (escrow < reward) reason = "ECONOMICS_ESCROW_UNFUNDED";
  }
  const netRevenue = reward - protocol, net = netRevenue - price - borrowerFee - planning;
  if (!reason && (reward === 0n || net < amount(policy.minNetRewardRaw))) reason = "ECONOMICS_NOT_WORTHWHILE";
  return { basis: "successful-completion-bound", scope: "settlement-asset-only", rewardRaw: reward.toString(), protocolFeeRaw: protocol.toString(), netRevenueRaw: netRevenue.toString(),
    executionCostRaw: price.toString(), planningCostRaw: planning.toString(), fromCashRaw: fromCash.toString(), fromCreditRaw: fromCredit.toString(), borrowerFeeRaw: borrowerFee.toString(), netRewardRaw: net.toString(), ...(reason ? { reason } : {}) };
}
export const hostedTaskEconomics = (planningCostRaw = "0", executionCostRaw?: string): TaskEconomicsPolicy => ({ version: 1, minNetRewardRaw: "1", planningCostRaw,
  borrowerFeeBps: "1500", ...(executionCostRaw === undefined ? {} : { executionCostRaw }) });

/** Runs in the SDK durable-handle callback before broadcast. A changed signed credit fee cannot escape the bound. */
export function assertEconomicPayment(policy: TaskEconomicsPolicy, handle: PaymentHandle): void {
  validateTaskEconomicsPolicy(policy);
  if (policy.executionCostRaw !== undefined && handle.quote.price !== policy.executionCostRaw) throw new PaymentError("ECONOMICS_EXECUTION_PRICE_CHANGED", "Execution quote exceeded the saved economic price");
  const raw = handle.submission?.rawTransaction;
  if (!raw) {
    if (handle.submission) throw new PaymentError("ECONOMICS_SIGNED_AUTH_REQUIRED", "Economic admission requires inspectable signed payment bytes before broadcast");
    return;
  }
  if (/^0x76/i.test(raw)) throw new PaymentError("ECONOMICS_SIGNED_TRANSACTION_UNSUPPORTED", "Tempo type0x76 economic inspection is not supported");
  let signed: Transaction;
  try { signed = Transaction.from(raw); } catch { throw new PaymentError("ECONOMICS_SIGNED_TRANSACTION_UNSUPPORTED", "Economic admission requires a supported signed transaction"); }
  const call = accountInterface.parseTransaction({ data: signed.data, value: signed.value });
  if (!call || call.name !== "payProvider" || call.args[2] !== BigInt(handle.quote.price)
    || call.args[4].feeBps > BigInt(policy.borrowerFeeBps)) throw new PaymentError("ECONOMICS_BORROWER_FEE_CHANGED", "Signed borrowing fee exceeded the saved economic bound");
}
