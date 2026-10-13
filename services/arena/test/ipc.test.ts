import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { requestSettlement } from "../src/ipc.js";
import { settlementTimeout, type Settlement, type Verdict } from "../src/protocol.js";

test("IPC timeout is bounded, destroys a timed-out client and accepts a delayed same-verdict reply", { timeout: 5000 }, async () => {
  const directory = await mkdtemp("/tmp/af-ipc-timeout-");
  const sockets = new Set<Socket>(), timers = new Set<NodeJS.Timeout>();
  const verdict: Verdict = { version: 1, runId: "11111111-1111-1111-1111-111111111111", chainId: "31337",
    escrowAddress: "0x" + "11".repeat(20), taskId: "1", agentId: "0", problemId: "sum-integers", passed: true, mode: "docker", evidenceHash: "0".repeat(64) };
  const settlement: Settlement = { taskId: "1", runId: verdict.runId, passed: true, txHash: "0x" + "22".repeat(32), blockNumber: 1, feedback: [] };
  const received: Verdict[] = [];
  const server = createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.once("close", () => sockets.delete(socket)); socket.on("error", () => {});
    let body = ""; socket.on("data", chunk => { body += String(chunk); });
    socket.on("end", () => {
      received.push(JSON.parse(body).verdict);
      const timer = setTimeout(() => {
        timers.delete(timer);
        if (!socket.destroyed) socket.end(JSON.stringify({ settlement }) + "\n");
      }, 150);
      timers.add(timer);
    });
  });
  try {
    assert.equal(settlementTimeout(), 30000); assert.equal(settlementTimeout(50), 50); assert.equal(settlementTimeout(300000), 300000);
    server.listen(join(directory, "settler.sock")); await once(server, "listening");
    await assert.rejects(requestSettlement(directory, "a".repeat(64), verdict, 49), /INVALID_SETTLEMENT_TIMEOUT/);
    assert.equal(received.length, 0);
    await assert.rejects(requestSettlement(directory, "a".repeat(64), verdict, 50), /SETTLER_TIMEOUT/);
    // The server is half-open by design. A destroyed client must leave no live
    // socket once the delayed reply has completed, and a retry uses the verdict.
    await delay(170);
    for (let i = 0; sockets.size && i < 20; i++) await delay(10);
    assert.equal(sockets.size, 0);
    assert.deepEqual(await requestSettlement(directory, "a".repeat(64), verdict, 500), settlement);
    assert.deepEqual(await requestSettlement(directory, "a".repeat(64), verdict), settlement);
    assert.deepEqual(received, [verdict, verdict, verdict]);
  } finally {
    for (const timer of timers) clearTimeout(timer);
    for (const socket of sockets) socket.destroy();
    if (server.listening) await new Promise<void>(resolve => server.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  }
});
