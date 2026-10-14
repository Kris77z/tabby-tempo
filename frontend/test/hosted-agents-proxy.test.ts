import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { NextRequest } from "next/server.js";
import { hostedAgentsRequest } from "../lib/hosted-agents-proxy.js";
import { hostedRequest, HostedClientError } from "../lib/hosted-client.js";

test("owner sponsorship snapshot and run binding survive the proxy without the private authorization file", async () => {
  const sponsorship = { used: 3, limit: 9, remaining: 6, globalLimit: 100, testAuthorization: { id: "approved-grant", maxTotalGames: 9, active: true, additionalUsed: 0, expiresAt: "2026-10-13T07:28:04.166Z", actorRewards: [{ hostedAgentId: "actor", rewardKind: "usdc", walletKey: "SECRET" }], file: "/private/SECRET", grant: { key: "SECRET" } }, secret: "SECRET" };
  const response = await hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ agents: [], runs: [{ requestId: "game", testSponsorship: { grantId: "approved-grant", digest: "digest", ordinal: 1, privateFile: "SECRET" } }], models: [], sponsorship })) as typeof fetch });
  assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body.sponsorship, { used: 3, limit: 9, remaining: 6, globalLimit: 100, testAuthorization: { id: "approved-grant", maxTotalGames: 9, active: true, additionalUsed: 0, expiresAt: "2026-10-13T07:28:04.166Z", actorRewards: [{ hostedAgentId: "actor", rewardKind: "usdc" }] } });
  assert.deepEqual(body.runs[0].testSponsorship, { grantId: "approved-grant", digest: "digest", ordinal: 1 }); assert.doesNotMatch(JSON.stringify(body), /SECRET|privateFile|walletKey|\/private/);
});

