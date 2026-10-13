import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { keccak256, toUtf8Bytes } from "ethers";
import { InferCredit, PaymentError, type PaymentHandle } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil } from "../../underwriter/test/fixture.js";
import type { RelayConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { Relay } from "../src/relay.js";
import { Refunder } from "../src/refunder.js";

const errorCode = (code: string) => (error: unknown) => error instanceof PaymentError && error.code === code;
const result = { choices: [{ message: { role: "assistant", content: "controlled result" } }], usage: { total_tokens: 3 } };
const brokenBody = (status: number) => new Response(new ReadableStream({ start(controller) { controller.error(new Error("controlled truncated response")); } }), { status });

test("paid upstream uncertainty never dispatches a fallback, replays a model or becomes a refundable rejection", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-upstream-uncertain-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let infer: InferCredit | undefined;
  let running: Awaited<ReturnType<typeof serve>> | undefined;
  let primary: (signal: AbortSignal) => Promise<Response> = async () => Response.json(result);
  let latest!: PaymentHandle;
  const calls: string[] = [];
  const upstreamFetch: typeof fetch = async (url, init) => {
    const name = new URL(String(url)).hostname.split(".")[0];
    calls.push(name);
    assert.equal(new Headers(init!.headers).get("authorization"), `Bearer synthetic-${name}`);
    return name === "primary" ? primary(init!.signal!) : Response.json(result);
  };
  const serve = async (config: RelayConfig, port = 0) => {
    const relay = new Relay(config, { provider: f!.provider, upstreamFetch });
    const refunder = new Refunder(relay);
    await relay.initialize(); await refunder.initialize();
    const server = createHttpServer(relay, refunder);
    server.listen(port, "127.0.0.1"); await once(server, "listening");
    const address = server.address() as { port: number };
    const url = `http://127.0.0.1:${address.port}`;
    const request = async (path: string, body?: unknown, headers = {}) => {
      const response = await fetch(url + path, body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    return { relay, refunder, url, port: address.port, request, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); relay.close(); } };
  };
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    const upstreams = ["primary", "fallback"].map(name => ({ name, model: `${name}-model`, baseUrl: `https://${name}.invalid/v1`, key: `synthetic-${name}` }));
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 6, payTo: f.payee, service: { id: "infercredit/coder", model: "coder", price: 1000n, upstreams },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 25,
      host: "127.0.0.1", port: 8788, operatorToken: "synthetic-local-operator-token-32", refunderKey: key(1) };
    running = await serve(config);
    infer = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account,
      asset: config.asset, provider: config.payTo, maxPrice: 1000n, onHandle: handle => { latest = handle; } });
    const fetchPaid = (label: string) => infer!.fetch(running!.url + "/v1/chat", { body: { service: config.service.id, model: config.service.model,
      messages: [{ role: "user", content: label }] } });
    const restart = async () => {
      const port = running!.port; await running!.close(); running = await serve(config, port); await running.relay.recover();
    };
    const assertUnknown = async (handle: PaymentHandle, expectedCalls: number) => {
      const balance = await f!.providerBalance(), nonce = await f!.provider.getTransactionCount(f!.agentAddress);
      const adminNonce = await f!.provider.getTransactionCount(await f!.admin.getAddress());
      const paymentBefore = await read(f!.account, "getPayment", [handle.quote.paymentId]);
      assert.equal(paymentBefore.fromCash, 1000n); assert.equal(paymentBefore.fromCredit, 0n);
      await assert.rejects(infer!.resume(structuredClone(handle)), errorCode("UPSTREAM_UNCERTAIN"));
      await restart();
      await assert.rejects(infer!.resume(structuredClone(handle)), errorCode("UPSTREAM_UNCERTAIN"));
      const direct = await running!.request("/v1/chat", handle.input, { "x-payment-id": handle.quote.paymentId });
      assert.equal(direct.status, 409); assert.equal(direct.body.error, "UPSTREAM_UNCERTAIN");
      const status = await running!.request(`/payments/${handle.quote.paymentId}?agentId=1&requestDigest=${handle.quote.requestDigest}`);
      assert.equal(status.status, 200); assert.equal(status.body.state, "Processing"); assert.equal(status.body.deliveryError, "UPSTREAM_UNCERTAIN");
      assert.equal(status.body.refundPending, false); assert.equal(status.body.refundedAmount, "0");
      assert.equal(status.body.result, undefined); assert.equal(status.body.receipt, undefined);
      const refund = await running!.request("/ops/refund", { paymentId: handle.quote.paymentId,
        refundId: keccak256(toUtf8Bytes(handle.quote.paymentId)), amount: "1000" }, { authorization: `Bearer ${config.operatorToken}` });
      assert.equal(refund.status, 409); assert.equal(refund.body.error, "UPSTREAM_UNCERTAIN");
      assert.equal(calls.length, expectedCalls);
      assert.equal(await f!.providerBalance(), balance); assert.equal(await f!.provider.getTransactionCount(f!.agentAddress), nonce);
      assert.equal(await f!.provider.getTransactionCount(await f!.admin.getAddress()), adminNonce);
      assert.equal((await read(f!.account, "getPayment", [handle.quote.paymentId])).refundedAmount, 0n);
      const persisted = await readFile(join(config.dataDir, `${handle.quote.paymentId}.json`), "utf8");
      assert.equal(persisted.includes("synthetic-primary"), false); assert.equal(persisted.includes("synthetic-fallback"), false);
      assert.equal(persisted.includes("controlled truncated response"), false);
    };

    for (const [label, reply] of [
      ...[408, 409, 500, 503].map(status => [`HTTP ${status}`, async () => Response.json({ error: "controlled server response" }, { status })] as const),
      ["disconnect", async () => { throw new Error("controlled transport failure containing synthetic-primary"); }],
      ["timeout", async (signal: AbortSignal) => new Promise<Response>((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener("abort", () => reject(signal.reason), { once: true });
      })],
      ["malformed 2xx JSON", async () => new Response("{", { status: 200 })],
      ["invalid 2xx result", async () => Response.json({ choices: [] })],
      ["truncated 2xx body", async () => brokenBody(200)],
      ["truncated rejection body", async () => brokenBody(400)],
    ] as readonly (readonly [string, (signal: AbortSignal) => Promise<Response>])[]) {
      await t.test(label, async () => {
        primary = reply;
        const before = calls.length, balance = await f!.providerBalance(), nonce = await f!.provider.getTransactionCount(f!.agentAddress);
        await assert.rejects(fetchPaid(label), errorCode("UPSTREAM_UNCERTAIN"));
        const handle = structuredClone(latest);
        assert.deepEqual(calls.slice(before), ["primary"]);
        const record = await running!.relay.store.read(handle.quote.paymentId);
        assert.equal(record.upstreamAttempts!.length, 1); assert.equal(record.upstreamAttempts![0].state, "Unknown");
        assert.equal(record.upstreamAttempts![0].upstream, "primary"); assert.equal(record.upstreamAttempts![0].model, "primary-model");
        assert.ok(Number.isSafeInteger(record.upstreamAttempts![0].startedAt));
        assert.equal(await f!.providerBalance(), balance + 1000n); assert.equal(await f!.provider.getTransactionCount(f!.agentAddress), nonce + 1);
        await assertUnknown(handle, before + 1);
      });
    }

    await t.test("crash after durable Dispatching blocks even a request not yet sent", async () => {
      primary = async () => Response.json(result);
      const write = running!.relay.store.write.bind(running!.relay.store), before = calls.length;
      running!.relay.store.write = async record => { await write(record); if (record.upstreamAttempts?.at(-1)?.state === "Dispatching") throw new Error("controlled dispatch checkpoint crash"); };
      await assert.rejects(fetchPaid("dispatch checkpoint crash"), errorCode("SERVICE_UNAVAILABLE"));
      const handle = structuredClone(latest);
      assert.equal((await running!.relay.store.read(handle.quote.paymentId)).upstreamAttempts![0].state, "Dispatching");
      assert.equal(calls.length, before);
      await restart(); await assertUnknown(handle, before);
    });

    await t.test("lost successful result commit cannot bill the model again", async () => {
      primary = async () => Response.json(result);
      const write = running!.relay.store.write.bind(running!.relay.store), before = calls.length;
      running!.relay.store.write = async record => { if (record.state === "Delivered") throw new Error("controlled result commit failure"); await write(record); };
      await assert.rejects(fetchPaid("result commit failure"), errorCode("SERVICE_UNAVAILABLE"));
      const handle = structuredClone(latest);
      assert.equal((await running!.relay.store.read(handle.quote.paymentId)).upstreamAttempts![0].state, "Dispatching");
      await restart(); await assertUnknown(handle, before + 1);
    });

    await t.test("failure saving a rejection does not permit a fallback or refund", async () => {
      primary = async () => Response.json({ error: "controlled request rejection" }, { status: 400 });
      const write = running!.relay.store.write.bind(running!.relay.store), before = calls.length;
      running!.relay.store.write = async record => { if (record.upstreamAttempts?.at(-1)?.state === "Rejected") throw new Error("controlled rejection commit failure"); await write(record); };
      await assert.rejects(fetchPaid("rejection commit failure"), errorCode("SERVICE_UNAVAILABLE"));
      const handle = structuredClone(latest);
      assert.equal((await running!.relay.store.read(handle.quote.paymentId)).upstreamAttempts![0].state, "Dispatching");
      await restart(); await assertUnknown(handle, before + 1);
    });

    await t.test("a client wait timeout can still claim a later saved result without new payment or model dispatch", async () => {
      let release!: (response: Response) => void;
      primary = () => new Promise(resolve => { release = resolve; });
      let delivered!: () => void;
      const completed = new Promise<void>(resolve => { delivered = resolve; });
      const write = running!.relay.store.write.bind(running!.relay.store), before = calls.length;
      running!.relay.store.write = async record => { await write(record); if (record.state === "Delivered") delivered(); };
      const upstreamTimeout = config.upstreamTimeout;
      config.upstreamTimeout = 1000;
      const impatient = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account,
        asset: config.asset, provider: config.payTo, maxPrice: 1000n, timeoutMs: 100, onHandle: handle => { latest = handle; } });
      try {
        await assert.rejects(impatient.fetch(running!.url + "/v1/chat", { body: { service: config.service.id, model: config.service.model,
          messages: [{ role: "user", content: "client wait timeout" }] } }), errorCode("RELAY_UNAVAILABLE"));
        const handle = structuredClone(latest), balance = await f!.providerBalance(), nonce = await f!.provider.getTransactionCount(f!.agentAddress);
        assert.equal((await running!.relay.store.read(handle.quote.paymentId)).state, "Processing");
        release(Response.json(result)); await completed;
        assert.equal((await impatient.resume(handle)).receipt.upstream, "primary");
        await restart(); await infer!.resume(handle);
        assert.deepEqual(calls.slice(before), ["primary"]);
        assert.equal(await f!.providerBalance(), balance); assert.equal(await f!.provider.getTransactionCount(f!.agentAddress), nonce);
      } finally { impatient.close(); config.upstreamTimeout = upstreamTimeout; }
    });

    await t.test("unknown dispatch stays blocked after route deletion or an old pending refund", async () => {
      primary = async () => Response.json({ error: "controlled unknown response" }, { status: 503 });
      const before = calls.length;
      await assert.rejects(fetchPaid("deleted route and pending refund"), errorCode("UPSTREAM_UNCERTAIN"));
      const handle = structuredClone(latest), record = await running!.relay.store.read(handle.quote.paymentId);
      record.refunds.push({ id: keccak256(toUtf8Bytes("legacy pending refund")), amount: "1000", state: "Prepared" });
      await running!.relay.store.write(record);
      const originalUpstreams = config.service.upstreams;
      config.service.upstreams = [{ ...originalUpstreams[0], name: "changed", model: "changed-model" }];
      try {
        await assert.rejects(infer!.resume(handle), errorCode("UPSTREAM_UNCERTAIN"));
        await restart();
        const adminNonce = await f!.provider.getTransactionCount(await f!.admin.getAddress());
        await running!.refunder.recover();
        assert.equal(await f!.provider.getTransactionCount(await f!.admin.getAddress()), adminNonce);
        const current = await running!.relay.store.read(handle.quote.paymentId);
        assert.equal(current.state, "Processing"); assert.equal(current.refunds[0].state, "Prepared");
        assert.equal(current.refunds[0].approval, undefined); assert.equal(current.refunds[0].transaction, undefined);
        assert.equal((await read(f!.account, "getPayment", [handle.quote.paymentId])).refundedAmount, 0n);
        assert.equal(calls.length, before + 1);
      } finally { config.service.upstreams = originalUpstreams; }
    });

    await t.test("durable rejection resumes only the next candidate", async () => {
      primary = async () => Response.json({ error: "controlled request rejection" }, { status: 400 });
      const write = running!.relay.store.write.bind(running!.relay.store), before = calls.length;
      running!.relay.store.write = async record => { await write(record); if (record.upstreamAttempts?.at(-1)?.state === "Rejected") throw new Error("controlled rejection checkpoint crash"); };
      await assert.rejects(fetchPaid("rejection checkpoint crash"), errorCode("SERVICE_UNAVAILABLE"));
      const handle = structuredClone(latest), balance = await f!.providerBalance(), nonce = await f!.provider.getTransactionCount(f!.agentAddress);
      assert.deepEqual(calls.slice(before), ["primary"]);
      await restart();
      const delivered = await infer!.resume(handle);
      assert.equal(delivered.receipt.upstream, "fallback"); assert.equal(delivered.receipt.model, "fallback-model"); assert.equal(delivered.receipt.price, "1000");
      assert.deepEqual(calls.slice(before), ["primary", "fallback"]);
      assert.deepEqual((await running!.relay.store.read(handle.quote.paymentId)).upstreamAttempts!.map(attempt => attempt.state), ["Rejected", "Delivered"]);
      assert.equal(await f!.providerBalance(), balance); assert.equal(await f!.provider.getTransactionCount(f!.agentAddress), nonce);
    });

    for (const status of [400, 401, 403, 404, 413, 415, 422, 429]) await t.test(`complete HTTP ${status} rejection permits one paid fallback`, async () => {
      primary = async () => Response.json({ error: "controlled rejection" }, { status });
      const before = calls.length, nonce = await f!.provider.getTransactionCount(f!.agentAddress), balance = await f!.providerBalance();
      const delivered = await fetchPaid(`explicit rejection ${status}`);
      assert.deepEqual(calls.slice(before), ["primary", "fallback"]);
      assert.equal(delivered.receipt.upstream, "fallback"); assert.equal(delivered.receipt.model, "fallback-model");
      assert.equal(delivered.receipt.price, "1000"); assert.equal(delivered.receipt.fromCash, "1000");
      assert.deepEqual((await running!.relay.store.read(delivered.handle.quote.paymentId)).upstreamAttempts!.map(attempt => [attempt.state, attempt.httpStatus]), [["Rejected", status], ["Delivered", 200]]);
      await restart(); await infer!.resume(delivered.handle);
      assert.equal(calls.length, before + 2); assert.equal(await f!.providerBalance(), balance + 1000n);
      assert.equal(await f!.provider.getTransactionCount(f!.agentAddress), nonce + 1);
    });

    for (const state of ["Processing", "Paid"] as const) await t.test(`legacy ${state} without dispatch evidence is not retried or refunded`, async () => {
      primary = async () => Response.json({ error: "controlled unknown response" }, { status: 503 });
      const before = calls.length;
      await assert.rejects(fetchPaid(`legacy ${state}`), errorCode("UPSTREAM_UNCERTAIN"));
      const handle = structuredClone(latest), record = await running!.relay.store.read(handle.quote.paymentId);
      delete record.upstreamAttempts; record.state = state;
      if (state === "Paid") record.lastError = "UPSTREAM_FAILED"; else delete record.lastError;
      await running!.relay.store.write(record);
      await assertUnknown(handle, before + 1);
    });
  } finally {
    infer?.close(); await running?.close(); await f?.close(); if (child) await stopAnvil(child);
    await rm(directory, { recursive: true, force: true });
  }
});
