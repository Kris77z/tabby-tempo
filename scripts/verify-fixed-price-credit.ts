import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { Wallet, id } from "ethers";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../services/underwriter/test/fixture.js";
import { FixedPriceSolvingRelay, FixedPriceRefunder, FIXED_SOLVE_MODEL, FIXED_SOLVE_SERVICE } from "../services/provider-relay/src/fixed-price.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { createArenaHttpServer } from "../services/arena/src/http.js";
import type { ArenaConfig } from "../services/arena/src/protocol.js";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { InferCredit, type Inference, type PaymentHandle } from "@agentfuel/sdk";
import { runFixedPriceTask, type FixedTaskConfig, type FixedTaskSession } from "@agentfuel/pi-loop/fixed-task";
import { PUBLIC_SAMPLE } from "@agentfuel/pi-loop";
import type { SolveSpec } from "@agentfuel/pi-loop/provider";

const good = "import json,sys\nprint(json.dumps(sum(json.load(sys.stdin))))\n", wrong = "print(0)\n", sampleOnly = "print(9)\n";
function response(code: string) { return { model: "controlled-response-alias", choices: [{ finish_reason: "tool_calls", message: { role: "assistant", content: null, tool_calls: [{ id: "call_same", type: "function", function: { name: "test_public_sample", arguments: JSON.stringify({ code }) } }] } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }; }
const json = (value: unknown) => JSON.stringify(value, (_k, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";

/** Controlled upstream only. Own Anvil, mock USDC, Docker and independent settler; no public RPC/model. */
export async function verifyFixedPriceCredit(directory: string) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const report: Record<string, any> = { schema: 1, upstreamMode: "controlled", chainId: "31337", fixedPrice: "120000", complete: false, scenarios: [] };
  let ipcRuntime: string | undefined;
  let anvil: ChildProcess | undefined, settler: ChildProcess | undefined, f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: FixedPriceSolvingRelay | undefined, server: ReturnType<typeof createHttpServer> | undefined, arena: ReturnType<typeof createArenaHttpServer> | undefined;
  const sessions: Array<{ name: string; session: FixedTaskSession }> = [], calls: any[] = [], extraReceipts: any[] = [];
  try {
    const local = await startAnvil(); anvil = local.child;
    f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
    await f.provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]); // Gas only; provider starts with zero mock-USDC.
    assert.equal(await f.providerBalance(), 0n);
    report.funding = { providerInitialTokenBalance: "0", providerTokenMint: false, providerGasOnlyFunded: true, agentInitialCash: String(await read(f.account, "cash", ["1"])) };
    const taskIds: string[] = []; for (let i = 0; i < 7; i++) { f.agent.reset(); taskIds.push(String(await f.task(i === 5 ? 300000n : 150000n))); }
    ipcRuntime = await mkdtemp(join(tmpdir(), "af-fp-ipc-"));
    const arenaConfig: ArenaConfig = { rpcUrl: local.rpc, chainId: "31337", escrowAddress: await f.escrow.getAddress(), ipcDirectory: ipcRuntime, tasks: Object.fromEntries(taskIds.map(taskId => [taskId, { agentId: "1", problemId: "sum-integers" }])) };
    report.contracts = { account: await f.account.getAddress(), manager: await f.manager.getAddress(), escrow: await f.escrow.getAddress(), asset: f.config.settlementAsset, provider: f.payee, agent: f.agentAddress, verifier: new Wallet(key(1)).address };
    report.taskIds = taskIds;
    report.taskRewards = Object.fromEntries(taskIds.map((taskId, i) => [taskId, i === 5 ? "300000" : "150000"]));
    const arenaFile = join(directory, "arena.json"); await writeFile(arenaFile, json(arenaConfig), { mode: 0o600 });
    settler = spawn(process.execPath, ["--import", "tsx", new URL("../services/arena/src/settler-main.ts", import.meta.url).pathname], { cwd: new URL("..", import.meta.url).pathname, env: { ...process.env, ARENA_CONFIG: arenaFile, ARENA_VERIFIER_PRIVATE_KEY: key(1) }, stdio: ["ignore", "pipe", "pipe"] });
    await new Promise<void>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error("SETTLER_START_TIMEOUT")), 10000);
      const finish = (error?: Error) => { clearTimeout(timer); error ? reject(error) : resolveReady(); };
      settler!.stdout!.on("data", data => { if (String(data).includes('"ready":true')) finish(); });
      settler!.stderr!.on("data", () => finish(new Error("SETTLER_START_FAILED"))); settler!.once("error", finish); settler!.once("exit", () => finish(new Error("SETTLER_EXITED")));
    });
    arena = createArenaHttpServer(arenaConfig, [], f.provider); arena.server.listen(0, "127.0.0.1"); await once(arena.server, "listening");
    const arenaUrl = `http://127.0.0.1:${(arena.server.address() as { port: number }).port}`;
    let queue: Array<ReturnType<typeof response> | "unknown"> = [], slowDeadline = 0;
    class PublicRunner extends DockerExecutor { override async ready() { await super.ready(); if (slowDeadline) await delay(Math.max(1, slowDeadline - Date.now() + 10)); } }
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL, price: 120000n, upstreams: [
        { name: "cheap", model: "controlled-cheap", baseUrl: "https://cheap.invalid/v1", key: "synthetic-model-key" },
        { name: "strong", model: "controlled-strong", baseUrl: "https://strong.invalid/v1", key: "synthetic-model-key" },
      ] }, dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 5000, host: "127.0.0.1", port: 8788, refunderKey: key(4), operatorToken: "controlled-operator-token-at-least-32-characters" };
    relay = new FixedPriceSolvingRelay(config, { provider: f.provider, runner: new PublicRunner(), modelFetch: async (_url, init) => {
      const body = JSON.parse(String(init?.body)); calls.push(body); assert.ok(queue.length, "No unplanned model invocation");
      assert.equal(body.agentId, undefined); assert.equal(body.taskId, undefined); assert.deepEqual(body.tools.map((t: any) => t.function.name), ["test_public_sample"]);
      const next = queue.shift(); if (next === "unknown") throw new Error("Controlled lost model response"); return Response.json(next);
    } });
    await relay.initialize(); let refunder = new FixedPriceRefunder(relay); await refunder.initialize();
    server = createHttpServer(relay, refunder); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const relayBase = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const cfg = (taskId: string, patch: Partial<SolveSpec> = {}): FixedTaskConfig => {
      const solve: SolveSpec = { version: 1, problemId: "sum-integers", tiers: ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 256, deadlineMs: Date.now() + 90000, ...patch };
      return { taskId, agentId: "1", rpcUrl: local.rpc, chainId: "31337", account: config.account, asset: config.asset, provider: f!.payee, relayUrl: relayBase + "/v1/chat", underwriterUrl: f!.http, maxServicePrice: "120000", solve, deadlineMs: solve.deadlineMs, arenaUrl, escrowAddress: arenaConfig.escrowAddress };
    };
    const options = { signer: new Wallet(key(2), f.provider), timeoutMs: 5000, pollTimeoutMs: 15000 };
    const run = async (name: string, c: FixedTaskConfig) => { const s = await runFixedPriceTask(join(directory, name), c, options); sessions.push({ name, session: s }); return s; };
    const taskLoan = (taskId: string) => read(f!.manager, "getLoan", [taskId]);
    const body = (c: FixedTaskConfig) => ({ service: FIXED_SOLVE_SERVICE, model: FIXED_SOLVE_MODEL, agentId: c.agentId, taskId: c.taskId, messages: [{ role: "user", content: PUBLIC_SAMPLE.prompt }], solve: c.solve });
    const postQuote = async (c: FixedTaskConfig) => { const res = await fetch(relayBase + "/v1/chat", { method: "POST", headers: { "content-type": "application/json" }, body: json(body(c)) }); return { status: res.status, body: await res.json() as any }; };
    const verifyPaid = async (s: FixedTaskSession, cash: bigint, credit: bigint) => {
      const r = await f!.provider.getTransactionReceipt(s.handle!.submission!.txHash!); assert.equal(r?.status, 1);
      const paid = r!.logs.map(log => { try { return f!.account.interface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "ProviderPaid");
      const opened = r!.logs.map(log => { try { return f!.manager.interface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "LoanOpened");
      assert.equal(paid.length, 1); assert.equal(opened.length, 1); assert.equal(paid[0]!.args.fromCash, cash); assert.equal(paid[0]!.args.fromCredit, credit);
      assert.equal(paid[0]!.args.paymentId, s.handle!.quote.paymentId); assert.equal(opened[0]!.args.taskId, BigInt(s.config.taskId)); assert.equal(opened[0]!.args.amount, credit);
      const transaction = await f!.provider.getTransaction(r!.hash), call = f!.account.interface.parseTransaction({ data: transaction!.data, value: transaction!.value });
      assert.equal(call!.name, "payProvider"); const feeBps = BigInt(call!.args[4].feeBps);
      return { cash: cash.toString(), credit: credit.toString(), feeBps: feeBps.toString(), fee: (credit * feeBps / 10000n).toString(), paymentTx: r!.hash };
    };
    // Unpaid requests cannot reserve another agent's task. Paid request and old handle remain bound.
    const repairConfig = cfg(taskIds[0]), attackerConfig = { ...repairConfig, solve: { ...repairConfig.solve, maxToolCalls: 1 } };
    assert.equal((await postQuote(attackerConfig)).status, 402); assert.equal((await postQuote(repairConfig)).status, 402);
    queue = [response(wrong), response(good)]; const nonce0 = await f.provider.getTransactionCount(f.agentAddress);
    const repair = await run("repair", repairConfig); assert.equal(repair.phase, "Succeeded", json(repair)); const repairFunding = await verifyPaid(repair, 40000n, 80000n); assert.equal(repairFunding.fee, "12000");
    assert.equal(await f.providerBalance(), 120000n); assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonce0 + 1);
    assert.equal(repair.inference!.receipt.model, "controlled-strong"); assert.equal(repair.reservedPrice, "120000");
    assert.deepEqual((repair.inference!.result as any).run.tools.map((t: any) => t.result.passed), [false, true]);
    const loan0 = await taskLoan(taskIds[0]); assert.equal(loan0.status, 2n); assert.equal((await read(f.escrow, "getTask", [taskIds[0]])).status, 3n);
    assert.equal((await postQuote(attackerConfig)).status, 409); assert.equal((await postQuote(repairConfig)).body.quote.paymentId, repair.handle!.quote.paymentId);
    const callsAfterRepair = calls.length; assert.equal((await run("repair", repairConfig)).phase, "Succeeded"); assert.equal(calls.length, callsAfterRepair);
    report.scenarios.push({ name: "repair", passed: true, ...repairFunding, fixedPrice: repair.handle!.quote.price, modelCalls: (repair.inference!.result as any).run.rounds.length });

    // Restored delivery/candidate must retain the original paid proof and tested code.
    const tamperCases: Array<[string, (s: FixedTaskSession) => void, string]> = [
      ["candidate", s => { s.candidate = wrong; }, "SESSION_CANDIDATE_MISMATCH"],
      ["qualification", s => { s.qualificationCodeHash = "0".repeat(64); }, "SESSION_CANDIDATE_MISMATCH"],
      ["payload", s => { s.submission!.payload.code = wrong; s.phase = "SubmissionPending"; }, "SESSION_CANDIDATE_MISMATCH"],
      ["usage", s => { s.inference!.receipt.usage = { total_tokens: 999 }; }, "SERVICE_RESULT_INVALID"],
      ["upstream", s => { s.inference!.receipt.upstream = "cheap"; }, "SERVICE_RESULT_INVALID"],
      ["funds", s => { s.inference!.receipt.fromCash = "0"; s.inference!.receipt.fromCredit = "120000"; }, "SERVICE_PAYMENT_INVALID"],
      ["null-result", s => { s.inference!.result = null; }, "SERVICE_RESULT_INVALID"],
      ["bad-rounds", s => { (s.inference!.result as any).run.rounds = null; }, "SERVICE_RESULT_INVALID"],
    ];
    const beforeTamperNonce = await f.provider.getTransactionCount(f.agentAddress);
    for (const [name, mutate, reason] of tamperCases) {
      const saved = JSON.parse(json(repair)) as FixedTaskSession; saved.phase = "ReadyToSubmit";
      if (name !== "payload") delete saved.submission; mutate(saved);
      const target = join(directory, `tamper-${name}`); await mkdir(target, { mode: 0o700 }); await writeFile(join(target, "session.json"), json(saved), { mode: 0o600 });
      const rejected = await runFixedPriceTask(target, repairConfig, options); assert.equal(rejected.reason, reason); assert.notEqual(rejected.phase, "Succeeded");
    }
    assert.equal(await f.provider.getTransactionCount(f.agentAddress), beforeTamperNonce); assert.equal(calls.length, callsAfterRepair);
    const fraudConfig = cfg(taskIds[3]), originalStatus = relay.status.bind(relay);
    relay.status = async (paymentId, agentId, digest) => {
      const record = await relay!.record(paymentId, agentId, digest);
      if (record.state !== "Quoted" || record.quote.taskId !== fraudConfig.taskId) return originalStatus(paymentId, agentId, digest);
      const result = JSON.parse(json(repair.inference!.result)); result.taskId = fraudConfig.taskId; result.run.spec = fraudConfig.solve;
      return { ...await originalStatus(paymentId, agentId, digest), state: "Delivered", result,
        receipt: { ...repair.inference!.receipt, ...record.quote, model: repair.inference!.receipt.model } };
    };
    try {
      const fraud = await run("forged-delivered", fraudConfig); assert.equal(fraud.reason, "SERVICE_PAYMENT_INVALID"); assert.equal(fraud.submission, undefined);
      assert.equal(await f.provider.getTransactionCount(f.agentAddress), beforeTamperNonce); assert.equal(calls.length, callsAfterRepair);
    } finally { relay.status = originalStatus; }
    report.scenarios.push({ name: "restored-receipt-candidate-negative", passed: true, negativeCases: tamperCases.length + 1, extraPaymentOrModel: false });

    // A final Delivered write followed by lost HTTP response is claimed from cache without another draw/model call.
    const originalWrite = relay.store.write.bind(relay.store); let loseDelivery = true;
    relay.store.write = async record => { await originalWrite(record); if (loseDelivery && record.state === "Delivered") { loseDelivery = false; throw new Error("Controlled lost paid delivery"); } };
    queue = [response(good)]; const earlyConfig = cfg(taskIds[1]), earlyCash = await read(f.account, "cash", ["1"]);
    const earlyPaused = await run("early", earlyConfig); assert.equal(earlyPaused.phase, "Paused");
    const earlyNonce = await f.provider.getTransactionCount(f.agentAddress), earlyCalls = calls.length; relay.store.write = originalWrite;
    const early = await run("early", earlyConfig); assert.equal(early.phase, "Succeeded", json(early)); await verifyPaid(early, earlyCash, 120000n - earlyCash);
    assert.equal(calls.length, earlyCalls); assert.equal(await f.provider.getTransactionCount(f.agentAddress), earlyNonce); assert.equal(await f.providerBalance(), 240000n);
    assert.equal((early.inference!.result as any).run.rounds.length, 1); assert.equal(early.inference!.receipt.price, "120000");
    await assert.rejects(refunder.refund(early.handle!.quote.paymentId, id("early-refund"), "120000"), /Only paid/);
    report.scenarios.push({ name: "early-success-cache", passed: true, priceUnchanged: true, extraPaymentOrModel: false });

    const fullRefund = async (name: string, s: FixedTaskSession, injectFailure = false, defaulted = false) => {
      const paymentId = s.handle!.quote.paymentId, refundId = id(`fixed-spike-${name}`), before = await f!.providerBalance();
      await assert.rejects(refunder.refund(paymentId, refundId, "1"), /full original price/);
      let fault = injectFailure; relay!.store.write = async record => { if (fault && record.refunds.some(r => r.state === "Confirmed")) { fault = false; throw new Error("Controlled lost refund commit"); } await originalWrite(record); };
      if (injectFailure) {
        await assert.rejects(refunder.refund(paymentId, refundId, "120000"), /Controlled lost refund commit/);
        assert.equal(await f!.providerBalance(), before - 120000n);
        assert.equal((await run(name, s.config)).phase, "RefundPending");
        const refundNonce = await f!.provider.getTransactionCount(f!.payee); relay!.store.write = originalWrite;
        refunder = new FixedPriceRefunder(relay!); await refunder.recover(); assert.equal(await f!.provider.getTransactionCount(f!.payee), refundNonce);
      } else { await refunder.refund(paymentId, refundId, "120000"); relay!.store.write = originalWrite; }
      assert.equal(await f!.providerBalance(), before - 120000n);
      const loan = await taskLoan(s.config.taskId); assert.equal(loan.status, defaulted ? 3n : 4n); assert.equal(loan.principal + loan.fee, 0n);
      const record = await relay!.store.read(paymentId), receipt = await f!.provider.getTransactionReceipt(record.refunds[0].transaction!.txHash);
      const events = receipt!.logs.map(log => { try { return f!.manager.interface.parseLog(log); } catch { return null; } });
      assert.ok(events.some(event => event?.name === "RefundProcessed" && event.args.amount === 120000n)); if (!defaulted) assert.ok(events.some(event => event?.name === "LoanClosedByRefund"));
      const refunded = await run(name, s.config); assert.equal(refunded.phase, "Refunded", json(refunded)); assert.equal(refunded.submission, undefined);
      assert.equal((await read(f!.escrow, "getTask", [s.config.taskId])).status, defaulted ? 4n : 2n);
      assert.equal(refunded.refundConfirmation?.loanStatus, defaulted ? "3" : "4");
      const nonce = await f!.provider.getTransactionCount(f!.agentAddress), count = calls.length; await run(name, s.config);
      assert.equal(await f!.provider.getTransactionCount(f!.agentAddress), nonce); assert.equal(calls.length, count);
    };
    queue = ["unknown"]; const unknownConfig = cfg(taskIds[2]), unknownCash = await read(f.account, "cash", ["1"]);
    const unknown = await run("unknown", unknownConfig); assert.equal(unknown.phase, "Paused"); assert.equal(unknown.reason, "SOLVE_DISPATCH_UNKNOWN"); await verifyPaid(unknown, unknownCash, 120000n - unknownCash);
    const unknownCalls = calls.length, unknownNonce = await f.provider.getTransactionCount(f.agentAddress);
    assert.equal((await run("unknown", unknownConfig)).reason, "SOLVE_DISPATCH_UNKNOWN"); assert.equal(calls.length, unknownCalls); assert.equal(await f.provider.getTransactionCount(f.agentAddress), unknownNonce);
    await fullRefund("unknown", unknown, true); report.scenarios.push({ name: "unknown-dispatch-full-refund-recovery", passed: true, noRedispatch: true });
    queue = [response(wrong)]; const limited = await run("limited", cfg(taskIds[3], { maxRounds: 1, tiers: ["cheap"] })); assert.equal(limited.reason, "SOLVE_UNDELIVERED"); await fullRefund("limited", limited); report.scenarios.push({ name: "round-limit-full-refund", passed: true });
    const deadlineConfig = cfg(taskIds[4], { deadlineMs: Date.now() + 1800 }); slowDeadline = deadlineConfig.deadlineMs; queue = [response(good)];
    const expired = await run("deadline", deadlineConfig); slowDeadline = 0; assert.equal(expired.reason, "SOLVE_UNDELIVERED"); await fullRefund("deadline", expired); report.scenarios.push({ name: "deadline-full-refund", passed: true });

    // Prepare a paid undelivered service before later default freezes new borrowing.
    queue = ["unknown"]; const late = await run("late-refund", cfg(taskIds[6])); assert.equal(late.reason, "SOLVE_DISPATCH_UNKNOWN");

    // Delivered sample-only code is not undelivered: Arena can fail it and the real loan defaults.
    queue = [response(sampleOnly)]; const failed = await run("hidden-fail", cfg(taskIds[5])); assert.equal(failed.phase, "Failed", json(failed));
    await verifyPaid(failed, 0n, 120000n);
    assert.equal((failed.inference!.result as any).run.phase, "Delivered"); assert.equal((await taskLoan(taskIds[5])).status, 3n); assert.equal((await read(f.escrow, "getTask", [taskIds[5]])).status, 4n);
    await assert.rejects(refunder.refund(failed.handle!.quote.paymentId, id("failed-refund"), "120000"), /Only paid/);
    assert.equal(await f.providerBalance(), 480000n); assert.equal(queue.length, 0); report.scenarios.push({ name: "delivered-hidden-fail-default", passed: true, refundable: false, taskReward: "300000", cash: "0", credit: "120000" });
    const lateTask = await read(f.escrow, "getTask", [taskIds[6]]);
    await f.provider.send("evm_setNextBlockTimestamp", [Number(lateTask.deadline) + 1]); await f.provider.send("evm_mine", []); f.admin.reset();
    extraReceipts.push(await tx(f.escrow, f.admin, "expireTask", [taskIds[6]])); assert.equal((await taskLoan(taskIds[6])).status, 3n);
    await fullRefund("late-refund", late, false, true); assert.equal(await f.providerBalance(), 360000n);
    report.scenarios.push({ name: "expired-defaulted-then-full-refund", passed: true, taskRemainsFailed: true });
    report.complete = true;
  } catch (error) { report.error = error instanceof Error ? error.message : "FIXED_PRICE_SPIKE_FAILED"; throw error; }
  finally {
    try {
      await arena?.close(); arena = undefined;
      if (ipcRuntime) {
        try { await writeFile(join(directory, "settlement-journal.json"), await readFile(join(ipcRuntime, "settlements.json")), { mode: 0o600 }); }
        catch (error) {
          // An early failure may precede the first settlement. Preserve that original failure.
          if ((error as NodeJS.ErrnoException).code !== "ENOENT" || report.complete) throw error;
          report.settlementJournalCreated = false;
        }
      }
      if (f && relay) {
        for (const receipt of extraReceipts) await writeFile(join(directory, `${receipt.hash}.receipt.json`), json(receipt), { mode: 0o600 });
        report.tasks = Object.fromEntries(await Promise.all((report.taskIds ?? []).map(async (taskId: string) => {
          const task = await read(f!.escrow, "getTask", [taskId]), loan = await read(f!.manager, "getLoan", [taskId]);
          return [taskId, { task: { agentId: task.agentId, reward: task.reward, escrowBalance: task.escrowBalance, deadline: task.deadline, status: task.status },
            loan: { agentId: loan.agentId, principal: loan.principal, fee: loan.fee, loanDueAt: loan.loanDueAt, status: loan.status } }];
        })));
        report.providerBalance = String(await f.providerBalance()); report.agentCash = String(await read(f.account, "cash", ["1"])); report.totalOutstanding = String(await read(f.manager, "totalOutstanding"));
        for (const paymentId of await relay.store.ids()) {
          const record = await relay.store.read(paymentId); const hashes = [record.proof?.txHash, ...record.refunds.flatMap(r => [r.approval?.txHash, r.transaction?.txHash])].filter((v): v is string => Boolean(v));
          for (const hash of hashes) await writeFile(join(directory, `${hash}.receipt.json`), json(await f.provider.getTransactionReceipt(hash)), { mode: 0o600 });
        }
        for (const { session } of sessions) if (session.submission?.result) {
          const hash = (session.submission.result as any).settlement.txHash;
          await writeFile(join(directory, `${hash}.receipt.json`), json(await f.provider.getTransactionReceipt(hash)), { mode: 0o600 });
        }
      }
      await writeFile(join(directory, "model-calls.json"), json(calls), { mode: 0o600 }); await writeFile(join(directory, "report.json"), json(report), { mode: 0o600 });
    } finally {
      if (server?.listening) await new Promise<void>(resolveClosed => server!.close(() => resolveClosed())); relay?.close(); await arena?.close();
      if (settler) await stopAnvil(settler); await f?.close(); if (anvil) await stopAnvil(anvil); if (ipcRuntime) await rm(ipcRuntime, { recursive: true, force: true });
    }
  }
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const output = process.argv[2]; if (!output?.startsWith("/")) throw new Error("Use an absolute fresh output directory");
  await mkdir(output, { mode: 0o700 }); // Refuse reusing a completed or uncertain run.
  const result = await verifyFixedPriceCredit(output); process.stdout.write(json({ complete: result.complete, upstreamMode: result.upstreamMode, scenarios: result.scenarios.length }));
}
