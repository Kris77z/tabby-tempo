import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { once } from "node:events";
import { Transaction } from "ethers";
import { InferCredit, type PaymentHandle } from "@agentfuel/sdk";
import { accountInterface, paymentId, requestDigest } from "@agentfuel/sdk/protocol";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { fixture, key, startAnvil, stopAnvil } from "../services/underwriter/test/fixture.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";
import { verifyProviderPaid } from "./live-tiers-evidence.js";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";

const PLAN = { version: 1, kind: "injected-rejection-real-fallback", chainId: "31337", tier: "cheap", model: "kimi-k2.6",
  priceRaw: "10000", maxPhysicalCalls: 1, maxCompletionTokens: 128, injectedRejectionStatus: 429 };
const safe = (e: unknown) => typeof (e as any)?.code === "string" && /^[A-Z0-9_]+$/.test((e as any).code) ? (e as any).code : "FALLBACK_CHECK_FAILED";

export async function auditFallback(output: string) {
  const json = async (file: string) => JSON.parse(await readFile(join(output, file), "utf8"));
  const report = await json("report.json"), handle = await json("handle.json"), receipt = await json("receipt.json");
  const response = await json("physical-response.json"), request = await json("physical-request.json");
  const record = await json(`relay/${handle.quote.paymentId}.json`);
  assert.deepEqual(report.plan, PLAN); assert.equal(report.status, "Complete");
  assert.ok(["controlled", "real-kimi-system-https-proxy"].includes(report.upstreamMode));
  assert.equal(report.physicalCalls, 1); assert.equal(report.injectedRejections, 1);
  assert.equal(record.state, "Delivered"); assert.deepEqual(record.upstreamAttempts.map((x: any) => x.state), ["Rejected", "Delivered"]);
  assert.equal(record.upstreamAttempts[0].httpStatus, 429); assert.equal(record.upstreamAttempts[0].upstream, "local-rejection");
  assert.equal(record.upstreamAttempts[1].upstream, "kimi-fallback");
  assert.equal(handle.quote.requestDigest, requestDigest(handle.input)); assert.equal(handle.input.tier, "cheap");
  assert.equal(handle.quote.price, PLAN.priceRaw); assert.equal(handle.quote.chainId, "31337");
  assert.equal(handle.input.taskId, "0"); assert.equal(handle.quote.taskId, "0"); assert.equal(handle.quote.agentId, handle.input.agentId);
  assert.equal(handle.quote.paymentId, paymentId("0", handle.quote.requestDigest, handle.quote.serverNonce));
  assert.deepEqual(record.request, handle.input); assert.equal(record.route.tier, "cheap");
  assert.deepEqual(record.route.upstreams.map((x: any) => [x.name, x.model]), [["local-rejection", PLAN.model], ["kimi-fallback", PLAN.model]]);
  assert.deepEqual(record.quote, handle.quote); assert.deepEqual(record.result, response); assert.deepEqual(record.receipt, receipt);
  const { agentId, taskId, service, tier, ...inference } = handle.input;
  assert.deepEqual(request, { ...inference, model: PLAN.model });
  assert.equal(request.max_completion_tokens, 128); assert.equal(response.model, PLAN.model);
  assert.equal(response.choices[0].message.content.trim(), "OK"); assert.equal(response.choices[0].finish_reason, "stop");
  assert.equal(receipt.fromCash, PLAN.priceRaw); assert.equal(receipt.fromCredit, "0");
  assert.equal(receipt.upstream, "kimi-fallback"); assert.equal(receipt.tier, "cheap"); assert.equal(receipt.model, PLAN.model);
  assert.deepEqual(receipt.usage, response.usage); assert.equal(receipt.requestDigest, handle.quote.requestDigest);
  assert.equal(receipt.paymentId, handle.quote.paymentId); assert.equal(receipt.price, PLAN.priceRaw);
  for (const field of ["chainId", "agentId", "taskId", "account", "asset", "payTo", "service"] as const) assert.equal(receipt[field], handle.quote[field]);
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) assert.ok(Number.isSafeInteger(response.usage[field]) && response.usage[field] > 0);
  assert.equal(response.usage.total_tokens, response.usage.prompt_tokens + response.usage.completion_tokens);
  assert.ok(response.usage.completion_tokens <= PLAN.maxCompletionTokens);
  const tx = Transaction.from(handle.submission.rawTransaction); assert.equal(tx.hash, receipt.txHash);
  assert.equal(tx.hash, handle.submission.txHash); assert.equal(tx.nonce, handle.submission.nonce); assert.equal(tx.nonce, report.before.nonce);
  assert.equal(tx.chainId, 31337n); assert.equal(tx.to!.toLowerCase(), handle.quote.account.toLowerCase());
  assert.equal(tx.from!.toLowerCase(), handle.submission.from.toLowerCase());
  const call = accountInterface.parseTransaction({ data: tx.data, value: tx.value })!;
  assert.equal(call.name, "payProvider"); assert.equal(call.args[0], BigInt(agentId)); assert.equal(call.args[2], 10000n);
  assert.equal(call.args[1].toLowerCase(), handle.quote.payTo.toLowerCase()); assert.equal(call.args[3], handle.quote.paymentId);
  verifyProviderPaid(handle.quote, receipt, await json("raw-receipt.json"));
  assert.equal(BigInt(report.after.providerBalance) - BigInt(report.before.providerBalance), 10000n);
  assert.equal(report.after.nonce - report.before.nonce, 1); assert.deepEqual(report.afterReplay, report.after);
  assert.equal(report.callsAfterRestart, 1); assert.equal(report.rejectionsAfterRestart, 1);
  return { verified: true, scope: "saved-artifact consistency", injectedRejection: true, actualVendorFailureObserved: false,
    model: PLAN.model, physicalCalls: 1, usage: response.usage, priceRaw: PLAN.priceRaw, noAdditionalPaymentOrModelOnRestart: true };
}