const origin = "http://127.0.0.1:3000", upstreamUrl = "http://127.0.0.1:8791", token = "s".repeat(64);
const config = { origin, upstreamUrl }, cookie = `agentfuel_hosted_session=${token}`;
const settings = { name: "Hosted", modelId: "coder", strategy: "balanced", perRunBudgetRaw: "120000", totalBudgetRaw: "1000000", allowCredit: true };
function request(path: string, method = "GET", body?: unknown, headers: Record<string, string> = {}) {
  return new Request(`${origin}/api/hosted${path}`, { method, headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json", cookie, ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
}
test("login keeps bearer only in HttpOnly Strict cookie; HTTPS adds Secure; logout clears it", async () => {
  const expiresAt = Date.now() + 3600000; let calls = 0;
  const fetcher = (async (url: URL | RequestInfo, options?: RequestInit) => {
    calls++; assert.equal(String(url), `${upstreamUrl}/auth/login`); assert.equal(options?.redirect, "error"); assert.equal(options?.cache, "no-store");
    const headers = new Headers(options?.headers); assert.equal(headers.get("authorization"), null); assert.equal(headers.get("cookie"), null); assert.equal(headers.get("origin"), upstreamUrl);
    return Response.json({ token, expiresAt, privateKey: "FAKE_PRIVATE_SENTINEL" });
  }) as typeof fetch;
  const response = await hostedAgentsRequest(request("/auth/login", "POST", { challengeId: "challenge", signature: "signature" }), { ...config, fetcher });
  assert.equal(response.status, 200); assert.deepEqual(await response.json(), { authenticated: true, expiresAt });
  assert.match(response.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict/); assert.match(response.headers.get("set-cookie")!, /Path=\/api\/hosted/); assert.doesNotMatch(response.headers.get("set-cookie")!, /Secure/);
  assert.equal(response.headers.get("cache-control"), "private, no-store");
  const secure = await hostedAgentsRequest(new Request("https://app.example/api/hosted/auth/login", { method: "POST", headers: { host: "app.example", origin: "https://app.example", "content-type": "application/json" }, body: "{}" }), { ...config, origin: "https://app.example", fetcher });
  assert.match(secure.headers.get("set-cookie")!, /; Secure/); assert.equal(calls, 2);
  const logout = await hostedAgentsRequest(request("/auth/logout", "POST", {}), { ...config, fetcher: (async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`); return Response.json({ authenticated: false });
  }) as typeof fetch });
  assert.equal(logout.status, 200); assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/);
});
test("bridge refuses owner/header injection, cross origin and unsafe upstream before fetch", async () => {
  let calls = 0; const fetcher = (async () => { calls++; return Response.json({}); }) as typeof fetch;
  for (const [input, options, status] of [
    [request("/agents", "POST", { ...settings, requestId: "id", owner: "attacker" }), config, 400],
    [request("/agents", "GET", undefined, { authorization: "Bearer attacker" }), config, 403],
    [request("/agents", "GET", undefined, { "x-owner": "attacker" }), config, 403],
    [request("/agents", "GET", undefined, { origin: "https://evil.example" }), config, 403],
    [request("/agents", "GET", undefined, { host: "evil.example" }), config, 403],
    [request("/agents", "GET", undefined, { "sec-fetch-site": "same-site" }), config, 403],
    [request("/agents", "GET", undefined, { cookie: "" }), config, 401],
    [request("/agents", "GET", undefined, { cookie: `${cookie}; ${cookie}` }), config, 401],
    [request("/agents?owner=attacker"), config, 400],
    [request("/agents"), { ...config, upstreamUrl: "https://evil.example/" }, 503],
    [request("/agents"), { ...config, upstreamUrl: undefined }, 503],
    [request("/agents"), { ...config, origin: undefined }, 503],
    [request("/arbitrary"), config, 404],
    [request("/agents", "DELETE"), config, 405],
  ] as const) assert.equal((await hostedAgentsRequest(input, { ...options, fetcher })).status, status);
  const missingOrigin = request("/agents", "POST", { ...settings, requestId: "id" }); missingOrigin.headers.delete("origin");
  assert.equal((await hostedAgentsRequest(missingOrigin, { ...config, fetcher })).status, 403); assert.equal(calls, 0);
});
test("fixed paths use only cookie bearer and public projections; upstream errors never leak", async () => {
  let calls = 0;
  const fetcher = (async (url, options) => {
    calls++; assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`);
    assert.equal(new Headers(options?.headers).get("x-owner"), null); assert.equal(new Headers(options?.headers).get("cookie"), null);
    const value = { ...settings, id: "agent-1", owner: "owner", wallet: "wallet", privateKey: "SECRET", keyFile: "/private/secret", binding: { chainId: "31337", agentId: "0", wallet: "wallet", rpcUrl: "SECRET" } };
    if (String(url).endsWith("/runs")) { const command = JSON.parse(options!.body as string); return Response.json({ requestId: "run", agentId: "agent-1", action: command.action, ...(command.amountRaw ? { amountRaw: command.amountRaw } : {}), status: "Queued", result: { phase: "done", chargedRaw: "120000", rawTransaction: "SECRET" }, token: "SECRET" }, { status: 202 }); }
    if (options?.method === "GET") return Response.json({ agents: [value], runs: [], models: [{ id: "coder", label: "Coder", apiKey: "SECRET" }], token: "SECRET" });
    return Response.json(value, { status: 202 });
  }) as typeof fetch;
  for (const input of [request("/agents"), request("/agents", "POST", { ...settings, requestId: "id" }), request("/agents/agent-1", "PATCH", settings), request("/agents/agent-1/pause", "POST", { paused: true }), request("/agents/agent-1/runs", "POST", { action: "task", requestId: "run" }), request("/agents/agent-1/runs", "POST", { action: "deposit", requestId: "deposit", amountRaw: "40000" })]) {
    const response = await hostedAgentsRequest(input, { ...config, fetcher }); assert.ok(response.ok); const text = await response.text(); assert.doesNotMatch(text, /SECRET|privateKey|keyFile|rawTransaction|apiKey|rpcUrl|token/);
    if (JSON.parse(text).action === "deposit") assert.equal(JSON.parse(text).amountRaw, "40000");
  }
  assert.equal(calls, 6);
  const unauthorized = await hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ error: "HOSTED_SESSION_EXPIRED", secret: "SECRET" }, { status: 401 })) as typeof fetch });
  assert.equal(unauthorized.status, 401); assert.match(unauthorized.headers.get("set-cookie")!, /Max-Age=0/); assert.deepEqual(await unauthorized.json(), { error: "HOSTED_SESSION_EXPIRED" });
  for (const fetcher of [(async () => { throw new Error("SECRET URL credential"); }), (async () => Response.json({ error: "SECRET" }, { status: 502 }))] as typeof fetch[]) {
    const response = await hostedAgentsRequest(request("/agents"), { ...config, fetcher }); assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "HOSTED_UNAVAILABLE" });
  }
});
test("JSON input/output is bounded and redirects are refused without retries", async () => {
  let calls = 0;
  const fetcher = (async (_url, options) => { calls++; assert.equal(options?.redirect, "error"); assert.ok(options?.signal); const chunk = new Uint8Array(1024 * 1024); let count = 0; return new Response(new ReadableStream({ pull(controller) { if (count++ < 65) controller.enqueue(chunk); else controller.close(); } })); }) as typeof fetch;
  const large = await hostedAgentsRequest(request("/agents", "POST", { ...settings, name: "x".repeat(8192) }), { ...config, fetcher });
  assert.equal(large.status, 413); assert.equal(calls, 0);
  const output = await hostedAgentsRequest(request("/agents"), { ...config, fetcher }); assert.equal(output.status, 413); assert.equal(calls, 1);
  const login = await hostedAgentsRequest(request("/auth/login", "POST", {}), { ...config, fetcher: (async () => Response.json({ token: "bad; cookie", expiresAt: Date.now() + 3600000 })) as typeof fetch });
  assert.equal(login.status, 503); assert.equal(login.headers.get("set-cookie"), null);
});
test("real HTTP redirect never receives a session bearer and is attempted only once", async () => {
  let targetCalls = 0, upstreamCalls = 0, authorization: string | undefined;
  const target = createServer((_request, response) => { targetCalls++; response.end("{}"); }); target.listen(0, "127.0.0.1"); await once(target, "listening");
  const location = `http://127.0.0.1:${(target.address() as any).port}/agents`;
  const upstream = createServer((request, response) => { upstreamCalls++; authorization = request.headers.authorization; response.writeHead(302, { location }); response.end(); });
  try {
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const response = await hostedAgentsRequest(request("/agents"), { origin, upstreamUrl: `http://127.0.0.1:${(upstream.address() as any).port}` });
    assert.equal(response.status, 503); assert.deepEqual(await response.json(), { error: "HOSTED_UNAVAILABLE" });
    assert.equal(authorization, `Bearer ${token}`); assert.equal(upstreamCalls, 1); assert.equal(targetCalls, 0);
  } finally {
    await Promise.all([upstream, target].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

test("finance is a cookie-authenticated read-only path with closed nested projections and distinct settlement evidence", async () => {
  const block = { number: 50, hash: "0x" + "a".repeat(64), timestamp: 1791676800, rpcUrl: "SECRET" };
  const publicFinance = { status: "confirmed", observedAt: "2026-10-11T00:00:00.000Z", chainId: "10143", agentId: "1999", wallet: "wallet", cashRaw: "58000", debtRaw: "0", scannedTaskCount: 12, ownedTaskCount: 1,
    block, credit: { score: "570", tier: "C", tierCapRaw: "200000", feeBps: "1500", eligible: true, rejection: null, privateKey: "SECRET" },
    counts: { repayments: "1", defaults: "0", mirrorRepayments: "1", successes: "1", mirrorDefaults: "0", token: "SECRET" },
    policy: { maxCashPerTxRaw: "120000", maxDebtPerTxRaw: "120000", maxDebtPerDayRaw: "1000000", ownerFrozen: false, config: "SECRET" }, privateKey: "SECRET" };
  let calls = 0;
  const fetcher = (async (url, options) => {
    calls++; assert.equal(String(url), `${upstreamUrl}/agents/agent-1/finance`); assert.equal(options?.method, "GET"); assert.equal(options?.body, undefined);
    assert.equal(new Headers(options?.headers).get("authorization"), `Bearer ${token}`); return Response.json(publicFinance);
  }) as typeof fetch;
  const response = await hostedAgentsRequest(request("/agents/agent-1/finance"), { ...config, fetcher });
  assert.equal(response.status, 200); const text = await response.text(), result = JSON.parse(text);
  assert.equal(result.credit.score, "570"); assert.equal(result.counts.repayments, "1"); assert.equal(result.block.number, 50);
  assert.doesNotMatch(text, /SECRET|privateKey|rpcUrl|token|config/);
  for (const method of ["POST", "PATCH", "DELETE"]) assert.equal((await hostedAgentsRequest(request("/agents/agent-1/finance", method), { ...config, fetcher })).status, 405);
  assert.equal(calls, 1);
  const hash = "0x" + "b".repeat(64);
  const snapshot = await hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ agents: [], models: [], runs: [{ action: "task", result: {
    phase: "Succeeded", chainId: "10143", acceptTxHash: "0x" + "c".repeat(64), paymentTxHash: "0x" + "d".repeat(64), fromCashRaw: "40000", fromCreditRaw: "80000", refundedRaw: "0",
    settlement: { txHash: hash, block, passed: true, loanStatus: "2", repaidRaw: "92000", slashedRaw: "0", residualRaw: "58000", rawTransaction: "SECRET" } } }] })) as typeof fetch });
  const payload = await snapshot.text(); assert.doesNotMatch(payload, /SECRET|rpcUrl|rawTransaction/); assert.equal(JSON.parse(payload).runs[0].result.settlement.txHash, hash);
});

