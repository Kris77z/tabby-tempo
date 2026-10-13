import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id } from "ethers";
import { EMPTY_AUTH, type ChatInput } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../underwriter/test/fixture.js";
import { Relay } from "../src/relay.js";
import { Refunder } from "../src/refunder.js";

test("refund polls delayed receipts on a quiet real chain, retains original bytes through reorg rejection and recovers without another send", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-refund-wait-")), local = await startAnvil();
  let f: Awaited<ReturnType<typeof fixture>> | undefined, relay: Relay | undefined;
  try {
    f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
    await f.provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]);
    let calls = 0;
    relay = new Relay({ rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: "infercredit/coder", model: "coder", price: 1000n, upstreams: [{ name: "primary", model: "controlled", baseUrl: "https://controlled.invalid/v1", key: "synthetic" }] },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 0, refunderKey: key(4) },
    { provider: f.provider, upstreamFetch: async () => { calls++; return Response.json({ error: "controlled rejection" }, { status: 400 }); } });
    const refunder = new Refunder(relay); await relay.initialize(); await refunder.initialize();
    const input: ChatInput = { agentId: "1", taskId: "0", service: "infercredit/coder", model: "coder", messages: [{ role: "user", content: "controlled" }] };
    const quote = await relay.quote(input), paid = await tx(f.account, f.agent, "payProvider", ["1", f.payee, "1000", quote.paymentId, EMPTY_AUTH, "0x"]);
    await assert.rejects(relay.chat(input, quote.paymentId, paid.hash)); assert.equal(calls, 1); assert.equal(await f.providerBalance(), 1000n);
    const rpc = f.provider, originalWait = rpc.waitForTransaction.bind(rpc), originalReceipt = rpc.getTransactionReceipt.bind(rpc), originalBroadcast = rpc.broadcastTransaction.bind(rpc), originalBlock = rpc.getBlock.bind(rpc);
    let sends = 0, hidden = 0, wrongBlock: number | undefined; const observed: string[] = [];
    rpc.waitForTransaction = async () => { throw new Error("TEST_BLOCK_SUBSCRIPTION_WAIT_FORBIDDEN"); };
    rpc.broadcastTransaction = async raw => { sends++; const sent = await originalBroadcast(raw); hidden = 2; return sent; };
    rpc.getTransactionReceipt = async hash => { observed.push(hash); if (hash !== paid.hash && hidden > 0) { hidden--; return null; } return originalReceipt(hash); };
    rpc.getBlock = async (...args) => { const block = await originalBlock(...args); return block && args[0] === wrongBlock ? Object.defineProperty(Object.create(block), "hash", { value: "0x" + "11".repeat(32) }) : block; };
    const refundId = id("quiet-refund-original");
    try {
      // Reject the first original approval's canonical proof, without creating a replacement approval.
      const broadcast = rpc.broadcastTransaction;
      rpc.broadcastTransaction = async raw => { const sent = await broadcast(raw), receipt = await originalReceipt(sent.hash); wrongBlock = receipt!.blockNumber; return sent; };
      await assert.rejects(refunder.refund(quote.paymentId, refundId, "1000"), (error: any) => error.code === "REFUND_REORG");
      const before = await relay.store.read(quote.paymentId), raw = before.refunds[0].approval!.rawTransaction;
      assert.equal(sends, 1); assert.equal(await f.providerBalance(), 1000n);
      wrongBlock = undefined; rpc.broadcastTransaction = broadcast;
      await refunder.recover();
      const confirmed = await relay.store.read(quote.paymentId); assert.equal(confirmed.state, "Refunded"); assert.equal(confirmed.refunds[0].approval!.rawTransaction, raw);
      assert.equal(sends, 2); // Original approval + original processRefund, never a replacement approval.
      const nonce = await rpc.getTransactionCount(f.payee); await refunder.recover(); await refunder.refund(quote.paymentId, refundId, "1000");
      assert.equal(await rpc.getTransactionCount(f.payee), nonce); assert.equal(sends, 2); assert.equal(calls, 1);
      assert.equal(await f.providerBalance(), 0n); assert.equal((await read(f.account, "getPayment", [quote.paymentId])).refundedAmount, 1000n);
      for (const operation of [confirmed.refunds[0].approval!, confirmed.refunds[0].transaction!]) {
        const receipt = await originalReceipt(operation.txHash); assert.equal(receipt?.status, 1); assert.equal((await originalBlock(receipt!.blockNumber))?.hash, receipt!.blockHash);
        assert.ok(observed.filter(hash => hash === operation.txHash).length >= 3);
      }
    } finally { rpc.waitForTransaction = originalWait; rpc.getTransactionReceipt = originalReceipt; rpc.broadcastTransaction = originalBroadcast; rpc.getBlock = originalBlock; }
  } finally { relay?.close(); await f?.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});
