import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { createServer } from "node:http";
import { mkdtemp, realpath, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import { createHostedHttpServer } from "../src/http.js";
import { createHostedTaskExecutor } from "../src/task-executor.js";
import { createHostedGameExecutor } from "../src/game-executor.js";
import { createHostedTaskFixture } from "./task-fixture.js";
import { key, tx, read } from "../../underwriter/test/fixture.js";
import { hostedAgentsRequest } from "../../../frontend/lib/hosted-agents-proxy.js";
import type { HostedRun } from "../src/types.js";

/** Root acceptance: real owner auth, random custody wallet, actual local contracts and both production adapters. */
test("owner creates a hosted Agent through HTTP, deposits, completes credit task, wins USDC, spends reward and redeems won tokens", { timeout: 180000 }, async t => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-hosted-flow-"))), f = await createHostedTaskFixture(join(directory, "chain"));
  let service: HostedService | undefined, http: ReturnType<typeof createHostedHttpServer> | undefined;
  const calls: any[] = [];
  const model = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const part of req) chunks.push(Buffer.from(part));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    let content = "Controlled reward-funded inference.";
    if (body.messages.length === 2) { const view = JSON.parse(body.messages[1].content); content = JSON.stringify(view.seat === 0 ? { type: "all-in" } : { type: "fold" }); }
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 12, completion_tokens: 6, total_tokens: 18 } }));
  });
  model.listen(0, "127.0.0.1"); await once(model, "listening");
  const modelUrl = `http://127.0.0.1:${(model.address() as any).port}/v1/chat/completions`;
  const file = async (name: string, text: string) => { const path = join(directory, name); await writeFile(path, text, { mode: 0o600 }); return path; };
  const taskConfig = structuredClone(f.config); taskConfig.models = [{ ...taskConfig.models[0], id: "kimi-k2.6" }]; taskConfig.initialCashRaw = "0";
  taskConfig.gasSponsorKeyFile = taskConfig.guardianKeyFile; taskConfig.gasGrantWei = "100000000000000000"; taskConfig.gasSponsorBudgetWei = "200000000000000000";
  const tasks = createHostedTaskExecutor(taskConfig, { provider: f.fx.f.provider });
  const games = createHostedGameExecutor({ version: 1, chainId: "31337", identity: taskConfig.identity, account: f.fx.config.account, token: f.fx.config.asset,
    publicRpcUrl: f.fx.local.rpc, rpcTransport: "direct", sponsorKeyFile: await file("sponsor.key", key(4)),
    opponent: { binding: { chainId: "31337", agentId: "1", wallet: new Wallet(key(2)).address }, keyFile: await file("bot.key", key(2)), modelId: "kimi-k2.6", strategy: "balanced" },
    models: [{ id: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", keyFile: await file("model.key", "controlled-local-only") }],
    creditsDirectory: join(directory, "credits"), walletDirectory: taskConfig.walletDirectory }, { provider: f.fx.f.provider, upstreamFetch: (_url, init) => fetch(modelUrl, init) });
  const origin = "http://127.0.0.1:3020";
  try {
    f.fx.f.admin.reset(); await tx(f.fx.f.token!, f.fx.f.admin, "mint", [new Wallet(key(4)).address, 300000n]);
    service = await HostedService.open({ directory: join(directory, "hosted"), origin, chainId: "31337", models: [{ id: "kimi-k2.6", label: "Controlled Kimi fixture" }], maxAgentsPerOwner: 2, maxPerRunBudgetRaw: "120000", maxTotalBudgetRaw: "1000000" },
      { execute: input => ["provision", "deposit", "task"].includes(input.run.action) ? tasks.execute(input) : games.execute(input) });
    http = createHostedHttpServer(service); http.listen(0, "127.0.0.1"); await once(http, "listening"); const upstreamUrl = `http://127.0.0.1:${(http.address() as any).port}`;
    const api = (path: string, method: string, body?: unknown, cookie?: string) => hostedAgentsRequest(new Request(origin + "/api/hosted" + path, { method,
      headers: { origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), { upstreamUrl, origin });
    const login = async (wallet: Pick<Wallet, "address" | "signMessage">) => { const c = await (await api("/auth/challenge", "POST", { wallet: wallet.address })).json(); const response = await api("/auth/login", "POST", { challengeId: c.id, signature: await wallet.signMessage(c.message) }); assert.equal(response.status, 200); assert.equal((await response.json()).token, undefined); return response.headers.get("set-cookie")!.split(";")[0]; };
    const user = Wallet.createRandom(), other = Wallet.createRandom(), cookie = await login(user), otherCookie = await login(other), createId = randomUUID();
    const response = await api("/agents", "POST", { requestId: createId, name: "User-created Agent", modelId: "kimi-k2.6", strategy: "aggressive", perRunBudgetRaw: "120000", totalBudgetRaw: "240000", allowCredit: true }, cookie);
    assert.equal(response.status, 202); const created = await response.json(); await service.waitUntilIdle();
    const snapshot = async () => { const r = await api("/agents", "GET", undefined, cookie); assert.equal(r.status, 200); return r.json(); };
    let view = await snapshot(); assert.equal(view.agents[0].status, "Ready", JSON.stringify(view.runs)); assert.equal(view.agents[0].binding.agentId, "2"); assert.notEqual(created.wallet, user.address);
    assert.equal(await read(f.fx.f.identity, "ownerOf", ["2"]), created.wallet); assert.equal(await read(f.fx.f.account, "cash", ["2"]), 0n);
    assert.equal((await (await api("/agents", "GET", undefined, otherCookie)).json()).agents.length, 0);
    assert.equal((await api(`/agents/${created.id}/runs`, "POST", { action: "game", requestId: randomUUID(), rewardKind: "usdc" }, otherCookie)).status, 404);
    const run = async (action: string, rest: object = {}) => {
      const requestId = randomUUID(), input = { action, requestId, ...rest }; const response = await api(`/agents/${created.id}/runs`, "POST", input, cookie); assert.equal(response.status, 202, await response.clone().text()); await service!.waitUntilIdle();
      const s = await snapshot(), result = s.runs.find((r: HostedRun) => r.requestId === requestId) as HostedRun; assert.equal(result.status, "Succeeded", JSON.stringify(result)); return { result, input };
    };
    // User-funded token arrival is controlled local mint. Only the custody wallet can deposit into its Account.
    f.fx.f.admin.reset(); await tx(f.fx.f.token!, f.fx.f.admin, "mint", [created.wallet, 40000n]);
    await run("deposit", { amountRaw: "40000" }); assert.equal(await read(f.fx.f.account, "cash", ["2"]), 40000n);
    f.fx.queue(f.GOOD_CODE["sum-integers"]); const first = await run("task"); assert.equal(first.result.chargedRaw, "120000"); assert.equal(first.result.result!.principalRaw, "0"); assert.equal(await read(f.fx.f.account, "cash", ["2"]), 58000n);
    const game = await run("game", { rewardKind: "usdc" }); assert.equal(game.result.result!.rewardRaw, "100000"); assert.equal(await read(f.fx.f.account, "cash", ["2"]), 158000n);
    assert.equal(calls[0].model, "kimi-k2.6"); assert.match(calls[0].messages[0].content, /Strategy preset: aggressive/);
    f.fx.queue(f.GOOD_CODE["unique-sorted"]); const second = await run("task"); assert.equal(second.result.chargedRaw, "120000"); assert.equal((await read(f.fx.f.account, "getPayment", [second.result.result!.paymentId!])).fromCredit, 0n);
    const tokens = await run("game", { rewardKind: "llm-credits" }); assert.equal(tokens.result.result!.creditsGranted, 4096);
    const redeemed = await run("credits"); assert.equal(redeemed.result.result!.creditsUsed, 18);
    const nonces = await Promise.all([created.wallet, new Wallet(key(4)).address].map(w => f.fx.f.provider.getTransactionCount(w))), n = calls.length, taskCalls = f.fx.calls.length;
    await api(`/agents/${created.id}/runs`, "POST", redeemed.input, cookie); await api(`/agents/${created.id}/runs`, "POST", game.input, cookie); await service.waitUntilIdle();
    assert.equal(calls.length, n); assert.equal(f.fx.calls.length, taskCalls); assert.deepEqual(await Promise.all([created.wallet, new Wallet(key(4)).address].map(w => f.fx.f.provider.getTransactionCount(w))), nonces);
    view = await snapshot(); assert.equal(view.agents[0].spentRaw, "240000"); assert.equal(view.agents[0].reservedRaw, "0"); assert.equal(await read(f.fx.f.manager, "totalOutstanding"), 0n);
    assert.doesNotMatch(JSON.stringify(view), /privateKey|rawTransaction|keyFile|controlled-local-only/);
    t.diagnostic(JSON.stringify({ chainId: 31337, model: "controlled responses, no paid vendor", hostedAgentId: view.agents[0].binding.agentId, taskCalls, gameAndCreditCalls: calls.length, cashAfter: String(await read(f.fx.f.account, "cash", ["2"])), spentRaw: view.agents[0].spentRaw, wonUsdcRaw: "100000", creditsGranted: 4096, creditsUsed: 18, outstanding: "0", originalReplayNoNewCallsOrTransactions: true }));
  } finally { if (http) await new Promise<void>(done => http!.close(() => done())); await service?.close(); games.close(); model.closeAllConnections(); await new Promise<void>(done => model.close(() => done())); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