test("a finance read beyond the former deadline crosses both layers once; ordinary reads keep their shorter deadline", async t => {
  // Scale time by 1000 while retaining actual abort propagation across the
  // browser signal, incoming Request and proxy signal. A 70s finance read must
  // finish, while the same delay on a normal GET must still stop.
  const abortAfter = AbortSignal.timeout.bind(AbortSignal);
  t.mock.method(AbortSignal, "timeout", (milliseconds: number) => abortAfter(Math.ceil(milliseconds / 1000)));
  const upstreamCalls: string[] = [];
  const fetcher = (async (input, init) => {
    const path = new URL(String(input)).pathname; upstreamCalls.push(path);
    return new Promise<Response>((resolve, reject) => {
      const signal = init?.signal;
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", abort);
        resolve(Response.json(path.endsWith("/finance") ? { status: "unavailable", reason: "HOSTED_FINANCE_NOT_BOUND" } : { agents: [], runs: [], models: [] }));
      }, 70);
      const abort = () => { clearTimeout(timer); reject(signal?.reason); };
      signal?.addEventListener("abort", abort, { once: true });
    });
  }) as typeof fetch;
  t.mock.method(globalThis, "fetch", async (input: URL | RequestInfo, init?: RequestInit) => {
    const path = String(input).slice("/api/hosted".length);
    return hostedAgentsRequest(new Request(request(path), { signal: init?.signal }), { ...config, fetcher });
  });
  assert.deepEqual(await hostedRequest("/agents/agent-1/finance"), { status: "unavailable", reason: "HOSTED_FINANCE_NOT_BOUND" });
  await assert.rejects(hostedRequest("/agents"), (error: unknown) => error instanceof HostedClientError && error.code === "HOSTED_UNAVAILABLE");
  assert.deepEqual(upstreamCalls, ["/agents/agent-1/finance", "/agents"]);
});

