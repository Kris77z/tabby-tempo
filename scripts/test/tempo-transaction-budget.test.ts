import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Interface, Wallet, ZeroAddress } from "ethers";
import { chainRpcProvider } from "../demo-rpc.js";
import { reserveTempoTransaction, tempoMaximumFeeRaw, validateTempoTransactionBudget, type TempoTransactionBudget } from "../tempo-transaction-budget.js";
import { TEMPO_FEE_MANAGER, TEMPO_PATH_USD } from "../tempo-config.js";

const exec = promisify(execFile), token = async () => TEMPO_PATH_USD;
const wallet = Wallet.createRandom(), target = Wallet.createRandom().address;
async function fixture(maxTransactions = 40) {
  const directory = await mkdtemp(join(tmpdir(), "tempo-tx-budget-"));
  const file = join(directory, "transaction-budget.json"), now = Date.now();
  const snapshot = JSON.stringify({ version: 1, chainId: "42431", asset: { address: TEMPO_PATH_USD, symbol: "PathUSD", decimals: 6 },
    contracts: { account: target, escrow: Wallet.createRandom().address, manager: Wallet.createRandom().address } });
  const bootstrapSnapshotFile = join(directory, "bootstrap-domain.json"); await writeFile(bootstrapSnapshotFile, snapshot, { mode: 0o600 });
  const config: TempoTransactionBudget = { version: 1, id: randomUUID(), chainId: "42431", asset: TEMPO_PATH_USD,
    issuedAtMs: now - 1000, expiresAtMs: now + 3600000, maxTransactions, maxGasPerTransaction: "20000000",
    maxFeePerGas: "3600000003", maxFeeRaw: "3000000", signers: [wallet.address], targets: [target],
    bootstrapSnapshotFile, bootstrapSnapshotSha256: createHash("sha256").update(snapshot).digest("hex") };
  await writeFile(file, JSON.stringify(config), { mode: 0o600 });
  return { directory, file, config, ledger: () => readFile(join(directory, "transaction-budget-ledger.json"), "utf8").then(JSON.parse) };
}
const signed = (nonce = 0, overrides: Record<string, unknown> = {}) => wallet.signTransaction({ type: 2, chainId: 42431n,
  nonce, to: target, value: 0n, gasLimit: 20_000_000n, maxFeePerGas: 3_600_000_003n, maxPriorityFeePerGas: 1n, ...overrides });

test("six-decimal gas bound rounds each maximum transaction upward", () => {
  assert.equal(tempoMaximumFeeRaw(20_000_000n, 3_600_000_003n), 72001n);
  assert.equal(tempoMaximumFeeRaw(20_000_000n, 3_600_000_003n) * 40n, 2_880_040n);
  assert.ok(2_880_040n < 3_000_000n);
});

