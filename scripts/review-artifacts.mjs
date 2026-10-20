import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, writeFile, readdir, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, isAbsolute, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { buildReviewEvidence, projectFreshReviewEvidence, validateFreshReviewEvidenceManifestShape } from './review-evidence.mjs';
import { renderReviewReplay } from './review-replay.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const json = value => JSON.stringify(value, null, 2) + '\n';
const suites = Object.freeze([
  ['local-economic', 'scripts/check-economic-loop.mjs', []],
  ['local-consumer', 'scripts/check-publisher-worker.mjs', []],
  ['local-bounded', 'scripts/check-bounded-economy.mjs', ['--execute-local']],
  ['local-independent-shadow', 'scripts/check-independent-economy.mjs', []],
  ['local-independent', 'scripts/check-independent-economy.mjs', ['--execute-local']],
]);
const names = new Set(['index.json', 'README.txt', 'SHA256SUMS', 'saved-evidence.json', 'saved-replay.html',
  ...suites.flatMap(([name]) => [`${name}.json`, `${name}-evidence.json`, `${name}-replay.html`])]);

// Commands are fixed by this module. Neither command output nor exception text
// enters an artifact: launchers can touch private journals and signed payments.
export async function runArtifactCheck(args) {
  return new Promise(resolveResult => {
    const child = spawn(process.execPath, args, { cwd: root, stdio: 'ignore' });
    child.once('error', () => resolveResult(1));
    child.once('exit', code => resolveResult(Number.isInteger(code) ? code : 1));
  });
}

async function gitMetadata() {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);
  const revision = (await exec('git', ['rev-parse', 'HEAD'], { cwd: root })).stdout.trim();
  assert.match(revision, /^[a-f0-9]{40}$/);
  const dirty = Boolean((await exec('git', ['status', '--porcelain'], { cwd: root })).stdout.trim());
  const ci = {};
  for (const [name, env] of [['runId', 'GITHUB_RUN_ID'], ['runAttempt', 'GITHUB_RUN_ATTEMPT']]) {
    if (/^\d{1,30}$/.test(process.env[env] ?? '')) ci[name] = process.env[env];
  }
  return { revision, dirty, node: process.version, ci };
}

/** Only new owned directories are populated. Dependency injection is for local
 * negative tests; the CLI has no command, report-import or remote endpoint flag. */
