import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { rpcRequest } from "../demo-rpc.js";

async function fixture(successAfter: number, retryAfter = "0") {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume(); const success = ++calls >= successAfter;
    response.writeHead(success ? 200 : 429, { "content-type": "application/json", "retry-after": retryAfter });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x1" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, calls: () => calls,
    async close() { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
async function send(url: string, method = "eth_getLogs", timeout = 10000, body?: unknown, opted = true) {
  const connection = rpcRequest(url, undefined, timeout, false, undefined, opted);
  connection.request.method = "POST"; connection.request.body = JSON.stringify(body ?? { jsonrpc: "2.0", id: 1, method, params: [] });
  try { return await connection.request.send(); } finally { connection.close(); }
}
test("429 read recovery succeeds once while writes, batches and non-opted requests remain single-attempt", async () => {
  const f = await fixture(2);
  try { assert.equal((await send(f.url)).statusCode, 200); assert.equal(f.calls(), 2); }
  finally { await f.close(); }
  for (const input of [{ method: "eth_sendRawTransaction" }, { body: [{ jsonrpc: "2.0", id: 1, method: "eth_getLogs", params: [] }] }, { opted: false }]) {
    const denied = await fixture(Infinity);
    try { assert.equal((await send(denied.url, input.method, 10000, input.body, input.opted)).statusCode, 429); assert.equal(denied.calls(), 1); }
    finally { await denied.close(); }
  }
});
test("429 recovery stops after three retries and Retry-After cannot extend the original deadline", async () => {
  const f = await fixture(Infinity);
  try { assert.equal((await send(f.url)).statusCode, 429); assert.equal(f.calls(), 4); }
  finally { await f.close(); }
  const delayed = await fixture(2, "3600");
  try {
    const started = Date.now(); await assert.rejects(send(delayed.url, "eth_getLogs", 120), /TIMEOUT/);
    assert.equal(delayed.calls(), 1); assert.ok(Date.now() - started < 1000);
  } finally { await delayed.close(); }
});
