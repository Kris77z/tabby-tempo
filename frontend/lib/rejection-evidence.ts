// Node-only reader. The API route provides the server-only boundary.
import { readFile } from "node:fs/promises";
import { Contract, Interface, toQuantity } from "ethers";
import { ACCOUNT_ABI } from "./abi";
import { createServerRpc } from "./server-transport";
import type { Deployment, VerifiedRejectionEvidence } from "./types";

const accountInterface = new Interface(ACCOUNT_ABI);
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const fail = () => { throw new Error("REJECTION_EVIDENCE_UNVERIFIABLE"); };

export async function readRejectionEvidence(config: Deployment, statePath: string): Promise<VerifiedRejectionEvidence> {
  const state = JSON.parse(await readFile(statePath, "utf8"));
  // Select only this record; contexts, authorizations and other private state never leave this module.
  const record = state?.reverse?.spendRejected;
  const agentId = state?.agents?.hero;
  if (state?.addresses?.account?.toLowerCase() !== config.contracts.account.toLowerCase() ||
    typeof agentId !== "string" || !/^(0|[1-9]\d*)$/.test(agentId) || !config.agents.some(a => a.id === agentId) ||
    !record || record.name !== "SpendRejected" || record.reason !== "1" ||
    typeof record.txHash !== "string" || !/^0x[\da-f]{64}$/i.test(record.txHash) ||
    !Number.isSafeInteger(record.blockNumber) || record.blockNumber < config.deploymentBlock ||
    record.status !== 0 || record.logCount !== 0 ||
    typeof record.revertData !== "string" || !/^0x[\da-f]+$/i.test(record.revertData)) fail();
  const recordedError = accountInterface.parseError(record.revertData);
  if (recordedError?.name !== "SpendRejected" || String(recordedError.args.agentId) !== agentId || recordedError.args.reason !== 1n) fail();

  const connection = await createServerRpc(config.rpcUrl), { provider } = connection;
  try {
    if (BigInt(await provider.send("eth_chainId", [])) !== BigInt(config.chainId)) fail();
    const [transaction, receipt] = await Promise.all([
      provider.getTransaction(record.txHash), provider.getTransactionReceipt(record.txHash),
    ]);
    if (!transaction || !receipt || !transaction.to || !same(transaction.to, config.contracts.account) ||
      transaction.chainId !== BigInt(config.chainId) || transaction.hash !== record.txHash || receipt.hash !== record.txHash ||
      receipt.status !== 0 || receipt.logs.length !== 0 || receipt.blockNumber !== record.blockNumber ||
      transaction.blockNumber !== receipt.blockNumber || transaction.blockHash !== receipt.blockHash || transaction.value !== 0n) fail();
    const call = accountInterface.parseTransaction({ data: transaction!.data, value: transaction!.value });
    if (call?.name !== "payProvider" || String(call.args.agentId) !== agentId ||
      !same(call.args.provider, recordedError!.args.target) || call.args.amount <= 0n) fail();
    const adapter = new Contract(config.contracts.adapter, ["function resolveAgent(uint256) view returns(address,address)"], provider);
    const [, wallet] = await adapter.getFunction("resolveAgent").staticCall(agentId, { blockTag: receipt!.blockNumber });
    if (!same(wallet, transaction!.from)) fail();

    let revertData: unknown;
    try {
      await provider.send("eth_call", [{ from: transaction!.from, to: transaction!.to, data: transaction!.data,
        value: toQuantity(transaction!.value), gas: toQuantity(transaction!.gasLimit) }, toQuantity(receipt!.blockNumber)]);
    } catch (error) {
      const e = error as { data?: unknown; info?: { error?: { data?: unknown } } };
      revertData = e.data ?? e.info?.error?.data;
    }
    if (typeof revertData !== "string" || revertData.toLowerCase() !== record.revertData.toLowerCase()) fail();
    const actualError = accountInterface.parseError(revertData as string);
    if (actualError?.name !== "SpendRejected" || actualError.args.reason !== 1n ||
      String(actualError.args.agentId) !== agentId || !same(actualError.args.target, call!.args.provider)) fail();
    return { verified: true, chainId: config.chainId, account: config.contracts.account, agentId,
      from: transaction!.from, payee: call!.args.provider, amount: String(call!.args.amount),
      hash: transaction!.hash, block: receipt!.blockNumber, status: 0, logCount: 0, revertData: revertData as string };
  } finally { connection.close(); }
}
