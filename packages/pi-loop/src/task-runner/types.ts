import type { ProblemId } from "@agentfuel/arena";

export class TaskRunnerError extends Error {
  constructor(readonly code: string, readonly status = 400) { super(code); }
}
export const TASK_REQUEST_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function taskRequestId(value: unknown): string {
  if (typeof value !== "string" || !TASK_REQUEST_ID.test(value)) throw new TaskRunnerError("TASK_REQUEST_ID_REQUIRED");
  return value;
}
export type TaskRunnerCommand = { action: "start"; requestId: string; profileId: string } | { action: "recover"; requestId: string };
export function parseTaskRunnerCommand(value: unknown): TaskRunnerCommand {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TaskRunnerError("TASK_COMMAND_INVALID");
  const item = value as Record<string, unknown>, requestId = taskRequestId(item.requestId);
  if (item.action === "start" && Object.keys(item).sort().join(",") === "action,profileId,requestId" &&
    typeof item.profileId === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(item.profileId)) return { action: "start", requestId, profileId: item.profileId };
  if (item.action === "recover" && Object.keys(item).sort().join(",") === "action,requestId") return { action: "recover", requestId };
  throw new TaskRunnerError("TASK_COMMAND_INVALID");
}
export type TaskWorkflowPhase = "Selected" | "AcceptPending" | "Running" | "Succeeded" | "Failed" | "Refunded" | "Stopped" | "Paused" | "SubmissionPending" | "RefundPending";
export interface TaskWorkflowView {
  version: 1; phase: TaskWorkflowPhase; reason?: string; deadlineMs: number; reservedPrice: string;
  choice?: { taskId: string; problemId: ProblemId; providerId: string; tier: "cheap" | "strong"; price: string; funding: "cash" | "task-credit" | "reward-tokens" | "inference-allowance" };
  acceptTxHash?: string; paymentId?: string; childPhase?: string;
  tools?: { rounds: number; attempts: number; passed: number };
  finance?: { taskStatus: string; loanStatus: string; principal: string; fee: string; fromCash?: string; fromCredit?: string; repaid?: string; slashed?: string; residual?: string };
}
/** The entire browser contract. Config, wallet secrets, signatures, code and URLs never appear here. */
export interface TaskRunnerRun {
  requestId: string; profileId: string; status: "Queued" | "Running" | "Paused" | "Succeeded" | "Failed" | "Refunded" | "Stopped";
  createdAt: string; updatedAt: string; recoverable: boolean; reason?: string; workflow?: TaskWorkflowView;
}
export interface TaskRunnerProfile { profileId: string; label: string; chainId: string; agentId: string; problemIds: ProblemId[] }
export interface TaskRunnerSnapshot { enabled: true; profiles: TaskRunnerProfile[]; runs: TaskRunnerRun[]; run?: TaskRunnerRun }
const phases: TaskWorkflowPhase[] = ["Selected", "AcceptPending", "Running", "Succeeded", "Failed", "Refunded", "Stopped", "Paused", "SubmissionPending", "RefundPending"];
const problems = ["sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"];
function record(value: unknown, fields: string[]): Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new TaskRunnerError("TASK_PUBLIC_SNAPSHOT_INVALID", 502);
  return value as Record<string, any>;
}
function requireValue(condition: boolean): asserts condition { if (!condition) throw new TaskRunnerError("TASK_PUBLIC_SNAPSHOT_INVALID", 502); }
function reason(value: unknown) { if (value !== undefined) requireValue(typeof value === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value)); }
function amount(value: unknown): boolean { return typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value); }
function hex(value: unknown): boolean { return typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value); }
function timestamp(value: unknown): boolean { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value) && Number.isFinite(Date.parse(value)); }
export function parseTaskWorkflowView(value: unknown): TaskWorkflowView {
  const item = record(value, ["version", "phase", "reason", "deadlineMs", "reservedPrice", "choice", "acceptTxHash", "paymentId", "childPhase", "tools", "finance"]);
  requireValue(item.version === 1 && phases.includes(item.phase) && Number.isSafeInteger(item.deadlineMs) && item.deadlineMs >= 0 && amount(item.reservedPrice)); reason(item.reason);
  if (item.acceptTxHash !== undefined) requireValue(hex(item.acceptTxHash));
  if (item.paymentId !== undefined) requireValue(hex(item.paymentId));
  if (item.childPhase !== undefined) requireValue(["Purchasing", "ReadyToSubmit", "SubmissionPending", "Succeeded", "Failed", "Paused", "Stopped", "RefundPending", "Refunded"].includes(item.childPhase));
  if (item.choice !== undefined) {
    const choice = record(item.choice, ["taskId", "problemId", "providerId", "tier", "price", "funding"]);
    requireValue(amount(choice.taskId) && choice.taskId !== "0" && problems.includes(choice.problemId) && typeof choice.providerId === "string" && /^[a-zA-Z0-9_-]{1,64}$/.test(choice.providerId) &&
      ["cheap", "strong"].includes(choice.tier) && amount(choice.price) && ["cash", "task-credit"].includes(choice.funding));
  }
  if (item.tools !== undefined) {
    const tools = record(item.tools, ["rounds", "attempts", "passed"]);
    requireValue(Number.isSafeInteger(tools.rounds) && tools.rounds >= 0 && tools.rounds <= 3 && Number.isSafeInteger(tools.attempts) && tools.attempts >= 0 && tools.attempts <= 4 && Number.isSafeInteger(tools.passed) && tools.passed >= 0 && tools.passed <= tools.attempts);
  }
  if (item.finance !== undefined) {
    const finance = record(item.finance, ["taskStatus", "loanStatus", "principal", "fee", "fromCash", "fromCredit", "repaid", "slashed", "residual"]);
    requireValue(["taskStatus", "loanStatus", "principal", "fee"].every(key => amount(finance[key])) && Object.values(finance).every(amount));
  }
  return structuredClone(item) as TaskWorkflowView;
}
export function parseTaskRunnerSnapshot(value: unknown): TaskRunnerSnapshot {
  const item = record(value, ["enabled", "profiles", "runs", "run"]);
  requireValue(item.enabled === true && Array.isArray(item.profiles) && item.profiles.length <= 16 && Array.isArray(item.runs) && item.runs.length <= 20);
  const profiles = item.profiles.map((raw: unknown) => {
    const profile = record(raw, ["profileId", "label", "chainId", "agentId", "problemIds"]);
    requireValue(typeof profile.profileId === "string" && /^[a-z0-9][a-z0-9_-]{0,63}$/.test(profile.profileId) && typeof profile.label === "string" && profile.label.length > 0 && profile.label.length <= 80 &&
      ["31337", "10143", "42431"].includes(profile.chainId) && amount(profile.agentId) && profile.agentId !== "0" && Array.isArray(profile.problemIds) && profile.problemIds.length <= 4 && profile.problemIds.every((id: unknown) => typeof id === "string" && problems.includes(id)));
    return structuredClone(profile) as TaskRunnerProfile;
  });
  const run = (raw: unknown): TaskRunnerRun => {
    const entry = record(raw, ["requestId", "profileId", "status", "createdAt", "updatedAt", "recoverable", "reason", "workflow"]);
    requireValue(typeof entry.requestId === "string" && TASK_REQUEST_ID.test(entry.requestId) && typeof entry.profileId === "string" && profiles.some(profile => profile.profileId === entry.profileId) &&
      ["Queued", "Running", "Paused", "Succeeded", "Failed", "Refunded", "Stopped"].includes(entry.status) && timestamp(entry.createdAt) && timestamp(entry.updatedAt) && typeof entry.recoverable === "boolean");
    reason(entry.reason);
    return structuredClone({ ...entry, ...(entry.workflow === undefined ? {} : { workflow: parseTaskWorkflowView(entry.workflow) }) }) as TaskRunnerRun;
  };
  return { enabled: true, profiles, runs: item.runs.map(run), ...(item.run === undefined ? {} : { run: run(item.run) }) };
}
