import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { Wallet } from "ethers";
import { DockerExecutor, DEFAULT_IMAGE } from "@agentfuel/arena/docker";
import { runProgrammingLoop, type LoopConfig, type LoopSession } from "@agentfuel/pi-loop";
import { PaymentError } from "@agentfuel/sdk";
import { createArenaHttpServer } from "../services/arena/src/http.js";
import { atomicJson, type ArenaConfig } from "../services/arena/src/protocol.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../services/underwriter/test/fixture.js";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";
import { loadProbeUpstream, publicPricing, tierPrices } from "./verify-live-tiers.js";
import { auditSavedPi } from "./live-pi-evidence.js";

export const livePiPlan = { chainId: "31337", asset: "local mock-USDC", assetDecimals: 6, transport: "system-https-proxy",
  models: { cheap: "kimi-k2.6", strong: "kimi-k3" }, tiers: ["cheap", "strong", "strong"], operatorPricesRaw: tierPrices,
  maxRounds: 3, maxCompletionTokens: 2048, maxTotalPriceRaw: "70000", maxPricePerCallRaw: "30000", deadlineDurationMs: 300000,
  inferenceRetries: 0, preseededError: false, problemId: "sum-integers", publicSample: { input: [4, 8, -3], expected: 9 }, dockerImage: DEFAULT_IMAGE,
  tierParameters: { cheap: { thinking: { type: "disabled" as const } }, strong: { reasoning_effort: "low" as const } },
  publishedPricing: publicPricing, apiSource: "https://platform.kimi.com/docs/api/chat.md", apiAccessedDate: "2026-10-04",
  limitation: "Operator mock-USDC quote budget excludes gas and is not the upstream model bill. Stop at first public-sample pass; no forced paid repair round." };
