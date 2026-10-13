import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { EMPTY_AUTH, InferCredit, type ChatInput } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil, tx } from "../../underwriter/test/fixture.js";
import { ALLOWANCE_MODEL, ALLOWANCE_SERVICE, allowanceBody, InferenceAllowanceRelay } from "../src/allowance.js";
import type { RelayConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { Refunder } from "../src/refunder.js";
import { RelayError } from "../src/relay.js";

const terms = { creditsRaw: "120000", modelCatalogDigest: keccak256(toUtf8Bytes("two-model-catalog-v1")) };
const code = (expected: string) => (error: unknown) => error instanceof RelayError && error.code === expected;

test("task allowance uses real task credit, preserves its package across SDK replay/restart, and calls no model", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-allowance-"));
  const local = await startAnvil();
  const f = await fixture(local.rpc, join(directory, "underwriter"), 6);
  const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(),
    asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee, service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL,
      price: 120000n, upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] },
    dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000,
    host: "127.0.0.1", port: 8788, refunderKey: key(1) };
  let calls = 0;
  const options = { ...terms, provider: f.provider, upstreamFetch: (async () => { calls++; throw new Error("No model calls allowed"); }) as typeof fetch };
  let relay = new InferenceAllowanceRelay(config, options);
  const server = createHttpServer(relay, new Refunder(relay));
  const infer = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n,
    account: config.account, asset: config.asset, provider: config.payTo, maxPrice: config.service.price, underwriterUrl: f.http });
  try {
    await relay.initialize(); server.listen(0, "127.0.0.1"); await once(server, "listening");
    const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
    const taskId = await f.task();
    const before = await f.providerBalance();
    const delivered = await infer.forTask(String(taskId)).fetch(url, { body: allowanceBody(terms) });
    assert.equal(delivered.receipt.fromCash, "40000"); assert.equal(delivered.receipt.fromCredit, "80000");
    assert.equal((await read(f.manager, "getLoan", [taskId])).principal, 80000n);
    assert.equal(delivered.receipt.upstream, "allowance-ledger"); assert.equal(delivered.receipt.model, ALLOWANCE_MODEL);
    assert.deepEqual(delivered.result, { kind: "inference-allowance", paymentId: delivered.handle.quote.paymentId, agentId: "1", taskId: String(taskId), ...terms });
    assert.deepEqual(delivered.receipt.usage, { kind: "prepaid-inference-allowance", ...terms, llmInvocations: 0 });
    const nonce = await f.provider.getTransactionCount(f.agentAddress);
    assert.deepEqual((await infer.resume(structuredClone(delivered.handle))).result, delivered.result);
    assert.deepEqual((await infer.forTask(String(taskId)).fetch(url, { body: allowanceBody(terms) })).result, delivered.result);
    assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonce);
    assert.equal((await f.providerBalance()) - before, 120000n);
    relay.close(); relay = new InferenceAllowanceRelay(config, options); await relay.recover();
    assert.deepEqual((await relay.chat(delivered.handle.input, delivered.handle.quote.paymentId)).result, delivered.result);
    const changed = new InferenceAllowanceRelay(config, { ...options, creditsRaw: "240000" });
    try {
      await assert.rejects(changed.chat(delivered.handle.input, delivered.handle.quote.paymentId), code("ALLOWANCE_CONFIG_MISMATCH"));
      await assert.rejects(changed.status(delivered.handle.quote.paymentId, "1", delivered.handle.quote.requestDigest), code("ALLOWANCE_CONFIG_MISMATCH"));
    } finally { changed.close(); }
    await assert.rejects(relay.quote({ ...delivered.handle.input, taskId: "0" }), code("INVALID_ALLOWANCE_REQUEST"));
    await assert.rejects(relay.quote({ ...delivered.handle.input, allowance: { ...terms, creditsRaw: "240000" } }), code("ALLOWANCE_CONFIG_MISMATCH"));
    assert.equal(calls, 0);
  } finally {
    infer.close(); await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); relay.close();
    await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true });
  }
});

