import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Transaction, Wallet } from "ethers";
import { problemCatalog } from "@agentfuel/arena";
import { runSelectedInference, selectInference, type SelectionConfig, type SelectionSession } from "@agentfuel/pi-loop/selector";
import { PaymentError, accountInterface, paymentId, requestDigest, sameAddress } from "@agentfuel/sdk";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { fixture, key, read, startAnvil, stopAnvil } from "../services/underwriter/test/fixture.js";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";
import { verifyProviderPaid } from "./live-tiers-evidence.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";

export const SELECTION_PLAN = { chainId: "31337", asset: "local mock-USDC", assetDecimals: 6, transport: "system-https-proxy",
  candidates: ["sum-integers", "balanced-brackets"], models: { cheap: "kimi-k2.6", strong: "kimi-k3" },
  operatorPrices: { cheap: "10000", strong: "30000" }, maxPrice: "30000", allowCredit: false, maxCompletionTokens: 2048,
  physicalCallLimit: 1, inferenceRetries: 0, deadlineDurationMs: 300000, expectedSelection: { problemId: "balanced-brackets", tier: "cheap", price: "10000" },
  limitation: "One selected SDK inference purchase, not Pi tools, code execution or Arena settlement. Operator quote excludes gas and is not the vendor bill." } as const;
