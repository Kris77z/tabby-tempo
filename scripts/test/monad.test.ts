import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createServer } from "node:http";
import { connect } from "node:net";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import type { Duplex } from "node:stream";
import { promisify } from "node:util";
import { Contract, FetchRequest, Interface, JsonRpcProvider, keccak256, NonceManager, toUtf8Bytes, Wallet, ZeroHash } from "ethers";
import { DemoJournal } from "../demo-journal.js";
import { backupAndRemoveArenaIpc, prepareArenaIpc } from "../demo-arena-state.js";
import { arenaBindings, checkVerifierKey, monadDeploymentEvidence, monadManifest, needsBeforeLiveCheckpoint, prepareMonadDeployment, runMonadDemo } from "../demo-monad.js";
import { monadProvider, proxyUpstreamFetch, readRpcUrlFile, rpcRequest } from "../demo-rpc.js";
import { ALL_ROLES, combineFunding, enforceFreshDeployment, freshDeploymentReady, FUNDING, MONAD_IDENTITY, MONAD_REPUTATION, MONAD_USDC, monadPreflight, monadRuntimeConfig, parseMonadConfig, SIGNING_ROLES, type Role } from "../demo-monad-config.js";
import { deploy, json, readCreditProfile, reportDemoFailure, ROOT, saveJson, startLocalAnvil, stopChild, syntheticKey, tx } from "../demo-common.js";
import { parseConfig } from "../../services/arena/src/protocol.js";
import { IDENTITY_ABI, REPUTATION_ABI } from "../../packages/erc8004/src/index.js";
import { InferCredit } from "../../packages/sdk/src/index.js";
import { Underwriter } from "../../services/underwriter/src/underwriter.js";
import { Relay } from "../../services/provider-relay/src/relay.js";
import { ArenaController } from "../../services/arena/src/controller.js";
import { ArenaSettler } from "../../services/arena/src/settler.js";

