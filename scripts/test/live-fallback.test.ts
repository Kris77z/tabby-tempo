import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditFallback, verifyLiveFallback } from "../verify-live-fallback.js";

async function setup() {
  const dir = await mkdtemp(join(tmpdir(), "agentfuel-fallback-"));
  const config = join(dir, "config.json"), key = join(dir, "key");
  await writeFile(key, "synthetic", { mode: 0o600 });
  await writeFile(config, JSON.stringify({ upstream: { name: "kimi", model: "kimi-k2.6", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: key } }), { mode: 0o600 });
  return { dir, config, output: join(dir, "evidence") };
}

test("fallback: one injected rejection, one delivery, original receipt on replay/restart; audit rejects changed evidence", { timeout: 120000 }, async () => {
  const f = await setup(); let calls = 0;
  try {
    const upstream: typeof fetch = async (_url, init) => {
      calls++; const request = JSON.parse(String(init?.body));
      assert.equal(request.model, "kimi-k2.6"); assert.equal(request.max_completion_tokens, 128);
      return Response.json({ model: "kimi-k2.6", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "OK" } }], usage: { prompt_tokens: 11, completion_tokens: 1, total_tokens: 12 } });
    };
    assert.equal((await verifyLiveFallback({ config: f.config }, upstream)).execute, false); assert.equal(calls, 0);
    const report = await verifyLiveFallback({ ...f, execute: true }, upstream);
    assert.equal(report.status, "Complete", JSON.stringify(report)); assert.equal(calls, 1);
    assert.equal((await auditFallback(f.output)).verified, true);
    const filename = join(f.output, "physical-response.json");
    const original = await readFile(filename, "utf8"), changed = JSON.parse(original); changed.usage.total_tokens++;
    await writeFile(filename, JSON.stringify(changed)); await assert.rejects(auditFallback(f.output)); await writeFile(filename, original);
    const handle = JSON.parse(await readFile(join(f.output, "handle.json"), "utf8"));
    const paths = [filename, join(f.output, "receipt.json"), join(f.output, "relay", handle.quote.paymentId + ".json")];
    const originals = await Promise.all(paths.map(path => readFile(path, "utf8")));
    for (const usage of [{ prompt_tokens: 11, completion_tokens: 129, total_tokens: 140 }, { prompt_tokens: 11, completion_tokens: 1, total_tokens: 13 }]) {
      const values = originals.map(text => JSON.parse(text));
      values[0].usage = usage; values[1].usage = usage; values[2].result.usage = usage; values[2].receipt.usage = usage;
      await Promise.all(paths.map((path, i) => writeFile(path, JSON.stringify(values[i]))));
      await assert.rejects(auditFallback(f.output));
    }
    await Promise.all(paths.map((path, i) => writeFile(path, originals[i])));
    await assert.rejects(verifyLiveFallback({ ...f, execute: true }, upstream)); assert.equal(calls, 1);
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});

test("fallback: unknown second dispatch stops without a new call or a success claim", { timeout: 120000 }, async () => {
  const f = await setup(); let calls = 0;
  try {
    const report = await verifyLiveFallback({ ...f, execute: true }, async () => { calls++; throw new Error("synthetic transport disconnect"); });
    assert.equal(report.status, "Incomplete"); assert.equal(calls, 1);
    const handle = JSON.parse(await readFile(join(f.output, "handle.json"), "utf8"));
    const record = JSON.parse(await readFile(join(f.output, "relay", handle.quote.paymentId + ".json"), "utf8"));
    assert.equal(record.state, "Processing"); assert.deepEqual(record.upstreamAttempts.map((a: any) => a.state), ["Rejected", "Unknown"]);
    await assert.rejects(auditFallback(f.output));
  } finally { await rm(f.dir, { recursive: true, force: true }); }
});
