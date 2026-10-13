import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { test } from "node:test";
import { monadProvider } from "../demo-rpc.js";

test("operator call gas only fills omitted eth_call gas and leaves signing RPCs unchanged", async () => {
  const priorGas = process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT, priorInterval = process.env.AGENTFUEL_RPC_INTERVAL_MS;
  const bodies: { method: string; params: unknown[] }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); bodies.push(body);
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x01" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const call = { to: "0x1111111111111111111111111111111111111111", data: "0x313ce567" };
  try {
    delete process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT; process.env.AGENTFUEL_RPC_INTERVAL_MS = "0";
    let connection = await monadProvider(url, "direct");
    try { await connection.provider.send("eth_call", [call, "latest"]); } finally { connection.close(); }
    assert.deepEqual(bodies[0].params, [call, "latest"]);

    process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT = "100000";
    for (const interval of ["0", "1"]) {
      process.env.AGENTFUEL_RPC_INTERVAL_MS = interval;
      connection = await monadProvider(url, "direct");
      const before = bodies.length;
      const explicit = { ...call, gas: "0x0" }, nullGas = { ...call, gas: null };
      const estimate = [{ ...call }, "pending"], broadcast = ["0xoriginal-signed-bytes"];
      try {
        await connection.provider.send("eth_call", [call, "0x123", { state: "unchanged" }]);
        await connection.provider.send("eth_call", [explicit, "latest"]);
        await connection.provider.send("eth_call", [nullGas, "latest"]);
        await connection.provider.send("eth_estimateGas", estimate);
        await connection.provider.send("eth_sendRawTransaction", broadcast);
      } finally { connection.close(); }
      assert.deepEqual(bodies[before].params, [{ ...call, gas: "0x186a0" }, "0x123", { state: "unchanged" }]);
      assert.deepEqual(bodies[before + 1].params, [explicit, "latest"]);
      assert.deepEqual(bodies[before + 2].params, [nullGas, "latest"]);
      assert.deepEqual(bodies[before + 3].params, estimate);
      assert.deepEqual(bodies[before + 4].params, broadcast);
      assert.equal(Object.hasOwn(call, "gas"), false);
    }

    for (const invalid of ["", "0", "20999", "1000001", "-1", "1.5", "1e5", "0x186a0", "Infinity", "9007199254740993", " 100000"]) {
      process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT = invalid;
      await assert.rejects(monadProvider(url, "direct"), /^Error: RPC_CALL_GAS_LIMIT_INVALID$/);
    }
    process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT = "1000000";
    connection = await monadProvider(url, "direct");
    try { await connection.provider.send("eth_call", [call, "latest"]); } finally { connection.close(); }
    assert.deepEqual(bodies.at(-1)?.params, [{ ...call, gas: "0xf4240" }, "latest"]);
  } finally {
    if (priorGas === undefined) delete process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT; else process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT = priorGas;
    if (priorInterval === undefined) delete process.env.AGENTFUEL_RPC_INTERVAL_MS; else process.env.AGENTFUEL_RPC_INTERVAL_MS = priorInterval;
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