export async function buildReviewArtifacts({ output, executeLocal = false, run = runArtifactCheck,
  saved = buildReviewEvidence, project = projectFreshReviewEvidence, metadata = gitMetadata } = {}) {
  assert.ok(isAbsolute(output), 'ABSOLUTE_NEW_OUTPUT_DIRECTORY_REQUIRED');
  await mkdir(output, { mode: 0o700 }); // EEXIST is an error, including symlinks.
  const privateDirectory = await mkdtemp(join(tmpdir(), 'agentfuel-review-artifacts-'));
  const files = [], checks = [];
  const index = { schemaVersion: 1, mode: executeLocal ? 'fresh-local-integration' : 'offline-review',
    status: 'failed', generatedAt: new Date().toISOString(), source: null,
    scope: { productionDeploymentChanged: false, publicChainExecution: false, rawJournalsIncluded: false,
      provenance: 'Local observation and byte checksums, not an external attestation.' }, checks, files };
  const emit = async (name, bytes) => {
    assert.ok(names.has(name) && !files.some(file => file.name === name), 'FIXED_UNIQUE_ARTIFACT_REQUIRED');
    await writeFile(join(output, name), bytes, { flag: 'wx', mode: 0o600 });
    files.push({ name, sha256: hash(bytes) });
  };
  try {
    index.source = await metadata();
    if (!executeLocal) {
      console.error('review-artifacts: offline checks');
      const code = await run(['scripts/review-check.mjs']);
      checks.push({ name: 'offline-review', status: code === 0 ? 'passed' : 'failed', code: code === 0 ? 'CHECK_PASSED' : 'CHECK_FAILED' });
    }
    try {
      const manifest = await saved();
      await emit('saved-evidence.json', json(manifest));
      await emit('saved-replay.html', (await renderReviewReplay(manifest)).document);
      checks.push({ name: 'saved-evidence', status: 'passed', code: 'CHECK_PASSED' });
    } catch { checks.push({ name: 'saved-evidence', status: 'failed', code: 'SAVED_EVIDENCE_INVALID' }); }
    if (executeLocal) for (const [kind, script, flags] of suites) {
      console.error(`review-artifacts: ${kind}`);
      const privateReport = join(privateDirectory, `${kind}.json`);
      try {
        const code = await run([script, ...flags, '--report', privateReport]);
        if (code !== 0) throw Error('CHECK_FAILED');
        const raw = JSON.parse(await readFile(privateReport, 'utf8'));
        const preliminary = project(kind, raw, { file: `${kind}.json`, sha256: '0'.repeat(64) });
        // The semantic projector selects every exported field. Raw report extras,
        // logs, absolute paths, payment handles and signed transactions are omitted.
        const summary = { schemaVersion: 1, kind, status: 'passed', environment: preliminary.sources[0].environment,
          implementation: preliminary.sources[0].implementation,
          observations: preliminary.claims.map(c => ({ checkedFacts: c.checkedFacts, bindings: c.bindings, timeline: c.timeline })) };
        const bytes = json(summary);
        const manifest = project(kind, raw, { file: `${kind}.json`, sha256: hash(bytes) });
        const rendered = await renderReviewReplay(manifest);
        await emit(`${kind}.json`, bytes);
        await emit(`${kind}-evidence.json`, json(manifest));
        await emit(`${kind}-replay.html`, rendered.document);
        checks.push({ name: kind, status: 'passed', code: 'CHECK_PASSED' });
      } catch { checks.push({ name: kind, status: 'failed', code: 'LOCAL_CHECK_OR_EVIDENCE_FAILED' }); }
    }
    index.status = checks.every(c => c.status === 'passed') ? 'passed' : 'failed';
  } catch { checks.push({ name: 'bundle', status: 'failed', code: 'BUNDLE_BUILD_FAILED' }); }
  finally {
    try { await rm(privateDirectory, { recursive: true, force: true }); }
    catch { index.status = 'failed'; checks.push({ name: 'cleanup', status: 'failed', code: 'PRIVATE_TEMP_CLEANUP_FAILED' }); }
    await emit('README.txt', 'Tabby review artifacts\n\nOpen saved-replay.html for registered historical evidence.\nOpen local-*-replay.html for fresh, controlled local observations when present.\nindex.json records check outcomes; failed checks never become passed evidence.\nSHA256SUMS identifies these bytes, not their external authenticity.\nRun: node scripts/review-artifacts.mjs --verify <absolute bundle directory>\nReproduce offline: npm run review:artifacts -- --output <new absolute directory>\nReproduce locally: npm run review:artifacts -- --execute-local --output <new absolute directory>\nRequires Node 22; local execution also requires Foundry 1.8.1 and the pinned Docker image.\nRaw subprocess output, payment handles, private journals and credentials are excluded.\nDiagnostics are fixed codes; rerun the named repository command locally for investigation.\nNo production deployment or fresh public-chain execution is established.\n');
    // index lists payload files only, avoiding a circular self-checksum.
    const indexBytes = json(index);
    await writeFile(join(output, 'index.json'), indexBytes, { flag: 'wx', mode: 0o600 });
    const sums = [...files, { name: 'index.json', sha256: hash(indexBytes) }].sort((a, b) => a.name.localeCompare(b.name));
    await writeFile(join(output, 'SHA256SUMS'), sums.map(f => `${f.sha256}  ${f.name}\n`).join(''), { flag: 'wx', mode: 0o600 });
  }
  return index;
}

