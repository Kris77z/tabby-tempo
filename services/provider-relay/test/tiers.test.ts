import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { keccak256, toUtf8Bytes } from "ethers";
import { EMPTY_AUTH, InferCredit, PaymentError, requestDigest, type ChatInput, type PaymentHandle } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../underwriter/test/fixture.js";
import { loadConfig, type RelayConfig, type Upstream } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { Relay, RelayError } from "../src/relay.js";
import { Refunder } from "../src/refunder.js";

const body = { service: "infercredit/coder", model: "coder", messages: [{ role: "user", content: "Return a local deterministic solution." }] };
const paymentError = (code: string) => (error: unknown) => error instanceof PaymentError && error.code === code;
const relayError = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;
const endpoint = (name: string): Upstream => ({ name, model: `${name}-model`, baseUrl: `https://${name}.invalid/v1`, key: `synthetic-route-${name}` });

test("tier configuration is explicit, paired and priced cheap below strong; legacy config stays compatible", async () => {
  const env = { RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "31337", ACCOUNT_ADDRESS: "0x" + "11".repeat(20),
    PROVIDER_ADDRESS: "0x" + "22".repeat(20), SETTLEMENT_ASSET: "0x" + "33".repeat(20), ASSET_DECIMALS: "6", TEST_API_KEY: "synthetic" };
  const upstreams = [{ name: "test", baseUrl: "https://upstream.invalid/v1", model: "test", keyEnv: "TEST_API_KEY" }];
  const legacy = loadConfig({ ...env, PRICE: "10000", UPSTREAMS_JSON: JSON.stringify(upstreams) });
  assert.equal(legacy.service.model, "coder"); assert.equal(legacy.service.price, 10000n); assert.equal(legacy.service.tiers, undefined);
  const definitions = { cheap: { price: "10000", upstreams }, strong: { price: "30000", upstreams } };
  const config = loadConfig({ ...env, TIERS_JSON: JSON.stringify(definitions) });
  assert.equal(config.service.tiers!.cheap.price, 10000n); assert.equal(config.service.tiers!.strong.price, 30000n);
  for (const tiers of [{ cheap: definitions.cheap }, { ...definitions, other: definitions.cheap },
    { ...definitions, strong: { ...definitions.strong, price: "10000" } },
    { ...definitions, cheap: { ...definitions.cheap, price: "40000" } },
    { ...definitions, cheap: { ...definitions.cheap, price: "0" } }]) {
    assert.throws(() => loadConfig({ ...env, TIERS_JSON: JSON.stringify(tiers) }));
  }
  assert.throws(() => loadConfig({ ...env, PRICE: "10000", UPSTREAMS_JSON: JSON.stringify(upstreams), TIERS_JSON: JSON.stringify(definitions) }), /not both/);
  for (const baseUrl of ["https://secret@upstream.invalid/v1", "https://upstream.invalid/v1?key=secret"]) {
    assert.throws(() => loadConfig({ ...env, PRICE: "10000", UPSTREAMS_JSON: JSON.stringify([{ ...upstreams[0], baseUrl }]) }), /without credentials/);
  }
  const input = { ...body, agentId: "1", taskId: "0" } as ChatInput;
  for (const cfg of [legacy, config]) {
    const relay = new Relay(cfg);
    try {
      assert.throws(() => relay.validate({ ...input, tier: "unknown" }), relayError("INVALID_TIER"));
      await assert.rejects(relay.quote({ ...input, tier: "unknown" } as unknown as ChatInput), relayError("INVALID_TIER"));
    } finally { relay.close(); }
  }
  const relay = new Relay(config);
  try {
    assert.throws(() => relay.validate(input), relayError("INVALID_TIER"));
    assert.equal(relay.validate({ ...input, tier: "strong" }).tier, "strong");
    assert.notEqual(requestDigest({ ...input, tier: "cheap" }), requestDigest({ ...input, tier: "strong" }));
    assert.throws(() => new Relay({ ...config, service: { ...config.service, tiers: { ...config.service.tiers!, strong: { ...config.service.tiers!.strong, price: 1n } } } }), /cheap price/);
  } finally { relay.close(); }
});

