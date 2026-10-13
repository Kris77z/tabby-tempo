import { setTimeout as delay } from "node:timers/promises";
import { Interface, type JsonRpcProvider, type Signer } from "ethers";
import { PaymentError, type Json } from "@agentfuel/sdk";
import { submissionTypedData, type Submission } from "@agentfuel/arena/submission-auth";
import type { ProblemId } from "@agentfuel/arena";
import { publicSampleFor } from "./public-sample.js";

export interface SubmissionConfig { taskId: string; agentId: string; rpcUrl: string; chainId: string; escrowAddress: string; arenaUrl: string; deadlineMs: number }
export interface SubmissionState { phase: string; reason?: string; candidate?: string; submission?: { payload: Submission; runId?: string; result?: Json } }
export interface SubmissionOptions { rpc: JsonRpcProvider; signer: Signer; save: () => Promise<void>; timeoutMs?: number; pollTimeoutMs?: number }
const escrowInterface = new Interface(["event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)"]);
function stop(code: string): never { throw new PaymentError(code, code); }
/** Shared host-only final submission. Callers must durably qualify candidate before entering. */
export async function submitProgrammingCandidate(state: SubmissionState, config: SubmissionConfig, options: SubmissionOptions, problemId: ProblemId = "sum-integers") {
  publicSampleFor(problemId);
  const { rpc, save } = options;
  const assertTime = () => { if (Date.now() >= config.deadlineMs) stop("SESSION_DEADLINE"); };
  if (await rpc.send("eth_chainId", []) !== `0x${BigInt(config.chainId).toString(16)}`) stop("NETWORK_MISMATCH");
  if (!state.submission) {
    assertTime(); if (!state.candidate) stop("PUBLIC_SAMPLE_REQUIRED");
    const block = (await rpc.getBlock("latest"))!;
    const seconds = Math.min(300, Math.floor((config.deadlineMs - Date.now()) / 1000)); if (seconds <= 0) stop("SESSION_DEADLINE");
    const payload: Submission = { taskId: config.taskId, code: state.candidate, deadline: String(block.timestamp + seconds), signature: "" };
    const typed = submissionTypedData({ rpcUrl: config.rpcUrl, chainId: config.chainId, escrowAddress: config.escrowAddress, ipcDirectory: "/unused", tasks: { [config.taskId]: { agentId: config.agentId, problemId } } }, payload);
    assertTime(); payload.signature = await options.signer.signTypedData(typed.domain, typed.types, typed.message);
    state.submission = { payload }; state.phase = "SubmissionPending"; await save();
  }
  const submission = state.submission;
  if (!submission.runId) {
    assertTime(); // After a lost HTTP response only the exact saved signature/payload may be replayed, before this deadline.
    try {
      const response = await fetch(config.arenaUrl.replace(/\/$/, "") + "/submissions", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(submission.payload), signal: AbortSignal.timeout(options.timeoutMs ?? 10000) });
      const body = await response.json() as { runId?: string; error?: string };
      if (!response.ok || !body.runId) {
        const rejected = response.status >= 400 && response.status < 500 && response.status !== 409 && response.status !== 429;
        // An HTTP rejection is not a final task/loan outcome. Keep the original paid candidate and signature recoverable.
        state.phase = "SubmissionPending";
        state.reason = rejected ? "ARENA_SUBMISSION_REJECTED" : response.status === 409 ? "SUBMISSION_CONFLICT_UNCERTAIN" : "SUBMISSION_UNCERTAIN";
        await save(); return;
      }
      submission.runId = body.runId; await save();
    } catch { state.reason = "SUBMISSION_UNCERTAIN"; await save(); return; }
  }
  const until = Date.now() + (options.pollTimeoutMs ?? 30000);
  do {
    try {
      const response = await fetch(config.arenaUrl.replace(/\/$/, "") + "/runs/" + encodeURIComponent(submission.runId), { signal: AbortSignal.timeout(options.timeoutMs ?? 10000) });
      const run = await response.json() as { status?: string; result?: Json };
      if (!response.ok) { state.reason = "ARENA_RUN_UNAVAILABLE"; await save(); return; }
      if (run.status === "error") { state.phase = "SubmissionPending"; state.reason = "ARENA_SETTLEMENT_UNCERTAIN"; await save(); return; }
      if (run.status === "settled") {
        const result = run.result as { verdict?: { taskId?: string; agentId?: string; runId?: string; passed?: boolean; mode?: string; chainId?: string; escrowAddress?: string; problemId?: string }; settlement?: { taskId?: string; runId?: string; passed?: boolean; txHash?: string } };
        const verdict = result?.verdict, settlement = result?.settlement;
        if (!verdict || !settlement || verdict.taskId !== config.taskId || verdict.agentId !== config.agentId || verdict.runId !== submission.runId || verdict.mode !== "docker" || typeof verdict.passed !== "boolean" || verdict.chainId !== config.chainId || verdict.escrowAddress?.toLowerCase() !== config.escrowAddress.toLowerCase() || verdict.problemId !== problemId || settlement.taskId !== config.taskId || settlement.runId !== submission.runId || settlement.passed !== verdict.passed || !settlement.txHash) stop("ARENA_RESULT_MISMATCH");
        const receipt = await rpc.getTransactionReceipt(settlement.txHash);
        const event = receipt?.logs.filter(log => log.address.toLowerCase() === config.escrowAddress.toLowerCase()).map(log => { try { return escrowInterface.parseLog(log); } catch { return null; } }).find(event => event?.name === "TaskSettled" && event.args.taskId === BigInt(config.taskId) && event.args.passed === verdict.passed);
        if (receipt?.status !== 1 || !event) stop("ARENA_SETTLEMENT_UNCONFIRMED");
        submission.result = run.result; state.phase = verdict.passed ? "Succeeded" : "Failed";
        if (!verdict.passed) state.reason = "ARENA_TASK_FAILED"; else delete state.reason;
        await save(); return;
      }
    } catch (error) { state.reason = error instanceof PaymentError ? error.code : "ARENA_RUN_UNAVAILABLE"; await save(); return; }
    if (Date.now() >= until) break; await delay(100);
  } while (Date.now() < until);
  state.reason = "ARENA_RUNNING"; await save();
}