const code = (error: unknown) => { const value = error instanceof PaymentError ? error.code : (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message; return typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "VERIFICATION_FAILED"; };

// Test harness injection is not exposed as a CLI option and is explicitly labelled in saved evidence.
export async function main(args: string[], controlledUpstream?: typeof fetch) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: "string" }, output: { type: "string" }, "audit-output": { type: "string" }, execute: { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) { console.log("verify-live-pi --config /absolute/private/demo.json --output /absolute/new-directory --execute; or --audit-output /absolute/saved-directory. Without --execute prints a bounded plan and makes no network/model calls."); return; }
  if (values["audit-output"]) { if (values.config || values.output || values.execute) throw new Error("AUDIT_ONLY_ARGUMENTS_REQUIRED"); console.log(JSON.stringify(await auditSavedPi(values["audit-output"]))); return; }
  if (!values.config) throw new Error("CONFIG_REQUIRED");
  const upstream = await loadProbeUpstream(values.config);
  if (!values.execute) { console.log(JSON.stringify({ mode: "plan-only", ...livePiPlan })); return; }
  if (!values.output || !isAbsolute(values.output)) throw new Error("ABSOLUTE_NEW_OUTPUT_REQUIRED");
  const output = values.output; await mkdir(output, { mode: 0o700 }); // Never replay a paid run through this script.
  const save = async (name: string, value: unknown) => { const target = join(output, name); await mkdir(dirname(target), { recursive: true, mode: 0o700 }); const serialized = JSON.stringify(value).replaceAll(upstream.key, "[REDACTED]"); await atomicJson(target, JSON.parse(serialized)); };
  const attempts: Array<{ round: number; requestedModel: string; requestDigest: string; paymentId: string; httpStatus?: number; finishReason?: string; durationMs?: number; error?: string }> = [];
  const report: any = { version: 1, startedAt: new Date().toISOString(), runtimeNodeVersion: process.version, upstreamMode: controlledUpstream ? "controlled-upstream" : "real-kimi-system-https-proxy", plan: livePiPlan, status: "Running", stage: "preflight", attempts, evidenceCollectionErrors: [] };
  report.sourceHashes = {};
  for (const path of ["package-lock.json", "scripts/verify-live-pi.ts", "scripts/live-pi-evidence.ts", "scripts/demo-rpc.ts", "packages/pi-loop/package.json",
    "packages/pi-loop/src/index.ts", "packages/pi-loop/src/adapter.ts", "packages/pi-loop/src/session.ts", "packages/pi-loop/src/public-sample.ts", "packages/sdk/src/index.ts", "packages/sdk/src/protocol.ts",
    "services/provider-relay/src/config.ts", "services/provider-relay/src/relay.ts", "services/provider-relay/src/store.ts", "services/provider-relay/src/http.ts",
    "services/arena/src/http.ts", "services/arena/src/docker.ts", "services/arena/src/controller.ts", "services/arena/src/ipc.ts", "services/arena/src/protocol.ts", "services/arena/src/settler.ts", "services/arena/src/settler-main.ts", "services/arena/src/submission-auth.ts",
    "services/underwriter/test/fixture.ts", "contracts/src/AgentAccount.sol", "contracts/src/TaskEscrow.sol"])
    report.sourceHashes[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
  let anvil: ChildProcess | undefined, settler: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined, relay: Relay | undefined, server: ReturnType<typeof createHttpServer> | undefined;
  let arena: ReturnType<typeof createArenaHttpServer> | undefined, transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  let loopConfig: LoopConfig | undefined, session: LoopSession | undefined;
  await save("report.json", report);
  try {
    const proxy = controlledUpstream ? undefined : await systemHttpsProxy(); const runner = new DockerExecutor(); await runner.ready(); report.dockerReady = true;
    report.stage = "local-fixture"; const local = await startAnvil(); anvil = local.child; f = await fixture(local.rpc, join(output, "underwriter"), 6);
    const deposit = await tx(f.account, f.agent, "depositCash", [1n, 30000n]); await save("cash-deposit-transaction-receipt.json", deposit.toJSON());
    const taskId = String(await f.task()); assert.equal((await read(f.escrow, "getTask", [taskId])).status, 2n);
    // macOS Unix sockets have a short path limit; keep IPC runtime private but outside long evidence paths.
    const { mkdtemp } = await import("node:fs/promises"); const { tmpdir } = await import("node:os"); const ipcRuntime = await mkdtemp(join(tmpdir(), "af-live-pi-"));
    report.ipcRuntime = ipcRuntime;
    const arenaConfig: ArenaConfig = { rpcUrl: local.rpc, chainId: "31337", escrowAddress: await f.escrow.getAddress(), ipcDirectory: ipcRuntime,
      tasks: { [taskId]: { agentId: "1", problemId: "sum-integers" } }, settlementTimeoutMs: 30000 };
    await save("arena-config.json", arenaConfig);
    // Only the independent settler receives the synthetic local verifier key; it is never written into evidence.
    report.stage = "start-settler"; settler = spawn(process.execPath, ["--import", "tsx", new URL("../services/arena/src/settler-main.ts", import.meta.url).pathname], { cwd: new URL("..", import.meta.url).pathname,
      env: { PATH: process.env.PATH, ARENA_CONFIG: join(output, "arena-config.json"), ARENA_VERIFIER_PRIVATE_KEY: key(1) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000); const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolve(); }; settler!.stdout!.on("data", data => { if (String(data).includes('"ready":true')) finish(); }); settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("error", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("exit", () => finish(new Error("SETTLER_EXITED"))); });
    report.independentSettler = { ready: true, pid: settler.pid, sharesProcessWithLoop: false };
    arena = createArenaHttpServer(arenaConfig, [], f.provider); arena.server.listen(0, "127.0.0.1"); await once(arena.server, "listening");
    const cheap = [{ ...upstream, model: livePiPlan.models.cheap }], strong = [{ ...upstream, model: livePiPlan.models.strong }];
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: "infercredit/coder", model: "coder", price: 10000n, upstreams: cheap, tiers: { cheap: { price: 10000n, upstreams: cheap }, strong: { price: 30000n, upstreams: strong } } },
      dataDir: join(output, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 120000, host: "127.0.0.1", port: 0 };
    report.stage = "start-relay"; if (proxy) transport = proxyUpstreamFetch(proxy, 120000);
    relay = new Relay(config, { provider: f.provider, upstreamFetch: async (url, init) => {
      const current = JSON.parse(await readFile(join(output, "session/session.json"), "utf8")) as LoopSession;
      const round = current.rounds.findIndex(r => !r.appended) + 1; const handle = current.rounds[round - 1]?.handle;
      if (!handle || attempts.length >= 3 || attempts.some(a => a.paymentId === handle.quote.paymentId) || Date.now() >= current.config.deadlineMs) throw new Error("PAID_REQUEST_LIMIT_REACHED");
      const request = JSON.parse(String(init?.body)); const expected = livePiPlan.models[handle.input.tier!]; assert.equal(request.model, expected); assert.equal(request.max_completion_tokens, 2048);
      const attempt: typeof attempts[number] = { round, requestedModel: request.model, requestDigest: handle.quote.requestDigest, paymentId: handle.quote.paymentId }; attempts.push(attempt);
      await save(`round-${round}/request.json`, request); await save("report.json", report); // Durable attempt before external paid request.
      const started = Date.now();
      try {
        const signal = AbortSignal.any([...(init?.signal ? [init.signal] : []), AbortSignal.timeout(Math.max(1, current.config.deadlineMs - Date.now()))]);
        const response = await (controlledUpstream ?? transport!.fetch)(url, { ...init, signal }); attempt.httpStatus = response.status;
        const rawText = await response.clone().text(); let body: any;
        try { body = JSON.parse(rawText); } catch { body = { rawText }; }
        await save(`round-${round}/response.json`, body); attempt.finishReason = body.choices?.[0]?.finish_reason;
        return response;
      } catch (error) { attempt.error = code(error); throw error; }
      finally { attempt.durationMs = Date.now() - started; await save("report.json", report); }
    } });
    await relay.initialize(); server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening");
    loopConfig = { taskId, agentId: "1", rpcUrl: local.rpc, chainId: "31337", account: config.account, asset: config.asset, provider: config.payTo,
      relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, service: config.service.id, model: config.service.model,
      tiers: ["cheap", "strong", "strong"], maxRounds: 3, maxToolCalls: 6, maxTotalPrice: "70000", maxPricePerCall: "30000", deadlineMs: Date.now() + 300000,
      arenaUrl: `http://127.0.0.1:${(arena.server.address() as { port: number }).port}`, escrowAddress: arenaConfig.escrowAddress, maxCompletionTokens: 2048, tierParameters: livePiPlan.tierParameters };
    report.localChain = { chainId: "31337", account: config.account, asset: config.asset, provider: config.payTo, escrow: arenaConfig.escrowAddress, agentId: "1", agentAddress: f.agentAddress,
      verifier: new Wallet(key(1)).address, problemId: "sum-integers", taskId, providerBalanceBefore: String(await f.providerBalance()), agentNonceBefore: await f.provider.getTransactionCount(f.agentAddress),
      cashBefore: String(await read(f.account, "cash", [1n])), taskStatusBefore: "2" };
    await save("loop-config.json", loopConfig); await save("report.json", report);
    report.stage = "pi-loop"; session = await runProgrammingLoop(join(output, "session"), loopConfig, { signer: new Wallet(key(2), f.provider), runner, timeoutMs: 150000, pollTimeoutMs: 30000 });
    report.status = session.phase === "Succeeded" ? "TaskSucceeded" : "Incomplete"; report.loopPhase = session.phase; report.loopReason = session.reason;
  } catch (error) { report.status = "Failed"; report.error = code(error); report.failedStage = report.stage; }
  finally {
    // Collect all available signed transactions, raw receipts and final verdicts while the original chain is still alive, including failure paths.
    const collect = async (name: string, work: () => Promise<void>) => { try { await work(); } catch { report.evidenceCollectionErrors.push(name); } };
    await collect("session", async () => { session = JSON.parse(await readFile(join(output, "session/session.json"), "utf8")); report.loopPhase = session!.phase; report.loopReason = session!.reason; });
    if (f && session) {
      report.paymentGasFeesRawETH = [];
      for (const [index, round] of session.rounds.entries()) if (round.handle?.submission?.txHash) await collect(`round-${index + 1}-receipt`, async () => { const raw = await f!.provider.getTransactionReceipt(round.handle!.submission!.txHash!); if (raw) { await save(`round-${index + 1}/transaction-receipt.json`, raw.toJSON()); report.paymentGasFeesRawETH.push({ round: index + 1, feeWei: raw.fee.toString() }); } });
      if (session.submission?.result) await collect("arena-result", () => save("arena-result.json", session!.submission!.result));
      const settlement = (session.submission?.result as { settlement?: { txHash?: string } } | undefined)?.settlement;
      if (settlement?.txHash) await collect("settlement-receipt", async () => { const raw = await f!.provider.getTransactionReceipt(settlement.txHash!); assert.ok(raw); await save("settlement-transaction-receipt.json", raw.toJSON()); });
    }
    // Closing Arena waits for any already accepted final submission. Preserve a pending settler journal before stopping its signer/chain.
    if (server?.listening) await new Promise<void>(resolve => server!.close(() => resolve())); await arena?.close();
    if (report.ipcRuntime) await collect("settlement-journal", async () => { try {
      const journal = JSON.parse(await readFile(join(report.ipcRuntime, "settlements.json"), "utf8")); await save("settlement-journal.json", journal);
      const entry = journal[report.localChain?.taskId];
      if (f && entry?.txHash) { const raw = await f.provider.getTransactionReceipt(entry.txHash); if (raw) { await save("settlement-transaction-receipt.json", raw.toJSON()); report.settlementGasFeeWei = raw.fee.toString(); } }
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; } });
    if (f && report.localChain) await collect("chain-final-state", async () => { Object.assign(report.localChain, { providerBalanceAfter: String(await f!.providerBalance()), agentNonceAfter: await f!.provider.getTransactionCount(f!.agentAddress),
      cashAfter: String(await read(f!.account, "cash", [1n])), loanStatus: String((await read(f!.manager, "getLoan", [report.localChain.taskId])).status), taskStatusAfter: String((await read(f!.escrow, "getTask", [report.localChain.taskId])).status) }); });
    await save("report.json", report); // Evidence snapshot precedes chain teardown even if cleanup fails.
    if (settler) await stopAnvil(settler); relay?.close(); transport?.close(); await f?.close(); if (anvil) await stopAnvil(anvil);
    if (report.ipcRuntime) { const { rm } = await import("node:fs/promises"); await rm(report.ipcRuntime, { recursive: true, force: true }); delete report.ipcRuntime; }
    report.finishedAt = new Date().toISOString(); report.paidInferenceAttempts = attempts.length;
    report.realRepairValidated = (session?.tools.filter(t => t.result?.passed === false).length ?? 0) > 0 && session?.phase === "Succeeded" && session.rounds.length > 1;
    report.limitations = ["New local Anvil/mock-USDC only, no real Monad Pi or credit borrowing.", "Operator quote budget excludes gas and is not the provider bill.", "No artificial starter/error; first-round success does not validate real multi-round repair.", "No Magpie, autonomous task selection, gaming or standard x402 compatibility claim."];
    await save("report.json", report);
  }
  if (report.status === "TaskSucceeded" && report.evidenceCollectionErrors.length === 0) {
    try { report.savedEvidenceAudit = await auditSavedPi(output); await save("report.json", report); }
    catch { report.status = "EvidenceValidationFailed"; await save("report.json", report); }
  }
  if (report.status === "TaskSucceeded" && report.evidenceCollectionErrors.length) { report.status = "EvidenceCollectionFailed"; await save("report.json", report); }
  console.log(JSON.stringify({ reportPath: join(output, "report.json"), status: report.status, loopPhase: report.loopPhase, paidInferenceAttempts: attempts.length, realRepairValidated: report.realRepairValidated }));
  if (report.status !== "TaskSucceeded" || !report.savedEvidenceAudit) process.exitCode = 1;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).catch(error => { console.error(JSON.stringify({ error: code(error), instruction: "Preserve existing report/evidence. Do not rerun paid inference automatically." })); process.exitCode = 1; });
