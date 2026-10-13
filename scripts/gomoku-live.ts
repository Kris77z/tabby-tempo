import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { PaymentError } from "@agentfuel/sdk";
import { atomicJson } from "../services/arena/src/protocol.js";
import { replayMatch, runMatch, type MatchSession } from "../services/arena/src/gomoku/match.js";
import { RULES } from "../services/arena/src/gomoku/rules.js";
import { read } from "../services/underwriter/test/fixture.js";
import { createGomokuFixture } from "./gomoku-fixture.js";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";

export const gomokuLivePlan = {
  rules: RULES, size: 15, model: "kimi-k2.6", thinking: { type: "disabled" as const }, maxPlies: 31,
  maxCompletionTokens: 256, deadlineDurationMs: 1200000, upstreamTimeoutMs: 55000, sdkTimeoutMs: 60000,
  operatorPricePerMoveRaw: "10000", maxTotalPriceRaw: { black: "160000", white: "150000" },
  chainId: "31337", settlementAsset: "local mock-USDC", assetDecimals: 6, transport: "system-https-proxy",
  inferenceRetries: 0, independentWallets: true, sharedPrize: false, credit: false, tools: false, preseededMoves: false,
  limitation: "Operator mock-USDC caps are independent player fees, not the vendor invoice or gas. Real moves may stop, forfeit or reach the ply limit without a five-in-a-row winner.",
};
const failureCode = (error: unknown) => {
  const value = error instanceof PaymentError ? error.code : (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof value === "string" && /^[A-Z_0-9]+$/.test(value) ? value : "LIVE_GOMOKU_INFRASTRUCTURE_UNCERTAIN";
};

/** Injection exists only for local tests, never as a CLI option. Saved evidence explicitly labels controlled responses. */
export async function main(args: string[], controlledUpstream?: typeof fetch) {
  const { values } = parseArgs({ args, strict: true, options: { config: { type: "string" }, output: { type: "string" }, execute: { type: "boolean", default: false }, help: { type: "boolean" } } });
  if (values.help) { console.log("gomoku-live --config /absolute/private/demo.json [--output /absolute/new-directory --execute]. Default: bounded plan, no network/model calls. Existing output is never rerun."); return; }
  if (!values.config) throw new Error("CONFIG_REQUIRED");
  const upstream = await loadProbeUpstream(values.config);
  if (!values.execute) { console.log(JSON.stringify({ mode: "plan-only", ...gomokuLivePlan })); return; }
  if (!values.output || !isAbsolute(values.output)) throw new Error("ABSOLUTE_NEW_OUTPUT_REQUIRED");
  const output = values.output; await mkdir(output, { mode: 0o700 });
  const save = async (name: string, value: unknown) => {
    const path = join(output, name); await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    await atomicJson(path, JSON.parse(JSON.stringify(value).replaceAll(upstream.key, "[REDACTED]")));
  };
  const attempts: { ply: number; side: string; paymentId: string; requestDigest: string; requestedModel: string; status?: number; returnedModel?: string; durationMs?: number; error?: string }[] = [];
  const report: any = { version: 1, startedAt: new Date().toISOString(), node: process.version, plan: gomokuLivePlan,
    upstreamMode: controlledUpstream ? "controlled-upstream" : "real-kimi-system-https-proxy", phase: "Starting", attempts, evidenceCollectionErrors: [] };
  let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  let local: Awaited<ReturnType<typeof createGomokuFixture>> | undefined;
  let session: MatchSession | undefined;
  const sessionPath = join(output, "match/session.json");
  await save("report.json", report);
  try {
    report.sourceHashes = {};
    for (const path of ["scripts/gomoku-live.ts", "scripts/gomoku-fixture.ts", "scripts/demo-rpc.ts", "packages/sdk/src/index.ts", "packages/sdk/src/protocol.ts", "packages/pi-loop/src/session.ts", "services/arena/src/gomoku/rules.ts", "services/arena/src/gomoku/match.ts", "services/provider-relay/src/relay.ts", "services/provider-relay/src/store.ts", "services/underwriter/test/fixture.ts"])
      report.sourceHashes[path] = createHash("sha256").update(await readFile(new URL(`../${path}`, import.meta.url))).digest("hex");
    if (!controlledUpstream) transport = proxyUpstreamFetch(await systemHttpsProxy(), gomokuLivePlan.upstreamTimeoutMs);
    local = await createGomokuFixture(output, { physicalModel: gomokuLivePlan.model, price: BigInt(gomokuLivePlan.operatorPricePerMoveRaw), upstreamTimeoutMs: gomokuLivePlan.upstreamTimeoutMs,
      responder: async (call, signal) => {
        const current = JSON.parse(await readFile(sessionPath, "utf8")) as MatchSession; const turn = current.turns.at(-1)!; const handle = turn.handle;
        assert.ok(handle && !turn.applied && turn.dispatchIntent); assert.equal(turn.ply, call.ply); assert.equal(turn.side, call.side);
        assert.equal(call.model, gomokuLivePlan.model); assert.equal(call.request.max_completion_tokens, gomokuLivePlan.maxCompletionTokens);
        assert.deepEqual(call.request.thinking, gomokuLivePlan.thinking); assert.equal(call.request.stream, false);
        assert.equal(call.request.tools, undefined); assert.equal(call.request.tool_choice, undefined);
        if (attempts.length >= gomokuLivePlan.maxPlies || attempts.some(attempt => attempt.paymentId === handle.quote.paymentId) || Date.now() >= current.config.deadlineMs) throw new Error("PAID_REQUEST_LIMIT_REACHED");
        const attempt: typeof attempts[number] = { ply: call.ply, side: call.side, paymentId: handle.quote.paymentId, requestDigest: handle.quote.requestDigest, requestedModel: call.model };
        attempts.push(attempt); await save(`ply-${call.ply}/request.json`, call.request); await save("report.json", report);
        const started = Date.now();
        try {
          const boundSignal = AbortSignal.any([signal, AbortSignal.timeout(Math.max(1, current.config.deadlineMs - Date.now()))]);
          const response = await (controlledUpstream ?? transport!.fetch)(`${upstream.baseUrl}/chat/completions`, { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${upstream.key}` }, body: JSON.stringify(call.request), signal: boundSignal });
          attempt.status = response.status; const raw = await response.clone().text(); let body: any;
          try { body = JSON.parse(raw); } catch { body = { rawText: raw }; }
          await save(`ply-${call.ply}/response.json`, { httpStatus: response.status, body, rawText: raw }); attempt.returnedModel = body.model;
          return response;
        } catch (error) { attempt.error = failureCode(error); throw error; }
        finally { attempt.durationMs = Date.now() - started; await save("report.json", report); }
      } });
    const config = local.config("kimi-gomoku", { maxPlies: gomokuLivePlan.maxPlies, deadlineMs: Date.now() + gomokuLivePlan.deadlineDurationMs });
    for (const side of ["black", "white"] as const) Object.assign(config.players[side], { maxTotalPrice: gomokuLivePlan.maxTotalPriceRaw[side], maxCompletionTokens: gomokuLivePlan.maxCompletionTokens, thinking: gomokuLivePlan.thinking });
    const balances = async () => ({ blackCash: String(await read(local!.f.account, "cash", [1n])), whiteCash: String(await read(local!.f.account, "cash", [2n])), provider: String(await local!.f.providerBalance()),
      blackNonce: await local!.f.provider.getTransactionCount(config.players.black.wallet), whiteNonce: await local!.f.provider.getTransactionCount(config.players.white.wallet), totalOutstanding: String(await read(local!.f.manager, "totalOutstanding")) });
    report.localChain = { chainId: "31337", account: config.players.black.account, asset: config.players.black.asset, provider: config.players.black.provider,
      black: { agentId: "1", wallet: config.players.black.wallet }, white: { agentId: "2", wallet: config.players.white.wallet }, before: await balances() };
    await save("match-config.json", config); report.phase = "Running"; await save("report.json", report);
    session = await runMatch(join(output, "match"), config, { signers: local.signers, timeoutMs: gomokuLivePlan.sdkTimeoutMs });
    report.phase = session.phase; report.reason = session.reason; report.result = session.result ?? null; report.moves = replayMatch(session).moves.length; report.reservedPrice = session.reservedPrice;
    report.localChain.after = await balances();
  } catch (error) { report.error = failureCode(error); if (report.phase === "Starting") report.phase = "PreflightFailed"; else report.phase = "InfrastructureError"; }
  finally {
    const collect = async (name: string, work: () => Promise<void>) => { try { await work(); } catch { report.evidenceCollectionErrors.push(name); } };
    await collect("session", async () => { session = JSON.parse(await readFile(sessionPath, "utf8")); report.savedPhase = session!.phase; report.savedReason = session!.reason; replayMatch(session!); report.replayVerified = true; });
    if (local && session) for (const turn of session.turns) if (turn.handle?.submission?.txHash) await collect(`ply-${turn.ply}-receipt`, async () => {
      const receipt = await local!.f.provider.getTransactionReceipt(turn.handle!.submission!.txHash!); if (receipt) await save(`ply-${turn.ply}/transaction-receipt.json`, receipt.toJSON());
    });
    if (local) {
      await collect("upstream-calls", () => save("upstream-calls.json", local!.calls));
      await collect("final-balances", async () => { report.finalBalancesBeforeShutdown = { blackCash: String(await read(local!.f.account, "cash", [1n])), whiteCash: String(await read(local!.f.account, "cash", [2n])), provider: String(await local!.f.providerBalance()), totalOutstanding: String(await read(local!.f.manager, "totalOutstanding")) }; });
    }
    report.finishedAt = new Date().toISOString(); report.paidInferenceAttempts = attempts.length;
    report.limitations = ["Local Anvil/mock-USDC fees only; vendor bill is not verified", "No reward, collateral, loan or reputation update", "No rerun of an existing output; unknown paid result stays paused", "One fixed vendor candidate and one HTTP dispatch per payment; no auto model retry", "Controlled test responses are labelled, real responses receive no forced winner or seeded moves", "Chain is closed only after available receipts and balances are saved"];
    try { await save("report.json", report); }
    finally { transport?.close(); await local?.close(); }
  }
  console.log(JSON.stringify({ reportPath: join(output, "report.json"), phase: report.phase, result: report.result ?? null, moves: report.moves ?? 0, paidInferenceAttempts: attempts.length, replayVerified: report.replayVerified ?? false }));
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main(process.argv.slice(2)).then(report => { if (report?.error || report?.evidenceCollectionErrors.length) process.exitCode = 1; }).catch(error => { console.error(JSON.stringify({ error: failureCode(error), instruction: "Preserve evidence; do not rerun paid inference automatically." })); process.exitCode = 1; });
