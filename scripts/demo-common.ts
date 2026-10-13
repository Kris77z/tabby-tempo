import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { createServer as reservePort } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import { Contract, ContractFactory, JsonRpcProvider, keccak256, Wallet,
  type ErrorCode, type Signer, type TransactionReceipt } from "ethers";
import type { Json } from "../packages/sdk/src/protocol.js";

export interface JournalDiagnostic { ethersCode?: ErrorCode; rpcCode?: number; httpStatus?: number }
const ethersCodes = new Set<ErrorCode>([
  "UNKNOWN_ERROR", "NOT_IMPLEMENTED", "UNSUPPORTED_OPERATION", "NETWORK_ERROR", "SERVER_ERROR", "TIMEOUT", "BAD_DATA", "CANCELLED",
  "BUFFER_OVERRUN", "NUMERIC_FAULT", "INVALID_ARGUMENT", "MISSING_ARGUMENT", "UNEXPECTED_ARGUMENT", "VALUE_MISMATCH", "CALL_EXCEPTION",
  "INSUFFICIENT_FUNDS", "NONCE_EXPIRED", "REPLACEMENT_UNDERPRICED", "TRANSACTION_REPLACED", "UNCONFIGURED_NAME", "OFFCHAIN_FAULT", "ACTION_REJECTED",
]);
export function journalDiagnostic(error: unknown): JournalDiagnostic {
  const value = error as any, diagnostic: JournalDiagnostic = {};
  const ethersCode = [value?.diagnostic?.ethersCode, value?.code].find(code => ethersCodes.has(code));
  if (ethersCode !== undefined) diagnostic.ethersCode = ethersCode;
  const rpcCode = [value?.diagnostic?.rpcCode, value?.error?.code, value?.info?.error?.code, value?.code]
    .find(code => Number.isSafeInteger(code) && code >= -2147483648 && code <= 2147483647);
  if (rpcCode !== undefined) diagnostic.rpcCode = rpcCode;
  const responseStatus = typeof value?.info?.responseStatus === "string" ? Number(value.info.responseStatus.match(/^([1-5][0-9]{2})(?:\s|$)/)?.[1]) : undefined;
  const httpStatus = [value?.diagnostic?.httpStatus, value?.response?.statusCode, value?.info?.response?.statusCode, value?.statusCode, value?.status, responseStatus]
    .find(status => Number.isSafeInteger(status) && status >= 100 && status <= 599);
  if (httpStatus !== undefined) diagnostic.httpStatus = httpStatus;
  return diagnostic;
}
export function reportDemoFailure(error: unknown) {
  const message = (error as Error)?.message;
  console.error(/^[A-Z_]+$/.test(message) ? message : "DEMO_FAILED_SEE_SAVED_EVIDENCE");
  const diagnostic = journalDiagnostic(error);
  if (Object.keys(diagnostic).length) console.error(JSON.stringify({ diagnostic }));
}
export async function readCreditProfile(underwriterUrl: string, id: string) {
  const response = await fetch(`${underwriterUrl}/agents/${id}/credit`);
  if (!response.ok) throw Object.assign(new Error("PROFILE_READ_FAILED"), { diagnostic: journalDiagnostic({ status: response.status }) });
  return response.json() as Promise<any>;
}

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const syntheticKey = (role: number) => `0x${role.toString(16).padStart(64, "0")}`;
export const json = (value: unknown) => JSON.stringify(value, (_, value) => typeof value === "bigint" ? value.toString() : value, 2);
export async function saveJson(path: string, value: unknown) {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, json(value) + "\n", { mode: 0o600, flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}
export const read = (contract: Contract, method: string, args: unknown[] = []) => contract.getFunction(method).staticCall(...args);
export async function tx(contract: Contract, signer: Signer, method: string, args: unknown[] = [], overrides = {}): Promise<TransactionReceipt> {
  const receipt = await (await contract.connect(signer).getFunction(method)(...args, overrides)).wait();
  if (!receipt || receipt.status !== 1) throw new Error(`TRANSACTION_FAILED:${method}`);
  return receipt;
}
export async function artifact(name: string) { return JSON.parse(await readFile(resolve(ROOT, "contracts/out", `${name}.sol`, `${name}.json`), "utf8")); }
export async function deploy(name: string, signer: Signer, provider: JsonRpcProvider, args: unknown[] = []) {
  const definition = await artifact(name);
  const contract = await new ContractFactory(definition.abi, definition.bytecode.object, signer).deploy(...args);
  await contract.waitForDeployment();
  return new Contract(await contract.getAddress(), definition.abi, provider);
}
export async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
export async function closeServer(server?: Server) {
  if (!server?.listening) return;
  server.closeIdleConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
export async function stopChild(child?: ChildProcess) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit"); child.kill("SIGTERM");
  if (!await Promise.race([exited.then(() => true), delay(2500).then(() => false)])) { child.kill("SIGKILL"); await exited; }
}
export async function startLocalAnvil() {
  const reserved = reservePort(); reserved.listen(0, "127.0.0.1"); await once(reserved, "listening");
  const port = (reserved.address() as { port: number }).port;
  await new Promise<void>(resolve => reserved.close(() => resolve()));
  const child = spawn(process.env.ANVIL_BIN ?? "anvil", ["--host", "127.0.0.1", "--port", String(port), "--chain-id", "31337", "--accounts", "0", "--silent"], { stdio: ["ignore", "ignore", "pipe"] });
  let error = ""; child.stderr!.on("data", chunk => { error += String(chunk).slice(0, 1000); });
  child.on("error", failure => { error = failure.message; });
  const rpcUrl = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    if (error || child.exitCode !== null) { await stopChild(child); throw new Error("LOCAL_ANVIL_START_FAILED"); }
    try {
      const response = await fetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }), signal: AbortSignal.timeout(200) });
      if ((await response.json() as { result: string }).result === "0x7a69") return { rpcUrl, child };
    } catch { /* Wait only for the child this demo owns. */ }
    await delay(50);
  }
  await stopChild(child); throw new Error("LOCAL_ANVIL_START_TIMEOUT");
}
export function inferenceCode(result: Json): string {
  const content = (result as { choices?: { message?: { content?: unknown } }[] } | null)?.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("INFERENCE_HAS_NO_CODE");
  // Strip only a surrounding Python Markdown fence. Never substitute an answer.
  const fenced = /^\s*```(?:python|py)?\s*\n([\s\S]*?)\n```\s*$/i.exec(content);
  return fenced ? fenced[1] : content.trim();
}
export async function rejectedTransaction(provider: JsonRpcProvider, signer: Wallet, contract: Contract, method: string, args: unknown[]) {
  const data = contract.interface.encodeFunctionData(method, args);
  let revertData = "";
  try { await provider.call({ to: await contract.getAddress(), from: signer.address, data }); throw new Error("EXPECTED_REVERT_DID_NOT_OCCUR"); }
  catch (error) {
    const e = error as { data?: string; info?: { error?: { data?: string } } };
    revertData = e.data ?? e.info?.error?.data ?? "";
    if (!revertData.startsWith("0x")) throw error;
  }
  const populated = await signer.populateTransaction({ to: await contract.getAddress(), data, gasLimit: 1_000_000 });
  const raw = await signer.signTransaction(populated); const txHash = keccak256(raw);
  try { await provider.broadcastTransaction(raw); } catch { if (!await provider.getTransactionReceipt(txHash)) throw new Error("REVERT_BROADCAST_UNCONFIRMED"); }
  const receipt = await provider.waitForTransaction(txHash, 1, 15000);
  if (!receipt || receipt.status !== 0) throw new Error("REVERT_RECEIPT_MISSING");
  return { txHash, blockNumber: receipt.blockNumber, status: receipt.status, revertData, logCount: receipt.logs.length };
}
