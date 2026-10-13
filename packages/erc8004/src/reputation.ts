import { Contract, getAddress, ZeroHash, type Signer, type TransactionReceipt } from "ethers";
import { assertNetwork, assertTransactionSigner, registryOptions, uint, type RegistryOptions } from "./identity.js";

export const REPUTATION_ABI = [
  "event NewFeedback(uint256 indexed agentId,address indexed clientAddress,uint64 feedbackIndex,int128 value,uint8 valueDecimals,string indexed indexedTag1,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
  "function getIdentityRegistry() view returns(address)",
  "function getSummary(uint256 agentId,address[] clientAddresses,string tag1,string tag2) view returns(uint64 count,int128 summaryValue,uint8 summaryValueDecimals)",
  "function readFeedback(uint256 agentId,address clientAddress,uint64 feedbackIndex) view returns(int128 value,uint8 valueDecimals,string tag1,string tag2,bool isRevoked)",
  "function giveFeedback(uint256 agentId,int128 value,uint8 valueDecimals,string tag1,string tag2,string endpoint,string feedbackURI,bytes32 feedbackHash)",
  "function revokeFeedback(uint256 agentId,uint64 feedbackIndex)",
];
export interface Summary { count: bigint; summaryValue: bigint; summaryValueDecimals: bigint }
export interface Feedback { value: bigint; valueDecimals: bigint; tag1: string; tag2: string; revoked: boolean }
export interface FeedbackInput {
  agentId: bigint; value: bigint; valueDecimals: number; tag1: string; tag2: string;
  endpoint?: string; feedbackURI?: string; feedbackHash?: string;
}
export function clientFilter(clients: readonly string[]): string[] {
  if (!Array.isArray(clients) || clients.length === 0) throw new Error("NONEMPTY_CLIENT_FILTER_REQUIRED");
  const normalized = clients.map(client => getAddress(client));
  if (new Set(normalized).size !== normalized.length) throw new Error("DUPLICATE_CLIENT_FILTER");
  return normalized;
}
export class ReputationRegistry {
  readonly options: RegistryOptions;
  private readonly contract: Contract;
  constructor(options: RegistryOptions) {
    this.options = registryOptions(options);
    this.contract = new Contract(this.options.address, REPUTATION_ABI, this.options.provider);
  }
  async readSummary(agentId: bigint, clients: readonly string[], tag1: string, tag2: string): Promise<Summary> {
    uint(agentId, "AGENT_ID"); const filter = clientFilter(clients); await assertNetwork(this.options);
    const summary = await this.contract.getFunction("getSummary").staticCall(agentId, filter, tag1, tag2);
    // Preserve the registry-defined signed aggregate; never infer sum/mean.
    return { count: BigInt(summary.count), summaryValue: BigInt(summary.summaryValue), summaryValueDecimals: BigInt(summary.summaryValueDecimals) };
  }
  async readFeedback(agentId: bigint, client: string, feedbackIndex: bigint): Promise<Feedback> {
    uint(agentId, "AGENT_ID"); uint(feedbackIndex, "FEEDBACK_INDEX", 64);
    if (feedbackIndex === 0n) throw new Error("FEEDBACK_INDEX_MUST_BE_POSITIVE");
    const address = getAddress(client); await assertNetwork(this.options);
    const feedback = await this.contract.getFunction("readFeedback").staticCall(agentId, address, feedbackIndex);
    return { value: BigInt(feedback.value), valueDecimals: BigInt(feedback.valueDecimals), tag1: feedback.tag1, tag2: feedback.tag2, revoked: Boolean(feedback.isRevoked) };
  }
  async giveFeedback(clientSigner: Signer, input: FeedbackInput): Promise<TransactionReceipt> {
    uint(input.agentId, "AGENT_ID");
    if (typeof input.value !== "bigint" || input.value < -(10n ** 38n) || input.value > 10n ** 38n) throw new Error("INVALID_FEEDBACK_VALUE");
    if (!Number.isInteger(input.valueDecimals) || input.valueDecimals < 0 || input.valueDecimals > 18) throw new Error("INVALID_VALUE_DECIMALS");
    await assertTransactionSigner(clientSigner, this.options);
    const receipt = await (await this.contract.connect(clientSigner).getFunction("giveFeedback")(input.agentId, input.value, input.valueDecimals,
      input.tag1, input.tag2, input.endpoint ?? "", input.feedbackURI ?? "", input.feedbackHash ?? ZeroHash)).wait();
    if (!receipt || receipt.status !== 1) throw new Error("FEEDBACK_TRANSACTION_FAILED");
    return receipt;
  }
  async revokeFeedback(clientSigner: Signer, agentId: bigint, feedbackIndex: bigint): Promise<TransactionReceipt> {
    uint(agentId, "AGENT_ID"); uint(feedbackIndex, "FEEDBACK_INDEX", 64);
    if (feedbackIndex === 0n) throw new Error("FEEDBACK_INDEX_MUST_BE_POSITIVE");
    await assertTransactionSigner(clientSigner, this.options);
    const receipt = await (await this.contract.connect(clientSigner).getFunction("revokeFeedback")(agentId, feedbackIndex)).wait();
    if (!receipt || receipt.status !== 1) throw new Error("FEEDBACK_REVOKE_FAILED");
    return receipt;
  }
}
