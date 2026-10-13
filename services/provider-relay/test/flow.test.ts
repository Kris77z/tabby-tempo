import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ChildProcess } from "node:child_process";
import { BrowserProvider, keccak256, toUtf8Bytes } from "ethers";
import { InferCredit, PaymentError, EMPTY_AUTH, canonical, paymentId, requestDigest, type ChatInput, type PaymentHandle } from "@agentfuel/sdk";
import { accountInterface } from "@agentfuel/sdk/protocol";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../underwriter/test/fixture.js";
import { createHttpServer } from "../src/http.js";
import { Relay, RelayError } from "../src/relay.js";
import { Refunder } from "../src/refunder.js";
import { loadConfig, type RelayConfig } from "../src/config.js";

const body = { service: "infercredit/coder", model: "coder", messages: [{ role: "user", content: "Return a deterministic solution." }] };
const errorCode = (code: string) => (error: unknown) => error instanceof PaymentError && error.code === code;
const relayError = (code: string) => (error: unknown) => error instanceof RelayError && error.code === code;

test("request/payment encoding binds all inference fields and ignores JSON key ordering", () => {
  const input = { ...body, agentId: "1", taskId: "2" } as ChatInput;
  const changed = { ...input, temperature: 0.7 };
  assert.equal(canonical({ b: 1, a: [2, { c: 3 }] }), '{"a":[2,{"c":3}],"b":1}');
  assert.equal(requestDigest(input), requestDigest({ taskId: "2", agentId: "1", ...body }));
  assert.notEqual(requestDigest(input), requestDigest(changed));
  assert.notEqual(paymentId("2", requestDigest(input), "0x" + "11".repeat(32)), paymentId("3", requestDigest(input), "0x" + "11".repeat(32)));
});

test("log scan configuration defaults to 1000 and rejects invalid environment/direct values", () => {
  const env = { RPC_URL: "http://127.0.0.1:1", CHAIN_ID: "31337", ACCOUNT_ADDRESS: "0x" + "11".repeat(20),
    PROVIDER_ADDRESS: "0x" + "22".repeat(20), SETTLEMENT_ASSET: "0x" + "33".repeat(20), ASSET_DECIMALS: "6", PRICE: "10000",
    UPSTREAMS_JSON: JSON.stringify([{ name: "test", baseUrl: "https://upstream.invalid/v1", model: "test", keyEnv: "TEST_API_KEY" }]),
    TEST_API_KEY: "synthetic" };
  const config = loadConfig(env);
  assert.equal(config.logScanChunkBlocks, 1000);
  for (const value of ["1", "100", "1000"]) assert.equal(loadConfig({ ...env, LOG_SCAN_CHUNK_BLOCKS: value }).logScanChunkBlocks, Number(value));
  for (const value of ["0", "1001", "-1", "1.5", "NaN"]) assert.throws(() => loadConfig({ ...env, LOG_SCAN_CHUNK_BLOCKS: value }), /LOG_SCAN_CHUNK_BLOCKS/);
  for (const value of [0, 1001, -1, 1.5, NaN]) assert.throws(() => new Relay({ ...config, logScanChunkBlocks: value }), /logScanChunkBlocks/);
});

