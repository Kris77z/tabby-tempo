import assert from "node:assert/strict";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { parseArgs } from "node:util";
import { InferCredit, PaymentError, type Json, type PaymentHandle } from "@agentfuel/sdk";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import { upstreamUrl, type RelayConfig } from "../services/provider-relay/src/config.js";
import { fixture, key, startAnvil, stopAnvil } from "../services/underwriter/test/fixture.js";
import { proxyUpstreamFetch, rpcRequest, systemHttpsProxy } from "./demo-rpc.js";
import { auditSavedProbe, verifyProviderPaid, type RawReceipt } from "./live-tiers-evidence.js";

const HELP = "verify-live-tiers --config /absolute/private/demo.monad.json --output /absolute/new-directory --execute\nUses two single paid inference requests: kimi-k2.6 and kimi-k3, max_completion_tokens=128, no inference retries. Payments use only a new local Anvil/mock-USDC fixture. Without --execute, validates configuration and prints a safe plan without network or inference.";
export const tierPrices = { cheap: "10000", strong: "30000" } as const;
export const publicPricing = {
  source: "https://platform.kimi.com/docs/pricing/chat.md", accessedDate: "2026-10-04", currency: "CNY", unit: "per 1000000 tokens",
  cheap: { model: "kimi-k2.6", inputCacheMiss: "6.50", inputCacheHit: "1.10", output: "27.00" },
  strong: { model: "kimi-k3", inputUncached: "20.00", inputCacheHit: "2.00", cacheWrite5min: "20.00", cacheWrite1h: "40.00", output: "100.00" },
  cacheAccounting: "For K3, cached/read, cache-write and uncached input token counts are mutually exclusive and sum to prompt_tokens. Reasoning and final content both consume the output cap and are billed as output.",
  limitation: "Published rates are context only; this probe does not calculate or verify the provider bill. Anvil quote prices are operator prices, not upstream-cost conversion.",
};
export function completionSummary(result: Json) {
  const value = result as { model?: unknown; usage?: Json; choices?: { finish_reason?: unknown; message?: { content?: unknown; reasoning_content?: unknown } }[] };
  const choice = value?.choices?.[0];
  const content = typeof choice?.message?.content === "string" ? choice.message.content : "";
  const reasoning = typeof choice?.message?.reasoning_content === "string" ? choice.message.reasoning_content : "";
  return { returnedModel: typeof value?.model === "string" ? value.model : null, usage: value?.usage ?? null,
    finishReason: typeof choice?.finish_reason === "string" ? choice.finish_reason : null, content,
    hasFinalContent: content.trim().length > 0, returnedOK: content.trim() === "OK", reasoningCharacterCount: reasoning.length,
    taskCompleted: content.trim() === "OK" && choice?.finish_reason === "stop" };
}
async function privateFile(path: string) {
  if (!isAbsolute(path)) throw new Error("ABSOLUTE_PRIVATE_PATH_REQUIRED");
  const meta = await stat(path);
  if (!meta.isFile() || (meta.mode & 0o777) !== 0o600 || (process.getuid && meta.uid !== process.getuid())) throw new Error("PRIVATE_FILE_REQUIRED");
  return (await readFile(path, "utf8")).trim();
}
export async function loadProbeUpstream(configPath: string) {
  const config = JSON.parse(await privateFile(configPath)) as { upstream: { name: string; baseUrl: string; model: string; apiKeyFile: string } };
  const { upstream } = config;
  if (!upstream || upstream.name !== "kimi" || new URL(upstreamUrl(upstream.baseUrl)).hostname !== "api.moonshot.cn") throw new Error("KIMI_CONFIGURATION_REQUIRED");
  const baseUrl = upstreamUrl(upstream.baseUrl);
  if (new URL(baseUrl).pathname !== "/v1") throw new Error("KIMI_V1_REQUIRED");
  const apiKey = await privateFile(upstream.apiKeyFile);
  if (!apiKey || /\s/.test(apiKey)) throw new Error("INVALID_API_KEY_FILE");
  return { name: upstream.name, baseUrl, key: apiKey };
}
function failureCode(error: unknown) {
  const code = error instanceof PaymentError ? error.code : (error as { code?: unknown })?.code;
  return typeof code === "string" && /^[A-Z_0-9]+$/.test(code) ? code : "VERIFICATION_FAILED";
}

