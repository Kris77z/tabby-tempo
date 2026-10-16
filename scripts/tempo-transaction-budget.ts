import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdir, open, readFile, rename, rmdir, lstat, unlink } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Transaction, getAddress, keccak256 } from "ethers";
import { TEMPO_PATH_USD } from "./tempo-config.js";

/** One separately approved acceptance window; a durable reservation is never refunded on RPC failure. */
export interface TempoTransactionBudget {
  version: 1; id: string; chainId: "42431"; asset: string; issuedAtMs: number; expiresAtMs: number;
  maxTransactions: number; maxGasPerTransaction: string; maxFeePerGas: string; maxFeeRaw: string;
  signers: string[]; targets: string[]; bootstrapSnapshotFile: string; bootstrapSnapshotSha256: string;
}
export interface TempoTransactionReservation {
  hash: string; sender: string; to: string; nonce: number; gasLimit: string; maxFeePerGas: string;
  feeToken: string; maxFeeRaw: string; admittedAt: string;
}
export interface TempoTransactionBudgetLedger { version: 1; budgetId: string; digest: string; reservations: TempoTransactionReservation[] }
const fail = (code = "TEMPO_TRANSACTION_BUDGET_INVALID"): never => { throw new Error(code); };
const digest = (raw: string) => createHash("sha256").update(raw).digest("hex");
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const uint = (v: unknown): v is string => typeof v === "string" && /^[1-9][0-9]{0,29}$/.test(v);
function closed(v: unknown, keys: string[]): asserts v is Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !keys.includes(k))) fail();
}
export function validateTempoTransactionBudget(value: unknown): TempoTransactionBudget {
  closed(value, ["version", "id", "chainId", "asset", "issuedAtMs", "expiresAtMs", "maxTransactions", "maxGasPerTransaction", "maxFeePerGas", "maxFeeRaw", "signers", "targets", "bootstrapSnapshotFile", "bootstrapSnapshotSha256"]);
  if (value.version !== 1 || !uuid.test(value.id) || value.chainId !== "42431" || value.asset !== TEMPO_PATH_USD
    || !Number.isSafeInteger(value.issuedAtMs) || !Number.isSafeInteger(value.expiresAtMs) || value.issuedAtMs <= 0
    || value.expiresAtMs <= value.issuedAtMs || value.expiresAtMs - value.issuedAtMs > 86400000
    || !Number.isSafeInteger(value.maxTransactions) || value.maxTransactions < 1 || value.maxTransactions > 40
    || !uint(value.maxGasPerTransaction) || BigInt(value.maxGasPerTransaction) > 20_000_000n
    || !uint(value.maxFeePerGas) || BigInt(value.maxFeePerGas) > 3_600_000_003n
    || !uint(value.maxFeeRaw) || BigInt(value.maxFeeRaw) > 3_000_000n || typeof value.bootstrapSnapshotFile !== "string"
    || !isAbsolute(value.bootstrapSnapshotFile) || resolve(value.bootstrapSnapshotFile) !== value.bootstrapSnapshotFile
    || !/^[a-f0-9]{64}$/.test(value.bootstrapSnapshotSha256)) fail();
  for (const key of ["signers", "targets"]) {
    if (!Array.isArray(value[key]) || !value[key].length || value[key].length > 16 || new Set(value[key]).size !== value[key].length) fail();
    for (const address of value[key]) { try { if (getAddress(address) !== address || /^0x0{40}$/.test(address)) fail(); } catch { fail(); } }
  }
  return structuredClone(value) as TempoTransactionBudget;
}
async function privateRead(file: string) {
  if (!isAbsolute(file) || resolve(file) !== file) fail();
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const st = await handle.stat();
    if (!st.isFile() || st.mode & 0o077 || st.uid !== process.getuid?.()) fail("TEMPO_TRANSACTION_BUDGET_PRIVATE_FILE_REQUIRED");
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}
async function atomic(file: string, value: unknown) {
  const temp = `${file}.${randomUUID()}.tmp`, handle = await open(temp, "wx", 0o600);
  try { await handle.writeFile(JSON.stringify(value, null, 2) + "\n"); await handle.sync(); } finally { await handle.close(); }
  try { await rename(temp, file); const dir = await open(dirname(file), constants.O_RDONLY); try { await dir.sync(); } finally { await dir.close(); } }
  finally { await unlink(temp).catch(error => { if (error.code !== "ENOENT") throw error; }); }
}
/** Tempo gas prices are attodollars; PathUSD has 6 decimals. Round each reservation upwards. */
export function tempoMaximumFeeRaw(gas: bigint, maxFee: bigint) { return (gas * maxFee + 999_999_999_999n) / 1_000_000_000_000n; }