test("durable reservation survives unknown response and original hash replay after expiry", async () => {
  const f = await fixture();
  try {
    const raw = await signed();
    assert.equal((await reserveTempoTransaction(f.file, raw, token)).cached, false);
    assert.equal((await reserveTempoTransaction(f.file, raw, token, () => f.config.expiresAtMs + 1)).cached, true);
    assert.equal((await f.ledger()).reservations.length, 1);
    await assert.rejects(reserveTempoTransaction(f.file, await signed(1), token, () => f.config.expiresAtMs), /BUDGET_EXPIRED/);
    await assert.rejects(reserveTempoTransaction(f.file, raw, async () => ZeroAddress), /FEE_TOKEN_MISMATCH/);
    assert.equal((await f.ledger()).reservations.length, 1);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("expiry during fee verification rejects before persistence; historical admission times are bound", async () => {
  const f = await fixture(); let now = f.config.expiresAtMs - 1;
  try {
    await assert.rejects(reserveTempoTransaction(f.file, await signed(), async () => { now++; return TEMPO_PATH_USD; }, () => now), /BUDGET_EXPIRED/);
    await assert.rejects(f.ledger(), { code: "ENOENT" });
    await reserveTempoTransaction(f.file, await signed(), token);
    const ledger = await f.ledger(); ledger.reservations[0].admittedAt = new Date(f.config.expiresAtMs).toISOString();
    await writeFile(join(f.directory, "transaction-budget-ledger.json"), JSON.stringify(ledger));
    await assert.rejects(reserveTempoTransaction(f.file, await signed(1), token), /LEDGER_INVALID/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("a listed arbitrary target cannot expand the immutable bootstrap domain", async () => {
  const f = await fixture();
  try {
    await writeFile(f.file, JSON.stringify({ ...f.config, targets: [wallet.address] }));
    await assert.rejects(reserveTempoTransaction(f.file, await signed(0, { to: wallet.address }), token), /DOMAIN_INVALID/);
    await writeFile(f.file, JSON.stringify(f.config));
    await writeFile(f.config.bootstrapSnapshotFile, "{}");
    await assert.rejects(reserveTempoTransaction(f.file, await signed(), token), /DOMAIN_CHANGED/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("domain, sender, destination, fee, gas and fee-token rejection never reserves", async () => {
  const f = await fixture();
  try {
    for (const overrides of [{ chainId: 1n }, { to: wallet.address }, { value: 1n }, { gasLimit: 20_000_001n },
      { maxFeePerGas: 3_600_000_004n }, { type: 0, gasPrice: 1n, maxFeePerGas: undefined, maxPriorityFeePerGas: undefined }]) {
      await assert.rejects(reserveTempoTransaction(f.file, await signed(0, overrides), token), /TRANSACTION_REJECTED/);
    }
    const foreign = Wallet.createRandom();
    const raw = await foreign.signTransaction({ type: 2, chainId: 42431, nonce: 0, to: target, gasLimit: 21000, maxFeePerGas: 1, maxPriorityFeePerGas: 1 });
    await assert.rejects(reserveTempoTransaction(f.file, raw, token), /TRANSACTION_REJECTED/);
    await assert.rejects(reserveTempoTransaction(f.file, await signed(), async () => wallet.address), /FEE_TOKEN_MISMATCH/);
    await assert.rejects(f.ledger(), { code: "ENOENT" });
    await chmod(f.file, 0o644);
    await assert.rejects(reserveTempoTransaction(f.file, await signed(), token), /PRIVATE_FILE_REQUIRED/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("cross-process atomic count and exact-hash idempotence enforce a common cap", async () => {
  const f = await fixture(3);
  try {
    const module = resolve("scripts/tempo-transaction-budget.ts");
    const claim = async (raw: string) => {
      const code = `import { reserveTempoTransaction } from ${JSON.stringify(module)}; try { await reserveTempoTransaction(${JSON.stringify(f.file)},${JSON.stringify(raw)},async()=>${JSON.stringify(TEMPO_PATH_USD)}); console.log('ok'); } catch(e) { console.log(e.message); process.exitCode=2; }`;
      return exec(process.execPath, ["--import", "tsx", "--input-type=module", "-e", code]);
    };
    const first = await signed();
    await Promise.all([claim(first), claim(first), claim(first)]);
    assert.equal((await f.ledger()).reservations.length, 1);
    const raws = await Promise.all([1, 2, 3, 4].map(nonce => signed(nonce)));
    const results = await Promise.allSettled(raws.map(claim));
    assert.equal(results.filter(r => r.status === "fulfilled").length, 2);
    assert.equal((await f.ledger()).reservations.length, 3);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("modified budget or corrupted ledger cannot reset a consumed allowance", async () => {
  const f = await fixture();
  try {
    await reserveTempoTransaction(f.file, await signed(), token);
    await writeFile(f.file, JSON.stringify({ ...f.config, id: randomUUID() }));
    await assert.rejects(reserveTempoTransaction(f.file, await signed(1), token), /LEDGER_INVALID/);
    await writeFile(f.file, JSON.stringify(f.config));
    const ledger = await f.ledger(); ledger.reservations[0].maxFeeRaw = "1";
    await writeFile(join(f.directory, "transaction-budget-ledger.json"), JSON.stringify(ledger));
    await assert.rejects(reserveTempoTransaction(f.file, await signed(1), token), /LEDGER_INVALID/);
    assert.throws(() => validateTempoTransactionBudget({ ...f.config, maxFeeRaw: "3000001" }), /BUDGET_INVALID/);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("real RPC send boundary checks canonical fee preference before broadcast and blocks alternate writes", async () => {
  const f = await fixture(), old = process.env.TEMPO_TRANSACTION_BUDGET_FILE;
  const fee = new Interface(["function userTokens(address) view returns(address)"]), asset = new Interface(["function decimals() view returns(uint8)", "function symbol() view returns(string)"]);
  let broadcasts = 0, preference = ZeroAddress;
  const block = { number: "0x10", hash: "0x" + "ab".repeat(32) };
  const server = createServer(async (req, res) => {
    let raw = ""; for await (const chunk of req) raw += chunk;
    const request = JSON.parse(raw), { method, params } = request;
    let result: unknown;
    if (method === "eth_chainId") result = "0xa5bf";
    else if (method === "eth_getBlockByNumber") result = block;
    else if (method === "eth_call") {
      const data = params[0].data;
      if (params[0].to.toLowerCase() === TEMPO_FEE_MANAGER.toLowerCase()) result = fee.encodeFunctionResult("userTokens", [preference]);
      else if (data === asset.encodeFunctionData("decimals")) result = asset.encodeFunctionResult("decimals", [6]);
      else result = asset.encodeFunctionResult("symbol", ["PathUSD"]);
    } else if (method === "eth_sendRawTransaction") { broadcasts++; result = "0x" + "cd".repeat(32); }
    else throw Error(method);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: request.id, result }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  process.env.TEMPO_TRANSACTION_BUDGET_FILE = f.file;
  const connection = await chainRpcProvider(`http://127.0.0.1:${(server.address() as { port: number }).port}`, 42431, "direct");
  try {
    await connection.provider.send("eth_sendRawTransaction", [await signed()]); assert.equal(broadcasts, 1);
    await assert.rejects(connection.provider.send("eth_sendTransaction", [{}]), /WRITE_REJECTED/);
    preference = wallet.address;
    await assert.rejects(connection.provider.send("eth_sendRawTransaction", [await signed(1)]), /FEE_TOKEN_MISMATCH/);
    assert.equal(broadcasts, 1); assert.equal((await f.ledger()).reservations.length, 1);
  } finally {
    connection.close(); if (old === undefined) delete process.env.TEMPO_TRANSACTION_BUDGET_FILE; else process.env.TEMPO_TRANSACTION_BUDGET_FILE = old;
    await new Promise<void>(done => server.close(() => done())); await rm(f.directory, { recursive: true, force: true });
  }
});
