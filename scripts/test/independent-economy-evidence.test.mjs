import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { buildReviewEvidence, projectFreshReviewEvidence, validateFreshReviewEvidenceManifestShape, validateEconomic, validateConsumer } from '../review-evidence.mjs';
import { independentEvidenceHash, validateIndependentEconomyReport, validateIndependentShadowReport } from '../lib/independent-economy-evidence.mjs';

const load = file => JSON.parse(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const execution = () => load('docs/acceptance/tempo-local-20261020/independent.json');
const shadow = () => load('docs/acceptance/tempo-local-20261020/independent-shadow.json');
const reject = mutate => { const data = execution(); mutate(data); assert.throws(() => validateIndependentEconomyReport(data)); };

test('fresh clean CI reports retain source state without changing saved historical dirty requirements', () => {
  for (const [kind, file, validate, source] of [
    ['local-economic', 'docs/acceptance/tempo-local-20261020/economic.json', validateEconomic, d => d.provenance.source],
    ['local-consumer', 'docs/acceptance/tempo-local-20261020/consumer.json', validateConsumer, d => d.source],
  ]) {
    const data = load(file); source(data).dirty = false;
    assert.throws(() => validate(data)); validate(data, { fresh: true });
    const manifest = projectFreshReviewEvidence(kind, data, { file: `${kind}.json`, sha256: 'a'.repeat(64) });
    assert.equal(manifest.sources[0].implementation.dirty, false);
    assert.equal(manifest.sources[0].sha256, 'a'.repeat(64));
    assert.equal(manifest.scope.mode, 'fresh-local-evidence-consistency');
    validateFreshReviewEvidenceManifestShape(manifest);
  }
});

test('fresh public references are bounded relative JSON artifacts and never arbitrary local files', () => {
  const data = load('docs/acceptance/tempo-local-20261020/economic.json');
  for (const file of ['/tmp/private.json', '../private.json', 'public/../../private.json', 'https://private.invalid/data.json', 'a'.repeat(300) + '.json'])
    assert.throws(() => projectFreshReviewEvidence('local-economic', data, { file, sha256: 'a'.repeat(64) }));
});

test('independent source and real observation clocks cannot be omitted or moved to future history', () => {
  reject(d => { delete d.provenance.sourceSha256['packages/sdk/src/index.ts']; });
  reject(d => { d.provenance.sourceSha256['../../private.key'] = 'a'.repeat(64); });
  reject(d => { d.durationMs += 1; });
  reject(d => { d.rounds[0].observation.nowMs = Number.NaN; });
  reject(d => { d.rounds[0].observation.candidates[0].observedAtMs = Date.parse(d.completedAt) + 1; });
  reject(d => { d.rounds[1].observation.history[0].atMs = Date.parse(d.completedAt) + 1; });
});

test('published fee, original quote and terminal replay retain their actual bindings', () => {
  reject(d => { d.rounds[0].observation.candidates[0].protocolFeeBps = '1'; });
  reject(d => { d.rounds[0].quote.requestDigest = '0x' + 'a'.repeat(64); });
  reject(d => { d.rounds[0].observation.candidates.find(c => c.taskId === d.rounds[0].taskId).expiresAtMs = d.rounds[0].observation.nowMs; });
  reject(d => { d.replay.after.acceptanceEvents += 1; });
  reject(d => { d.final.stopReason = 'TIME_LIMIT'; });
});

test('frozen task count applies even when every recorded policy hash is recomputed', () => {
  reject(d => {
    d.policy.maxTasks = 1; d.policySha256 = independentEvidenceHash(d.policy);
    for (const r of d.rounds) { r.policySha256 = d.policySha256; r.bindings.policySha256 = d.policySha256; }
    for (const i of d.interruptions) { i.original.policySha256 = d.policySha256; i.recovered.policySha256 = d.policySha256; }
    if (d.unknown.interruption) { d.unknown.interruption.original.policySha256 = d.policySha256; d.unknown.interruption.recovered.policySha256 = d.policySha256; }
  });
});

test('fresh independent execution and shadow manifests bind their supplied public artifacts', () => {
  for (const [kind, data, validate] of [['local-independent', execution(), validateIndependentEconomyReport], ['local-independent-shadow', shadow(), validateIndependentShadowReport]]) {
    validate(data);
    const before = structuredClone(data), manifest = projectFreshReviewEvidence(kind, data, { file: `${kind}.json`, sha256: 'b'.repeat(64) });
    assert.equal(manifest.sources[0].sha256, 'b'.repeat(64)); assert.equal(manifest.sources.length, 1); assert.ok(manifest.timeline.length > 0);
    assert.deepEqual(data, before); validateFreshReviewEvidenceManifestShape(manifest);
  }
});

test('independent replay interleaves real process recovery and resolves Unknown before continued work', () => {
  const data = execution(), manifest = projectFreshReviewEvidence('local-independent', data, { file: 'local-independent.json', sha256: 'b'.repeat(64) });
  const timeline = manifest.timeline;
  const event = (requestId, type, title) => {
    const matches = timeline.filter(e => e.requestId === requestId && e.type === type && (!title || e.title === title));
    assert.equal(matches.length, 1, `unique ${type} for original request`); return matches[0];
  };
  const before = (left, right) => assert.ok(timeline.indexOf(left) < timeline.indexOf(right), `${left.title} precedes ${right.title}`);
  for (const [index, round] of data.rounds.entries()) {
    const selected = event(round.requestId, 'decision-selected'), accepted = event(round.requestId, 'task-accepted');
    const paid = event(round.requestId, 'provider-paid'), settled = event(round.requestId, round.outcome === 'succeeded' ? 'task-settled' : 'task-failed');
    before(selected, accepted); before(accepted, paid); before(paid, settled);
    if (data.rounds[index + 1]) before(settled, event(data.rounds[index + 1].requestId, 'decision-selected'));
    for (const interruption of data.interruptions.filter(i => i.original.requestId === round.requestId)) {
      const restarted = timeline.filter(e => e.requestId === round.requestId && e.type === 'worker-process-restarted');
      if (interruption.checkpoint === 'before-payment') { before(accepted, restarted[0]); before(restarted[0], paid); }
      if (interruption.checkpoint === 'after-payment') { before(paid, restarted[1]); before(restarted[1], settled); }
      if (interruption.checkpoint === 'after-settlement') { before(settled, restarted[2]); before(restarted[2], event(data.rounds[index + 1].requestId, 'decision-selected')); }
    }
  }
  const unknown = data.unknown, blocked = event(unknown.requestId, 'payment-unknown'), refunded = event(unknown.requestId, 'original-payment-refunded');
  const terminated = event(unknown.requestId, 'task-failed'), resolved = event(unknown.requestId, 'unknown-resolved');
  const recovered = event(unknown.requestId, 'worker-process-restarted');
  before(event(unknown.requestId, 'provider-paid'), blocked); before(blocked, refunded); before(refunded, terminated); before(terminated, resolved); before(resolved, recovered);
  before(recovered, event(unknown.continuedRequestId, 'decision-selected'));
  assert.equal(refunded.txHash, unknown.resolution.receipt.txHash); assert.equal(terminated.txHash, unknown.resolution.taskTermination.txHash);
  assert.equal(timeline.filter(e => e.type === 'worker-process-restarted').length, data.interruptions.length);
  const saved = buildReviewEvidence().claims.find(c => c.reportId === 'tempo-owned-independent-20261020');
  const order = events => events.map(({ type, requestId, txHash, title }) => ({ type, requestId, txHash, title }));
  assert.deepEqual(order(saved.timeline), order(timeline), 'saved and fresh artifacts expose the same causal sequence');
  data.interruptions.reverse();
  assert.deepEqual(order(projectFreshReviewEvidence('local-independent', data, { file: 'local-independent.json', sha256: 'b'.repeat(64) }).timeline), order(timeline), 'checkpoint array ordering cannot reorder the operating history');
});
