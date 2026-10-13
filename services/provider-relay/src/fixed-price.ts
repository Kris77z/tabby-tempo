import { createHash } from "node:crypto";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { Contract, Wallet } from "ethers";
import { requestDigest, sameAddress, type ChatInput, type Json, type Quote, type RoutingTier } from "@agentfuel/sdk/protocol";
import { runProviderSolver, validateSolveSpec, type SolveSpec } from "@agentfuel/pi-loop/provider";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { publicSampleFor } from "@agentfuel/pi-loop/public-sample";
import type { DockerExecutor } from "@agentfuel/arena/docker";
import { upstreamUrl, type RelayConfig, type Upstream } from "./config.js";
import { Relay, RelayError, type RelayOptions } from "./relay.js";
import { Refunder, type RefunderOptions } from "./refunder.js";
import type { PaymentRecord } from "./store.js";

export const FIXED_SOLVE_SERVICE = "infercredit/solve-fixed";
export const FIXED_SOLVE_MODEL = "pi-fixed-v1";
interface PaidClaim { paymentId: string; digest: string; quote: Quote }
export interface FixedPriceOptions extends RelayOptions { runner?: DockerExecutor; modelFetch?: typeof fetch; recoverLock?: boolean }

/** Separate opt-in service. The original chat Relay and its cash delivery remain unchanged. */
export class FixedPriceSolvingRelay extends Relay {
  // This separate service deliberately refunds an unqualified/unknown solve in full,
  // with its provider bearing the uncertain model cost. It uses its own solve journal.
  override isDeliveryUncertain(_record: PaymentRecord) { return false; }
  constructor(config: RelayConfig, private readonly solving: FixedPriceOptions = {}) {
    super(config, solving);
    if (config.service.id !== FIXED_SOLVE_SERVICE || config.service.model !== FIXED_SOLVE_MODEL || config.service.tiers ||
      config.service.upstreams.length !== 2 || config.service.upstreams.map(u => u.name).sort().join(",") !== "cheap,strong" ||
      !config.refunderKey || !sameAddress(new Wallet(config.refunderKey).address, config.payTo)) {
      this.close(); throw new Error("INVALID_FIXED_PRICE_SERVICE");
    }
  }
  override validate(value: unknown, forQuote = true): ChatInput {
    const input = super.validate(value, forQuote);
    try {
      const spec = validateSolveSpec(input.solve, forQuote);
      if (Object.keys(input).sort().join(",") !== "agentId,messages,model,service,solve,taskId" || input.taskId === "0" ||
        input.service !== FIXED_SOLVE_SERVICE || input.model !== FIXED_SOLVE_MODEL ||
        !isDeepStrictEqual(input.messages, [{ role: "user", content: publicSampleFor(spec.problemId).prompt }])) throw new Error();
    } catch { throw new RelayError("INVALID_SOLVE_REQUEST", "Use the fixed public task and bounded solve specification", 400); }
    return input;
  }
  private claimStore(input: ChatInput) {
    return new SessionStore<PaidClaim>(join(this.config.dataDir, "task-claims", `${input.agentId}-${input.taskId}`));
  }
  private async claim(input: ChatInput): Promise<PaidClaim | undefined> {
    try {
      const claim = JSON.parse(await readFile(join(this.claimStore(input).directory, "session.json"), "utf8")) as PaidClaim;
      const quote = claim.quote;
      if (!quote || quote.paymentId !== claim.paymentId || quote.requestDigest !== claim.digest || quote.chainId !== this.config.chainId.toString() ||
        !sameAddress(quote.account, this.config.account) || !sameAddress(quote.asset, this.config.asset) || !sameAddress(quote.payTo, this.config.payTo) ||
        quote.agentId !== input.agentId || quote.taskId !== input.taskId || quote.service !== FIXED_SOLVE_SERVICE || quote.model !== FIXED_SOLVE_MODEL) throw new Error("SOLVE_CLAIM_BINDING_MISMATCH");
      return claim;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
  }
  override async quote(input: ChatInput): Promise<Quote> {
    this.validate(input);
    const prior = await this.claim(input);
    if (prior) {
      if (prior.digest !== requestDigest(input)) throw new RelayError("SOLVE_TASK_ALREADY_PAID", "This task is bound to its original paid request");
      return prior.quote;
    }
    // Unauthenticated quotes do not claim a task. Only a confirmed payment may do so.
    return super.quote(input);
  }
  override async status(id: string, agentId: string, digest: string) {
    const view = await super.status(id, agentId, digest);
    if (view.state !== "Quoted") return view;
    const record = await this.record(id, agentId, digest), prior = await this.claim(record.request);
    return prior && prior.paymentId !== id ? { ...view, deliveryError: "SOLVE_TASK_ALREADY_PAID" } : view;
  }
  private routes(record: PaymentRecord): Record<RoutingTier, Upstream> {
    const snapshot = record.route;
    if (!snapshot || snapshot.version !== 1 || snapshot.model !== record.quote.model || snapshot.tier !== undefined) throw new RelayError("ROUTE_SNAPSHOT_REQUIRED", "Original solving route is required; refund remains available");
    const routes = Object.fromEntries(snapshot.upstreams.map(pinned => [pinned.name, this.config.service.upstreams.find(current =>
      current.name === pinned.name && current.model === pinned.model && upstreamUrl(current.baseUrl) === pinned.baseUrl)]));
    if (Object.keys(routes).sort().join(",") !== "cheap,strong" || !routes.cheap || !routes.strong) throw new RelayError("ROUTE_UNAVAILABLE", "Restore the paid solving models or refund the original payment");
    return routes as Record<RoutingTier, Upstream>;
  }
  private async assigned(record: PaymentRecord) {
    await this.chain();
    const account = new Contract(this.config.account, ["function taskEscrow() view returns(address)", "function adapter() view returns(address)"], this.provider);
    const escrow = new Contract(await account.getFunction("taskEscrow").staticCall(), ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], this.provider);
    const adapter = new Contract(await account.getFunction("adapter").staticCall(), ["function resolveAgent(uint256) view returns(address owner,address wallet)", "function identityChanged(uint256) view returns(bool)"], this.provider);
    const [task, identity, changed, block, payment] = await Promise.all([
      escrow.getFunction("getTask").staticCall(record.quote.taskId), adapter.getFunction("resolveAgent").staticCall(record.quote.agentId),
      adapter.getFunction("identityChanged").staticCall(record.quote.agentId), this.provider.getBlock("latest"), this.provider.getTransaction(record.proof!.txHash),
    ]);
    if (task.status !== 2n || task.agentId !== BigInt(record.quote.agentId) || !block || BigInt(block.timestamp) >= task.deadline ||
      changed || !payment || !sameAddress(identity.wallet, payment.from)) throw new RelayError("SOLVE_TASK_UNAVAILABLE", "Assigned task, deadline or current identity changed; no new model dispatch");
  }
  override async deliver(record: PaymentRecord) {
    await this.confirm(record); // Reuse the original quote/domain/payment proof binding.
    if (record.state === "Delivered") return { result: record.result, receipt: record.receipt };
    if (record.state === "Quoted") throw new RelayError("PAYMENT_REQUIRED", "Payment not confirmed", 402);
    if (record.state === "Refunded" || record.refunds.length) throw new RelayError("REFUND_IN_PROGRESS", "Original payment is being refunded");
    if (record.expiredPayment) throw new RelayError("PAYMENT_AFTER_EXPIRY", "Late original payment can only be refunded");
    const claim = this.claimStore(record.request); await claim.start(this.solving.recoverLock);
    try {
      const prior = await claim.read();
      if (prior && (prior.paymentId !== record.quote.paymentId || prior.digest !== record.quote.requestDigest)) throw new RelayError("SOLVE_TASK_ALREADY_PAID", "Use the original paid solving handle; this duplicate remains refundable");
      if (!prior) await claim.write({ paymentId: record.quote.paymentId, digest: record.quote.requestDigest, quote: record.quote });
    } finally { await claim.close(); }
    try {
      const spec = validateSolveSpec(record.request.solve, false), routes = this.routes(record);
      record.state = "Processing"; await this.store.write(record);
      const run = await runProviderSolver(join(this.config.dataDir, "solve-runs", record.quote.paymentId), spec, {
        routes: Object.fromEntries(Object.entries(routes).map(([tier, { name, model, baseUrl }]) => [tier, { name, model, baseUrl: upstreamUrl(baseUrl) }])) as Parameters<typeof runProviderSolver>[2]["routes"],
        runner: this.solving.runner, recoverLock: this.solving.recoverLock,
        invoke: async (tier, body, signal) => {
          await this.assigned(record); // Every new dispatch; cached paid output does not need a live assignment.
          if (Date.now() >= spec.deadlineMs) throw new RelayError("SOLVE_DEADLINE", "No new dispatch after the paid service deadline");
          const route = routes[tier];
          const response = await (this.solving.modelFetch ?? fetch)(upstreamUrl(route.baseUrl) + "/chat/completions", {
            method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${route.key}` }, body: JSON.stringify(body),
            signal: AbortSignal.any([signal, AbortSignal.timeout(this.config.upstreamTimeout)]),
          });
          if (!response.ok) throw new RelayError("SOLVE_UPSTREAM_UNKNOWN", "Model dispatch did not yield a saved response");
          return await response.json() as Record<string, Json>;
        },
      });
      if (run.phase !== "Delivered" || !run.candidate || !run.codeHash) throw new RelayError(run.phase === "Unknown" ? "SOLVE_DISPATCH_UNKNOWN" : "SOLVE_UNDELIVERED", "No qualified final code; resume only the original handle or request its full refund", 502);
      const last = run.rounds.at(-1)!;
      if (run.codeHash !== createHash("sha256").update(run.candidate).digest("hex") || last.model !== routes[last.tier].model) throw new RelayError("SOLVE_RESULT_MISMATCH", "Solving journal is not bound to the paid models");
      record.result = JSON.parse(JSON.stringify({ schema: 1, taskId: record.quote.taskId, code: run.candidate, codeHash: run.codeHash, run }));
      record.receipt = { ...record.proof!, paymentId: record.quote.paymentId, agentId: record.quote.agentId, taskId: record.quote.taskId,
        requestDigest: record.quote.requestDigest, service: record.quote.service, price: record.quote.price, asset: record.quote.asset,
        chainId: record.quote.chainId, account: record.quote.account, payTo: record.quote.payTo, upstream: routes[last.tier].name, model: last.model,
        usage: last.response?.usage ?? null };
      record.state = "Delivered"; delete record.lastError; await this.store.write(record);
      return { result: record.result, receipt: record.receipt };
    } catch (error) {
      // A failed acknowledgement after durable delivery cannot reopen it for refunds.
      if ((await this.store.read(record.quote.paymentId)).state === "Delivered") throw error;
      record.state = "Paid"; delete record.result; delete record.receipt; record.lastError = error instanceof RelayError ? error.code : "SOLVE_RECOVERY_REQUIRED"; await this.store.write(record); throw error;
    }
  }
}

/** This service sells a fixed deliverable; it supports only the original full-price refund. */
export class FixedPriceRefunder extends Refunder {
  constructor(private readonly solvingRelay: FixedPriceSolvingRelay, limits: RefunderOptions = {}) { super(solvingRelay, limits); }
  override async refund(paymentId: string, refundId: string, amount: string) {
    const record = await this.solvingRelay.store.read(paymentId);
    if (amount !== record.quote.price) throw new RelayError("FIXED_PRICE_FULL_REFUND_REQUIRED", "Undelivered solving service refunds the full original price", 400);
    return super.refund(paymentId, refundId, amount);
  }
}
