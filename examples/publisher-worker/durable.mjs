import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, rmdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { keccak256 } from "ethers";

export async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}
export async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const file = await open(temporary, "wx", 0o600);
    try { await file.writeFile(JSON.stringify(value, null, 2) + "\n"); await file.sync(); }
    finally { await file.close(); }
    await rename(temporary, path);
    const parent = await open(dirname(path), "r");
    try { await parent.sync(); } finally { await parent.close(); }
  } finally { await rm(temporary, { force: true }); }
}
export async function withJournal(path, binding, work) {
  path = resolve(path);
  // A changed request cannot write even a lock beside an existing journal.
  const prior = await readJson(path);
  if (prior !== undefined && (!prior || typeof prior !== "object" || Array.isArray(prior) || prior.binding !== binding || prior.version !== 1 || !prior.transactions || typeof prior.transactions !== "object")) throw new Error("JOURNAL_BINDING_MISMATCH");
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.lock`;
  try { await mkdir(lock, { mode: 0o700 }); }
  catch (error) { if (error.code === "EEXIST") throw new Error("JOURNAL_LOCKED"); throw error; }
  try {
    const loaded = await readJson(path);
    const state = loaded === undefined ? {version:1,binding,transactions:{}} : loaded;
    if (state.version !== 1 || state.binding !== binding) throw new Error("JOURNAL_BINDING_MISMATCH");
    const save = () => writeJson(path, state);
    return await work(state, save);
  } finally { await rmdir(lock); }
}
export async function canonicalReceipt(provider, hash) {
  const receipt = await provider.getTransactionReceipt(hash);
  if (!receipt) return undefined;
  if ((await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash) throw new Error("NONCANONICAL_RECEIPT");
  if (receipt.status !== 1) throw new Error("TRANSACTION_REVERTED");
  return receipt;
}
/** The signed transaction is durable before broadcast. Recovery only reuses those bytes. */
export async function sendOnce(state, save, stage, signer, request) {
  const provider = signer.provider;
  let submitted = state.transactions[stage];
  const recovering = Boolean(submitted);
  if (!submitted) {
    const populated = await signer.populateTransaction(request);
    const rawTransaction = await signer.signTransaction(populated);
    submitted = { rawTransaction, txHash: keccak256(rawTransaction), from: await signer.getAddress(), nonce: populated.nonce };
    state.transactions[stage] = submitted;
    await save();
  }
  let receipt = await canonicalReceipt(provider, submitted.txHash);
  if (receipt) return receipt;
  const known = await provider.getTransaction(submitted.txHash);
  if (!known) {
    if (await provider.getTransactionCount(submitted.from, "latest") > submitted.nonce) throw new Error("TRANSACTION_UNCERTAIN");
    if (recovering || submitted.broadcastIntent) throw new Error("TRANSACTION_UNCERTAIN");
    submitted.broadcastIntent = true; await save();
    await provider.broadcastTransaction(submitted.rawTransaction);
  }
  const mined = await provider.waitForTransaction(submitted.txHash, 1, 30000);
  if (!mined) throw new Error("TRANSACTION_PENDING");
  receipt = await canonicalReceipt(provider, submitted.txHash);
  if (!receipt) throw new Error("TRANSACTION_UNCERTAIN");
  return receipt;
}
export function cliFailure(error) {
  const message = error?.code ?? error?.message;
  console.error(typeof message === "string" && /^[A-Z_]{1,100}$/.test(message) ? message : "EXAMPLE_FAILED");
  process.exitCode = 1;
}