test("Request-local proxy retries up to three opted-in read 503s within its original timeout", { timeout: 15000 }, async () => {
  let mode = "ok", failures = 0, requests = 0, tunnels = 0, received!: () => void;
  const bodies: string[] = [];
  const sockets = new Set<Duplex>();
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    bodies.push(body); requests++; received?.();
    if (mode === "hang-response") return;
    if (mode === "later-hang" && failures === 0) return;
    const status = mode === "throttle" ? 429 : mode === "error" ? 500 : mode === "503" || failures-- > 0 ? 503 : 200;
    res.writeHead(status, { "content-type": "application/json" });
    res.end('{"jsonrpc":"2.0","id":1,"result":"0x279f"}');
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const proxy = createServer();
  proxy.on("connect", (_request, client, head) => {
    tunnels++; track(client);
    if (mode === "hang-connect") { client.once("end", () => client.destroy()); client.resume(); return; }
    const remote = connect((upstream.address() as { port: number }).port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head);
      client.pipe(remote); remote.pipe(client);
    });
    track(remote); remote.on("error", () => client.destroy()); client.on("error", () => remote.destroy());
    client.on("close", () => remote.destroy()); remote.on("close", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const globalGetUrl = new FetchRequest("http://example.invalid").getUrlFunc;
  const request = (timeout = 1000, retryRead503 = false) => {
    const connection = rpcRequest("http://rpc.invalid", proxyUrl, timeout, retryRead503);
    connection.request.body = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
    return connection;
  };
  const closed = async () => { for (let i = 0; sockets.size && i < 50; i++) await delay(10); assert.equal(sockets.size, 0); };
  try {
    const ok = request(); try { assert.equal((await ok.request.send()).bodyJson.result, "0x279f"); } finally { ok.close(); }
    await closed(); assert.equal(requests, 1); assert.equal(tunnels, 1);
    mode = "throttle";
    const throttle = request(); try { assert.equal((await throttle.request.send()).statusCode, 429); } finally { throttle.close(); }
    await closed(); assert.equal(requests, 2); assert.equal(tunnels, 2);
    mode = "hang-connect";
    const timeout = request(80);
    try { await assert.rejects(timeout.request.send(), (error: any) => error.code === "TIMEOUT"); } finally { timeout.close(); }
    await closed(); assert.equal(tunnels, 3); assert.equal(requests, 2);
    mode = "hang-response";
    const cancel = request(), arrived = new Promise<void>(resolve => { received = resolve; });
    try {
      const result = cancel.request.send(); await arrived; cancel.request.cancel();
      await assert.rejects(result, (error: any) => error.code === "CANCELLED");
    } finally { cancel.close(); }
    await closed(); assert.equal(tunnels, 4); assert.equal(requests, 3);
    const count = async (payload: unknown, retry: boolean, expectedStatus: number, expectedRequests: number) => {
      const before = requests;
      const connection = request(3000, retry); connection.request.body = JSON.stringify(payload);
      try { assert.equal((await connection.request.send()).statusCode, expectedStatus); }
      finally { connection.close(); }
      await closed(); assert.equal(requests - before, expectedRequests);
    };
    mode = "ok"; failures = 3;
    const read = { jsonrpc: "2.0", id: 19, method: "eth_call", params: [{ to: "0x" + "11".repeat(20), data: "0x1234" }, "latest"] };
    await count(read, true, 200, 4);
    assert.ok(bodies.slice(-4).every(body => body === bodies.at(-1))); assert.deepEqual(JSON.parse(bodies.at(-1)!), read);
    mode = "503";
    await count(read, true, 503, 4); // Four consecutive 503s exhaust the request-local budget.
    await count(read, false, 503, 1);
    for (const payload of [
      { ...read, method: "eth_sendRawTransaction", params: ["0xdead"] },
      { ...read, method: "eth_newFilter", params: [{}] },
      [read], [read, { ...read, id: 20, method: "eth_sendRawTransaction" }],
    ]) await count(payload, true, 503, 1);
    mode = "throttle"; await count(read, true, 429, 1);
    mode = "error"; await count(read, true, 500, 1);
    // Cancellation during the short delay must prevent the second request.
    mode = "503";
    const duringDelay = request(1000, true), first503 = new Promise<void>(resolve => { received = resolve; }), beforeDelay = requests;
    try {
      const result = duringDelay.request.send(); await first503; await delay(20); duringDelay.request.cancel();
      await assert.rejects(result, (error: any) => error.code === "CANCELLED"); await delay(270);
      assert.equal(requests - beforeDelay, 1);
    } finally { duringDelay.close(); }
    await closed();
    // Cancelling during the final, longer backoff must also prevent its request.
    const lastDelay = request(3000, true), beforeLastDelay = requests;
    const third503 = new Promise<void>(resolve => { received = () => { if (requests === beforeLastDelay + 3) resolve(); }; });
    try {
      const result = lastDelay.request.send(); await third503; await delay(20); lastDelay.request.cancel();
      await assert.rejects(result, (error: any) => error.code === "CANCELLED"); await delay(1050);
      assert.equal(requests - beforeLastDelay, 3);
    } finally { lastDelay.close(); }
    await closed();
    const short = request(80, true), beforeShort = requests;
    try { await assert.rejects(short.request.send(), (error: any) => error.code === "TIMEOUT"); }
    finally { short.close(); }
    await closed(); assert.equal(requests - beforeShort, 1);
    // The fourth attempt still shares the original wall-clock timeout and cancel signal.
    mode = "later-hang"; failures = 3;
    const lastTimeout = request(2000, true), beforeTimeout = requests, started = Date.now();
    try { await assert.rejects(lastTimeout.request.send(), (error: any) => error.code === "TIMEOUT"); }
    finally { lastTimeout.close(); }
    await closed(); assert.equal(requests - beforeTimeout, 4); assert.ok(Date.now() - started < 2200);
    failures = 3;
    const lastCancel = request(3000, true), beforeCancel = requests;
    const lastArrived = new Promise<void>(resolve => { received = () => { if (requests === beforeCancel + 4) resolve(); }; });
    try {
      const result = lastCancel.request.send(); await lastArrived; lastCancel.request.cancel();
      await assert.rejects(result, (error: any) => error.code === "CANCELLED");
    } finally { lastCancel.close(); }
    await closed(); assert.equal(requests - beforeCancel, 4);
    assert.equal(new FetchRequest("http://example.invalid").getUrlFunc, globalGetUrl);
  } finally {
    for (const socket of sockets) socket.destroy();
    upstream.closeAllConnections(); proxy.closeAllConnections();
    await Promise.all([new Promise<void>(resolve => upstream.close(() => resolve())), new Promise<void>(resolve => proxy.close(() => resolve()))]);
  }
});

test("Proxy inference preserves JSON POST, rejects redirects, and cancels without retries or credential errors", { timeout: 10000 }, async () => {
  let mode = "ok", requests = 0, tunnels = 0, leaked = 0, redirectStatus = 302, received!: () => void, connected!: () => void;
  const sockets = new Set<Duplex>(), seen: { method?: string; authorization?: string; body: unknown }[] = [];
  const track = (socket: Duplex) => { sockets.add(socket); socket.once("close", () => sockets.delete(socket)); };
  const trap = createServer((req, res) => { leaked++; req.resume(); res.end("unexpected redirect"); });
  trap.listen(0, "127.0.0.1"); await once(trap, "listening");
  const upstream = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += String(chunk);
    requests++; seen.push({ method: req.method, authorization: req.headers.authorization, body: JSON.parse(body) }); received?.();
    if (mode === "hang-response") return;
    if (mode === "redirect") { res.writeHead(redirectStatus, { location: `http://127.0.0.1:${(trap.address() as { port: number }).port}/leaked` }); res.end(); return; }
    res.writeHead(mode === "throttle" ? 429 : mode === "503" ? 503 : 200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "original model code" } }], usage: { total_tokens: 3 } }));
  });
  upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const proxy = createServer();
  proxy.on("connect", (_request, client, head) => {
    tunnels++; track(client); connected?.();
    if (mode === "hang-connect") { client.once("end", () => client.destroy()); client.resume(); return; }
    const remote = connect((upstream.address() as { port: number }).port, "127.0.0.1", () => {
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n"); if (head.length) remote.write(head); client.pipe(remote); remote.pipe(client);
    });
    track(remote); remote.on("error", () => client.destroy()); client.on("error", () => remote.destroy());
    client.on("close", () => remote.destroy()); remote.on("close", () => client.destroy());
  });
  proxy.listen(0, "127.0.0.1"); await once(proxy, "listening");
  const proxyUrl = `http://127.0.0.1:${(proxy.address() as { port: number }).port}`;
  const transport = proxyUpstreamFetch(proxyUrl, 1000), globalFetch = fetch;
  const globalGetUrl = new FetchRequest("http://example.invalid").getUrlFunc;
  const input = { model: "synthetic-model", messages: [{ role: "user", content: "Return code." }], temperature: 1, max_tokens: 2048, stream: false };
  const init = { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer synthetic-test-only" }, body: JSON.stringify(input) };
  const call = (adapter = transport, signal?: AbortSignal, overrideBody?: string) => adapter.fetch("http://upstream.invalid/v1/chat/completions", { ...init, body: overrideBody ?? init.body, signal });
  const closed = async () => { for (let i = 0; sockets.size && i < 50; i++) await delay(10); assert.equal(sockets.size, 0); };
  const fails = (code: string) => (error: any) => {
    assert.equal(error.code, code); assert.ok(!String(error).includes("synthetic-test-only"));
    assert.equal(error.request, undefined); assert.equal(error.cause, undefined); return true;
  };
  try {
    const response = await call(); assert.equal(response.status, 200);
    assert.equal((await response.json()).choices[0].message.content, "original model code");
    assert.deepEqual(seen[0], { method: "POST", authorization: init.headers.authorization, body: input });
    await closed(); assert.equal(requests, 1);
    mode = "redirect";
    for (const status of [301, 302, 303, 307, 308]) {
      redirectStatus = status; const before: number = requests;
      await assert.rejects(call(), fails("REDIRECT_REJECTED")); await closed(); assert.equal(requests - before, 1);
    }
    assert.equal(leaked, 0);
    mode = "throttle"; let before = requests;
    assert.equal((await call()).status, 429); await closed(); assert.equal(requests - before, 1);
    mode = "503"; before = requests;
    // Even RPC-shaped JSON cannot opt a paid inference request into retries.
    assert.equal((await call(transport, undefined, JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] }))).status, 503);
    await closed(); assert.equal(requests - before, 1);
    const preCancelled = new AbortController(); preCancelled.abort(); const beforeTunnel = tunnels;
    await assert.rejects(call(transport, preCancelled.signal), fails("CANCELLED")); assert.equal(tunnels, beforeTunnel);
    mode = "hang-connect";
    const abort = new AbortController(), tunnel = new Promise<void>(resolve => { connected = resolve; });
    const pending = call(transport, abort.signal); await tunnel; abort.abort(); await assert.rejects(pending, fails("CANCELLED")); await closed();
    mode = "hang-response";
    const short = proxyUpstreamFetch(proxyUrl, 80); before = requests;
    try { await assert.rejects(call(short), fails("TIMEOUT")); }
    finally { short.close(); }
    await closed(); assert.equal(requests - before, 1);
    const closing = proxyUpstreamFetch(proxyUrl, 1000), arrived = new Promise<void>(resolve => { received = resolve; });
    const closingRequest = call(closing); await arrived; closing.close();
    await assert.rejects(closingRequest, fails("CANCELLED")); await closed();
    await assert.rejects(call(closing), fails("CANCELLED"));
    assert.equal(fetch, globalFetch); assert.equal(new FetchRequest("http://example.invalid").getUrlFunc, globalGetUrl);
  } finally {
    transport.close(); for (const socket of sockets) socket.destroy();
    for (const server of [upstream, proxy, trap]) server.closeAllConnections();
    await Promise.all([upstream, proxy, trap].map(server => new Promise<void>(resolve => server.close(() => resolve()))));
  }
});