export async function main(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: "string" }, output: { type: "string" }, "audit-output": { type: "string" }, execute: { type: "boolean", default: false }, help: { type: "boolean", default: false } } });
  if (values.help) { console.log(HELP); return; }
  if (values["audit-output"]) {
    if (values.execute || values.config || values.output) throw new Error("AUDIT_ONLY_ARGUMENTS_REQUIRED");
    const audit = await auditSavedProbe(values["audit-output"]);
    console.log(JSON.stringify({ mode: "offline-audit", ...audit })); return;
  }
  if (!values.config) throw new Error("CONFIG_REQUIRED");
  const upstream = await loadProbeUpstream(values.config);
  const plan = { endpointHostname: "api.moonshot.cn", transport: "system-https-proxy", chainId: "31337", settlementAsset: "local mock-USDC", assetDecimals: 6,
    operatorPricesRaw: tierPrices, operatorPricesDisplay: { cheap: "0.01", strong: "0.03" },
    models: { cheap: "kimi-k2.6", strong: "kimi-k3" }, requestCountLimit: 2, requestsPerModelLimit: 1, maxCompletionTokens: 128, inferenceRetries: 0,
    requestOptions: { cheap: { thinking: { type: "disabled" } }, strong: { reasoning_effort: "low" } }, publishedPricing: publicPricing };
  if (!values.execute) { console.log(JSON.stringify({ mode: "plan-only", ...plan })); return; }
  if (!values.output || !isAbsolute(values.output)) throw new Error("ABSOLUTE_NEW_OUTPUT_REQUIRED");
  await mkdir(values.output, { mode: 0o700 }); // Refuse existing evidence directories instead of replaying paid inference.
  const output = values.output;
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  const report: Record<string, unknown> = { version: 1, startedAt: new Date().toISOString(), plan, paidInferenceAttempts: 0, status: "Running", tiers: {} };
  const tiers = report.tiers as Record<string, unknown>;
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  let infer: InferCredit | undefined;
  let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  const attempts: { requestedModel: string; httpStatus?: number; durationMs?: number; error?: string }[] = [];
  try {
    const proxy = await systemHttpsProxy();
    const list = rpcRequest(upstream.baseUrl + "/models", proxy, 30000);
    try {
      list.request.method = "GET"; list.request.setHeader("authorization", `Bearer ${upstream.key}`);
      const response = await list.request.send();
      const body = JSON.parse(new TextDecoder().decode(response.body ?? new Uint8Array())) as { data?: { id?: string }[] };
      const models = body.data?.map(model => model.id).filter(id => typeof id === "string") ?? [];
      report.modelDirectory = { httpStatus: response.statusCode, models, readOnlyRequests: 1 };
      if (response.statusCode !== 200 || !models.includes("kimi-k2.6") || !models.includes("kimi-k3")) throw new Error("TWO_MODELS_NOT_LISTED");
    } finally { list.close(); }
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, join(output, "underwriter"), 6);
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 6, payTo: f.payee, service: { id: "infercredit/coder", model: "coder", price: 10000n, upstreams: [{ ...upstream, model: "kimi-k2.6" }],
        tiers: { cheap: { price: 10000n, upstreams: [{ ...upstream, model: "kimi-k2.6" }] }, strong: { price: 30000n, upstreams: [{ ...upstream, model: "kimi-k3" }] } } },
      dataDir: join(output, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 120000, host: "127.0.0.1", port: 0 };
    transport = proxyUpstreamFetch(proxy, 120000);
    const upstreamFetch: typeof fetch = async (url, init) => {
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      if (attempts.length >= 2 || attempts.some(attempt => attempt.requestedModel === model)) throw new Error("PAID_REQUEST_LIMIT_REACHED");
      const attempt: typeof attempts[number] = { requestedModel: model }; attempts.push(attempt);
      report.paidInferenceAttempts = attempts.length; await save("report.json", report);
      const started = Date.now();
      try { const response = await transport!.fetch(url, init); attempt.httpStatus = response.status; return response; }
      catch (error) { attempt.error = failureCode(error); throw error; }
      finally { attempt.durationMs = Date.now() - started; }
    };
    relay = new Relay(config, { provider: f.provider, upstreamFetch }); await relay.initialize();
    server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
    const before = await f.providerBalance(); const nonceBefore = await f.provider.getTransactionCount(f.agentAddress);
    infer = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account,
      asset: config.asset, provider: config.payTo, maxPrice: 30000n, timeoutMs: 150000,
      onHandle: handle => save(`handle-${handle.input.tier}.json`, handle) });
    const handles: PaymentHandle[] = [];
    for (const tier of ["cheap", "strong"] as const) {
      const body = { service: config.service.id, model: config.service.model, tier, stream: false, max_completion_tokens: 128,
        ...(tier === "cheap" ? { thinking: { type: "disabled" } } : { reasoning_effort: "low" }),
        messages: [{ role: "user", content: "Return exactly OK." }] };
      try {
        const delivered = await infer.fetch(url, { body }); handles.push(delivered.handle);
        const summary = completionSummary(delivered.result);
        tiers[tier] = { requestedModel: plan.models[tier], quote: delivered.handle.quote, receipt: delivered.receipt,
          ...summary, modelFieldMatchesRequested: summary.returnedModel === plan.models[tier], providerAttempt: attempts.find(attempt => attempt.requestedModel === plan.models[tier]) };
        await save(`response-${tier}.json`, delivered.result); await save(`receipt-${tier}.json`, delivered.receipt);
        const rawReceipt = await f.provider.getTransactionReceipt(delivered.receipt.txHash);
        assert.ok(rawReceipt); const raw = rawReceipt.toJSON() as RawReceipt;
        await save(`transaction-receipt-${tier}.json`, raw); verifyProviderPaid(delivered.handle.quote, delivered.receipt, raw);
      } catch (error) { tiers[tier] = { requestedModel: plan.models[tier], error: failureCode(error), providerAttempt: attempts.find(attempt => attempt.requestedModel === plan.models[tier]) }; }
      await save("report.json", report);
    }
    const after = await f.providerBalance(); const nonceAfter = await f.provider.getTransactionCount(f.agentAddress);
    const beforeReplayAttempts = attempts.length;
    for (const handle of handles) await infer.resume(structuredClone(handle));
    assert.equal(attempts.length, beforeReplayAttempts); assert.equal(await f.providerBalance(), after);
    assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonceAfter);
    report.localPaymentEvidence = { chainId: "31337", asset: config.asset, account: config.account, beforeProviderBalance: before.toString(), afterProviderBalance: after.toString(),
      providerReceivedRaw: (after - before).toString(), agentNonceBefore: nonceBefore, agentNonceAfter: nonceAfter,
      deliveredPaymentIds: handles.map(handle => handle.quote.paymentId), cacheReplayRequests: handles.length, cacheReplayAddedInferenceRequests: attempts.length - beforeReplayAttempts,
      cacheReplayAddedPayments: 0, expectedTotalRawIfBothPaid: "40000" };
    if (handles.length === 2) { assert.equal(after - before, 40000n); assert.equal(nonceAfter - nonceBefore, 2); assert.equal(attempts.length, 2); }
    report.status = handles.length === 2 ? "BothTiersDelivered" : "Incomplete";
    report.taskCompletionValidated = Object.values(tiers).length === 2 && Object.values(tiers).every(tier => (tier as { taskCompleted?: boolean }).taskCompleted === true);
    report.limitations = ["Short completion probe only; no model capability evaluation.", "Receipt.model is the configured requested model; response model is the provider's self-reported value.", "Quote prices are operator-set local mock-USDC prices, not provider cost or actual bill.", "No standard x402 compatibility validation, no Monad deployment/payment, no Pi or Magpie."];
  } catch (error) { report.status = "Failed"; report.error = failureCode(error); }
  finally {
    infer?.close(); if (server) await new Promise<void>(resolve => server!.close(() => resolve())); relay?.close(); transport?.close();
    await f?.close(); if (child) await stopAnvil(child);
    report.finishedAt = new Date().toISOString(); report.attempts = attempts; report.paidInferenceAttempts = attempts.length;
    await save("report.json", report);
  }
  if (report.status === "BothTiersDelivered") {
    try { report.savedEvidenceAudit = await auditSavedProbe(output); await save("report.json", report); }
    catch (error) { report.status = "EvidenceValidationFailed"; report.error = failureCode(error); await save("report.json", report); }
  }
  console.log(JSON.stringify({ reportPath: join(output, "report.json"), status: report.status, taskCompletionValidated: report.taskCompletionValidated ?? false, paidInferenceAttempts: attempts.length }));
  if (report.status !== "BothTiersDelivered" || report.taskCompletionValidated !== true) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: failureCode(error), instruction: "Inspect any existing output/report before deciding next steps; do not replay paid inference." })); process.exitCode = 1; });
}
