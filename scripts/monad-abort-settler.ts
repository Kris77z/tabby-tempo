import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, Interface, JsonRpcProvider, Transaction, Wallet, getAddress, keccak256 } from "ethers";
import { ACCOUNT_ABI, MANAGER_ABI, accountInterface, managerInterface, canonical, type Json } from "../packages/sdk/src/protocol.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { DemoJournal } from "./demo-journal.js";
import { readSecret } from "./demo-monad-config.js";
import { chainRpcProvider, readRpcUrlFile, type RpcTransport } from "./demo-rpc.js";

export interface AbortConfig {
  version: 1; chainId: string; rpcUrlFile: string; rpcTransport: RpcTransport; verifierKeyFile: string; journalDirectory: string;
  account: string; manager: string; escrow: string; asset: string; agentId: string; taskId: string; wallet: string;
  paymentId: string; paymentTxHash: string; refundTxHash: string; refundId: string; ledgerFile: string;
  resolutionId: string; evidenceDigest: string; reason: "task-abort/provider-unknown"; maxFeePerGas: string;
}
const hash = (x: unknown) => typeof x === "string" && /^0x[0-9a-f]{64}$/.test(x);
const same = (a: string, b: string) => getAddress(a) === getAddress(b);
const digest = (x: unknown) => createHash("sha256").update(canonical(x as Json)).digest("hex");
function fail(code: string): never { throw new Error(code); }
const escrowAbi = ["function verifier() view returns(address)", "function creditManager() view returns(address)", "function settlementAsset() view returns(address)",
  "function settle(uint256,bool)", "function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))",
  "event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)"];
