import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { rpcRequest } from "../demo-rpc.js";

const read = { jsonrpc: "2.0", id: 1, method: "eth_chainId", params: [] };
async function fixture(modes: ("reset" | "503" | "ok")[]) {
  let calls = 0;
  const server = createServer((request, response) => {
    request.resume(); const mode = modes[Math.min(calls++, modes.length - 1)];
    if (mode === "reset") { request.socket.destroy(); return; }
    response.writeHead(mode === "503" ? 503 : 200, { "content-type": "application/json" });
    response.end(JSON.stringify({ jsonrpc: "2.0", id: 1, result: "0x279f" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  return { url, calls: () => calls, close: async () => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); } };
}
async function send(url: string, body: unknown, opted = true, timeout = 4000) {
  const connection = rpcRequest(url, undefined, timeout, opted);
  connection.request.method = "POST"; connection.request.setHeader("content-type", "application/json");
  connection.request.body = JSON.stringify(body);
  try { return await connection.request.send(); } finally { connection.close(); }
}

test("opted-in read RPCs share one retry budget for socket resets and 503s", async () => {
  const f = await fixture(["reset", "503", "reset", "ok"]);
  try { assert.equal((await send(f.url, read)).statusCode, 200); assert.equal(f.calls(), 4); }
  finally { await f.close(); }
});

test("reset exhaustion is a fixed safe error and writes, batches and non-opted reads are never repeated", async () => {
  const f = await fixture(["reset"]);
  try {
    await assert.rejects(send(f.url, read), error => error instanceof Error && error.message === "RPC_REQUEST_ECONNRESET" && !error.message.includes(f.url));
    assert.equal(f.calls(), 4);
    let before = f.calls();
    await assert.rejects(send(f.url, { jsonrpc: "2.0", id: 2, method: "eth_sendRawTransaction", params: ["0xsynthetic-signed-bytes"] }), /RPC_REQUEST_ECONNRESET/);
    assert.equal(f.calls() - before, 1);
    before = f.calls(); await assert.rejects(send(f.url, [read]), /RPC_REQUEST_ECONNRESET/); assert.equal(f.calls() - before, 1);
    before = f.calls(); await assert.rejects(send(f.url, read, false)); assert.equal(f.calls() - before, 1);
  } finally { await f.close(); }
});

test("a reset backoff shares the original deadline and cancellation prevents another request", async () => {
  const f = await fixture(["reset"]);
  try {
    const started = Date.now(); await assert.rejects(send(f.url, read, true, 150), /TIMEOUT/);
    assert.equal(f.calls(), 1); assert.ok(Date.now() - started < 600);
    const connection = rpcRequest(f.url, undefined, 4000, true);
    connection.request.method = "POST"; connection.request.body = JSON.stringify(read);
    const before = f.calls(), pending = connection.request.send();
    const timer = setInterval(() => { if (f.calls() > before) { clearInterval(timer); connection.request.cancel(); } }, 5);
    try { await assert.rejects(pending, /CANCELLED/); assert.equal(f.calls() - before, 1); }
    finally { clearInterval(timer); connection.close(); }
  } finally { await f.close(); }
});
