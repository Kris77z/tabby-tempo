import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import type { JsonRpcProvider, Wallet } from "ethers";
import { PaymentError } from "@agentfuel/sdk";
import { runProviderSolver, type ProviderSolveOptions, type ProviderSolveState, type SolveSpec } from "./provider.js";
import { SessionStore } from "./session.js";
import { submitProgrammingCandidate, type SubmissionConfig, type SubmissionState } from "./submission.js";

export interface RewardTaskConfig extends SubmissionConfig { solve: SolveSpec }
export interface RewardTaskSession extends SubmissionState {
  version: 1; config: RewardTaskConfig; solve?: ProviderSolveState; creditsUsed: number;
}
export interface RewardTaskOptions {
  submitFailedCandidate?: boolean;
  signer: Wallet; provider: JsonRpcProvider; solver: ProviderSolveOptions;
  creditsUsed: () => Promise<number>; recoverLock?: boolean; timeoutMs?: number; pollTimeoutMs?: number;
}
/** Reward-backed Pi solver; only the independent Arena can attest completion and settle income. */
export async function runRewardTask(directory: string, config: RewardTaskConfig, options: RewardTaskOptions): Promise<RewardTaskSession> {
  const store = new SessionStore<RewardTaskSession>(directory); await store.start(options.recoverLock);
  let state: RewardTaskSession | undefined;
  const save = () => store.write(state!);
  try {
    state = await store.read();
    if (state && (state.version !== 1 || !isDeepStrictEqual(state.config, config))) throw new Error("REWARD_TASK_CONFIG_CHANGED");
    state ??= { version: 1, config: structuredClone(config), phase: "Running", creditsUsed: 0 };
    if (["Succeeded", "Failed", "Stopped"].includes(state.phase)) return structuredClone(state);
    await save();
    state.solve = await runProviderSolver(join(directory, "solver"), config.solve, { ...options.solver, recoverLock: options.recoverLock });
    state.creditsUsed = await options.creditsUsed();
    // A paid worker may submit its last tested candidate for independent failure settlement.
    // Public failure never proves the final outcome; Arena still runs the hidden tests.
    const lastTest = state.solve.tools.at(-1);
    const failedCandidate = options.submitFailedCandidate && state.solve.phase === "Undelivered" && ["ROUND_LIMIT", "TOOL_LIMIT"].includes(state.solve.reason ?? "")
      && lastTest?.result && !lastTest.result.passed ? lastTest.code : undefined;
    if (state.solve.phase !== "Delivered" && !failedCandidate) {
      state.phase = state.solve.phase === "Undelivered" ? "Stopped" : "Paused";
      state.reason = state.solve.reason ?? "REWARD_TASK_INCOMPLETE"; await save(); return structuredClone(state);
    }
    const code = failedCandidate ?? state.solve.candidate;
    if (!code || !failedCandidate && (state.solve.codeHash !== createHash("sha256").update(code).digest("hex")
      || !state.solve.tools.some(tool => tool.code === code && tool.result?.passed))
      || state.submission && state.submission.payload.code !== code) throw new Error("REWARD_TASK_CANDIDATE_INVALID");
    state.candidate = code; state.phase = state.submission ? "SubmissionPending" : "ReadyToSubmit"; delete state.reason; await save();
    await submitProgrammingCandidate(state, config, { signer: options.signer, rpc: options.provider, save,
      timeoutMs: options.timeoutMs, pollTimeoutMs: options.pollTimeoutMs }, config.solve.problemId);
    return structuredClone(state);
  } catch (error) {
    if (!state || !(error instanceof PaymentError)) throw error;
    state.phase = state.submission ? "SubmissionPending" : "Paused"; state.reason = error.code; await save(); return structuredClone(state);
  } finally { await store.close(); }
}
