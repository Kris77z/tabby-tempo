import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import { connect } from "node:net";
import type { Duplex } from "node:stream";
import { setTimeout as delay } from "node:timers/promises";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FetchRequest, toUtf8Bytes } from "ethers";
import { arenaRequest } from "../lib/arena";
import { fixtureDashboard } from "../lib/fixture";
import { readDashboard } from "../lib/read";
import { createServerRpc, frontendTransport } from "../lib/server-transport";
import { publicConfig, validateDeployment } from "../lib/config";
import type { Deployment } from "../lib/types";
import { chainRpcProvider } from "../../scripts/demo-rpc.js";

async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
}
function localProxy(targetPort: number) {
  const sockets = new Set<Duplex>(); let tunnels = 0;
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const server = createServer();
  server.on("connect", (_request, client, head) => {
    tunnels++; track(client);
    const remote = connect(targetPort, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    });
    track(remote); remote.on("error", () => client.destroy()); client.on("error", () => remote.destroy());
    client.on("close", () => remote.destroy()); remote.on("close", () => client.destroy());
  });
  return { server, sockets, tunnels: () => tunnels, destroy() { for (const socket of sockets) socket.destroy(); } };
}
function restoreFlag(t: { after: (callback: () => void) => void }) {
  const previous = process.env.FRONTEND_RPC_TRANSPORT;
  const previousFile = process.env.FRONTEND_RPC_URL_FILE;
  delete process.env.FRONTEND_RPC_URL_FILE;
  t.after(() => {
    if (previous === undefined) delete process.env.FRONTEND_RPC_TRANSPORT; else process.env.FRONTEND_RPC_TRANSPORT = previous;
    if (previousFile === undefined) delete process.env.FRONTEND_RPC_URL_FILE; else process.env.FRONTEND_RPC_URL_FILE = previousFile;
  });
}

test("Tempo SSR and shared service RPC connections share four read slots and 100ms pacing; explicit call gas stays unchanged", async t => {
  restoreFlag(t); process.env.FRONTEND_RPC_TRANSPORT = "direct";
  const flags = ["AGENTFUEL_RPC_INTERVAL_MS", "AGENTFUEL_RPC_CALL_GAS_LIMIT", "AGENTFUEL_RPC_RETRY_READ_503"] as const;
  const before = flags.map(name => process.env[name]);
  t.after(() => flags.forEach((name, index) => { if (before[index] === undefined) delete process.env[name]; else process.env[name] = before[index]; }));
  process.env.AGENTFUEL_RPC_INTERVAL_MS = "15"; process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT = "1000000";
  process.env.AGENTFUEL_RPC_RETRY_READ_503 = "1";
  let active = 0, peak = 0; const starts: number[] = [], gases: string[] = [];
  const rpc = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body); assert.equal(input.method, "eth_call");
    active++; peak = Math.max(peak, active); starts.push(Date.now()); gases.push(input.params[0].gas);
    try { await delay(180); response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: "0x" })); }
    finally { active--; }
  });
  const url = await listen(rpc), first = await createServerRpc(url, undefined, "42431"), second = await createServerRpc(url, undefined, "42431");
  const shared = await chainRpcProvider(url, "42431", "direct");
  try {
    await Promise.all(Array.from({ length: 24 }, (_, index) => [first, second, shared][index % 3].provider.send("eth_call", [{ to: "0x" + "1".repeat(40), data: "0x", ...(index === 0 ? { gas: "0x5208" } : {}) }, "latest"])));
    assert.ok(peak > 1 && peak <= 4, `physical concurrency across connections: ${peak}`);
    assert.ok(starts.at(-1)! - starts[0] >= 23 * 80, "100ms pacing is shared across SSR and service connections");
    assert.equal(gases.filter(value => value === "0x5208").length, 1);
    assert.equal(gases.filter(value => value === "0xf4240").length, 23);
  } finally { first.close(); second.close(); shared.close(); await close(rpc); }
});

