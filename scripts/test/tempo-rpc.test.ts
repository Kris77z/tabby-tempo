import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import test from "node:test";
import { chainRpcProvider, monadProvider } from "../demo-rpc.js";

test("Tempo transport binds chain 42431, retries reads, and broadcasts signed bytes only once", async () => {
  const previous = process.env.AGENTFUEL_RPC_RETRY_READ_503;
  process.env.AGENTFUEL_RPC_RETRY_READ_503 = "1";
  const calls: { method: string; params: unknown[] }[] = [];
  let failedRead = false;
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); calls.push(body);
    if (body.method === "eth_sendRawTransaction" || body.method === "eth_blockNumber" && !failedRead) {
      failedRead = true; response.writeHead(503); response.end("temporarily unavailable"); return;
    }
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: body.method === "eth_chainId" ? "0xa5bf" : "0x1" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const connection = await chainRpcProvider(url, "42431", "direct");
  try {
    assert.equal((await connection.provider.getNetwork()).chainId, 42431n);
    assert.equal(await connection.provider.send("eth_chainId", []), "0xa5bf");
    assert.equal(await connection.provider.send("eth_blockNumber", []), "0x1");
    assert.equal(calls.filter(call => call.method === "eth_blockNumber").length, 2);
    await assert.rejects(connection.provider.send("eth_sendRawTransaction", ["0xoriginal-signed-bytes"]));
    assert.deepEqual(calls.filter(call => call.method === "eth_sendRawTransaction").map(call => call.params), [["0xoriginal-signed-bytes"]]);
    const legacy = await monadProvider(url, "direct");
    try { assert.equal((await legacy.provider.getNetwork()).chainId, 10143n); } finally { legacy.close(); }
    for (const invalid of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, "", "0", "01", "0xa5bf", "42431 "]) {
      await assert.rejects(chainRpcProvider(url, invalid, "direct"), /RPC_CHAIN_ID_INVALID/);
    }
  } finally {
    connection.close(); assert.equal(connection.provider.destroyed, true);
    if (previous === undefined) delete process.env.AGENTFUEL_RPC_RETRY_READ_503; else process.env.AGENTFUEL_RPC_RETRY_READ_503 = previous;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
