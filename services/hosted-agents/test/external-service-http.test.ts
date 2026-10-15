import assert from "node:assert/strict";
import { once } from "node:events";
import { connect } from "node:net";
import test, { type TestContext } from "node:test";
import type { Refunder } from "../../provider-relay/src/refunder.js";
import { createExternalServiceServer, type ExternalSpecialistRelay } from "../src/external/service.js";
import { externalAdvertisement, type ExternalServiceTrust } from "../src/external/registry.js";

async function serve(t: TestContext) {
  const identity: ExternalServiceTrust = {
    id: "local-writer", name: "Local writer", taskType: "writer", endpoint: "http://127.0.0.1:1/v1/chat",
    serviceId: "external/writer", modelId: "writer", physicalModel: "controlled-writer", priceRaw: "10000",
    provider: "0x1111111111111111111111111111111111111111",
  };
  const statusCalls: string[][] = [];
  // Exercise the real HTTP wrapper without initializing a wallet, RPC or model relay.
  const relay = {
    identity, config: { frontendOrigin: "http://127.0.0.1:3028" },
    async status(...args: string[]) { statusCalls.push(args); return { state: "Quoted" }; },
  } as unknown as ExternalSpecialistRelay;
  const server = createExternalServiceServer(relay, {} as Refunder);
  t.after(async () => {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = (server.address() as { port: number }).port;
  return { port, url: `http://127.0.0.1:${port}`, identity, statusCalls };
}

function rawGet(port: number, target: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: "127.0.0.1", port });
    let response = "";
    socket.setTimeout(2000, () => socket.destroy(new Error("LOCAL_HTTP_RESPONSE_TIMEOUT")));
    socket.once("connect", () => socket.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`));
    socket.on("data", chunk => { response += chunk.toString(); });
    socket.once("end", () => resolve(response));
    socket.once("error", reject);
  });
}

test("malformed absolute request targets return 400 and leave external metadata available", { timeout: 5000 }, async t => {
  const local = await serve(t);
  for (const target of ["http://[::1", "http://%"] as const) {
    const response = await rawGet(local.port, target);
    assert.match(response, /^HTTP\/1\.1 400 /);
    assert.match(response, /"error":"INVALID_URL"/);
    assert.equal(response.includes(target), false, "The invalid target is not reflected in the error");
  }
  const identity = await fetch(local.url + "/identity");
  assert.equal(identity.status, 200);
  assert.deepEqual(await identity.json(), { service: externalAdvertisement(local.identity) });
  const services = await fetch(local.url + "/services");
  assert.equal(services.status, 200);
  assert.deepEqual(await services.json(), { services: [externalAdvertisement(local.identity)] });
  assert.equal(local.statusCalls.length, 0);
});

test("valid payment status requests retain the original Relay handler and Origin rejection", { timeout: 5000 }, async t => {
  const local = await serve(t), paymentId = "0x" + "a".repeat(64), requestDigest = "0x" + "b".repeat(64);
  const url = `${local.url}/payments/${paymentId}?agentId=7&requestDigest=${requestDigest}`;
  const status = await fetch(url);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { state: "Quoted" });
  assert.deepEqual(local.statusCalls, [[paymentId, "7", requestDigest]]);
  const forbidden = await fetch(url, { headers: { Origin: "https://foreign.invalid" } });
  assert.equal(forbidden.status, 403);
  assert.equal((await forbidden.json() as { error: string }).error, "ORIGIN_REJECTED");
  assert.equal(local.statusCalls.length, 1);
});
