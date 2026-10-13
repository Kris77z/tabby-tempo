import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Contract, Wallet } from "ethers";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { DemoJournal } from "./demo-journal.js";
import { chainRpcProvider, readRpcUrlFile } from "./demo-rpc.js";
import { reportDemoFailure } from "./demo-common.js";
import { TEMPO_PATH_USD } from "./tempo-config.js";

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
async function main() {
  const directory = resolve(process.argv[2] ?? ""), label = process.argv[3];
  assert.ok(process.argv[2] && label === "autonomy-validation", "Usage: tempo-agent-funding.ts RUNTIME autonomy-validation");
  const ready = await read(join(directory, "ready.json")), bootstrap = await read(ready.bootstrapFile);
  assert.equal(ready.chainId, "42431"); assert.equal(bootstrap.chainId, "42431");
  assert.equal(bootstrap.asset.address.toLowerCase(), TEMPO_PATH_USD.toLowerCase());
  assert.equal(bootstrap.asset.decimals, 6); assert.equal(bootstrap.asset.symbol, "PathUSD");
  const acceptance = await read(join(directory, "acceptance.json")), entry = acceptance.agents[label];
  assert.equal(entry.create.totalBudgetRaw, "300000"); assert.equal(entry.faucet.address.toLowerCase(), entry.agent.wallet.toLowerCase());
  assert.equal(entry.faucet.hashes, undefined, "This recovery retains the original Unknown faucet intent");
  const operation = new SessionStore<any>(join(directory, "operator-funding", label)); await operation.start(true);
  const connection = await chainRpcProvider(await readRpcUrlFile(bootstrap.rpcUrlFile), "42431", bootstrap.rpcTransport);
  try {
    assert.equal(BigInt(await connection.provider.send("eth_chainId", [])), 42431n);
    const wallet = new Wallet((await readFile(bootstrap.roleKeyFiles.sponsor, "utf8")).trim(), connection.provider);
    const token = new Contract(bootstrap.asset.address, ["function balanceOf(address) view returns(uint256)", "function decimals() view returns(uint8)", "function symbol() view returns(string)", "function transfer(address,uint256) returns(bool)", "event Transfer(address indexed from,address indexed to,uint256 value)"], connection.provider);
    assert.equal(await token.getFunction("decimals").staticCall(), 6n); assert.equal(await token.getFunction("symbol").staticCall(), "PathUSD");
    let state = await operation.read();
    const intent = { version: 1, chainId: "42431", agentId: entry.agent.id, recipient: entry.agent.wallet, sender: wallet.address, asset: bootstrap.asset.address, amountRaw: "1000000", purpose: "Testnet registration and fee reserve; account cash deposit remains 50000 and total spending policy remains 300000", originalFaucetStatus: "Unknown" };
    if (state) assert.deepEqual(state.intent, intent);
    else {
      const before = await token.balanceOf(entry.agent.wallet); assert.equal(before, 0n, "Inspect funding before creating an operator transfer");
      assert.ok(await token.balanceOf(wallet.address) > 1_000_000n, "Operator requires transfer amount plus its own fee reserve");
      state = { intent, balanceBeforeRaw: String(before), createdAt: new Date().toISOString() }; await operation.write(state);
    }
    const journal = new DemoJournal(connection.provider, join(operation.directory, "transactions.json")); await journal.load();
    if (state.result) assert.ok(journal.has("fund"), "A confirmed funding result must retain its original signed transaction");
    if (!journal.has("fund")) {
      const request = await token.getFunction("transfer").populateTransaction(intent.recipient, BigInt(intent.amountRaw));
      await journal.send("fund", wallet, { ...request, maxFeePerGas: BigInt(bootstrap.maxFeePerGas), maxPriorityFeePerGas: 1n });
    }
    const receipt = await journal.receipt("fund");
    assert.equal((await connection.provider.getBlock(receipt.blockNumber))?.hash, receipt.blockHash);
    const transfers = receipt.logs.filter(log => log.address.toLowerCase() === intent.asset.toLowerCase()).flatMap(log => {
      try { const event = token.interface.parseLog(log); return event?.name === "Transfer" && event.args.from.toLowerCase() === intent.sender.toLowerCase() && event.args.to.toLowerCase() === intent.recipient.toLowerCase() ? [event] : []; } catch { return []; }
    });
    assert.equal(transfers.length, 1); assert.equal(transfers[0].args.value, BigInt(intent.amountRaw));
    const balance = await token.balanceOf(intent.recipient);
    // The canonical Transfer proves arrival even if this process crashed
    // before recording its result and later registration spent the balance.
    // Current balance is an observation, never a reason for another top-up.
    state.result = { ...intent, txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, status: receipt.status,
      balanceObservedRaw: String(balance), observedAt: new Date().toISOString(), canonical: true }; await operation.write(state);
    console.log(JSON.stringify(state.result));
  } finally { connection.close(); await operation.close(); }
}
main().catch(error => { reportDemoFailure(error); process.exitCode = 1; });
