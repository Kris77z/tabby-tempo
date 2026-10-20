import { InferCredit, PaymentError, type InferOptions, type PaymentHandle, type Inference } from "@agentfuel/sdk";
import { paymentId, requestDigest, type ChatInput, type Quote } from "@agentfuel/sdk/protocol";
import type { Signer } from "ethers";

// Compiled by the external consumer: both package subpaths must resolve declarations, not source files.
export async function consume(signer: Signer, saved: PaymentHandle, save: (handle: PaymentHandle) => Promise<void>) {
  const options: InferOptions = { signer, agentId: "1", chainId: 31337n,
    account: `0x${"11".repeat(20)}`, asset: `0x${"22".repeat(20)}`, provider: `0x${"33".repeat(20)}`,
    maxPrice: 10000n, onHandle: save };
  const input: ChatInput = { agentId: "1", taskId: "0", service: "infercredit/coder", model: "coder", messages: [] };
  const digest: string = requestDigest(input);
  const id: string = paymentId("0", digest, `0x${"55".repeat(32)}`);
  const quote: Quote = saved.quote;
  const client = new InferCredit(options);
  try {
    const resumed: Inference = await client.resume(saved);
    return { resumed, id, quote };
  } catch (error) {
    if (error instanceof PaymentError) return { code: error.code, handle: error.handle };
    throw error;
  } finally { client.close(); }
}

// @ts-expect-error maxPrice uses raw bigint units, not a display string.
const invalidPrice: InferOptions["maxPrice"] = "0.01";
void invalidPrice;
