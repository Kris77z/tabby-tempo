import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
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
import { upstreamAttemptsDigest } from "../src/store.js";

const digest = (text: string) => keccak256(toUtf8Bytes(text));
const hasCode = (code: string) => (error: unknown) => error instanceof PaymentError && error.code === code;
test("operator accepts Unknown delivery cost without rewriting dispatch evidence, and only one full refund survives restart", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-operator-resolution-"));
  let child: ChildProcess | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined, infer: InferCredit | undefined;
  let running: Awaited<ReturnType<typeof serve>> | undefined, latest!: PaymentHandle, calls = 0;
  const upstreamFetch: typeof fetch = async () => { calls++; return Response.json({ error: "controlled upstream uncertainty" }, { status: 503 }); };
  const serve = async (config: RelayConfig, port = 0) => {
    const relay = new Relay(config, { provider: f!.provider, upstreamFetch }), refunder = new Refunder(relay);
    await relay.initialize(); await refunder.initialize();
    const server = createHttpServer(relay, refunder); server.listen(port, "127.0.0.1"); await once(server, "listening");
    const actualPort = (server.address() as { port: number }).port, url = `http://127.0.0.1:${actualPort}`;
    const request = async (path: string, body: unknown, headers = {}) => {
      const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
      return { status: response.status, body: await response.json() as any };
    };
    return { relay, refunder, url, port: actualPort, request, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); relay.close(); } };
  };
  try {
    const local = await startAnvil(); child = local.child; f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6,
      payTo: f.payee, service: { id: "infercredit/planner", model: "planner", price: 1000n, upstreams: ["primary", "fallback"].map(name => ({ name, model: "kimi-k2.6", baseUrl: `https://${name}.invalid/v1`, key: "synthetic-only" })) },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 100, host: "127.0.0.1", port: 8788,
      frontendOrigin: "http://localhost:3000", operatorToken: "synthetic-local-operator-token-32", refunderKey: key(1) };
    const auth = { authorization: `Bearer ${config.operatorToken}` };
    running = await serve(config);
    infer = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account,
      asset: config.asset, provider: config.payTo, maxPrice: 1000n, onHandle: handle => { latest = handle; } });
    await assert.rejects(infer.fetch(running.url + "/v1/chat", { body: { service: config.service.id, model: config.service.model, messages: [{ role: "user", content: "operator audit fixture" }] } }), hasCode("UPSTREAM_UNCERTAIN"));
    const handle = structuredClone(latest), id = handle.quote.paymentId, initial = await running.relay.store.read(id);
    const input = { paymentId: id, resolutionId: randomUUID(), expectedAttemptsDigest: upstreamAttemptsDigest(initial.upstreamAttempts!), evidenceDigest: digest("operator acknowledges unknown vendor cost") };
    const refund = { paymentId: id, refundId: digest("operator full refund"), amount: "1000" };
    const restart = async () => { const port = running!.port; await running!.close(); running = await serve(config, port); await running.relay.recover(); };
    await t.test("unknown without decision, unauthenticated/browser requests, extra fields and stale digest fail closed", async () => {
      assert.equal((await running!.request("/ops/refund", refund, auth)).body.error, "UPSTREAM_UNCERTAIN");
      assert.equal((await running!.request("/ops/resolve-undelivered", input)).status, 403);
      assert.equal((await running!.request("/ops/resolve-undelivered", input, { authorization: "Bearer wrong" })).status, 403);
      assert.equal((await running!.request("/ops/resolve-undelivered", input, { ...auth, origin: config.frontendOrigin! })).status, 403);
      assert.equal((await running!.request("/ops/resolve-undelivered", { ...input, reason: "change decision" }, auth)).status, 400);
      assert.equal((await running!.request("/ops/resolve-undelivered", { ...input, resolutionId: "invalid" }, auth)).status, 400);
      assert.equal((await running!.request("/ops/resolve-undelivered", { ...input, expectedAttemptsDigest: digest("stale") }, auth)).body.error, "OPERATOR_RESOLUTION_CONFLICT");
      assert.equal((await running!.relay.store.read(id)).operatorResolution, undefined); assert.equal(calls, 1);
    });
    await t.test("active dispatch, delivered bytes, existing refund and unconfirmed payment are ineligible", async () => {
      for (const mutate of [
        (r: typeof initial) => { r.upstreamAttempts![0].state = "Dispatching"; },
        (r: typeof initial) => { r.result = { choices: [] }; },
        (r: typeof initial) => { r.refunds.push({ id: digest("preexisting"), amount: "1", state: "Prepared" }); },
        (r: typeof initial) => { delete r.proof; },
      ]) {
        const state = structuredClone(initial); mutate(state); await running!.relay.store.write(state);
        const result = await running!.request("/ops/resolve-undelivered", { ...input, expectedAttemptsDigest: upstreamAttemptsDigest(state.upstreamAttempts!) }, auth);
        assert.equal(result.body.error, "OPERATOR_RESOLUTION_NOT_ALLOWED");
      }
      await running!.relay.store.write(initial);
    });
    await t.test("payment lock prevents a decision racing the running delivery", async () => {
      let release!: () => void, entered!: () => void;
      const ready = new Promise<void>(resolve => { entered = resolve; });
      const held = running!.relay.store.lock(id, async () => { entered(); await new Promise<void>(resolve => { release = resolve; }); });
      await ready; let finished = false;
      const resolving = running!.relay.resolveUndelivered(input).then(result => { finished = true; return result; });
      await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(finished, false); release(); await held;
      const result = await resolving; assert.equal(result.operatorResolution?.reason, "operator-accepted-nondelivery-cost");
      const record = await running!.relay.store.read(id); assert.deepEqual(record.upstreamAttempts, initial.upstreamAttempts);
      assert.equal(record.lastError, "UPSTREAM_UNCERTAIN"); assert.equal(record.state, "Processing");
    });
    await t.test("decision is immutable/idempotent and blocks every redispatch after restart", async () => {
      const saved = (await running!.relay.store.read(id)).operatorResolution;
      for (const changed of [{ resolutionId: randomUUID() }, { evidenceDigest: digest("different evidence") }])
        assert.equal((await running!.request("/ops/resolve-undelivered", { ...input, ...changed }, auth)).body.error, "OPERATOR_RESOLUTION_CONFLICT");
      assert.deepEqual((await running!.request("/ops/resolve-undelivered", input, auth)).body.operatorResolution, saved);
      await restart(); await assert.rejects(infer!.resume(handle), hasCode("OPERATOR_RESOLVED_UNDELIVERED"));
      assert.equal((await running!.request("/v1/chat", handle.input, { "x-payment-id": id })).body.error, "OPERATOR_RESOLVED_UNDELIVERED");
      assert.equal(calls, 1); assert.deepEqual((await running!.relay.store.read(id)).operatorResolution, saved);
      const changed = await running!.relay.store.read(id); changed.upstreamAttempts![0].httpStatus = 500; await running!.relay.store.write(changed);
      assert.equal((await running!.request("/ops/refund", refund, auth)).body.error, "OPERATOR_RESOLUTION_CONFLICT");
      changed.upstreamAttempts = initial.upstreamAttempts; await running!.relay.store.write(changed);
    });
    await t.test("only full refund admitted; crash before finish recovers the same refund without inference", async () => {
      assert.equal((await running!.request("/ops/refund", { ...refund, amount: "500" }, auth)).body.error, "OPERATOR_REFUND_FULL_ONLY");
      assert.equal((await read(f!.account, "getPayment", [id])).refundedAmount, 0n);
      const write = running!.relay.store.write.bind(running!.relay.store);
      running!.relay.store.write = async record => { await write(record); if (record.refunds.length) throw new Error("controlled crash after durable refund reservation"); };
      assert.equal((await running!.request("/ops/refund", refund, auth)).status, 503);
      assert.equal((await read(f!.account, "getPayment", [id])).refundedAmount, 0n);
      await restart(); await running!.refunder.recover();
      const record = await running!.relay.store.read(id); assert.equal(record.state, "Refunded"); assert.equal(record.refunds.length, 1);
      assert.equal(record.refunds[0].state, "Confirmed"); assert.equal(record.refunds[0].id, refund.refundId); assert.equal(record.refunds[0].amount, "1000");
      assert.deepEqual(record.upstreamAttempts, initial.upstreamAttempts); assert.equal(record.upstreamAttempts![0].state, "Unknown"); assert.equal(record.upstreamAttempts![0].httpStatus, 503);
      assert.equal((await read(f!.account, "getPayment", [id])).refundedAmount, 1000n); assert.equal(calls, 1);
      const nonce = await f!.provider.getTransactionCount(await f!.admin.getAddress());
      const replay = await running!.request("/ops/refund", refund, auth); assert.equal(replay.status, 200); assert.equal(replay.body.refundedAmount, "1000");
      assert.equal(replay.body.refundPending, false);
      assert.deepEqual(replay.body.confirmedRefunds, [{ refundId: refund.refundId, amount: "1000", txHash: record.refunds[0].transaction!.txHash }]);
      assert.equal(JSON.stringify(replay.body).includes("rawTransaction"), false);
      assert.equal((await running!.request("/ops/refund", { ...refund, refundId: digest("second full refund") }, auth)).body.error, "OPERATOR_REFUND_FULL_ONLY");
      assert.equal((await running!.request("/ops/resolve-undelivered", input, auth)).status, 200);
      await restart(); await running!.refunder.recover(); await assert.rejects(infer!.resume(handle), hasCode("REFUNDED"));
      assert.equal(await f!.provider.getTransactionCount(await f!.admin.getAddress()), nonce); assert.equal(calls, 1);
    });
  } finally { infer?.close(); await running?.close(); await f?.close(); if (child) await stopAnvil(child); await rm(directory, { recursive: true, force: true }); }
});