test("server-only RPC file overrides the actual endpoint without changing public configuration or exposing invalid secrets", async t => {
  restoreFlag(t); process.env.FRONTEND_RPC_TRANSPORT = "direct";
  const directory = await mkdtemp(join(tmpdir(), "af-frontend-private-rpc-")), file = join(directory, "rpc-url.txt");
  const sentinel = "FAKE_FRONTEND_RPC_SENTINEL", endpoint = `https://rpc.invalid/v2/${sentinel}`, seen: string[] = [];
  const originalGetUrl = new FetchRequest("https://unused.invalid").getUrlFunc;
  FetchRequest.registerGetUrl(async request => {
    seen.push(request.url); const input = JSON.parse(new TextDecoder().decode(request.body!));
    return { statusCode: 200, statusMessage: "OK", headers: {}, body: toUtf8Bytes(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: "0x279f" })) };
  });
  try {
    await writeFile(file, endpoint, { mode: 0o600 }); process.env.FRONTEND_RPC_URL_FILE = file;
    const deployment = validateDeployment({ ...fixtureDashboard().config!, chainId: "10143", rpcUrl: "https://rpc.ankr.com/monad_testnet",
      deploymentBlock: 42, underwriterUrl: "http://127.0.0.1:8787" });
    const before = JSON.stringify(deployment), connection = await createServerRpc(deployment.rpcUrl);
    try { assert.equal(await connection.provider.send("eth_chainId", []), "0x279f"); }
    finally { connection.close(); }
    assert.ok(seen.length > 0 && seen.every(url => url === endpoint));
    assert.equal(JSON.stringify(deployment), before); assert.equal(JSON.stringify(publicConfig(deployment)).includes(sentinel), false);
    await chmod(file, 0o644); await assert.rejects(createServerRpc(deployment.rpcUrl), /PRIVATE_RPC_URL_FILE_REQUIRED/); await chmod(file, 0o600);
    await writeFile(file, `invalid ${sentinel}`);
    await assert.rejects(createServerRpc(deployment.rpcUrl), (error: any) => {
      assert.equal(error.message, "INVALID_RPC_URL"); assert.equal(String(error).includes(sentinel), false); assert.equal(error.cause, undefined); return true;
    });
    assert.ok(seen.every(url => url === endpoint));
  } finally { FetchRequest.registerGetUrl(originalGetUrl); await rm(directory, { recursive: true, force: true }); }
});

test("frontend server transport is explicit; default direct leaves proxy lookup untouched", async t => {
  restoreFlag(t); delete process.env.FRONTEND_RPC_TRANSPORT;
  assert.deepEqual(frontendTransport(), { transport: "direct", creditTimeoutMs: 12_000, arenaTimeoutMs: 15_000 });
  assert.deepEqual(frontendTransport("system-https-proxy"), { transport: "system-https-proxy", creditTimeoutMs: 120_000, arenaTimeoutMs: 90_000 });
  let lookups = 0;
  const resolveProxy = async () => { lookups++; throw new Error("PROXY_NOT_CONFIGURED"); };
  const direct = await createServerRpc("http://unused.invalid", resolveProxy); direct.close(); assert.equal(lookups, 0);
  process.env.FRONTEND_RPC_TRANSPORT = "system-https-proxy";
  await assert.rejects(createServerRpc("http://unused.invalid", resolveProxy), /PROXY_NOT_CONFIGURED/); assert.equal(lookups, 1);
  for (const invalid of ["", "proxy", "automatic"]) {
    process.env.FRONTEND_RPC_TRANSPORT = invalid;
    await assert.rejects(createServerRpc("http://unused.invalid", resolveProxy), /FRONTEND_RPC_TRANSPORT_INVALID/);
  }
  assert.equal(lookups, 1);
});

