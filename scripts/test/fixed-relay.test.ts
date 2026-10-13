import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { once } from "node:events";
import { fixture, key, startAnvil, stopAnvil } from "../../services/underwriter/test/fixture.js";
import { publicSampleFor } from "../../packages/pi-loop/src/public-sample.js";
import { startFixedRelay } from "../fixed-relay.js";

test("standalone fixed Relay starts without payment/model, serves bound quote and refuses another writer", { timeout: 45000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-fixed-start-"));
  const local = await startAnvil(); let f: Awaited<ReturnType<typeof fixture>> | undefined, runtime: Awaited<ReturnType<typeof startFixedRelay>> | undefined;
  try {
    f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
    const socket = createServer(); socket.listen(0, "127.0.0.1"); await once(socket, "listening");
    const port = (socket.address() as { port: number }).port; await new Promise<void>(done => socket.close(() => done()));
    const env = { RPC_URL: local.rpc, CHAIN_ID: "31337", ACCOUNT_ADDRESS: await f.account.getAddress(), PROVIDER_ADDRESS: f.payee,
      SETTLEMENT_ASSET: f.config.settlementAsset, ASSET_DECIMALS: "6", SERVICE_ID: "infercredit/solve-fixed", LOGICAL_MODEL: "pi-fixed-v1", PRICE: "120000",
      HOST: "127.0.0.1", PORT: String(port), DATA_DIR: join(directory, "relay"), REFUNDER_PRIVATE_KEY: key(4), SYNTHETIC: "test-only",
      UPSTREAMS_JSON: JSON.stringify(["cheap", "strong"].map(name => ({ name, model: name, baseUrl: "http://127.0.0.1:1/v1", keyEnv: "SYNTHETIC" }))) };
    let calls = 0; const options = { provider: f.provider, modelFetch: (async () => { calls++; throw new Error("No model on startup or quote"); }) as typeof fetch };
    const before = await f.provider.getTransactionCount(f.agentAddress); runtime = await startFixedRelay(env, options);
    await assert.rejects(startFixedRelay(env, options), /SESSION_BUSY/);
    const solve = { version: 1, problemId: "sum-integers", tiers: ["cheap"], maxRounds: 1, maxToolCalls: 1, maxCompletionTokens: 128, deadlineMs: Date.now() + 60000 };
    const response = await fetch(`http://127.0.0.1:${port}/v1/chat`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "1", taskId: "1", service: "infercredit/solve-fixed", model: "pi-fixed-v1", solve, messages: [{ role: "user", content: publicSampleFor("sum-integers").prompt }] }) });
    assert.equal(response.status, 402); assert.equal((await response.json() as any).quote.price, "120000");
    assert.equal(calls, 0); assert.equal(await f.providerBalance(), 0n); assert.equal(await f.provider.getTransactionCount(f.agentAddress), before);
    await runtime.close(); runtime = await startFixedRelay(env, options); assert.equal(calls, 0);
    await assert.rejects(startFixedRelay({ ...env, HOST: "0.0.0.0" }, options), /LOCAL_OPERATOR_ONLY/);
  } finally { await runtime?.close(); await f?.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});