function configuration(directory: string) {
  const keys = { deployer: 1, guardian: 1, treasury: 1, poster: 1, provider: 15, refunder: 1, rotatedOwner: 1,
    underwriter: 2, verifier: 3, hero: 11, veteran: 12, defaulted: 13, rotatedWallet: 15 } as Record<Role, number>;
  return { version: 1, chainId: "10143", rpcUrl: "https://testnet-rpc.monad.xyz", explorerUrl: "https://testnet.monadexplorer.com",
    asset: { address: MONAD_USDC, symbol: "USDC", decimals: 6 }, registries: { identity: MONAD_IDENTITY, reputation: MONAD_REPUTATION },
    roles: Object.fromEntries(ALL_ROLES.map(role => [role, new Wallet(syntheticKey(keys[role])).address])),
    keyFiles: Object.fromEntries(SIGNING_ROLES.map(role => [role, join(directory, `${keys[role]}.key`)])),
    upstream: { name: "kimi", baseUrl: "https://api.moonshot.ai/v1", model: "kimi-k2.5", apiKeyFile: join(directory, "kimi.key"), requestOptions: { max_tokens: 1024 } },
    blockedProvider: new Wallet(syntheticKey(99)).address };
}

test("Explicit Monad RPC override changes only the endpoint and retains the original configuration hash", async () => {
  const original = parseMonadConfig({ ...configuration("/tmp/nonexistent-demo-key-fixture"), rpcUrl: "https://rpc.ankr.com/monad_testnet" });
  const before = json(original), expectedHash = keccak256(toUtf8Bytes(before));
  const unchanged = monadRuntimeConfig(original);
  assert.equal(unchanged.config, original); assert.equal(unchanged.configHash, expectedHash);
  const runtime = monadRuntimeConfig(original, "https://testnet-rpc.monad.xyz/");
  assert.equal(runtime.config.rpcUrl, "https://testnet-rpc.monad.xyz");
  assert.deepEqual({ ...runtime.config, rpcUrl: original.rpcUrl }, original);
  assert.equal(json(original), before); assert.equal(runtime.configHash, expectedHash);
  assert.notEqual(runtime.configHash, keccak256(toUtf8Bytes(json(runtime.config))));
  // Even with the same runtime endpoint, the original endpoint and every
  // non-transport field remain part of the persisted resume binding.
  assert.notEqual(monadRuntimeConfig(runtime.config, runtime.config.rpcUrl).configHash, expectedHash);
  const altered = parseMonadConfig({ ...original, roles: { ...original.roles, hero: new Wallet(syntheticKey(31)).address } });
  assert.notEqual(monadRuntimeConfig(altered, runtime.config.rpcUrl).configHash, expectedHash);
  for (const url of ["http://127.0.0.1:8545", "ws://rpc.invalid", "https://user:password@rpc.invalid", "https://rpc.invalid?token=synthetic", "https://rpc.invalid#fragment"]) {
    assert.throws(() => monadRuntimeConfig(original, url), /INVALID_RPC_URL/);
  }
  await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", join(ROOT, "scripts/demo.ts"), "--mode", "local", "--rpc-url", runtime.config.rpcUrl],
    { cwd: ROOT, env: { PATH: process.env.PATH }, timeout: 10000, maxBuffer: 2048 }), (error: any) => {
    assert.equal(error.code, 1); assert.equal(error.stdout, ""); assert.equal(error.stderr.trim(), "MONAD_FLAGS_REQUIRE_MONAD_MODE"); return true;
  });
});

