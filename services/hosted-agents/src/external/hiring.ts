import { isDeepStrictEqual } from "node:util";
import type { Json } from "@agentfuel/sdk";
import type { ExternalHireProof } from "../goal-types.js";
import type { GoalCall, GoalModelRoute, GoalState } from "../goals/executor.js";
import { paidGoalCall } from "../goals/payment.js";
import { specialistSystem } from "../goals/commander.js";
import { normalizeSpecialistOutput, specialistPrompt } from "../specialists/execution.js";
import { openHostedPlannerConnection } from "../autonomy-executor.js";
import { taskPrivateFile } from "../../../../packages/pi-loop/src/task-runner/config.js";
import type { HostedTaskExecutorConfig } from "../task-executor.js";
import type { HostedExecution } from "../types.js";
import { externalDigest, readExternalServiceChainMetadata, type ExternalServiceSnapshot } from "./registry.js";

export interface ExternalHireState {
  version: 1; binding: string; stage: string; service: ExternalServiceSnapshot;
  route: GoalModelRoute; assignmentDigest: string; promptDigest: string;
}
export interface ExternalHireAssignment {
  stage: string; taskType: string; originalGoal: string;
  assignment: { name: string; taskType: string; goal: string };
  previous?: Json[]; chainResearch?: Json; researchDigest?: string;
}
export interface ExternalHireCall extends GoalCall { route: GoalModelRoute }

/** Binds the external report to the exact assigned task and inherited context.
 * All external URL/provider/model fields came from server-side allowlisting. */
export function prepareExternalHire(mission: GoalState, service: ExternalServiceSnapshot, assignment: ExternalHireAssignment): { hire: ExternalHireState; call: ExternalHireCall } {
  if (assignment.taskType !== service.service.taskType || assignment.assignment.taskType !== assignment.taskType ||
    assignment.originalGoal !== mission.input.goal || !assignment.stage || assignment.stage.length > 100) throw new Error("HOSTED_EXTERNAL_ASSIGNMENT_INVALID");
  const profile = specialistPrompt(assignment.taskType, specialistSystem, mission.input.chainId);
  const { stage, taskType: _taskType, ...context } = assignment;
  const user = JSON.stringify(context);
  if (Buffer.byteLength(JSON.stringify({ system: profile.system, user })) > 112000) throw new Error("HOSTED_GOAL_INPUT_TOO_LARGE");
  const trust = service.trust;
  const route: GoalModelRoute = { id: trust.modelId, relayUrl: trust.endpoint, provider: trust.provider,
    priceRaw: trust.priceRaw, service: trust.serviceId, model: trust.modelId, physicalModel: trust.physicalModel,
    ...(trust.responseModel ? { responseModel: trust.responseModel } : {}) };
  const assignmentDigest = externalDigest(user);
  const hire: ExternalHireState = { version: 1, binding: externalDigest({ mission: mission.binding, stage, service, assignmentDigest, promptDigest: profile.promptDigest }),
    stage, service: structuredClone(service), route, assignmentDigest, promptDigest: profile.promptDigest };
  const call: ExternalHireCall = { stage, route: structuredClone(route), serviceId: trust.serviceId, promptDigest: profile.promptDigest,
    messages: [{ role: "system", content: profile.system }, { role: "user", content: user }], max_completion_tokens: 2048 };
  return { hire, call };
}

/** Service-side provenance is covered by the paid result and its original
 * request digest. The host additionally proves the canonical ProviderPaid log. */
export function externalResultBinding(trust: ExternalServiceSnapshot["trust"], messages: { role: string; content: string }[], chainId = trust.identity?.chainId) {
  if (messages.length !== 2 || messages[0].role !== "system" || messages[1].role !== "user") throw new Error("HOSTED_EXTERNAL_ASSIGNMENT_INVALID");
  const prompt = specialistPrompt(trust.taskType, specialistSystem, chainId);
  if (messages[0].content !== prompt.system) throw new Error("HOSTED_EXTERNAL_PROMPT_CHANGED");
  let assignment: ExternalHireAssignment;
  try { assignment = JSON.parse(messages[1].content); } catch { throw new Error("HOSTED_EXTERNAL_ASSIGNMENT_INVALID"); }
  if (!assignment || typeof assignment.originalGoal !== "string" || !assignment.originalGoal.trim() || assignment.originalGoal.length > 12000 ||
    !assignment.assignment || assignment.assignment.taskType !== trust.taskType || typeof assignment.assignment.name !== "string" ||
    !assignment.assignment.name.trim() || assignment.assignment.name.length > 160 || typeof assignment.assignment.goal !== "string" ||
    !assignment.assignment.goal.trim() || assignment.assignment.goal.length > 12000) throw new Error("HOSTED_EXTERNAL_ASSIGNMENT_INVALID");
  return { version: 1, id: trust.id, serviceId: trust.serviceId, taskType: trust.taskType, provider: trust.provider,
    ...(trust.identity ? { identity: structuredClone(trust.identity) } : {}), promptDigest: prompt.promptDigest, assignmentDigest: externalDigest(messages[1].content) };
}

