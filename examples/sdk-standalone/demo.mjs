import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PaymentError } from "@agentfuel/sdk";
import { fetchOrResume } from "./client.mjs";
import { body, startFixture } from "./fixture.mjs";
import { readHandle } from "./journal.mjs";

const directory = await mkdtemp(join(tmpdir(), "agentfuel-sdk-demo-"));
const fixture = await startFixture();
try {
  const arguments_ = { options: { ...fixture.options, beforePayment() {
    throw new PaymentError("EXAMPLE_PAYMENT_BLOCKED", "The default example never signs or sends payment");
  } }, relayUrl: fixture.relayUrl, body, handlePath: join(directory, "payment.json") };
  await assert.rejects(fetchOrResume(arguments_), error => error instanceof PaymentError && error.code === "EXAMPLE_PAYMENT_BLOCKED");
  const handle = await readHandle(arguments_.handlePath);
  assert.equal(handle.submission, undefined);
  await assert.rejects(fetchOrResume(arguments_), error => error instanceof PaymentError && error.code === "EXAMPLE_PAYMENT_BLOCKED");
  assert.equal((await readHandle(arguments_.handlePath)).quote.paymentId, handle.quote.paymentId);
  fixture.setDelivered(handle);
  const cached = await fetchOrResume(arguments_);
  assert.equal(cached.result.mode, "fixture-only");
  assert.equal(cached.handle.quote.paymentId, handle.quote.paymentId);
  assert.deepEqual(fixture.counts, { quotes: 1, statuses: 3, transactionSends: 0, rawTransactionSends: 0 });
  console.log("SDK smoke passed: bound 402 -> durable handle -> blocked payment -> same-handle resume -> preset cache.");
  console.log("Controlled loopback fixtures only: 1 quote, 0 signing/sends, 0 model calls. No chain payment was proven.");
} finally { await fixture.close(); await rm(directory, { recursive: true, force: true }); }
