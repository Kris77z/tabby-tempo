import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import test from "node:test";
import { chainRpcProvider } from "../demo-rpc.js";

const address = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;
async function heldEndpoint() {
  let release!: () => void, firstFour!: () => void, active = 0, maximum = 0;
  const gate = new Promise<void>(resolve => release = resolve), four = new Promise<void>(resolve => firstFour = resolve);
  const reads: { address: string; at: number }[] = [], writes: string[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString());
    if (["eth_getBalance", "eth_getStorageAt"].includes(body.method)) {
      reads.push({ address: body.params[0], at: Date.now() }); active++; maximum = Math.max(maximum, active);
      if (reads.length === 4) firstFour();
      await gate; active--;
    } else writes.push(body.method);
    response.setHeader("content-type", "application/json"); response.end(JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0x1" }));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, reads, writes, four, release, maximum: () => maximum,
    async close() { release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); } };
}
const timed = <T>(promise: Promise<T>, ms: number) => Promise.race([promise, delay(ms).then(() => { throw new Error("CONTROLLED_RPC_TEST_TIMEOUT"); })]);

test("Tempo providers sharing an endpoint keep four balance/storage read slots and 100ms pacing while writes bypass the full queue", async () => {
  const endpoint = await heldEndpoint(), a = await chainRpcProvider(endpoint.url, 42431, "direct"), b = await chainRpcProvider(`${endpoint.url}/`, "42431", "direct");
  const pending = Promise.allSettled(Array.from({ length: 12 }, (_, index) => (index % 2 ? a : b).provider.send(index % 3 ? "eth_getBalance" : "eth_getStorageAt", index % 3 ? [address(index + 1), "latest"] : [address(index + 1), "0x0", "latest"])));
  try {
    await timed(endpoint.four, 2000); await delay(150);
    assert.equal(endpoint.reads.length, 4, "different providers must share the endpoint's four active read slots");
    await timed(b.provider.send("eth_sendRawTransaction", ["0xoriginal-signed-bytes"]), 500);
    await timed(a.provider.send("tempo_fundAddress", [address(100)]), 500);
    assert.deepEqual(endpoint.writes, ["eth_sendRawTransaction", "tempo_fundAddress"]);
    assert.equal(endpoint.reads.length, 4, "broadcasts must complete before held reads release their slots");
    endpoint.release(); const results = await pending;
    assert.ok(results.every(result => result.status === "fulfilled")); assert.equal(endpoint.maximum(), 4); assert.equal(endpoint.reads.length, 12);
    for (let index = 1; index < endpoint.reads.length; index++) assert.ok(endpoint.reads[index].at - endpoint.reads[index - 1].at >= 80,
      "actual HTTP read starts must retain 100ms pacing across providers, allowing local scheduling jitter");
  } finally { endpoint.release(); a.close(); b.close(); await pending; await endpoint.close(); }
});

test("closing one Tempo provider cancels its queued reads without issuing them or stopping another provider", async () => {
  const endpoint = await heldEndpoint(), active = await chainRpcProvider(endpoint.url, 42431, "direct"), queued = await chainRpcProvider(endpoint.url, 42431, "direct");
  const holding = Promise.allSettled(Array.from({ length: 4 }, (_, index) => active.provider.send("eth_getBalance", [address(index + 1), "latest"])));
  let cancelled: Promise<PromiseSettledResult<unknown>[]> | undefined;
  try {
    await timed(endpoint.four, 2000);
    const forbidden = Array.from({ length: 6 }, (_, index) => address(index + 100));
    cancelled = Promise.allSettled(forbidden.map(wallet => queued.provider.send("eth_getBalance", [wallet, "latest"])));
    await delay(50); queued.close();
    assert.ok((await timed(cancelled, 1000)).every(result => result.status === "rejected"));
    endpoint.release(); await holding;
    assert.equal(await active.provider.send("eth_getBalance", [address(999), "latest"]), "0x1");
    assert.ok(endpoint.reads.every(read => !forbidden.includes(read.address))); assert.equal(endpoint.reads.length, 5);
  } finally { endpoint.release(); active.close(); queued.close(); await holding; await cancelled; await endpoint.close(); }
});

test("Tempo retains endpoint pacing when a completed provider closes before the next provider opens", async () => {
  const endpoint = await heldEndpoint(), first = await chainRpcProvider(endpoint.url, 42431, "direct");
  let second: Awaited<ReturnType<typeof chainRpcProvider>> | undefined;
  try {
    endpoint.release(); await first.provider.send("eth_getBalance", [address(1), "latest"]); first.close();
    second = await chainRpcProvider(`${endpoint.url}/`, 42431, "direct");
    await second.provider.send("eth_getBalance", [address(2), "latest"]);
    assert.equal(endpoint.reads.length, 2); assert.ok(endpoint.reads[1].at - endpoint.reads[0].at >= 80);
  } finally { first.close(); second?.close(); await endpoint.close(); }
});

test("Tempo's read queue is bounded and its wait consumes the original request deadline", async () => {
  const endpoint = await heldEndpoint(), active = await chainRpcProvider(endpoint.url, 42431, "direct"), queued = await chainRpcProvider(endpoint.url, 42431, "direct");
  const holding = Promise.allSettled(Array.from({ length: 4 }, (_, index) => active.provider.send("eth_getBalance", [address(index + 1), "latest"])));
  const rawRead = (id: number, timeout: number) => {
    const request = queued.provider._getConnection(); request.timeout = timeout; request.method = "POST";
    request.body = JSON.stringify({ jsonrpc: "2.0", id, method: "eth_getBalance", params: [address(id), "latest"] }); return request.send();
  };
  let bounded: Promise<unknown>[] = [];
  try {
    await timed(endpoint.four, 2000);
    await assert.rejects(rawRead(500, 40), error => (error as { code?: string }).code === "TIMEOUT");
    assert.equal(endpoint.reads.length, 4, "an expired queued read must never reach the endpoint");
    const rejected: unknown[] = [];
    bounded = Array.from({ length: 70 }, (_, index) => rawRead(index + 1000, 5000).catch(error => { rejected.push(error); }));
    await delay(50);
    assert.equal(rejected.filter(error => (error as { code?: string }).code === "RPC_READ_QUEUE_FULL").length, 6);
    queued.close(); await Promise.all(bounded);
    assert.equal(endpoint.reads.length, 4, "overflow and cancelled reads must never reach the endpoint");
  } finally { endpoint.release(); active.close(); queued.close(); await holding; await Promise.all(bounded); await endpoint.close(); }
});