test("configured local CONNECT proxy retries one read 503 and rejects the actual wrong chain with cleanup", { timeout: 10_000 }, async t => {
  restoreFlag(t); process.env.FRONTEND_RPC_TRANSPORT = "system-https-proxy";
  let blockCalls = 0, creditCalls = 0;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body); assert.equal(Array.isArray(input), false);
    if (input.method === "eth_blockNumber" && ++blockCalls === 1) { res.writeHead(503); res.end(); return; }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: input.method === "eth_chainId" ? "0x7a69" : "0x1" }));
  });
  await listen(rpc);
  const proxy = localProxy((rpc.address() as { port: number }).port), proxyUrl = await listen(proxy.server);
  const credit = createServer((_req, res) => { creditCalls++; res.writeHead(500); res.end(); }), creditUrl = await listen(credit);
  const createRpc = (url: string) => createServerRpc(url, async () => proxyUrl);
  try {
    const connection = await createRpc("http://local-rpc.invalid");
    try { assert.equal(await connection.provider.send("eth_blockNumber", []), "0x1"); assert.equal(blockCalls, 2); }
    finally { connection.close(); }
    const fixture = fixtureDashboard();
    const config: Deployment = { ...fixture.config!, chainId: "10143", rpcUrl: "http://local-rpc.invalid", deploymentBlock: 0, underwriterUrl: creditUrl };
    await assert.rejects(readDashboard(config, createRpc), /RPC chainId 与部署清单不一致/);
    assert.equal(creditCalls, 0); assert.ok(proxy.tunnels() > 0);
    for (let i = 0; i < 20 && proxy.sockets.size; i++) await delay(20);
    assert.equal(proxy.sockets.size, 0);
  } finally { proxy.destroy(); await Promise.all([close(proxy.server), close(rpc), close(credit)]); }
});

test("slow local credit and Arena exceed direct deadlines but complete with explicit proxy timing", { timeout: 30_000 }, async t => {
  restoreFlag(t);
  const fixture = fixtureDashboard(), zero = "0x0000000000000000000000000000000000000000";
  const credits = fixture.profiles.map(p => ({ ...p.credit, configuration: { ...p.credit.configuration, assetDecimals: "18", settlementAsset: zero } }));
  let completedCredits = 0, codeReads = 0;
  const rpc = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    const input = JSON.parse(body); if (input.method === "eth_getCode") codeReads++;
    const result = input.method === "eth_chainId" ? "0x7a69" : input.method === "eth_getCode" ? "0x" : input.method === "eth_getLogs" ? [] : null;
    res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result }));
  });
  const rpcUrl = await listen(rpc), proxy = localProxy((rpc.address() as { port: number }).port), proxyUrl = await listen(proxy.server);
  const service = createServer(async (req, res) => {
    if (req.url?.startsWith("/agents/")) {
      const id = req.url.split("/")[2];
      // Credit reads are serial. One slow snapshot exercises the per-request deadline
      // without multiplying the 13-second fixture delay across all three agents.
      if (id === fixture.config!.agents[0].id) await delay(13_000);
      if (res.destroyed) return;
      completedCredits++;
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(credits.find(c => c.agentId === id)));
    } else {
      await delay(16_000); if (res.destroyed) return;
      res.writeHead(202, { "content-type": "application/json" }); res.end(JSON.stringify({ runId: "local-delayed-test", status: "running" }));
    }
  });
  const serviceUrl = await listen(service);
  const config: Deployment = { ...fixture.config!, asset: { address: zero, symbol: "MON", decimals: 18 }, rpcUrl, deploymentBlock: 0, underwriterUrl: serviceUrl };
  try {
    process.env.FRONTEND_RPC_TRANSPORT = "direct";
    const directCredit = assert.rejects(readDashboard(config), { name: "TimeoutError" });
    const directArena = assert.rejects(arenaRequest(serviceUrl, "/submissions", { taskId: "local-test" }), { name: "TimeoutError" });
    // readDashboard and createServerRpc capture their configuration before this switch.
    process.env.FRONTEND_RPC_TRANSPORT = "system-https-proxy";
    const proxyCredit = assert.rejects(readDashboard(config, url => createServerRpc(url, async () => proxyUrl)), /部署地址没有合约代码/);
    const proxyArena = arenaRequest<{ runId: string }>(serviceUrl, "/submissions", { taskId: "local-test" }, frontendTransport().arenaTimeoutMs);
    const [, , , result] = await Promise.all([directCredit, directArena, proxyCredit, proxyArena]);
    assert.equal(result.runId, "local-delayed-test"); assert.equal(completedCredits, 3); assert.ok(codeReads > 0);
  } finally { proxy.destroy(); await Promise.all([close(proxy.server), close(rpc), close(service)]); }
});
