import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import type { Socket } from "node:net";
import test from "node:test";
import type { JsonRpcProvider, Log } from "ethers";
import { frontendLogPageBlocks, readLogPages } from "../lib/read";
import { createServerRpc, frontendTransport } from "../lib/server-transport";

const settings = ["FRONTEND_RPC_TRANSPORT", "FRONTEND_RPC_URL_FILE", "FRONTEND_LOG_PAGE_BLOCKS", "AGENTFUEL_RPC_INTERVAL_MS", "AGENTFUEL_RPC_CALL_GAS_LIMIT", "AGENTFUEL_RPC_RETRY_READ_503"];
function configure(t: { after(callback: () => void): void }, values: Record<string, string> = {}) {
  const previous = new Map(settings.map(key => [key, process.env[key]]));
  for (const key of settings) { if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key]; }
  t.after(() => { for (const [key, value] of previous) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
}
async function listen(server: Server) {
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function close(server: Server) { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }

test("configured ten-block log pages retain all 2000 blocks and event order under the provider cap", async t => {
  configure(t, { FRONTEND_LOG_PAGE_BLOCKS: "10" });
  const ranges: [number, number][] = [], covered: number[] = [];
  const addresses = ["account", "manager", "escrow"];
  const provider: Pick<JsonRpcProvider, "getLogs"> = { async getLogs(filter) {
    assert.ok("fromBlock" in filter && "toBlock" in filter); assert.deepEqual(filter.address, addresses);
    const from = Number(filter.fromBlock), to = Number(filter.toBlock);
    assert.ok(to - from + 1 <= 10, "controlled provider rejects larger pages"); ranges.push([from, to]);
    covered.push(...Array.from({ length: to - from + 1 }, (_, index) => from + index));
    return [{ blockNumber: to, index: 1 }, { blockNumber: from, index: 0 }] as Log[];
  } };
  const logs = await readLogPages(provider, addresses, 7, 2006);
  assert.equal(ranges.length, 200); assert.deepEqual(ranges[0], [7, 16]); assert.deepEqual(ranges.at(-1), [1997, 2006]);
  assert.deepEqual(covered, Array.from({ length: 2000 }, (_, index) => index + 7));
  assert.equal(logs.length, 400); assert.equal(logs[0].blockNumber, 7); assert.equal(logs.at(-1)!.blockNumber, 2006);
  const tail: [number, number][] = [];
  await readLogPages({ async getLogs(filter) { assert.ok("fromBlock" in filter && "toBlock" in filter); tail.push([Number(filter.fromBlock), Number(filter.toBlock)]); return []; } }, addresses, 7, 28);
  assert.deepEqual(tail, [[7, 16], [17, 26], [27, 28]]);
});

test("log page configuration preserves the default and rejects values outside integer 1..100 before reading", async t => {
  configure(t); assert.equal(frontendLogPageBlocks(), 100);
  for (const value of ["1", "10", "100"]) assert.equal(frontendLogPageBlocks(value), Number(value));
  for (const value of ["", "0", "101", "1.5", "1e1", "-1", "NaN"]) assert.throws(() => frontendLogPageBlocks(value), /FRONTEND_LOG_PAGE_BLOCKS_INVALID/);
  let reads = 0;
  await assert.rejects(readLogPages({ async getLogs() { reads++; return []; } }, [], 1, 10, 101), /FRONTEND_LOG_PAGE_BLOCKS_INVALID/);
  assert.equal(reads, 0);
});

test("generic direct RPC paces concurrent calls and caps only eth_call without explicit gas", async t => {
  configure(t, { FRONTEND_RPC_TRANSPORT: "direct", AGENTFUEL_RPC_INTERVAL_MS: "60", AGENTFUEL_RPC_CALL_GAS_LIMIT: "1000000" });
  const calls: { method: string; params: any[]; at: number }[] = [];
  const server = createServer(async (request, response) => {
    let body = ""; for await (const chunk of request) body += String(chunk);
    const input = JSON.parse(body); assert.equal(Array.isArray(input), false); calls.push({ ...input, at: Date.now() });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: input.method === "eth_chainId" ? "0x7a69" : input.method === "eth_estimateGas" ? "0x5208" : "0x" }));
  });
  const url = await listen(server), connection = await createServerRpc(url, async () => { throw new Error("NO_PROXY_LOOKUP_EXPECTED"); });
  try {
    assert.equal((await connection.provider.getNetwork()).chainId, 31337n);
    const transaction = { to: "0x" + "1".repeat(40), data: "0x" };
    await Promise.all([
      connection.provider.send("eth_call", [transaction, "latest"]),
      connection.provider.send("eth_call", [{ ...transaction, gas: "0x5208" }, "latest"]),
      connection.provider.send("eth_estimateGas", [transaction]),
    ]);
    const business = calls.filter(call => call.method !== "eth_chainId"); assert.equal(business.length, 3);
    assert.equal(business[0].params[0].gas, "0xf4240"); assert.equal(business[1].params[0].gas, "0x5208"); assert.equal(business[2].params[0].gas, undefined);
    assert.deepEqual(transaction, { to: "0x" + "1".repeat(40), data: "0x" });
    for (let index = 1; index < business.length; index++) assert.ok(business[index].at - business[index - 1].at >= 45, "concurrent leaf calls must be paced");
    assert.equal(frontendTransport().creditTimeoutMs, 12000);
  } finally { connection.close(); await close(server); }
});