test("cash allowance rejects duplicate grants, task reassignment and reconfigured paid packages; undelivered package refunds remain available", { timeout: 90_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-allowance-cash-"));
  const local = await startAnvil(); const f = await fixture(local.rpc, join(directory, "underwriter"), 6);
  const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
    assetDecimals: 6, payTo: f.payee, service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 10000n,
      upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] },
    dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788, refunderKey: key(1) };
  const relay = new InferenceAllowanceRelay(config, { ...terms, provider: f.provider });
  try {
    const taskId = await f.task(); const input = { ...allowanceBody(terms), agentId: "1", taskId: String(taskId) } as ChatInput;
    const first = await relay.quote(input), duplicate = await relay.quote(input);
    await tx(f.account, f.agent, "payProvider", [1n, f.payee, first.price, first.paymentId, EMPTY_AUTH, "0x"]);
    const delivered = await relay.chat(input, first.paymentId); assert.equal(delivered.receipt!.fromCredit, "0");
    await tx(f.account, f.agent, "payProvider", [1n, f.payee, duplicate.price, duplicate.paymentId, EMPTY_AUTH, "0x"]);
    await assert.rejects(relay.chat(input, duplicate.paymentId), code("ALLOWANCE_TASK_ALREADY_PAID"));
    const refunder = new Refunder(relay); await refunder.initialize();
    await assert.rejects(refunder.refund(first.paymentId, keccak256(toUtf8Bytes("delivered")), first.price), code("REFUND_NOT_ALLOWED"));
    await refunder.refund(duplicate.paymentId, keccak256(toUtf8Bytes("duplicate")), duplicate.price);
    f.admin.reset();
    const secondTask = await f.task(), secondInput = { ...input, taskId: String(secondTask) };
    const second = await relay.quote(secondInput);
    await tx(f.account, f.agent, "payProvider", [1n, f.payee, second.price, second.paymentId, EMPTY_AUTH, "0x"]);
    const changed = new InferenceAllowanceRelay(config, { ...terms, creditsRaw: "240000", provider: f.provider });
    try {
      await assert.rejects(changed.chat(secondInput, second.paymentId), code("ALLOWANCE_CONFIG_MISMATCH"));
      await new Refunder(changed).refund(second.paymentId, keccak256(toUtf8Bytes("config changed")), second.price);
    } finally { changed.close(); }
    f.admin.reset();
    const thirdTask = await f.task(), thirdInput = { ...input, taskId: String(thirdTask) };
    const third = await relay.quote(thirdInput);
    await tx(f.account, f.agent, "payProvider", [1n, f.payee, third.price, third.paymentId, EMPTY_AUTH, "0x"]);
    await tx(f.escrow, f.admin, "settle", [thirdTask, false]);
    await assert.rejects(relay.chat(thirdInput, third.paymentId), code("ALLOWANCE_TASK_UNAVAILABLE"));
    const fourthTask = await f.task(), fourthInput = { ...input, taskId: String(fourthTask) };
    const fourth = await relay.quote(fourthInput);
    await tx(f.account, f.agent, "payProvider", [1n, f.payee, fourth.price, fourth.paymentId, EMPTY_AUTH, "0x"]);
    const write = relay.store.write.bind(relay.store); let crash = true;
    relay.store.write = async record => {
      if (crash && record.state === "Delivered") { crash = false; throw new Error("controlled allowance commit failure"); }
      await write(record);
    };
    await assert.rejects(relay.chat(fourthInput, fourth.paymentId), /controlled allowance commit failure/);
    assert.equal((await relay.store.read(fourth.paymentId)).state, "Paid");
    const nonce = await f.provider.getTransactionCount(f.agentAddress), balance = await f.providerBalance();
    const restarted = new InferenceAllowanceRelay(config, { ...terms, provider: f.provider });
    try {
      await restarted.recover();
      assert.equal((await restarted.status(fourth.paymentId, "1", fourth.requestDigest)).state, "Delivered");
      assert.equal(await f.provider.getTransactionCount(f.agentAddress), nonce); assert.equal(await f.providerBalance(), balance);
    } finally { restarted.close(); }
  } finally { relay.close(); await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});