export async function verifyLiveFallback(options: { config: string; output?: string; execute?: boolean }, controlled?: typeof fetch) {
  const upstream = await loadProbeUpstream(options.config);
  if (!options.execute) return { plan: PLAN, execute: false };
  if (!options.output || !isAbsolute(options.output)) throw new Error("ABSOLUTE_NEW_OUTPUT_REQUIRED");
  const output = options.output; await mkdir(output, { mode: 0o700 }); // Existing output can only be audited, never rerun.
  const save = (file: string, value: unknown) => writeFile(join(output, file), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const report: any = { plan: PLAN, upstreamMode: controlled ? "controlled" : "real-kimi-system-https-proxy", status: "Running",
    physicalCalls: 0, injectedRejections: 0, limitations: ["First candidate rejection is host-injected before vendor dispatch; not a natural vendor failure.", "Local mock-USDC price is not a vendor bill; no Monad, Pi or Magpie claim."] };
  let local: Awaited<ReturnType<typeof startAnvil>> | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined, server: ReturnType<typeof createHttpServer> | undefined, sdk: InferCredit | undefined;
  let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  try {
    await save("report.json", report); local = await startAnvil(); f = await fixture(local.rpc, join(output, "underwriter"), 6);
    if (!controlled) transport = proxyUpstreamFetch(await systemHttpsProxy(), 120000);
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 6, payTo: f.payee, dataDir: join(output, "relay"), host: "127.0.0.1", port: 0, quoteTtl: 300, confirmations: 1,
      upstreamTimeout: 120000, service: { id: "infercredit/coder", model: "coder", price: 10000n, upstreams: [], tiers: {
        cheap: { price: 10000n, upstreams: [{ name: "local-rejection", model: PLAN.model, baseUrl: "https://local-rejection.invalid/v1", key: "synthetic" }, { ...upstream, name: "kimi-fallback", model: PLAN.model }] },
        strong: { price: 30000n, upstreams: [{ ...upstream, name: "unused-strong", model: "kimi-k3" }] } } } };
    const upstreamFetch: typeof fetch = async (url, init) => {
      if (String(url) === "https://local-rejection.invalid/v1/chat/completions") {
        assert.equal(report.injectedRejections, 0); report.injectedRejections++; await save("report.json", report);
        return Response.json({ error: "controlled pre-dispatch refusal" }, { status: 429 });
      }
      assert.equal(String(url), upstream.baseUrl + "/chat/completions"); assert.equal(report.physicalCalls, 0);
      const request = JSON.parse(String(init?.body)); assert.equal(request.model, PLAN.model); assert.equal(request.max_completion_tokens, 128);
      report.physicalCalls++; await save("physical-request.json", request); await save("report.json", report);
      const response = await (controlled ?? transport!.fetch)(url, init);
      await save("physical-response.json", await response.clone().json()); return response;
    };
    const serve = async (port = 0) => {
      relay = new Relay(config, { provider: f!.provider, upstreamFetch }); await relay.initialize();
      server = createHttpServer(relay, new Refunder(relay)); server.listen(port, "127.0.0.1"); await once(server, "listening");
      return (server.address() as { port: number }).port;
    };
    const port = await serve();
    const snapshot = async () => ({ providerBalance: String(await f!.providerBalance()), nonce: await f!.provider.getTransactionCount(f!.agentAddress) });
    report.before = await snapshot();
    sdk = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account,
      asset: config.asset, provider: config.payTo, maxPrice: 10000n, timeoutMs: 150000, onHandle: (h: PaymentHandle) => save("handle.json", h) });
    const delivered = await sdk.fetch(`http://127.0.0.1:${port}/v1/chat`, { body: { service: config.service.id, model: "coder", tier: "cheap",
      stream: false, max_completion_tokens: 128, thinking: { type: "disabled" }, messages: [{ role: "user", content: "Return exactly OK." }] } });
    await save("handle.json", delivered.handle); await save("receipt.json", delivered.receipt);
    const raw = await f.provider.getTransactionReceipt(delivered.receipt.txHash); assert.ok(raw); await save("raw-receipt.json", raw.toJSON());
    report.after = await snapshot(); await sdk.resume(structuredClone(delivered.handle));
    await new Promise<void>(r => server!.close(() => r())); server = undefined; relay!.close();
    await serve(port); await relay!.recover(); await sdk.resume(structuredClone(delivered.handle));
    report.afterReplay = await snapshot(); report.callsAfterRestart = report.physicalCalls; report.rejectionsAfterRestart = report.injectedRejections;
    report.status = "Complete"; await save("report.json", report); report.audit = await auditFallback(output);
  } catch (error) { report.status = "Incomplete"; report.error = safe(error); }
  finally {
    sdk?.close(); if (server) await new Promise<void>(r => server!.close(() => r())); relay?.close(); transport?.close();
    await f?.close(); if (local) await stopAnvil(local.child); await save("report.json", report);
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, execute: { type: "boolean" }, "audit-output": { type: "string" } } });
  const work = values["audit-output"] ? (!values.execute && !values.config && !values.output ? auditFallback(values["audit-output"]) : Promise.reject(new Error("AUDIT_ONLY_REQUIRED")))
    : values.config ? verifyLiveFallback({ config: values.config, output: values.output, execute: values.execute }) : Promise.reject(new Error("CONFIG_REQUIRED"));
  work.then((r: any) => { console.log(JSON.stringify(r)); if (r.status === "Incomplete") process.exitCode = 1; }).catch(e => { console.error(safe(e)); process.exitCode = 1; });
}
