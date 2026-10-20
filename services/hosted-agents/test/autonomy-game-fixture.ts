import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, realpath, readFile, writeFile, rm, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet, Transaction } from "ethers";
import { DockerExecutor } from "../../arena/src/docker.js";
import { replayHand, type PlayerView } from "../../arena/src/holdem/engine.js";
import { createHostedTaskFixture } from "./task-fixture.js";
import { createHostedTaskExecutor } from "../src/task-executor.js";
import { createHostedGameExecutor } from "../src/game-executor.js";
import { HostedAutonomyExecutor } from "../src/autonomy-executor.js";
import { modelCatalogDigest } from "../src/metered-task.js";
import type { GatewayModel } from "../src/inference-gateway.js";
import { InferenceAllowanceRelay, ALLOWANCE_SERVICE, ALLOWANCE_MODEL } from "../../provider-relay/src/allowance.js";
import { Relay } from "../../provider-relay/src/relay.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { modelToolResponse } from "../../../packages/pi-loop/test/workflow-fixture.js";
import { key, read } from "../../underwriter/test/fixture.js";
import { validateHostedActivity, type HostedActivityInput } from "../src/scene-types.js";
import { HostedService } from "../src/service.js";
import { InferenceRewardLedger } from "../../arena/src/inference-rewards/index.js";
import { createKimiRewardDispatch } from "../../arena/src/inference-rewards/provider.js";
import { randomUUID } from "node:crypto";

/** Owned Anvil, actual loopback model HTTP, independent Docker/Arena verifier; no public vendor calls. */
export async function createAutonomyGameFixture() {
  const runner = new DockerExecutor(); await runner.ready();
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-autonomy-game-live-")));
  const f = await createHostedTaskFixture(join(directory, "chain"));
  const requests: any[] = [], samples: unknown[] = []; let loseNextGame = false, loseEveryGame = false;
  const original = runner.execute.bind(runner);
  runner.execute = async (...args) => { const result = await original(...args); samples.push(result); return result; };
  const model = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST"); assert.equal(req.url, "/v1/chat/completions");
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); requests.push(body);
      let response: unknown;
      if (body.model === "physical-planner") response = { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ action: "run-task", modelId: "kimi-k2.6", funding: "credit" }) } }],
        usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 } };
      else if (body.tools) response = modelToolResponse(f.GOOD_CODE["sum-integers"], body.model);
      else if (body.messages.length === 1) response = { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Controlled identity-bound reward allowance was consumed." } }],
        usage: { prompt_tokens: 3568, completion_tokens: 16, total_tokens: 3584 } };
      else {
        const view = JSON.parse(body.messages[1].content) as PlayerView;
        const action = view.seat === 0 && (loseNextGame || loseEveryGame) ? { type: "fold" } : view.seat === 0 ? { type: "all-in" } : { type: "fold" };
        if (view.seat === 0) loseNextGame = false;
        response = { model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(action) } }],
          usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } };
      }
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
    } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: (error as Error).message })); }
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const route = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1/chat/completions`;
  const file = async (name: string, value: string) => { const path = join(directory, name); await writeFile(path, value, { mode: 0o600 }); return path; };
  const modelKey = await file("model.key", "controlled-local-model");
  const catalog: [GatewayModel, GatewayModel] = [
    { id: "cheap", model: "cheap/controlled", route, inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", maxCompletionTokens: 256 },
    { id: "strong", model: "strong/controlled", route, inputMicroCreditsPerToken: "3", outputMicroCreditsPerToken: "6", maxCompletionTokens: 256 },
  ];
  const allowance = new InferenceAllowanceRelay({ ...f.fx.relayConfig, dataDir: join(directory, "allowance"), service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
    upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] } },
    { creditsRaw: "100000", modelCatalogDigest: modelCatalogDigest(catalog), provider: f.fx.f.provider });
  const planner = new Relay({ ...f.fx.relayConfig, dataDir: join(directory, "planner-relay"), service: { id: "infercredit/plan", model: "logical-planner", price: 10000n,
    upstreams: [{ name: "cheap", model: "physical-planner", baseUrl: route.replace(/\/chat\/completions$/, ""), key: "controlled-local-model" }] } }, { provider: f.fx.f.provider });
  const servers = [allowance, planner].map(relay => createHttpServer(relay, new Refunder(relay)));
  for (const server of servers) { server.listen(0, "127.0.0.1"); await once(server, "listening"); }
  const url = (i: number) => `http://127.0.0.1:${(servers[i].address() as { port: number }).port}/v1/chat`;
  const config = structuredClone(f.config); config.initialCashRaw = "0"; config.models[0].id = "kimi-k2.6";
  config.metered = { relayUrl: url(0), payTo: f.fx.f.payee, priceRaw: "120000", creditsRaw: "100000", catalog, keyFile: modelKey };
  const games = createHostedGameExecutor({ version: 1, chainId: "31337", identity: config.identity, account: f.fx.config.account, token: f.fx.config.asset,
    publicRpcUrl: f.fx.local.rpc, rpcTransport: "direct", sponsorKeyFile: await file("sponsor.key", key(1)),
    opponent: { binding: { chainId: "31337", agentId: "1", wallet: new Wallet(key(2)).address }, keyFile: await file("opponent.key", key(2)), modelId: "kimi-k2.6", strategy: "balanced" },
    models: [{ id: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", keyFile: modelKey }], creditsDirectory: join(directory, "credits"), walletDirectory: config.walletDirectory,
  }, { provider: f.fx.f.provider, upstreamFetch: async (_officialUrl, init) => fetch(route, init) });
  const tasks = createHostedTaskExecutor(config, { provider: f.fx.f.provider, runner, reward: input => games.rewardTask(input) });
  const autonomous = (rewardKinds: ("usdc" | "llm-credits")[]) => new HostedAutonomyExecutor(tasks, { maxTasks: 1, maxDecisions: 5, durationMs: 240000,
    plannerRelayUrl: url(1), plannerProvider: f.fx.f.payee, plannerPriceRaw: "10000", plannerService: "infercredit/plan", plannerModel: "logical-planner", plannerPhysicalModel: "physical-planner",
    games: { maxGames: 2, maxSpendPerGameRaw: "0", rewardKinds, rewardTaskMinTokens: 2048 },
  }, { provider: f.fx.f.provider, games });
  const close = async () => {
    games.close();
    for (const server of servers) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
    allowance.close(); planner.close(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done()));
    await f.close(); await rm(directory, { recursive: true, force: true });
  };
  return { directory, f, tasks, games, autonomous, requests, samples, close, route, loseNextGame: () => { loseNextGame = true; }, loseEveryGame: () => { loseEveryGame = true; } };
}

