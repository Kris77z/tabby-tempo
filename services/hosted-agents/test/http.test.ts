import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { request as httpRequest } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { Wallet } from "ethers";
import { HostedService } from "../src/service.js";
import { createHostedHttpServer } from "../src/http.js";
import type { HostedExecutor, HostedConfig } from "../src/types.js";
import { hostedAgentsRequest } from "../../../frontend/lib/hosted-agents-proxy.js";

const origin = "http://127.0.0.1:3000";
const settings = { name: "Managed Agent", modelId: "coder", strategy: "balanced" as const, perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true };
const wallets = [new Wallet("0x" + "1".padStart(64, "0")), new Wallet("0x" + "2".padStart(64, "0"))];
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-hosted-http-"))); let calls = 0, identities = 0;
  const inputs: { action: string; amountRaw?: string }[] = [];
  const config: HostedConfig = { directory, origin, chainId: "31337", models: [{ id: "coder", label: "Synthetic Coder" }], maxAgentsPerOwner: 3, maxTotalBudgetRaw: "1000000", maxPerRunBudgetRaw: "120000" };
  const executor: HostedExecutor = { async execute(input) { calls++; inputs.push({ action: input.run.action, amountRaw: input.run.amountRaw });
    return input.run.action === "provision" ? { phase: "SyntheticProvision", terminal: true, success: true, chargedRaw: "0", binding: { chainId: "31337", agentId: String(++identities), wallet: input.agent.wallet } } : { phase: "SyntheticTask", terminal: true, success: true, chargedRaw: input.run.reservedRaw };
  } };
  const service = await HostedService.open(config, executor), server = createHostedHttpServer(service);
  server.listen(0, "127.0.0.1"); await once(server, "listening"); const url = `http://127.0.0.1:${(server.address() as any).port}`;
  const close = async () => { await new Promise<void>(resolve => server.close(() => resolve())); await service.close(); await rm(directory, { recursive: true, force: true }); };
  const send = (path: string, method = "GET", body?: unknown, token?: string, headers = {}) => fetch(url + path, { method, headers: { origin: url, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  const login = async (wallet: Wallet) => {
    const challenge = await (await send("/auth/challenge", "POST", { wallet: wallet.address })).json();
    assert.match(challenge.message, /Origin: http:\/\/127\.0\.0\.1:3000/); assert.ok(challenge.expiresAt > Date.now());
    const signature = await wallet.signMessage(challenge.message), response = await send("/auth/login", "POST", { challengeId: challenge.id, signature });
    assert.equal(response.status, 200); return { challenge, signature, ...(await response.json()) };
  };
  return { directory, service, url, send, login, close, calls: () => calls, inputs, executor };
}
test("name-only HTTP creation gates execution until a valid settings update", async () => {
  const f = await fixture();
  try {
    const { token } = await f.login(wallets[0]);
    const input = { name: "Name only", requestId: randomUUID() };
    const response = await f.send("/agents", "POST", input, token);
    assert.equal(response.status, 202); const created = await response.json();
    await f.service.waitUntilIdle(); assert.equal(created.configurationRequired, true);
    const denied = await f.send(`/agents/${created.id}/runs`, "POST", { action: "task", requestId: randomUUID() }, token);
    assert.equal(denied.status, 409); assert.equal((await denied.json()).error, "HOSTED_CONFIGURATION_REQUIRED");
    const updated = await f.send(`/agents/${created.id}`, "PATCH", settings, token);
    assert.equal(updated.status, 200); assert.equal((await updated.json()).configurationRequired, false);
    const replay = await f.send("/agents", "POST", input, token);
    assert.equal((await replay.json()).id, created.id); assert.equal(f.calls(), 1);
    assert.equal((await f.send(`/agents/${created.id}/runs`, "POST", { action: "task", requestId: randomUUID() }, token)).status, 202);
    await f.service.waitUntilIdle(); assert.equal(f.calls(), 2);
  } finally { await f.close(); }
});

test("actual HostedService HTTP binds signed sessions to two owners and preserves idempotency", async () => {
  const f = await fixture();
  try {
    const a = await f.login(wallets[0]), b = await f.login(wallets[1]);
    assert.equal((await f.send("/auth/login", "POST", { challengeId: a.challenge.id, signature: a.signature })).status, 401);
    assert.equal((await f.send("/agents")).status, 401);
    const requestId = randomUUID(), created = await (await f.send("/agents", "POST", { requestId, ...settings }, a.token)).json();
    await f.service.waitUntilIdle(); assert.equal(created.owner, wallets[0].address); assert.notEqual(created.wallet, wallets[0].address); assert.equal(f.calls(), 1);
    const retry = await (await f.send("/agents", "POST", { requestId, ...settings }, a.token)).json();
    assert.equal(retry.id, created.id); assert.equal(retry.wallet, created.wallet); assert.equal(f.calls(), 1);
    assert.equal((await f.send("/agents", "POST", { requestId, ...settings, name: "Changed" }, a.token)).status, 409);
    for (const [path, method, body] of [[`/agents/${created.id}`, "PATCH", settings], [`/agents/${created.id}/pause`, "POST", { paused: true }], [`/agents/${created.id}/runs`, "POST", { action: "task", requestId: randomUUID() }], [`/agents/${created.id}/runs`, "POST", { action: "deposit", amountRaw: "40000", requestId: randomUUID() }]] as const)
      assert.equal((await f.send(path, method, body, b.token)).status, 404);
    assert.deepEqual((await (await f.send("/agents", "GET", undefined, b.token)).json()).agents, []);
    assert.equal((await f.send("/agents", "POST", { requestId: randomUUID(), ...settings, owner: wallets[1].address }, a.token)).status, 400);
    assert.equal((await f.send(`/agents/${created.id}`, "PATCH", { ...settings, name: "Updated" }, a.token)).status, 200);
    assert.equal((await f.send(`/agents/${created.id}/pause`, "POST", { paused: true }, a.token)).status, 200);
    assert.equal((await f.send(`/agents/${created.id}/runs`, "POST", { action: "task", requestId: randomUUID() }, a.token)).status, 409);
    await f.send(`/agents/${created.id}/pause`, "POST", { paused: false }, a.token);
    const runId = randomUUID(); assert.equal((await f.send(`/agents/${created.id}/runs`, "POST", { action: "task", requestId: runId }, a.token)).status, 202);
    await f.service.waitUntilIdle(); await f.send(`/agents/${created.id}/runs`, "POST", { action: "task", requestId: runId }, a.token); assert.equal(f.calls(), 2);
    const response = await f.send("/agents", "GET", undefined, a.token), text = await response.text(), snapshot = JSON.parse(text);
    assert.equal(snapshot.agents[0].spentRaw, "120000"); assert.equal(snapshot.runs[0].status, "Succeeded");
    assert.doesNotMatch(text, /privateKey|keyFile|wallet\.key|token|rpcUrl/); assert.ok(!text.includes(f.directory)); assert.ok(!text.includes(a.token));
    assert.equal(response.headers.get("cache-control"), "private, no-store");
    await f.send("/auth/logout", "POST", {}, a.token); assert.equal((await f.send("/agents", "GET", undefined, a.token)).status, 401);
  } finally { await f.close(); }
});
test("actual signed HTTP login through Next bridge returns cookie and no browser bearer", async () => {
  const f = await fixture();
  try {
    const bridge = (path: string, method: string, body?: unknown, cookie?: string) => hostedAgentsRequest(new Request(origin + "/api/hosted" + path, { method, headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) }), { origin, upstreamUrl: f.url });
    const challenge = await (await bridge("/auth/challenge", "POST", { wallet: wallets[0].address })).json();
    const login = await bridge("/auth/login", "POST", { challengeId: challenge.id, signature: await wallets[0].signMessage(challenge.message) });
    assert.equal(login.status, 200); const value = await login.json(); assert.equal(value.authenticated, true); assert.equal(value.token, undefined);
    const cookie = login.headers.get("set-cookie")!.split(";")[0]; assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/);
    const create = await bridge("/agents", "POST", { requestId: randomUUID(), ...settings }, cookie); assert.equal(create.status, 202); await f.service.waitUntilIdle();
    const agent = await create.json(), deposit = { action: "deposit", requestId: randomUUID(), amountRaw: "40000" };
    const posted = await bridge(`/agents/${agent.id}/runs`, "POST", deposit, cookie); assert.equal(posted.status, 202); assert.equal((await posted.json()).amountRaw, "40000"); await f.service.waitUntilIdle();
    const duplicate = await bridge(`/agents/${agent.id}/runs`, "POST", deposit, cookie); assert.equal(duplicate.status, 202); assert.equal((await duplicate.json()).amountRaw, "40000"); assert.equal(f.calls(), 2);
    assert.deepEqual(f.inputs[1], { action: "deposit", amountRaw: "40000" });
    assert.equal((await bridge(`/agents/${agent.id}/runs`, "POST", { ...deposit, amountRaw: "40001" }, cookie)).status, 409);
    for (const amountRaw of [undefined, "0", "-1", "1000001", 40000]) assert.equal((await bridge(`/agents/${agent.id}/runs`, "POST", { action: "deposit", requestId: randomUUID(), amountRaw }, cookie)).status, 400);
    assert.equal((await bridge(`/agents/${agent.id}/runs`, "POST", { action: "task", requestId: randomUUID(), amountRaw: "40000" }, cookie)).status, 400);
    const snapshot = await bridge("/agents", "GET", undefined, cookie); assert.equal(snapshot.status, 200); const state = await snapshot.json(); assert.equal(state.agents.length, 1); assert.equal(state.runs[0].amountRaw, "40000");
    const logout = await bridge("/auth/logout", "POST", {}, cookie); assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
    assert.equal((await bridge("/agents", "GET", undefined, cookie)).status, 401);
  } finally { await f.close(); }
});
test("HTTP requires exact loopback Host/Origin, bounded JSON and safe errors", async () => {
  const f = await fixture();
  try {
    const hostStatus = await new Promise<number>((resolve, reject) => {
      const call = httpRequest(f.url + "/auth/challenge", { method: "POST", headers: { host: "evil.example", origin: f.url, "content-type": "application/json" } }, response => { response.resume(); response.once("end", () => resolve(response.statusCode!)); });
      call.once("error", reject); call.setTimeout(5000, () => call.destroy(new Error("TEST_REQUEST_TIMEOUT")));
      call.end(JSON.stringify({ wallet: wallets[0].address }));
    }); assert.equal(hostStatus, 403);
    assert.equal((await f.send("/auth/challenge", "POST", { wallet: wallets[0].address }, undefined, { origin: "https://evil.example" })).status, 403);
    assert.equal((await f.send("/auth/challenge", "POST", { wallet: "x".repeat(8193) })).status, 413);
    assert.equal((await f.send("/auth/challenge", "POST", { wallet: wallets[0].address }, undefined, { "content-type": "text/plain" })).status, 415);
    assert.equal((await f.send("/agents?owner=attacker")).status, 400);
    assert.equal((await f.send("/agents", "DELETE")).status, 405);
    assert.equal((await f.send("/unknown")).status, 404);
    const invalid = await f.send("/auth/challenge", "POST", { wallet: "FAKE_PRIVATE_SENTINEL" }); assert.deepEqual(await invalid.json(), { error: "HOSTED_WALLET_INVALID" });
    assert.equal(f.calls(), 0);
  } finally { await f.close(); }
});


