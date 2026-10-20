import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (Number(process.versions.node.split('.')[0]) < 22) {
  console.error(`review:check requires Node.js >=22; current version is ${process.version}.`);
  process.exit(1);
}
const root = fileURLToPath(new URL('../', import.meta.url));
const steps = [
  ['documentation links', ['scripts/check-doc-links.mjs']],
  ['saved evidence consistency', ['scripts/check-acceptance-evidence.mjs']],
  ['unified review evidence', ['scripts/review-evidence.mjs']],
  ['review evidence, replay and launcher boundaries', ['--test', 'scripts/test/review-evidence.test.mjs', 'scripts/test/review-evidence-audit.test.mjs', 'scripts/test/review-replay.test.mjs', 'scripts/test/bounded-economy-launcher-audit.test.mjs', 'scripts/test/review-artifacts.test.mjs', 'scripts/test/independent-economy-evidence.test.mjs', 'scripts/test/independent-evidence-audit.test.mjs']],
  ['root TypeScript', ['node_modules/typescript/bin/tsc', '--noEmit']],
  ['frontend TypeScript', ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'frontend/tsconfig.json']],
  ['controlled mechanism tests', ['node_modules/tsx/dist/cli.mjs', '--test', '--test-concurrency=1',
    'scripts/test/bounded-economy-audit.test.ts',
    'scripts/test/independent-economy-audit.test.mjs',
    'packages/pi-loop/test/autonomy.test.ts',
    'packages/pi-loop/test/economics.test.ts',
    'services/hosted-agents/test/accounting.test.ts',
    'services/hosted-agents/test/accounting-http.test.ts',
    'services/hosted-agents/test/strategy-advice-audit.test.ts',
    'services/hosted-agents/test/strategy-advice-http.test.ts',
    'scripts/test/strategy-advice-demo.test.ts',
    'services/hosted-agents/test/operating-report-audit.test.ts',
    'scripts/test/operating-report-demo.test.ts',
    'frontend/test/hosted-operating-report.test.ts',
    'frontend/test/hosted-accounting.test.ts',
    'frontend/test/hosted-strategy-advice.test.ts',
    'services/hosted-agents/test/goals-reconciliation.test.ts',
    'services/hosted-agents/test/model-fallback.test.ts',
    'examples/publisher-worker/test/protocol.test.mjs', 'examples/publisher-worker/test/dispatch.test.mjs']],
  ['standalone SDK consumer', ['scripts/check-sdk-standalone.mjs']],
];
for (const [label, args] of steps) {
  console.log(`\n[review:check] ${label}`);
  const result = spawnSync(process.execPath, args, { cwd: root, stdio: 'inherit' });
  if (result.error) console.error(result.error.message);
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
console.log('\nReview checks passed: saved evidence, types, controlled mechanisms and standalone SDK consumer. No fresh public-chain, vendor, Docker or Foundry acceptance was run.');