export async function reserveTempoTransaction(file: string, raw: string, feeToken: (sender: string, to: string, data: string) => Promise<string>, clock: () => number = Date.now) {
  const rawConfig = await privateRead(file), budget = validateTempoTransactionBudget(JSON.parse(rawConfig));
  const snapshotRaw = await privateRead(budget.bootstrapSnapshotFile);
  if (digest(snapshotRaw) !== budget.bootstrapSnapshotSha256) fail("TEMPO_TRANSACTION_BUDGET_DOMAIN_CHANGED");
  const snapshot = JSON.parse(snapshotRaw);
  closed(snapshot, ["version", "chainId", "asset", "contracts"]); closed(snapshot.asset, ["address", "symbol", "decimals"]); closed(snapshot.contracts, ["account", "escrow", "manager"]);
  if (snapshot.version !== 1 || snapshot.chainId !== "42431" || snapshot.asset.address !== TEMPO_PATH_USD || snapshot.asset.symbol !== "PathUSD" || snapshot.asset.decimals !== 6
    || !["account", "escrow", "manager"].every(key => { try { return getAddress(snapshot.contracts[key]) === snapshot.contracts[key] && !/^0x0{40}$/.test(snapshot.contracts[key]); } catch { return false; } })
    || new Set(Object.values(snapshot.contracts)).size !== 3
    || !budget.targets.every(address => [TEMPO_PATH_USD, ...Object.values(snapshot.contracts)].some(value => getAddress(String(value)) === address))) fail("TEMPO_TRANSACTION_BUDGET_DOMAIN_INVALID");
  let tx: Transaction;
  try { tx = Transaction.from(raw); } catch { return fail("TEMPO_TRANSACTION_BUDGET_TRANSACTION_INVALID"); }
  if (tx.type !== 2 || tx.chainId !== 42431n || !tx.signature || !tx.from || !tx.to || tx.hash !== keccak256(raw)
    || tx.value !== 0n || !budget.signers.includes(tx.from) || !budget.targets.includes(tx.to)
    || tx.gasLimit <= 0n || tx.gasLimit > BigInt(budget.maxGasPerTransaction) || !tx.maxFeePerGas
    || tx.maxFeePerGas > BigInt(budget.maxFeePerGas) || tx.maxPriorityFeePerGas! > tx.maxFeePerGas) fail("TEMPO_TRANSACTION_BUDGET_TRANSACTION_REJECTED");
  const sender = tx.from!, to = tx.to!, maxFeePerGas = tx.maxFeePerGas!;
  const parent = await lstat(dirname(file));
  if (!parent.isDirectory() || parent.isSymbolicLink() || parent.mode & 0o077 || parent.uid !== process.getuid?.()) fail("TEMPO_TRANSACTION_BUDGET_PRIVATE_DIRECTORY_REQUIRED");
  const lock = join(dirname(file), "transaction-budget.lock"), ledgerFile = join(dirname(file), "transaction-budget-ledger.json");
  const until = Date.now() + 5000;
  for (;;) {
    try { await mkdir(lock, { mode: 0o700 }); break; }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; if (Date.now() >= until) fail("TEMPO_TRANSACTION_BUDGET_LOCKED"); await delay(20); }
  }
  try {
    if (await privateRead(file) !== rawConfig) fail("TEMPO_TRANSACTION_BUDGET_BINDING_CHANGED");
    let ledger: TempoTransactionBudgetLedger;
    try { ledger = JSON.parse(await privateRead(ledgerFile)); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; ledger = { version: 1, budgetId: budget.id, digest: digest(rawConfig), reservations: [] }; }
    closed(ledger, ["version", "budgetId", "digest", "reservations"]);
    if (ledger.version !== 1 || ledger.budgetId !== budget.id || ledger.digest !== digest(rawConfig) || !Array.isArray(ledger.reservations)
      || ledger.reservations.length > budget.maxTransactions || new Set(ledger.reservations.map(r => r.hash)).size !== ledger.reservations.length) fail("TEMPO_TRANSACTION_BUDGET_LEDGER_INVALID");
    let reserved = 0n;
    for (const row of ledger.reservations) {
      closed(row, ["hash", "sender", "to", "nonce", "gasLimit", "maxFeePerGas", "feeToken", "maxFeeRaw", "admittedAt"]);
      if (!/^0x[0-9a-f]{64}$/.test(row.hash) || !budget.signers.includes(row.sender) || !budget.targets.includes(row.to)
        || !Number.isSafeInteger(row.nonce) || row.nonce < 0 || !uint(row.gasLimit) || BigInt(row.gasLimit) > BigInt(budget.maxGasPerTransaction)
        || !uint(row.maxFeePerGas) || BigInt(row.maxFeePerGas) > BigInt(budget.maxFeePerGas) || row.feeToken !== budget.asset
        || !uint(row.maxFeeRaw) || BigInt(row.maxFeeRaw) !== tempoMaximumFeeRaw(BigInt(row.gasLimit), BigInt(row.maxFeePerGas))
        || !Number.isFinite(Date.parse(row.admittedAt)) || new Date(row.admittedAt).toISOString() !== row.admittedAt
        || Date.parse(row.admittedAt) < budget.issuedAtMs || Date.parse(row.admittedAt) >= budget.expiresAtMs) fail("TEMPO_TRANSACTION_BUDGET_LEDGER_INVALID");
      reserved += BigInt(row.maxFeeRaw);
    }
    if (reserved > BigInt(budget.maxFeeRaw)) fail("TEMPO_TRANSACTION_BUDGET_LEDGER_INVALID");
    const previous = ledger.reservations.find(row => row.hash === tx.hash);
    if (previous) {
      if (previous.sender !== tx.from || previous.to !== tx.to || previous.nonce !== tx.nonce || previous.gasLimit !== String(tx.gasLimit)
        || previous.maxFeePerGas !== String(tx.maxFeePerGas)) fail("TEMPO_TRANSACTION_BUDGET_LEDGER_INVALID");
      if (getAddress(await feeToken(sender, to, tx.data)) !== getAddress(budget.asset)) fail("TEMPO_TRANSACTION_BUDGET_FEE_TOKEN_MISMATCH");
      return { cached: true, reservation: previous };
    }
    const initialNow = clock();
    if (initialNow < budget.issuedAtMs || initialNow >= budget.expiresAtMs) fail("TEMPO_TRANSACTION_BUDGET_EXPIRED");
    const maxFeeRaw = tempoMaximumFeeRaw(tx.gasLimit, maxFeePerGas);
    if (ledger.reservations.length >= budget.maxTransactions || reserved + maxFeeRaw > BigInt(budget.maxFeeRaw)) fail("TEMPO_TRANSACTION_BUDGET_EXHAUSTED");
    // The provider uses only the underlying read transport, so this cannot recursively broadcast.
    if (getAddress(await feeToken(sender, to, tx.data)) !== getAddress(budget.asset)) fail("TEMPO_TRANSACTION_BUDGET_FEE_TOKEN_MISMATCH");
    const finalNow = clock();
    if (finalNow < budget.issuedAtMs || finalNow >= budget.expiresAtMs) fail("TEMPO_TRANSACTION_BUDGET_EXPIRED");
    if (await privateRead(file) !== rawConfig || await privateRead(budget.bootstrapSnapshotFile) !== snapshotRaw) fail("TEMPO_TRANSACTION_BUDGET_BINDING_CHANGED");
    const reservation: TempoTransactionReservation = { hash: tx.hash!, sender, to, nonce: tx.nonce,
      gasLimit: String(tx.gasLimit), maxFeePerGas: String(tx.maxFeePerGas), feeToken: budget.asset, maxFeeRaw: String(maxFeeRaw), admittedAt: new Date(finalNow).toISOString() };
    ledger.reservations.push(reservation); await atomic(ledgerFile, ledger);
    return { cached: false, reservation };
  } finally { await rmdir(lock); }
}
