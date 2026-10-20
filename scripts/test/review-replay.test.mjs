import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { readFile, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { renderReviewReplay, createReplayServer } from '../review-replay.mjs';

const manifest = { schemaVersion: 1, sources: [], claims: [], timeline: [] };
test('embedded evidence cannot terminate JSON script or inject executable markup', async () => {
  const attack = '</script><script>alert("not evidence")</script>&\u2028\u2029';
  const source = { ...manifest, claims: [{ id: attack, checkedFacts: { value: attack } }] };
  const rendered = await renderReviewReplay(source, { generatedAt: 'fixed' });
  const data = rendered.document.match(/<script id="evidence-data" type="application\/json">([\s\S]*?)<\/script>/)[1];
  assert.equal(data.includes('<'), false); assert.equal(data.includes('&'), false);
  assert.deepEqual(JSON.parse(data), { manifest: source, generatedAt: 'fixed' });
  assert.equal(rendered.document.includes(attack), false);
  assert.equal((rendered.document.match(/<script(?:\s|>)/g) || []).length, 2);
});
test('portable viewer has exact inline hashes and denies all network connections', async () => {
  const rendered = await renderReviewReplay(manifest);
  for (const [, bytes] of rendered.document.matchAll(/<(?:style|script)(?:\s[^>]+)?>([\s\S]*?)<\/(?:style|script)>/g)) {
    assert.ok(rendered.csp.includes(`'sha256-${createHash('sha256').update(bytes).digest('base64')}'`));
  }
  assert.ok(rendered.csp.includes("default-src 'none'")); assert.ok(rendered.csp.includes("connect-src 'none'"));
  const client = await readFile(new URL('../review-replay/client.js', import.meta.url), 'utf8');
  assert.doesNotMatch(client, /\b(?:fetch|eval|XMLHttpRequest|WebSocket)\s*\(|\.innerHTML\s*=/);
  await assert.rejects(renderReviewReplay({ ...manifest, schemaVersion: 2 }), /REPLAY_MANIFEST_INVALID/);
});
test('local server only serves its embedded document, with no action endpoint or file browsing', async () => {
  const rendered = await renderReviewReplay(manifest), server = createReplayServer(rendered);
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const get = await fetch(base); assert.equal(get.status, 200); assert.equal(await get.text(), rendered.document);
    assert.equal(get.headers.get('content-security-policy'), rendered.csp);
    assert.equal(get.headers.get('cache-control'), 'no-store');
    const head = await fetch(base, { method: 'HEAD' }); assert.equal(head.status, 200); assert.equal(await head.text(), '');
    assert.equal((await fetch(`${base}/api/execute`, { method: 'POST' })).status, 405);
    assert.equal((await fetch(`${base}/package.json`)).status, 404);
    assert.equal((await fetch(`${base}/?path=/etc/passwd`)).status, 404);
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
});
test('CLI refuses invalid arguments and never overwrites a saved artifact', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'tabby-replay-test-'));
  try {
    const file = join(directory, 'existing.html'); await writeFile(file, 'original');
    const run = args => spawnSync(process.execPath, ['scripts/review-replay.mjs', ...args], { encoding: 'utf8', timeout: 30000 });
    const invalid = run(['--output', 'relative.html']); assert.equal(invalid.status, 1); assert.match(invalid.stderr, /REPLAY_USAGE_INVALID/);
    const existing = run(['--output', file]); assert.equal(existing.status, 1); assert.match(existing.stderr, /REPLAY_OUTPUT_EXISTS/);
    assert.equal(await readFile(file, 'utf8'), 'original');
  } finally { await rm(directory, { recursive: true, force: true }); }
});