/** Integrity/shape check, not source authentication or a rerun of the suite. */
export async function verifyReviewArtifacts(directory) {
  assert.ok(isAbsolute(directory));
  assert.ok((await lstat(directory)).isDirectory(), 'BUNDLE_DIRECTORY_REQUIRED');
  const entries = await readdir(directory);
  for (const name of entries) {
    assert.ok(names.has(name), 'UNEXPECTED_ARTIFACT');
    assert.ok((await lstat(join(directory, name))).isFile(), 'REGULAR_ARTIFACT_REQUIRED');
  }
  const sums = (await readFile(join(directory, 'SHA256SUMS'), 'utf8')).trim().split('\n').map(line => {
    const match = /^([a-f0-9]{64})  ([a-zA-Z0-9_.-]+)$/.exec(line);
    assert.ok(match && names.has(match[2]) && match[2] !== 'SHA256SUMS', 'CHECKSUM_ENTRY_INVALID');
    return { name: match[2], sha256: match[1] };
  });
  assert.equal(new Set(sums.map(f => f.name)).size, sums.length, 'DUPLICATE_CHECKSUM');
  assert.deepEqual(entries.sort(), [...sums.map(f => f.name), 'SHA256SUMS'].sort(), 'MISSING_OR_EXTRA_ARTIFACT');
  for (const file of sums) assert.equal(hash(await readFile(join(directory, file.name))), file.sha256, 'ARTIFACT_HASH_MISMATCH');
  const index = JSON.parse(await readFile(join(directory, 'index.json'), 'utf8'));
  assert.equal(index.schemaVersion, 1);
  assert.ok(['passed', 'failed'].includes(index.status));
  assert.ok(['offline-review', 'fresh-local-integration'].includes(index.mode));
  assert.ok(index.checks.length > 0);
  const expected = index.mode === 'offline-review' ? ['offline-review', 'saved-evidence'] : ['saved-evidence', ...suites.map(s => s[0])];
  assert.equal(new Set(index.checks.map(c => c.name)).size, index.checks.length, 'DUPLICATE_CHECK');
  for (const check of index.checks) {
    assert.ok([...expected, 'bundle', 'cleanup'].includes(check.name), 'UNEXPECTED_CHECK');
    assert.ok(['passed', 'failed'].includes(check.status), 'INVALID_CHECK_STATUS');
    assert.ok(['CHECK_PASSED', 'CHECK_FAILED', 'SAVED_EVIDENCE_INVALID', 'LOCAL_CHECK_OR_EVIDENCE_FAILED', 'BUNDLE_BUILD_FAILED', 'PRIVATE_TEMP_CLEANUP_FAILED'].includes(check.code));
    assert.equal(check.status === 'passed', check.code === 'CHECK_PASSED');
  }
  assert.equal(index.status, index.checks.every(c => c.status === 'passed') ? 'passed' : 'failed');
  if (index.status === 'passed') assert.deepEqual(index.checks.map(c => c.name), expected, 'INCOMPLETE_CHECK_SET');
  for (const check of index.checks) if (check.status === 'passed' && check.name !== 'offline-review') {
    const required = check.name === 'saved-evidence' ? ['saved-evidence.json', 'saved-replay.html'] : [`${check.name}.json`, `${check.name}-evidence.json`, `${check.name}-replay.html`];
    for (const file of required) assert.ok(entries.includes(file), 'INCOMPLETE_CHECK_ARTIFACTS');
  }
  if (index.mode === 'offline-review') assert.ok(!entries.some(name => name.startsWith('local-')), 'OFFLINE_BUNDLE_HAS_FRESH_ARTIFACT');
  assert.deepEqual(index.files.slice().sort((a, b) => a.name.localeCompare(b.name)), sums.filter(f => f.name !== 'index.json').sort((a, b) => a.name.localeCompare(b.name)));
  if (entries.includes('saved-evidence.json')) {
    const saved = JSON.parse(await readFile(join(directory, 'saved-evidence.json'), 'utf8'));
    assert.equal(saved.schemaVersion, 1);
    assert.equal(saved.scope.mode, 'offline-registered-evidence-consistency');
    assert.ok(Array.isArray(saved.sources) && Array.isArray(saved.claims) && Array.isArray(saved.timeline));
    assert.ok(index.checks.some(c => c.name === 'saved-evidence' && c.status === 'passed'));
    for (const claim of saved.claims) assert.ok(saved.sources.some(source => source.reportId === claim.reportId && source.file === claim.source.file && source.sha256 === claim.source.sha256), 'SAVED_CLAIM_SOURCE_BINDING');
  }
  for (const [kind] of suites) if (entries.includes(`${kind}-evidence.json`)) {
    const manifest = JSON.parse(await readFile(join(directory, `${kind}-evidence.json`), 'utf8'));
    validateFreshReviewEvidenceManifestShape(manifest);
    assert.equal(manifest.sources[0].file, `${kind}.json`);
    assert.equal(manifest.sources[0].sha256, sums.find(f => f.name === `${kind}.json`)?.sha256);
    assert.ok(index.checks.some(c => c.name === kind && c.status === 'passed'));
    const summary = JSON.parse(await readFile(join(directory, `${kind}.json`), 'utf8'));
    assert.deepEqual(summary, { schemaVersion: 1, kind, status: 'passed', environment: manifest.sources[0].environment,
      implementation: manifest.sources[0].implementation,
      observations: manifest.claims.map(c => ({ checkedFacts: c.checkedFacts, bindings: c.bindings, timeline: c.timeline })) });
  }
  return { status: index.status, files: entries.length, mode: index.mode };
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {
    const args = process.argv.slice(2);
    if (args.length === 2 && args[0] === '--verify') {
      const result = await verifyReviewArtifacts(args[1]);
      console.log(JSON.stringify(result));
      if (result.status !== 'passed') process.exitCode = 1;
    }
    else {
      const executeLocal = args[0] === '--execute-local';
      if (executeLocal) args.shift();
      assert.ok(args.length === 2 && args[0] === '--output', 'USAGE');
      const index = await buildReviewArtifacts({ output: args[1], executeLocal });
      console.log(JSON.stringify({ status: index.status, checks: index.checks }));
      if (index.status !== 'passed') process.exitCode = 1;
    }
  } catch { console.error('REVIEW_ARTIFACTS_FAILED: require a new absolute output directory, or a valid bundle to verify.'); process.exitCode = 1; }
}
