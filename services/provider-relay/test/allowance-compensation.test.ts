import assert from "node:assert/strict";
import test from "node:test";
import { once } from "node:events";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toUtf8Bytes } from "ethers";
import { InferCredit, canonical } from "@agentfuel/sdk";
import { fixture, key, read, startAnvil, stopAnvil } from "../../underwriter/test/fixture.js";
import { ALLOWANCE_MODEL, ALLOWANCE_SERVICE, allowanceBody, InferenceAllowanceRelay } from "../src/allowance.js";
import { allowanceCertificateDigest, type AllowanceClosure } from "../src/store.js";
import type { RelayConfig } from "../src/config.js";
import { createHttpServer } from "../src/http.js";
import { Refunder } from "../src/refunder.js";
const hash = (v: string) => keccak256(toUtf8Bytes(v));
const code = (expected: string) => (error: any) => error?.code === expected;

test("delivered allowance compensation requires a verified sealed ledger and permanently closes the original payment", { timeout: 120000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-allowance-compensation-")), local = await startAnvil();
  const f = await fixture(local.rpc, join(directory, "underwriter"), 6);
  const terms = { creditsRaw: "200000", modelCatalogDigest: hash("two models") };
  const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6,
    payTo: f.payee, service: { id: ALLOWANCE_SERVICE, model: ALLOWANCE_MODEL, price: 120000n,
      upstreams: [{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/ledger", key: "unused" }] },
    dataDir: join(directory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788,
    operatorToken: "synthetic-local-operator-token-32", frontendOrigin: "http://localhost:3000", refunderKey: key(1) };
  const ledgerPath = join(directory, "sealed-ledger.json"); let upstreamCalls = 0;
  const options = { ...terms, provider: f.provider, upstreamFetch: (async () => { upstreamCalls++; throw new Error("No inference in allowance service"); }) as typeof fetch,
    verifyAllowanceClosure: async (closure: AllowanceClosure) => {
      try {
        const ledger = JSON.parse(await readFile(ledgerPath, "utf8")), { closure: saved, ...original } = ledger;
        return canonical(saved) === canonical(closure as any) && closure.expectedLedgerDigest === createHash("sha256").update(canonical(original)).digest("hex") &&
          ledger.invocations.some((v: any) => v.state === "Unknown") && ledger.invocations.every((v: any) => v.state === "Unknown") && ledger.grants.length === 1 && ledger.grants[0].paymentId === closure.paymentId;
      } catch { return false; }
    } };
  const serve = async (port = 0) => {
    const relay = new InferenceAllowanceRelay(config, options), refunder = new Refunder(relay); await relay.initialize(); await refunder.initialize();
    const server = createHttpServer(relay, refunder); server.listen(port, "127.0.0.1"); await once(server, "listening"); const actualPort = (server.address() as { port: number }).port;
    const url = `http://127.0.0.1:${actualPort}`;
    const request = async (path: string, body: unknown, headers = {}) => {
      const response = await fetch(url + path, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) }); return { status: response.status, body: await response.json() as any };
    };
    return { relay, refunder, url, port: actualPort, request, close: async () => { await new Promise<void>(resolve => server.close(() => resolve())); relay.close(); } };
  };
  let running = await serve(); const auth = { authorization: `Bearer ${config.operatorToken}` };
  const infer = new InferCredit({ agentId: "1", sessionKey: key(2), rpcUrl: local.rpc, chainId: 31337n, account: config.account,
    asset: config.asset, provider: config.payTo, maxPrice: config.service.price, underwriterUrl: f.http });
  try {
    const taskId = await f.task(), delivered = await infer.forTask(String(taskId)).fetch(running.url + "/v1/chat", { body: allowanceBody(terms) });
    const id = delivered.handle.quote.paymentId, original = await running.relay.store.read(id);
    const ledger = { binding: { agentId: "1", taskId: String(taskId), wallet: f.agentAddress }, grants: [{ paymentId: id }], invocations: [{ id: "round:0", state: "Unknown", httpStatus: 503 }] };
    const closure: AllowanceClosure = { version: 1, paymentId: id, resolutionId: randomUUID(), evidenceDigest: hash("operator accepts unknown supplier cost"), reason: "operator-accepted-unknown-cost",
      expectedLedgerDigest: createHash("sha256").update(canonical(ledger)).digest("hex"), binding: ledger.binding, sealedAt: Date.now() };
    const input = { paymentId: id, resolutionId: closure.resolutionId, evidenceDigest: closure.evidenceDigest, closure, certificateDigest: allowanceCertificateDigest(closure) };
    const refund = { paymentId: id, refundId: hash("full allowance compensation"), amount: "120000" };
    const restart = async () => { const port = running.port; await running.close(); running = await serve(port); await running.relay.recover(); };
    await t.test("ordinary delivery is nonrefundable and unverified/auth-invalid certificates cannot enable compensation", async () => {
      await assert.rejects(running.refunder.refund(id, refund.refundId, refund.amount), code("REFUND_NOT_ALLOWED"));
      assert.equal((await running.request("/ops/compensate-allowance", input)).status, 403);
      assert.equal((await running.request("/ops/compensate-allowance", input, { ...auth, origin: config.frontendOrigin! })).status, 403);
      assert.equal((await running.request("/ops/compensate-allowance", { ...input, certificateDigest: hash("wrong") }, auth)).status, 400);
      assert.equal((await running.request("/ops/compensate-allowance", input, auth)).body.error, "ALLOWANCE_CLOSURE_UNVERIFIED");
      const disabled = new InferenceAllowanceRelay(config, { ...terms, provider: f.provider });
      try { await assert.rejects(disabled.compensateAllowance(input), code("ALLOWANCE_CLOSURE_UNVERIFIED")); } finally { disabled.close(); }
      assert.equal((await running.relay.store.read(id)).operatorCompensation, undefined);
    });
    await t.test("wrong task/wallet/evidence/ledger binding fails even for an authenticated operator", async () => {
      for (const wrong of [{ ...closure, binding: { ...closure.binding, taskId: String(BigInt(taskId) + 1n) } },
        { ...closure, binding: { ...closure.binding, wallet: f.payee } }]) {
        await writeFile(ledgerPath, JSON.stringify({ ...ledger, closure: wrong }));
        assert.equal((await running.request("/ops/compensate-allowance", { ...input, closure: wrong, certificateDigest: allowanceCertificateDigest(wrong) }, auth)).body.error, "ALLOWANCE_COMPENSATION_CONFLICT");
      }
      await writeFile(ledgerPath, JSON.stringify({ ...ledger, closure }));
      const wrongReceipt = structuredClone(original); wrongReceipt.receipt!.blockHash = hash("noncanonical saved receipt"); await running.relay.store.write(wrongReceipt);
      assert.equal((await running.request("/ops/compensate-allowance", input, auth)).body.error, "ALLOWANCE_COMPENSATION_CONFLICT");
      await running.relay.store.write(original);
      assert.equal((await running.request("/ops/compensate-allowance", { ...input, evidenceDigest: hash("other") }, auth)).status, 400);
      const wrongDigest = { ...closure, expectedLedgerDigest: "a".repeat(64) };
      assert.equal((await running.request("/ops/compensate-allowance", { ...input, closure: wrongDigest, certificateDigest: allowanceCertificateDigest(wrongDigest) }, auth)).body.error, "ALLOWANCE_CLOSURE_UNVERIFIED");
    });
    await t.test("durable decision crash preserves delivery evidence but permanently blocks status delivery and new quote", async () => {
      const task = await read(f.escrow, "getTask", [taskId]);
      await f.provider.send("evm_setNextBlockTimestamp", [Number(task.deadline) + 1]); await f.provider.send("evm_mine", []);
      const write = running.relay.store.write.bind(running.relay.store);
      running.relay.store.write = async r => { await write(r); if (r.operatorCompensation) throw new Error("controlled decision commit crash"); };
      assert.equal((await running.request("/ops/compensate-allowance", input, auth)).status, 503); await restart();
      const status = await running.relay.status(id, "1", delivered.handle.quote.requestDigest);
      assert.equal(status.state, "CompensationPending"); assert.equal(status.result, undefined); assert.equal(status.receipt, undefined);
      assert.deepEqual(status.originalDelivery, { result: original.result, receipt: original.receipt });
      const saved = (await running.relay.store.read(id)).operatorCompensation;
      assert.deepEqual((await running.request("/ops/compensate-allowance", input, auth)).body.operatorCompensation, saved);
      const changed = { ...closure, resolutionId: randomUUID() };
      assert.equal((await running.request("/ops/compensate-allowance", { ...input, resolutionId: changed.resolutionId, closure: changed, certificateDigest: allowanceCertificateDigest(changed) }, auth)).body.error, "ALLOWANCE_COMPENSATION_CONFLICT");
      await assert.rejects(infer.resume(delivered.handle), code("ALLOWANCE_COMPENSATED"));
      await assert.rejects(running.relay.quote(delivered.handle.input), code("ALLOWANCE_COMPENSATED"));
      await assert.rejects(running.relay.deliver(await running.relay.store.read(id)), code("ALLOWANCE_COMPENSATED"));
    });
    await t.test("full compensation recovers after crash, closes credit by refund without default, and never regrants", async () => {
      assert.equal((await running.request("/ops/refund", { ...refund, amount: "40000" }, auth)).body.error, "OPERATOR_REFUND_FULL_ONLY");
      const write = running.relay.store.write.bind(running.relay.store);
      running.relay.store.write = async r => { await write(r); if (r.refunds.length) throw new Error("controlled refund intent crash"); };
      assert.equal((await running.request("/ops/refund", refund, auth)).status, 503); await restart(); await running.refunder.recover();
      const record = await running.relay.store.read(id), loan = await read(f.manager, "getLoan", [taskId]);
      assert.equal(record.state, "Refunded"); assert.deepEqual(record.result, original.result); assert.deepEqual(record.receipt, original.receipt);
      assert.equal(loan.status, 4n); assert.equal(loan.principal + loan.fee, 0n); assert.equal(await read(f.manager, "defaultCount", [1n]), 0n); assert.equal(await read(f.manager, "repaymentCount", [1n]), 0n);
      assert.equal((await read(f.account, "getPayment", [id])).refundedAmount, 120000n); assert.equal(await read(f.account, "cash", [1n]), 40000n);
      const agentNonce = await f.provider.getTransactionCount(f.agentAddress), adminNonce = await f.provider.getTransactionCount(await f.admin.getAddress());
      const replay = await running.request("/ops/refund", refund, auth); assert.equal(replay.status, 200); assert.equal(replay.body.state, "Refunded"); assert.equal(replay.body.refundPending, false);
      assert.deepEqual(replay.body.originalDelivery, { result: original.result, receipt: original.receipt });
      assert.equal((await running.request("/ops/refund", { ...refund, refundId: hash("another refund") }, auth)).body.error, "OPERATOR_REFUND_FULL_ONLY");
      await restart(); await running.refunder.recover(); await assert.rejects(infer.resume(delivered.handle), code("REFUNDED"));
      await assert.rejects(running.relay.chat(delivered.handle.input, id), code("ALLOWANCE_COMPENSATED")); await assert.rejects(running.relay.quote(delivered.handle.input), code("ALLOWANCE_COMPENSATED"));
      assert.equal(await f.provider.getTransactionCount(f.agentAddress), agentNonce); assert.equal(await f.provider.getTransactionCount(await f.admin.getAddress()), adminNonce); assert.equal(upstreamCalls, 0);
    });
  } finally { infer.close(); await running.close(); await f.close(); await stopAnvil(local.child); await rm(directory, { recursive: true, force: true }); }
});
