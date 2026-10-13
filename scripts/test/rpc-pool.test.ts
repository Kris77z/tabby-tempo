import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createServer } from "node:http";
import { createServer as secureServer } from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import type { Socket } from "node:net";
import { rpcRequest } from "../demo-rpc.js";

const execute = promisify(execFile);
function call(connection: ReturnType<typeof rpcRequest>, id: number, method = "eth_chainId", timeout?: number) {
  const request = connection.request.clone(); request.method = "POST";
  request.body = JSON.stringify({ jsonrpc: "2.0", id, method, params: [] });
  if (timeout) request.timeout = timeout;
  return request;
}
async function until(check: () => boolean) {
  for (let i = 0; i < 200 && !check(); i++) await delay(5);
  assert.equal(check(), true);
}

test("direct RPC pool reuses completed connections; cancellation and timeout do not kill a concurrent request", async () => {
  const sockets = new Set<Socket>(), received = new Map<number, Socket>();
  const server = createServer(async (req, res) => {
    let text = ""; for await (const chunk of req) text += chunk;
    const body = JSON.parse(text); received.set(body.id, req.socket);
    if ([3, 4, 5, 6, 7].includes(body.id)) await delay(220);
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x279f" }));
  });
  server.on("connection", socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const connection = rpcRequest(`http://127.0.0.1:${(server.address() as { port: number }).port}`, undefined, 2000, true);
  try {
    assert.equal((await call(connection, 1).send()).bodyJson.result, "0x279f");
    await call(connection, 2).send(); assert.equal(received.get(1), received.get(2), "Sequential calls must reuse their connection-owned socket");
    const cancelled = call(connection, 3), survivor = call(connection, 4);
    const rejected = assert.rejects(cancelled.send(), /CANCELLED/), kept = survivor.send();
    await until(() => received.has(3) && received.has(4)); cancelled.cancel();
    await rejected; assert.equal((await kept).bodyJson.result, "0x279f");
    const timed = assert.rejects(call(connection, 5, "eth_chainId", 70).send(), /TIMEOUT/), keptAgain = call(connection, 6).send();
    await timed; assert.equal((await keptAgain).statusCode, 200);
    assert.ok(sockets.size > 0, "Completed requests leave reusable idle sockets");
    const closing = assert.rejects(call(connection, 7).send(), /CANCELLED/);
    await until(() => received.has(7)); connection.close(); await closing;
    await until(() => sockets.size === 0);
    await assert.rejects(call(connection, 8).send(), /RPC_CONNECTION_CLOSED/);
    assert.equal(received.has(8), false);
  } finally { connection.close(); server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); }
});

test("HTTPS direct RPC pool reuses TLS connections and decodes gzip with normal FetchResponse metadata", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-rpc-tls-"));
  const key = join(directory, "key.pem"), cert = join(directory, "cert.pem");
  let server: ReturnType<typeof secureServer> | undefined;
  try {
    await execute("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "1", "-subj", "/CN=localhost", "-addext", "subjectAltName=IP:127.0.0.1"]);
    let tlsConnections = 0, requests = 0;
    server = secureServer({ key: await readFile(key), cert: await readFile(cert) }, async (req, res) => {
      let text = ""; for await (const chunk of req) text += chunk;
      const body = JSON.parse(text); requests++;
      const gzip = gzipSync(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x279f" }));
      res.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip", "content-length": String(gzip.length), "x-rpc-fixture": "gzip" }); res.end(gzip);
    });
    server.on("secureConnection", () => { tlsConnections++; });
    server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `https://127.0.0.1:${(server.address() as { port: number }).port}`;
    // Trust only this generated CA in a fresh child; never disable TLS verification
    // or change the parent's/global Agent used by other tests or application requests.
    const source = `import assert from 'node:assert/strict'; import {rpcRequest} from ${JSON.stringify(new URL("../demo-rpc.ts", import.meta.url).href)};
      const c=rpcRequest(${JSON.stringify(url)},undefined,2000,true); try { for(let id=1;id<=3;id++) { const r=c.request.clone();r.method='POST';r.body=JSON.stringify({jsonrpc:'2.0',id,method:'eth_chainId',params:[]});const out=await r.send();assert.equal(out.statusCode,200);assert.equal(out.statusMessage,'OK');assert.equal(out.headers['x-rpc-fixture'],'gzip');assert.equal(out.bodyJson.result,'0x279f'); } } finally { c.close(); }`;
    await execute(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", source], { env: { ...process.env, NODE_EXTRA_CA_CERTS: cert }, timeout: 15000 });
    assert.equal(requests, 3); assert.equal(tlsConnections, 1);
  } finally { server?.closeAllConnections(); if (server) await new Promise<void>(done => server!.close(() => done())); await rm(directory, { recursive: true, force: true }); }
});
