import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { Transaction, keccak256 } from "ethers";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { createTaskRunnerFixture, waitTaskRunnerHttp } from "../packages/pi-loop/test/task-runner-fixture.js";
import { GOOD_CODE, modelToolResponse } from "../packages/pi-loop/test/workflow-fixture.js";
import { read } from "../services/underwriter/test/fixture.js";
import { loadProbeUpstream } from "./verify-live-tiers.js";
import { proxyUpstreamFetch, systemHttpsProxy } from "./demo-rpc.js";
import { taskRunsRequest } from "../frontend/lib/task-runner-proxy.js";

const save = (file: string, value: unknown) => writeFile(file, JSON.stringify(value, (_key, item) => typeof item === "bigint" ? item.toString() : item, 2) + "\n", { mode: 0o600 });
const json = async (file: string) => JSON.parse(await readFile(file, "utf8"));
/** One HTTP-selected Open task; only --execute opts into one real, capped model request. */
export async function verifyBackend(options: { output: string; config?: string; controlled?: boolean }) {
  if (!isAbsolute(options.output)) throw new Error("ABSOLUTE_OUTPUT_REQUIRED");
  await mkdir(options.output, { mode: 0o700 }); // Existing output is never reused to buy a second request.
  let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  let fixture: Awaited<ReturnType<typeof createTaskRunnerFixture>> | undefined;
  let physicalCalls = 0;
  const report: Record<string, any> = { version: 1, mode: options.controlled ? "controlled" : "real-kimi", chainId: "31337", asset: "mock-USDC-6", completed: false, maxModelCalls: 1, maxCompletionTokens: 2048 };
  try {
    const upstream = options.controlled ? undefined : await loadProbeUpstream(options.config!);
    if (upstream) transport = proxyUpstreamFetch(await systemHttpsProxy(), 120000);
    const modelFetch: typeof fetch = async (url, init) => {
      assert.equal(physicalCalls, 0, "MODEL_CALL_BUDGET_EXHAUSTED"); physicalCalls++;
      const request = JSON.parse(String(init?.body));
      assert.equal(request.model, options.controlled ? "controlled-cheap" : "kimi-k2.6");
      assert.equal(request.max_completion_tokens, 2048);
      await save(join(options.output, "model-request.json"), request);
      const response = options.controlled ? Response.json(modelToolResponse(GOOD_CODE["sum-integers"], request.model)) : await transport!.fetch(url, init);
      const body = await response.clone().json();
      await save(join(options.output, "model-response.json"), { status: response.status, body });
      assert.equal(response.status, 200); assert.equal(body.model, request.model);
      assert.ok(Number.isSafeInteger(body.usage?.completion_tokens) && body.usage.completion_tokens <= 2048);
      report.model = body.model; report.usage = body.usage;
      return response;
    };
    fixture = await createTaskRunnerFixture(join(options.output, "runtime"), [{ problemId: "sum-integers", open: true }], {
      modelFetch, ...(upstream ? { models: { cheap: "kimi-k2.6", strong: "kimi-k3" }, upstreams: { cheap: upstream, strong: upstream } } : {}),
      upstreamTimeoutMs: 120000, maxCompletionTokens: 2048, workflowTimeoutMs: 180000,
    });
    const { fx, runner, apiUrl, loaded } = fixture, requestId = randomUUID(); report.requestId = requestId;
    const beforeNonce = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    const bridge = (body?: unknown) => taskRunsRequest(new Request("http://127.0.0.1:3020/api/tasks/runs" + (body ? "" : `?requestId=${requestId}`), {
      method: body ? "POST" : "GET", headers: { origin: "http://127.0.0.1:3020", "content-type": "application/json" }, ...(body ? { body: JSON.stringify(body) } : {}),
    }), { upstreamUrl: new URL(apiUrl).origin });
    const start = await bridge({ action: "start", requestId, profileId: "local-fixed-b" }); assert.equal(start.status, 202);
    await save(join(options.output, "start.json"), await start.json());
    await runner.waitUntilIdle();
    let snapshot = await waitTaskRunnerHttp(apiUrl, requestId, 180000);
    // Recover the original request only; a delayed response must never cause another purchase/model call.
    if (snapshot.run?.recoverable && ["SubmissionPending", "RefundPending", "Paused"].includes(snapshot.run.workflow?.phase ?? "")) {
      await bridge({ action: "recover", requestId }); await runner.waitUntilIdle(); snapshot = await waitTaskRunnerHttp(apiUrl, requestId, 180000);
    }
    await save(join(options.output, "final.json"), snapshot);
    assert.equal(snapshot.run?.status, "Succeeded", snapshot.run?.reason);
    const status = snapshot.run!.workflow!;
    assert.deepEqual([status.finance?.fromCash, status.finance?.fromCredit, status.finance?.repaid], ["40000", "80000", "92000"]);
    assert.deepEqual([status.finance?.principal, status.finance?.fee, status.finance?.loanStatus], ["0", "0", "2"]);
    assert.equal(physicalCalls, 1); assert.equal(fx.calls.length, 1);
    const state = await json(join(loaded.config.dataDirectory, "runs", requestId, "session.json"));
    const hashes = [state.accept.txHash, state.child.inference.receipt.txHash, state.child.submission.result.settlement.txHash];
    const receipts = [];
    for (const hash of hashes) {
      const receipt = await fx.f.provider.getTransactionReceipt(hash); assert.equal(receipt?.status, 1);
      const block = await fx.f.provider.getBlock(receipt!.blockNumber); assert.equal(block?.hash, receipt!.blockHash);
      receipts.push(receipt!.toJSON());
    }
    const accepted = Transaction.from(state.accept.rawTransaction);
    assert.equal(keccak256(state.accept.rawTransaction), hashes[0]); assert.equal(accepted.from, fx.f.agentAddress);
    assert.equal(fx.f.escrow.interface.parseTransaction({ data: accepted.data })!.name, "acceptTask");
    const payment = await fx.f.provider.getTransaction(hashes[1]);
    const call = fx.f.account.interface.parseTransaction({ data: payment!.data });
    assert.equal(call!.name, "payProvider"); assert.equal(String(call!.args[2]), "120000"); assert.equal(call!.args[3], status.paymentId);
    assert.equal(payment!.from, fx.f.agentAddress);
    const accountEvents = receipts[1].logs.filter((log: any) => log.address.toLowerCase() === fx.config.account.toLowerCase()).map((log: any) => { try { return fx.f.account.interface.parseLog(log); } catch { return null; } });
    assert.equal(accountEvents.filter((event: any) => event?.name === "ProviderPaid").length, 1);
    assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), beforeNonce + 2);
    assert.equal(await read(fx.f.account, "cash", ["1"]), 58000n); assert.equal(await fx.f.providerBalance(), 120000n);
    assert.equal((await read(fx.f.manager, "getLoan", [status.choice!.taskId])).status, 2n);
    await save(join(options.output, "receipts.json"), receipts);
    // New Docker runs independently check the saved generated code; no model is called.
    const docker = new DockerExecutor(); await docker.ready();
    for (const [input, expected] of [[[], 0], [[-8, 3, 9], 4], [[1, 2, 3], 6]] as const) {
      const result = await docker.execute(state.child.candidate, JSON.stringify(input));
      assert.equal(result.failure, undefined); assert.equal(JSON.parse(result.stdout), expected);
    }
    const beforeRecovery = await fx.f.provider.getTransactionCount(fx.f.agentAddress);
    assert.equal((await bridge({ action: "recover", requestId })).status, 202); await runner.waitUntilIdle();
    const publicResponse = await bridge(); assert.equal(publicResponse.status, 200); const publicState = await publicResponse.json();
    assert.equal(publicState.run.status, "Succeeded"); assert.equal(physicalCalls, 1); assert.equal(await fx.f.provider.getTransactionCount(fx.f.agentAddress), beforeRecovery);
    assert.equal(JSON.stringify(publicState).includes(state.accept.rawTransaction), false);
    assert.equal(JSON.stringify(publicState).includes(state.child.candidate), false);
    Object.assign(report, { completed: true, physicalCalls, canonicalReceipts: 3, independentDockerCases: 3, originalRecoveryNoNewPaymentOrModel: true,
      fromCash: "40000", fromCredit: "80000", repaid: "92000", cashAfter: "58000", principal: "0", fee: "0", hashes,
      candidateSha256: createHash("sha256").update(state.child.candidate).digest("hex") });
  } catch (error) {
    report.physicalCalls = physicalCalls; report.error = /^[A-Z_0-9]+$/.test((error as Error).message) ? (error as Error).message : "BACKEND_VERIFICATION_FAILED";
    throw error;
  } finally {
    await save(join(options.output, "report.json"), report); await fixture?.close(); transport?.close();
  }
  return report;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const { values } = parseArgs({ options: { config: { type: "string" }, output: { type: "string" }, execute: { type: "boolean" }, controlled: { type: "boolean" } } });
    if (!values.output || !isAbsolute(values.output) || values.execute && values.controlled) throw new Error("BACKEND_VERIFY_ARGUMENTS_REQUIRED");
    if (!values.execute && !values.controlled) console.log(JSON.stringify({ mode: "plan", chainId: "31337", maxModelCalls: 1, maxCompletionTokens: 2048, output: values.output }));
    else { if (values.execute && !values.config) throw new Error("PRIVATE_CONFIG_REQUIRED"); console.log(JSON.stringify(await verifyBackend({ output: values.output, config: values.config, controlled: values.controlled }))); }
  } catch { console.error("BACKEND_VERIFICATION_FAILED; inspect the private output report"); process.exitCode = 1; }
}