const safe = (error: unknown) => { const value = error instanceof PaymentError ? error.code : (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "SELECTION_VERIFICATION_FAILED"; };

/** Offline consistency audit only; it does not rerun a model, query a chain or execute returned code. */
export async function auditSavedSelection(output: string) {
  const json = async (name: string) => JSON.parse(await readFile(join(output, name), "utf8"));
  const report = await json("report.json"), session = await json("selection/session.json") as SelectionSession;
  assert.deepEqual(report.plan, SELECTION_PLAN); assert.equal(report.status, "SelectionDelivered"); assert.deepEqual(report.evidenceCollectionErrors, []);
  assert.ok(["controlled", "real-kimi-system-https-proxy"].includes(report.upstreamMode));
  assert.equal(session.phase, "Delivered"); assert.deepEqual(session.decision, selectInference(session.config, session.decision.snapshot));
  const selected = session.decision.selected!; assert.ok(selected);
  assert.deepEqual({ problemId: selected.problemId, tier: selected.tier, price: selected.price }, SELECTION_PLAN.expectedSelection);
  assert.equal(session.config.allowCredit, false); assert.equal(session.config.chainId, SELECTION_PLAN.chainId);
  assert.equal(session.config.maxPrice, SELECTION_PLAN.maxPrice); assert.equal(session.config.maxCompletionTokens, SELECTION_PLAN.maxCompletionTokens);
  assert.equal(session.config.deadlineMs - report.selectionCreatedAtMs, SELECTION_PLAN.deadlineDurationMs);
  const provider = session.config.providers.find(value => value.id === selected.providerId)!;
  assert.ok(provider); assert.equal(provider.payTo, report.chain.provider); assert.equal(session.config.account, report.chain.account);
  const handle = session.handle!, receipt = session.inference!.receipt, request = await json("physical-request.json"), response = await json("physical-response.json");
  const record = await json(`relay/${handle.quote.paymentId}.json`), raw = await json("payment-transaction-receipt.json");
  assert.deepEqual(await json("handle.json"), handle); assert.deepEqual(await json("receipt.json"), receipt); assert.deepEqual(await json("selection-result.json"), session);
  assert.equal(handle.input.taskId, "0"); assert.equal(handle.quote.taskId, "0"); assert.equal(receipt.taskId, "0");
  assert.equal(handle.quote.tier, selected.tier); assert.equal(handle.quote.price, selected.price); assert.equal(receipt.tier, selected.tier); assert.equal(receipt.price, selected.price);
  assert.equal(handle.quote.chainId, session.config.chainId); assert.equal(receipt.chainId, session.config.chainId);
  assert.equal(handle.quote.agentId, session.config.agentId); assert.equal(receipt.agentId, session.config.agentId);
  for (const field of ["asset", "account"] as const) { assert.ok(sameAddress(handle.quote[field], session.config[field])); assert.ok(sameAddress(receipt[field], session.config[field])); }
  assert.ok(sameAddress(handle.quote.payTo, provider.payTo)); assert.ok(sameAddress(receipt.payTo, provider.payTo));
  assert.equal(handle.relayUrl, provider.relayUrl); assert.equal(handle.quote.service, provider.service); assert.equal(handle.quote.model, provider.model);
  assert.equal(handle.quote.requestDigest, requestDigest(handle.input)); assert.equal(handle.quote.paymentId, paymentId("0", handle.quote.requestDigest, handle.quote.serverNonce));
  assert.equal(receipt.requestDigest, handle.quote.requestDigest); assert.equal(receipt.paymentId, handle.quote.paymentId);
  const { agentId: _agent, taskId: _task, service: _service, tier: _tier, ...inference } = handle.input;
  assert.equal(request.max_completion_tokens, SELECTION_PLAN.maxCompletionTokens); assert.deepEqual(request, { ...inference, model: SELECTION_PLAN.models.cheap });
  assert.deepEqual(request.messages, [{ role: "system", content: "Return Python 3.12 source code for the public programming specification. No tools or wallet actions." },
    { role: "user", content: problemCatalog().find(problem => problem.id === selected.problemId)!.prompt }]);
  assert.equal(receipt.model, SELECTION_PLAN.models.cheap); assert.equal(response.model, SELECTION_PLAN.models.cheap); assert.deepEqual(receipt.usage, response.usage);
  assert.deepEqual(session.inference!.result, response); assert.equal(response.choices[0].finish_reason, "stop"); assert.ok(response.choices[0].message.content.trim());
  assert.ok(Number.isSafeInteger(response.usage.prompt_tokens) && response.usage.prompt_tokens >= 0);
  assert.ok(Number.isSafeInteger(response.usage.completion_tokens) && response.usage.completion_tokens >= 0 && response.usage.completion_tokens <= SELECTION_PLAN.maxCompletionTokens);
  assert.equal(response.usage.total_tokens, response.usage.prompt_tokens + response.usage.completion_tokens);
  assert.equal(record.state, "Delivered"); assert.deepEqual(record.request, handle.input); assert.deepEqual(record.quote, handle.quote); assert.deepEqual(record.receipt, receipt); assert.deepEqual(record.result, response);
  assert.equal(record.route.version, 1); assert.equal(record.route.tier, selected.tier); assert.equal(record.route.model, provider.model);
  assert.equal(record.route.upstreams.length, 1); assert.equal(record.route.upstreams[0].name, "kimi");
  assert.equal(record.route.upstreams[0].model, request.model); assert.equal(receipt.upstream, record.route.upstreams[0].name);
  assert.equal(record.upstreamAttempts.length, 1); assert.equal(record.upstreamAttempts[0].state, "Delivered");
  assert.equal(record.upstreamAttempts[0].upstream, receipt.upstream); assert.equal(record.upstreamAttempts[0].model, request.model);
  assert.equal(session.decision.snapshot.cash, report.before.cash); assert.equal(session.reservedPrice, selected.price);
  assert.equal(report.physicalCalls, 1); assert.equal(report.responseHttpStatus, 200);
  const signed = Transaction.from(handle.submission!.rawTransaction!);
  assert.equal(signed.hash, receipt.txHash); assert.equal(signed.hash, handle.submission!.txHash); assert.equal(signed.chainId, 31337n);
  assert.ok(sameAddress(signed.from!, report.chain.agentAddress)); assert.ok(sameAddress(signed.to!, session.config.account));
  const call = accountInterface.parseTransaction({ data: signed.data, value: signed.value })!;
  assert.equal(call.name, "payProvider"); assert.equal(call.args[0], BigInt(session.config.agentId)); assert.ok(sameAddress(call.args[1], provider.payTo));
  assert.equal(call.args[2], BigInt(selected.price)); assert.equal(call.args[3], handle.quote.paymentId); assert.equal(call.args[4].taskId, 0n); assert.equal(call.args[5], "0x");
  verifyProviderPaid(handle.quote, receipt, raw); assert.ok(sameAddress(raw.from, report.chain.agentAddress));
  assert.equal(receipt.fromCash, selected.price); assert.equal(receipt.fromCredit, "0");
  assert.equal(BigInt(report.after.providerBalance) - BigInt(report.before.providerBalance), BigInt(selected.price));
  assert.equal(BigInt(report.before.cash) - BigInt(report.after.cash), BigInt(selected.price));
  assert.equal(report.after.nonce - report.before.nonce, 1); assert.equal(signed.nonce, report.before.nonce);
  assert.deepEqual(report.afterReplay, report.after); assert.equal(report.physicalCallsAfterReplay, 1); assert.equal(report.replayedPaymentId, handle.quote.paymentId);
  assert.deepEqual(report.finalBalances, { cash: report.after.cash, providerBalance: report.after.providerBalance, nonce: report.after.nonce });
  assert.equal(report.after.taskStatus, "2"); assert.equal(report.after.loanStatus, "0");
  const audit = { fullyVerified: true, upstreamMode: report.upstreamMode, selected: { taskId: selected.taskId, problemId: selected.problemId, tier: selected.tier, price: selected.price },
    requestedModel: request.model, returnedModel: response.model, usage: response.usage, finishReason: response.choices[0].finish_reason,
    paymentId: handle.quote.paymentId, signedTransactionAndProviderPaidValidated: true, replayAddedPayments: 0, replayAddedModels: 0,
    limitation: SELECTION_PLAN.limitation };
  await writeFile(join(output, "offline-selection-audit.json"), JSON.stringify(audit, null, 2) + "\n", { mode: 0o600 }); return audit;
}

// Injection exists only for controlled tests, never as a CLI flag or a claim of real model verification.
export async function verifyLiveSelection(options: { config: string; output?: string; execute?: boolean }, controlled?: typeof fetch) {
  const upstream = await loadProbeUpstream(options.config);
  if (!options.execute) return { mode: "plan-only", plan: SELECTION_PLAN };
  if (!options.output || !isAbsolute(options.output)) throw new Error("ABSOLUTE_NEW_OUTPUT_REQUIRED");
  const output = options.output; await mkdir(output, { mode: 0o700 }); // Existing evidence is audit-only, never a fresh paid retry.
  const save = (name: string, value: unknown) => writeFile(join(output, name), JSON.stringify(value, null, 2).replaceAll(upstream.key, "[REDACTED]") + "\n", { mode: 0o600 });
  const report: any = { version: 1, plan: SELECTION_PLAN, upstreamMode: controlled ? "controlled" : "real-kimi-system-https-proxy", status: "Running", physicalCalls: 0,
    evidenceCollectionErrors: [], limitations: [SELECTION_PLAN.limitation, "No automatic paid retry. Unknown original payment/request retains its handle for operator reconciliation."] };
  let local: Awaited<ReturnType<typeof startAnvil>> | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined, server: ReturnType<typeof createHttpServer> | undefined, transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  let session: SelectionSession | undefined;
  try {
    report.sourceHashes = {};
    for (const path of ["scripts/verify-live-selection.ts", "packages/pi-loop/src/selector.ts", "packages/sdk/src/index.ts", "services/provider-relay/src/relay.ts", "services/provider-relay/src/store.ts"])
      report.sourceHashes[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
    await save("report.json", report); local = await startAnvil(); f = await fixture(local.rpc, join(output, "underwriter"), 6);
    const sum = String(await f.task()), brackets = String(await f.task(150000n, 600));
    if (!controlled) transport = proxyUpstreamFetch(await systemHttpsProxy(), 120000);
    const cheap = [{ ...upstream, model: SELECTION_PLAN.models.cheap }], strong = [{ ...upstream, model: SELECTION_PLAN.models.strong }];
    const relayConfig: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 6, payTo: f.payee, dataDir: join(output, "relay"), host: "127.0.0.1", port: 0, quoteTtl: 300, confirmations: 1, upstreamTimeout: 120000,
      service: { id: "infercredit/coder", model: "coder", price: 10000n, upstreams: cheap, tiers: { cheap: { price: 10000n, upstreams: cheap }, strong: { price: 30000n, upstreams: strong } } } };
    const upstreamFetch: typeof fetch = async (url, init) => {
      assert.equal(report.physicalCalls, 0); const request = JSON.parse(String(init?.body));
      assert.equal(request.model, SELECTION_PLAN.models.cheap); assert.equal(request.max_completion_tokens, SELECTION_PLAN.maxCompletionTokens);
      report.physicalCalls++; await save("physical-request.json", request); await save("report.json", report); // Persist dispatch intent before network.
      try { const response = await (controlled ?? transport!.fetch)(url, init); report.responseHttpStatus = response.status;
        const text = await response.clone().text(); await save("physical-response-text.json", { text });
        try { await save("physical-response.json", JSON.parse(text)); } catch { /* Raw non-JSON is preserved; Relay records Unknown. */ }
        return response;
      } catch (error) { report.upstreamError = safe(error); throw error; }
    };
    relay = new Relay(relayConfig, { provider: f.provider, upstreamFetch }); await relay.initialize();
    server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening");
    report.selectionCreatedAtMs = Date.now();
    const config: SelectionConfig = { agentId: "1", chainId: "31337", account: relayConfig.account, asset: relayConfig.asset, escrowAddress: await f.escrow.getAddress(),
      allowCredit: false, maxPrice: SELECTION_PLAN.maxPrice, deadlineMs: report.selectionCreatedAtMs + SELECTION_PLAN.deadlineDurationMs, minRemainingMs: 5000, maxCompletionTokens: SELECTION_PLAN.maxCompletionTokens,
      tasks: await Promise.all([[sum, "sum-integers"], [brackets, "balanced-brackets"]].map(async ([taskId, problemId]) => ({ taskId, problemId: problemId as "sum-integers" | "balanced-brackets",
        deadlineMs: Number((await read(f!.escrow, "getTask", [taskId])).deadline) * 1000, creditLimit: "0" }))),
      providers: [{ id: "trusted-kimi", payTo: f.payee, relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, service: "infercredit/coder", model: "coder",
        routes: [{ tier: "cheap", price: "10000", capabilities: ["python3-json-stdio", "balanced-brackets"] }, { tier: "strong", price: "30000", capabilities: ["python3-json-stdio", "sum-integers", "balanced-brackets"] }] }] };
    report.chain = { account: config.account, asset: config.asset, escrow: config.escrowAddress, provider: f.payee, agentAddress: f.agentAddress };
    const snapshot = async () => ({ cash: String(await read(f!.account, "cash", ["1"])), providerBalance: String(await f!.providerBalance()), nonce: await f!.provider.getTransactionCount(f!.agentAddress),
      taskStatus: String((await read(f!.escrow, "getTask", [brackets])).status), loanStatus: String((await read(f!.manager, "getLoan", [brackets])).status) });
    report.before = await snapshot(); await save("report.json", report);
    session = await runSelectedInference(join(output, "selection"), config, { signer: new Wallet(key(2), f.provider), timeoutMs: 150000 });
    await save("selection-result.json", session); report.phase = session.phase; report.reason = session.reason; report.after = await snapshot();
    if (session.phase === "Delivered") {
      const replay = await runSelectedInference(join(output, "selection"), config, { signer: new Wallet(key(2), f.provider), timeoutMs: 150000 });
      assert.deepEqual(replay, session); report.afterReplay = await snapshot(); report.physicalCallsAfterReplay = report.physicalCalls; report.replayedPaymentId = replay.handle!.quote.paymentId;
      const result = session.inference!.result as any, choice = result.choices[0];
      report.status = choice.finish_reason === "stop" && typeof choice.message.content === "string" && choice.message.content.trim() ? "SelectionDelivered" : "LimitedOutputDelivered";
      report.returnedModel = result.model; report.usage = result.usage; report.finishReason = choice.finish_reason;
    } else report.status = "Incomplete";
  } catch (error) { report.status = "Incomplete"; report.error = safe(error); }
  finally {
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); // Stop ingress before collecting final payment evidence.
    const collect = async (name: string, work: () => Promise<void>) => { try { await work(); } catch { report.evidenceCollectionErrors.push(name); } };
    if (!session) await collect("selection-session", async () => { session = JSON.parse(await readFile(join(output, "selection/session.json"), "utf8")); await save("selection-result.json", session); });
    if (session?.handle) await collect("original-handle", () => save("handle.json", session!.handle));
    if (session?.inference) await collect("inference-receipt", () => save("receipt.json", session!.inference!.receipt));
    if (f && session?.handle?.submission?.txHash) await collect("raw-payment-receipt", async () => {
      const raw = await f!.provider.getTransactionReceipt(session!.handle!.submission!.txHash!); assert.ok(raw); await save("payment-transaction-receipt.json", raw.toJSON()); report.paymentGasFeeWei = raw.fee.toString();
    });
    if (f) await collect("final-balances", async () => { report.finalBalances = { cash: String(await read(f!.account, "cash", ["1"])),
      providerBalance: String(await f!.providerBalance()), nonce: await f!.provider.getTransactionCount(f!.agentAddress) }; });
    try { await save("report.json", report); } // Save success and failure evidence before destroying our own chain.
    finally { relay?.close(); transport?.close(); if (f) await collect("fixture-close", () => f!.close()); if (local) await collect("anvil-stop", () => stopAnvil(local!.child)); }
  }
  if (report.status === "SelectionDelivered" && report.evidenceCollectionErrors.length > 0) report.status = "EvidenceCollectionFailed";
  if (report.status === "SelectionDelivered") {
    try { report.audit = await auditSavedSelection(output); } catch (error) { report.status = "EvidenceValidationFailed"; report.error = safe(error); }
  }
  report.finishedAt = new Date().toISOString(); await save("report.json", report); return report;
}

export async function main(args: string[]) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: "string" }, output: { type: "string" }, execute: { type: "boolean" }, "audit-output": { type: "string" } } });
  if (values["audit-output"]) { if (values.config || values.output || values.execute) throw new Error("AUDIT_ONLY_ARGUMENTS_REQUIRED"); console.log(JSON.stringify(await auditSavedSelection(values["audit-output"]))); return; }
  if (!values.config) throw new Error("CONFIG_REQUIRED");
  const report = await verifyLiveSelection({ config: values.config, output: values.output, execute: values.execute });
  console.log(JSON.stringify(report)); if (report.status && report.status !== "SelectionDelivered") process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: safe(error), instruction: "Preserve existing evidence; do not replay a paid run in a new directory." })); process.exitCode = 1; });