test("100-block scanning keeps boundary payments and resumes a failed page without hiding a late payment", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-relay-scan-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined;
  let restoreLogs: (() => void) | undefined;
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(),
      asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: body.service, model: body.model, price: 10000n,
        upstreams: [{ name: "test", baseUrl: "https://upstream.invalid/v1", model: "test", key: "synthetic" }] },
      dataDir: join(directory, "relay"), quoteTtl: 5000, confirmations: 1, upstreamTimeout: 1000,
      logScanChunkBlocks: 100, host: "127.0.0.1", port: 8788 };
    let upstreamCalls = 0;
    const upstreamFetch: typeof fetch = async () => { upstreamCalls++; throw new Error("unexpected upstream call"); };
    relay = new Relay(config, { provider: f.provider, upstreamFetch });
    await relay.initialize();
    const ranges: { from: number; to: number }[] = [];
    const originalLogs = f.provider.getLogs;
    let failFrom: number | undefined;
    f.provider.getLogs = async filter => {
      if (!("fromBlock" in filter) || !("toBlock" in filter)) throw new Error("Expected a bounded log range");
      const range = { from: Number(filter.fromBlock), to: Number(filter.toBlock) };
      ranges.push(range);
      if (range.from === failFrom) throw new Error("controlled log scan failure");
      return originalLogs.call(f!.provider, filter);
    };
    restoreLogs = () => { f!.provider.getLogs = originalLogs; };
    const input = { ...body, agentId: "1", taskId: "0" } as ChatInput;
    const atEnd = await relay.quote(input);
    await f.provider.send("anvil_mine", ["0x62"]); // Payment is the final block of its first 100-block page.
    const endPayment = await tx(f.account, f.agent, "payProvider", [1n, f.payee, atEnd.price, atEnd.paymentId, EMPTY_AUTH, "0x"]);
    assert.equal(endPayment.blockNumber, atEnd.createdBlock + 99);
    await relay.confirm(await relay.store.read(atEnd.paymentId));
    assert.deepEqual(ranges.splice(0), [{ from: atEnd.createdBlock, to: endPayment.blockNumber }]);
    assert.equal((await relay.store.read(atEnd.paymentId)).proof!.txHash, endPayment.hash);

    const atStart = await relay.quote(input);
    await f.provider.send("anvil_mine", ["0x63"]); // Payment is the first block of the following page.
    const startPayment = await tx(f.account, f.agent, "payProvider", [1n, f.payee, atStart.price, atStart.paymentId, EMPTY_AUTH, "0x"]);
    assert.equal(startPayment.blockNumber, atStart.createdBlock + 100);
    await relay.confirm(await relay.store.read(atStart.paymentId));
    assert.deepEqual(ranges.splice(0), [{ from: atStart.createdBlock, to: atStart.createdBlock + 99 },
      { from: atStart.createdBlock + 100, to: startPayment.blockNumber }]);
    assert.equal((await relay.store.read(atStart.paymentId)).proof!.txHash, startPayment.hash);

    config.quoteTtl = 1;
    const late = await relay.quote(input);
    await f.provider.send("anvil_mine", ["0xc8"]);
    await f.provider.send("evm_increaseTime", [2]);
    const latePayment = await tx(f.account, f.agent, "payProvider", [1n, f.payee, late.price, late.paymentId, EMPTY_AUTH, "0x"]);
    failFrom = late.createdBlock + 100;
    await assert.rejects(relay.confirm(await relay.store.read(late.paymentId)), /controlled log scan failure/);
    assert.deepEqual(ranges.splice(0), [{ from: late.createdBlock, to: late.createdBlock + 99 },
      { from: failFrom, to: late.createdBlock + 199 }]);
    const interrupted = await relay.store.read(late.paymentId);
    assert.equal(interrupted.state, "Quoted"); assert.equal(interrupted.scanBlock, failFrom);
    relay.close();
    relay = new Relay(config, { provider: f.provider, upstreamFetch }); // Read the persisted cursor after a restart.
    failFrom = undefined;
    await relay.confirm(await relay.store.read(late.paymentId));
    assert.deepEqual(ranges.splice(0), [{ from: late.createdBlock + 100, to: late.createdBlock + 199 },
      { from: late.createdBlock + 200, to: latePayment.blockNumber }]);
    const confirmed = await relay.store.read(late.paymentId);
    assert.equal(confirmed.state, "Paid"); assert.equal(confirmed.proof!.txHash, latePayment.hash);
    assert.equal(confirmed.expiredPayment, true);
    await assert.rejects(relay.deliver(confirmed), relayError("PAYMENT_AFTER_EXPIRY"));
    assert.equal(upstreamCalls, 0);
  } finally {
    restoreLogs?.(); relay?.close(); await f?.close(); if (child) await stopAnvil(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("unpaid recovery preserves its cursor; later and refunded payments still need real receipt verification", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-relay-unpaid-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined;
  let restoreProvider: (() => void) | undefined;
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(),
      asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: body.service, model: body.model, price: 10000n,
        upstreams: [{ name: "test", baseUrl: "https://upstream.invalid/v1", model: "test", key: "synthetic" }] },
      dataDir: join(directory, "relay"), quoteTtl: 5000, confirmations: 1, upstreamTimeout: 1000,
      logScanChunkBlocks: 100, host: "127.0.0.1", port: 8788 };
    let upstreamCalls = 0;
    const upstreamFetch: typeof fetch = async () => {
      upstreamCalls++;
      return Response.json({ choices: [{ message: { role: "assistant", content: "local test result" } }] });
    };
    relay = new Relay(config, { provider: f.provider, upstreamFetch });
    await relay.initialize();
    const input = { ...body, agentId: "1", taskId: "0" } as ChatInput;
    const quote = await relay.quote(input);
    const ranges: { from: number; to: number }[] = [];
    const originalCall = f.provider.call, originalLogs = f.provider.getLogs, originalSend = f.provider.send;
    const selector = accountInterface.getFunction("getPayment")!.selector;
    let paymentReads = 0, failRead = false, wrongChain = false;
    f.provider.call = async transaction => {
      if (typeof transaction.data === "string" && transaction.data.startsWith(selector)) {
        assert.equal(String(transaction.to).toLowerCase(), config.account.toLowerCase());
        paymentReads++;
        if (failRead) throw new Error("controlled payment read failure");
      }
      return originalCall.call(f!.provider, transaction);
    };
    f.provider.getLogs = async filter => {
      assert.ok("fromBlock" in filter && "toBlock" in filter);
      ranges.push({ from: Number(filter.fromBlock), to: Number(filter.toBlock) });
      return originalLogs.call(f!.provider, filter);
    };
    f.provider.send = async (method, params) => wrongChain && method === "eth_chainId" ? "0x279f" : originalSend.call(f!.provider, method, params);
    restoreProvider = () => { f!.provider.call = originalCall; f!.provider.getLogs = originalLogs; f!.provider.send = originalSend; };

    const untouched = await relay.store.read(quote.paymentId);
    assert.equal((await relay.status(quote.paymentId, input.agentId, quote.requestDigest)).state, "Quoted");
    assert.deepEqual(await relay.store.read(quote.paymentId), untouched); // An absent cursor is not created either.
    const withCursor = { ...untouched, scanBlock: quote.createdBlock + 1 };
    await relay.store.write(withCursor);
    await f.provider.send("anvil_mine", ["0x3e9"]);
    await relay.recover();
    assert.deepEqual(await relay.store.read(quote.paymentId), withCursor);
    assert.equal(ranges.length, 0); assert.equal(upstreamCalls, 0);

    const readsBeforeWrongChain = paymentReads;
    wrongChain = true;
    await assert.rejects(relay.confirm(await relay.store.read(quote.paymentId)), relayError("NETWORK_MISMATCH"));
    wrongChain = false;
    assert.equal(paymentReads, readsBeforeWrongChain); // The zero-record shortcut cannot bypass chain validation.
    failRead = true;
    await assert.rejects(relay.recover(), /controlled payment read failure/);
    failRead = false;
    assert.deepEqual(await relay.store.read(quote.paymentId), withCursor);
    assert.equal(ranges.length, 0); assert.equal(upstreamCalls, 0);

    const payment = await tx(f.account, f.agent, "payProvider", [1n, f.payee, quote.price, quote.paymentId, EMPTY_AUTH, "0x"]);
    const delivered = await relay.chat(input, quote.paymentId);
    assert.equal(delivered.receipt!.txHash, payment.hash);
    assert.equal(delivered.receipt!.fromCash, quote.price); assert.equal(upstreamCalls, 1);
    assert.equal((await relay.store.read(quote.paymentId)).state, "Delivered");
    assert.equal(ranges[0].from, withCursor.scanBlock);
    assert.equal(ranges.at(-1)!.to, payment.blockNumber);
    assert.ok(ranges.every((range, index) => range.to - range.from + 1 <= 100 && (!index || range.from === ranges[index - 1].to + 1)));
    ranges.length = 0;

    const refunded = await relay.quote(input);
    const refundedPayment = await tx(f.account, f.agent, "payProvider", [1n, f.payee, refunded.price, refunded.paymentId, EMPTY_AUTH, "0x"]);
    await tx(f.manager, f.admin, "processRefund", [refunded.paymentId, refunded.price, keccak256(toUtf8Bytes("local fully refunded payment"))]);
    const chainPayment = await read(f.account, "getPayment", [refunded.paymentId]);
    assert.equal(chainPayment.fromCash, BigInt(refunded.price));
    assert.equal(chainPayment.refundedAmount, BigInt(refunded.price));
    const badAmount = await relay.store.read(refunded.paymentId);
    badAmount.quote.price = "9999";
    await assert.rejects(relay.confirm(badAmount), relayError("PAYMENT_MISMATCH"));
    assert.ok(ranges.length > 0); // A zero remaining balance must not bypass event/receipt checks.
    await relay.confirm(await relay.store.read(refunded.paymentId));
    const confirmedRefunded = await relay.store.read(refunded.paymentId);
    assert.equal(confirmedRefunded.state, "Paid");
    assert.equal(confirmedRefunded.proof!.txHash, refundedPayment.hash);
    assert.equal(confirmedRefunded.proof!.fromCash, refunded.price);
    assert.equal(upstreamCalls, 1); // This test only verifies discovery of the already-refunded payment.
  } finally {
    restoreProvider?.(); relay?.close(); await f?.close(); if (child) await stopAnvil(child);
    await rm(directory, { recursive: true, force: true });
  }
});

