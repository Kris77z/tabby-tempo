import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { id } from "ethers";
import { EMPTY_AUTH, type ChatInput } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../underwriter/test/fixture.js";
import { Relay } from "../src/relay.js";
import { Refunder } from "../src/refunder.js";

test("status distinguishes missing history from explicit no-dispatch history through a real full refund", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "relay-refund-status-")), local = await startAnvil();
  let f: Awaited<ReturnType<typeof fixture>> | undefined, relay: Relay | undefined;
  try {
    f = await fixture(local.rpc, join(directory, "underwriter"), 6, { refunderKey: key(4) });
    await f.provider.send("anvil_setBalance", [f.payee, "0x3635c9adc5dea00000"]);
    let upstreamCalls = 0;
    relay = new Relay({ rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
      service: { id: "controlled", model: "controlled", price: 1000n, upstreams: [{ name: "controlled", model: "controlled", baseUrl: "https://controlled.invalid/v1", key: "synthetic" }] },
      dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 0, refunderKey: key(4) },
      { provider: f.provider, upstreamFetch: async () => { upstreamCalls++; throw Error("UNEXPECTED_MODEL_CALL"); } });
    const refunder = new Refunder(relay); await relay.initialize(); await refunder.initialize();
    const input: ChatInput = { agentId: "1", taskId: "0", service: "controlled", model: "controlled", messages: [{ role: "user", content: "unsubmitted" }] };
    const quote = await relay.quote(input);
    await tx(f.account, f.agent, "payProvider", ["1", f.payee, "1000", quote.paymentId, EMPTY_AUTH, "0x"]);
    const status = async () => JSON.parse(JSON.stringify(await relay!.status(quote.paymentId, "1", quote.requestDigest)));
    const paid = await status(); assert.equal(paid.state, "Paid"); assert.deepEqual(paid.upstreamAttempts, []);
    const record = await relay.store.read(quote.paymentId), legacy = structuredClone(record); delete legacy.upstreamAttempts;
    await relay.store.write(legacy); assert.equal(Object.hasOwn(await status(), "upstreamAttempts"), false);
    await relay.store.write(record);
    const refundId = id("natural-undispatched-full-refund"); await refunder.refund(quote.paymentId, refundId, "1000");
    const refunded = await status(); assert.equal(refunded.state, "Refunded"); assert.deepEqual(refunded.upstreamAttempts, []);
    assert.equal(refunded.refundedAmount, "1000"); assert.equal(refunded.confirmedRefunds.length, 1); assert.equal(refunded.confirmedRefunds[0].refundId, refundId);
    for (const field of ["result", "receipt", "operatorResolution", "operatorCompensation"]) assert.equal(Object.hasOwn(refunded, field), false);
    assert.equal((await read(f.account, "getPayment", [quote.paymentId])).refundedAmount, 1000n);
    assert.equal(await read(f.account, "refundConsumed", [refundId]), true); assert.equal(upstreamCalls, 0);
  } finally { relay?.close(); await f?.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});
