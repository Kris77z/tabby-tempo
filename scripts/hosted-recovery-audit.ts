import type { HostedRun } from "../services/hosted-agents/src/types.js";

/** Read-only postcondition for a normal refunded Goal cancellation. A fully
 * refunded undelivered call ends as Failed, not as a fabricated successful run.
 * The public API field is activities (plural); missing evidence must fail. */
export function assertRefundedGoalCancellation(run: HostedRun) {
  if (run.action !== "goal" || run.status !== "Failed" || run.recoverable !== false || run.result?.terminal !== true
    || run.result.success !== false || run.reason !== "HOSTED_GOAL_UNDELIVERED_REFUNDED"
    || run.result.reason !== run.reason || run.result.refundedRaw === undefined || BigInt(run.result.refundedRaw) <= 0n
    || !Array.isArray(run.activities) || !run.activities.some(event => event.reason === "HOSTED_GOAL_CANCELLED" && event.state === "stopping")
    || run.activities.at(-1)?.reason !== run.reason)
    throw new Error("HOSTED_REFUNDED_CANCEL_AUDIT_FAILED");
  return { requestId: run.requestId, status: run.status, reason: run.reason, refundedRaw: run.result.refundedRaw, terminal: true as const };
}
