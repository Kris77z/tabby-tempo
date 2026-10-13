import { Contract, JsonRpcApiProvider, JsonRpcProvider, Wallet, isError, keccak256, randomBytes, type Signer, type TransactionReceipt, type TransactionRequest } from "ethers";
import { ACCOUNT_ABI, EMPTY_AUTH, MANAGER_ABI, PaymentError, accountInterface, contractError, paymentId,
  requestDigest, sameAddress, uint, type ChatInput, type InferenceReceipt, type Json, type Quote, type RoutingTier } from "./protocol.js";
export * from "./protocol.js";

export interface PaymentHandle {
  version: 1; relayUrl: string; input: ChatInput; quote: Quote; creditNonce: string;
  submission?: { from: string; nonce: number; txHash?: string; rawTransaction?: string;
    revertedReceipt?: { txHash: string; status: 0; blockNumber: number; blockHash: string; gasUsed: string } };
}
export interface InferOptions {
  agentId: string; rpcUrl?: string; chainId: bigint; account: string; asset: string; provider: string; maxPrice: bigint;
  sessionKey?: string; signer?: Signer; underwriterUrl?: string; timeoutMs?: number;
  onHandle?: (handle: PaymentHandle) => Promise<void> | void;
  beforePayment?: (handle: PaymentHandle) => Promise<void> | void;
}
export interface FetchOptions { body: Record<string, Json> & { service: string; model: string; messages: Json[]; tier?: RoutingTier } }
export interface Inference { result: Json; receipt: InferenceReceipt; handle: PaymentHandle }

