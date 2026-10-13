import { readFile } from "node:fs/promises";
import { AbstractSigner, JsonRpcProvider, keccak256, Transaction, Wallet, type Provider, type Signer, type TransactionRequest, type TransactionResponse, type TypedDataDomain, type TypedDataField } from "ethers";
import { journalDiagnostic, saveJson } from "./demo-common.js";
export type { JournalDiagnostic } from "./demo-common.js";

interface Entry { from: string; txHash: string; rawTransaction: string }
function unconfirmed(error: unknown) {
  // Never retain the original error, message, cause, request or signed bytes.
  return Object.assign(new Error("RECORDED_TRANSACTION_UNCONFIRMED_USE_SAME_OUTPUT"), { diagnostic: journalDiagnostic(error) });
}
async function observe<T>(query: () => Promise<T>): Promise<T> {
  try { return await query(); } catch (error) { throw unconfirmed(error); }
}
async function broadcastRecorded(provider: JsonRpcProvider, entry: Entry) {
  try { return await provider.broadcastTransaction(entry.rawTransaction); }
  catch (error) {
    try { const known = await provider.getTransaction(entry.txHash); if (known) return known; }
    catch { /* Keep the broadcast diagnostic if its subsequent lookup also fails. */ }
    throw unconfirmed(error);
  }
}
export class DemoJournal {
  private entries: Record<string, Entry> = {};
  constructor(readonly provider: JsonRpcProvider, readonly path: string) {}
  async load() {
    try { this.entries = JSON.parse(await readFile(this.path, "utf8")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("DEMO_JOURNAL_UNREADABLE"); }
  }
  has(id: string) { return Object.hasOwn(this.entries, id); }
  private async assertChain(entry: Entry) {
    const signed = Transaction.from(entry.rawTransaction);
    if (signed.hash !== entry.txHash || signed.from !== entry.from || signed.chainId !== (await this.provider.getNetwork()).chainId)
      throw new Error("JOURNAL_TRANSACTION_CHAIN_MISMATCH");
  }
  signer(id: string, wallet: Wallet): Signer { return new RecordedSigner(wallet, this, id); }
  async send(id: string, wallet: Wallet, request: TransactionRequest): Promise<TransactionResponse> {
    let entry = this.entries[id];
    if (!entry) {
      const populated = await wallet.populateTransaction(request);
      if (populated.chainId === 42431n && request.gasLimit === undefined) {
        populated.gasLimit = (BigInt(populated.gasLimit!) * 120n + 99n) / 100n;
        if (populated.gasLimit > 30_000_000n) throw new Error("TEMPO_TRANSACTION_GAS_LIMIT");
      }
      const rawTransaction = await wallet.signTransaction(populated);
      entry = { from: wallet.address, txHash: keccak256(rawTransaction), rawTransaction };
      this.entries[id] = entry;
      try { await saveJson(this.path, this.entries); } catch (error) { delete this.entries[id]; throw error; }
    }
    if (entry.from !== wallet.address) throw new Error("JOURNAL_SIGNER_MISMATCH");
    await this.assertChain(entry);
    const known = await observe(() => this.provider.getTransaction(entry.txHash));
    if (known) return known;
    // Replay only the originally persisted bytes. Never create another nonce.
    return broadcastRecorded(this.provider, entry);
  }
  async receipt(id: string, status = 1) {
    const entry = this.entries[id]; if (!entry) throw new Error("JOURNAL_ENTRY_MISSING");
    await this.assertChain(entry);
    let receipt = await observe(() => this.provider.getTransactionReceipt(entry.txHash));
    if (!receipt) {
      if (!await observe(() => this.provider.getTransaction(entry.txHash))) await broadcastRecorded(this.provider, entry);
      receipt = await observe(() => this.provider.waitForTransaction(entry.txHash, 1, 60000));
    }
    if (!receipt || receipt.status !== status) throw new Error("RECORDED_TRANSACTION_STATUS_MISMATCH");
    return receipt;
  }
}
class RecordedSigner extends AbstractSigner {
  constructor(private wallet: Wallet, private journal: DemoJournal, private id: string) { super(wallet.provider); }
  getAddress() { return this.wallet.getAddress(); }
  connect(_provider: Provider | null): Signer { throw new Error("DEMO_SIGNER_PROVIDER_FIXED"); }
  signTransaction(request: TransactionRequest) { return this.wallet.signTransaction(request); }
  signMessage(message: string | Uint8Array) { return this.wallet.signMessage(message); }
  signTypedData(domain: TypedDataDomain, types: Record<string, TypedDataField[]>, value: Record<string, any>) { return this.wallet.signTypedData(domain, types, value); }
  sendTransaction(request: TransactionRequest) { return this.journal.send(this.id, this.wallet, request); }
}
