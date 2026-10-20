import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, rmdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { InferCredit, PaymentError } from "@agentfuel/sdk";
import { fetchOrResume } from "../client.mjs";
import { body, startFixture } from "../fixture.mjs";
import { readHandle, writePrivateJson } from "../journal.mjs";

const code = expected => error => error instanceof PaymentError && error.code === expected;
const blocked = () => { throw new PaymentError("EXAMPLE_PAYMENT_BLOCKED", "Controlled guard prevents payment"); };
async function setup(t, fixtureOptions) {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-sdk-test-"));
  const fixture = await startFixture(fixtureOptions);
  t.after(async () => { await fixture.close(); await rm(directory, { recursive: true, force: true }); });
  const request = { options: { ...fixture.options, beforePayment: blocked }, relayUrl: fixture.relayUrl,
    body, handlePath: join(directory, "payment.json") };
  return { fixture, request };
}

test("installed SDK binds a 402, saves a durable handle, and resumes its original preset cache without signing", async t => {
  const { fixture, request } = await setup(t);
  await assert.rejects(fetchOrResume(request), code("EXAMPLE_PAYMENT_BLOCKED"));
  const original = await readHandle(request.handlePath);
  assert.equal(original.version, 1); assert.equal(original.quote.price, "10000");
  assert.equal(original.quote.taskId, "0"); assert.equal(original.submission, undefined);
  if (process.platform !== "win32") assert.equal((await stat(request.handlePath)).mode & 0o777, 0o600);
  await assert.rejects(fetchOrResume(request), code("EXAMPLE_PAYMENT_BLOCKED"));
  assert.deepEqual(await readHandle(request.handlePath), original);
  fixture.setDelivered(original);
  const cached = await fetchOrResume({ ...request, options: { ...request.options,
    beforePayment: () => assert.fail("A delivered cache read must not open new-payment admission") } });
  assert.equal(cached.result.mode, "fixture-only"); assert.equal(cached.handle.quote.paymentId, original.quote.paymentId);
  assert.deepEqual(fixture.counts, { quotes: 1, statuses: 3, transactionSends: 0, rawTransactionSends: 0 });
  assert.ok(!fixture.rpcMethods.some(method => /send|sign/i.test(method)));
});

test("task-bound request uses the same exported API and original task on resume", async t => {
  const { fixture, request } = await setup(t);
  request.taskId = "7";
  await assert.rejects(fetchOrResume(request), code("EXAMPLE_PAYMENT_BLOCKED"));
  const saved = await readHandle(request.handlePath);
  assert.equal(saved.quote.taskId, "7"); assert.equal(saved.input.taskId, "7");
  fixture.setDelivered(saved);
  assert.equal((await fetchOrResume(request)).handle.quote.paymentId, saved.quote.paymentId);
  assert.equal(fixture.counts.quotes, 1);
});

for (const [name, mutateQuote] of [
  ["wrong provider", quote => ({ ...quote, payTo: `0x${"99".repeat(20)}` })],
  ["wrong chain", quote => ({ ...quote, chainId: "1" })],
  ["changed request digest", quote => ({ ...quote, requestDigest: `0x${"00".repeat(32)}` })],
  ["price over per-request ceiling", quote => ({ ...quote, price: "10001" })],
]) {
  test(`untrusted quote is rejected before persistence or payment: ${name}`, async t => {
    const { fixture, request } = await setup(t, { mutateQuote });
    await assert.rejects(fetchOrResume(request), code("UNTRUSTED_QUOTE"));
    assert.equal(await readHandle(request.handlePath), undefined);
    assert.deepEqual(fixture.counts, { quotes: 1, statuses: 0, transactionSends: 0, rawTransactionSends: 0 });
  });
}

test("RPC chain mismatch rejects before requesting a quote", async t => {
  const { fixture, request } = await setup(t, { chainId: 1n });
  await assert.rejects(fetchOrResume(request), code("NETWORK_MISMATCH"));
  assert.equal(fixture.counts.quotes, 0);
});

test("persistence failure stops SDK before status lookup or payment admission", async t => {
  const { fixture, request } = await setup(t);
  const client = new InferCredit({ ...request.options, onHandle() { throw new Error("Controlled journal failure"); },
    beforePayment() { assert.fail("Persistence must complete first"); } });
  try { await assert.rejects(client.fetch(request.relayUrl, { body }), /Controlled journal failure/); }
  finally { client.close(); }
  assert.deepEqual(fixture.counts, { quotes: 1, statuses: 0, transactionSends: 0, rawTransactionSends: 0 });
});

test("changing the requested body or saved input cannot replace an uncertain purchase", async t => {
  const { fixture, request } = await setup(t);
  await assert.rejects(fetchOrResume(request), code("EXAMPLE_PAYMENT_BLOCKED"));
  const bytes = await readFile(request.handlePath, "utf8");
  await assert.rejects(fetchOrResume({ ...request, body: { ...body, temperature: 0.5 } }), code("CONFIG_HANDLE_MISMATCH"));
  assert.equal(await readFile(request.handlePath, "utf8"), bytes);
  const tampered = JSON.parse(bytes); tampered.input.messages = [];
  await writePrivateJson(request.handlePath, tampered);
  await assert.rejects(fetchOrResume(request), code("UNTRUSTED_QUOTE"));
  assert.equal(fixture.counts.quotes, 1); assert.equal(fixture.counts.transactionSends, 0);
});

test("exclusive journal ownership rejects a concurrent client before it can request another quote", async t => {
  const { fixture, request } = await setup(t);
  let entered, release;
  const admitted = new Promise(resolve => { entered = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const first = fetchOrResume({ ...request, options: { ...request.options, beforePayment: async () => {
    entered(); await held; blocked();
  } } });
  const finished = assert.rejects(first, code("EXAMPLE_PAYMENT_BLOCKED"));
  await admitted;
  try {
    await assert.rejects(fetchOrResume(request), code("JOURNAL_LOCKED"));
    assert.equal(fixture.counts.quotes, 1);
  } finally { release(); await finished; }
  await assert.rejects(fetchOrResume(request), code("EXAMPLE_PAYMENT_BLOCKED"));
  assert.equal(fixture.counts.quotes, 1);
});

test("an unknown existing journal lock is preserved for explicit operator resolution", async t => {
  const { fixture, request } = await setup(t);
  const lock = `${request.handlePath}.lock`;
  await mkdir(lock);
  await assert.rejects(fetchOrResume(request), code("JOURNAL_LOCKED"));
  assert.equal((await stat(lock)).isDirectory(), true);
  assert.equal(fixture.counts.quotes, 0);
  await rmdir(lock);
});
