import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostedTaskFixture } from "./task-fixture.js";
import { createHostedTaskExecutor } from "../src/task-executor.js";
import { HostedAutonomyExecutor } from "../src/autonomy-executor.js";
import { modelCatalogDigest } from "../src/metered-task.js";
import { InferenceAllowanceRelay, ALLOWANCE_SERVICE, ALLOWANCE_MODEL } from "../../provider-relay/src/allowance.js";
import { Relay } from "../../provider-relay/src/relay.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { modelToolResponse } from "../../../packages/pi-loop/test/workflow-fixture.js";
import type { GatewayModel } from "../src/inference-gateway.js";

test("paid planner chooses and settles two real metered tasks within one hosted budget, replay is read-only", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-autonomy-live-")));
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const keyFile = join(directory, "model.key"); await writeFile(keyFile, "controlled", { mode: 0o600 });
  const catalog: [GatewayModel, GatewayModel] = [
    { id: "cheap", model: "cheap/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 256 },
    { id: "strong", model: "strong/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 },
  ];
  const allowance = new InferenceAllowanceRelay({ ...f.fx.relayConfig, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
    upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
    { creditsRaw: "100000", modelCatalogDigest: modelCatalogDigest(catalog), provider: f.fx.f.provider });
  let plans = 0, solves = 0;
  const planner = new Relay({ ...f.fx.relayConfig, dataDir: join(directory, "planner-relay"), service: { id: "infercredit/plan", model: "logical-planner", price: 10000n,
    upstreams: [{ name: "cheap", model: "physical-planner", baseUrl: "http://127.0.0.1:9999/v1", key: "unused" }] } }, { provider: f.fx.f.provider,
    upstreamFetch: async () => { plans++; return Response.json({ model: "physical-planner", choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ action: "run-task", modelId: "cheap", funding: "credit" }) } }], usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } }); } });
  const servers = [allowance, planner].map(relay => createHttpServer(relay, new Refunder(relay)));
  for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
  const url = (i: number) => `http://127.0.0.1:${(servers[i].address() as any).port}/v1/chat`;
  const config = structuredClone(f.config); config.initialCashRaw = "50000"; config.metered = { relayUrl: url(0), payTo: f.fx.f.payee, priceRaw: "120000", creditsRaw: "100000", catalog, keyFile };
  const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, gatewayDispatch: async (model) => {
    solves++; return { status: 200, body: modelToolResponse(f.GOOD_CODE[solves === 1 ? "sum-integers" : "unique-sorted"], model.model) };
  } });
  const autonomous = new HostedAutonomyExecutor(tasks, { maxTasks: 2, maxDecisions: 3, durationMs: 200000, plannerRelayUrl: url(1), plannerProvider: f.fx.f.payee,
    plannerPriceRaw: "10000", plannerService: "infercredit/plan", plannerModel: "logical-planner", plannerPhysicalModel: "physical-planner" }, { provider: f.fx.f.provider });
  try {
    const actor = await f.actor(5, "cheap", 50000n); actor.agent.totalBudgetRaw = "260000";
    const ready = await tasks.execute(actor.input("provision")); assert.equal(ready.success, true, JSON.stringify(ready)); actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const input = actor.input("task"); input.run.action = "autonomous"; input.run.reservedRaw = "260000";
    const result = await autonomous.execute(input);
    assert.equal(result.phase, "Completed", JSON.stringify(result)); assert.equal(result.autonomousTasks, 2); assert.equal(result.chargedRaw, "260000"); assert.equal(result.success, true);
    assert.equal(plans, 2); assert.equal(solves, 2);
    const finance = await tasks.finance(actor.agent); assert.equal(finance.status, "confirmed");
    if (finance.status === "confirmed") { assert.equal(finance.counts.successes, "2"); assert.equal(finance.debtRaw, "0"); }
    const nonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await autonomous.execute({ ...input, recover: true }), result);
    assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce); assert.equal(plans, 2); assert.equal(solves, 2);
  } finally { for (const server of servers) await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); allowance.close(); planner.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