test("capability projection exposes rates and limits without gateway routes, keys or planner credentials", async () => {
  const response = await hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ agents: [], runs: [], models: [], capabilities: {
    inference: { priceRaw: "120000", creditsRaw: "100000", keyFile: "SECRET", models: [{ id: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2", route: "SECRET", apiKey: "SECRET" }] },
    autonomy: { maxTasks: 2, durationMs: 180000, plannerPriceRaw: "10000", plannerRelayUrl: "SECRET" }, privateKey: "SECRET",
  } })) as typeof fetch });
  assert.equal(response.status, 200); const body = await response.json();
  assert.deepEqual(body.capabilities, { inference: { priceRaw: "120000", creditsRaw: "100000", models: [{ id: "cheap", inputMicroCreditsPerToken: "1", outputMicroCreditsPerToken: "2" }] }, autonomy: { maxTasks: 2, durationMs: 180000, plannerPriceRaw: "10000" } });
  assert.doesNotMatch(JSON.stringify(body), /SECRET|keyFile|route|apiKey|plannerRelayUrl/);
});

test("Next loopback URL normalization preserves exact browser Host and Origin checks", async () => {
  let calls = 0;
  const fetcher = (async (_url, init) => { calls++; assert.equal(new Headers(init?.headers).get("origin"), upstreamUrl); return Response.json({ id: "challenge", message: "message", expiresAt: Date.now() + 10000 }); }) as typeof fetch;
  const unauthenticated = new NextRequest(`${origin}/api/hosted/agents`, { headers: { host: "127.0.0.1:3000" } });
  assert.equal(new URL(unauthenticated.url).hostname, "localhost");
  const missing = await hostedAgentsRequest(unauthenticated, { ...config, fetcher });
  assert.equal(missing.status, 401); assert.deepEqual(await missing.json(), { error: "HOSTED_AUTH_REQUIRED" });
  const login = new NextRequest(`${origin}/api/hosted/auth/challenge`, { method: "POST", headers: { host: "127.0.0.1:3000", origin, "content-type": "application/json" }, body: JSON.stringify({ wallet: "wallet" }) });
  assert.equal((await hostedAgentsRequest(login, { ...config, fetcher })).status, 200); assert.equal(calls, 1);
  for (const [url, headers] of [
    ["http://localhost:3000", { host: "localhost:3000", origin }],
    ["http://localhost:3000", { host: "127.0.0.1:3000", origin: "http://localhost:3000" }],
    ["http://localhost:3001", { host: "127.0.0.1:3000", origin }],
    ["https://localhost:3000", { host: "127.0.0.1:3000", origin }],
    ["http://evil.example:3000", { host: "127.0.0.1:3000", origin }],
    ["http://localhost:3000", { host: "evil.example", origin, "x-forwarded-host": "127.0.0.1:3000" }],
    ["http://localhost:3000", { host: "127.0.0.1:3000", origin, "sec-fetch-site": "cross-site" }],
    ["http://localhost:3000", { origin }],
  ] as [string, Record<string, string>][]) {
    const response = await hostedAgentsRequest(new Request(`${url}/api/hosted/auth/challenge`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify({ wallet: "wallet" }) }), { ...config, fetcher });
    assert.equal(response.status, 403, JSON.stringify({ url, headers }));
  }
  assert.equal(calls, 1);
});