test("injected upstream preserves explicitly rejected fallback/replay and borrowed RPC ownership", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-relay-provider-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined;
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    const config: RelayConfig = { rpcUrl: "http://127.0.0.1:1", chainId: 31337n, account: await f.account.getAddress(),
      asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee, service: { id: body.service, model: body.model, price: 10000n,
        upstreams: [{ name: "primary", baseUrl: "https://primary.invalid/v1", model: "primary-model", key: "synthetic-primary" },
          { name: "fallback", baseUrl: "https://fallback.invalid/v1/", model: "fallback-model", key: "synthetic-fallback" }] },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788 };
    const calls: { url: string; input: any }[] = [];
    const upstreamFetch: typeof fetch = async (url, init) => {
      const index = calls.length;
      calls.push({ url: String(url), input: JSON.parse(String(init!.body)) });
      assert.equal(init!.method, "POST");
      assert.equal(new Headers(init!.headers).get("authorization"), `Bearer synthetic-${index === 0 ? "primary" : "fallback"}`);
      assert.ok(init!.signal instanceof AbortSignal);
      if (index === 0) return Response.json({ error: "controlled auth rejection" }, { status: 401 });
      return Response.json({ choices: [{ message: { role: "assistant", content: "injected result" } }], usage: { total_tokens: 3 } });
    };
    relay = new Relay(config, { provider: f.provider, upstreamFetch });
    await relay.initialize();
    const input = { ...body, agentId: "1", taskId: "0", temperature: 1, max_tokens: 32, stream: false } as ChatInput;
    const quote = await relay.quote(input);
    const receipt = await tx(f.account, f.agent, "payProvider", [1n, f.payee, quote.price, quote.paymentId, EMPTY_AUTH, "0x"]);
    const delivered = await relay.chat(input, quote.paymentId, receipt.hash);
    assert.equal(delivered.receipt!.upstream, "fallback");
    assert.equal(delivered.receipt!.fromCash, "10000"); assert.equal(delivered.receipt!.fromCredit, "0");
    assert.deepEqual(calls.map(call => call.url), ["https://primary.invalid/v1/chat/completions", "https://fallback.invalid/v1/chat/completions"]);
    assert.deepEqual(calls.map(call => call.input), ["primary-model", "fallback-model"].map(model => ({
      model, messages: body.messages, temperature: 1, max_tokens: 32, stream: false,
    })));
    assert.deepEqual(await relay.chat(input, quote.paymentId, receipt.hash), delivered);
    assert.equal(calls.length, 2);
    relay.close();
    assert.equal(f.provider.destroyed, false);
    assert.equal(await f.provider.send("eth_chainId", []), "0x7a69");
    relay = new Relay(config, { provider: f.provider, upstreamFetch });
    await relay.initialize(); await relay.recover();
    assert.deepEqual(await relay.chat(input, quote.paymentId, receipt.hash), delivered);
    assert.equal(calls.length, 2);
    const wrongChain = new Relay({ ...config, chainId: 10143n }, { provider: f.provider });
    try { await assert.rejects(wrongChain.initialize(), relayError("NETWORK_MISMATCH")); }
    finally { wrongChain.close(); }
    assert.equal(await f.provider.send("eth_chainId", []), "0x7a69");
    const owned = new Relay(config);
    owned.close(); assert.equal(owned.provider.destroyed, true);
  } finally { relay?.close(); await f?.close(); if (child) await stopAnvil(child); await rm(directory, { recursive: true, force: true }); }
});

