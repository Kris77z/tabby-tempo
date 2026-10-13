import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet, type TransactionRequest } from "ethers";
import { InferCredit, PaymentError, type PaymentHandle } from "@agentfuel/sdk";
import { runFixedPriceTask, type FixedTaskConfig } from "@agentfuel/pi-loop/fixed-task";
import { fixture, key, read, startAnvil, stopAnvil } from "../../underwriter/test/fixture.js";
import { FIXED_SOLVE_MODEL, FIXED_SOLVE_SERVICE, FixedPriceSolvingRelay } from "../src/fixed-price.js";
import { createHttpServer } from "../src/http.js";
import { Refunder } from "../src/refunder.js";

class LowGasWallet extends Wallet {
  signs = 0;
  override populateTransaction(request: TransactionRequest) { return super.populateTransaction({ ...request, gasLimit: 100000n }); }
  override signTransaction(request: TransactionRequest) { this.signs++; return super.signTransaction(request); }
}
const failure = (code: string) => (error: unknown) => error instanceof PaymentError && error.code === code;

test("canonical out-of-gas payment is durably terminal; resume never signs again and a noncanonical receipt remains uncertain", { timeout: 30000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-payment-reverted-")), local = await startAnvil();
  let f: Awaited<ReturnType<typeof fixture>> | undefined, relay: FixedPriceSolvingRelay | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  try {
    f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
    const taskId = (await f.task()).toString(); let modelCalls = 0;
    relay = new FixedPriceSolvingRelay({ rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6,
      payTo: f.payee, refunderKey: key(4), service: { id: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL, price: 120000n,
        upstreams: ["cheap", "strong"].map(name => ({ name, model: `controlled-${name}`, baseUrl: "https://unused.invalid/v1", key: "synthetic" })) },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 0 },
    { provider: f.provider, modelFetch: async () => { modelCalls++; throw new Error("No model dispatch for a reverted payment"); } });
    await relay.initialize(); server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, deadlineMs = Date.now() + 90000;
    const config: FixedTaskConfig = { taskId, agentId: "1", rpcUrl: local.rpc, chainId: "31337", account: relay.config.account, asset: relay.config.asset, provider: f.payee,
      relayUrl, underwriterUrl: f.http, maxServicePrice: "120000", deadlineMs, arenaUrl: "http://127.0.0.1:1", escrowAddress: await f.escrow.getAddress(),
      solve: { version: 1, problemId: "sum-integers", tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128, deadlineMs } };
    const signer = new LowGasWallet(key(2), f.provider), sessionDirectory = join(directory, "session");
    const before = { cash: await read(f.account, "cash", [1n]), nonce: await f.provider.getTransactionCount(f.agentAddress), provider: await f.providerBalance() };
    const state = await runFixedPriceTask(sessionDirectory, config, { signer, provider: f.provider, timeoutMs: 5000 });
    assert.equal(state.phase, "Stopped"); assert.equal(state.reason, "PAYMENT_REVERTED"); assert.equal(signer.signs, 1); assert.equal(modelCalls, 0);
    assert.equal(state.reservedPrice, "120000"); assert.equal(state.inference, undefined);
    const receipt = await f.provider.getTransactionReceipt(state.handle!.submission!.txHash!); assert.equal(receipt?.status, 0); assert.equal(receipt!.gasUsed, 100000n); assert.equal(receipt!.logs.length, 0);
    assert.deepEqual(state.handle!.submission!.revertedReceipt, { txHash: receipt!.hash, status: 0, blockNumber: receipt!.blockNumber, blockHash: receipt!.blockHash, gasUsed: "100000" });
    const saved = JSON.parse(await readFile(join(sessionDirectory, "session.json"), "utf8")); assert.deepEqual(saved.handle.submission.revertedReceipt, state.handle!.submission!.revertedReceipt);
    assert.equal(await read(f.account, "cash", [1n]), before.cash); assert.equal(await f.providerBalance(), before.provider); assert.equal((await read(f.manager, "getLoan", [taskId])).status, 0n);
    assert.equal(await f.provider.getTransactionCount(f.agentAddress), before.nonce + 1);
    assert.deepEqual(await runFixedPriceTask(sessionDirectory, config, { signer, provider: f.provider }), state); assert.equal(signer.signs, 1);

    let guards = 0, preserved: PaymentHandle | undefined;
    const sdk = new InferCredit({ agentId: "1", chainId: 31337n, account: config.account, asset: config.asset, provider: config.provider, maxPrice: 120000n,
      signer, underwriterUrl: f.http, beforePayment: () => { guards++; throw new PaymentError("SESSION_DEADLINE", "No new payment authorized"); }, onHandle: handle => { preserved = handle; } });
    try {
      await assert.rejects(sdk.resume(structuredClone(state.handle!)), failure("PAYMENT_REVERTED")); assert.equal(guards, 0); assert.ok(preserved?.submission?.revertedReceipt);
      const originalGetBlock = f.provider.getBlock.bind(f.provider);
      f.provider.getBlock = async (...args) => { const block = await originalGetBlock(...args); return block && args[0] === receipt!.blockNumber ? Object.defineProperty(Object.create(block), "hash", { value: "0x" + "11".repeat(32) }) : block; };
      try { await assert.rejects(sdk.resume(structuredClone(state.handle!)), failure("PAYMENT_UNCERTAIN")); }
      finally { f.provider.getBlock = originalGetBlock; }
      assert.equal(signer.signs, 1); assert.equal(guards, 0); assert.equal(await f.provider.getTransactionCount(f.agentAddress), before.nonce + 1); assert.equal(await read(f.account, "cash", [1n]), before.cash); assert.equal(modelCalls, 0);
    } finally { sdk.close(); }

    // A transport that returns no receipt is still unknown, even if it returned
    // a transaction response. No fabricated status-0 or terminal marker follows.
    const originalBroadcast = f.provider.broadcastTransaction.bind(f.provider);
    f.provider.broadcastTransaction = async () => ({ wait: async () => null } as any);
    let pending: PaymentHandle | undefined;
    const unknown = new InferCredit({ agentId: "1", chainId: 31337n, account: config.account, asset: config.asset, provider: config.provider, maxPrice: 120000n,
      signer, underwriterUrl: f.http, onHandle: handle => { pending = handle; } });
    try {
      await assert.rejects(unknown.forTask(taskId).fetch(relayUrl, { body: { service: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL,
        messages: state.handle!.input.messages, solve: JSON.parse(JSON.stringify(config.solve)) } }), failure("PAYMENT_UNCERTAIN"));
      assert.ok(pending?.submission?.rawTransaction); assert.equal(pending?.submission?.revertedReceipt, undefined);
      assert.equal(await f.provider.getTransactionCount(f.agentAddress), before.nonce + 1); assert.equal(await read(f.account, "cash", [1n]), before.cash); assert.equal(modelCalls, 0);
    } finally { unknown.close(); f.provider.broadcastTransaction = originalBroadcast; }
  } finally {
    if (server) await new Promise<void>(resolve => server!.close(() => resolve())); relay?.close(); await f?.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true });
  }
});