test("explicit TLS proxy permits the fixed public HTTPS origin while rejecting mismatched forwarded authority", async () => {
  const publicOrigin = "https://tempo.tabbyai.xyz";
  const proxyHeaders = { host: "tempo.tabbyai.xyz", origin: publicOrigin, "content-type": "application/json",
    "x-forwarded-host": "tempo.tabbyai.xyz", "x-forwarded-proto": "https", "sec-fetch-site": "same-origin" };
  const proxied = (path = "/auth/challenge", headers: Record<string, string> = proxyHeaders, url = "https://127.0.0.1:3028") =>
    new NextRequest(`${url}/api/hosted${path}`, { method: "POST", headers,
      body: JSON.stringify(path === "/auth/login" ? { challengeId: "challenge", signature: "signature" } : { wallet: "wallet" }) });
  let calls = 0;
  const expiresAt = Date.now() + 3600000;
  const fetcher = (async (url, init) => {
    calls++; assert.equal(new Headers(init?.headers).get("origin"), upstreamUrl);
    return String(url).endsWith("/auth/login") ? Response.json({ token, expiresAt })
      : Response.json({ id: "challenge", message: "message", expiresAt });
  }) as typeof fetch;
  const proxyConfig = { ...config, origin: publicOrigin, trustProxy: true, fetcher };
  assert.equal(new URL(proxied().url).hostname, "localhost");
  assert.equal((await hostedAgentsRequest(proxied(), proxyConfig)).status, 200);
  const login = await hostedAgentsRequest(proxied("/auth/login"), proxyConfig);
  assert.equal(login.status, 200); assert.match(login.headers.get("set-cookie")!, /HttpOnly; SameSite=Strict.*; Secure/);
  const anonymous = new NextRequest("https://127.0.0.1:3028/api/hosted/agents", { headers: proxyHeaders });
  assert.equal((await hostedAgentsRequest(anonymous, proxyConfig)).status, 401);
  assert.equal((await hostedAgentsRequest(proxied(), { ...proxyConfig, trustProxy: false })).status, 403);
  for (const headers of [
    { ...proxyHeaders, "x-forwarded-host": "" },
    { ...proxyHeaders, "x-forwarded-host": "evil.example" },
    { ...proxyHeaders, "x-forwarded-host": "tempo.tabbyai.xyz, evil.example" },
    { ...proxyHeaders, "x-forwarded-proto": "http" },
    { ...proxyHeaders, "x-forwarded-proto": "https, http" },
    { ...proxyHeaders, host: "evil.example" },
    { ...proxyHeaders, origin: "https://evil.example" },
    { ...proxyHeaders, "sec-fetch-site": "cross-site" },
  ]) assert.equal((await hostedAgentsRequest(proxied("/auth/challenge", headers), proxyConfig)).status, 403);
  assert.equal((await hostedAgentsRequest(proxied("/auth/challenge", proxyHeaders, "https://evil.example:3028"), proxyConfig)).status, 403);
  assert.equal((await hostedAgentsRequest(proxied("/auth/challenge", proxyHeaders, "http://127.0.0.1:3028"), proxyConfig)).status, 403);
  const missingOrigin = proxied(); missingOrigin.headers.delete("origin");
  assert.equal((await hostedAgentsRequest(missingOrigin, proxyConfig)).status, 403);
  assert.equal(calls, 2);
});

