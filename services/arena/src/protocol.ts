import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { getAddress } from "ethers";
import { isProblemId, type ProblemId } from "./problems.js";

export const ESCROW_ABI = [
  "function verifier() view returns(address)",
  "function adapter() view returns(address)",
  "function feedbackSent(uint256,uint8) view returns(bool)",
  "function pendingFeedback(uint256,uint8) view returns(bool)",
  "function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))",
  "function settle(uint256 taskId,bool passed)",
  "event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)",
];
/** Omit agentId for an operator-approved task catalog; the Assigned chain task supplies its actual Agent. */
export interface TaskBinding { agentId?: string; problemId: ProblemId }
export interface ArenaConfig {
  rpcUrl: string; chainId: string; escrowAddress: string;
  tasks: Record<string, TaskBinding>; ipcDirectory: string; allowManual?: boolean; settlementTimeoutMs?: number;
}
export interface Verdict {
  version: 1; runId: string; chainId: string; escrowAddress: string; taskId: string;
  agentId: string; problemId: ProblemId; passed: boolean;
  mode: "docker" | "manual"; evidenceHash: string;
}
export interface Settlement { taskId: string; runId: string; passed: boolean; txHash: string; blockNumber: number; feedback: Array<{ type: number; sent: boolean; pending: boolean }> }
export const digest = (value: string) => createHash("sha256").update(value).digest("hex");
export function settlementTimeout(value: unknown = 30000): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 50 || value > 300000) throw new Error("INVALID_SETTLEMENT_TIMEOUT");
  return value;
}
export function uintString(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value) || BigInt(value) >= 2n ** 256n) throw new Error(`INVALID_${name}`);
  return value;
}
export function parseConfig(value: unknown): ArenaConfig {
  const c = value as ArenaConfig;
  if (!c || typeof c !== "object" || typeof c.rpcUrl !== "string" || !/^https?:\/\//.test(c.rpcUrl)) throw new Error("INVALID_RPC_URL");
  uintString(c.chainId, "CHAIN_ID");
  if (c.chainId === "0") throw new Error("INVALID_CHAIN_ID");
  c.escrowAddress = getAddress(c.escrowAddress);
  if (typeof c.ipcDirectory !== "string" || !c.ipcDirectory.startsWith("/")) throw new Error("ABSOLUTE_IPC_DIRECTORY_REQUIRED");
  // Keep Unix socket paths below the macOS sockaddr_un limit.
  if (join(c.ipcDirectory, "settler.sock").length > 100) throw new Error("IPC_PATH_TOO_LONG");
  if (!c.tasks || typeof c.tasks !== "object" || Array.isArray(c.tasks) || Object.keys(c.tasks).length === 0) throw new Error("EXPLICIT_TASKS_REQUIRED");
  for (const [id, binding] of Object.entries(c.tasks)) {
    uintString(id, "TASK_ID");
    if (id === "0" || !binding || typeof binding !== "object") throw new Error("INVALID_TASK_BINDING");
    if (binding.agentId !== undefined) uintString(binding.agentId, "AGENT_ID");
    if (!isProblemId(binding.problemId)) throw new Error("INVALID_TASK_BINDING");
  }
  if (c.allowManual !== undefined && typeof c.allowManual !== "boolean") throw new Error("INVALID_MANUAL_POLICY");
  settlementTimeout(c.settlementTimeoutMs);
  return c;
}
export async function loadArenaConfig(path: string): Promise<ArenaConfig> { return parseConfig(JSON.parse(await readFile(path, "utf8"))); }
export function validateVerdict(value: unknown, config: ArenaConfig): Verdict {
  const v = value as Verdict;
  if (!v || typeof v !== "object" || v.version !== 1 || typeof v.runId !== "string" || !/^[a-f0-9-]{36}$/.test(v.runId)) throw new Error("INVALID_VERDICT");
  uintString(v.taskId, "TASK_ID");
  if (v.chainId !== config.chainId || getAddress(v.escrowAddress) !== config.escrowAddress) throw new Error("DOMAIN_MISMATCH");
  const binding = Object.hasOwn(config.tasks, v.taskId) ? config.tasks[v.taskId] : undefined;
  uintString(v.agentId, "AGENT_ID");
  if (!binding || (binding.agentId !== undefined ? v.agentId !== binding.agentId : v.agentId === "0") || v.problemId !== binding.problemId) throw new Error("TASK_NOT_AUTHORIZED");
  if (typeof v.passed !== "boolean" || !["docker", "manual"].includes(v.mode) || !/^[a-f0-9]{64}$/.test(v.evidenceHash)) throw new Error("INVALID_VERDICT");
  if (v.mode === "manual" && !config.allowManual) throw new Error("MANUAL_DISABLED");
  return v;
}
export async function atomicJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, JSON.stringify(value) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally { await rm(temporary, { force: true }); }
}
export async function privateDirectory(path: string): Promise<string> {
  const absolute = resolve(path);
  await mkdir(absolute, { recursive: true, mode: 0o700 });
  await chmod(absolute, 0o700);
  return absolute;
}