export class InferCredit {
  private readonly rpc: JsonRpcApiProvider;
  private readonly ownsRpc: boolean;
  private readonly signer: Signer;
  private readonly account: Contract;
  private readonly locks = new Map<string, Promise<Inference>>();
  private walletQueue: Promise<unknown> = Promise.resolve();
  constructor(private readonly options: InferOptions) {
    uint(options.agentId, "agentId");
    if (Boolean(options.sessionKey) === Boolean(options.signer)) throw new Error("Provide exactly one signer or sessionKey");
    if (options.maxPrice <= 0n) throw new Error("maxPrice must be positive");
    if (!options.rpcUrl && !(options.signer?.provider instanceof JsonRpcApiProvider)) throw new Error("Provide rpcUrl or a Browser/JSON-RPC signer provider");
    this.ownsRpc = Boolean(options.rpcUrl);
    this.rpc = options.rpcUrl ? new JsonRpcProvider(options.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 }) : options.signer!.provider as JsonRpcApiProvider;
    this.signer = options.signer || new Wallet(options.sessionKey!, this.rpc);
    this.account = new Contract(options.account, ACCOUNT_ABI, this.rpc);
  }
  close() { if (this.ownsRpc) this.rpc.destroy(); }
  forTask(taskId: string) { uint(taskId, "taskId"); return { fetch: (url: string, init: FetchOptions) => this.fetchFor(taskId, url, init) }; }
  fetch(url: string, init: FetchOptions) { return this.fetchFor("0", url, init); }

  private async chain() {
    if (BigInt(await this.rpc.send("eth_chainId", [])) !== this.options.chainId) throw new PaymentError("NETWORK_MISMATCH", "RPC is on the wrong chain");
    if (this.signer.provider && (await this.signer.provider.getNetwork()).chainId !== this.options.chainId) {
      throw new PaymentError("SIGNER_NETWORK_MISMATCH", "Wallet is on the wrong chain");
    }
    if (!sameAddress(await this.account.getFunction("settlementAsset").staticCall(), this.options.asset)) throw new PaymentError("ASSET_MISMATCH", "Account uses a different asset");
  }
  private validateQuote(quote: Quote, input: ChatInput) {
    try {
      if (uint(quote.chainId, "chainId") !== this.options.chainId || !sameAddress(quote.account, this.options.account) ||
        !sameAddress(quote.asset, this.options.asset) || !sameAddress(quote.payTo, this.options.provider) ||
        quote.agentId !== input.agentId || quote.taskId !== input.taskId || quote.service !== input.service || quote.model !== input.model || quote.tier !== input.tier ||
        (quote.tier !== undefined && quote.tier !== "cheap" && quote.tier !== "strong") ||
        quote.requestDigest !== requestDigest(input) || quote.paymentId !== paymentId(input.taskId, quote.requestDigest, quote.serverNonce) ||
        uint(quote.price, "price") === 0n || BigInt(quote.price) > this.options.maxPrice ||
        uint(quote.quoteExpiry, "quoteExpiry") === 0n || !Number.isSafeInteger(quote.createdBlock) || quote.createdBlock < 0) throw new Error();
    } catch { throw new PaymentError("UNTRUSTED_QUOTE", "Quote does not match expected request, chain, account, asset, provider or price ceiling"); }
  }
  private async saved(handle: PaymentHandle) { await this.options.onHandle?.(structuredClone(handle)); }
  private async http(url: string, init?: RequestInit) {
    try { return await fetch(url, { ...init, signal: AbortSignal.timeout(this.options.timeoutMs || 15_000) }); }
    catch { throw new PaymentError("RELAY_UNAVAILABLE", "Relay request failed; resume the same payment handle"); }
  }
  private async fetchFor(taskId: string, url: string, init: FetchOptions): Promise<Inference> {
    await this.chain();
    const input = { ...init.body, agentId: this.options.agentId, taskId } as ChatInput;
    const first = await this.http(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(input) });
    if (first.status !== 402) throw new PaymentError("QUOTE_REQUIRED", "Relay must return a bound 402 quote before payment");
    const quote = (await first.json() as { quote: Quote }).quote;
    this.validateQuote(quote, input);
    const handle: PaymentHandle = { version: 1, relayUrl: url, input, quote, creditNonce: BigInt(keccak256(randomBytes(32))).toString() };
    await this.saved(handle);
    return this.resume(handle);
  }

  resume(handle: PaymentHandle): Promise<Inference> {
    this.validateQuote(handle.quote, handle.input);
    if (handle.version !== 1 || handle.input.agentId !== this.options.agentId) throw new PaymentError("HANDLE_MISMATCH", "Handle belongs to a different agent");
    const existing = this.locks.get(handle.quote.paymentId);
    if (existing) return existing;
    const work = this.finish(handle).catch(async error => {
      // wait() throws rather than returning a status-0 receipt. Verify that
      // original transaction against its canonical block before classifying it.
      if (isError(error, "CALL_EXCEPTION") && error.receipt?.status === 0) {
        try { await this.rejectRevertedPayment(handle, error.receipt); }
        catch (verified) { error = verified; }
      }
      if (error instanceof PaymentError) { error.handle = structuredClone(handle); throw error; }
      const decoded = contractError(error); decoded.handle = structuredClone(handle); throw decoded;
    });
    this.locks.set(handle.quote.paymentId, work);
    void work.finally(() => { if (this.locks.get(handle.quote.paymentId) === work) this.locks.delete(handle.quote.paymentId); }).catch(() => {});
    return work;
  }
  private async rejectRevertedPayment(handle: PaymentHandle, receipt: TransactionReceipt) {
    if (receipt.status !== 0 || receipt.hash !== handle.submission?.txHash) return;
    const block = await this.rpc.getBlock(receipt.blockNumber);
    if (!block || block.hash !== receipt.blockHash) throw new PaymentError("PAYMENT_UNCERTAIN", "Reverted payment receipt is not confirmed in its canonical block");
    handle.submission.revertedReceipt = { txHash: receipt.hash, status: 0, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, gasUsed: receipt.gasUsed.toString() };
    await this.saved(handle);
    throw new PaymentError("PAYMENT_REVERTED", "Original payment transaction reverted; no funds were delivered and this handle will not sign or pay again");
  }
  private async confirmSubmittedReceipt(handle: PaymentHandle, receipt: TransactionReceipt | null) {
    if (!receipt) throw new PaymentError("PAYMENT_UNCERTAIN", "Submitted payment has no confirmed receipt; resume this handle without signing another transaction");
    if (receipt.status === 0) await this.rejectRevertedPayment(handle, receipt);
    if (receipt.status !== 1) throw new PaymentError("PAYMENT_UNCERTAIN", "Submitted payment receipt has no confirmed success or canonical revert");
  }
  private statusUrl(handle: PaymentHandle) {
    const url = new URL(handle.relayUrl); url.pathname = `/payments/${handle.quote.paymentId}`;
    url.search = new URLSearchParams({ agentId: handle.input.agentId, requestDigest: handle.quote.requestDigest }).toString();
    return url.href;
  }
  private async finish(handle: PaymentHandle): Promise<Inference> {
    await this.chain();
    const status = await this.http(this.statusUrl(handle));
    const view = await status.json() as { state: string; result?: Json; receipt?: InferenceReceipt; error?: string; deliveryError?: string };
    if (!status.ok) throw new PaymentError(view.error || "PAYMENT_REJECTED", "Relay could not confirm this payment");
    if (view.state === "Refunded") throw new PaymentError("REFUNDED", "Payment has been refunded");
    if (view.state === "Delivered") return { result: view.result!, receipt: view.receipt!, handle };
    if (view.state === "Quoted") {
      if (view.deliveryError) throw new PaymentError(view.deliveryError, "Original quote route is unavailable; no payment was submitted");
      const work = this.walletQueue.catch(() => {}).then(() => this.pay(handle));
      this.walletQueue = work;
      await work;
    }
    const delivered = await this.http(handle.relayUrl, { method: "POST", headers: { "content-type": "application/json",
      "x-payment-id": handle.quote.paymentId, ...(handle.submission?.txHash ? { "x-payment-tx": handle.submission.txHash } : {}) }, body: JSON.stringify(handle.input) });
    const body = await delivered.json() as { result: Json; receipt: InferenceReceipt; error?: string };
    if (!delivered.ok) throw new PaymentError(body.error || "DELIVERY_PENDING", "Delivery is pending; resume the same payment handle");
    return { result: body.result, receipt: body.receipt, handle };
  }
  private async assertQuoteLive(quote: Quote) {
    // A stalled/local chain's last mined block can lag real time. Neither clock may
    // authorize a new signature or broadcast after the quote's expiry.
    const block = await this.rpc.getBlock("latest");
    if (!block) throw new PaymentError("PAYMENT_UNCERTAIN", "Latest block unavailable before payment");
    if (BigInt(block.timestamp) > BigInt(quote.quoteExpiry) || BigInt(Math.floor(Date.now() / 1000)) > BigInt(quote.quoteExpiry))
      throw new PaymentError("QUOTE_EXPIRED", "Unpaid quote expired; reconcile the original handle without sending payment");
  }
  private async pay(handle: PaymentHandle) {
    const quote = handle.quote;
    const record = await this.account.getFunction("getPayment").staticCall(quote.paymentId);
    if (record.fromCash + record.fromCredit > 0n) return; // Relay must prove its provider/amount; never pay this id again.
    if (handle.submission) {
      if (handle.submission.txHash) {
        const receipt = await this.rpc.getTransactionReceipt(handle.submission.txHash);
        if (receipt?.status === 0) await this.rejectRevertedPayment(handle, receipt);
        if (receipt) return;
      }
      await this.options.beforePayment?.(structuredClone(handle));
      if (!handle.submission.rawTransaction) throw new PaymentError("PAYMENT_UNCERTAIN", "Wallet submission is uncertain; no second send is allowed");
      if (handle.submission.txHash && await this.rpc.getTransaction(handle.submission.txHash)) throw new PaymentError("PAYMENT_PENDING", "Recorded payment is known to the chain; wait for its receipt");
      await this.assertQuoteLive(quote);
      const currentNonce = await this.rpc.getTransactionCount(handle.submission.from, "latest");
      if (currentNonce > handle.submission.nonce) throw new PaymentError("PAYMENT_UNCERTAIN", "Nonce was consumed but payment is not confirmed");
      await this.broadcast(handle); // Exactly the same signed bytes, never another payment transaction.
      return;
    }
    await this.options.beforePayment?.(structuredClone(handle));
    await this.assertQuoteLive(quote);
    const adapter = new Contract(await this.account.getFunction("adapter").staticCall(), ["function resolveAgent(uint256) view returns(address owner,address wallet)"], this.rpc);
    const identity = await adapter.getFunction("resolveAgent").staticCall(this.options.agentId);
    const from = await this.signer.getAddress();
    if (!sameAddress(from, identity.wallet)) throw new PaymentError("NotAgentWallet", "Signer is not the current registry wallet");
    const cash: bigint = await this.account.getFunction("cash").staticCall(this.options.agentId);
    let auth: Record<string, unknown> = EMPTY_AUTH;
    let signature = "0x";
    if (cash < BigInt(quote.price)) {
      if (quote.taskId === "0") throw new PaymentError("CASH_REQUIRED", "Without a task, only cash payment is allowed");
      const manager = new Contract(await this.account.getFunction("creditManager").staticCall(), MANAGER_ABI, this.rpc);
      if ((await manager.getFunction("getLoan").staticCall(quote.taskId)).status !== 0n) throw new PaymentError("TASK_ALREADY_BORROWED", "A task cannot draw a second loan, even with a different nonce");
      if (!this.options.underwriterUrl) throw new PaymentError("UNDERWRITER_REQUIRED", "Cash shortfall requires an underwriter");
      const response = await this.http(`${this.options.underwriterUrl.replace(/\/$/, "")}/authorize`, { method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ agentId: quote.agentId, taskId: quote.taskId, nonce: handle.creditNonce }) });
      const body = await response.json() as { authorization: Record<string, unknown>; signature: string; error?: string };
      if (!response.ok) throw new PaymentError(body.error || "AUTHORIZATION_REJECTED", "Underwriter rejected authorization");
      auth = body.authorization; signature = body.signature;
      if (auth.agentId !== quote.agentId || auth.taskId !== quote.taskId || auth.nonce !== handle.creditNonce ||
        BigInt(String(auth.principalCap)) < BigInt(quote.price) - cash) throw new PaymentError("AUTHORIZATION_MISMATCH", "Authorization does not cover the payment");
    }
    const request: TransactionRequest = { to: this.options.account, chainId: this.options.chainId,
      data: accountInterface.encodeFunctionData("payProvider", [quote.agentId, quote.payTo, quote.price, quote.paymentId, auth, signature]) };
    const populated = await this.signer.populateTransaction(request);
    await this.options.beforePayment?.(structuredClone(handle));
    await this.assertQuoteLive(quote);
    handle.submission = { from, nonce: Number(populated.nonce) };
    if (this.signer instanceof Wallet) {
      handle.submission.rawTransaction = await this.signer.signTransaction(populated);
      handle.submission.txHash = keccak256(handle.submission.rawTransaction);
      await this.saved(handle);
      await this.broadcast(handle);
    } else {
      await this.saved(handle); // Browser wallet intent is durable before eth_sendTransaction.
      await this.options.beforePayment?.(structuredClone(handle));
      await this.assertQuoteLive(quote);
      let sent;
      try { sent = await this.signer.sendTransaction(populated); }
      catch (error) {
        if (isError(error, "ACTION_REJECTED") || (error as { code?: unknown })?.code === 4001) {
          delete handle.submission; await this.saved(handle);
          throw new PaymentError("WALLET_REJECTED", "Wallet explicitly rejected signing; the same handle can be resumed");
        }
        throw error;
      }
      handle.submission.txHash = sent.hash;
      await this.saved(handle);
      const receipt = await sent.wait(1, this.options.timeoutMs || 15_000);
      await this.confirmSubmittedReceipt(handle, receipt);
    }
  }
  private async broadcast(handle: PaymentHandle) {
    await this.options.beforePayment?.(structuredClone(handle));
    await this.assertQuoteLive(handle.quote);
    const sent = await this.rpc.broadcastTransaction(handle.submission!.rawTransaction!);
    const receipt = await sent.wait(1, this.options.timeoutMs || 15_000);
    await this.confirmSubmittedReceipt(handle, receipt);
  }
}
