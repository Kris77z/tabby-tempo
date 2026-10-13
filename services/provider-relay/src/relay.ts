import { Contract, JsonRpcProvider, hexlify, randomBytes, ZeroAddress } from "ethers";
import { ACCOUNT_ABI, MANAGER_ABI, accountInterface, paymentId, requestDigest, sameAddress, uint,
  type ChatInput, type Json, type PaymentProof, type Quote } from "@agentfuel/sdk/protocol";
import { upstreamUrl, validateService, type RelayConfig, type TierRoute, type Upstream } from "./config.js";
import { Store, upstreamAttemptsDigest, validOperatorResolution, validResolutionInput, type PaymentRecord, type UpstreamAttempt } from "./store.js";

// Complete request/auth/route/size/quota rejections from the configured upstream.
// Timeouts, conflicts and server errors do not prove that inference never ran.
const REJECTED_HTTP_STATUSES = new Set([400, 401, 403, 404, 413, 415, 422, 429]);

export class RelayError extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export interface RelayOptions {
  provider?: JsonRpcProvider;
  upstreamFetch?: typeof fetch;
}
export class Relay {
  readonly provider: JsonRpcProvider;
  readonly account: Contract;
  readonly store: Store;
  private readonly ownsProvider: boolean;
  private readonly upstreamFetch?: typeof fetch;
  private readonly logScanChunkBlocks: number;
  constructor(readonly config: RelayConfig, options: RelayOptions = {}) {
    validateService(config.service);
    this.logScanChunkBlocks = config.logScanChunkBlocks ?? 1000;
    if (!Number.isInteger(this.logScanChunkBlocks) || this.logScanChunkBlocks < 1 || this.logScanChunkBlocks > 1000) {
      throw new Error("logScanChunkBlocks must be 1..1000");
    }
    this.ownsProvider = options.provider === undefined;
    this.provider = options.provider ?? new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 });
    this.upstreamFetch = options.upstreamFetch;
    this.account = new Contract(config.account, ACCOUNT_ABI, this.provider);
    this.store = new Store(config.dataDir);
  }
  close() { if (this.ownsProvider) this.provider.destroy(); }
  async chain() {
    if (BigInt(await this.provider.send("eth_chainId", [])) !== this.config.chainId) throw new RelayError("NETWORK_MISMATCH", "RPC chain differs from configuration");
  }
  async initialize() {
    await this.chain();
    const asset = await this.account.getFunction("settlementAsset").staticCall();
    if (!sameAddress(asset, this.config.asset)) throw new RelayError("ASSET_MISMATCH", "Account settlement asset differs");
    const decimals = sameAddress(asset, ZeroAddress) ? 18n : await new Contract(asset, ["function decimals() view returns(uint8)"], this.provider).getFunction("decimals").staticCall();
    if (decimals !== BigInt(this.config.assetDecimals)) throw new RelayError("DECIMALS_MISMATCH", "Asset precision differs");
    const manager = new Contract(await this.account.getFunction("creditManager").staticCall(), MANAGER_ABI, this.provider);
    if (!sameAddress(await manager.getFunction("agentAccount").staticCall(), this.config.account)) throw new RelayError("WIRING_MISMATCH", "Manager/Account connection differs");
  }
  validate(value: unknown, forQuote = true): ChatInput {
    const input = value as ChatInput;
    try {
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error();
      uint(input.agentId, "agentId"); uint(input.taskId, "taskId");
      if (typeof input.service !== "string" || !input.service || typeof input.model !== "string" || !input.model ||
        !Array.isArray(input.messages) || !input.messages.length || input.stream === true) throw new Error();
      requestDigest(input);
    } catch { throw new RelayError("INVALID_REQUEST", "Use service/model, nonempty messages and decimal agentId/taskId; streaming is not supported", 400); }
    if (input.tier !== undefined && input.tier !== "cheap" && input.tier !== "strong") throw new RelayError("INVALID_TIER", "Use cheap or strong tier", 400);
    if (forQuote) this.selectRoute(input);
    return input;
  }
  private selectRoute(input: ChatInput): TierRoute {
    const service = this.config.service;
    if (input.service !== service.id || input.model !== service.model) throw new RelayError("INVALID_REQUEST", "Use configured service/model", 400);
    if (service.tiers) {
      if (input.tier !== "cheap" && input.tier !== "strong") throw new RelayError("INVALID_TIER", "Tiered service requires cheap or strong", 400);
      validateService(service);
      return service.tiers[input.tier];
    }
    if (input.tier !== undefined) throw new RelayError("INVALID_TIER", "Legacy service does not configure tiers", 400);
    validateService(service);
    return service;
  }
  async quote(input: ChatInput): Promise<Quote> {
    this.validate(input);
    const selected = this.selectRoute(input);
    const route = { version: 1 as const, model: input.model, ...(input.tier ? { tier: input.tier } : {}),
      upstreams: selected.upstreams.map(({ name, model, baseUrl }) => ({ name, model, baseUrl: upstreamUrl(baseUrl) })) };
    const price = selected.price.toString();
    await this.chain();
    const block = (await this.provider.getBlock("latest"))!;
    const digest = requestDigest(input);
    const nonce = hexlify(randomBytes(32));
    const quote: Quote = { paymentId: paymentId(input.taskId, digest, nonce), agentId: input.agentId, taskId: input.taskId,
      requestDigest: digest, serverNonce: nonce, service: input.service, model: input.model,
      ...(input.tier ? { tier: input.tier } : {}), price, payTo: this.config.payTo, asset: this.config.asset,
      chainId: this.config.chainId.toString(), account: this.config.account, quoteExpiry: String(block.timestamp + this.config.quoteTtl), createdBlock: block.number };
    await this.store.write({ quote, request: input, route, state: "Quoted", refunds: [], upstreamAttempts: [] });
    return quote;
  }
  async record(id: string, agentId: string, digest: string) {
    let record: PaymentRecord;
    try { record = await this.store.read(id); } catch { throw new RelayError("QUOTE_NOT_FOUND", "Unknown quote", 404); }
    if (record.quote.agentId !== agentId || record.quote.requestDigest !== digest) throw new RelayError("REQUEST_MISMATCH", "Payment is bound to another agent/request");
    return record;
  }
  private assertRecord(record: PaymentRecord) {
    const { quote, request } = record;
    if (quote.chainId !== this.config.chainId.toString() || !sameAddress(quote.account, this.config.account) ||
      !sameAddress(quote.asset, this.config.asset) || !sameAddress(quote.payTo, this.config.payTo) ||
      request.agentId !== quote.agentId || request.taskId !== quote.taskId || quote.tier !== request.tier ||
      request.model !== quote.model || request.service !== quote.service || requestDigest(request) !== quote.requestDigest ||
      paymentId(quote.taskId, quote.requestDigest, quote.serverNonce) !== quote.paymentId) {
      throw new RelayError("STORE_BINDING_MISMATCH", "Persisted quote belongs to a different configuration or request");
    }
  }
  async proof(quote: Quote, hash: string): Promise<PaymentProof> {
    if (!/^0x[0-9a-fA-F]{64}$/.test(hash)) throw new RelayError("INVALID_PAYMENT", "Use a transaction hash", 400);
    await this.chain();
    const receipt = await this.provider.getTransactionReceipt(hash);
    if (!receipt || receipt.status !== 1 || !receipt.to || !sameAddress(receipt.to, this.config.account)) throw new RelayError("INVALID_PAYMENT", "Expected a successful direct Account payment receipt");
    const block = (await this.provider.getBlock(receipt.blockNumber))!;
    if (block.hash !== receipt.blockHash) throw new RelayError("PAYMENT_REORG", "Payment block is not canonical");
    if ((await this.provider.getBlockNumber()) - receipt.blockNumber + 1 < this.config.confirmations) throw new RelayError("PAYMENT_UNCONFIRMED", "Payment needs more confirmations", 425);
    if (receipt.blockNumber < quote.createdBlock) throw new RelayError("PAYMENT_BEFORE_QUOTE", "Payment predates the quote");
    const matches = receipt.logs.filter(log => sameAddress(log.address, this.config.account)).map(log => {
      try { return accountInterface.parseLog(log); } catch { return null; }
    }).filter(event => event?.name === "ProviderPaid" && event.args.paymentId === quote.paymentId);
    const event = matches[0];
    if (matches.length !== 1 || !event || event.args.agentId !== BigInt(quote.agentId) ||
      !sameAddress(event.args.provider, quote.payTo) || event.args.fromCash + event.args.fromCredit !== BigInt(quote.price)) {
      throw new RelayError("PAYMENT_MISMATCH", "ProviderPaid agent/provider/amount/paymentId does not match quote");
    }
    const transaction = await this.provider.getTransaction(hash);
    const call = transaction && accountInterface.parseTransaction({ data: transaction.data, value: transaction.value });
    if (!call || call.name !== "payProvider" || call.args[0] !== BigInt(quote.agentId) || !sameAddress(call.args[1], quote.payTo) ||
      call.args[2] !== BigInt(quote.price) || call.args[3] !== quote.paymentId ||
      (event.args.fromCredit > 0n && call.args[4].taskId !== BigInt(quote.taskId))) throw new RelayError("PAYMENT_MISMATCH", "Payment calldata does not match quote");
    return { txHash: hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, timestamp: block.timestamp,
      fromCash: event.args.fromCash.toString(), fromCredit: event.args.fromCredit.toString() };
  }
  async confirm(record: PaymentRecord, suppliedHash?: string) {
    this.assertRecord(record);
    if (record.state !== "Quoted") {
      if (suppliedHash && suppliedHash !== record.proof?.txHash) throw new RelayError("PAYMENT_MISMATCH", "Payment already confirmed with another transaction");
      return;
    }
    let hash = suppliedHash;
    if (!hash) {
      await this.chain();
      const payment = await this.account.getFunction("getPayment").staticCall(record.quote.paymentId);
      // A payment and its event are committed atomically. Refunds retain the
      // original amounts, so only the untouched record can skip log discovery.
      if (payment.agentId === 0n && payment.taskId === 0n && payment.fromCash === 0n &&
        payment.fromCredit === 0n && payment.refundedAmount === 0n) return;
      const filter = this.account.filters.ProviderPaid(record.quote.agentId, record.quote.payTo, record.quote.paymentId);
      const confirmedHead = (await this.provider.getBlockNumber()) - this.config.confirmations + 1;
      for (let from = record.scanBlock ?? record.quote.createdBlock; from <= confirmedHead; from = record.scanBlock!) {
        const end = Math.min(from + this.logScanChunkBlocks - 1, confirmedHead);
        const events = await this.account.queryFilter(filter, from, end);
        hash = events[0]?.transactionHash;
        if (hash) break;
        record.scanBlock = end + 1; await this.store.write(record);
      }
    }
    if (!hash) return;
    record.proof = await this.proof(record.quote, hash);
    record.expiredPayment = BigInt(record.proof.timestamp) > BigInt(record.quote.quoteExpiry);
    record.state = "Paid";
    await this.store.write(record);
  }
  isDeliveryUncertain(record: PaymentRecord) {
    if (record.state === "Delivered" || record.state === "Refunded") return false;
    return record.upstreamAttempts?.some(attempt => attempt.state !== "Rejected") ||
      (record.upstreamAttempts === undefined && (record.state === "Processing" || record.lastError === "UPSTREAM_FAILED"));
  }
  async resolveUndelivered(input: unknown) {
    if (!validResolutionInput(input)) throw new RelayError("INVALID_OPERATOR_RESOLUTION", "Use paymentId, resolutionId, expectedAttemptsDigest and evidenceDigest only", 400);
    return this.store.lock(input.paymentId, async () => {
      let record: PaymentRecord;
      try { record = await this.store.read(input.paymentId); } catch { throw new RelayError("QUOTE_NOT_FOUND", "Unknown quote", 404); }
      this.assertRecord(record);
      if (record.operatorResolution) {
        const saved = record.operatorResolution;
        if (!validOperatorResolution(record) || ["paymentId", "resolutionId", "expectedAttemptsDigest", "evidenceDigest"].some(key => saved[key as keyof typeof input] !== input[key as keyof typeof input]))
          throw new RelayError("OPERATOR_RESOLUTION_CONFLICT", "Original operator decision is immutable");
        return this.view(record);
      }
      if (!record.proof || record.state !== "Processing" || record.result !== undefined || record.receipt !== undefined || record.refunds.length ||
        !record.upstreamAttempts?.some(attempt => attempt.state === "Unknown") || record.upstreamAttempts.some(attempt => !["Unknown", "Rejected"].includes(attempt.state)))
        throw new RelayError("OPERATOR_RESOLUTION_NOT_ALLOWED", "Only a confirmed, undelivered Unknown dispatch with no refund or active dispatch can be resolved");
      if (upstreamAttemptsDigest(record.upstreamAttempts) !== input.expectedAttemptsDigest) throw new RelayError("OPERATOR_RESOLUTION_CONFLICT", "Dispatch evidence changed");
      // Revalidate the original canonical payment, including external refunds.
      await this.proof(record.quote, record.proof.txHash);
      const payment = await this.account.getFunction("getPayment").staticCall(input.paymentId);
      if (payment.agentId !== BigInt(record.quote.agentId) || payment.fromCash + payment.fromCredit !== BigInt(record.quote.price) || payment.refundedAmount !== 0n)
        throw new RelayError("OPERATOR_RESOLUTION_NOT_ALLOWED", "Payment is missing or already refunded");
      record.operatorResolution = { version: 1, ...input, reason: "operator-accepted-nondelivery-cost", resolvedAt: Date.now() };
      await this.store.write(record); // Preserve the Unknown evidence; this permanently disables dispatch.
      return this.view(record);
    });
  }
  async compensateAllowance(_input: unknown): Promise<ReturnType<Relay["view"]>> { throw new RelayError("ALLOWANCE_COMPENSATION_DISABLED", "Only the allowance relay with a trusted sealed-ledger verifier supports compensation"); }
  async verifyCompensation(_record: PaymentRecord): Promise<void> { throw new RelayError("ALLOWANCE_COMPENSATION_DISABLED", "A trusted sealed-ledger verifier is required"); }
  view(record: PaymentRecord) { return { state: record.operatorCompensation && record.state === "Delivered" ? "CompensationPending" : record.state, paymentId: record.quote.paymentId, expiredPayment: Boolean(record.expiredPayment), refundPending: record.refunds.length > 0 && record.state !== "Refunded",
    refundedAmount: record.refunds.filter(refund => refund.state === "Confirmed").reduce((sum, refund) => sum + BigInt(refund.amount), 0n).toString(),
    confirmedRefunds: record.refunds.filter(refund => refund.state === "Confirmed" && refund.transaction).map(refund => ({ refundId: refund.id, amount: refund.amount, txHash: refund.transaction!.txHash })),
    ...(this.isDeliveryUncertain(record) ? { deliveryError: "UPSTREAM_UNCERTAIN" } : record.lastError ? { deliveryError: record.lastError } : {}),
    ...(record.upstreamAttempts?.length ? { upstreamAttempts: record.upstreamAttempts } : {}),
    ...(record.operatorResolution ? { operatorResolution: record.operatorResolution } : {}),
    ...(record.operatorCompensation ? { operatorCompensation: record.operatorCompensation, originalDelivery: { result: record.result, receipt: record.receipt } } : {}),
    ...(record.state === "Delivered" && !record.operatorCompensation ? { result: record.result, receipt: record.receipt } : {}) }; }
  async status(id: string, agentId: string, digest: string) {
    const peek = await this.record(id, agentId, digest);
    if (peek.state === "Processing") { this.assertRecord(peek); return this.view(peek); }
    return this.store.lock(id, async () => {
      const record = await this.record(id, agentId, digest); await this.confirm(record);
      const view = this.view(record);
      if (record.state === "Quoted") {
        try { this.pinnedUpstreams(record); }
        catch (error) { if (!(error instanceof RelayError)) throw error; return { ...view, deliveryError: error.code }; }
      }
      return view;
    });
  }
  async chat(input: ChatInput, id: string, hash?: string) {
    this.validate(input, false);
    return this.store.lock(id, async () => {
      const record = await this.record(id, input.agentId, requestDigest(input));
      await this.confirm(record, hash);
      if (record.state === "Quoted") throw new RelayError("PAYMENT_REQUIRED", "Payment not confirmed", 402);
      return this.deliver(record);
    });
  }
  async deliver(record: PaymentRecord) {
    this.assertRecord(record);
    if (record.operatorCompensation) throw new RelayError("ALLOWANCE_COMPENSATED", "Original delivered allowance is permanently closed for operator compensation");
    if (record.operatorResolution) throw new RelayError("OPERATOR_RESOLVED_UNDELIVERED", "Operator accepted unknown vendor cost; this payment can only be fully refunded, never dispatched again");
    if (record.state === "Delivered") return { result: record.result, receipt: record.receipt };
    if (this.isDeliveryUncertain(record)) {
      record.state = "Processing"; record.lastError = "UPSTREAM_UNCERTAIN"; await this.store.write(record);
      throw new RelayError("UPSTREAM_UNCERTAIN", "Original dispatch needs operator reconciliation; no new upstream request or automatic refund is allowed");
    }
    if (record.expiredPayment) throw new RelayError("PAYMENT_AFTER_EXPIRY", "Late payment is recorded for operator refund, not inference");
    if (record.state === "Refunded" || record.refunds.length) throw new RelayError("REFUND_IN_PROGRESS", "Payment is being refunded; inference is disabled");
    let candidates: Upstream[];
    try { candidates = this.pinnedUpstreams(record); }
    catch (error) {
      if (!(error instanceof RelayError)) throw error;
      record.state = "Paid"; record.lastError = error.code; await this.store.write(record);
      throw error;
    }
    record.upstreamAttempts ??= [];
    record.state = "Processing";
    await this.store.write(record); // Original request is durable before any upstream call.
    const { agentId: _agent, taskId: _task, service: _service, tier: _tier, ...inference } = record.request;
    for (const upstream of candidates) {
      if (record.upstreamAttempts.some(attempt => attempt.upstream === upstream.name && attempt.model === upstream.model)) continue;
      const attempt: UpstreamAttempt = { upstream: upstream.name, model: upstream.model, startedAt: Date.now(), state: "Dispatching" };
      record.upstreamAttempts.push(attempt);
      await this.store.write(record); // A crash after this point cannot prove the vendor did not receive the request.
      let response: Response;
      let result: Record<string, Json>;
      try {
        response = await (this.upstreamFetch ?? fetch)(`${upstream.baseUrl.replace(/\/$/, "")}/chat/completions`, { method: "POST",
          headers: { "content-type": "application/json", authorization: `Bearer ${upstream.key}` },
          body: JSON.stringify({ ...inference, model: upstream.model }), signal: AbortSignal.timeout(this.config.upstreamTimeout) });
      } catch { return this.uncertain(record, attempt, "NETWORK_OR_TIMEOUT"); }
      attempt.httpStatus = response.status;
      if (!response.ok) {
        if (!REJECTED_HTTP_STATUSES.has(response.status)) {
          await response.body?.cancel().catch(() => {});
          return this.uncertain(record, attempt, "HTTP_STATUS");
        }
        try { await response.text(); } // A truncated rejection response is also unknown.
        catch { return this.uncertain(record, attempt, "NETWORK_OR_TIMEOUT"); }
        attempt.state = "Rejected"; attempt.reason = "HTTP_STATUS";
        await this.store.write(record); // Only a durable rejection permits the next locked candidate.
        continue;
      }
      try {
        result = await response.json() as Record<string, Json>;
        if (!result || !Array.isArray(result.choices) || !result.choices.length || result.error) throw new Error();
      } catch { return this.uncertain(record, attempt, "INVALID_RESPONSE"); }
      record.result = result;
      record.receipt = { ...record.proof!, paymentId: record.quote.paymentId, agentId: record.quote.agentId, taskId: record.quote.taskId,
        requestDigest: record.quote.requestDigest, service: record.quote.service, price: record.quote.price,
        asset: record.quote.asset, chainId: record.quote.chainId, account: record.quote.account, payTo: record.quote.payTo,
        ...(record.quote.tier ? { tier: record.quote.tier } : {}), upstream: upstream.name, model: upstream.model, usage: result.usage || null };
      attempt.state = "Delivered";
      record.state = "Delivered"; delete record.lastError;
      await this.store.write(record); // Storage failure is not another upstream failure.
      return { result: record.result, receipt: record.receipt };
    }
    record.state = "Paid"; record.lastError = "UPSTREAM_FAILED"; await this.store.write(record);
    throw new RelayError("UPSTREAM_FAILED", "All available upstreams explicitly rejected the request; operator refund is available", 502);
  }
  private async uncertain(record: PaymentRecord, attempt: UpstreamAttempt, reason: UpstreamAttempt["reason"]): Promise<never> {
    attempt.state = "Unknown"; attempt.reason = reason;
    record.state = "Processing"; record.lastError = "UPSTREAM_UNCERTAIN";
    await this.store.write(record);
    throw new RelayError("UPSTREAM_UNCERTAIN", "Original dispatch needs operator reconciliation; no new upstream request or automatic refund is allowed");
  }
  private pinnedUpstreams(record: PaymentRecord): Upstream[] {
    const { route, quote } = record;
    if (!route) throw new RelayError("ROUTE_SNAPSHOT_REQUIRED", "Legacy undelivered quote has no route snapshot; operator refund is available");
    if (route.version !== 1 || route.model !== quote.model || route.tier !== quote.tier ||
      !Array.isArray(route.upstreams) || !route.upstreams.length || route.upstreams.length > 4) {
      throw new RelayError("ROUTE_BINDING_MISMATCH", "Persisted route does not match the original quote");
    }
    const service = this.config.service;
    const current = service.id === quote.service && service.model === quote.model ?
      (quote.tier ? service.tiers?.[quote.tier] : !service.tiers ? service : undefined) : undefined;
    const candidates = route.upstreams.flatMap(pinned => {
      const match = current?.upstreams.find(upstream => upstream.name === pinned.name && upstream.model === pinned.model &&
        upstreamUrl(upstream.baseUrl) === pinned.baseUrl);
      return match ? [{ ...match, baseUrl: pinned.baseUrl }] : [];
    });
    if (!candidates.length) throw new RelayError("ROUTE_UNAVAILABLE", "Original tier/model candidates are unavailable; restore that route or request an operator refund");
    return candidates;
  }
  async recover() {
    for (const id of await this.store.ids()) await this.store.lock(id, async () => {
      const record = await this.store.read(id);
      if (record.refunds.length || record.state === "Delivered" || record.state === "Refunded") return;
      try { await this.confirm(record); if (record.state === "Paid" || record.state === "Processing") await this.deliver(record); }
      catch (error) { if (!(error instanceof RelayError)) throw error; }
    });
  }
}