test("Private RPC file keeps its sentinel out of public artifacts and CLI errors without changing resume binding", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-private-rpc-")), file = join(directory, "rpc-url.txt");
  const sentinel = "FAKE_RPC_SECRET_SENTINEL", endpoint = `https://rpc.invalid/v2/${sentinel}`;
  try {
    const original = parseMonadConfig({ ...configuration(directory), rpcUrl: "https://rpc.ankr.com/monad_testnet" });
    await writeFile(file, endpoint + "\n", { mode: 0o600 });
    assert.equal(await readRpcUrlFile(file), endpoint);
    const runtime = monadRuntimeConfig(original, await readRpcUrlFile(file), true);
    assert.equal(runtime.config.rpcUrl, endpoint); assert.equal(runtime.publicRpcUrl, original.rpcUrl);
    assert.equal(runtime.configHash, monadRuntimeConfig(original).configHash); assert.equal(original.rpcUrl, "https://rpc.ankr.com/monad_testnet");
    assert.equal(monadRuntimeConfig(original, "https://monad-testnet.drpc.org").publicRpcUrl, "https://monad-testnet.drpc.org");
    const addresses = Object.fromEntries(["manager", "adapter", "account", "escrow"].map((name, i) => [name, new Wallet(syntheticKey(31 + i)).address])) as NonNullable<typeof original.contracts>;
    const manifest = monadManifest(runtime.config, runtime.publicRpcUrl, 42, addresses, { hero: "0", veteran: "2", defaulted: "3" },
      { underwriterUrl: "http://127.0.0.1:8787", relayUrl: "http://127.0.0.1:8788", arenaUrl: "http://127.0.0.1:8789" });
    const deployment = monadDeploymentEvidence(runtime.config, addresses, {}, "system-https-proxy");
    const token = new Interface(["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)"]);
    const identity = new Interface(IDENTITY_ABI), reputation = new Interface(REPUTATION_ABI);
    const provider = { send: async () => "0x279f", getCode: async () => "0x01", getBalance: async () => 0n,
      getFeeData: async () => ({ maxFeePerGas: 1n }), getBlock: async () => ({ number: 42, hash: ZeroHash, timestamp: 1 }),
      call: async ({ data }: { data: string }) => {
        if (data.startsWith(token.getFunction("decimals")!.selector)) return token.encodeFunctionResult("decimals", [6]);
        if (data.startsWith(token.getFunction("balanceOf")!.selector)) return token.encodeFunctionResult("balanceOf", [0]);
        if (data.startsWith(identity.getFunction("eip712Domain")!.selector)) return identity.encodeFunctionResult("eip712Domain", ["0x0f", "ERC8004IdentityRegistry", "1", 10143, MONAD_IDENTITY, ZeroHash, []]);
        if (data.startsWith(reputation.getFunction("getIdentityRegistry")!.selector)) return reputation.encodeFunctionResult("getIdentityRegistry", [MONAD_IDENTITY]);
        throw new Error("UNEXPECTED_PREFLIGHT_CALL");
      } } as unknown as JsonRpcProvider;
    const report = await monadPreflight(runtime.config, provider);
    assert.equal(report.rpcOrigin, "https://rpc.invalid"); assert.equal(deployment.rpcOrigin, report.rpcOrigin);
    for (const value of [manifest, deployment, report]) assert.equal(json(value).includes(sentinel), false);
    await saveJson(join(directory, "manifest.json"), manifest);
    assert.equal((await readFile(join(directory, "manifest.json"), "utf8")).includes(sentinel), false);
    const arena = parseConfig({ rpcUrl: runtime.config.rpcUrl, chainId: "10143", escrowAddress: addresses.escrow,
      ipcDirectory: join(directory, "ipc"), tasks: { "1": { agentId: "0", problemId: "sum-integers" } } });
    const arenaFile = join(directory, "arena.json"); await saveJson(arenaFile, arena);
    assert.equal((await stat(arenaFile)).mode & 0o777, 0o600);
    assert.equal(JSON.parse(await readFile(arenaFile, "utf8")).rpcUrl, endpoint); // Independent settler reads this private file.
    await chmod(file, 0o644); await assert.rejects(readRpcUrlFile(file), /PRIVATE_RPC_URL_FILE_REQUIRED/); await chmod(file, 0o600);
    await assert.rejects(readRpcUrlFile("relative.txt"), /ABSOLUTE_RPC_URL_FILE_REQUIRED/);
    await assert.rejects(readRpcUrlFile(join(directory, "missing")), /PRIVATE_RPC_URL_FILE_REQUIRED/);
    await assert.rejects(readRpcUrlFile(directory), /PRIVATE_RPC_URL_FILE_REQUIRED/);
    for (const invalid of [`http://rpc.invalid/${sentinel}`, `https://rpc.invalid?key=${sentinel}`, `https://user:${sentinel}@rpc.invalid`, `invalid ${sentinel}`]) {
      await writeFile(file, invalid); await assert.rejects(readRpcUrlFile(file), (error: any) => {
        assert.equal(error.message, "INVALID_RPC_URL"); assert.equal(String(error).includes(sentinel), false); assert.equal(error.cause, undefined); return true;
      });
    }
    await writeFile(file, endpoint);
    const configFile = join(directory, "config.json"); await saveJson(configFile, original);
    const cli = async (args: string[], expected: string, extraImports: string[] = []) => {
      await assert.rejects(promisify(execFile)(process.execPath, ["--import", "tsx", ...extraImports, join(ROOT, "scripts/demo.ts"), ...args],
        { cwd: ROOT, env: { PATH: process.env.PATH }, timeout: 10000, maxBuffer: 2048 }), (error: any) => {
        assert.equal(error.code, 1); assert.equal(error.stdout, ""); assert.equal(error.stderr.trim(), expected);
        assert.equal(`${error.stdout}${error.stderr}`.includes(sentinel), false); return true;
      });
    };
    await cli(["--mode", "local", "--rpc-url-file", file], "MONAD_FLAGS_REQUIRE_MONAD_MODE");
    await cli(["--mode", "monad", "--rpc-url", original.rpcUrl, "--rpc-url-file", file], "RPC_URL_OPTIONS_MUTUALLY_EXCLUSIVE");
    await assert.rejects(runMonadDemo(original, { output: directory, rpcUrl: original.rpcUrl, rpcUrlFile: file }), /RPC_URL_OPTIONS_MUTUALLY_EXCLUSIVE/);
    // This child consumes the valid file via the actual CLI, with its network intercepted before any request.
    const hook = join(directory, "offline-hook.mjs");
    await writeFile(hook, `import {FetchRequest,toUtf8Bytes} from ${JSON.stringify(join(ROOT, "node_modules/ethers/lib.esm/index.js"))};
      FetchRequest.registerGetUrl(async req=>{if(!req.url.endsWith('/v2/${sentinel}'))throw new Error('WRONG_PRIVATE_RPC');
        const input=JSON.parse(new TextDecoder().decode(req.body));return {statusCode:200,statusMessage:'OK',headers:{},body:toUtf8Bytes(JSON.stringify({jsonrpc:'2.0',id:input.id,result:'0x7a69'}))};});`);
    await cli(["--mode", "monad", "--config", configFile, "--rpc-url-file", file], "NETWORK_MISMATCH", ["--import", hook]);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("SDK, Underwriter, Relay, controller and independent settler consume the private effective endpoint and still reject the wrong chain", async t => {
  const directory = await mkdtemp(join(tmpdir(), "af-private-rpc-routing-"));
  const endpoint = "https://rpc.invalid/v2/FAKE_RPC_ROUTING_SENTINEL", seen: string[] = [];
  const originalGetUrl = new FetchRequest("https://unused.invalid").getUrlFunc;
  // Restore the process-wide transport even if fixture construction itself throws.
  t.after(async () => { FetchRequest.registerGetUrl(originalGetUrl); await rm(directory, { recursive: true, force: true }); });
  FetchRequest.registerGetUrl(async request => {
    seen.push(request.url); const input = JSON.parse(new TextDecoder().decode(request.body!));
    const calls = Array.isArray(input) ? input : [input];
    const results = calls.map(call => { assert.equal(call.method, "eth_chainId"); return { jsonrpc: "2.0", id: call.id, result: "0x7a69" }; });
    return { statusCode: 200, statusMessage: "OK", headers: {}, body: toUtf8Bytes(JSON.stringify(Array.isArray(input) ? results : results[0])) };
  });
  const connection = await monadProvider(endpoint, "direct"), provider = connection.provider;
  const config = monadRuntimeConfig(parseMonadConfig(configuration(directory)), endpoint, true).config;
  const address = new Wallet(syntheticKey(31)).address;
  const arenaConfig = parseConfig({ rpcUrl: config.rpcUrl, chainId: "10143", escrowAddress: address, ipcDirectory: join(directory, "ipc"), tasks: { "1": { agentId: "0", problemId: "sum-integers" } } });
  const underwriter = new Underwriter({ rpcUrl: config.rpcUrl, chainId: 10143n, managerAddress: address, settlementAsset: MONAD_USDC,
    assetDecimals: 6, tokenUsdPrice: 10n ** 18n, privateKey: syntheticKey(2), evidenceDir: directory, host: "127.0.0.1", port: 8787 }, provider);
  const relay = new Relay({ rpcUrl: config.rpcUrl, chainId: 10143n, account: address, asset: MONAD_USDC, assetDecimals: 6, payTo: config.roles.provider,
    service: { id: "infercredit/coder", model: "coder", price: 120000n, upstreams: [{ name: "controlled", model: "controlled", baseUrl: "https://model.invalid/v1", key: "synthetic-test-key" }] }, dataDir: directory,
    quoteTtl: 300, confirmations: 1, logScanChunkBlocks: 100, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788 }, { provider });
  const controller = new ArenaController(arenaConfig, {}, provider), settler = new ArenaSettler(arenaConfig, syntheticKey(3));
  const sdk = new InferCredit({ agentId: "0", signer: new Wallet(syntheticKey(11), provider), chainId: 10143n, account: address,
    asset: MONAD_USDC, provider: config.roles.provider, maxPrice: 120000n });
  try {
    await assert.rejects(underwriter.initialize(), (error: any) => error.code === "NETWORK_MISMATCH");
    await assert.rejects(relay.initialize(), (error: any) => error.code === "NETWORK_MISMATCH");
    await assert.rejects(controller.submit({ taskId: "1", code: "print(0)" }), /NETWORK_MISMATCH/);
    await assert.rejects(settler.start(), /NETWORK_MISMATCH/);
    await assert.rejects(sdk.fetch("http://127.0.0.1:1/v1/chat", { body: { service: "infercredit/coder", model: "coder", messages: [] } }), (error: any) => error.code === "NETWORK_MISMATCH");
    assert.ok(seen.length >= 5); assert.ok(seen.every(url => url === endpoint));
  } finally {
    sdk.close(); controller.close(); relay.close(); underwriter.close(); await settler.close();
    connection.close(); FetchRequest.registerGetUrl(originalGetUrl); await rm(directory, { recursive: true, force: true });
  }
});

test("Shared management roles merge funding; isolated signer/agent domains remain mandatory", () => {
  const config = parseMonadConfig(configuration("/tmp/nonexistent-demo-key-fixture"));
  assert.equal(config.roles.deployer, config.roles.poster); assert.equal(config.keyFiles.deployer, config.keyFiles.guardian);
  const roles = ALL_ROLES.map(role => ({ role, address: config.roles[role], native: 100n, usdc: 10000000n,
    nativeRequired: FUNDING[role].gasUnits, usdcRequired: FUNDING[role].usdc }));
  const combined = combineFunding(roles);
  const management = combined.find(wallet => wallet.address === config.roles.deployer)!;
  assert.equal(management.usdcRequired, 11200000n); assert.equal(management.nativeRequired, 23600000n);
  assert.equal(management.fundedForFreshRun, false); // Individually treasury/poster look sufficient, aggregate does not.
  const value = configuration("/tmp/nonexistent-demo-key-fixture");
  const unsafe = { ...value, roles: { ...value.roles, underwriter: value.roles.deployer } };
  assert.throws(() => parseMonadConfig(unsafe), /SIGNER_AND_AGENT_ISOLATION_REQUIRED/);
  assert.throws(() => parseMonadConfig({ ...value, roles: { ...value.roles, provider: value.roles.poster } }), /PROVIDER_POSTER_MUST_DIFFER/);
  assert.throws(() => parseMonadConfig({ ...value, keyFiles: { ...value.keyFiles, verifier: value.keyFiles.deployer } }), /VERIFIER_KEY_FILE_MUST_BE_EXCLUSIVE/);
  assert.throws(() => parseMonadConfig({ ...value, registries: { ...value.registries, identity: value.roles.hero } }), /VERIFIED_MONAD_CANONICAL_REGISTRIES_REQUIRED/);
  assert.throws(() => parseMonadConfig({ ...value, upstream: { ...value.upstream, baseUrl: "http://127.0.0.1:9999/v1" } }), /INVALID_KIMI_BASE_URL/);
});

test("Restart after third task creation/settlement does not impose the earlier 640 checkpoint", () => {
  assert.equal(needsBeforeLiveCheckpoint({ "hero-2": { id: "7" } }), true);
  for (const id of ["", "8"]) {
    assert.equal(needsBeforeLiveCheckpoint({ "hero-3": { id } }), false);
    const tasks = arenaBindings({ "hero-2": { id: "7", agentId: "0" }, "hero-3": { id, agentId: "0" } });
    assert.equal(Object.hasOwn(tasks, ""), false);
    parseConfig({ rpcUrl: "http://127.0.0.1:8545", chainId: "10143", escrowAddress: new Wallet(syntheticKey(1)).address, ipcDirectory: "/tmp/ar-test", tasks });
    assert.equal(Object.hasOwn(tasks, "8"), id === "8");
  }
});

test("IPC journal survives backup failure and recovery interruption, and a live signer is never deleted", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-monad-ipc-test-"));
  const backup = join(directory, "backup.json"), journal = join(directory, "settlements.json");
  const record = { "8": { verdict: { taskId: "8", passed: true }, rawTx: "0x01", txHash: keccak256("0x01") } };
  try {
    await saveJson(journal, record);
    await assert.rejects(backupAndRemoveArenaIpc(directory, backup, async () => { throw new Error("INJECTED_BACKUP_FAILURE"); }), /INJECTED_BACKUP_FAILURE/);
    assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), record);
    await prepareArenaIpc(directory, backup); // Simulated interruption immediately after preparation.
    assert.deepEqual(JSON.parse(await readFile(journal, "utf8")), record);
    await writeFile(join(directory, "settler.owner"), String(process.pid), { mode: 0o600 });
    await assert.rejects(prepareArenaIpc(directory, backup), /SETTLER_IS_RUNNING/);
    assert.equal((await stat(journal)).isFile(), true);
    await rm(join(directory, "settler.owner"));
    const externalBackup = join(tmpdir(), `af-monad-backup-${process.pid}-${Date.now()}.json`);
    try { await backupAndRemoveArenaIpc(directory, externalBackup); assert.deepEqual(JSON.parse(await readFile(externalBackup, "utf8")), record); }
    finally { await rm(externalBackup, { force: true }); }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Verifier key is checked only by the independent child before any transaction", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-monad-verifier-test-"));
  const file = join(directory, "verifier.key"), key = syntheticKey(3);
  try {
    await writeFile(file, key, { mode: 0o600 });
    await checkVerifierKey(file, new Wallet(key).address);
    await assert.rejects(checkVerifierKey(file, new Wallet(syntheticKey(4)).address), /VERIFIER_KEY_CHECK_FAILED_BEFORE_TRANSACTIONS/);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Credit profile HTTP failures preserve their status at the CLI boundary without retaining secrets", async t => {
  const secret = "synthetic-credential-do-not-retain", url = `https://underwriter.invalid/${secret}`, id = `agent-${secret}`;
  let response!: Response;
  const request = t.mock.method(globalThis, "fetch", async () => response);
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => { lines.push(line); });
  for (const status of [400, 429, 500, 503]) {
    response = new Response(secret, { status, statusText: secret, headers: { "x-secret": secret } });
    const before = request.mock.callCount();
    let failure: any;
    await assert.rejects(readCreditProfile(url, id), (error: any) => {
      failure = error;
      assert.equal(error.message, "PROFILE_READ_FAILED");
      assert.deepEqual(error.diagnostic, { httpStatus: status });
      assert.deepEqual(Object.keys(error), ["diagnostic"]);
      for (const field of ["cause", "request", "body", "response", "url", "key"]) assert.equal(error[field], undefined);
      for (const serialized of [JSON.stringify(error), String(error), error.stack]) assert.ok(!serialized.includes(secret));
      return true;
    });
    assert.equal(request.mock.callCount() - before, 1);
    assert.equal(request.mock.calls.at(-1)!.arguments[0], `${url}/agents/${id}/credit`);
    assert.equal(response.bodyUsed, false);
    reportDemoFailure(failure);
    assert.deepEqual(lines.splice(0), ["PROFILE_READ_FAILED", JSON.stringify({ diagnostic: { httpStatus: status } })]);
  }
});

