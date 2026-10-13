import { open, readFile } from "node:fs/promises";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Contract } from "ethers";
import { requestDigest, sameAddress, uint, type ChatInput, type Json, type Quote } from "@agentfuel/sdk/protocol";
import type { FetchOptions } from "@agentfuel/sdk";
import { SessionStore } from "@agentfuel/pi-loop/session";
import type { RelayConfig } from "./config.js";
import { Relay, RelayError, type RelayOptions } from "./relay.js";
import { validCompensationInput, validOperatorCompensation, type AllowanceClosure, type PaymentRecord } from "./store.js";

export const ALLOWANCE_SERVICE = "infercredit/allowance";
export const ALLOWANCE_MODEL = "inference-allowance-v1";
export interface AllowanceTerms { creditsRaw: string; modelCatalogDigest: string }
export interface AllowanceOptions extends RelayOptions, AllowanceTerms {
  recoverLock?: boolean;
  /** Must verify the actual permanently sealed ledger, never just the supplied certificate. */
  verifyAllowanceClosure?(closure: AllowanceClosure): Promise<boolean>;
}
interface PaidClaim { paymentId: string; digest: string; quote: Quote }
const messages = [{ role: "user", content: "Purchase one task-bound prepaid inference allowance package." }];

function validTerms(terms: AllowanceTerms) {
  return terms && uint(terms.creditsRaw, "creditsRaw") > 0n && /^0x[0-9a-f]{64}$/.test(terms.modelCatalogDigest);
}
/** These terms are inside the signed payment request digest, not mutable server metadata. */
export function allowanceBody(terms: AllowanceTerms): FetchOptions["body"] {
  if (!validTerms(terms)) throw new Error("INVALID_ALLOWANCE_TERMS");
  return { service: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, messages: structuredClone(messages),
    allowance: { creditsRaw: terms.creditsRaw, modelCatalogDigest: terms.modelCatalogDigest } };
}

