import { createHash } from "node:crypto";
import { validateExternalHire } from "../goal-types.js";
import type { GoalState } from "./executor.js";
import { isDeepStrictEqual } from "node:util";
import { normalizeSpecialistOutput } from "../specialists/execution.js";
import { goalProtocolContext } from "./protocol-context.js";

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Host context only: never derive execution claims from an artifact's text.
 * External proofs enter the view only after canonical payment and provenance
 * validation. This proves paid text delivery, not arbitrary tools/code execution.
 * A pending reviewer is described as a separate call, never as already passed. */
export function goalExecutionEvidence(state: GoalState, stage: string, artifact: string) {
  const sourceStage = stage === "revision-review" ? "revision" : `phase-${state.view.phases.length - 1}`;
  const source = state.calls.find(call => call.stage === sourceStage);
  const sourceType = state.view.phases.at(-1)?.taskType;
  if (!source?.response || !sourceType || normalizeSpecialistOutput(sourceType, source.response.text) !== artifact)
    throw new Error("HOSTED_GOAL_EXECUTION_EVIDENCE_INVALID");
  return {
    version: 1,
    missionBinding: state.binding,
    actor: { hostedAgentId: state.input.agentId, chainId: state.input.chainId, agentId: state.input.chainAgentId, wallet: state.input.wallet },
    deliveryScope: "paid-text-delivery-only",
    artifact: { stage: sourceStage, sha256: sha256(artifact), ...(stage === "revision-review" ? { source: "hosted-revision", derivedFrom: `phase-${state.view.phases.length - 1}` } : {}) },
    phases: state.view.phases.map((phase, index) => {
      const call = state.view.calls.find(call => call.stage === `phase-${index}`);
      if (call?.external) {
        const privateCall = state.calls.find(entry => entry.stage === call.stage), hire = state.externalHires?.[call.stage], proof = validateExternalHire(call.external);
        const receipt = privateCall?.inference?.receipt, quote = privateCall?.handle?.quote, response = privateCall?.response;
        if (!privateCall || !hire || !receipt || !quote || !response || privateCall.recovery?.resolved || response.deliveryError
          || proof.paymentId !== receipt.paymentId || proof.txHash !== receipt.txHash || proof.requestDigest !== receipt.requestDigest
          || proof.paymentId !== quote.paymentId || proof.requestDigest !== quote.requestDigest
          || proof.paymentId !== response.paymentId || proof.txHash !== response.txHash || proof.service.priceRaw !== response.chargedRaw
          || proof.promptDigest !== hire.promptDigest || proof.assignmentDigest !== hire.assignmentDigest || !isDeepStrictEqual(proof.service, hire.service.service)
          || normalizeSpecialistOutput(phase.taskType, response.text) !== phase.output
          || receipt.chainId !== state.input.chainId || receipt.agentId !== state.input.chainAgentId || receipt.taskId !== "0"
          || receipt.fromCredit !== "0" || receipt.fromCash !== proof.service.priceRaw || receipt.payTo.toLowerCase() !== proof.service.provider.toLowerCase())
          throw new Error("HOSTED_GOAL_EXECUTION_EVIDENCE_INVALID");
      }
      return { stage: `phase-${index}`, taskType: phase.taskType, ...(phase.output ? { outputSha256: sha256(phase.output) } : {}),
        ...(call?.external ? { source: "external-specialist", proof: validateExternalHire(call.external) } : { source: "hosted-specialist" }) };
    }),
    reviewer: { stage, mode: "separate-model-call", result: "pending" },
    protocol: structuredClone(goalProtocolContext),
  };
}