export async function executeExternalHire(task: HostedTaskExecutorConfig, mission: GoalState, call: GoalCall, hire: ExternalHireState,
  input: HostedExecution, save: () => Promise<void>, control: () => Promise<{ paused: boolean; cancelled: boolean }> | undefined) {
  const binding = externalResultBinding(hire.service.trust, call.messages, mission.input.chainId);
  if (hire.version !== 1 || hire.stage !== call.stage || hire.assignmentDigest !== binding.assignmentDigest || hire.promptDigest !== binding.promptDigest ||
    hire.binding !== externalDigest({ mission: mission.binding, stage: hire.stage, service: hire.service, assignmentDigest: hire.assignmentDigest, promptDigest: hire.promptDigest }) ||
    !isDeepStrictEqual((call as ExternalHireCall).route, hire.route) || call.serviceId !== hire.service.trust.serviceId ||
    call.promptDigest !== hire.promptDigest || call.max_completion_tokens !== 2048) throw new Error("HOSTED_GOAL_BINDING_CHANGED");
  if (call.recovery?.resolved) throw new Error(call.recovery.voided ? "HOSTED_GOAL_PAYMENT_VOIDED" : call.recovery.reverted ? "HOSTED_GOAL_PAYMENT_REVERTED" : "HOSTED_GOAL_UNDELIVERED_REFUNDED");
  // The shared payment runtime persists a quote, then signed bytes, before
  // broadcast. It always resumes the same handle after timeouts or cancellation.
  // A previously rejected admission may later be resumed after funding or
  // identity repair. Clear that old unpaid marker before any new SDK attempt;
  // only the current guard/reconciliation may prove this attempt unpaid.
  call.started = true; call.unpaid = false; await save();
  // Cached delivery is re-verified against the original quote and canonical
  // chain receipt, without a new HTTP quote or a new payment transaction.
  let identityConnection: Awaited<ReturnType<typeof openHostedPlannerConnection>> | undefined;
  const admission = async () => {
    const c = await control();
    if (!c?.paused && !c?.cancelled && !input.run.stopRequested && Date.now() < mission.deadlineMs &&
      !call.inference && !call.handle?.submission && hire.service.trust.identity) {
      try {
        identityConnection ??= await openHostedPlannerConnection((await taskPrivateFile(task.rpcUrlFile)).trim(), mission.input.chainId, task.rpcTransport);
        await readExternalServiceChainMetadata(hire.service.trust, identityConnection.provider);
      } catch (error) { call.unpaid = true; await save(); throw error; }
    }
    return c ?? { paused: false, cancelled: false };
  };
  try { call.response = await paidGoalCall(task, mission, call, input, save, admission); await save(); }
  finally { identityConnection?.close(); }
  const response = call.response;
  const result = call.inference?.result as { externalService?: unknown } | undefined;
  const receipt = call.inference?.receipt, quote = call.handle?.quote;
  // A malformed paid response still consumes budget. Keep the canonical
  // payment response so recovery cannot buy a replacement report silently.
  if (!result || !isDeepStrictEqual(result.externalService, binding) || !receipt || !quote ||
    response.chargedRaw !== hire.route.priceRaw || response.paymentId !== receipt.paymentId || response.txHash !== receipt.txHash ||
    receipt.paymentId !== quote.paymentId || receipt.requestDigest !== quote.requestDigest) {
    response.deliveryError = "HOSTED_EXTERNAL_PROVENANCE_INVALID"; await save(); throw new Error(response.deliveryError);
  }
  if (response.deliveryError) throw new Error(response.deliveryError);
  const output = normalizeSpecialistOutput(hire.service.service.taskType, response.text);
  if (!output.trim() || output.length > 24000) throw new Error("HOSTED_GOAL_OUTPUT_INVALID");
  const proof: ExternalHireProof = { service: structuredClone(hire.service.service), paymentId: receipt.paymentId, txHash: receipt.txHash,
    requestDigest: receipt.requestDigest, promptDigest: hire.promptDigest, assignmentDigest: hire.assignmentDigest };
  return { output, response, proof };
}