/** Sells a prepaid package. The hosted gateway meters its consumption separately; no LLM runs here. */
export class InferenceAllowanceRelay extends Relay {
  private readonly terms: AllowanceTerms;
  constructor(config: RelayConfig, private readonly allowance: AllowanceOptions) {
    super(config, allowance);
    try {
      if (config.service.id !== ALLOWANCE_SERVICE || config.service.model !== ALLOWANCE_MODEL || config.service.tiers || !validTerms(allowance)) throw new Error();
      this.terms = { creditsRaw: allowance.creditsRaw, modelCatalogDigest: allowance.modelCatalogDigest };
    } catch { this.close(); throw new Error("INVALID_ALLOWANCE_SERVICE"); }
  }
  override validate(value: unknown, forQuote = true): ChatInput {
    const input = super.validate(value, forQuote);
    try {
      const terms = input.allowance as unknown as AllowanceTerms;
      if (Object.keys(input).sort().join(",") !== "agentId,allowance,messages,model,service,taskId" || input.taskId === "0" ||
        input.service !== ALLOWANCE_SERVICE || input.model !== ALLOWANCE_MODEL || !isDeepStrictEqual(input.messages, messages) ||
        !terms || Object.keys(terms).sort().join(",") !== "creditsRaw,modelCatalogDigest" || !validTerms(terms)) throw new Error();
      if (forQuote && !isDeepStrictEqual(terms, this.terms)) throw new RelayError("ALLOWANCE_CONFIG_MISMATCH", "Use the configured allowance package and model catalog");
    } catch (error) {
      if (error instanceof RelayError) throw error;
      throw new RelayError("INVALID_ALLOWANCE_REQUEST", "Use a nonzero task and the exact prepaid allowance specification", 400);
    }
    return input;
  }
  private assertTerms(record: PaymentRecord) {
    this.validate(record.request, false);
    if (!isDeepStrictEqual(record.request.allowance, this.terms)) throw new RelayError("ALLOWANCE_CONFIG_MISMATCH", "Restore the original allowance package/catalog or refund the undelivered payment");
  }
  private claimStore(input: ChatInput) { return new SessionStore<PaidClaim>(join(this.config.dataDir, "task-claims", `${input.agentId}-${input.taskId}`)); }
  private async claim(input: ChatInput): Promise<PaidClaim | undefined> {
    try {
      const claim = JSON.parse(await readFile(join(this.claimStore(input).directory, "session.json"), "utf8")) as PaidClaim;
      const q = claim.quote;
      if (!q || q.paymentId !== claim.paymentId || q.requestDigest !== claim.digest || q.agentId !== input.agentId || q.taskId !== input.taskId ||
        q.chainId !== this.config.chainId.toString() || !sameAddress(q.account, this.config.account) || !sameAddress(q.asset, this.config.asset) ||
        !sameAddress(q.payTo, this.config.payTo) || q.service !== ALLOWANCE_SERVICE || q.model !== ALLOWANCE_MODEL) throw new Error("ALLOWANCE_CLAIM_MISMATCH");
      return claim;
    } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  private async assigned(input: ChatInput, record?: PaymentRecord, forCompensation = false) {
    await this.chain();
    const account = new Contract(this.config.account, ["function taskEscrow() view returns(address)", "function adapter() view returns(address)"], this.provider);
    const escrow = new Contract(await account.getFunction("taskEscrow").staticCall(), ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], this.provider);
    const adapter = new Contract(await account.getFunction("adapter").staticCall(), ["function resolveAgent(uint256) view returns(address owner,address wallet)", "function identityChanged(uint256) view returns(bool)"], this.provider);
    const [task, identity, changed, block] = await Promise.all([escrow.getFunction("getTask").staticCall(input.taskId),
      adapter.getFunction("resolveAgent").staticCall(input.agentId), adapter.getFunction("identityChanged").staticCall(input.agentId), this.provider.getBlock("latest")]);
    if (task.status !== 2n || task.agentId !== BigInt(input.agentId) || !block || !forCompensation && BigInt(block.timestamp) >= task.deadline || changed) {
      throw new RelayError("ALLOWANCE_TASK_UNAVAILABLE", "Allowance requires an active assigned task and unchanged identity");
    }
    if (record) {
      const [transaction, payment] = await Promise.all([this.provider.getTransaction(record.proof!.txHash), this.account.getFunction("getPayment").staticCall(record.quote.paymentId)]);
      if (!transaction || !sameAddress(transaction.from, identity.wallet)) throw new RelayError("ALLOWANCE_IDENTITY_MISMATCH", "Payment signer must be the assigned agent's current wallet");
      if (payment.refundedAmount !== 0n) throw new RelayError("REFUND_IN_PROGRESS", "Refunded payments cannot grant allowance");
    }
  }
  override async quote(input: ChatInput): Promise<Quote> {
    this.validate(input);
    const prior = await this.claim(input);
    if (prior) {
      if ((await this.store.read(prior.paymentId)).operatorCompensation) throw new RelayError("ALLOWANCE_COMPENSATED", "This task's original allowance was permanently closed");
      if (prior.digest !== requestDigest(input)) throw new RelayError("ALLOWANCE_TASK_ALREADY_PAID", "Use the task's original allowance payment");
      return prior.quote;
    }
    await this.assigned(input);
    return super.quote(input);
  }
  override async status(id: string, agentId: string, digest: string) {
    const record = await this.record(id, agentId, digest); this.assertTerms(record);
    const view = await super.status(id, agentId, digest);
    const prior = await this.claim(record.request);
    return prior && prior.paymentId !== id ? { ...view, deliveryError: "ALLOWANCE_TASK_ALREADY_PAID" } : view;
  }
  override async deliver(record: PaymentRecord) {
    await this.confirm(record); this.assertTerms(record);
    if (record.operatorCompensation) throw new RelayError("ALLOWANCE_COMPENSATED", "Original delivered allowance is permanently closed for operator compensation");
    if (record.state === "Delivered") return { result: record.result, receipt: record.receipt };
    if (record.state === "Quoted") throw new RelayError("PAYMENT_REQUIRED", "Payment not confirmed", 402);
    if (record.state === "Refunded" || record.refunds.length) throw new RelayError("REFUND_IN_PROGRESS", "Original payment is being refunded");
    if (record.expiredPayment) throw new RelayError("PAYMENT_AFTER_EXPIRY", "Late original payment can only be refunded");
    await this.assigned(record.request, record);
    const claim = this.claimStore(record.request); await claim.start(this.allowance.recoverLock);
    try {
      const prior = await claim.read();
      if (prior && (prior.paymentId !== record.quote.paymentId || prior.digest !== record.quote.requestDigest)) throw new RelayError("ALLOWANCE_TASK_ALREADY_PAID", "This task already has an allowance; the duplicate remains refundable");
      if (!prior) await claim.write({ paymentId: record.quote.paymentId, digest: record.quote.requestDigest, quote: record.quote });
      record.result = { kind: "inference-allowance", paymentId: record.quote.paymentId, agentId: record.quote.agentId,
        taskId: record.quote.taskId, ...this.terms } satisfies Record<string, Json>;
      record.receipt = { ...record.proof!, paymentId: record.quote.paymentId, agentId: record.quote.agentId, taskId: record.quote.taskId,
        requestDigest: record.quote.requestDigest, service: record.quote.service, price: record.quote.price, asset: record.quote.asset,
        chainId: record.quote.chainId, account: record.quote.account, payTo: record.quote.payTo, upstream: "allowance-ledger", model: ALLOWANCE_MODEL,
        usage: { kind: "prepaid-inference-allowance", creditsRaw: this.terms.creditsRaw, modelCatalogDigest: this.terms.modelCatalogDigest, llmInvocations: 0 } };
      record.state = "Delivered"; delete record.lastError;
      await this.store.write(record);
      // Do not acknowledge a spendable grant until both its file and rename are durable.
      const committed = await open(join(this.config.dataDir, `${record.quote.paymentId}.json`), "r");
      try { await committed.sync(); } finally { await committed.close(); }
      const directory = await open(this.config.dataDir, "r");
      try { await directory.sync(); } finally { await directory.close(); }
      return { result: record.result, receipt: record.receipt };
    } finally { await claim.close(); }
  }
  override async verifyCompensation(record: PaymentRecord) {
    await this.confirm(record); // Includes the base quote/request/domain binding check.
    if (!validOperatorCompensation(record)) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Compensation does not match the original delivered allowance");
    if (!this.allowance.verifyAllowanceClosure || !await this.allowance.verifyAllowanceClosure(structuredClone(record.operatorCompensation!.closure)))
      throw new RelayError("ALLOWANCE_CLOSURE_UNVERIFIED", "The trusted host must prove the original ledger is permanently sealed");
    this.assertTerms(record); const confirmed = await this.proof(record.quote, record.proof!.txHash);
    for (const key of ["txHash", "blockNumber", "blockHash", "timestamp", "fromCash", "fromCredit"] as const)
      if (record.proof![key] !== confirmed[key] || record.receipt![key] !== confirmed[key]) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Original delivery proof is no longer canonical");
    if (!isDeepStrictEqual(record.result, { kind: "inference-allowance", paymentId: record.quote.paymentId, agentId: record.quote.agentId, taskId: record.quote.taskId, ...this.terms }))
      throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Original delivered allowance terms differ");
    for (const key of ["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "asset", "chainId", "account", "payTo"] as const)
      if (record.receipt![key] !== record.quote[key]) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Original allowance receipt differs from quote");
    const payment = await this.account.getFunction("getPayment").staticCall(record.quote.paymentId);
    if (payment.agentId !== BigInt(record.quote.agentId) || payment.fromCash + payment.fromCredit !== BigInt(record.quote.price) ||
      ![0n, BigInt(record.quote.price)].includes(payment.refundedAmount)) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Original payment cannot be fully compensated");
    if (payment.fromCredit > 0n) {
      const manager = new Contract(await this.account.getFunction("creditManager").staticCall(), ["function getLoan(uint256) view returns(tuple(uint256 agentId,uint256 principal,uint256 fee,uint256 loanDueAt,uint8 status))"], this.provider);
      const loan = await manager.getFunction("getLoan").staticCall(record.quote.taskId);
      if (payment.taskId !== BigInt(record.quote.taskId) || loan.agentId !== BigInt(record.quote.agentId) ||
        (payment.refundedAmount === 0n ? loan.status !== 1n || loan.principal !== payment.fromCredit : loan.status !== 4n || loan.principal + loan.fee !== 0n))
        throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Task loan must be active before compensation and closed by its full refund afterwards");
    }
    const transaction = await this.provider.getTransaction(record.proof!.txHash);
    if (!transaction || !sameAddress(transaction.from, record.operatorCompensation!.closure.binding.wallet)) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Closure wallet differs from the original payment signer");
    const claim = await this.claim(record.request);
    if (claim?.paymentId !== record.quote.paymentId || claim.digest !== record.quote.requestDigest) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Closure is not for the task's original allowance");
  }
  override async compensateAllowance(input: unknown) {
    if (!validCompensationInput(input)) throw new RelayError("INVALID_ALLOWANCE_COMPENSATION", "Use an exact, digest-bound sealed-ledger certificate", 400);
    return this.store.lock(input.paymentId, async () => {
      let record: PaymentRecord;
      try { record = await this.store.read(input.paymentId); } catch { throw new RelayError("QUOTE_NOT_FOUND", "Unknown allowance quote", 404); }
      if (record.operatorCompensation) {
        const saved = record.operatorCompensation;
        if (!isDeepStrictEqual({ paymentId: saved.paymentId, resolutionId: saved.resolutionId, evidenceDigest: saved.evidenceDigest, closure: saved.closure, certificateDigest: saved.certificateDigest }, input))
          throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Original compensation decision is immutable");
        await this.verifyCompensation(record); return this.view(record);
      }
      if (record.state !== "Delivered" || !record.result || !record.receipt || record.refunds.length || record.operatorResolution)
        throw new RelayError("ALLOWANCE_COMPENSATION_NOT_ALLOWED", "Only the original delivered and not-yet-refunded allowance can be compensated");
      const candidate = structuredClone(record);
      candidate.operatorCompensation = { version: 1, ...input, reason: "operator-accepted-unknown-inference-cost", resolvedAt: Date.now() };
      await this.verifyCompensation(candidate);
      await this.assigned(record.request, record, true); // Expiry stops new inference, not compensation of an unliquidated loan.
      await this.store.write(candidate); // Original result/receipt remain intact; no future delivery or regrant.
      const committed = await open(join(this.config.dataDir, `${record.quote.paymentId}.json`), "r");
      try { await committed.sync(); } finally { await committed.close(); }
      const dir = await open(this.config.dataDir, "r"); try { await dir.sync(); } finally { await dir.close(); }
      return this.view(candidate);
    });
  }
}