test("signed cookie bridge accepts long Chinese/English goals, preserves configuration flag and owner-scoped cancellation", async () => {
  const f = await fixture();
  try {
    f.executor.capabilities = { goals: { maxPhases: 3, models: [{ id: "coder", pricePerCallRaw: "10000" }] } };
    const originalExecute = f.executor.execute.bind(f.executor);
    f.executor.execute = async input => {
      if (input.run.action !== "goal") return originalExecute(input);
      await input.progress!({ stage: "paused", phases: [], calls: [] });
      return input.run.stopRequested
        ? { phase: "Cancelled", terminal: true, success: false, chargedRaw: "0", reason: "HOSTED_GOAL_CANCELLED", mission: { stage: "cancelled", phases: [], calls: [] } }
        : { phase: "Paused", terminal: false, success: false, chargedRaw: "0", reason: "HOSTED_GOAL_CALL_UNCERTAIN" };
    };
    const bridge = (path: string, method: string, body: unknown | undefined, cookie: string) => hostedAgentsRequest(new Request(origin + "/api/hosted" + path, { method,
      headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json", cookie }, body: body === undefined ? undefined : JSON.stringify(body) }), { origin, upstreamUrl: f.url });
    const a = await f.login(wallets[0]), b = await f.login(wallets[1]), cookieA = `agentfuel_hosted_session=${a.token}`, cookieB = `agentfuel_hosted_session=${b.token}`;
    const created = await bridge("/agents", "POST", { name: "Goal agent", requestId: randomUUID() }, cookieA);
    assert.equal(created.status, 202); const agent = await created.json(); assert.equal(agent.configurationRequired, true); await f.service.waitUntilIdle();
    const initial = await (await bridge("/agents", "GET", undefined, cookieA)).json(); assert.equal(initial.agents[0].configurationRequired, true);
    const updated = await bridge(`/agents/${agent.id}`, "PATCH", settings, cookieA); assert.equal((await updated.json()).configurationRequired, false);
    for (const goal of ["Explain the tradeoffs. ".repeat(450), "请根据这些要求给出详细方案。".repeat(700)]) {
      assert.ok(Buffer.byteLength(goal) > 8192); assert.ok(goal.length <= 12000);
      const command = { action: "goal", requestId: randomUUID(), goal };
      const posted = await bridge(`/agents/${agent.id}/runs`, "POST", command, cookieA); assert.equal(posted.status, 202); assert.equal((await posted.json()).goal, goal); await f.service.waitUntilIdle();
      assert.equal((await bridge(`/agents/${agent.id}/runs`, "POST", { ...command, goal: goal + "!" }, cookieA)).status, 409);
      assert.equal((await bridge(`/agents/${agent.id}/cancel`, "POST", { requestId: command.requestId }, cookieB)).status, 404);
      const snapshot = await (await bridge("/agents", "GET", undefined, cookieA)).json(); assert.equal(snapshot.runs.find((run: any) => run.requestId === command.requestId).goal, goal);
      const cancelled = await bridge(`/agents/${agent.id}/cancel`, "POST", { requestId: command.requestId }, cookieA); assert.equal(cancelled.status, 202); assert.equal((await cancelled.json()).stopRequested, true);
      await f.service.waitUntilIdle(); const final = await (await bridge("/agents", "GET", undefined, cookieA)).json(); assert.equal(final.runs.find((run: any) => run.requestId === command.requestId).reason, "HOSTED_GOAL_CANCELLED");
      assert.equal((await bridge(`/agents/${agent.id}/cancel`, "POST", { requestId: command.requestId, owner: wallets[0].address }, cookieA)).status, 400);
    }
    assert.equal((await bridge(`/agents/${agent.id}/runs`, "POST", { action: "goal", requestId: randomUUID(), goal: "x".repeat(12001) }, cookieA)).status, 400);
    assert.equal((await bridge(`/agents/${agent.id}/runs`, "POST", { action: "goal", requestId: randomUUID(), goal: "中".repeat(23000) }, cookieA)).status, 413);
    assert.equal((await f.send(`/agents/${agent.id}/runs`, "POST", { action: "goal", requestId: randomUUID(), goal: "中".repeat(23000) }, a.token)).status, 413);
  } finally { await f.close(); }
});
