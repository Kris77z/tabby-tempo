import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonical, type ChatInput, type InferenceReceipt, type Json, type PaymentProof, type Quote, type RoutingTier } from "@agentfuel/sdk/protocol";
import { keccak256, toUtf8Bytes } from "ethers";
import type { Upstream } from "./config.js";

export interface SignedOperation { rawTransaction: string; txHash: string; nonce: number }
export interface Refund { id: string; amount: string; state: "Prepared" | "Confirmed"; approval?: SignedOperation; transaction?: SignedOperation }
export interface RouteSnapshot { version: 1; model: string; tier?: RoutingTier; upstreams: Omit<Upstream, "key">[] }
export interface UpstreamAttempt {
  upstream: string; model: string; startedAt: number;
  state: "Dispatching" | "Rejected" | "Unknown" | "Delivered";
  httpStatus?: number; reason?: "NETWORK_OR_TIMEOUT" | "HTTP_STATUS" | "INVALID_RESPONSE";
}
export interface OperatorResolutionInput { paymentId: string; resolutionId: string; expectedAttemptsDigest: string; evidenceDigest: string }
export interface OperatorResolution extends OperatorResolutionInput {
  version: 1; reason: "operator-accepted-nondelivery-cost"; resolvedAt: number;
}
export interface AllowanceClosure {
  version: 1; resolutionId: string; evidenceDigest: string; reason: "operator-accepted-unknown-cost";
  paymentId: string; expectedLedgerDigest: string; binding: { agentId: string; taskId: string; wallet: string }; sealedAt: number;
}
export interface AllowanceCompensationInput {
  paymentId: string; resolutionId: string; evidenceDigest: string; closure: AllowanceClosure; certificateDigest: string;
}
export interface OperatorCompensation extends AllowanceCompensationInput {
  version: 1; reason: "operator-accepted-unknown-inference-cost"; resolvedAt: number;
}
export const allowanceCertificateDigest = (closure: AllowanceClosure) => keccak256(toUtf8Bytes(canonical(closure as unknown as Json)));
export function validCompensationInput(value: unknown): value is AllowanceCompensationInput {
  const v = value as AllowanceCompensationInput, c = v?.closure;
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).sort().join(",") !== "certificateDigest,closure,evidenceDigest,paymentId,resolutionId" ||
    !hash(v.paymentId) || !hash(v.evidenceDigest) || !hash(v.certificateDigest) || typeof v.resolutionId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(v.resolutionId) ||
    !c || Object.keys(c).sort().join(",") !== "binding,evidenceDigest,expectedLedgerDigest,paymentId,reason,resolutionId,sealedAt,version" ||
    c.version !== 1 || c.reason !== "operator-accepted-unknown-cost" || c.paymentId !== v.paymentId || c.resolutionId !== v.resolutionId || c.evidenceDigest !== v.evidenceDigest ||
    typeof c.expectedLedgerDigest !== "string" || !/^[0-9a-f]{64}$/.test(c.expectedLedgerDigest) || !Number.isSafeInteger(c.sealedAt) || c.sealedAt <= 0 ||
    !c.binding || Object.keys(c.binding).sort().join(",") !== "agentId,taskId,wallet" || !/^[1-9][0-9]{0,77}$/.test(c.binding.agentId) || !/^[1-9][0-9]{0,77}$/.test(c.binding.taskId) ||
    !/^0x[0-9a-fA-F]{40}$/.test(c.binding.wallet)) return false;
  return v.certificateDigest === allowanceCertificateDigest(c);
}
export function validOperatorCompensation(record: PaymentRecord): boolean {
  const c = record.operatorCompensation, q = record.quote, receipt = record.receipt, result = record.result as Record<string, Json> | undefined;
  if (!c || c.version !== 1 || c.reason !== "operator-accepted-unknown-inference-cost" || !Number.isSafeInteger(c.resolvedAt) || c.resolvedAt <= 0 ||
    !validCompensationInput({ paymentId: c.paymentId, resolutionId: c.resolutionId, evidenceDigest: c.evidenceDigest, closure: c.closure, certificateDigest: c.certificateDigest }) ||
    !["Delivered", "Refunded"].includes(record.state) || record.operatorResolution || !record.proof || !receipt || !result ||
    q.service !== "infercredit/allowance" || q.model !== "inference-allowance-v1" || c.paymentId !== q.paymentId || c.closure.binding.agentId !== q.agentId || c.closure.binding.taskId !== q.taskId ||
    receipt.paymentId !== q.paymentId || receipt.txHash !== record.proof.txHash || receipt.requestDigest !== q.requestDigest || receipt.upstream !== "allowance-ledger" ||
    result.kind !== "inference-allowance" || result.paymentId !== q.paymentId || result.agentId !== q.agentId || result.taskId !== q.taskId) return false;
  return true;
}
export const upstreamAttemptsDigest = (attempts: UpstreamAttempt[]) => keccak256(toUtf8Bytes(canonical(attempts as unknown as Json)));
const hash = (value: unknown) => typeof value === "string" && /^0x[0-9a-f]{64}$/.test(value);
export function validResolutionInput(value: unknown): value is OperatorResolutionInput {
  const input = value as OperatorResolutionInput;
  return !!input && typeof input === "object" && !Array.isArray(input) &&
    Object.keys(input).sort().join(",") === "evidenceDigest,expectedAttemptsDigest,paymentId,resolutionId" &&
    hash(input.paymentId) && hash(input.expectedAttemptsDigest) && hash(input.evidenceDigest) &&
    (hash(input.resolutionId) || typeof input.resolutionId === "string" && /^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(input.resolutionId));
}
export function validOperatorResolution(record: PaymentRecord): boolean {
  const resolution = record.operatorResolution, attempts = record.upstreamAttempts;
  if (!resolution || resolution.version !== 1 || resolution.reason !== "operator-accepted-nondelivery-cost" || !Number.isSafeInteger(resolution.resolvedAt) || resolution.resolvedAt <= 0 ||
    !validResolutionInput({ paymentId: resolution.paymentId, resolutionId: resolution.resolutionId, expectedAttemptsDigest: resolution.expectedAttemptsDigest, evidenceDigest: resolution.evidenceDigest }) ||
    resolution.paymentId !== record.quote.paymentId || !record.proof || record.result !== undefined || record.receipt !== undefined || record.state === "Delivered" || record.state === "Quoted" ||
    !attempts?.some(a => a.state === "Unknown") || attempts.some(a => !["Unknown", "Rejected"].includes(a.state))) return false;
  return resolution.expectedAttemptsDigest === upstreamAttemptsDigest(attempts);
}
export interface PaymentRecord {
  quote: Quote; request: ChatInput; state: "Quoted" | "Paid" | "Processing" | "Delivered" | "Refunded";
  proof?: PaymentProof; result?: Json; receipt?: InferenceReceipt; lastError?: string; refunds: Refund[];
  scanBlock?: number; expiredPayment?: boolean; route?: RouteSnapshot;
  upstreamAttempts?: UpstreamAttempt[];
  operatorResolution?: OperatorResolution;
  operatorCompensation?: OperatorCompensation;
}
export class Store {
  private readonly locks = new Map<string, Promise<unknown>>();
  constructor(private readonly directory: string) {}
  private file(id: string) { if (!/^0x[0-9a-f]{64}$/.test(id)) throw new Error("Invalid paymentId"); return join(this.directory, `${id}.json`); }
  async read(id: string): Promise<PaymentRecord> { return JSON.parse(await readFile(this.file(id), "utf8")); }
  async write(record: PaymentRecord) {
    await mkdir(this.directory, { recursive: true });
    const target = this.file(record.quote.paymentId);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, JSON.stringify(record), { flag: "wx", mode: 0o600 }); await rename(temporary, target); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async ids() { await mkdir(this.directory, { recursive: true }); return (await readdir(this.directory)).filter(name => /^0x[0-9a-f]{64}\.json$/.test(name)).map(name => name.slice(0, -5)); }
  lock<T>(id: string, work: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) || Promise.resolve()).catch(() => {}).then(work);
    this.locks.set(id, next);
    void next.finally(() => { if (this.locks.get(id) === next) this.locks.delete(id); }).catch(() => {});
    return next;
  }
}