test("Credit profile success preserves JSON and makes one request", async t => {
  const expected = { agentId: "1977", terms: { score: "710", tier: "A" }, context: ["original", 17] };
  let status = 200;
  const request = t.mock.method(globalThis, "fetch", async () => new Response(JSON.stringify(expected), { status }));
  for (status of [200, 201]) {
    const before = request.mock.callCount();
    assert.deepEqual(await readCreditProfile("http://underwriter.invalid", "1977"), expected);
    assert.equal(request.mock.callCount() - before, 1);
    assert.deepEqual(request.mock.calls.at(-1)!.arguments, ["http://underwriter.invalid/agents/1977/credit"]);
  }
});

test("Demo CLI failure output revalidates diagnostics and never invents HTTP status", t => {
  const secret = "https://credential.invalid/private-api-key", lines: string[] = [];
  t.mock.method(console, "error", (line: string) => { lines.push(line); });
  reportDemoFailure(Object.assign(new Error("PROFILE_READ_FAILED"), {
    diagnostic: { httpStatus: 503, ethersCode: "SERVER_ERROR", rpcCode: -32000, url: secret, body: secret, key: secret },
    cause: new Error(secret), request: { body: secret }, response: { body: secret },
  }));
  assert.deepEqual(lines.splice(0), ["PROFILE_READ_FAILED", JSON.stringify({ diagnostic: { ethersCode: "SERVER_ERROR", rpcCode: -32000, httpStatus: 503 } })]);
  reportDemoFailure(Object.assign(new Error(secret), {
    code: "NETWORK_ERROR", diagnostic: { httpStatus: "503", ethersCode: secret, rpcCode: -2147483649, body: secret }, cause: new Error(secret),
  }));
  assert.deepEqual(lines.splice(0), ["DEMO_FAILED_SEE_SAVED_EVIDENCE", JSON.stringify({ diagnostic: { ethersCode: "NETWORK_ERROR" } })]);
  for (const httpStatus of [undefined, 99, 600, NaN]) {
    reportDemoFailure(Object.assign(new Error("PROFILE_READ_FAILED"), { diagnostic: { httpStatus, body: secret } }));
    assert.deepEqual(lines.splice(0), ["PROFILE_READ_FAILED"]);
  }
});