async function upstream() {
  const control = { primary: 0, fallback: 0, failAll: false, seen: [] as any[] };
  const server = createServer(async (req, res) => {
    let content = ""; for await (const chunk of req) content += chunk;
    const input = JSON.parse(content); control.seen.push(input);
    const primary = req.url === "/primary/chat/completions";
    if (primary) control.primary++; else control.fallback++;
    if (primary || control.failAll) { res.writeHead(429); res.end('{"error":"controlled quota rejection"}'); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ id: "controlled-completion", model: input.model,
      choices: [{ message: { role: "assistant", content: "deterministic result" } }], usage: { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 } }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { control, base, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}
async function serve(config: RelayConfig, port = 0) {
  const relay = new Relay(config); const refunder = new Refunder(relay);
  await relay.initialize(); await refunder.initialize();
  const server = createHttpServer(relay, refunder);
  server.listen(port, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const request = async (path: string, input?: unknown, headers = {}) => {
    const response = await fetch(url + path, input === undefined ? {} : { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(input) });
    return { status: response.status, body: await response.json() as any };
  };
  return { relay, refunder, url, request, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); relay.close(); } };
}

test("SDK/relay real Anvil flow, recovery and refunds in both settlement modes", { timeout: 180_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-relay-"));
  let child: ChildProcess | undefined;
  const upstreamServer = await upstream();
  try {
    const local = await startAnvil(); child = local.child;
    for (const decimals of [6, 18] as const) await t.test(`real ${decimals === 6 ? "USDC" : "native"} quote/payment/inference/refund`, async () => {
      const f = await fixture(local.rpc, join(directory, `evidence-${decimals}`), decimals);
      const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
        assetDecimals: decimals, payTo: f.payee, service: { id: body.service, model: body.model, price: 12n * f.unit / 100n,
          upstreams: [{ name: "kimi", baseUrl: upstreamServer.base + "/primary", model: "kimi-local", key: "synthetic" },
            { name: "qwen", baseUrl: upstreamServer.base + "/fallback", model: "qwen-local", key: "synthetic" }] },
        dataDir: join(directory, `relay-${decimals}`), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000,
        host: "127.0.0.1", port: 8788, frontendOrigin: "http://localhost:3000", operatorToken: "synthetic-local-operator-token-32", refunderKey: key(1) };
      let running = await serve(config);
      let latest!: PaymentHandle;
      const infer = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n,
        account: config.account, asset: config.asset, provider: config.payTo, maxPrice: config.service.price,
        underwriterUrl: f.http, onHandle: handle => { latest = handle; } });
      try {
        upstreamServer.control.failAll = false;
        const taskId = await f.task();
        const before = await f.providerBalance(); const calls = upstreamServer.control.fallback;
        const result = await infer.forTask(taskId.toString()).fetch(running.url + "/v1/chat", { body });
        const saved = JSON.parse(JSON.stringify(result.handle)) as PaymentHandle;
        assert.equal(result.receipt.upstream, "qwen"); assert.equal(result.receipt.model, "qwen-local");
        assert.deepEqual(result.receipt.usage, { prompt_tokens: 3, completion_tokens: 7, total_tokens: 10 });
        assert.equal(result.receipt.price, (12n * f.unit / 100n).toString());
        assert.equal(result.receipt.fromCash, (4n * f.unit / 100n).toString());
        assert.equal(result.receipt.fromCredit, (8n * f.unit / 100n).toString());
        assert.equal((await read(f.manager, "getLoan", [taskId])).principal, 8n * f.unit / 100n);
        assert.equal((await read(f.manager, "getLoan", [taskId])).fee, 12n * f.unit / 1000n);
        assert.equal((await f.providerBalance()) - before, 12n * f.unit / 100n);
        assert.equal(upstreamServer.control.fallback, calls + 1);
        const retries = await Promise.all([infer.resume(saved), infer.resume(structuredClone(saved)),
          running.request("/v1/chat", saved.input, { "x-payment-id": saved.quote.paymentId })]);
        assert.equal((retries[2] as any).status, 200);
        assert.equal(upstreamServer.control.fallback, calls + 1);
        assert.equal((await f.providerBalance()) - before, 12n * f.unit / 100n);
        const mismatch = await running.request("/v1/chat", { ...saved.input, messages: [{ role: "user", content: "different" }] }, { "x-payment-id": saved.quote.paymentId });
        assert.equal(mismatch.body.error, "REQUEST_MISMATCH");
        await assert.rejects(infer.forTask(taskId.toString()).fetch(running.url + "/v1/chat", { body }), errorCode("TASK_ALREADY_BORROWED"));
        assert.equal((await f.providerBalance()) - before, 12n * f.unit / 100n);
        const another = await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" });
        assert.equal((await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" },
          { "x-payment-id": another.body.quote.paymentId, "x-payment-tx": saved.submission!.txHash! })).body.error, "PAYMENT_MISMATCH");
        assert.equal((await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" },
          { "x-payment-id": another.body.quote.paymentId, "x-payment-tx": "0x" + "00".repeat(32) })).body.error, "INVALID_PAYMENT");
        await f.provider.send("evm_increaseTime", [301]); await f.provider.send("evm_mine", []);
        assert.deepEqual((await infer.resume(saved)).result, result.result); // Paid before expiry remains claimable forever.
        f.agent.reset();
        if (f.token) await tx(f.account, f.agent, "depositCash", [1n, f.unit / 2n]);
        else await tx(f.account, f.agent, "depositCash", [1n, f.unit / 2n], { value: f.unit / 2n });
        const evidenceCount = (await readdir(f.config.evidenceDir)).length;
        const cashResult = await infer.fetch(running.url + "/v1/chat", { body });
        assert.equal(cashResult.receipt.fromCredit, "0"); assert.equal(cashResult.handle.quote.taskId, "0");
        assert.equal((await readdir(f.config.evidenceDir)).length, evidenceCount);
        // Persist Processing, then fail before the first upstream: restart must use that exact original request.
        const write = running.relay.store.write.bind(running.relay.store); let crash = true;
        running.relay.store.write = async record => { await write(record); if (crash && record.state === "Processing") { crash = false; throw new Error("controlled crash after durable Processing"); } };
        await assert.rejects(infer.fetch(running.url + "/v1/chat", { body }), errorCode("SERVICE_UNAVAILABLE"));
        const processing = structuredClone(latest);
        const stored = await running.relay.store.read(processing.quote.paymentId);
        assert.equal(stored.state, "Processing"); assert.deepEqual(stored.request, processing.input);
        const paidBalance = await f.providerBalance(); const recoveryCalls = upstreamServer.control.fallback;
        const port = Number(new URL(running.url).port); await running.close(); running = await serve(config, port);
        await running.relay.recover();
        assert.equal(upstreamServer.control.fallback, recoveryCalls + 1);
        const recovered = await infer.resume(processing);
        assert.equal(recovered.receipt.paymentId, processing.quote.paymentId);
        assert.equal(await f.providerBalance(), paidBalance);
        assert.deepEqual(upstreamServer.control.seen.at(-1).messages, processing.input.messages);
        // All upstreams fail after real cash payment; operator returns funds in two instalments.
        upstreamServer.control.failAll = true;
        await assert.rejects(infer.fetch(running.url + "/v1/chat", { body }), errorCode("UPSTREAM_FAILED"));
        const failed = structuredClone(latest);
        assert.equal((await running.relay.store.read(failed.quote.paymentId)).state, "Paid");
        const cashBefore = await read(f.account, "cash", [1n]);
        const refund1 = keccak256(toUtf8Bytes(`part-one-${decimals}`)); const refund2 = keccak256(toUtf8Bytes(`part-two-${decimals}`));
        const amount = (6n * f.unit / 100n).toString();
        assert.equal((await running.request("/ops/refund", { paymentId: failed.quote.paymentId, refundId: refund1, amount })).status, 403);
        const ops = { authorization: `Bearer ${config.operatorToken}` };
        const partial = await running.request("/ops/refund", { paymentId: failed.quote.paymentId, refundId: refund1, amount }, ops);
        assert.equal(partial.status, 200, JSON.stringify(partial.body)); assert.equal(partial.body.state, "Paid"); assert.equal(partial.body.refundPending, true);
        assert.equal(await read(f.account, "cash", [1n]), cashBefore + BigInt(amount));
        assert.equal((await read(f.account, "getPayment", [failed.quote.paymentId])).refundedAmount, BigInt(amount));
        const nonceAfter = await f.provider.getTransactionCount(await f.admin.getAddress(), "latest");
        assert.equal((await running.request("/ops/refund", { paymentId: failed.quote.paymentId, refundId: refund1, amount }, ops)).status, 200);
        assert.equal(await f.provider.getTransactionCount(await f.admin.getAddress(), "latest"), nonceAfter);
        await assert.rejects(infer.resume(failed), errorCode("REFUND_IN_PROGRESS"));
        assert.equal((await running.request("/ops/refund", { paymentId: failed.quote.paymentId, refundId: refund1, amount: "1" }, ops)).body.error, "REFUND_MISMATCH");
        if (f.token) {
          f.admin.reset(); await tx(f.token, f.admin, "cheatSetBlocked", [config.account, true]);
          const vault = await read(f.manager, "vaultBalance"); const balance = await read(f.token, "balanceOf", [await f.admin.getAddress()]);
          await assert.rejects(running.refunder.refund(failed.quote.paymentId, refund2, amount), (error: any) => {
            const decoded = f.token!.interface.parseError(error.data); return decoded?.name === "TransferBlocked" && decoded.args.to === config.account;
          });
          assert.equal(await read(f.account, "refundConsumed", [refund2]), false);
          assert.equal(await read(f.manager, "vaultBalance"), vault);
          assert.equal(await read(f.account, "cash", [1n]), cashBefore + BigInt(amount));
          assert.equal(await read(f.token, "balanceOf", [await f.admin.getAddress()]), balance);
          assert.equal((await running.relay.store.read(failed.quote.paymentId)).state, "Paid");
          f.admin.reset(); await tx(f.token, f.admin, "cheatSetBlocked", [config.account, false]);
        }
        // Chain succeeds, final state-file update fails; recovery must confirm the same tx, never refund twice.
        const refundWrite = running.relay.store.write.bind(running.relay.store); let lostCommit = true;
        running.relay.store.write = async record => { if (lostCommit && record.state === "Refunded") { lostCommit = false; throw new Error("controlled final refund write failure"); } await refundWrite(record); };
        const full = await running.request("/ops/refund", { paymentId: failed.quote.paymentId, refundId: refund2, amount }, ops);
        assert.equal(full.status, 503);
        assert.equal((await running.relay.store.read(failed.quote.paymentId)).state, "Paid");
        assert.equal((await read(f.account, "getPayment", [failed.quote.paymentId])).refundedAmount, 12n * f.unit / 100n);
        const postRefundNonce = await f.provider.getTransactionCount(await f.admin.getAddress(), "latest");
        await running.refunder.recover();
        assert.equal((await running.relay.store.read(failed.quote.paymentId)).state, "Refunded");
        const refundedStatus = await running.request(`/payments/${failed.quote.paymentId}?agentId=1&requestDigest=${failed.quote.requestDigest}`);
        assert.equal(refundedStatus.body.refundPending, false); assert.equal(refundedStatus.body.refundedAmount, (12n * f.unit / 100n).toString());
        assert.equal(await f.provider.getTransactionCount(await f.admin.getAddress(), "latest"), postRefundNonce);
        assert.equal(await read(f.account, "cash", [1n]), cashBefore + 12n * f.unit / 100n);
        await assert.rejects(infer.resume(failed), errorCode("REFUNDED"));
        upstreamServer.control.failAll = false; f.admin.reset();
        // A late, genuinely received payment is non-deliverable but must have an operator refund exit.
        const late = await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" });
        await f.provider.send("evm_increaseTime", [301]); await f.provider.send("evm_mine", []);
        f.agent.reset();
        const lateTx = await tx(f.account, f.agent, "payProvider", [1n, f.payee, late.body.quote.price, late.body.quote.paymentId, EMPTY_AUTH, "0x"]);
        const lateStatus = await running.request(`/payments/${late.body.quote.paymentId}?agentId=1&requestDigest=${late.body.quote.requestDigest}`);
        assert.equal(lateStatus.body.state, "Paid"); assert.equal(lateStatus.body.expiredPayment, true);
        assert.equal((await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" },
          { "x-payment-id": late.body.quote.paymentId, "x-payment-tx": lateTx.hash })).body.error, "PAYMENT_AFTER_EXPIRY");
        const lateRefund = await running.request("/ops/refund", { paymentId: late.body.quote.paymentId,
          refundId: keccak256(toUtf8Bytes(`late-${decimals}`)), amount: late.body.quote.price }, ops);
        assert.equal(lateRefund.status, 200, JSON.stringify(lateRefund.body)); assert.equal(lateRefund.body.state, "Refunded");
        f.admin.reset();
        if (decimals === 6) {
          const preflight = await fetch(running.url + "/v1/chat", { method: "OPTIONS", headers: { origin: config.frontendOrigin!, "access-control-request-method": "POST" } });
          assert.equal(preflight.status, 204); assert.equal(preflight.headers.get("access-control-allow-origin"), config.frontendOrigin);
          const untrusted = await fetch(running.url + "/v1/chat", { method: "OPTIONS", headers: { origin: "http://evil.invalid" } });
          assert.equal(untrusted.status, 403);
          // EIP-1193/browser path: explicit user rejection can resume; a lost hash after broadcast is discovered on chain.
          await f.provider.send("anvil_impersonateAccount", [f.agentAddress]);
          let rejects = 1, lostHash = false, sent = 0;
          const browser = new BrowserProvider({ request: async ({ method, params }: { method: string; params?: readonly unknown[] | object }) => {
            if (method === "eth_accounts" || method === "eth_requestAccounts") return [f.agentAddress];
            if (method === "eth_sendTransaction") {
              if (rejects-- > 0) throw Object.assign(new Error("user rejection"), { code: 4001 });
              sent++; const hash = await f.provider.send(method, params as unknown[]);
              if (lostHash) { lostHash = false; throw Object.assign(new Error("controlled lost response"), { code: -32001 }); }
              return hash;
            }
            return f.provider.send(method, params as unknown[] || []);
          } });
          let browserHandle!: PaymentHandle;
          const browserSdk = new InferCredit({ agentId: "1", signer: await browser.getSigner(f.agentAddress), chainId: 31337n,
            account: config.account, asset: config.asset, provider: config.payTo, maxPrice: config.service.price, onHandle: handle => { browserHandle = handle; } });
          try {
            await assert.rejects(browserSdk.fetch(running.url + "/v1/chat", { body }), errorCode("WALLET_REJECTED"));
            assert.equal(browserHandle.submission, undefined); assert.equal(sent, 0);
            assert.equal((await browserSdk.resume(browserHandle)).receipt.fromCredit, "0"); assert.equal(sent, 1);
            lostHash = true;
            await assert.rejects(browserSdk.fetch(running.url + "/v1/chat", { body }), errorCode("PAYMENT_UNCERTAIN"));
            assert.equal(browserHandle.submission!.txHash, undefined);
            const resumed = await browserSdk.resume(browserHandle);
            assert.equal(resumed.receipt.paymentId, browserHandle.quote.paymentId); assert.equal(sent, 2);
          } finally { browserSdk.close(); browser.destroy(); await f.provider.send("anvil_stopImpersonatingAccount", [f.agentAddress]); }
          const physical = await f.providerBalance();
          config.service.price *= 2n;
          await assert.rejects(infer.fetch(running.url + "/v1/chat", { body }), errorCode("UNTRUSTED_QUOTE"));
          config.service.price /= 2n; assert.equal(await f.providerBalance(), physical);
          const wrongChain = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 10143n,
            account: config.account, asset: config.asset, provider: config.payTo, maxPrice: config.service.price });
          try { await assert.rejects(wrongChain.fetch(running.url + "/v1/chat", { body }), errorCode("NETWORK_MISMATCH")); }
          finally { wrongChain.close(); }
          f.agent.reset(); await tx(f.account, f.agent, "depositCash", [1n, f.unit / 4n]);
          config.quoteTtl = 5000; config.confirmations = 2;
          const scanned = await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" });
          await f.provider.send("anvil_mine", ["0x3e9"]);
          const scanningTx = await tx(f.account, f.agent, "payProvider", [1n, f.payee, scanned.body.quote.price, scanned.body.quote.paymentId, EMPTY_AUTH, "0x"]);
          const ranges: number[] = [];
          running.relay.provider.on("debug", (event: any) => {
            if (event.action === "sendRpcPayload") for (const payload of Array.isArray(event.payload) ? event.payload : [event.payload]) {
              if (payload.method === "eth_getLogs") ranges.push(parseInt(payload.params[0].toBlock, 16) - parseInt(payload.params[0].fromBlock, 16) + 1);
            }
          });
          const path = `/payments/${scanned.body.quote.paymentId}?agentId=1&requestDigest=${scanned.body.quote.requestDigest}`;
          assert.equal((await running.request(path)).body.state, "Quoted");
          assert.equal((await running.relay.store.read(scanned.body.quote.paymentId)).scanBlock, scanningTx.blockNumber);
          await f.provider.send("evm_mine", []);
          assert.equal((await running.request(path)).body.state, "Paid");
          assert.ok(ranges.length >= 3 && ranges.every(range => range <= 1000));
          assert.equal((await running.request("/v1/chat", { ...body, agentId: "1", taskId: "0" }, { "x-payment-id": scanned.body.quote.paymentId })).status, 200);
          config.confirmations = 1; config.quoteTtl = 1;
          let prepared!: PaymentHandle;
          const neverBroadcast = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n,
            account: config.account, asset: config.asset, provider: config.payTo, maxPrice: config.service.price,
            onHandle: handle => { prepared = handle; if (handle.submission?.rawTransaction) throw new Error("controlled client crash before broadcast"); } });
          try {
            await assert.rejects(neverBroadcast.fetch(running.url + "/v1/chat", { body }), errorCode("PAYMENT_UNCERTAIN"));
            assert.ok(prepared.submission?.rawTransaction);
            const beforeExpiry = await f.providerBalance();
            await f.provider.send("evm_increaseTime", [2]); await f.provider.send("evm_mine", []);
            await assert.rejects(neverBroadcast.resume(prepared), errorCode("QUOTE_EXPIRED"));
            assert.equal(await f.provider.getTransaction(prepared.submission!.txHash!), null);
            assert.equal(await f.providerBalance(), beforeExpiry);
          } finally { neverBroadcast.close(); }
        }
        assert.ok((await readdir(config.dataDir)).every(file => !file.endsWith(".tmp")));
      } finally { infer.close(); await running.close(); await f.close(); }
    });
  } finally { await upstreamServer.close(); if (child) await stopAnvil(child); await rm(directory, { recursive: true, force: true }); }
});
