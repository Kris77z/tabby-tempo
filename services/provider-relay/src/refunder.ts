import { Contract, Wallet, keccak256, ZeroAddress } from "ethers";
import { setTimeout as delay } from "node:timers/promises";
import { MANAGER_ABI, managerInterface, sameAddress, uint } from "@agentfuel/sdk/protocol";
import { Relay, RelayError } from "./relay.js";
import { validOperatorResolution, validOperatorCompensation, type PaymentRecord, type Refund, type SignedOperation } from "./store.js";
export interface RefunderOptions { maxFeePerGas?: bigint; gasLimit?: bigint; serialize?: <T>(operation:()=>Promise<T>)=>Promise<T> }

export class Refunder {
  private readonly wallet?: Wallet;
  private queue: Promise<unknown> = Promise.resolve();
  constructor(private readonly relay: Relay, private readonly limits: RefunderOptions = {}) {
    if ((limits.maxFeePerGas !== undefined && limits.maxFeePerGas <= 0n) || (limits.gasLimit !== undefined && limits.gasLimit <= 0n)) throw new Error("INVALID_GAS_CEILING");
    if (relay.config.refunderKey) this.wallet = new Wallet(relay.config.refunderKey, relay.provider);
  }
  private async manager() {
    if (!this.wallet) throw new RelayError("REFUND_DISABLED", "Configure the dedicated refunder key to use operator refunds", 503);
    await this.relay.chain();
    const address = await this.relay.account.getFunction("creditManager").staticCall();
    const manager = new Contract(address, MANAGER_ABI, this.relay.provider);
    if (!sameAddress(await manager.getFunction("relayRefunder").staticCall(), this.wallet.address)) throw new RelayError("REFUNDER_MISMATCH", "Signer is not Manager.relayRefunder");
    return manager;
  }
  async initialize() { if (this.wallet) await this.manager(); }
  private assertResolvedRefund(record: PaymentRecord, refundId: string, amount: string) {
    if (record.operatorCompensation) {
      if (!validOperatorCompensation(record)) throw new RelayError("ALLOWANCE_COMPENSATION_CONFLICT", "Invalid delivered-allowance compensation decision");
      if (amount !== record.quote.price || record.refunds.length > 1 || record.refunds.some(refund => refund.id !== refundId || refund.amount !== amount))
        throw new RelayError("OPERATOR_REFUND_FULL_ONLY", "Compensation requires one full original-price refund");
      return;
    }
    if (!record.operatorResolution) {
      if (this.relay.isDeliveryUncertain(record)) throw new RelayError("UPSTREAM_UNCERTAIN", "Reconcile the original dispatch before deciding delivery or refund");
      return;
    }
    if (!validOperatorResolution(record)) throw new RelayError("OPERATOR_RESOLUTION_CONFLICT", "Operator resolution no longer matches original unknown evidence");
    if (amount !== record.quote.price || record.refunds.length > 1 || record.refunds.some(refund => refund.id !== refundId || refund.amount !== amount))
      throw new RelayError("OPERATOR_REFUND_FULL_ONLY", "Operator-resolved unknown payment requires one full original-price refund");
  }
  refund(paymentId: string, refundId: string, amount: string) {
    try {
      if (typeof paymentId !== "string" || !/^0x[0-9a-f]{64}$/.test(paymentId) || typeof refundId !== "string" || !/^0x[0-9a-f]{64}$/.test(refundId) || uint(amount, "amount") === 0n) throw new Error();
    } catch { throw new RelayError("INVALID_REFUND", "Use bytes32 paymentId/refundId and positive decimal amount", 400); }
    const work = () => this.relay.store.lock(paymentId, async () => {
      const record = await this.relay.store.read(paymentId);
      await this.manager();
      await this.relay.confirm(record);
      if (record.state === "Quoted" || record.state === "Delivered" && !record.operatorCompensation) throw new RelayError("REFUND_NOT_ALLOWED", "Delivered inference requires a verified allowance compensation decision");
      this.assertResolvedRefund(record, refundId, amount);
      if (record.operatorCompensation) await this.relay.verifyCompensation(record);
      if (record.operatorResolution) await this.relay.proof(record.quote, record.proof!.txHash);
      let entry = record.refunds.find(refund => refund.id === refundId);
      if (entry && entry.amount !== amount) throw new RelayError("REFUND_MISMATCH", "RefundId is already bound to another amount");
      if (!entry) {
        if (await this.relay.account.getFunction("refundConsumed").staticCall(refundId)) throw new RelayError("REFUND_ID_USED", "RefundId was already consumed outside this payment journal");
        const reserved = record.refunds.reduce((sum, refund) => sum + BigInt(refund.amount), 0n);
        if (reserved + BigInt(amount) > BigInt(record.quote.price)) throw new RelayError("REFUND_EXCEEDS_PAYMENT", "Refund total exceeds original payment");
        entry = { id: refundId, amount, state: "Prepared" };
        record.refunds.push(entry);
        await this.relay.store.write(record); // Disables inference before any refund submission.
      }
      await this.finish(record, entry, true);
      return { ...this.relay.view(record), refundId, txHash: entry.transaction?.txHash };
    });
    const operation = this.queue.catch(() => {}).then(() => this.limits.serialize ? this.limits.serialize(work) : work());
    this.queue = operation;
    return operation;
  }
  private async signed(contract: Contract, method: string, args: unknown[], value = 0n): Promise<SignedOperation> {
    const request = { to: await contract.getAddress(), chainId: this.relay.config.chainId,
      data: contract.interface.encodeFunctionData(method, args), value,
      ...(this.limits.gasLimit !== undefined && this.relay.config.chainId !== 42431n ? { gasLimit: method === "approve" ? 100000n : this.limits.gasLimit } : {}) };
    const populated = await this.wallet!.populateTransaction(request);
    if (this.relay.config.chainId === 42431n) {
      populated.gasLimit = (BigInt(populated.gasLimit!) * 120n + 99n) / 100n;
      if (populated.gasLimit > (this.limits.gasLimit ?? 10_000_000n)) throw new RelayError("GAS_CEILING_EXCEEDED", "Refund gas exceeds its configured ceiling");
    }
    if (this.limits.maxFeePerGas !== undefined && BigInt(populated.maxFeePerGas ?? populated.gasPrice ?? 0n) > this.limits.maxFeePerGas) throw new RelayError("GAS_CEILING_EXCEEDED", "Refund fee exceeds its configured ceiling");
    const rawTransaction = await this.wallet!.signTransaction(populated);
    return { rawTransaction, txHash: keccak256(rawTransaction), nonce: Number(populated.nonce) };
  }
  private async execute(operation: SignedOperation) {
    const provider = this.relay.provider;
    let receipt = await provider.getTransactionReceipt(operation.txHash);
    if (!receipt) {
      const currentNonce = await provider.getTransactionCount(this.wallet!.address, "latest");
      if (currentNonce > operation.nonce) throw new RelayError("REFUND_UNCERTAIN", "Refund nonce consumed without its recorded receipt; do not submit another refund");
      try { await provider.broadcastTransaction(operation.rawTransaction); }
      catch {
        if (!await provider.getTransaction(operation.txHash)) throw new RelayError("REFUND_UNCERTAIN", "Refund broadcast is uncertain; retry the same refundId");
      }
      // A block subscription can bootstrap after the automined block. Poll only
      // this durable hash, with the same timeout and confirmation requirement;
      // neither a delayed receipt nor timeout creates another signature/send.
      const deadline = Date.now() + 15_000, timer = new AbortController();
      const expired = delay(15_000, undefined, { signal: timer.signal }).then(() => { throw new RelayError("REFUND_UNCONFIRMED", "Refund confirmation is pending"); });
      const poll = async () => {
        do {
          const found = await provider.getTransactionReceipt(operation.txHash);
          if (found && (found.status === 0 || (await provider.getBlockNumber()) - found.blockNumber + 1 >= this.relay.config.confirmations)) return found;
          const remaining = deadline - Date.now(); if (remaining > 0) await delay(Math.min(100, remaining));
        } while (Date.now() < deadline);
        throw new RelayError("REFUND_UNCONFIRMED", "Refund confirmation is pending");
      };
      try { receipt = await Promise.race([poll(), expired]); }
      finally { timer.abort(); }
    }
    if (!receipt) throw new RelayError("REFUND_UNCONFIRMED", "Refund confirmation is pending");
    if (receipt.status !== 1) throw new RelayError("REFUND_REVERTED", "Recorded refund transaction reverted");
    if ((await provider.getBlockNumber()) - receipt.blockNumber + 1 < this.relay.config.confirmations) throw new RelayError("REFUND_UNCONFIRMED", "Refund needs more confirmations");
    const block = await provider.getBlock(receipt.blockNumber);
    if (block?.hash !== receipt.blockHash) throw new RelayError("REFUND_REORG", "Refund receipt is not canonical");
    return receipt;
  }
  private async resetReverted(record: PaymentRecord, entry: Refund, field: "approval" | "transaction", retryFailed: boolean) {
    const operation = entry[field];
    if (operation && (await this.relay.provider.getTransactionReceipt(operation.txHash))?.status === 0 && retryFailed) {
      delete entry[field]; await this.relay.store.write(record);
    }
  }
  private async finish(record: PaymentRecord, entry: Refund, retryFailed: boolean) {
    const manager = await this.manager();
    if (entry.state !== "Confirmed") {
      if (!await this.relay.account.getFunction("refundConsumed").staticCall(entry.id)) {
        if (!sameAddress(this.relay.config.asset, ZeroAddress)) {
          const token = new Contract(this.relay.config.asset, ["function allowance(address,address) view returns(uint256)", "function approve(address,uint256) returns(bool)"], this.relay.provider);
          if ((await token.getFunction("allowance").staticCall(this.wallet!.address, await manager.getAddress())) < BigInt(entry.amount)) {
            await this.resetReverted(record, entry, "approval", retryFailed);
            if (!entry.approval) { entry.approval = await this.signed(token, "approve", [await manager.getAddress(), entry.amount]); await this.relay.store.write(record); }
            await this.execute(entry.approval);
          }
        }
        await this.resetReverted(record, entry, "transaction", retryFailed);
        if (!entry.transaction) {
          entry.transaction = await this.signed(manager, "processRefund", [record.quote.paymentId, entry.amount, entry.id],
            sameAddress(this.relay.config.asset, ZeroAddress) ? BigInt(entry.amount) : 0n);
          await this.relay.store.write(record);
        }
        await this.execute(entry.transaction);
      }
      if (!entry.transaction) throw new RelayError("REFUND_CONFLICT", "RefundId was consumed outside this journal; manual reconciliation is required");
      const receipt = await this.execute(entry.transaction);
      const events = receipt.logs.filter(log => sameAddress(log.address, manager.target as string)).map(log => { try { return managerInterface.parseLog(log); } catch { return null; } });
      const event = events.find(event => event?.name === "RefundProcessed" && event.args.paymentId === record.quote.paymentId && event.args.refundId === entry.id && event.args.amount === BigInt(entry.amount));
      if (!event || !await this.relay.account.getFunction("refundConsumed").staticCall(entry.id)) throw new RelayError("REFUND_MISMATCH", "Refund transaction does not prove this payment/refundId/amount");
      entry.state = "Confirmed";
    }
    const total = record.refunds.filter(refund => refund.state === "Confirmed").reduce((sum, refund) => sum + BigInt(refund.amount), 0n);
    const payment = await this.relay.account.getFunction("getPayment").staticCall(record.quote.paymentId);
    if (payment.refundedAmount !== total) throw new RelayError("REFUND_CONFLICT", "Chain refund total differs from this journal");
    if (total === BigInt(record.quote.price)) record.state = "Refunded";
    await this.relay.store.write(record);
  }
  async recover() {
    for (const id of await this.relay.store.ids()) {
      const record = await this.relay.store.read(id);
      if (!record.refunds.length || record.state === "Refunded") continue;
      await this.relay.store.lock(id, async () => {
        const current = await this.relay.store.read(id);
        if (current.operatorCompensation) {
          for (const entry of current.refunds) this.assertResolvedRefund(current, entry.id, entry.amount);
          await this.relay.verifyCompensation(current);
        }
        if (this.relay.isDeliveryUncertain(current) && !validOperatorResolution(current)) return;
        if (current.operatorResolution) {
          for (const entry of current.refunds) this.assertResolvedRefund(current, entry.id, entry.amount);
          await this.relay.proof(current.quote, current.proof!.txHash);
        }
        for (const entry of current.refunds) if (entry.state !== "Confirmed") await this.finish(current, entry, false);
      });
    }
  }
}
