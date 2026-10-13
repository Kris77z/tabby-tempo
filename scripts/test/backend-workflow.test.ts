import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { verifyBackend } from "../verify-backend.js";

test("backend bridge and HTTP workflow use one fixed purchase, canonical receipts and original recovery", { timeout: 120000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "af-backend-verify-")));
  try {
    const result = await verifyBackend({ output: join(directory, "run"), controlled: true });
    assert.equal(result.completed, true); assert.equal(result.mode, "controlled"); assert.equal(result.physicalCalls, 1);
    assert.equal(result.originalRecoveryNoNewPaymentOrModel, true); assert.equal(result.canonicalReceipts, 3);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
