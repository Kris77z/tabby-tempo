import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { verifyMagpie } from "../magpie-probe.js";

test("actual Magpie preserves tiers, cached payments, unknown-dispatch blocking and explicit-rejection refunds", { timeout: 120_000 }, async () => {
  assert.ok(process.env.MAGPIE_BIN, "Build the locked official Magpie with scripts/magpie-build.ts and set MAGPIE_BIN; this integration does not silently skip");
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-magpie-test-"));
  try {
    const report = await verifyMagpie({ binary: process.env.MAGPIE_BIN, output: directory, officialBinary: process.env.MAGPIE_OFFICIAL_BIN });
    assert.equal(report.verified, true);
    for (const scenario of ["paid-failure", "paid-503", "paid-408", "paid-409", "lost-response", "paid-invalid-response"]) {
      assert.ok(report.checks.some(check => check.name === `uncertain-${scenario}-no-resume-recover-or-refund-dispatch`));
    }
    assert.ok(report.checks.some(check => check.name === "explicit-rejection-keeps-original-price-and-never-redispatches"));
    assert.ok(report.checks.some(check => check.name === "original-payment-full-refund-without-new-dispatch"));
  } finally { await rm(directory, { recursive: true, force: true }); }
});
