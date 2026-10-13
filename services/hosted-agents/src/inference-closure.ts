import { createHash } from "node:crypto";
import { canonical, type Json } from "../../../packages/sdk/src/protocol.js";

/** A permanent, operator-authorized seal. It makes no claim about supplier cost. */
export interface GatewayClosure {
  version: 1; resolutionId: string; evidenceDigest: string; reason: "operator-accepted-unknown-cost";
  paymentId: string; expectedLedgerDigest: string;
  binding: { agentId: string; taskId: string; wallet: string }; sealedAt: number;
}
export function unsealedLedgerDigest(state: any): string {
  const { closure: _closure, ...original } = state;
  return createHash("sha256").update(canonical(original)).digest("hex");
}
export function validGatewayClosure(state: any, expected?: GatewayClosure): boolean {
  try {
    const c = state.closure as GatewayClosure;
    if (!c || c.version !== 1 || c.reason !== "operator-accepted-unknown-cost"
      || Object.keys(c).sort().join() !== ["version", "resolutionId", "evidenceDigest", "reason", "paymentId", "expectedLedgerDigest", "binding", "sealedAt"].sort().join()
      || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.resolutionId)
      || !/^0x[0-9a-f]{64}$/.test(c.evidenceDigest) || !/^0x[0-9a-f]{64}$/.test(c.paymentId)
      || !/^[0-9a-f]{64}$/.test(c.expectedLedgerDigest) || !Number.isSafeInteger(c.sealedAt) || c.sealedAt <= 0
      || canonical(c.binding) !== canonical(state.binding) || expected && canonical(c as unknown as Json) !== canonical(expected as unknown as Json)
      || unsealedLedgerDigest(state) !== c.expectedLedgerDigest) return false;
    const grant = state.grants?.[0];
    return state.version === 1 && state.grants?.length === 1 && grant.id === c.paymentId
      && grant.source.kind === "chain-payment" && grant.source.paymentId === c.paymentId
      && /^0x[0-9a-f]{64}$/.test(grant.source.txHash)
      && state.invocations?.length > 0 && state.invocations.every((v: any) => v.state === "Unknown" && !v.result);
  } catch { return false; }
}