test("SDK tiers reject overbudget quotes before payment and keep fallback, locked recovery and refund exits", { timeout: 120_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-tiers-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let running: Awaited<ReturnType<typeof serve>> | undefined;
  let infer: InferCredit | undefined;
  let lowBudget: InferCredit | undefined;
  const calls: { name: string; model: string; authorization: string | null; input: any }[] = [];
  let failAll = false;
  const upstreamFetch: typeof fetch = async (url, init) => {
    const input = JSON.parse(String(init!.body));
    const name = new URL(String(url)).hostname.split(".")[0];
    calls.push({ name, model: input.model, authorization: new Headers(init!.headers).get("authorization"), input });
    assert.equal(input.tier, undefined); assert.equal(input.service, undefined); assert.equal(input.agentId, undefined); assert.equal(input.taskId, undefined);
    if (failAll || name.endsWith("primary")) return Response.json({ error: "local quota rejection" }, { status: 429 });
    return Response.json({ model: input.model, choices: [{ message: { role: "assistant", content: "local result" } }], usage: { total_tokens: 3 } });
  };
  const serve = async (config: RelayConfig) => {
    const relay = new Relay(config, { provider: f!.provider, upstreamFetch });
    const refunder = new Refunder(relay);
    await relay.initialize(); await refunder.initialize();
    const server = createHttpServer(relay, refunder);
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const request = async (path: string, input?: unknown, headers = {}) => {
      const response = await fetch(url + path, input === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
      return { status: response.status, body: await response.json() as any };
    };
    return { relay, refunder, url, request, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); relay.close(); } };
  };
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    await tx(f.account, f.agent, "depositCash", [1n, 500000n]);
    const cheap = [endpoint("cheap-primary"), endpoint("cheap-fallback")];
    const strong = [endpoint("strong-primary"), endpoint("strong-fallback")];
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 6, payTo: f.payee, service: { id: body.service, model: body.model, price: 10000n, upstreams: cheap,
        tiers: { cheap: { price: 10000n, upstreams: cheap }, strong: { price: 30000n, upstreams: strong } } },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000,
      host: "127.0.0.1", port: 8788, operatorToken: "synthetic-local-operator-token-32", refunderKey: key(1) };
    running = await serve(config);
    let latest!: PaymentHandle;
    const options = { agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n,
      account: config.account, asset: config.asset, provider: config.payTo, maxPrice: 30000n };
    infer = new InferCredit({ ...options, onHandle: handle => { latest = handle; } });
    let handles = 0;
    lowBudget = new InferCredit({ ...options, maxPrice: 10000n, onHandle: () => { handles++; } });
    const balanceBefore = await f.providerBalance();
    const nonceBefore = await f.provider.getTransactionCount(f.agentAddress);
    await assert.rejects(lowBudget.fetch(running.url + "/v1/chat", { body: { ...body, tier: "strong" } }), paymentError("UNTRUSTED_QUOTE"));
    assert.equal(handles, 0); assert.equal(calls.length, 0);
    assert.equal(await f.providerBalance(), balanceBefore); assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonceBefore);
    for (const id of await running.relay.store.ids()) {
      assert.equal((await read(f.account, "getPayment", [id])).fromCash, 0n);
    }
    const cheapResult = await lowBudget.fetch(running.url + "/v1/chat", { body: { ...body, tier: "cheap" } });
    assert.equal(cheapResult.receipt.tier, "cheap"); assert.equal(cheapResult.receipt.price, "10000");
    assert.equal(cheapResult.receipt.upstream, "cheap-fallback"); assert.equal(cheapResult.receipt.model, "cheap-fallback-model");
    assert.deepEqual(calls.map(call => call.name), ["cheap-primary", "cheap-fallback"]);
    assert.equal((await f.providerBalance()) - balanceBefore, 10000n);
    assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonceBefore + 1);
    assert.throws(() => lowBudget!.resume({ ...cheapResult.handle, quote: { ...cheapResult.handle.quote, tier: "strong" } }), paymentError("UNTRUSTED_QUOTE"));
    assert.deepEqual(await lowBudget.resume(structuredClone(cheapResult.handle)), cheapResult);
    assert.equal(calls.length, 2);

    // Crash after the durable Processing write; restart with reordered candidates, a new model, higher price and rotated keys.
    const originalWrite = running.relay.store.write.bind(running.relay.store);
    let crash = true;
    running.relay.store.write = async record => { await originalWrite(record); if (crash && record.state === "Processing") { crash = false; throw new Error("local crash after Processing"); } };
    await assert.rejects(infer.fetch(running.url + "/v1/chat", { body: { ...body, tier: "strong" } }), paymentError("SERVICE_UNAVAILABLE"));
    const processing = structuredClone(latest);
    assert.equal(processing.quote.price, "30000"); assert.equal(processing.quote.tier, "strong");
    assert.ok(BigInt(cheapResult.receipt.price) < BigInt(processing.quote.price));
    assert.equal((await running.relay.store.read(processing.quote.paymentId)).state, "Processing");
    const paidBalance = await f.providerBalance(); const paidNonce = await f.provider.getTransactionCount(f.agentAddress);
    await running.close();
    const reordered = structuredClone(config);
    reordered.service.tiers!.strong = { price: 60000n, upstreams: [endpoint("strong-new"),
      { ...strong[1], key: "synthetic-route-rotated-fallback" }, { ...strong[0], key: "synthetic-route-rotated-primary" }] };
    running = await serve(reordered);
    await running.relay.recover();
    const recoveredHandle = { ...processing, relayUrl: running.url + "/v1/chat" };
    const recovered = await infer.resume(recoveredHandle);
    assert.equal(recovered.receipt.price, "30000"); assert.equal(recovered.receipt.tier, "strong");
    assert.equal(recovered.receipt.upstream, "strong-fallback"); assert.equal(recovered.receipt.model, "strong-fallback-model");
    assert.deepEqual(calls.slice(2).map(call => call.name), ["strong-primary", "strong-fallback"]);
    assert.deepEqual(calls.slice(2).map(call => call.authorization), ["Bearer synthetic-route-rotated-primary", "Bearer synthetic-route-rotated-fallback"]);
    const replayed = await Promise.all([infer.resume(structuredClone(recoveredHandle)), infer.resume(structuredClone(recoveredHandle))]);
    assert.deepEqual(replayed[0].receipt, recovered.receipt); assert.equal(calls.length, 4);
    assert.equal(await f.providerBalance(), paidBalance); assert.equal(await f.provider.getTransactionCount(f.agentAddress), paidNonce);

    // Both strong candidates fail. Cheap is never called, and a changed physical model cannot service the locked quote.
    reordered.service.tiers!.strong = structuredClone(config.service.tiers!.strong);
    failAll = true;
    await assert.rejects(infer.fetch(running.url + "/v1/chat", { body: { ...body, tier: "strong" } }), paymentError("UPSTREAM_FAILED"));
    const failed = structuredClone(latest);
    assert.equal((await running.relay.store.read(failed.quote.paymentId)).state, "Paid");
    assert.deepEqual(calls.slice(4).map(call => call.name), ["strong-primary", "strong-fallback"]);
    const failedBalance = await f.providerBalance(); const failedNonce = await f.provider.getTransactionCount(f.agentAddress);
    for (const field of ["model", "baseUrl"] as const) {
      reordered.service.tiers!.strong.upstreams = strong.map(upstream => ({ ...upstream, [field]: field === "model" ? "cheap-model" : "https://changed.invalid/v1" }));
      await assert.rejects(infer.resume({ ...failed, relayUrl: running.url + "/v1/chat" }), paymentError("ROUTE_UNAVAILABLE"));
      assert.equal(calls.length, 6); assert.equal(await f.providerBalance(), failedBalance);
    }
    // An unpaid quote from the original route also refuses to submit payment after a config change.
    reordered.service.tiers!.strong = structuredClone(config.service.tiers!.strong);
    const unpaidQuote = await running.relay.quote({ ...body, agentId: "1", taskId: "0", tier: "strong" });
    const unpaid: PaymentHandle = { version: 1, relayUrl: running.url + "/v1/chat", input: { ...body, agentId: "1", taskId: "0", tier: "strong" }, quote: unpaidQuote, creditNonce: "1" };
    delete reordered.service.tiers;
    await assert.rejects(infer.resume(unpaid), paymentError("ROUTE_UNAVAILABLE"));
    assert.equal(await f.providerBalance(), failedBalance); assert.equal(await f.provider.getTransactionCount(f.agentAddress), failedNonce);
    const statusPath = (handle: PaymentHandle) => `/payments/${handle.quote.paymentId}?agentId=1&requestDigest=${handle.quote.requestDigest}`;
    const status = await running.request(statusPath(failed));
    assert.equal(status.status, 200); assert.equal(status.body.state, "Paid"); assert.equal(status.body.deliveryError, "ROUTE_UNAVAILABLE");
    const blocked = await running.request("/v1/chat", failed.input, { "x-payment-id": failed.quote.paymentId });
    assert.equal(blocked.status, 409); assert.equal(blocked.body.error, "ROUTE_UNAVAILABLE"); assert.equal(calls.length, 6);
    assert.deepEqual((await running.request("/v1/chat", cheapResult.handle.input, { "x-payment-id": cheapResult.handle.quote.paymentId })).body.receipt, cheapResult.receipt);
    const cashBeforeRefund = await read(f.account, "cash", [1n]);
    const refunded = await running.request("/ops/refund", { paymentId: failed.quote.paymentId, refundId: keccak256(toUtf8Bytes("removed tier local refund")), amount: failed.quote.price }, { authorization: `Bearer ${config.operatorToken}` });
    assert.equal(refunded.status, 200, JSON.stringify(refunded.body)); assert.equal(refunded.body.state, "Refunded");
    assert.equal(await read(f.account, "cash", [1n]), cashBeforeRefund + 30000n);
    assert.equal(await f.provider.getTransactionCount(f.agentAddress), failedNonce);

    // Pre-snapshot records have an explicit fail-closed migration policy, with status/refund and Delivered cache still available.
    failAll = false;
    const oldQuote = await running.relay.quote({ ...body, agentId: "1", taskId: "0" });
    const oldRecord = await running.relay.store.read(oldQuote.paymentId); delete oldRecord.route; await running.relay.store.write(oldRecord);
    f.agent.reset(); await tx(f.account, f.agent, "payProvider", [1n, f.payee, oldQuote.price, oldQuote.paymentId, EMPTY_AUTH, "0x"]);
    const oldStatus = await running.request(`/payments/${oldQuote.paymentId}?agentId=1&requestDigest=${oldQuote.requestDigest}`);
    assert.equal(oldStatus.status, 200); assert.equal(oldStatus.body.state, "Paid");
    const oldBlocked = await running.request("/v1/chat", oldRecord.request, { "x-payment-id": oldQuote.paymentId });
    assert.equal(oldBlocked.body.error, "ROUTE_SNAPSHOT_REQUIRED"); assert.equal(calls.length, 6);
    const oldRefund = await running.request("/ops/refund", { paymentId: oldQuote.paymentId, refundId: keccak256(toUtf8Bytes("legacy snapshot local refund")), amount: oldQuote.price }, { authorization: `Bearer ${config.operatorToken}` });
    assert.equal(oldRefund.status, 200, JSON.stringify(oldRefund.body)); assert.equal(oldRefund.body.state, "Refunded");
    const cached = await running.relay.store.read(cheapResult.handle.quote.paymentId); delete cached.route; await running.relay.store.write(cached);
    const cachedResponse = await running.request("/v1/chat", cached.request, { "x-payment-id": cached.quote.paymentId });
    assert.equal(cachedResponse.status, 200); assert.deepEqual(cachedResponse.body.receipt, cheapResult.receipt);
    for (const file of await readdir(config.dataDir)) {
      const persisted = await readFile(join(config.dataDir, file), "utf8");
      assert.equal(persisted.includes("synthetic-route-"), false); assert.equal(file.endsWith(".tmp"), false);
    }
    for (const value of [cheapResult.handle.quote, recovered.receipt, status.body, refunded.body]) assert.equal(JSON.stringify(value).includes("synthetic-route-"), false);
  } finally {
    infer?.close(); lowBudget?.close(); await running?.close(); await f?.close(); if (child) await stopAnvil(child);
    await rm(directory, { recursive: true, force: true });
  }
});
