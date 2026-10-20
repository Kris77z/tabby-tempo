import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { buildReviewArtifacts, verifyReviewArtifacts } from '../review-artifacts.mjs';
import { buildReviewEvidence } from '../review-evidence.mjs';

async function fixture(t) {
  const dir = await mkdtemp(join(tmpdir(), 'af-artifact-test-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return join(dir, 'bundle');
}
const metadata = async () => ({ revision: 'a'.repeat(40), dirty: true, node: process.version, ci: {} });
test('offline bundle checks bytes and rejects reuse, tamper and unexpected files', async t => {
  const output = await fixture(t);
  const index = await buildReviewArtifacts({ output, metadata, run: async args => { assert.deepEqual(args, ['scripts/review-check.mjs']); return 0; } });
  assert.equal(index.status, 'passed');
  assert.equal((await verifyReviewArtifacts(output)).status, 'passed');
  await assert.rejects(buildReviewArtifacts({ output, metadata }), /EEXIST/);
  const file = join(output, 'README.txt'), original = await readFile(file);
  await writeFile(file, 'modified');
  await assert.rejects(verifyReviewArtifacts(output), /ARTIFACT_HASH_MISMATCH/);
  await writeFile(file, original);
  await writeFile(join(output, 'private-wallet.json'), 'secret');
  await assert.rejects(verifyReviewArtifacts(output), /UNEXPECTED_ARTIFACT/);
});
test('artifact verification rejects symlinks even when bytes match', async t => {
  const output = await fixture(t);
  await buildReviewArtifacts({ output, metadata, run: async () => 0 });
  const target = join(output, '..', 'outside.txt');
  await writeFile(target, await readFile(join(output, 'README.txt')));
  await rm(join(output, 'README.txt'));
  await symlink(target, join(output, 'README.txt'));
  await assert.rejects(verifyReviewArtifacts(output), /REGULAR_ARTIFACT_REQUIRED/);
});
test('failed commands produce fixed diagnostics without leaking exception text or importing private files', async t => {
  const output = await fixture(t), privatePaths = [];
  const secret = 'PRIVATE_RESPONSE_OR_SIGNED_TRANSACTION_MUST_NEVER_APPEAR';
  const index = await buildReviewArtifacts({ output, executeLocal: true, metadata, run: async args => {
    const file = args.at(-1); privatePaths.push(file);
    await writeFile(file, JSON.stringify({ secret }));
    throw Error(secret);
  } });
  assert.equal(index.status, 'failed');
  assert.equal(index.checks.filter(c => c.code === 'LOCAL_CHECK_OR_EVIDENCE_FAILED').length, 5);
  assert.equal((await verifyReviewArtifacts(output)).status, 'failed');
  for (const name of await readdir(output)) assert.ok(!(await readFile(join(output, name), 'utf8')).includes(secret));
  for (const file of privatePaths) await assert.rejects(readFile(file), /ENOENT/);
});
test('fresh semantic projections discard arbitrary report additions and bind artifact hashes', async t => {
  const output = await fixture(t), source = buildReviewEvidence();
  const secret = 'ARBITRARY_RAW_REPORT_EXTRA';
  const index = await buildReviewArtifacts({ output, executeLocal: true, metadata,
    run: async args => { await writeFile(args.at(-1), JSON.stringify({ privateExtra: secret })); return 0; },
    project: (kind, raw, ref) => {
      assert.equal(raw.privateExtra, secret);
      return { schemaVersion: 1, scope: { mode: 'test' }, sources: [{ ...source.sources[0], file: ref.file, sha256: ref.sha256 }],
        claims: [{ ...source.claims[0], checkedFacts: { validated: true }, bindings: {}, timeline: [] }], timeline: [] };
    } });
  assert.equal(index.status, 'passed');
  for (const name of await readdir(output)) assert.ok(!(await readFile(join(output, name), 'utf8')).includes(secret));
  // Injected shape deliberately isn't the production semantic validator.
  await assert.rejects(verifyReviewArtifacts(output));
});
test('saved validation failure stays visible with no fabricated saved evidence', async t => {
  const output = await fixture(t);
  const index = await buildReviewArtifacts({ output, metadata, run: async () => 0, saved: () => { throw Error('private details'); } });
  assert.equal(index.status, 'failed');
  assert.ok(!(await readdir(output)).includes('saved-evidence.json'));
  assert.equal((await verifyReviewArtifacts(output)).status, 'failed');
});
test('a rechecksummed bundle cannot remove required checks or rename them', async t => {
  const output = await fixture(t);
  await buildReviewArtifacts({ output, metadata, run: async () => 0 });
  const index = JSON.parse(await readFile(join(output, 'index.json'), 'utf8'));
  index.checks.shift();
  const bytes = JSON.stringify(index, null, 2) + '\n';
  await writeFile(join(output, 'index.json'), bytes);
  const sums = (await readFile(join(output, 'SHA256SUMS'), 'utf8')).replace(/^[a-f0-9]{64}  index\.json$/m, createHash('sha256').update(bytes).digest('hex') + '  index.json');
  await writeFile(join(output, 'SHA256SUMS'), sums);
  await assert.rejects(verifyReviewArtifacts(output), /INCOMPLETE_CHECK_SET/);
});
