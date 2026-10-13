import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FeeData, JsonRpcProvider, Network, Transaction, Wallet, keccak256, type TransactionResponse } from "ethers";
import { DemoJournal } from "../demo-journal.js";

test("Tempo send and receipt reject persisted Monad signed transaction before lookup or broadcast and preserve the journal", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-journal-chain-"))), path = join(directory, "transactions.json");
  const originalWallet = new Wallet(`0x${"14".padStart(64, "0")}`);
  const rawTransaction = await originalWallet.signTransaction({ type: 2, chainId: 10143n, nonce: 7, to: "0x1111111111111111111111111111111111111111",
    data: "0x1234", value: 0n, gasLimit: 500000n, maxFeePerGas: 10n, maxPriorityFeePerGas: 1n });
  const entry = { from: originalWallet.address, txHash: keccak256(rawTransaction), rawTransaction };
  const provider = new JsonRpcProvider("http://127.0.0.1:1"), wallet = originalWallet.connect(provider);
  let networkReads = 0, lookups = 0, receiptLookups = 0, broadcasts = 0, populations = 0, signatures = 0;
  provider.getNetwork = async () => { networkReads++; return Network.from(42431); };
  provider.getTransaction = async () => { lookups++; throw new Error("MUST_NOT_LOOK_UP_FOREIGN_TRANSACTION"); };
  provider.getTransactionReceipt = async () => { receiptLookups++; throw new Error("MUST_NOT_LOOK_UP_FOREIGN_RECEIPT"); };
  provider.broadcastTransaction = async () => { broadcasts++; throw new Error("MUST_NOT_BROADCAST_FOREIGN_TRANSACTION"); };
  wallet.populateTransaction = async () => { populations++; throw new Error("MUST_NOT_REPLACE_RECORDED_TRANSACTION"); };
  wallet.signTransaction = async () => { signatures++; throw new Error("MUST_NOT_RESIGN_RECORDED_TRANSACTION"); };
  try {
    await writeFile(path, JSON.stringify({ "existing-monad-operation": entry }, null, 2) + "\n", { mode: 0o600 });
    const before = await readFile(path), beforeMetadata = await stat(path, { bigint: true });
    assert.equal(Transaction.from(entry.rawTransaction).chainId, 10143n);
    const journal = new DemoJournal(provider, path); await journal.load(); assert.equal(journal.has("existing-monad-operation"), true);
    await assert.rejects(journal.send("existing-monad-operation", wallet, { to: "0x1111111111111111111111111111111111111111", data: "0x1234", value: 0n, chainId: 42431n }),
      /^Error: JOURNAL_TRANSACTION_CHAIN_MISMATCH$/);
    await assert.rejects(journal.receipt("existing-monad-operation"), /^Error: JOURNAL_TRANSACTION_CHAIN_MISMATCH$/);
    assert.equal(networkReads, 2); assert.equal(lookups, 0); assert.equal(receiptLookups, 0); assert.equal(broadcasts, 0); assert.equal(populations, 0); assert.equal(signatures, 0);
    assert.deepEqual(await readFile(path), before);
    assert.equal((await stat(path, { bigint: true })).mtimeNs, beforeMetadata.mtimeNs, "rejection must not rewrite the journal");
  } finally { provider.destroy(); await rm(directory, { recursive: true, force: true }); }
});

test("Tempo journal adds storage gas margin on first signature and recovers the original bytes without estimating again", async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-journal-tempo-gas-"))), path = join(directory, "transactions.json");
  const provider = new JsonRpcProvider("http://127.0.0.1:1"), wallet = new Wallet(`0x${"14".padStart(64, "0")}`, provider);
  let estimates = 0, nonceReads = 0;
  const broadcasts: string[] = [];
  provider.getNetwork = async () => Network.from(42431);
  provider.getTransactionCount = async () => { nonceReads++; return 7; };
  provider.getFeeData = async () => new FeeData(1n, 2n, 1n);
  provider.estimateGas = async () => { estimates++; if (estimates > 1) throw new Error("MUST_NOT_ESTIMATE_RECORDED_TRANSACTION"); return 1500000n; };
  provider.getTransaction = async () => null;
  provider.broadcastTransaction = async raw => {
    const persisted = JSON.parse(await readFile(path, "utf8"))["tempo-operation"];
    assert.equal(persisted.rawTransaction, raw, "signed bytes must persist before broadcasting");
    broadcasts.push(raw); return { hash: keccak256(raw) } as TransactionResponse;
  };
  try {
    const request = { to: "0x1111111111111111111111111111111111111111", data: "0x1234", value: 0n, chainId: 42431n };
    const journal = new DemoJournal(provider, path); await journal.load();
    const first = await journal.send("tempo-operation", wallet, request), before = await readFile(path), metadata = await stat(path, { bigint: true });
    const saved = JSON.parse(before.toString())["tempo-operation"], signed = Transaction.from(saved.rawTransaction);
    assert.equal(signed.chainId, 42431n); assert.equal(signed.gasLimit, 1800000n); assert.equal(signed.nonce, 7);
    assert.equal(first.hash, saved.txHash); assert.equal(estimates, 1); assert.equal(nonceReads, 1);
    const restored = new DemoJournal(provider, path); await restored.load();
    const recovered = await restored.send("tempo-operation", wallet, request);
    assert.equal(recovered.hash, first.hash); assert.equal(estimates, 1); assert.equal(nonceReads, 1);
    assert.deepEqual(broadcasts, [saved.rawTransaction, saved.rawTransaction]); assert.deepEqual(await readFile(path), before);
    assert.equal((await stat(path, { bigint: true })).mtimeNs, metadata.mtimeNs, "recovery must not rewrite original signed bytes");
  } finally { provider.destroy(); await rm(directory, { recursive: true, force: true }); }
});
