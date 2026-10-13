import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer as createHttpServer, type Server } from "node:http";
import { createServer as createTcpServer } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { keccak256, toUtf8Bytes } from "ethers";
import { InferCredit, PaymentError, accountInterface, requestDigest, type Inference, type PaymentHandle } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../services/underwriter/test/fixture.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { createHttpServer as createRelayHttpServer } from "../services/provider-relay/src/http.js";
import { Relay, RelayError } from "../services/provider-relay/src/relay.js";
import type { PaymentRecord } from "../services/provider-relay/src/store.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { startMagpie } from "./magpie-gateway.js";
import { magpieLock } from "./magpie-build.js";

async function listen(server: Server | ReturnType<typeof createTcpServer>) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return (server.address() as { port: number }).port;
}
async function close(server?: Server | ReturnType<typeof createTcpServer>) {
  if (!server?.listening) return;
  if ("closeAllConnections" in server) server.closeAllConnections();
  await new Promise<void>(done => server.close(() => done()));
}
async function freePort() { const server = createTcpServer(); const port = await listen(server); await close(server); return port; }
const save = (path: string, value: unknown) => writeFile(path, JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n", { mode: 0o600 });

export async function verifyMagpie(options: { binary: string; output: string; officialBinary?: string }) {
  const output = resolve(options.output); await mkdir(output, { recursive: true, mode: 0o700 });
  const checks: { name: string; details?: unknown }[] = [];
  const checked = (name: string, details?: unknown) => { checks.push({ name, details }); };
  const calls: { model: string; scenario: string; request: any; result?: any; authorizationMatches: boolean }[] = [];
  let failPaid = true;
  const upstream = createHttpServer(async (req, res) => {
    if (req.url === "/v1/models") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ object: "list", data: ["cheap-physical", "strong-physical"].map(id => ({ id, object: "model", owned_by: "controlled" })) })); return; }
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const scenario = String(body.messages?.at(-1)?.content || "ok");
    const entry = { model: body.model as string, scenario, request: body, authorizationMatches: req.headers.authorization === "Bearer synthetic-magpie-upstream", result: undefined as any };
    calls.push(entry);
    res.setHeader("content-type", "application/json");
    if (scenario === "rate" || scenario === "paid-rejected") { res.writeHead(429); res.end(JSON.stringify({ error: { message: "Rate limit reached", type: "rate_limit_error" } })); return; }
    if (scenario === "bad-gateway" || scenario === "paid-failure" && failPaid) { res.writeHead(502); res.end(JSON.stringify({ error: { message: "controlled unavailable", type: "server_error" } })); return; }
    const unknownStatus = ({ "paid-503": 503, "paid-408": 408, "paid-409": 409 } as Record<string, number>)[scenario];
    if (unknownStatus) { res.writeHead(unknownStatus); res.end(JSON.stringify({ error: { message: "controlled uncertain outcome", type: "server_error" } })); return; }
    if (scenario === "paid-invalid-response") { res.end(JSON.stringify({ choices: [] })); return; }
    if (scenario === "lost-response") { req.socket.destroy(); return; } // Request received and its synthetic inference ran; the response is lost.
    if (scenario === "redirect") { res.writeHead(307, { location: "/v1/chat/completions?second-dispatch=1" }); res.end(); return; }
    if (scenario === "repair-400") { res.writeHead(400); res.end(JSON.stringify({ error: { message: "max_tokens must be at least 16" } })); return; }
    const result = { id: `controlled-${calls.length}`, object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 4, completion_tokens: 1, total_tokens: 5 } };
    entry.result = result; res.end(JSON.stringify(result));
  });
  let brokenConnections = 0;
  const brokenNetwork = createTcpServer(socket => { brokenConnections++; socket.destroy(); });
  let gateway: Awaited<ReturnType<typeof startMagpie>> | undefined;
  let baseline: Awaited<ReturnType<typeof startMagpie>> | undefined;
  let local: Awaited<ReturnType<typeof startAnvil>> | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined; let relayServer: Server | undefined; let sdk: InferCredit | undefined; let low: InferCredit | undefined;
  let latest!: PaymentHandle;
  const paymentEvidence: unknown[] = [];
  try {
    const upstreamPort = await listen(upstream); const brokenPort = await listen(brokenNetwork); const offlinePort = await freePort();
    const providers = ["cheap", "strong"].map(id => ({ id, model: `${id}-physical`, baseUrl: `http://127.0.0.1:${upstreamPort}/v1`, key: "synthetic-magpie-upstream" }));
    const specialProviders = [{ id: "broken-network", model: "cheap-physical", baseUrl: `http://127.0.0.1:${brokenPort}/v1`, key: "synthetic-magpie-upstream" },
      { id: "offline", model: "cheap-physical", baseUrl: `http://127.0.0.1:${offlinePort}/v1`, key: "synthetic-magpie-upstream" }];
    gateway = await startMagpie({ binary: options.binary, stateDirectory: join(output, "magpie-state"), port: await freePort(), providers: [...providers, ...specialProviders] });
    checked("official-patched-process-health-and-explicit-catalog", { ...gateway.provenance, health: gateway.health, catalog: gateway.catalog });
    const postGateway = async (url: string, scenario: string, model = "cheap/cheap-physical") => {
      const response = await fetch(url + "/v1/chat/completions", { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer magpie" },
        body: JSON.stringify({ model, messages: [{ role: "user", content: scenario }], max_tokens: 1, stream: false }), signal: AbortSignal.timeout(15_000), redirect: "manual" });
      const responseText = await response.text();
      return { status: response.status, body: responseText ? JSON.parse(responseText) as any : null };
    };
    if (options.officialBinary) {
      baseline = await startMagpie({ binary: options.officialBinary, stateDirectory: join(output, "official-baseline-state"), port: await freePort(), providers, officialBaseline: true });
      const before = calls.length; const response = await postGateway(baseline.url, "bad-gateway");
      assert.equal(response.status, 502); assert.equal(calls.length - before, 3);
      checked("official-default-502-retries-twice", { ...baseline.provenance, actualUpstreamCalls: calls.length - before, status: response.status });
      await baseline.close(); baseline = undefined;
    }
    for (const scenario of ["rate", "bad-gateway", "lost-response", "redirect", "repair-400"]) {
      const before = calls.length; const response = await postGateway(gateway.url, scenario);
      assert.ok(response.status >= 400 || scenario === "redirect" && response.status === 307, `${scenario}: ${response.status}`);
      assert.equal(calls.length - before, 1, `${scenario} implicit duplicate upstream call`);
      checked(`one-dispatch-${scenario}`, { status: response.status, actualUpstreamCalls: calls.length - before });
    }
    const networkBefore = brokenConnections; const disconnected = await postGateway(gateway.url, "ok", "broken-network/cheap-physical");
    assert.equal(disconnected.status, 502); assert.equal(brokenConnections - networkBefore, 1);
    checked("one-connection-network-loss-before-http", { status: disconnected.status, actualConnections: brokenConnections - networkBefore });
    const beforeOffline = calls.length; const offline = await postGateway(gateway.url, "ok", "offline/cheap-physical");
    assert.equal(offline.status, 502); assert.equal(calls.length, beforeOffline);
    checked("offline-is-error-without-cross-provider-fallback", { status: offline.status, actualUpstreamCalls: 0 });
    const beforeEqual = calls.length;
    const equal = await Promise.all([postGateway(gateway.url, "equal-body"), postGateway(gateway.url, "equal-body")]);
    assert.deepEqual(equal.map(r => r.status), [200, 200]); assert.equal(calls.length - beforeEqual, 2);
    checked("equal-body-independent-requests-each-dispatch", { actualUpstreamCalls: 2 });

    local = await startAnvil(); f = await fixture(local.rpc, join(output, "underwriter"), 6, { refunderKey: key(4) });
    await f.provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]);
    f.agent.reset(); await tx(f.account, f.agent, "depositCash", [1n, 500000n]);
    const route = (tier: "cheap" | "strong") => ({ name: `magpie-${tier}`, model: `${tier}/${tier}-physical`, baseUrl: gateway!.url + "/v1", key: "magpie" });
    const cheap = [route("cheap")]; const strong = [route("strong")];
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: "infercredit/coder", model: "coder", price: 10000n, upstreams: cheap, tiers: { cheap: { price: 10000n, upstreams: cheap }, strong: { price: 30000n, upstreams: strong } } },
      dataDir: join(output, "relay-data"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 3000, host: "127.0.0.1", port: 8788,
      operatorToken: "synthetic-local-magpie-operator-token", refunderKey: key(4) };
    relay = new Relay(config, { provider: f.provider }); // Uses real HTTP fetch; no mocked Magpie transport.
    const refunder = new Refunder(relay); await relay.initialize(); await refunder.initialize();
    relayServer = createRelayHttpServer(relay, refunder); const relayPort = await listen(relayServer); const relayUrl = `http://127.0.0.1:${relayPort}/v1/chat`;
    const optionsSdk = { agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account, asset: config.asset, provider: config.payTo, maxPrice: 30000n,
      onHandle: async (handle: PaymentHandle) => { latest = structuredClone(handle); await save(join(output, "latest-handle.json"), handle); } };
    sdk = new InferCredit(optionsSdk); low = new InferCredit({ ...optionsSdk, maxPrice: 10000n });
    const body = (tier: "cheap" | "strong", content = "paid-success") => ({ service: "infercredit/coder", model: "coder", tier, messages: [{ role: "user", content }], stream: false, max_tokens: 16 });
    const beforeBudgetCalls = calls.length; const beforeBudgetBalance = await f.providerBalance(); const beforeBudgetNonce = await f.provider.getTransactionCount(f.agentAddress);
    await assert.rejects(low.fetch(relayUrl, { body: body("strong") }), (error: unknown) => error instanceof PaymentError && error.code === "UNTRUSTED_QUOTE");
    assert.equal(calls.length, beforeBudgetCalls); assert.equal(await f.providerBalance(), beforeBudgetBalance); assert.equal(await f.provider.getTransactionCount(f.agentAddress), beforeBudgetNonce);
    checked("strong-over-budget-never-pays-or-dispatches");
    const capturePayment = async (inference: Inference | PaymentHandle, label: string) => {
      const handle = "handle" in inference ? inference.handle : inference;
      const record = await relay!.store.read(handle.quote.paymentId);
      const receipt = await f!.provider.getTransactionReceipt(handle.submission!.txHash!); assert.ok(receipt); assert.equal(receipt.status, 1);
      const event = receipt.logs.filter(log => log.address.toLowerCase() === config.account.toLowerCase()).map(log => { try { return accountInterface.parseLog(log); } catch { return null; } }).find(log => log?.name === "ProviderPaid");
      assert.ok(event); assert.equal(event.args.paymentId, handle.quote.paymentId); assert.equal(event.args.provider.toLowerCase(), config.payTo.toLowerCase()); assert.equal(event.args.fromCash, BigInt(handle.quote.price)); assert.equal(event.args.fromCredit, 0n);
      assert.equal(record.quote.requestDigest, requestDigest(handle.input));
      const payment = await read(f!.account, "getPayment", [handle.quote.paymentId]);
      const evidence = { label, handle, record, rawTransactionReceipt: receipt.toJSON(), payment: { agentId: payment.agentId, taskId: payment.taskId, fromCash: payment.fromCash, fromCredit: payment.fromCredit, refundedAmount: payment.refundedAmount } };
      paymentEvidence.push(evidence); await save(join(output, `${label}-payment.json`), evidence); return record;
    };
    for (const tier of ["cheap", "strong"] as const) {
      const before = calls.length; const nonce = await f.provider.getTransactionCount(f.agentAddress); const balance = await f.providerBalance();
      const delivered: Inference = await sdk.fetch(relayUrl, { body: body(tier) });
      assert.equal(calls.length - before, 1); assert.equal(calls.at(-1)!.model, `${tier}-physical`);
      assert.equal(delivered.receipt.model, `${tier}/${tier}-physical`); assert.equal((delivered.result as any).model, `${tier}-physical`);
      assert.equal(delivered.receipt.price, tier === "cheap" ? "10000" : "30000"); assert.equal(delivered.receipt.tier, tier);
      assert.equal(await f.providerBalance() - balance, BigInt(delivered.receipt.price)); assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonce + 1);
      await capturePayment(delivered, tier);
      const cached: Inference[] = await Promise.all([sdk.resume(structuredClone(delivered.handle)), sdk.resume(structuredClone(delivered.handle))]);
      assert.deepEqual(cached[0].receipt, delivered.receipt); assert.equal(calls.length - before, 1); assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonce + 1);
      checked(`paid-${tier}-scoped-route-physical-response-and-cache`, { price: delivered.receipt.price, requestModel: delivered.receipt.model, responseModel: (delivered.result as any).model, actualUpstreamCalls: 1 });
    }
    // Same user body is a distinct new quote/payment; Magpie's per-request budget must not merge it with the first.
    const beforeSame = calls.length; const same = await sdk.fetch(relayUrl, { body: body("cheap") }); await capturePayment(same, "cheap-second");
    assert.equal(calls.length - beforeSame, 1); assert.notEqual(same.handle.quote.paymentId, (paymentEvidence[0] as any).handle.quote.paymentId);
    checked("equal-paid-body-distinct-quote-and-payment");

    for (const scenario of ["paid-failure", "paid-503", "paid-408", "paid-409", "lost-response", "paid-invalid-response"]) {
      const before = calls.length, balance = await f.providerBalance(), nonce = await f.provider.getTransactionCount(f.agentAddress);
      const refunderNonce = await f.provider.getTransactionCount(f.payee);
      await assert.rejects(sdk.fetch(relayUrl, { body: body("strong", scenario) }), (error: unknown) => error instanceof PaymentError && error.code === "UPSTREAM_UNCERTAIN");
      const uncertain = structuredClone(latest), record = await capturePayment(uncertain, `uncertain-${scenario}`);
      assert.equal(record.state, "Processing"); assert.equal(record.lastError, "UPSTREAM_UNCERTAIN");
      assert.equal(record.upstreamAttempts?.length, 1); assert.equal(record.upstreamAttempts?.[0].state, "Unknown");
      // Even if the vendor can now succeed, an unknown original dispatch cannot be repeated.
      config.service.tiers!.strong.price = 90000n; failPaid = false;
      await assert.rejects(sdk.resume(structuredClone(uncertain)), (error: unknown) => error instanceof PaymentError && error.code === "UPSTREAM_UNCERTAIN");
      const restarted = new Relay(config, { provider: f.provider });
      try { await restarted.initialize(); await restarted.recover(); } finally { restarted.close(); }
      await assert.rejects(refunder.refund(uncertain.quote.paymentId, keccak256(toUtf8Bytes(`magpie uncertain ${scenario}`)), uncertain.quote.price),
        (error: unknown) => error instanceof RelayError && error.code === "UPSTREAM_UNCERTAIN");
      const retained: PaymentRecord = await relay.store.read(uncertain.quote.paymentId);
      const payment = await read(f.account, "getPayment", [uncertain.quote.paymentId]);
      assert.equal(retained.state, "Processing"); assert.equal(retained.quote.price, "30000");
      assert.equal(retained.upstreamAttempts?.length, 1); assert.equal(retained.refunds.length, 0); assert.equal(payment.refundedAmount, 0n);
      assert.equal(calls.length - before, 1); assert.equal(await f.providerBalance() - balance, 30000n);
      assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonce + 1); assert.equal(await f.provider.getTransactionCount(f.payee), refunderNonce);
      await save(join(output, `uncertain-${scenario}-retained.json`), { record: retained, refundedAmount: payment.refundedAmount });
      checked(`uncertain-${scenario}-no-resume-recover-or-refund-dispatch`, { originalPrice: "30000", newConfiguredPrice: "90000", actualUpstreamCalls: 1, paymentTransactions: 1, refundedAmount: "0" });
      config.service.tiers!.strong.price = 30000n; failPaid = true;
    }
    const beforeRejected = calls.length, rejectedBalance = await f.providerBalance(), rejectedNonce = await f.provider.getTransactionCount(f.agentAddress);
    await assert.rejects(sdk.fetch(relayUrl, { body: body("strong", "paid-rejected") }), (error: unknown) => error instanceof PaymentError && error.code === "UPSTREAM_FAILED");
    const refundHandle = structuredClone(latest), rejectedRecord = await capturePayment(refundHandle, "rejected-refund");
    assert.equal(rejectedRecord.state, "Paid"); assert.equal(rejectedRecord.upstreamAttempts?.[0].state, "Rejected");
    assert.equal(rejectedRecord.upstreamAttempts?.[0].httpStatus, 429); assert.equal(calls.length - beforeRejected, 1);
    config.service.tiers!.strong.price = 90000n;
    await assert.rejects(sdk.resume(structuredClone(refundHandle)), (error: unknown) => error instanceof PaymentError && error.code === "UPSTREAM_FAILED");
    const refundId = keccak256(toUtf8Bytes("magpie rejected original payment local refund"));
    await assert.rejects(refunder.refund(refundHandle.quote.paymentId, refundId, "90000"),
      (error: unknown) => error instanceof RelayError && error.code === "REFUND_EXCEEDS_PAYMENT");
    checked("explicit-rejection-keeps-original-price-and-never-redispatches", { paidPrice: "30000", newConfiguredPrice: "90000", httpStatus: 429, actualUpstreamCalls: calls.length - beforeRejected });
    // Only a proven rejection permits an operator refund; use the locked original amount.
    const cash = await read(f.account, "cash", [1n]);
    const refunded = await refunder.refund(refundHandle.quote.paymentId, refundId, refundHandle.quote.price);
    assert.equal(refunded.state, "Refunded"); assert.equal(await read(f.account, "cash", [1n]), cash + 30000n); assert.equal(calls.length - beforeRejected, 1);
    assert.equal(await f.providerBalance(), rejectedBalance); assert.equal(await f.provider.getTransactionCount(f.agentAddress), rejectedNonce + 1);
    const refundedNonce = await f.provider.getTransactionCount(f.payee);
    await refunder.refund(refundHandle.quote.paymentId, refundId, refundHandle.quote.price);
    await assert.rejects(sdk.resume(structuredClone(refundHandle)), (error: unknown) => error instanceof PaymentError && error.code === "REFUNDED");
    assert.equal(await f.provider.getTransactionCount(f.payee), refundedNonce); assert.equal(await read(f.account, "cash", [1n]), cash + 30000n); assert.equal(calls.length - beforeRejected, 1);
    const refundRecord = await relay.store.read(refundHandle.quote.paymentId); const refundTxHash = refundRecord.refunds[0].transaction!.txHash;
    const refundReceipt = await f.provider.getTransactionReceipt(refundTxHash); assert.ok(refundReceipt); assert.equal(refundReceipt.status, 1);
    await save(join(output, "refund.json"), { refunded, record: refundRecord, rawTransactionReceipt: refundReceipt.toJSON() });
    checked("original-payment-full-refund-without-new-dispatch");
    for (const call of calls) {
      assert.equal(call.authorizationMatches, true); assert.equal(call.request.tier, undefined); assert.equal(call.request.service, undefined); assert.equal(call.request.agentId, undefined); assert.equal(call.request.taskId, undefined);
    }
    const report = { verified: true, scope: "local SDK -> Relay -> actual patched official Magpie -> controlled OpenAI-compatible HTTP provider; Anvil/mock-USDC only",
      magpie: gateway.provenance, lock: magpieLock, checks, paymentCount: new Set(paymentEvidence.map((e: any) => e.handle.quote.paymentId)).size, upstreamCalls: calls.length, brokenConnections,
      balances: { provider: await f.providerBalance(), agentCash: await read(f.account, "cash", [1n]) }, rpc: local.rpc,
      limitations: ["No public paid inference or Monad writes", "No subscription/group/classifier/Anthropic/streaming/tool validation", "Unknown dispatch stays Processing until operator reconciliation; resume/recover/refund cannot redispatch or decide its outcome", "Only durable explicit rejection permits another pinned candidate or original-price refund", "Provider-scoped receipt.model identifies the pinned route; saved physical request/response.model is separate", "Anvil is closed after raw receipts are saved"] };
    await save(join(output, "upstream-calls.json"), calls); await save(join(output, "report.json"), report); await writeFile(join(output, "magpie.log"), gateway.log(), { mode: 0o600 });
    return report;
  } finally { sdk?.close(); low?.close(); await close(relayServer); relay?.close(); await f?.close(); if (local) await stopAnvil(local.child); await gateway?.close(); await baseline?.close(); await close(upstream); await close(brokenNetwork); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const args = process.argv.slice(2); const values = new Map<string, string>(); for (let index = 0; index < args.length; index += 2) values.set(args[index], args[index + 1]);
  if (!values.get("--binary") || !values.get("--output")) throw new Error("Usage: tsx scripts/magpie-probe.ts --binary /build/magpie --output /new/evidence [--official-binary /official/magpie]");
  const report = await verifyMagpie({ binary: values.get("--binary")!, output: values.get("--output")!, officialBinary: values.get("--official-binary") });
  console.log(JSON.stringify({ verified: report.verified, checks: report.checks.length, upstreamCalls: report.upstreamCalls, output: resolve(values.get("--output")!) }));
}
