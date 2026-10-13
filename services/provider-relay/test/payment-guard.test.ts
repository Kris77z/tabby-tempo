import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ChildProcess } from "node:child_process";
import { BrowserProvider, Wallet, type TransactionRequest } from "ethers";
import { EMPTY_AUTH, InferCredit, PaymentError, type ChatInput, type InferOptions, type PaymentHandle } from "@agentfuel/sdk";
import type { RelayConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { Refunder } from "../src/refunder.js";
import { Relay } from "../src/relay.js";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../underwriter/test/fixture.js";

const body = { service: "infercredit/coder", model: "coder", messages: [{ role: "user", content: "Return a public sample solution" }] };
const denied = () => new PaymentError("GUARD_DENIED", "controlled payment guard rejection");
const errorCode = (code: string) => (error: unknown) => error instanceof PaymentError && error.code === code;
class CountingWallet extends Wallet {
  signs = 0;
  override async signTransaction(request: TransactionRequest) { this.signs++; return super.signTransaction(request); }
}

test("payment guard covers sign, raw replay, browser send and durable handles; paid claims bypass it", { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-payment-guard-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined;
  let closeServer: (() => Promise<void>) | undefined;
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    const active = f;
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(),
      asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: body.service, model: body.model, price: 10000n,
        upstreams: [{ name: "controlled", baseUrl: "https://upstream.invalid/v1", model: "controlled-model", key: "synthetic" }] },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788 };
    let upstreamCalls = 0;
    relay = new Relay(config, { provider: f.provider, upstreamFetch: async () => {
      upstreamCalls++;
      return Response.json({ model: "controlled-model", choices: [{ message: { role: "assistant", content: "print(1)" }, finish_reason: "stop" }] });
    } });
    await relay.initialize();
    const server = createHttpServer(relay, new Refunder(relay));
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    closeServer = () => new Promise<void>(resolve => server.close(() => resolve()));
    const relayUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
    const options: Omit<InferOptions, "sessionKey" | "signer"> = { agentId: "1", chainId: 31337n,
      account: config.account, asset: config.asset, provider: config.payTo, maxPrice: config.service.price };
    const snapshot = async () => ({ nonce: await active.provider.getTransactionCount(active.agentAddress, "latest"),
      cash: await read(active.account, "cash", [1n]), provider: await active.providerBalance(), native: await active.provider.getBalance(active.agentAddress) });
    const browser = async () => {
      let sends = 0;
      const provider = new BrowserProvider({ request: async ({ method, params }: { method: string; params?: readonly unknown[] | object }) => {
        if (method === "eth_accounts" || method === "eth_requestAccounts") return [active.agentAddress];
        if (method === "eth_sendTransaction") { sends++; throw new Error("Unexpected browser send in a denied-payment test"); }
        return active.provider.send(method, params as unknown[] || []);
      } });
      return { provider, signer: await provider.getSigner(active.agentAddress), sends: () => sends };
    };

    await t.test("last guard before Wallet signing refuses without changing balances or nonce", async () => {
      const before = await snapshot();
      const signer = new CountingWallet(key(2), active.provider);
      let checks = 0; let saved!: PaymentHandle;
      const infer = new InferCredit({ ...options, signer, onHandle: handle => { saved = handle; }, beforePayment: () => {
        if (++checks === 2) throw denied();
      } });
      try {
        await assert.rejects(infer.fetch(relayUrl, { body }), errorCode("GUARD_DENIED"));
        assert.equal(checks, 2); assert.equal(signer.signs, 0); assert.equal(saved.submission, undefined);
        assert.deepEqual(await snapshot(), before);
      } finally { infer.close(); }
    });

    await t.test("guard refuses original broadcast and the same signed raw replay", async () => {
      const before = await snapshot();
      const signer = new CountingWallet(key(2), active.provider);
      let prepared!: PaymentHandle;
      const prepare = new InferCredit({ ...options, signer, onHandle: handle => { prepared = handle; }, beforePayment: handle => {
        if (handle.submission?.rawTransaction) throw denied();
      } });
      try {
        await assert.rejects(prepare.fetch(relayUrl, { body }), errorCode("GUARD_DENIED"));
        assert.equal(signer.signs, 1); assert.ok(prepared.submission?.rawTransaction);
        assert.equal(await active.provider.getTransaction(prepared.submission!.txHash!), null);
        assert.deepEqual(await snapshot(), before);
      } finally { prepare.close(); }
      let checks = 0;
      const replay = new InferCredit({ ...options, signer, beforePayment: () => { if (++checks === 2) throw denied(); } });
      try {
        await assert.rejects(replay.resume(prepared), errorCode("GUARD_DENIED"));
        assert.equal(checks, 2); assert.equal(signer.signs, 1);
        assert.equal(await active.provider.getTransaction(prepared.submission!.txHash!), null);
        assert.deepEqual(await snapshot(), before);
      } finally { replay.close(); }
    });

    await t.test("guard after durable browser intent prevents eth_sendTransaction", async () => {
      const before = await snapshot(); const connection = await browser();
      let checks = 0; let intent!: PaymentHandle;
      const infer = new InferCredit({ ...options, signer: connection.signer, onHandle: handle => { intent = handle; }, beforePayment: () => {
        if (++checks === 3) throw denied();
      } });
      try {
        await assert.rejects(infer.fetch(relayUrl, { body }), errorCode("GUARD_DENIED"));
        assert.equal(checks, 3); assert.equal(connection.sends(), 0);
        assert.ok(intent.submission); assert.equal(intent.submission!.rawTransaction, undefined); assert.equal(intent.submission!.txHash, undefined);
        assert.deepEqual(await snapshot(), before);
      } finally { infer.close(); connection.provider.destroy(); }
    });

    await t.test("failed handle persistence stops initial payment, raw broadcast and browser send", async () => {
      const before = await snapshot();
      const signer = new CountingWallet(key(2), active.provider);
      let checks = 0;
      const initial = new InferCredit({ ...options, signer, onHandle: () => { throw new Error("controlled initial save failure"); },
        beforePayment: () => { checks++; } });
      try {
        await assert.rejects(initial.fetch(relayUrl, { body }), /controlled initial save failure/);
        assert.equal(checks, 0); assert.equal(signer.signs, 0); assert.deepEqual(await snapshot(), before);
      } finally { initial.close(); }
      let prepared!: PaymentHandle;
      const raw = new InferCredit({ ...options, signer, onHandle: handle => {
        prepared = handle; if (handle.submission?.rawTransaction) throw new Error("controlled signed save failure");
      } });
      try {
        await assert.rejects(raw.fetch(relayUrl, { body }), errorCode("PAYMENT_UNCERTAIN"));
        assert.equal(signer.signs, 1); assert.ok(prepared.submission?.rawTransaction);
        assert.equal(await active.provider.getTransaction(prepared.submission!.txHash!), null);
        assert.deepEqual(await snapshot(), before);
      } finally { raw.close(); }
      const connection = await browser();
      const intent = new InferCredit({ ...options, signer: connection.signer, onHandle: handle => {
        if (handle.submission) throw new Error("controlled intent save failure");
      } });
      try {
        await assert.rejects(intent.fetch(relayUrl, { body }), errorCode("PAYMENT_UNCERTAIN"));
        assert.equal(connection.sends(), 0); assert.deepEqual(await snapshot(), before);
      } finally { intent.close(); connection.provider.destroy(); }
    });

    await t.test("wall-clock expiry rejects unsigned and signed recovery while the latest block is still stale", async st => {
      const input = { ...body, agentId: "1", taskId: "0" } as ChatInput;
      const quote = await relay!.quote(input), before = await snapshot(), signer = new CountingWallet(key(2), active.provider);
      const handle: PaymentHandle = { version: 1, relayUrl, input, quote, creditNonce: "1" };
      let prepared!: PaymentHandle;
      const prepare = new InferCredit({ ...options, signer, onHandle: saved => { prepared = saved; }, beforePayment: h => { if (h.submission?.rawTransaction) throw denied(); } });
      try { await assert.rejects(prepare.resume(handle), errorCode("GUARD_DENIED")); }
      finally { prepare.close(); }
      assert.equal(signer.signs, 1); assert.ok(prepared.submission?.rawTransaction);
      assert.ok(BigInt((await active.provider.getBlock("latest"))!.timestamp) < BigInt(quote.quoteExpiry));
      st.mock.method(Date, "now", () => (Number(quote.quoteExpiry) + 1) * 1000);
      const unsignedSigner = new CountingWallet(key(2), active.provider), unsigned = new InferCredit({ ...options, signer: unsignedSigner });
      const signed = new InferCredit({ ...options, signer });
      try {
        const original: PaymentHandle = { version: 1, relayUrl, input, quote, creditNonce: "1" };
        await assert.rejects(unsigned.resume(original), errorCode("QUOTE_EXPIRED"));
        assert.equal(unsignedSigner.signs, 0); assert.equal(original.submission, undefined);
        await assert.rejects(signed.resume(prepared), errorCode("QUOTE_EXPIRED"));
        assert.equal(signer.signs, 1); assert.equal(await active.provider.getTransaction(prepared.submission!.txHash!), null);
        assert.deepEqual(await snapshot(), before);
      } finally { unsigned.close(); signed.close(); st.mock.restoreAll(); }
    });

    await t.test("expiry during payment preparation is checked again before signing or broadcasting", async st => {
      let current = Date.now(); st.mock.method(Date, "now", () => current);
      const before = await snapshot(), signer = new CountingWallet(key(2), active.provider); let checks = 0, unsigned!: PaymentHandle;
      const preSign = new InferCredit({ ...options, signer, onHandle: h => { unsigned = h; }, beforePayment: h => { if (++checks === 2) current = (Number(h.quote.quoteExpiry) + 1) * 1000; } });
      try { await assert.rejects(preSign.fetch(relayUrl, { body }), errorCode("QUOTE_EXPIRED")); assert.equal(signer.signs, 0); assert.equal(unsigned.submission, undefined); }
      finally { preSign.close(); }
      current = Number((await active.provider.getBlock("latest"))!.timestamp) * 1000; let prepared!: PaymentHandle;
      const preBroadcast = new InferCredit({ ...options, signer, onHandle: h => { prepared = h; if (h.submission?.rawTransaction) current = (Number(h.quote.quoteExpiry) + 1) * 1000; } });
      try {
        await assert.rejects(preBroadcast.fetch(relayUrl, { body }), errorCode("QUOTE_EXPIRED")); assert.equal(signer.signs, 1);
        assert.ok(prepared.submission?.rawTransaction); assert.equal(await active.provider.getTransaction(prepared.submission!.txHash!), null);
        assert.deepEqual(await snapshot(), before);
      } finally { preBroadcast.close(); st.mock.restoreAll(); }
    });

    await t.test("confirmed cash payment and cached delivery reconcile after wall-clock expiry without invoking the spending guard", async st => {
      const input = { ...body, agentId: "1", taskId: "0" } as ChatInput;
      const quote = await relay!.quote(input);
      const payment = await tx(active.account, active.agent, "payProvider", [1n, config.payTo, quote.price, quote.paymentId, EMPTY_AUTH, "0x"]);
      const paid = await snapshot(); let checks = 0;
      st.mock.method(Date, "now", () => (Number(quote.quoteExpiry) + 1) * 1000);
      const handle: PaymentHandle = { version: 1, relayUrl, input, quote, creditNonce: "1" };
      const infer = new InferCredit({ ...options, signer: new CountingWallet(key(2), active.provider), beforePayment: () => { checks++; throw denied(); } });
      try {
        const delivered = await infer.resume(handle);
        assert.equal(delivered.receipt.txHash, payment.hash); assert.equal(delivered.receipt.fromCash, quote.price); assert.equal(delivered.receipt.fromCredit, "0");
        assert.equal(checks, 0); assert.equal(upstreamCalls, 1); assert.deepEqual(await snapshot(), paid);
        assert.deepEqual((await infer.resume(structuredClone(handle))).result, delivered.result);
        assert.equal(checks, 0); assert.equal(upstreamCalls, 1); assert.deepEqual(await snapshot(), paid);
      } finally { infer.close(); st.mock.restoreAll(); }
    });
    await t.test("confirmed late payment reaches relay refund-only reconciliation instead of the local expiry guard", async () => {
      const input = { ...body, agentId: "1", taskId: "0" } as ChatInput, quote = await relay!.quote(input);
      await active.provider.send("evm_setNextBlockTimestamp", [Number(quote.quoteExpiry) + 1]);
      await tx(active.account, active.agent, "payProvider", [1n, config.payTo, quote.price, quote.paymentId, EMPTY_AUTH, "0x"]);
      const paid = await snapshot(), signer = new CountingWallet(key(2), active.provider);
      const infer = new InferCredit({ ...options, signer, beforePayment: () => { throw denied(); } });
      try {
        await assert.rejects(infer.resume({ version: 1, relayUrl, input, quote, creditNonce: "1" }), errorCode("PAYMENT_AFTER_EXPIRY"));
        assert.equal(signer.signs, 0); assert.equal(upstreamCalls, 1); assert.deepEqual(await snapshot(), paid);
        assert.equal((await relay!.store.read(quote.paymentId)).expiredPayment, true);
      } finally { infer.close(); }
    });
  } finally {
    await closeServer?.(); relay?.close(); await f?.close(); if (child) await stopAnvil(child);
    await rm(directory, { recursive: true, force: true });
  }
});
