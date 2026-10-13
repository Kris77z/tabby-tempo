import { Contract, JsonRpcProvider, keccak256, toUtf8Bytes, verifyTypedData } from "ethers";
import { ESCROW_ABI, uintString, type ArenaConfig } from "./protocol.js";

export const SUBMISSION_TYPES = { Submission: [
  { name: "taskId", type: "uint256" }, { name: "agentId", type: "uint256" },
  { name: "codeHash", type: "bytes32" }, { name: "deadline", type: "uint256" },
] };
export interface Submission { taskId: string; code: string; deadline: string; signature: string }
export function submissionTypedData(config: ArenaConfig, input: Omit<Submission, "signature">, assignedAgentId?: string) {
  const binding = Object.hasOwn(config.tasks, input.taskId) ? config.tasks[input.taskId] : undefined;
  if (!binding) throw new Error("TASK_NOT_AUTHORIZED");
  const agentId = binding.agentId ?? assignedAgentId;
  if (agentId === undefined) throw new Error("TASK_AGENT_REQUIRED");
  uintString(agentId, "AGENT_ID");
  if (binding.agentId !== undefined && assignedAgentId !== undefined && binding.agentId !== assignedAgentId) throw new Error("TASK_AGENT_MISMATCH");
  return { domain: { name: "InferCreditArena", version: "1", chainId: config.chainId, verifyingContract: config.escrowAddress },
    types: SUBMISSION_TYPES, message: { taskId: input.taskId, agentId, codeHash: keccak256(toUtf8Bytes(input.code)), deadline: input.deadline } };
}
export async function authorizeSubmission(provider: JsonRpcProvider, config: ArenaConfig, input: Submission): Promise<void> {
  uintString(input.deadline, "DEADLINE");
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(config.chainId)) throw new Error("NETWORK_MISMATCH");
  const block = await provider.getBlock("latest");
  if (!block) throw new Error("BLOCK_UNAVAILABLE");
  const deadline = BigInt(input.deadline);
  if (deadline <= BigInt(block.timestamp) || deadline > BigInt(block.timestamp + 300)) throw new Error("SUBMISSION_DEADLINE_INVALID");
  const escrow = new Contract(config.escrowAddress, ESCROW_ABI, provider);
  const binding = config.tasks[input.taskId];
  if (!binding) throw new Error("TASK_NOT_AUTHORIZED");
  const options = { blockTag: block.number };
  const [task, adapterAddress] = await Promise.all([
    escrow.getFunction("getTask").staticCall(input.taskId, options),
    escrow.getFunction("adapter").staticCall(options),
  ]);
  if (task.status !== 2n) throw new Error("TASK_NOT_ASSIGNED");
  if (task.agentId === 0n || binding.agentId !== undefined && task.agentId !== BigInt(binding.agentId)) throw new Error("TASK_AGENT_MISMATCH");
  const adapter = new Contract(adapterAddress, ["function resolveAgent(uint256) view returns(address owner,address wallet)"], provider);
  const identity = await adapter.getFunction("resolveAgent").staticCall(task.agentId, options);
  const typed = submissionTypedData(config, input, String(task.agentId));
  let recovered: string;
  try { recovered = verifyTypedData(typed.domain, typed.types, typed.message, input.signature); }
  catch { throw new Error("SUBMISSION_SIGNATURE_INVALID"); }
  if (recovered.toLowerCase() !== identity.wallet.toLowerCase()) throw new Error("SUBMISSION_SIGNER_MISMATCH");
}
