import test from "node:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifyFixedPriceCredit } from "../../../scripts/verify-fixed-price-credit.js";

test("fixed-price Pi service draws once, independently repays/defaults, and refunds undelivered provider funds without redispatch", { timeout: 180000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "af-fp-"));
  try { await verifyFixedPriceCredit(directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
});
