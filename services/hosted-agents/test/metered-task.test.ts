import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { mkdtemp, realpath, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHostedTaskFixture } from "./task-fixture.js";
import { createHostedTaskExecutor } from "../src/task-executor.js";
import { modelCatalogDigest } from "../src/metered-task.js";
import { InferenceAllowanceRelay, ALLOWANCE_SERVICE, ALLOWANCE_MODEL } from "../../provider-relay/src/allowance.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { modelToolResponse } from "../../../packages/pi-loop/test/workflow-fixture.js";
import type { GatewayModel } from "../src/inference-gateway.js";

test("borrowed allowance runs two priced models, repairs same Pi task, independently settles and replays without paying again", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-metered-task-")));
  let succeeded = false;
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const keyFile = join(directory, "model.key"); await writeFile(keyFile, "controlled", { mode: 0o600 });
  const catalog: [GatewayModel, GatewayModel] = [
    { id: "cheap", model: "cheap/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 256 },
    { id: "strong", model: "strong/controlled", route: "http://127.0.0.1:9999/v1/chat/completions", inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 },
  ];
  const relay = new InferenceAllowanceRelay({ ...f.fx.relayConfig, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
    upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
    { creditsRaw: "100000", modelCatalogDigest: modelCatalogDigest(catalog), provider: f.fx.f.provider });
  const server = createHttpServer(relay, new Refunder(relay)); await relay.initialize(); server.listen(0, "127.0.0.1"); await once(server, "listening");
  const config = structuredClone(f.config); config.metered = { relayUrl: `http://127.0.0.1:${(server.address() as any).port}/v1/chat`, payTo: f.fx.f.payee,
    priceRaw: "120000", creditsRaw: "100000", catalog, keyFile };
  const calls: any[] = [];
  const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, gatewayDispatch: async (model, body) => {
    calls.push(body); return { status: 200, body: modelToolResponse(calls.length === 1 ? "print(0)" : f.GOOD_CODE[calls.length <= 2 ? "sum-integers" : "unique-sorted"], model.model) };
  } });
  const assertSucceeded = async (runDirectory: string, result: Awaited<ReturnType<typeof tasks.execute>>) => {
    let acceptance: unknown;
    if (result.phase !== "Succeeded") {
      const task = JSON.parse(await readFile(join(runDirectory, "task-executor/workflow/reward-task/session.json"), "utf8"));
      acceptance = { result: task.submission?.result, journal: JSON.parse(await readFile(join(directory, "chain/arena-http-journal.json"), "utf8").catch(() => "null")) };
    }
    assert.equal(result.phase, "Succeeded", JSON.stringify({ ...result, acceptance }));
  };
  try {
    const actor = await f.actor(5); const ready = await tasks.execute(actor.input("provision")); assert.equal(ready.success, true, JSON.stringify(ready));
    actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const first = actor.input("task"); first.run.action = "metered-task";
    const result = await tasks.execute(first);
    await assertSucceeded(first.directory, result); assert.equal(result.chargedRaw, "120000");
    assert.equal(result.fromCashRaw, "40000"); assert.equal(result.fromCreditRaw, "80000"); assert.equal(result.creditsUsed, 60);
    assert.equal(result.settlement?.loanStatus, "2"); assert.equal(result.settlement?.repaidRaw, "92000"); assert.equal(result.settlement?.residualRaw, "58000");
    assert.equal(calls.length, 2); assert.deepEqual(calls.map(b => b.model), catalog.map(m => m.model));
    assert.ok(calls[1].messages.some((m: any) => m.role === "tool"), "repair keeps first public test feedback");
    const ledger = JSON.parse(await readFile(join(first.directory, "task-executor/workflow/metered/inference-ledger/session.json"), "utf8"));
    assert.deepEqual(ledger.invocations.map((i: any) => i.result.chargedCredits), ["50", "150"]);
    const nonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await tasks.execute({ ...first, recover: true }), result); assert.equal(calls.length, 2);
    assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    const second = actor.input("task"); second.run.action = "metered-task";
    const next = await tasks.execute(second); await assertSucceeded(second.directory, next);
    assert.equal(next.settlement?.passed, true); assert.equal(calls.length, 3);
    assert.equal((await tasks.finance(actor.agent)).status, "confirmed");
    succeeded = true;
  } catch (error) {
    if (error instanceof Error) error.message += `\nPreserved metered failure fixture: ${directory}`;
    throw error;
  } finally { await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); relay.close(); await f.close();
    if (succeeded) await rm(directory, { recursive: true, force: true });
  }
});
