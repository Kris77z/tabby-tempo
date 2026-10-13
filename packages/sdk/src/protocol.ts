import { AbiCoder, Interface, keccak256, toUtf8Bytes } from "ethers";

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
export type RoutingTier = "cheap" | "strong";
export type ChatInput = Record<string, Json> & { agentId: string; taskId: string; service: string; model: string; messages: Json[]; tier?: RoutingTier };
export interface Quote {
  paymentId: string; agentId: string; taskId: string; requestDigest: string; serverNonce: string;
  service: string; model: string; price: string; payTo: string; asset: string; chainId: string;
  account: string; quoteExpiry: string; createdBlock: number; tier?: RoutingTier;
}
export interface PaymentProof { txHash: string; blockNumber: number; blockHash: string; timestamp: number; fromCash: string; fromCredit: string }
export interface InferenceReceipt extends PaymentProof {
  paymentId: string; agentId: string; taskId: string; requestDigest: string; service: string; price: string;
  asset: string; chainId: string; account: string; payTo: string; upstream: string; model: string; usage: Json; tier?: RoutingTier;
}
export const UINT256_MAX = (1n << 256n) - 1n;
export function uint(value: unknown, name: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(value) || BigInt(value) > UINT256_MAX) {
    throw new Error(`${name} must be a decimal uint256 string`);
  }
  return BigInt(value);
}
export function canonical(value: Json): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") { if (!Number.isFinite(value)) throw new Error("Nonfinite JSON number"); return JSON.stringify(value); }
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("Request must contain JSON values only");
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
}
export const requestDigest = (input: ChatInput) => keccak256(toUtf8Bytes(canonical(input)));
export const paymentId = (taskId: string, digest: string, nonce: string) => keccak256(
  AbiCoder.defaultAbiCoder().encode(["uint256", "bytes32", "bytes32"], [uint(taskId, "taskId"), digest, nonce]));
export const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
export const ACCOUNT_ABI = [
  "function settlementAsset() view returns(address)", "function creditManager() view returns(address)",
  "function adapter() view returns(address)", "function cash(uint256) view returns(uint256)",
  "function getPayment(bytes32) view returns(tuple(uint256 agentId,uint256 taskId,uint256 fromCash,uint256 fromCredit,uint256 refundedAmount))",
  "function payProvider(uint256,address,uint256,bytes32,tuple(uint256 agentId,uint256 taskId,uint256 principalCap,uint16 feeBps,uint8 riskTier,uint64 identityVersion,uint256 authDeadline,uint256 loanDueAt,uint256 nonce,bytes32 evidenceHash),bytes)",
  "function refundConsumed(bytes32) view returns(bool)",
  "event ProviderPaid(uint256 indexed agentId,address indexed provider,bytes32 indexed paymentId,uint256 fromCash,uint256 fromCredit)",
  "error SpendRejected(uint256 agentId,address target,uint8 reason)", "error NotAgentWallet(uint256 agentId,address caller)",
  "error PaymentIdAlreadyUsed(bytes32 paymentId)",
];
export const MANAGER_ABI = [
  "function agentAccount() view returns(address)", "function relayRefunder() view returns(address)",
  "function getLoan(uint256) view returns(tuple(uint256 agentId,uint256 principal,uint256 fee,uint256 loanDueAt,uint8 status))",
  "function processRefund(bytes32,uint256,bytes32) payable",
  "event RefundProcessed(bytes32 indexed paymentId,bytes32 indexed refundId,uint256 amount,uint256 debtReduced,uint256 toCash)",
  "error NonceAlreadyUsed(uint256 agentId,uint256 nonce)", "error LoanAlreadyExists(uint256 taskId)",
  "error IdentityChanged(uint256 agentId)", "error AuthExpired(uint256 authDeadline,uint256 nowTs)",
  "error BadSignature()", "error TaskDeadlinePassed(uint256 taskId,uint256 deadline)",
  "error IdentityVersionMismatch(uint256 agentId,uint64 actual,uint64 provided)", "error DrawPaused()",
];
export const accountInterface = new Interface(ACCOUNT_ABI);
export const managerInterface = new Interface(MANAGER_ABI);
export const EMPTY_AUTH = { agentId: 0, taskId: 0, principalCap: 0, feeBps: 0, riskTier: 0,
  identityVersion: 0, authDeadline: 0, loanDueAt: 0, nonce: 0, evidenceHash: "0x" + "00".repeat(32) };

export class PaymentError extends Error {
  constructor(public code: string, message: string, public handle?: unknown, public reason?: number) { super(message); }
}
export function contractError(error: unknown): PaymentError {
  const candidate = error as { data?: string; info?: { error?: { data?: string } } };
  const data = candidate?.data || candidate?.info?.error?.data;
  if (typeof data === "string") for (const iface of [accountInterface, managerInterface]) {
    try {
      const decoded = iface.parseError(data);
      if (decoded) return new PaymentError(decoded.name, decoded.name === "SpendRejected" ? `SpendRejected reason ${decoded.args.reason}` : decoded.name,
        undefined, decoded.name === "SpendRejected" ? Number(decoded.args.reason) : undefined);
    } catch { /* A different contract may own this selector. */ }
  }
  return new PaymentError("PAYMENT_UNCERTAIN", "Transaction outcome is uncertain; resume the same payment handle");
}