const refundInterface = new Interface([...MANAGER_ABI, "event LoanClosedByRefund(uint256 indexed taskId,uint256 principalForgiven,uint256 feeForgiven)"]);
const escrowInterface = new Interface(escrowAbi), tokenInterface = new Interface(["event Transfer(address indexed from,address indexed to,uint256 value)"]);
export function validateAbortLedger(config: AbortConfig, ledger: any) {
  const closure = ledger?.closure, { closure: _closure, ...before } = ledger ?? {};
  if (!closure || closure.version !== 1 || closure.reason !== "operator-accepted-unknown-cost" || closure.resolutionId !== config.resolutionId
    || closure.evidenceDigest !== config.evidenceDigest || closure.paymentId !== config.paymentId || !Number.isSafeInteger(closure.sealedAt) || closure.sealedAt <= 0
    || closure.expectedLedgerDigest !== digest(before) || !ledger.binding || digest(closure.binding) !== digest(ledger.binding)
    || ledger.binding.agentId !== config.agentId || ledger.binding.taskId !== config.taskId || !same(ledger.binding.wallet, config.wallet)
    || !Array.isArray(ledger.grants) || ledger.grants.length !== 1 || ledger.grants[0].source?.kind !== "chain-payment"
    || ledger.grants[0].source.paymentId !== config.paymentId || ledger.grants[0].source.txHash !== config.paymentTxHash
    || !Array.isArray(ledger.invocations) || !ledger.invocations.some((call: any) => call.state === "Unknown")
    || ledger.invocations.some((call: any) => ["Completed", "DispatchIntent", "ResponseRecorded"].includes(call.state))) fail("ABORT_LEDGER_NOT_SEALED");
  return { ledgerDigest: closure.expectedLedgerDigest as string, sealedAt: closure.sealedAt as number };
}
function validateConfig(c: AbortConfig) {
  if (c.version !== 1 || !["10143", "31337", "42431"].includes(c.chainId) || c.reason !== "task-abort/provider-unknown" || !["direct", "system-https-proxy"].includes(c.rpcTransport)
    || !/^[1-9][0-9]*$/.test(c.agentId) || !/^[1-9][0-9]*$/.test(c.taskId) || !/^[1-9][0-9]*$/.test(c.maxFeePerGas) || BigInt(c.maxFeePerGas) > 250000000000n
    || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/.test(c.resolutionId)
    || [c.paymentId, c.paymentTxHash, c.refundTxHash, c.refundId, c.evidenceDigest].some(v => !hash(v))
    || [c.rpcUrlFile, c.verifierKeyFile, c.journalDirectory, c.ledgerFile].some(v => !isAbsolute(v))) fail("ABORT_CONFIG_INVALID");
  for (const address of [c.account, c.manager, c.escrow, c.asset, c.wallet]) if (getAddress(address) === "0x0000000000000000000000000000000000000000") fail("ABORT_CONFIG_INVALID");
}
/** All checks are reads. No hidden-test verdict is created or accepted by this operator path. */
export async function verifyAbortPreconditions(c: AbortConfig, provider: JsonRpcProvider, verifier: string, allowFailed = false) {
  validateConfig(c); validateAbortLedger(c, JSON.parse(await readFile(c.ledgerFile, "utf8")));
  if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(c.chainId)) fail("ABORT_CHAIN_MISMATCH");
  const block = await provider.getBlock("latest"); if (!block?.hash) fail("ABORT_BLOCK_UNCONFIRMED");
  const at = { blockTag: block.number }, escrow = new Contract(c.escrow, escrowAbi, provider), account = new Contract(c.account, ACCOUNT_ABI, provider), manager = new Contract(c.manager, MANAGER_ABI, provider);
  const [task, loan, payment, expectedVerifier, linkedManager, linkedAsset, escrowManager, escrowAsset] = await Promise.all([
    escrow.getTask(c.taskId, at), manager.getLoan(c.taskId, at), account.getPayment(c.paymentId, at), escrow.verifier(at), account.creditManager(at), account.settlementAsset(at), escrow.creditManager(at), escrow.settlementAsset(at)]);
  if (!same(expectedVerifier, verifier) || !same(linkedManager, c.manager) || !same(linkedAsset, c.asset) || !same(escrowManager, c.manager) || !same(escrowAsset, c.asset)
    || task.agentId !== BigInt(c.agentId) || !(task.status === 2n || allowFailed && task.status === 4n) || task.reward <= 0n
    || task.status === 2n && task.escrowBalance !== task.reward || task.status === 4n && task.escrowBalance !== 0n
    || loan.status !== 4n || loan.agentId !== BigInt(c.agentId) || loan.principal !== 0n || loan.fee !== 0n
    || payment.agentId !== BigInt(c.agentId) || payment.taskId !== BigInt(c.taskId) || payment.fromCredit <= 0n
    || payment.fromCash + payment.fromCredit !== payment.refundedAmount || payment.refundedAmount <= 0n) fail("ABORT_FINANCIAL_PRECONDITION_FAILED");
  for (const [txHash, kind] of [[c.paymentTxHash, "payment"], [c.refundTxHash, "refund"]] as const) {
    const receipt = await provider.getTransactionReceipt(txHash), tx = await provider.getTransaction(txHash);
    if (!receipt || receipt.status !== 1 || receipt.hash !== txHash || receipt.blockNumber > block.number || (await provider.getBlock(receipt.blockNumber))?.hash !== receipt.blockHash || !tx?.to) fail("ABORT_RECEIPT_UNCONFIRMED");
    const iface = kind === "payment" ? accountInterface : managerInterface, contract = kind === "payment" ? c.account : c.manager;
    const events = receipt.logs.filter(log => same(log.address, contract)).flatMap(log => { try { const e = iface.parseLog(log); return e?.name === (kind === "payment" ? "ProviderPaid" : "RefundProcessed") ? [e] : []; } catch { return []; } });
    if (!same(tx.to!, contract) || events.length !== 1 || events[0].args.paymentId !== c.paymentId) fail("ABORT_RECEIPT_BINDING_FAILED");
    const event = events[0];
    if (kind === "payment") {
      const call = accountInterface.parseTransaction({ data: tx.data, value: tx.value });
      if (!same(tx.from, c.wallet) || !call || call.name !== "payProvider" || call.args[0] !== BigInt(c.agentId) || call.args[2] !== payment.refundedAmount || call.args[3] !== c.paymentId || !same(call.args[1], event.args.provider)
        || event.args.agentId !== BigInt(c.agentId) || event.args.fromCash !== payment.fromCash || event.args.fromCredit !== payment.fromCredit) fail("ABORT_PAYMENT_BINDING_FAILED");
    } else {
      const closed = receipt.logs.filter(log => same(log.address, c.manager)).flatMap(log => { try { const e = refundInterface.parseLog(log); return e?.name === "LoanClosedByRefund" ? [e] : []; } catch { return []; } });
      if (closed.length !== 1 || closed[0].args.taskId !== BigInt(c.taskId) || closed[0].args.principalForgiven !== payment.fromCredit
        || event.args.refundId !== c.refundId || event.args.amount !== payment.refundedAmount || event.args.debtReduced !== payment.fromCredit + closed[0].args.feeForgiven
        || event.args.toCash !== payment.fromCash) fail("ABORT_REFUND_BINDING_FAILED");
    }
  }
  if ((await provider.getBlock(block.number))?.hash !== block.hash) fail("ABORT_BLOCK_UNCONFIRMED");
  return { poster: String(task.poster), rewardRaw: String(task.reward), paymentRaw: String(payment.refundedAmount), blockNumber: block.number, blockHash: block.hash };
}
interface AbortJournal { version: 1; config: AbortConfig; proof: Awaited<ReturnType<typeof verifyAbortPreconditions>>; result?: { txHash: string; blockNumber: number; blockHash: string; reason: string; rewardReturnedRaw: string } }
export async function settleAbortedTask(c: AbortConfig, provider: JsonRpcProvider, wallet: Wallet, recover = false) {
  const store = new SessionStore<AbortJournal>(c.journalDirectory); await store.start(recover);
  try {
    let state = await store.read(); if (state && digest(state.config) !== digest(c)) fail("ABORT_CONFIG_CHANGED");
    const journal = new DemoJournal(provider, join(c.journalDirectory, "transactions.json")); await journal.load();
    const sent = journal.has("abort"), proof = await verifyAbortPreconditions(c, provider, wallet.address, sent);
    state ??= { version: 1, config: structuredClone(c), proof }; await store.write(state);
    const escrow = new Contract(c.escrow, escrowAbi, wallet);
    const gasCap = c.chainId === "42431" ? 20000000n : 1000000n;
    if (!sent) {
      const gas = await escrow.settle.estimateGas(c.taskId, false, { gasLimit: gasCap }), limit = gas * 120n / 100n + 10000n;
      if (limit > gasCap) fail("ABORT_GAS_LIMIT_EXCEEDED");
      const fees = await provider.getFeeData(), maxFee = fees.maxFeePerGas ?? fees.gasPrice;
      if (!maxFee || maxFee > BigInt(c.maxFeePerGas)) fail("ABORT_GAS_PRICE_EXCEEDED");
      await verifyAbortPreconditions(c, provider, wallet.address);
      await journal.send("abort", wallet, { to: c.escrow, chainId: BigInt(c.chainId), value: 0n, data: escrowInterface.encodeFunctionData("settle", [c.taskId, false]),
        gasLimit: limit, maxFeePerGas: maxFee, maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? 0n });
    } else {
      // Validate the original bytes before DemoJournal is allowed to rebroadcast them.
      const entries = JSON.parse(await readFile(join(c.journalDirectory, "transactions.json"), "utf8")), entry = entries.abort, tx = Transaction.from(entry.rawTransaction);
      if (tx.hash !== entry.txHash || keccak256(entry.rawTransaction) !== entry.txHash || !tx.to || !same(tx.to, c.escrow) || !tx.from || !same(tx.from, wallet.address)
        || tx.chainId !== BigInt(c.chainId) || tx.data !== escrowInterface.encodeFunctionData("settle", [c.taskId, false]) || tx.value !== 0n
        || tx.gasLimit > gasCap || (tx.maxFeePerGas ?? tx.gasPrice ?? 0n) > BigInt(c.maxFeePerGas)) fail("ABORT_TRANSACTION_CHANGED");
      if (!await provider.getTransaction(tx.hash!) && await provider.getTransactionCount(wallet.address, "latest") > tx.nonce) fail("ABORT_NONCE_UNCERTAIN");
    }
    const receipt = await journal.receipt("abort"), block = await provider.getBlock(receipt.blockNumber);
    const events = receipt.logs.filter(log => same(log.address, c.escrow)).flatMap(log => { try { const e = escrowInterface.parseLog(log); return e?.name === "TaskSettled" ? [e] : []; } catch { return []; } });
    const transfers = receipt.logs.filter(log => same(log.address, c.asset)).flatMap(log => { try { const e = tokenInterface.parseLog(log); return e ? [e] : []; } catch { return []; } });
    if (block?.hash !== receipt.blockHash || events.length !== 1 || events[0].args.taskId !== BigInt(c.taskId) || events[0].args.passed !== false
      || events[0].args.repaid !== 0n || events[0].args.slashed !== 0n || events[0].args.agentResidual !== 0n
      || !transfers.some(e => same(e.args.from, c.escrow) && same(e.args.to, proof.poster) && e.args.value === BigInt(proof.rewardRaw))) fail("ABORT_SETTLEMENT_UNCONFIRMED");
    await verifyAbortPreconditions(c, provider, wallet.address, true);
    state.result = { txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, reason: c.reason, rewardReturnedRaw: proof.rewardRaw };
    await store.write(state); return state.result;
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  let connection: Awaited<ReturnType<typeof chainRpcProvider>> | undefined;
  try {
    const file = process.argv[2]; if (!file) fail("ABORT_CONFIG_FILE_REQUIRED");
    const config: AbortConfig = JSON.parse(await readFile(file, "utf8")); validateConfig(config); if (!["10143", "42431"].includes(config.chainId)) fail("REMOTE_TESTNET_REQUIRED");
    connection = await chainRpcProvider(await readRpcUrlFile(config.rpcUrlFile), config.chainId, config.rpcTransport);
    const wallet = new Wallet(await readSecret(config.verifierKeyFile), connection.provider);
    const result = process.argv.includes("--check") ? await verifyAbortPreconditions(config, connection.provider, wallet.address)
      : await settleAbortedTask(config, connection.provider, wallet, process.argv.includes("--recover"));
    console.log(JSON.stringify({ ok: true, ...result }));
  } catch (error) { const message = error instanceof Error ? error.message : ""; console.error(/^[A-Z_]+$/.test(message) ? message : "ABORT_SETTLER_FAILED"); process.exitCode = 1; }
  finally { connection?.close(); }
}