test("goal snapshots project nested artifacts and cancellation flags without private executor data", async () => {
  const mission = { stage: "completed", phases: [{ name: "Write", taskType: "writer", goal: "Write the plan", output: "A useful plan.", keyFile: "PRIVATE_SENTINEL" }], answer: "A useful plan.",
    review: { passed: true, summary: "Requirements checked", checks: ["Three concrete steps"], modelKey: "PRIVATE_SENTINEL" },
    calls: [{ stage: "phase-0", model: "kimi-k2.6", chargedRaw: "10000", promptTokens: 50, completionTokens: 20, rawTransaction: "PRIVATE_SENTINEL" }], privateKey: "PRIVATE_SENTINEL" };
  const run = { requestId: "run-1", agentId: "agent-1", action: "goal", goal: "帮我完成一个计划", stopRequested: true, mission, result: { mission, chargedRaw: "10000", phase: "Completed", walletKey: "PRIVATE_SENTINEL" } };
  const response = await hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ agents: [{ id: "agent-1", configurationRequired: true }], runs: [run], models: [],
    capabilities: { goals: { maxPhases: 3, models: [{ id: "kimi-k2.6", pricePerCallRaw: "10000", relayUrl: "PRIVATE_SENTINEL" }], provider: "PRIVATE_SENTINEL" } } })) as typeof fetch });
  assert.equal(response.status, 200); const text = await response.text(), body = JSON.parse(text);
  assert.doesNotMatch(text, /PRIVATE_SENTINEL|rawTransaction|privateKey|keyFile|relayUrl|walletKey|modelKey/);
  assert.equal(body.agents[0].configurationRequired, true); assert.equal(body.runs[0].goal, run.goal); assert.equal(body.runs[0].stopRequested, true);
  assert.equal(body.runs[0].mission.phases[0].output, "A useful plan."); assert.equal(body.runs[0].result.mission.review.passed, true);
  assert.deepEqual(body.capabilities.goals, { maxPhases: 3, models: [{ id: "kimi-k2.6", pricePerCallRaw: "10000" }] });
  const cancelled = await hostedAgentsRequest(request("/agents/agent-1/cancel", "POST", { requestId: "run-1" }), { ...config, fetcher: (async (url, init) => {
    assert.equal(String(url), `${upstreamUrl}/agents/agent-1/cancel`); assert.deepEqual(JSON.parse(init!.body as string), { requestId: "run-1" });
    assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${token}`); return Response.json(run, { status: 202 });
  }) as typeof fetch });
  assert.equal(cancelled.status, 202); const cancelledBody = await cancelled.json(); assert.equal(cancelledBody.stopRequested, true); assert.equal(cancelledBody.goal, run.goal);
});

test("goal history larger than one MiB remains readable within the bounded artifact window", async () => {
  const mission = { stage: "completed", phases: [{ name: "draft", taskType: "writer", goal: "Write a report", output: "文".repeat(20000) }], answer: "文".repeat(20000), calls: [] };
  const runs = Array.from({length: 12}, (_, i) => ({requestId: `goal-${i}`, agentId: "agent-1", action: "goal", goal: "Write a report", mission }));
  const response = await hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ agents: [], models: [], runs })) as typeof fetch });
  assert.equal(response.status, 200); assert.equal((await response.json()).runs.length, 12);
});

test("scene activities preserve ordered public facts and reject private or malformed event envelopes", async () => {
  const activity = { seq: 4, at: "2026-10-14T03:00:00.000Z", scene: "specialists", state: "selected", phaseId: "phase-0", subject: { id: "writer", name: "Writing Specialist", kind: "specialist" }, evidence: { candidateIds: ["writer", "analyst"], priceRaw: "10000" } };
  const snapshot = async (activities: unknown) => hostedAgentsRequest(request("/agents"), { ...config, fetcher: (async () => Response.json({ agents: [], models: [], runs: [{ requestId: "scene-run", activities, privateJournal: "PRIVATE_SENTINEL" }] })) as typeof fetch });
  const good = await snapshot([activity, {...activity,seq:5,state:"confirmed"}]);
  assert.equal(good.status,200); const text = await good.text(); assert.doesNotMatch(text,/PRIVATE_SENTINEL|privateJournal/); assert.deepEqual(JSON.parse(text).runs[0].activities.map((event:{seq:number})=>event.seq),[4,5]);
  for (const invalid of [[activity,{...activity,seq:4}],[{...activity,seq:0}],[{...activity,at:"invalid"}],[{...activity,keyFile:"PRIVATE_SENTINEL"}],[{...activity,evidence:{...activity.evidence,providerUrl:"PRIVATE_SENTINEL"}}],Array.from({length:257},(_,i)=>({...activity,seq:i+1}))]) {
    const rejected=await snapshot(invalid);assert.equal(rejected.status,503);assert.deepEqual(await rejected.json(),{error:"HOSTED_UNAVAILABLE"});
  }
});