test("direct read opt-in reuses its connection and retries a read 503 while writes and 429 stay single-attempt", async t => {
  configure(t, { FRONTEND_RPC_TRANSPORT: "direct", AGENTFUEL_RPC_RETRY_READ_503: "1" });
  const sockets = new Set<Socket>(), blockSockets: Socket[] = []; let blocks = 0, writes = 0, limited = 0;
  const server = createServer(async (request, response) => {
    sockets.add(request.socket);
    let body = ""; for await (const chunk of request) body += String(chunk); const input = JSON.parse(body);
    if (input.method === "eth_blockNumber") { blockSockets.push(request.socket); if (++blocks === 1) { response.writeHead(503); response.end(); return; } }
    if (input.method === "eth_sendRawTransaction") { writes++; response.writeHead(503); response.end(); return; }
    if (input.method === "eth_getCode") { limited++; response.writeHead(429); response.end(); return; }
    response.writeHead(200, { "content-type": "application/json" }); response.end(JSON.stringify({ jsonrpc: "2.0", id: input.id, result: input.method === "eth_chainId" ? "0x7a69" : "0x10" }));
  });
  const connection = await createServerRpc(await listen(server));
  try {
    assert.equal((await connection.provider.getNetwork()).chainId, 31337n);
    assert.equal(await connection.provider.send("eth_blockNumber", []), "0x10"); assert.equal(blocks, 2);
    await assert.rejects(connection.provider.send("eth_sendRawTransaction", ["0xfixture"])); assert.equal(writes, 1);
    await assert.rejects(connection.provider.send("eth_getCode", ["0x" + "1".repeat(40), "latest"])); assert.equal(limited, 1);
    assert.equal(blockSockets[0], blockSockets[1], "the read retry should reuse its keep-alive connection");
    // Ethers may make two concurrent network-detection requests on a generic provider.
    assert.ok(sockets.size <= 2, "later requests should reuse the connection-owned pool");
  } finally { connection.close(); await close(server); }
});

test("invalid pacing and gas settings fail before creating a transport", async t => {
  configure(t);
  for (const value of ["-1", "1.5", "5001", "oops"]) {
    process.env.AGENTFUEL_RPC_INTERVAL_MS = value; await assert.rejects(createServerRpc("http://unused.invalid"), /RPC_INTERVAL_INVALID/);
  }
  process.env.AGENTFUEL_RPC_INTERVAL_MS = "0";
  for (const value of ["0", "20000", "21000.5", "1000001", "1e6"]) {
    process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT = value; await assert.rejects(createServerRpc("http://unused.invalid"), /RPC_CALL_GAS_LIMIT_INVALID/);
  }
});