test("Journal failures retain only whitelisted diagnostics and never the original secret or signed bytes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-journal-diagnostic-test-"));
  const wallet = new Wallet(syntheticKey(23));
  const raw = await wallet.signTransaction({ chainId: 31337, type: 2, nonce: 0, to: new Wallet(syntheticKey(24)).address,
    value: 1n, gasLimit: 21000n, maxFeePerGas: 2n, maxPriorityFeePerGas: 1n });
  const secret = "synthetic-credential-do-not-retain", path = join(directory, "transactions.json");
  const record = { one: { from: wallet.address, txHash: keccak256(raw), rawTransaction: raw } };
  let lookups = 0, broadcasts = 0, lookupFailure = "none";
  let failure: unknown = Object.assign(new Error(`${secret} ${raw}`), { code: "UNKNOWN_ERROR", error: { code: -32000, message: secret },
    response: { statusCode: 503, body: secret }, request: { body: raw, headers: { authorization: secret } }, cause: new Error(secret) });
  const queryError = Object.assign(new Error(`${secret} ${raw}`), { code: "SERVER_ERROR", info: { error: { code: -32005 }, response: { statusCode: 502 } }, request: { body: raw }, cause: failure });
  const provider = {
    getTransaction: async () => { lookups++; if (lookupFailure === "first" || (lookupFailure === "after" && lookups > 1)) throw queryError; return null; },
    getTransactionReceipt: async () => null,
    broadcastTransaction: async (value: string) => { broadcasts++; assert.equal(value, raw); throw failure; },
    waitForTransaction: async () => { throw new Error("UNEXPECTED_WAIT"); },
  } as unknown as JsonRpcProvider;
  const safe = (expected: object) => (error: any) => {
    assert.equal(error.message, "RECORDED_TRANSACTION_UNCONFIRMED_USE_SAME_OUTPUT");
    assert.deepEqual(error.diagnostic, expected);
    assert.deepEqual(Object.keys(error), ["diagnostic"]);
    for (const field of ["cause", "request", "body", "response", "error", "info", "rawTransaction"]) assert.equal(error[field], undefined);
    for (const serialized of [JSON.stringify(error), String(error), error.stack]) {
      assert.ok(!serialized.includes(secret)); assert.ok(!serialized.includes(raw));
    }
    return true;
  };
  try {
    await saveJson(path, record);
    const journal = new DemoJournal(provider, path); await journal.load();
    for (const call of [() => journal.send("one", wallet, {}), () => journal.receipt("one")]) {
      lookups = broadcasts = 0; lookupFailure = "none";
      await assert.rejects(call(), safe({ ethersCode: "UNKNOWN_ERROR", rpcCode: -32000, httpStatus: 503 }));
      assert.equal(broadcasts, 1); assert.equal(lookups, 2);
      // If post-broadcast observation fails, retain the broadcast diagnostic;
      // the second error must not replace it or escape with its raw payload.
      lookups = broadcasts = 0; lookupFailure = "after";
      await assert.rejects(call(), safe({ ethersCode: "UNKNOWN_ERROR", rpcCode: -32000, httpStatus: 503 }));
      assert.equal(broadcasts, 1); assert.equal(lookups, 2);
      lookups = broadcasts = 0; lookupFailure = "first";
      await assert.rejects(call(), safe({ ethersCode: "SERVER_ERROR", rpcCode: -32005, httpStatus: 502 }));
      assert.equal(broadcasts, 0); assert.equal(lookups, 1);
    }
    failure = Object.assign(new Error(secret), { code: secret, error: { code: "-32000" }, response: { statusCode: "503" }, cause: queryError });
    lookups = broadcasts = 0; lookupFailure = "none";
    await assert.rejects(journal.receipt("one"), safe({}));
    assert.equal(broadcasts, 1); assert.deepEqual(JSON.parse(await readFile(path, "utf8")), record);
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test("Wrong-chain preflight signs nothing; journal restart rebroadcasts one original real Anvil transaction", { timeout: 30000 }, async () => {
  const local = await startLocalAnvil(), directory = await mkdtemp(join(tmpdir(), "af-monad-journal-test-"));
  const provider = new JsonRpcProvider(local.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  try {
    const original = parseMonadConfig({ ...configuration(directory), rpcUrl: "https://rpc.ankr.com/monad_testnet" });
    const { config, configHash } = monadRuntimeConfig(original, "https://testnet-rpc.monad.xyz");
    assert.equal(configHash, monadRuntimeConfig(original).configHash);
    await assert.rejects(monadPreflight(config, provider), /NETWORK_MISMATCH/); // Missing secret files are never read.
    const wallet = new Wallet(syntheticKey(21), provider), payee = new Wallet(syntheticKey(22));
    await provider.send("anvil_setBalance", [wallet.address, "0xde0b6b3a7640000"]);
    const journalPath = join(directory, "transactions.json");
    const journal = new DemoJournal(provider, journalPath); await journal.load();
    const broadcast = provider.broadcastTransaction.bind(provider);
    provider.broadcastTransaction = async () => { throw new Error("INJECTED_CRASH_BEFORE_BROADCAST"); };
    await assert.rejects(journal.send("one-payment", wallet, { to: payee.address, value: 1n }), /RECORDED_TRANSACTION_UNCONFIRMED_USE_SAME_OUTPUT/);
    const saved = JSON.parse(await readFile(journalPath, "utf8"));
    assert.equal(keccak256(saved["one-payment"].rawTransaction), saved["one-payment"].txHash);
    assert.equal(await provider.getTransactionCount(wallet.address), 0); assert.equal(await provider.getBalance(payee.address), 0n);
    provider.broadcastTransaction = broadcast;
    const restored = new DemoJournal(provider, journalPath); await restored.load();
    const first = await restored.send("one-payment", wallet, { to: payee.address, value: 1n });
    assert.equal(first.hash, saved["one-payment"].txHash); await restored.receipt("one-payment");
    const replay = await restored.send("one-payment", wallet, { to: payee.address, value: 1n });
    assert.equal(replay.hash, first.hash); assert.equal(await provider.getTransactionCount(wallet.address), 1);
    assert.equal(await provider.getBalance(payee.address), 1n);
  } finally { provider.destroy(); await stopChild(local.child); await rm(directory, { recursive: true, force: true }); }
});

test("Fresh existing deployments must be empty; resumed own business is allowed", { timeout: 30000 }, async () => {
  const local = await startLocalAnvil();
  const provider = new JsonRpcProvider(local.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  try {
    const wallet = new Wallet(syntheticKey(41), provider), signer = new NonceManager(wallet);
    await provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
    const identity = await deploy("MockIdentityRegistry", signer, provider);
    const reputation = await deploy("MockReputationRegistry", signer, provider, [await identity.getAddress()]);
    const token = await deploy("MockERC20", signer, provider, ["Test USDC", "USDC", 6]);
    const adapter = await deploy("ERC8004Adapter", signer, provider, [await identity.getAddress(), await reputation.getAddress(), wallet.address]);
    const manager = await deploy("CreditManager", signer, provider, [{ settlementAsset: await token.getAddress(), adapter: await adapter.getAddress(), underwriter: wallet.address,
      treasury: wallet.address, guardian: wallet.address, relayRefunder: wallet.address, owner: wallet.address, maxLtvBps: 8000, grace: 3600 }]);
    const account = await deploy("AgentAccount", signer, provider, [await token.getAddress(), await adapter.getAddress(), wallet.address]);
    const escrow = await deploy("TaskEscrow", signer, provider, [await token.getAddress(), await adapter.getAddress(), wallet.address, wallet.address, 0, wallet.address]);
    const addresses = { manager: await manager.getAddress(), adapter: await adapter.getAddress(), account: await account.getAddress(), escrow: await escrow.getAddress() };
    const contracts = { manager, adapter, account, escrow };
    assert.equal(await freshDeploymentReady(contracts, token, addresses), true);
    enforceFreshDeployment(true, false);
    await tx(token, signer, "mint", [wallet.address, 150000n]); await tx(token, signer, "approve", [addresses.escrow, 150000n]);
    await tx(escrow, signer, "createTask", [150000n, (await provider.getBlock("latest"))!.timestamp + 3600]);
    assert.equal(await freshDeploymentReady(contracts, token, addresses), false);
    assert.throws(() => enforceFreshDeployment(false, false), /DEDICATED_EMPTY_DEPLOYMENT_REQUIRED/);
    enforceFreshDeployment(false, true); // Resume uses its original state/handles, not a fresh-run guard.
  } finally { provider.destroy(); await stopChild(local.child); }
});

test("Deployment interruption resumes the original 11 transactions and pauses before token funding", { timeout: 30000 }, async () => {
  const local = await startLocalAnvil(), directory = await mkdtemp(join(tmpdir(), "af-monad-deploy-test-"));
  const provider = new JsonRpcProvider(local.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  try {
    const config = parseMonadConfig(configuration(directory));
    const wallet = new Wallet(syntheticKey(1), provider), setup = new NonceManager(wallet);
    await provider.send("anvil_setBalance", [wallet.address, "0x3635c9adc5dea00000"]);
    const identity = await deploy("MockIdentityRegistry", setup, provider);
    const reputation = await deploy("MockReputationRegistry", setup, provider, [await identity.getAddress()]);
    const token = await deploy("MockERC20", setup, provider, ["Test USDC", "USDC", 6]);
    config.registries = { identity: await identity.getAddress(), reputation: await reputation.getAddress() };
    config.asset.address = await token.getAddress();
    const startNonce = await provider.getTransactionCount(wallet.address), journalPath = join(directory, "transactions.json"), statePath = join(directory, "state.json");
    const journal = new DemoJournal(provider, journalPath); await journal.load();
    let checkpoints = 0;
    const save = async (addresses: any) => { checkpoints++; await saveJson(statePath, { addresses }); };
    let checks = 0;
    await assert.rejects(prepareMonadDeployment(config, provider, wallet, journal, undefined, save, () => {
      if (++checks === 6) throw new Error("DEMO_INTERRUPTED");
    }), /DEMO_INTERRUPTED/);
    assert.equal(await provider.getTransactionCount(wallet.address), startNonce + 5);
    assert.equal(checkpoints, 1);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    const original = JSON.parse(await readFile(journalPath, "utf8"));
    const resumed = new DemoJournal(provider, journalPath); await resumed.load();
    const result = await prepareMonadDeployment(config, provider, wallet, resumed, state.addresses, save);
    assert.deepEqual(result.addresses, state.addresses); assert.equal(checkpoints, 1);
    assert.equal(Object.keys(result.receipts).length, 11);
    assert.equal(await provider.getTransactionCount(wallet.address), startNonce + 11);
    for (const [id, entry] of Object.entries(original) as [string, any][]) assert.equal(result.receipts[id].hash, entry.txHash);
    assert.equal(await freshDeploymentReady(result.contracts, token, result.addresses), true);
    for (const spender of [result.addresses.manager, result.addresses.escrow]) assert.equal(await token.getFunction("allowance").staticCall(wallet.address, spender), 0n);
    const repeated = await prepareMonadDeployment(config, provider, wallet, resumed, result.addresses, save);
    assert.equal(await provider.getTransactionCount(wallet.address), startNonce + 11);
    assert.deepEqual(Object.fromEntries(Object.entries(repeated.receipts).map(([id, receipt]) => [id, receipt.hash])),
      Object.fromEntries(Object.entries(result.receipts).map(([id, receipt]) => [id, receipt.hash])));
  } finally { provider.destroy(); await stopChild(local.child); await rm(directory, { recursive: true, force: true }); }
});
