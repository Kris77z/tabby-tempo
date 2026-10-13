import type { PaymentHandle } from "@agentfuel/sdk";
import type { PublicConfig } from "./types";
export const paymentStorageKey = (config: PublicConfig, agentId: string) => `infercredit:payment:v1:${config.chainId}:${config.contracts.account.toLowerCase()}:${agentId}`;
export function validateStoredPayment(value: unknown, config: PublicConfig, agentId: string): PaymentHandle {
  const handle = value as PaymentHandle;
  if (!handle || handle.version !== 1 || !handle.quote || !handle.input || handle.input.agentId !== agentId || handle.quote.agentId !== agentId ||
    handle.quote.chainId !== config.chainId || handle.quote.account.toLowerCase() !== config.contracts.account.toLowerCase() ||
    !config.providers.some(p => p.address.toLowerCase() === handle.quote.payTo.toLowerCase() && p.relayUrl && `${p.relayUrl.replace(/\/$/, "")}/v1/chat` === handle.relayUrl)) {
    throw new Error("本地付款记录与当前部署不一致；请核对旧 paymentId 后再付款。");
  }
  return handle;
}
