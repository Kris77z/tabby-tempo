import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { INDEPENDENT_SOURCE_FILES, validateIndependentEconomyReport, validateIndependentShadowReport } from './lib/independent-economy-evidence.mjs';

// This is a closed registry, not an evidence-file importer. Reports and private
// journals have different trust/sensitivity boundaries; never spread a report
// into this public projection or accept arbitrary input paths.
const ROOT = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const ACCEPTANCE = 'docs/acceptance/tempo-local-20261020/';
const entry = (reportId,file,kind) => Object.freeze({reportId,file,kind,evidenceStatus:'final',supersededBy:null});
export const EVIDENCE_REGISTRY=Object.freeze([
 ...[['economic','local-economic'],['consumer','local-consumer'],['strategy','offline-strategy'],['operating','offline-role'],['bounded','local-bounded'],['independent-shadow','local-independent-shadow'],['independent','local-independent']].map(([id,kind])=>entry(`tempo-owned-${id}-20261020`,`${ACCEPTANCE}${id}.json`,kind))
]);
const REPORTS=new Map(EVIDENCE_REGISTRY.map(r=>[r.file,r]));
const NARRATIVES=Object.freeze([]);
const IMPLEMENTATION_FILES = new Set([
  'packages/pi-loop/src/economics.ts', 'packages/pi-loop/src/selector.ts', 'packages/pi-loop/src/workflow.ts',
  'scripts/fixtures/operating-report-payment-fixtures.ts', 'scripts/operating-report-demo.ts', 'scripts/strategy-advice-demo.ts',
  ...['accounting', 'finance-projection', 'finance-reader', 'operating-history', 'operating-report', 'operating-types', 'strategy-advice', 'strategy-history', 'strategy-types', 'task-executor'].map(n => `services/hosted-agents/src/${n}.ts`),
  'scripts/economic-loop-local.ts', 'scripts/check-economic-loop.mjs', 'scripts/publisher-worker-local.ts', 'scripts/check-publisher-worker.mjs',
  ...['README.md', 'package.json', 'package-lock.json', 'protocol.mjs', 'durable.mjs', 'publisher.mjs', 'admit.mjs', 'worker.mjs', 'test/protocol.test.mjs'].map(n => `examples/publisher-worker/${n}`),
  'scripts/lib/bounded-economy-policy.ts', 'scripts/bounded-economy-local.ts', 'scripts/check-bounded-economy.mjs',
  'packages/pi-loop/test/workflow-fixture.ts', 'services/provider-relay/src/fixed-price.ts', 'services/provider-relay/src/relay.ts', 'services/arena/src/settler-main.ts',
  ...INDEPENDENT_SOURCE_FILES,
]);
const LIMITATIONS = Object.freeze([
  'Offline consistency of registered saved reports; no chain receipt is re-queried and no vendor response is independently authenticated.',
  'Checksums identify inspected bytes, not an external attestation. Recomputing them cannot establish authenticity.',
  'Historical revision and source fingerprints describe the implementation observed then; they need not match the current checkout.',
  'No new public Tempo execution, production deployment, current availability, commercial demand or full supplier profitability is established.',
]);
const SOURCE_SEMANTICS = 'Saved revision is the base revision; dirty=true means the recorded implementation also included uncommitted changes. Saved source hashes fingerprint that historical implementation. Current hashes are a separate comparison, never a requirement for historical acceptance.';
const hostedSources = names => names.map(n => `services/hosted-agents/src/${n}.ts`);
const PI_SOURCES = ['packages/pi-loop/src/workflow.ts', 'packages/pi-loop/src/selector.ts', 'packages/pi-loop/src/economics.ts'];
const STRATEGY_SOURCES = [...hostedSources(['strategy-advice', 'strategy-history', 'strategy-types', 'accounting', 'finance-projection', 'finance-reader', 'task-executor']), ...PI_SOURCES];
const OPERATING_SOURCES = [...STRATEGY_SOURCES, ...hostedSources(['operating-types', 'operating-report', 'operating-history'])];
const OFFLINE_STRATEGY_SOURCES = ['scripts/strategy-advice-demo.ts', ...hostedSources(['strategy-advice', 'strategy-history', 'strategy-types', 'accounting', 'finance-projection']), ...PI_SOURCES];
const OFFLINE_OPERATING_SOURCES = ['scripts/operating-report-demo.ts', 'scripts/fixtures/operating-report-payment-fixtures.ts', ...hostedSources(['operating-types', 'operating-report', 'operating-history', 'accounting', 'strategy-history']), 'packages/pi-loop/src/selector.ts', 'packages/pi-loop/src/economics.ts'];
const BOUNDED_SOURCES = [...STRATEGY_SOURCES, 'scripts/lib/bounded-economy-policy.ts', 'scripts/bounded-economy-local.ts', 'scripts/check-bounded-economy.mjs', 'packages/pi-loop/test/workflow-fixture.ts', 'services/provider-relay/src/fixed-price.ts', 'services/provider-relay/src/relay.ts', 'services/arena/src/settler-main.ts'];
const digest = v => { assert.equal(typeof v, 'string'); assert.match(v, /^[a-f0-9]{64}$/i, 'expected SHA-256'); return v; };
const chainHash = v => { assert.equal(typeof v, 'string'); assert.match(v, /^0x[a-f0-9]{64}$/i, 'expected transaction/payment hash'); return v; };
const uuid = v => { assert.equal(typeof v, 'string'); assert.match(v, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'original request UUID'); return v; };
const raw = v => { assert.equal(typeof v, 'string'); assert.match(v, /^(?:0|[1-9]\d{0,77}|-[1-9]\d{0,77})$/, 'canonical integer raw-unit amount'); const n = BigInt(v); assert.ok(n > -(1n << 256n) && n < 1n << 256n, 'raw-unit amount exceeds uint256 magnitude'); return n; };
const unsigned = v => { const n = raw(v); assert.ok(n >= 0n, 'unsigned raw-unit amount'); return n; };
const eq = (a, b, msg) => assert.equal(raw(a), typeof b === 'bigint' ? b : raw(b), msg);
const unique = (xs, msg = 'duplicate binding') => assert.equal(new Set(xs).size, xs.length, msg);
const sum = (xs, k) => xs.reduce((n, x) => n + raw(x[k]), 0n);
const iso = v => { assert.equal(typeof v, 'string'); assert.match(v, /^\d{4}-\d\d-\d\dT/); assert.ok(Number.isFinite(Date.parse(v)), 'invalid evidence time'); return v; };
const keys = (v, allowed, msg) => { assert.ok(v && typeof v === 'object' && !Array.isArray(v), msg); for (const k of Object.keys(v)) assert.ok(allowed.includes(k), `${msg}: unexpected ${k}`); };
function repoBytes(file) {
  const path = realpathSync(resolve(ROOT, file));
  const rel = relative(ROOT, path);
  assert.ok(rel !== '..' && !rel.startsWith(`..${sep}`) && !rel.startsWith(sep), 'evidence/source path escapes repository');
  return readFileSync(path);
}
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
function receipt(r, event) {
  chainHash(r.txHash); if (r.blockHash !== undefined) chainHash(r.blockHash);
  assert.ok(Number.isSafeInteger(r.blockNumber) && r.blockNumber > 0, 'receipt block number');
  if (r.status !== undefined) assert.equal(r.status, 1, 'receipt status');
  if (event) { assert.equal(r.event, event, 'receipt event reference'); assert.equal(r.eventCount, 1); }
}
function cleanup(d) {
  for (const k of ['ownedProcessesStopped', 'ownedContainersRemoved', 'privateTempDirectoryRemoved', 'ownedIpcDirectoryRemoved']) assert.equal(d.cleanup[k], true, `cleanup ${k}`);
  assert.deepEqual(d.cleanup.failures, []);
}
function validateRawFields(value) {
  if (Array.isArray(value)) { value.forEach(validateRawFields); return; }
  if (!value || typeof value !== 'object') return;
  for (const [key, v] of Object.entries(value)) {
    if (v !== null && (key.endsWith('Raw') || ['fromCash', 'fromCredit', 'reward', 'repaid', 'slashed', 'toAgent', 'amount', 'debtReduced', 'toCash'].includes(key))) {
      const signed = /(?:netOperating|netReward|netAfterPlanning|Profit|Contribution|surplus|Deviation|deviation|cashAfterRaw|AfterAssumedCost)/.test(key);
      (signed ? raw : unsigned)(v);
    } else validateRawFields(v);
  }
}
function checkHashMap(map, expectedFiles) {
  assert.ok(map && Object.keys(map).length > 0, 'source fingerprints required');
  for (const [file, hash] of Object.entries(map)) { assert.ok(IMPLEMENTATION_FILES.has(file), `unregistered implementation source reference: ${file}`); digest(hash); repoBytes(file); }
  if (expectedFiles) assert.deepEqual(Object.keys(map).sort(), [...expectedFiles].sort(), 'complete recorded implementation source references');
}
function implementation(d) {
  const source = d.provenance?.source ?? d.source ?? {};
  if (source.revision !== undefined) assert.match(source.revision, /^[a-f0-9]{40}$/i, 'base revision');
  if (source.dirty !== undefined) assert.equal(typeof source.dirty, 'boolean');
  const hashes = { ...(d.sourceSha256 ?? {}), ...(d.provenance?.sourceSha256 ?? {}), ...(d.strategySourceSha256 ?? {}), ...(d.operatingSourceSha256 ?? {}) };
  if (source.consumerSha256) for (const [f, hash] of Object.entries(source.consumerSha256)) hashes[`examples/publisher-worker/${f}`] = hash;
  // Harness digests remain identified as saved fingerprints even if the old
  // report did not name their exact repository path.
  const savedFingerprints = {};
  for (const [k, v] of Object.entries(source)) if (/Sha256$/.test(k) && typeof v === 'string') savedFingerprints[k] = digest(v);
  if (d.suite === 'local-independent-economy') for (const k of ['sdkArchiveSha256', 'launcherSha256']) if (d.provenance[k]) savedFingerprints[k] = digest(d.provenance[k]);
  if (Object.keys(hashes).length) checkHashMap(hashes);
  return {
    revision: source.revision ?? null, dirty: source.dirty ?? null,
    sourceHashes: Object.entries(hashes).sort(([a], [b]) => a.localeCompare(b)).map(([file, saved]) => {
      const current = sha256(repoBytes(file)); return { file, sha256: saved, currentSha256: current, matchesCurrent: saved === current };
    }), savedFingerprints, semantics: SOURCE_SEMANTICS,
  };
}
function localEnvironment(d, { fresh = false } = {}) {
  assert.equal(d.provenance.chainId, '31337', 'local/public environment mismatch');
  assert.equal(d.provenance.environment, 'owned-local-anvil', 'local/public environment mismatch');
  assert.equal(d.provenance.model, 'controlled-response-injection', 'controlled/public model mismatch');
  assert.equal(d.provenance.evaluation, 'real-pinned-Docker-public-and-hidden-tests');
  assert.equal(d.scope.productionNetworkUsed, false, 'local report cannot claim production');
  assert.equal(d.scope.publicVendorCalls, false, 'controlled report cannot claim live vendors');
  assert.equal(d.scope.autonomousPlannerExercised, false);
  assert.match(d.provenance.source.revision, /^[a-f0-9]{40}$/i, 'local base revision');
  if (fresh) assert.equal(typeof d.provenance.source.dirty, 'boolean');
  else assert.equal(d.provenance.source.dirty, true, 'local evidence records uncommitted implementation');
  for (const field of ['trackedDiffSha256', 'harnessSha256', 'launcherSha256']) digest(d.provenance.source[field]);
  return { kind: 'local-anvil', chainId: '31337', modelMode: 'controlled', execution: 'real-local-contracts-and-Docker' };
}
function offlineEnvironment(d) {
  assert.equal(d.scope.controlledFixtures, true); assert.equal(d.scope.productionRead, false); assert.equal(d.scope.productionWrite, false);
  for (const k of ['externalRpcCalls', 'modelCalls', 'signedTransactions']) assert.equal(d.scope[k], 0, `offline environment ${k}`);
  if ('broadcastTransactions' in d.scope) assert.equal(d.scope.broadcastTransactions, 0);
  assert.equal(d.currency, 'USDC'); assert.equal(d.decimals, 6);
  return { kind: 'offline-fixture', chainId: null, modelMode: 'synthetic', execution: 'no-network-signing-or-broadcast' };
}

const ECONOMIC_SCENARIOS = ['reject-loss-before-payment', 'profitable-task-1', 'profitable-task-2', 'profitable-task-3', 'paid-hidden-test-failure', 'unknown-original-request-recovery', 'original-unknown-full-refund'];
const BASE_PREDICATES = ['rejectLossWithZeroPayment', 'realCreditExecutionSettlementRepayment', 'earningsFundNextTaskWithCreditDisabledAndZeroTopups', 'failedCostRetainedWithoutInventedIncome', 'unknownResumeUsesOriginalBytesWithoutDuplicatePaymentOrDispatch', 'incomeCostCapitalAndSubsidySeparated', 'cashReconcilesToCapitalPlusOperatingResult'];
const STRATEGY_PREDICATES = ['readOnlyStrategyAdvicePreservesHistoryCashNonceAndModelCalls', 'strategyAdviceRetainsPaidFailureAndBlocksUnknown'];
const ROLE_PREDICATES = ['roleAccountsReconcileSupplierReceiptsAndRefunds', 'readOnlyRunwaySeparatesActualResultsFromAssumptions'];
const READ_LABELS = ['after-three-settled-tasks', 'after-paid-failure', 'while-original-payment-is-unknown', 'after-original-full-refund'];
export function validateEconomic(d, options = {}) {
  assert.equal(d.version, 1); assert.equal(d.suite, 'local-economic-loop'); assert.equal(d.status, 'passed'); localEnvironment(d, options); cleanup(d); validateRawFields(d);
  iso(d.startedAt); iso(d.completedAt); assert.ok(Date.parse(d.completedAt) >= Date.parse(d.startedAt));
  assert.equal(d.durationMs, Date.parse(d.completedAt) - Date.parse(d.startedAt), 'run duration');
  assert.deepEqual(d.scenarios.map(s => s.name), ECONOMIC_SCENARIOS, 'required scenario sequence');
  const predicateNames = [...BASE_PREDICATES, ...(d.strategyAdvice ? STRATEGY_PREDICATES : []), ...(d.operatingReports ? ROLE_PREDICATES : [])];
  assert.deepEqual(Object.keys(d.predicates).sort(), predicateNames.sort(), 'required predicates');
  for (const p of predicateNames) assert.equal(d.predicates[p], true, `predicate ${p}`);
  const [reject, ...rest] = d.scenarios, profitable = rest.slice(0, 3), failed = rest[3], unknown = rest[4], refund = rest[5];
  unique(d.scenarios.slice(0, 6).map(s => uuid(s.requestId)), 'original requests must be distinct');
  unique(d.scenarios.slice(0, 6).map(s => s.taskId), 'task/request ownership');
  assert.equal(reject.reason, 'ECONOMICS_NOT_WORTHWHILE'); assert.equal(reject.phase, 'Stopped'); assert.deepEqual(reject.after, reject.before, 'rejected task must not spend or dispatch');
  const re = reject.economics; eq(re.netRevenueRaw, raw(re.rewardRaw) - raw(re.protocolFeeRaw));
  eq(re.executionCostRaw, raw(re.fromCashRaw) + raw(re.fromCreditRaw));
  eq(re.netRewardRaw, raw(re.netRevenueRaw) - raw(re.executionCostRaw) - raw(re.planningCostRaw) - raw(re.borrowerFeeRaw), 'loss-admission arithmetic'); assert.ok(raw(re.netRewardRaw) < 0n);
  assert.equal(d.initialFunding.initialAgentId, '2'); eq(d.initialFunding.startupCapitalRaw, 40000n); eq(d.initialFunding.ownerTopupsAfterProvisionRaw, 0n); eq(d.initialFunding.gameSubsidyRaw, 0n);
  assert.equal(d.publishedTasks.length, 6); unique(d.publishedTasks.map(t => t.taskId));
  eq(d.initialFunding.taskPublisherFundedRewardsRaw, sum(d.publishedTasks, 'fundedEscrowRaw'), 'publisher funding total'); receipt(d.initialFunding.mint);
  for (const t of d.publishedTasks) {
    receipt(t.creation, 'TaskCreated'); assert.equal(t.creation.values.taskId, t.taskId, 'task creation ownership');
    eq(t.rewardRaw, t.fundedEscrowRaw); eq(t.creation.values.reward, t.rewardRaw, 'task creation reward');
  }
  const rejectedTask = d.publishedTasks.find(t => t.taskId === reject.taskId); assert.ok(rejectedTask, 'rejected admission task must be published');
  eq(re.rewardRaw, rejectedTask.rewardRaw, 'admission reward must retain published task funding');
  const paid = [...profitable, failed, unknown]; unique(paid.map(s => chainHash(s.payment.values.paymentId)), 'unique original payment IDs'); unique(paid.map(s => s.payment.txHash));
  let prior = reject.after; let grossCost = 0n, revenue = 0n, fees = 0n, principal = 0n;
  for (const s of [...profitable, failed]) {
    for (const k of ['cashRaw', 'walletTokenRaw', 'providerTokenRaw', 'agentNonce', 'modelCalls']) assert.equal(s.before[k], prior[k], 'sequential scenario balance/counter continuity');
    receipt(s.payment, 'ProviderPaid'); receipt(s.settlement, 'TaskSettled');
    const p = s.payment.values, settlement = s.settlement.values;
    assert.equal(p.agentId, d.initialFunding.initialAgentId, 'payment agent ownership'); assert.equal(settlement.taskId, s.taskId, 'settlement task ownership');
    const task = d.publishedTasks.find(t => t.taskId === s.taskId); assert.ok(task, 'settlement must reference a published task');
    eq(s.chargedRaw, raw(p.fromCash) + raw(p.fromCredit), 'cash plus credit equals charge');
    eq(s.after.providerTokenRaw, raw(s.before.providerTokenRaw) + raw(s.chargedRaw), 'provider receipt conservation');
    assert.equal(s.after.modelCalls, s.before.modelCalls + 1); assert.ok(s.after.agentNonce > s.before.agentNonce);
    assert.equal(s.before.walletTokenRaw, s.after.walletTokenRaw); eq(s.borrowingFeeRaw, raw(p.fromCredit) * 15n / 100n, 'borrowing fee');
    if (s === failed) {
      assert.equal(s.phase, 'Failed'); assert.equal(s.reason, 'ARENA_TASK_FAILED'); assert.equal(settlement.passed, false);
      for (const f of ['repaid', 'slashed', 'toAgent']) eq(settlement[f], 0n); eq(s.taskRevenueRaw, 0n, 'failed task cannot invent revenue');
    } else {
      assert.equal(settlement.passed, true); eq(s.fromCashRaw, p.fromCash); eq(s.fromCreditRaw, p.fromCredit);
      eq(s.repaidRaw, raw(s.fromCreditRaw) + raw(s.borrowingFeeRaw), 'principal plus borrowing fee'); eq(settlement.repaid, s.repaidRaw);
      eq(settlement.toAgent, s.residualRaw); eq(settlement.slashed, 0n); eq(s.taskRevenueRaw, task.rewardRaw);
      eq(s.taskRevenueRaw, raw(s.repaidRaw) + raw(s.residualRaw), 'settlement reward conservation');
      eq(s.netOperatingRaw, raw(s.taskRevenueRaw) - raw(s.chargedRaw) - raw(s.borrowingFeeRaw), 'task operating result');
      assert.equal(s.loanStatus, raw(s.fromCreditRaw) > 0n ? '2' : '0');
    }
    eq(s.after.cashRaw, raw(s.before.cashRaw) - raw(p.fromCash) + raw(settlement.toAgent), 'Agent cash conservation');
    assert.ok(s.payment.blockNumber < s.settlement.blockNumber, 'payment precedes settlement');
    prior = s.after; grossCost += raw(s.chargedRaw); revenue += raw(s.taskRevenueRaw); fees += raw(s.borrowingFeeRaw); principal += raw(p.fromCredit);
  }
  eq(profitable[2].fromCreditRaw, 0n); assert.equal(profitable[2].funding, 'cash-only-from-retained-earnings; credit-disabled');
  assert.equal(unknown.phaseBefore, 'Paused'); assert.equal(unknown.phaseAfter, 'Paused'); assert.equal(unknown.reason, 'SOLVE_DISPATCH_UNKNOWN');
  assert.deepEqual(unknown.beforeRecovery, unknown.afterRecovery, 'Unknown recovery must preserve counters and original balance');
  digest(unknown.originalAcceptBytesSha256); digest(unknown.originalPaymentBytesSha256);
  assert.equal(unknown.pendingAccountingStatus, 'partial'); assert.equal(unknown.pendingNetOperatingRaw, null);
  receipt(unknown.payment, 'ProviderPaid'); assert.equal(unknown.payment.values.agentId, d.initialFunding.initialAgentId);
  assert.equal(unknown.paymentId, unknown.payment.values.paymentId, 'Unknown original payment binding');
  eq(unknown.chargedRaw, raw(unknown.payment.values.fromCash) + raw(unknown.payment.values.fromCredit));
  eq(unknown.beforeRecovery.cashRaw, raw(prior.cashRaw) - raw(unknown.payment.values.fromCash));
  eq(unknown.beforeRecovery.providerTokenRaw, raw(prior.providerTokenRaw) + raw(unknown.chargedRaw));
  assert.equal(unknown.beforeRecovery.modelCalls, prior.modelCalls + 1);
  receipt(refund.refund, 'RefundProcessed'); assert.equal(refund.requestId, unknown.requestId, 'refund original request ownership');
  assert.equal(refund.paymentId, unknown.paymentId, 'refund original payment ownership'); assert.equal(refund.refund.values.paymentId, unknown.paymentId, 'refund receipt ownership');
  assert.equal(refund.phase, 'Refunded'); assert.equal(refund.taskIsNotSuccessful, true); eq(refund.chargedRaw, 0n);
  eq(refund.refundedRaw, unknown.chargedRaw); eq(refund.refund.values.amount, refund.refundedRaw); eq(refund.refund.values.toCash, refund.refundedRaw); eq(refund.refund.values.debtReduced, 0n);
  eq(refund.after.cashRaw, raw(unknown.afterRecovery.cashRaw) + raw(refund.refundedRaw));
  eq(refund.after.providerTokenRaw, raw(unknown.afterRecovery.providerTokenRaw) - raw(refund.refundedRaw));
  assert.equal(refund.after.modelCalls, unknown.afterRecovery.modelCalls); assert.equal(refund.after.agentNonce, unknown.afterRecovery.agentNonce);
  assert.ok(refund.refund.blockNumber > unknown.payment.blockNumber);
  grossCost += raw(unknown.chargedRaw);
  const totals = d.accounting.totals; assert.equal(d.accounting.status, 'complete');
  const expected = { taskRevenueRaw: revenue, inferenceCostRaw: grossCost - raw(refund.refundedRaw), refundsRaw: raw(refund.refundedRaw), borrowingFeeRaw: fees, loanPrincipalRaw: principal, startupCapitalRaw: raw(d.initialFunding.startupCapitalRaw), ownerCapitalRaw: 0n, gameSubsidyRaw: 0n };
  for (const [k, n] of Object.entries(expected)) eq(totals[k], n, `accounting ${k}`);
  eq(totals.netOperatingRaw, revenue - expected.inferenceCostRaw - fees, 'operating result arithmetic');
  eq(d.chain.finalAgentCashRaw, raw(totals.startupCapitalRaw) + raw(totals.netOperatingRaw), 'cash equals capital plus operating result');
  eq(d.chain.finalAgentCashRaw, refund.after.cashRaw); eq(d.chain.providerNetReceivedRaw, expected.inferenceCostRaw);
  assert.equal(d.chain.providerPaidEventCount, paid.length, 'payment event count includes failure and Unknown');
  const entries = d.accounting.entries; unique(entries.map(e => e.requestId));
  for (const s of paid) {
    const e = entries.find(e => e.requestId === s.requestId); assert.ok(e, 'accounting must retain original request');
    assert.equal(e.taskId, s.taskId, 'accounting original task ownership'); assert.equal(e.paymentId, s.payment.values.paymentId, 'accounting original payment ownership');
    assert.equal(e.txHash, s === unknown ? s.payment.txHash : s.settlement.txHash, 'accounting original transaction reference');
    eq(e.inferenceCostRaw, s === unknown ? 0n : raw(s.chargedRaw)); eq(e.refundsRaw, s === unknown ? raw(refund.refundedRaw) : 0n);
    eq(e.taskRevenueRaw, s.taskRevenueRaw ?? '0'); eq(e.borrowingFeeRaw, s.borrowingFeeRaw ?? '0');
  }
  for (const k of Object.keys(expected)) eq(totals[k], sum(entries, k), `accounting entries reconcile ${k}`);
  assert.equal(d.accounting.coverage.entriesTruncated, false); assert.equal(d.accounting.coverage.pendingCount, 0); assert.equal(d.accounting.coverage.incompleteCount, 0); eq(d.accounting.coverage.uncoveredSpentRaw, 0n);
  if (d.strategyAdvice) validateStrategyReads(d);
  if (d.operatingReports) validateOperatingReads(d);
  return expected;
}

function validateStrategyReads(d) {
  checkHashMap(d.strategySourceSha256, STRATEGY_SOURCES);
  assert.deepEqual(d.strategyAdvice.map(r => r.label), READ_LABELS, 'strategy read sequence');
  const relevant = [d.scenarios[3].after, d.scenarios[4].after, d.scenarios[5].afterRecovery, d.scenarios[6].after];
  for (const [i, r] of d.strategyAdvice.entries()) {
    assert.deepEqual(r.before, r.after, 'strategy read must preserve journals, balances, nonces, quotes and calls');
    for (const [k, v] of Object.entries(relevant[i])) assert.equal(r.before[k], v, 'strategy read must bind its scenario');
    digest(r.before.historySha256); digest(r.before.inputsSha256);
    const a = r.advice; assert.equal(a.mode, 'advisory-only'); assert.equal(a.currency, 'USDC'); assert.equal(a.decimals, 6);
    assert.equal(a.agentId, d.accounting.agentId, 'strategy agent identity'); iso(a.observedAt);
    const c = a.cash; eq(c.cashRaw, r.before.cashRaw); eq(c.reserveCashRaw, 120000n); assert.equal(c.creditIncluded, false);
    const available = raw(c.cashRaw) - raw(c.pendingCommitmentsRaw) - raw(c.outstandingDebtRaw);
    eq(c.availableBeforeReserveRaw, available > 0n ? available : 0n, 'advice cash available');
    const spendable = available - raw(c.reserveCashRaw); eq(c.spendableCashRaw, spendable > 0n ? spendable : 0n, 'advice cash reserve');
    assert.equal(c.unresolvedLiabilities, i === 2, 'Unknown must block advice');
    assert.equal(a.recommendation.status, i === 0 ? 'preview' : i === 2 ? 'blocked' : 'no-eligible-candidate');
    unique(a.history.entries.map(e => e.requestId));
    for (const e of a.history.entries) {
      const s = d.scenarios.slice(0, 6).find(s => s.requestId === e.requestId); assert.ok(s, 'strategy original request reference');
      assert.ok(Date.parse(e.at) <= Date.parse(a.observedAt), 'strategy cannot use future observations');
      if (!e.prediction) continue;
      const p = e.prediction; assert.equal(p.source, 'original-workflow-admission'); assert.equal(p.taskId, s.taskId, 'prediction task ownership');
      digest(p.snapshotHash); digest(p.routeBinding); assert.ok(p.atMs <= Date.parse(e.at), 'prediction must precede outcome');
      eq(p.netRewardRaw, raw(p.netRevenueRaw) - raw(p.executionCostRaw) - raw(p.planningCostRaw) - raw(p.borrowerFeeRaw), 'original prediction arithmetic');
      const actual = e.realized;
      if (actual.status === 'confirmed') {
        eq(actual.taskContributionRaw, raw(actual.taskRevenueRaw) - raw(actual.executionCostRaw) - raw(actual.borrowingFeeRaw));
        eq(actual.netAfterPlanningRaw, raw(actual.taskContributionRaw) - raw(actual.planningCostRaw));
        eq(e.executionCostDeviationRaw, raw(actual.executionCostRaw) - raw(p.executionCostRaw));
      }
      if (s.name === 'paid-hidden-test-failure') { eq(actual.failureLossRaw, s.chargedRaw, 'paid failure loss retained'); eq(actual.taskRevenueRaw, 0n); }
      if (s.name === 'unknown-original-request-recovery' && i === 2) { assert.equal(actual.status, 'pending'); assert.equal(actual.taskRevenueRaw, null); }
    }
    for (const candidate of a.candidates) {
      assert.equal(candidate.source, 'owner-hypothetical');
      eq(candidate.adjustedExecutionCostRaw, raw(candidate.quotedExecutionCostRaw) + raw(candidate.observedCostBufferRaw ?? '0'));
      eq(candidate.successfulCompletionProfitRaw, raw(candidate.netRevenueRaw) - raw(candidate.adjustedExecutionCostRaw) - raw(candidate.planningCostRaw) - raw(candidate.borrowerFeeRaw));
      eq(candidate.cashAfterRaw, raw(c.cashRaw) - raw(c.pendingCommitmentsRaw) - raw(c.outstandingDebtRaw) - raw(candidate.cashRequiredRaw));
      if (candidate.failedComparableCount > 0 && candidate.observedFailureLossRaw !== null) assert.ok(raw(candidate.requiredProfitRaw) >= raw(candidate.observedFailureLossRaw));
    }
  }
}
function validateRunway(r) {
  if (!r) return;
  assert.ok(['none', 'owner-hypothetical', 'operator-declared'].includes(r.source), 'runway is an explicit assumption');
  if (r.status === 'finite') {
    assert.ok(raw(r.burnAmountRaw) > 0n); assert.ok(Number.isSafeInteger(r.burnWindowMs) && r.burnWindowMs > 0);
    eq(r.horizonMs, unsigned(r.availableRaw) * BigInt(r.burnWindowMs) / unsigned(r.burnAmountRaw), 'runway horizon arithmetic');
  } else {
    assert.ok(['unknown', 'zero-burn', 'exhausted'].includes(r.status));
    if (r.status !== 'exhausted') { assert.equal(r.horizonMs, null, 'unknown/zero-burn cannot assert horizon'); assert.equal(r.fullTasks, null); }
    if (r.status === 'zero-burn') eq(r.burnAmountRaw, 0n);
  }
}
function validateOperating(r, { unresolved = false, chainId = null } = {}) {
  assert.equal(r.mode, 'read-only'); assert.equal(r.currency, 'USDC'); assert.equal(r.decimals, 6);
  assert.equal(r.consolidation.roleTotalsAdditive, false, 'internal role transfers cannot be additive');
  assert.equal(r.consolidation.externalRevenueRaw, null);
  const a = r.agent, s = r.suppliers;
  for (const role of [a, r.platform, s]) assert.equal(role.actualProfitRaw, null, 'unobserved full costs keep actual profit unknown');
  eq(s.netReceiptsRaw, raw(s.grossReceiptsRaw) - raw(s.refundsRaw), 'supplier refunds counted once');
  eq(a.netServiceCostRaw, raw(s.netReceiptsRaw) + raw(s.unattributedNetServiceCostRaw), 'Agent cost/supplier receipts reconcile');
  if (a.settlementOperatingRaw !== null) eq(a.settlementOperatingRaw, raw(a.taskRevenueRaw) - raw(a.netServiceCostRaw) - raw(a.borrowingFeeRaw), 'role contribution arithmetic excludes principal/capital/subsidy');
  if (s.rows) {
    eq(s.grossReceiptsRaw, sum(s.rows, 'grossReceiptsRaw')); eq(s.refundsRaw, sum(s.rows, 'refundsRaw')); eq(s.netReceiptsRaw, sum(s.rows, 'netReceiptsRaw'));
    for (const row of s.rows) { if (chainId) assert.equal(row.chainId, chainId, 'supplier environment binding'); eq(row.netReceiptsRaw, raw(row.grossReceiptsRaw) - raw(row.refundsRaw)); }
  }
  assert.equal(r.platform.creditFeeRecipient, 'credit-vault', 'credit fee is not platform-wallet revenue');
  assert.equal(r.platform.treasuryReceiptsRaw, null, 'unconfirmed treasury receipts cannot be inferred from credit-vault fees');
  assert.equal(r.subsidy.startupCapitalSource, 'unattributed-capital'); assert.equal(r.subsidy.rewardTokensRemaining, null);
  assert.equal(r.cash.creditIncluded, false);
  if (unresolved) {
    assert.equal(a.settlementOperatingRaw, null, 'Unknown operating result remains unknown'); assert.equal(r.cash.spendableCashRaw, null, 'Unknown spendable cash'); assert.equal(r.runway.status, 'unknown');
  } else if (r.cash.spendableCashRaw !== null) {
    const spendable = raw(r.cash.cashRaw) - raw(r.cash.pendingReservationsRaw) - raw(r.cash.outstandingDebtRaw) - raw(r.cash.reserveCashRaw);
    eq(r.cash.spendableCashRaw, spendable > 0n ? spendable : 0n, 'spendable cash arithmetic');
  }
  validateRunway(r.runway);
  if (r.scenario) {
    assert.equal(r.scenario.source, 'owner-hypothetical');
    if (r.scenario.settlementOperatingAfterAssumedCostRaw !== null) eq(r.scenario.settlementOperatingAfterAssumedCostRaw, raw(a.settlementOperatingRaw) - raw(r.scenario.recurringCostRaw));
    if (r.scenario.subsidyBudgetRemainingRaw !== null) eq(r.scenario.subsidyBudgetRemainingRaw, raw(r.scenario.subsidyBudgetRaw) - raw(r.subsidy.gameDistributionOutflowRaw), 'budget tracks distribution, not recipient consumption');
    validateRunway(r.scenario.subsidyBudgetRunway);
  }
}
function validateOperatingReads(d) {
  checkHashMap(d.operatingSourceSha256, OPERATING_SOURCES);
  for (const [file, hash] of Object.entries(d.strategySourceSha256)) assert.equal(d.operatingSourceSha256[file], hash, 'same report source fingerprints must agree');
  assert.deepEqual(d.operatingReports.map(r => r.label), READ_LABELS, 'operating read sequence');
  for (const [i, r] of d.operatingReports.entries()) {
    assert.deepEqual(r.before, r.after, 'operating read must preserve all inputs and counters');
    assert.deepEqual(r.before, d.strategyAdvice[i].before, 'role/strategy reads bind the same observations');
    const o = r.operating; validateOperating(o, { unresolved: i === 2, chainId: '31337' });
    assert.equal(o.agentId, d.accounting.agentId, 'operating agent identity'); eq(o.cash.cashRaw, r.before.cashRaw);
    eq(o.agent.taskRevenueRaw, 600000n); eq(o.agent.borrowingFeeRaw, 13800n);
    const cost = ['360000', '480000', '600000', '480000'][i]; eq(o.agent.netServiceCostRaw, cost);
    if (i !== 2) eq(o.suppliers.netReceiptsRaw, o.agent.netServiceCostRaw);
    eq(o.subsidy.gameDistributionOutflowRaw, 0n); eq(o.subsidy.startupCapitalGrantedRaw, 40000n);
  }
}
export function validateConsumer(d, { fresh = false } = {}) {
  assert.equal(d.version, 1); assert.equal(d.suite, 'local-publisher-worker'); assert.equal(d.status, 'passed');
  assert.equal(d.chainId, '31337', 'consumer local environment'); assert.equal(d.assetDecimals, 6);
  assert.equal(d.scope, 'isolated Anvil; controlled model response; existing Docker Arena; no production execution or external adoption'); cleanup(d); iso(d.generatedAt); validateRawFields(d);
  assert.match(d.source.revision, /^[a-f0-9]{40}$/i); if (fresh) assert.equal(typeof d.source.dirty, 'boolean'); else assert.equal(d.source.dirty, true);
  for (const field of ['harnessSha256', 'trustedConfigSha256', 'sdkArchiveSha256']) digest(d.source[field]); digest(d.provenance.launcherSha256);
  assert.deepEqual(Object.keys(d.source.consumerSha256).sort(), ['README.md', 'package.json', 'package-lock.json', 'protocol.mjs', 'durable.mjs', 'publisher.mjs', 'admit.mjs', 'worker.mjs', 'test/protocol.test.mjs'].sort(), 'complete independent consumer source references');
  const e = d.economics, p = d.payment, s = d.settlement;
  unique(Object.values(d.roles).map(s => s.toLowerCase()), 'publisher/worker/verifier/provider must be separate roles');
  for (const address of Object.values(d.roles)) assert.match(address, /^0x[a-f0-9]{40}$/i);
  chainHash(d.paymentId); assert.match(d.taskId, /^\d+$/);
  for (const r of [d.publication, p, s]) receipt(r);
  assert.ok(d.publication.blockNumber < p.blockNumber && p.blockNumber < s.blockNumber, 'publication/payment/settlement order');
  eq(d.publication.reward, e.reward); eq(e.providerCost, raw(p.fromCash) + raw(p.fromCredit)); eq(e.principal, p.fromCredit);
  eq(e.borrowFee, raw(e.principal) * 15n / 100n); eq(s.repaid, raw(e.principal) + raw(e.borrowFee));
  eq(s.slashed, 0n); eq(s.residual, raw(e.reward) - raw(e.protocolFee) - raw(s.repaid), 'consumer settlement conservation');
  eq(e.netTaskIncome, raw(e.reward) - raw(e.protocolFee) - raw(e.providerCost) - raw(e.borrowFee), 'consumer contribution');
  eq(e.closingCash, raw(e.openingCash) + raw(e.netTaskIncome)); eq(e.closingCash, s.residual); assert.equal(e.gasIncluded, false);
  assert.equal(s.passed, true); assert.equal(d.verification.passed, true); assert.equal(d.verification.mode, 'docker'); assert.equal(d.verification.cases, 5); uuid(d.verification.runId);
  assert.equal(d.publication.recoveredSameTask, true); assert.equal(p.modelCalls, 1);
  for (const k of ['publisherExtraTasks', 'workerExtraPayments', 'modelExtraCalls', 'verifierExtraTransactions']) assert.equal(d.replay[k], 0, 'consumer replay creates no business effects');
  for (const k of ['recoveredSameArenaRun', 'recoveredSameSettlementHash']) assert.equal(d.replay[k], true);
  assert.deepEqual(d.negativeChecks, ['tampered publication rejected before admission write', 'unprofitable task rejected before acceptance/payment', 'changed worker config preserves original journal', 'worker cannot self-settle']);
}
function fixtureChecks(d, tasks, checks) {
  assert.equal(d.version, 1); iso(d.observedAt); offlineEnvironment(d); checkHashMap(d.sourceSha256);
  assert.equal(d.fixtureEvidence.taskCount, tasks); assert.equal(d.fixtureEvidence.journalCount, tasks * 2);
  assert.equal(d.fixtureEvidence.originalJournalsUnchanged, true); assert.equal(d.fixtureEvidence.temporaryFilesRemoved, true); digest(d.fixtureEvidence.fixtureDigest);
  unique(d.checksPassed); assert.equal(d.checksPassed.length, checks);
}
function validateOfflineStrategy(d) {
  fixtureChecks(d, 7, 9); assert.equal(d.demonstration, 'controlled-offline-strategy-advice');
  checkHashMap(d.sourceSha256, OFFLINE_STRATEGY_SOURCES);
  const c = d.costDeviation, f = d.paidFailure;
  eq(c.deviationRaw, raw(c.actualExecutionCostRaw) - raw(c.originalPrediction.executionCostRaw), 'cost deviation arithmetic');
  eq(c.originalPrediction.netRewardRaw, raw(c.originalPrediction.netRevenueRaw) - raw(c.originalPrediction.executionCostRaw) - raw(c.originalPrediction.planningCostRaw) - raw(c.originalPrediction.borrowerFeeRaw));
  assert.equal(c.before.recommendation.providerId, 'route-a'); assert.equal(c.after.recommendation.providerId, 'route-b');
  const route = c.after.candidates.find(x => x.providerId === 'route-a'); eq(route.observedCostBufferRaw, c.deviationRaw); eq(route.adjustedExecutionCostRaw, c.actualExecutionCostRaw);
  eq(f.actualLossRaw, f.knownFailureLossRaw); assert.equal(f.before.recommendation.providerId, 'route-c'); assert.equal(f.after.recommendation.providerId, 'route-b');
  const failed = f.after.candidates.find(x => x.providerId === 'route-c'); eq(failed.observedFailureLossRaw, f.actualLossRaw); assert.equal(failed.failedComparableCount, 1);
  eq(failed.requiredProfitRaw, raw(f.before.candidates.find(x => x.providerId === 'route-c').requiredProfitRaw) + raw(f.actualLossRaw), 'failure loss changes required profit');
  for (const r of [c.before, c.after, f.before, f.after, d.cashReserve, d.creditCannotSupplyReserve, d.minimumProfit]) {
    assert.equal(r.cash.creditIncluded, false); eq(r.cash.spendableCashRaw, raw(r.cash.cashRaw) - raw(r.cash.reserveCashRaw));
    for (const q of r.candidates) eq(q.adjustedExecutionCostRaw, raw(q.quotedExecutionCostRaw) + raw(q.observedCostBufferRaw));
  }
  for (const r of [d.cashReserve, d.creditCannotSupplyReserve]) { assert.equal(r.recommendation.status, 'no-eligible-candidate'); assert.ok(r.recommendation.reasons.includes('STRATEGY_CASH_RESERVE')); }
  assert.equal(d.minimumProfit.recommendation.status, 'no-eligible-candidate');
  for (const q of d.minimumProfit.candidates) assert.ok(raw(q.successfulCompletionProfitRaw) < raw(q.requiredProfitRaw), 'profit floor rejects candidate');
  assert.equal(d.unknownBlocksAdvice.recommendation.status, 'blocked'); assert.equal(d.unknownBlocksAdvice.unresolvedLiabilities, true);
}
function validateOfflineRole(d, final) {
  fixtureChecks(d, 5, 13); assert.equal(d.demonstration, 'controlled-offline-operating-report');
  checkHashMap(d.sourceSha256, OFFLINE_OPERATING_SOURCES);
  validateOperating(d.contribution); validateOperating(d.ownerHypothetical);
  eq(d.contribution.agent.settlementOperatingRaw, 1205000n); eq(d.contribution.platform.derivedProtocolFeeRaw, 100000n);
  for (const o of Object.values(d.operatorDeclarations)) {
    assert.equal(o.source, 'operator-declared'); assert.equal(o.actualProfitRaw, null); digest(o.evidenceDigest); validateRunway(o.runway); validateRunway(o.subsidy.budgetRunway);
    if (o.subsidy.grantedRaw !== null) {
      eq(o.subsidy.unallocatedGrantRaw, raw(o.subsidy.grantedRaw) - raw(o.subsidy.explicitlyAllocatedRaw));
      eq(o.subsidy.remainingBudgetRaw, raw(o.subsidy.budgetRaw) - raw(o.subsidy.grantedRaw) - raw(o.subsidy.unpaidCommittedRaw), 'platform distribution budget arithmetic');
    }
  }
  eq(d.operatorDeclarations.platform.reportedContributionRaw, -500000n); eq(d.operatorDeclarations.supplier.reportedContributionRaw, 50000n);
  for (const r of Object.values(d.runway)) validateRunway(r);
  assert.equal(d.invalidRefund.status, 'partial'); assert.equal(d.invalidRefund.settlementOperatingRaw, null);
  assert.equal(d.unresolved.status, 'partial'); assert.equal(d.unresolved.settlementOperatingRaw, null); assert.equal(d.unresolved.runway.status, 'unknown');
  if (final) {
    const u = d.subsidyGrantsUnknown; assert.ok(u, 'final report retains missing-grant correction');
    assert.ok(u.gaps.includes('OPERATING_SUBSIDY_GRANTS_UNKNOWN'));
    for (const k of ['subsidyBudgetRemainingRaw', 'subsidyBudgetShortfallRaw']) assert.equal(u.scenario[k], null, 'missing grant evidence withholds subsidy budget');
    assert.equal(u.scenario.subsidyBudgetRunway.availableRaw, null); assert.equal(u.scenario.subsidyBudgetRunway.status, 'unknown');
  } else assert.equal(d.subsidyGrantsUnknown, undefined, 'earlier report must remain distinguishable');
}

function canonicalJson(value) {
  if (value === null || ['string', 'boolean', 'number'].includes(typeof value)) return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}
const objectHash = value => sha256(canonicalJson(value));
const boundCandidateHash = c => {
  const { observedAtMs: _at, blockNumber: _block, blockHash: _blockHash, ...bound } = c;
  return objectHash(bound);
};
const maximum = (a, b) => a > b ? a : b;
function boundedAssessments(candidates, history, policy, cash, spent, { stopReason, nowMs } = {}) {
  return candidates.map(c => {
    const comparable = history.filter(h => h.prediction && h.prediction.routeBinding === c.routeBinding && h.prediction.problemId === c.problemId && h.prediction.providerId === c.providerId && h.prediction.tier === c.tier && h.prediction.funding === 'cash' && h.realized.status === 'confirmed' && h.executionCostDeviationRaw !== null && (nowMs === undefined || Date.parse(h.at) <= nowMs));
    const failures = comparable.filter(h => h.outcome === 'failed');
    const costBuffer = comparable.reduce((n, h) => maximum(n, raw(h.executionCostDeviationRaw)), 0n);
    const failureCushion = failures.reduce((n, h) => maximum(n, raw(h.realized.failureLossRaw ?? '0')), 0n);
    const cold = comparable.length ? 0n : raw(policy.coldStartCushionRaw);
    const net = raw(c.rewardRaw) - raw(c.rewardRaw) * unsigned(c.protocolFeeBps) / 10000n;
    const profit = net - raw(c.quote.priceRaw) - costBuffer;
    const required = maximum(raw(policy.minProfitRaw), (net * raw(policy.minMarginBps) + 9999n) / 10000n) + failureCushion + cold;
    const reasons = [], gaps = comparable.length ? [] : ['NO_COMPARABLE_HISTORY_CONSERVATIVE_COLD_START'];
    if (!policy.allowedProviderIds.includes(c.providerId)) reasons.push('PROVIDER_NOT_ALLOWED');
    if (c.taskStatus !== '1') reasons.push('TASK_NOT_OPEN');
    if (raw(c.escrowBalanceRaw) < raw(c.rewardRaw) || raw(c.rewardRaw) === 0n) reasons.push('TASK_NOT_FUNDED');
    if (nowMs !== undefined && (c.observedAtMs > nowMs || nowMs - c.observedAtMs > policy.maxObservationAgeMs)) reasons.push('OBSERVATION_STALE');
    if (nowMs !== undefined && (nowMs >= c.deadlineMs || nowMs >= c.quote.expiresAtMs)) reasons.push('QUOTE_OR_TASK_EXPIRED');
    if (raw(c.quote.priceRaw) + costBuffer > raw(policy.maxPaymentRaw)) reasons.push('PAYMENT_LIMIT');
    if (spent + raw(c.quote.priceRaw) + costBuffer > raw(policy.totalSpendRaw)) reasons.push('TOTAL_SPEND_LIMIT');
    if (cash - raw(c.quote.priceRaw) - costBuffer < raw(policy.reserveCashRaw)) reasons.push('CASH_RESERVE');
    if (!comparable.length && raw(c.quote.priceRaw) > raw(policy.coldStartMaxPriceRaw)) reasons.push('COLD_START_PRICE_LIMIT');
    if (failures.some(h => h.realized.failureLossRaw === null)) reasons.push('FAILURE_LOSS_UNKNOWN');
    if (profit < required) reasons.push('MINIMUM_PROFIT');
    if (stopReason) reasons.push(stopReason);
    return { taskId: c.taskId, providerId: c.providerId, routeBinding: c.routeBinding, status: reasons.length ? 'rejected' : 'eligible', reasons: [...new Set(reasons)].sort(), gaps, comparableCount: comparable.length, failedComparableCount: failures.length, coldStart: comparable.length === 0, quotedCostRaw: c.quote.priceRaw, costBufferRaw: String(costBuffer), failureCushionRaw: String(failureCushion), coldStartCushionRaw: String(cold), netRevenueRaw: String(net), completionProfitRaw: String(profit), requiredProfitRaw: String(required), surplusRaw: String(profit - required) };
  });
}
function bestAssessment(xs) {
  return xs.filter(x => x.status === 'eligible').sort((a, b) => raw(a.surplusRaw) > raw(b.surplusRaw) ? -1 : raw(a.surplusRaw) < raw(b.surplusRaw) ? 1 : raw(a.taskId) < raw(b.taskId) ? -1 : raw(a.taskId) > raw(b.taskId) ? 1 : a.providerId.localeCompare(b.providerId))[0]?.taskId;
}
function validateBoundedCandidates(candidates, tasks, startMs, endMs, latestBlock) {
  unique(candidates.map(c => `${c.taskId}:${c.providerId}`), 'bounded candidate identity');
  for (const c of candidates) {
    keys(c, ['source', 'taskId', 'problemId', 'providerId', 'tier', 'routeBinding', 'rewardRaw', 'escrowBalanceRaw', 'protocolFeeBps', 'taskStatus', 'deadlineMs', 'observedAtMs', 'blockNumber', 'blockHash', 'quote'], 'bounded candidate fields');
    assert.equal(c.source, 'local-chain-and-provider-quote', 'candidate must be observed, not hypothetical'); assert.equal(c.tier, 'cheap'); digest(c.routeBinding); chainHash(c.blockHash);
    const task = tasks.find(t => t.taskId === c.taskId); assert.ok(task, 'bounded candidate original published task'); assert.equal(c.problemId, task.problemId); eq(c.rewardRaw, task.rewardRaw); eq(c.escrowBalanceRaw, task.fundedEscrowRaw);
    assert.equal(c.taskStatus, '1'); assert.ok(unsigned(c.protocolFeeBps) <= 10000n); assert.ok(Number.isSafeInteger(c.blockNumber) && c.blockNumber >= task.creation.blockNumber);
    if (latestBlock !== undefined) assert.ok(c.blockNumber <= latestBlock, 'candidate block cannot exceed the recorded chain head');
    assert.equal(c.deadlineMs, Number(task.creation.values.deadline) * 1000, 'candidate deadline binds the funded task creation');
    assert.ok(Number.isSafeInteger(c.observedAtMs) && c.observedAtMs >= startMs && c.observedAtMs <= endMs, 'candidate observation in recorded window');
    keys(c.quote, ['priceRaw', 'paymentId', 'requestDigest', 'expiresAtMs'], 'bounded quote fields'); chainHash(c.quote.paymentId); chainHash(c.quote.requestDigest); assert.ok(unsigned(c.quote.priceRaw) > 0n);
    assert.ok(c.quote.expiresAtMs > c.observedAtMs); assert.ok(c.deadlineMs > c.observedAtMs);
  }
}
function validateBoundedDecision(decision, candidates, history, policy, cash, spent, options = {}) {
  assert.equal(decision.policyHash, objectHash(policy), 'decision frozen policy hash');
  const assessed = boundedAssessments(candidates, history, policy, cash, spent, options);
  assert.deepEqual(decision.candidates, assessed, 'decision assessment arithmetic and observed history');
  const selected = bestAssessment(assessed);
  assert.equal(decision.status, selected ? 'selected' : 'stopped'); assert.equal(decision.selectedTaskId, selected, 'highest-surplus candidate selection');
  if (selected) assert.equal(decision.selectedCandidateHash, boundCandidateHash(candidates.find(c => c.taskId === selected)), 'selected exact task/route/quote hash');
}

// Kept independent of the runtime controller: checks recorded observations and
// recomputes deterministic cash-only assessments without importing/executing TS.
export function validateBoundedEconomyReport(d, options = {}) {
  assert.equal(d.version, 1); assert.equal(d.suite, 'local-bounded-economy'); assert.equal(d.mode, 'execute-local'); assert.equal(d.status, 'passed'); localEnvironment(d, options); cleanup(d); validateRawFields(d);
  const startMs = Date.parse(iso(d.startedAt)), endMs = Date.parse(iso(d.completedAt)); assert.ok(endMs >= startMs); assert.equal(d.durationMs, endMs - startMs);
  assert.equal(d.scope.creditOptionsExercised, false); assert.equal(d.provenance.controller, 'bounded-deterministic-local-cash-only');
  const expectedPredicates = ['shadowKeepsNoncePaymentsCashAndModelCallsUnchanged', 'actualCashShortfallStopsNewPayment', 'candidatesUseFundedChainStateAndGenuineProviderQuotes', 'actualTaskStateDriftStopsBeforePayment', 'realSuccessFeedsNextDecision', 'paidFailureChangesNextChoice', 'inputOrderDoesNotControlSelection', 'exactQuoteAndTaskRevalidatedBeforeExecution', 'limitsFrozenBeforeNewPayment', 'unknownStopsNewPayment', 'originalUnknownRecoveryPreservesRequestAndSignedBytes', 'noOwnerTopupsOrGameSubsidy', 'actualsReadDoesNotMutateHistory'];
  assert.deepEqual(Object.keys(d.predicates).sort(), expectedPredicates.sort(), 'bounded required predicates'); for (const name of expectedPredicates) assert.equal(d.predicates[name], true, `bounded predicate ${name}`);
  checkHashMap(d.sourceSha256, BOUNDED_SOURCES); digest(d.policySha256); assert.equal(d.policySha256, objectHash(d.policy), 'policy fingerprint');
  const p = d.policy;
  keys(p, ['version', 'id', 'chainId', 'maxTasks', 'totalSpendRaw', 'maxPaymentRaw', 'reserveCashRaw', 'minProfitRaw', 'minMarginBps', 'coldStartCushionRaw', 'coldStartMaxPriceRaw', 'maxObservationAgeMs', 'startedAtMs', 'deadlineMs', 'allowedProviderIds'], 'bounded policy fields');
  assert.equal(p.version, 1); assert.equal(p.chainId, '31337'); assert.match(p.id, /^[a-z0-9-]{1,64}$/);
  for (const key of ['maxTasks', 'maxObservationAgeMs', 'startedAtMs', 'deadlineMs']) assert.ok(Number.isSafeInteger(p[key]) && p[key] >= 0, 'policy counters and clocks must be safe integers');
  assert.ok(p.maxTasks > 0 && p.maxTasks <= 32); assert.ok(p.deadlineMs > p.startedAtMs && p.deadlineMs - p.startedAtMs <= 300000); assert.ok(p.startedAtMs >= startMs && p.deadlineMs > endMs);
  assert.ok(p.maxObservationAgeMs > 0 && p.maxObservationAgeMs <= 30000); assert.ok(unsigned(p.maxPaymentRaw) > 0n && raw(p.maxPaymentRaw) <= unsigned(p.totalSpendRaw)); assert.ok(unsigned(p.coldStartMaxPriceRaw) <= raw(p.maxPaymentRaw)); assert.ok(unsigned(p.minMarginBps) <= 10000n);
  unique(p.allowedProviderIds); assert.ok(p.allowedProviderIds.length > 0); for (const id of p.allowedProviderIds) assert.match(id, /^[a-zA-Z0-9._-]{1,64}$/);
  unique(d.publishedTasks.map(t => t.taskId));
  assert.equal(d.publishedTasks.length, 7, 'bounded funded catalog includes the real state-drift guard task');
  for (const task of d.publishedTasks) { receipt(task.creation, 'TaskCreated'); assert.equal(task.creation.values.taskId, task.taskId, 'bounded published task ownership'); eq(task.rewardRaw, task.fundedEscrowRaw); eq(task.creation.values.reward, task.rewardRaw); }
  const shadow = d.shadow; assert.equal(shadow.setupTransactionsExcluded, true); assert.deepEqual(shadow.before, shadow.after, 'shadow must preserve all business counters'); assert.ok(shadow.quoteCallsAfter > shadow.quoteCallsBefore);
  assert.ok(Number.isSafeInteger(shadow.decisionAtMs) && shadow.decisionAtMs >= p.startedAtMs && shadow.decisionAtMs < p.deadlineMs && shadow.decisionAtMs <= endMs, 'shadow decision within frozen policy window');
  validateBoundedCandidates(shadow.candidates, d.publishedTasks, startMs, endMs, d.chain.latestBlock);
  validateBoundedDecision(shadow.decision, shadow.candidates, [], p, raw(shadow.before.cashRaw), 0n, { nowMs: shadow.decisionAtMs }); assert.equal(shadow.decision.stopReason, 'CASH_RESERVE');
  eq(d.initialFunding.startupCapitalRaw, 600000n); eq(d.initialFunding.ownerTopupsAfterProvisionRaw, 0n); eq(d.initialFunding.gameSubsidyRaw, 0n); receipt(d.initialFunding.mint);
  eq(d.initialFunding.taskPublisherFundedRewardsRaw, sum(d.publishedTasks, 'fundedEscrowRaw'));
  const drift = d.taskStateDriftProbe;
  assert.deepEqual(drift.before, drift.after, 'task-state drift must stop before Agent payment or dispatch'); assert.equal(drift.blockedCode, 'SELECTED_BINDING_CHANGED');
  validateBoundedCandidates(drift.candidates, d.publishedTasks, startMs, endMs, d.chain.latestBlock); validateBoundedCandidates(drift.freshCandidates, d.publishedTasks, startMs, endMs, d.chain.latestBlock);
  assert.ok(Number.isSafeInteger(drift.decisionAtMs) && drift.decisionAtMs >= p.startedAtMs && drift.freshDecisionAtMs >= drift.decisionAtMs && drift.freshDecisionAtMs < p.deadlineMs && drift.freshDecisionAtMs <= endMs);
  validateBoundedDecision(drift.decision, drift.candidates, [], p, raw(drift.before.cashRaw), 0n, { nowMs: drift.decisionAtMs });
  receipt(drift.competingAcceptance, 'TaskAccepted'); assert.equal(drift.competingAcceptance.values.taskId, drift.decision.selectedTaskId, 'competing acceptance binds the selected guard task');
  assert.notEqual(drift.competingAcceptance.values.agentId, d.initialFunding.initialAgentId, 'state drift is caused by another Agent');
  assert.ok(!drift.freshCandidates.some(c => c.taskId === drift.decision.selectedTaskId), 'closed selected task must disappear from fresh observations');
  assert.equal(drift.freshCandidates.length, drift.candidates.length - 1);
  for (const candidate of drift.freshCandidates) assert.equal(boundCandidateHash(candidate), boundCandidateHash(drift.candidates.find(c => c.taskId === candidate.taskId)), 'unrelated task/quote bindings preserved across drift');
  assert.equal(d.rounds.length, 4); assert.ok(d.rounds.length <= p.maxTasks, 'frozen maximum tasks applies to every new execution'); assert.deepEqual(d.rounds.map(r => r.execution.phase), ['Succeeded', 'Failed', 'Succeeded', 'Paused']);
  unique(d.rounds.map(r => uuid(r.execution.requestId))); unique(d.rounds.map(r => chainHash(r.execution.paymentId))); unique(d.rounds.map(r => r.execution.taskId));
  let history = [], spent = 0n, revenue = 0n, prior = null;
  for (const [i, r] of d.rounds.entries()) {
    assert.equal(r.round, i + 1); if (prior) assert.deepEqual(r.before, prior, 'bounded cash/counter continuity');
    else { eq(r.before.cashRaw, d.initialFunding.startupCapitalRaw); assert.deepEqual(r.before, drift.after, 'new execution starts after rejected drift probe'); }
    assert.ok(Number.isSafeInteger(r.decisionAtMs) && r.decisionAtMs >= p.startedAtMs && r.decisionAtMs < p.deadlineMs && r.decisionAtMs <= endMs, 'execution decision within frozen policy window');
    assert.ok(Number.isSafeInteger(r.preflight.freshDecisionAtMs) && r.preflight.freshDecisionAtMs >= r.decisionAtMs && r.preflight.freshDecisionAtMs < p.deadlineMs && r.preflight.freshDecisionAtMs <= endMs);
    validateBoundedCandidates(r.candidates, d.publishedTasks, startMs, endMs, d.chain.latestBlock);
    validateBoundedDecision(r.decision, r.candidates, history, p, raw(r.before.cashRaw), spent, { nowMs: r.decisionAtMs });
    for (const field of ['reversedSelectedTaskId', 'rotatedSelectedTaskId']) assert.equal(r.counterfactual[field], r.decision.selectedTaskId, 'input-order independent selection');
    for (const [field, excluded] of [['withoutFailureSelectedTaskId', 'failed'], ['withoutSuccessSelectedTaskId', 'succeeded']]) assert.equal(r.counterfactual[field], bestAssessment(boundedAssessments(r.candidates, history.filter(h => h.outcome !== excluded), p, raw(r.before.cashRaw), spent, { nowMs: r.decisionAtMs })), 'recorded counterfactual must use actual history');
    const selected = r.candidates.find(c => c.taskId === r.decision.selectedTaskId), e = r.execution; assert.ok(selected);
    assert.ok(r.preflight.freshDecisionAtMs < selected.quote.expiresAtMs && r.preflight.freshDecisionAtMs < selected.deadlineMs, 'preflight before quote/task expiry');
    assert.equal(e.taskId, selected.taskId, 'execution follows selected task'); assert.equal(e.paymentId, selected.quote.paymentId, 'execution follows original quote payment');
    assert.equal(r.preflight.selectedCandidateHash, boundCandidateHash(selected)); assert.equal(r.preflight.freshCandidateHash, r.preflight.selectedCandidateHash, 'preflight exact original task and quote'); assert.equal(r.preflight.quotedPaymentStatus, 'Quoted');
    receipt(e.payment, 'ProviderPaid'); assert.equal(e.payment.values.agentId, d.initialFunding.initialAgentId); assert.equal(e.payment.values.paymentId, e.paymentId, 'payment receipt original ownership'); eq(e.payment.values.fromCredit, 0n); eq(e.payment.values.fromCash, e.chargedRaw); eq(e.chargedRaw, selected.quote.priceRaw);
    spent += raw(e.chargedRaw); assert.ok(spent <= raw(p.totalSpendRaw)); assert.ok(raw(e.chargedRaw) <= raw(p.maxPaymentRaw)); assert.ok(raw(r.after.cashRaw) >= raw(p.reserveCashRaw));
    let earned = 0n;
    if (e.settlement) {
      receipt(e.settlement, 'TaskSettled'); assert.equal(e.settlement.values.taskId, e.taskId, 'bounded settlement task ownership');
      const s = e.settlement.values; assert.equal(s.passed, e.phase === 'Succeeded'); eq(s.repaid, 0n); eq(s.slashed, 0n); earned = e.phase === 'Succeeded' ? raw(selected.rewardRaw) : 0n; eq(s.toAgent, earned); assert.ok(e.settlement.blockNumber > e.payment.blockNumber);
    } else { assert.equal(e.phase, 'Paused'); assert.equal(e.reason, 'SOLVE_DISPATCH_UNKNOWN'); }
    revenue += earned; eq(r.after.cashRaw, raw(r.before.cashRaw) - raw(e.chargedRaw) + earned, 'bounded actual cash conservation');
    eq(r.after.providerTokenRaw, raw(r.before.providerTokenRaw) + raw(e.chargedRaw)); assert.equal(r.after.paymentEvents, r.before.paymentEvents + 1); assert.equal(r.after.modelCalls, r.before.modelCalls + 1); assert.ok(r.after.agentNonce > r.before.agentNonce);
    const actual = r.actuals; assert.deepEqual(actual.readOnly.before, actual.readOnly.after, 'actuals reader must preserve journals and counters');
    for (const [k, v] of Object.entries(r.after)) assert.equal(actual.readOnly.before[k], v, 'actuals bind original result snapshot');
    digest(actual.readOnly.before.historySha256); digest(actual.readOnly.before.inputSha256);
    eq(actual.totals.inferenceCostRaw, spent); eq(actual.totals.taskRevenueRaw, revenue); eq(actual.totals.startupCapitalRaw, d.initialFunding.startupCapitalRaw);
    for (const k of ['refundsRaw', 'borrowingFeeRaw', 'gameSubsidyRaw', 'ownerCapitalRaw', 'loanPrincipalRaw']) eq(actual.totals[k], 0n);
    assert.equal(actual.accountingStatus, i === 3 ? 'partial' : 'complete'); if (i === 3) assert.equal(actual.totals.netOperatingRaw, null, 'Unknown cannot become realized operating profit'); else eq(actual.totals.netOperatingRaw, revenue - spent);
    unique(actual.history.entries.map(h => h.requestId)); assert.equal(actual.history.entries.length, i + 1, 'bounded history cannot invent observations');
    for (const h of actual.history.entries) {
      const original = d.rounds.slice(0, i + 1).find(x => x.execution.requestId === h.requestId); assert.ok(original, 'history original request binding');
      assert.equal(h.prediction.taskId, original.execution.taskId); assert.equal(h.prediction.routeBinding, original.candidates.find(c => c.taskId === original.execution.taskId).routeBinding); assert.equal(h.prediction.funding, 'cash'); assert.equal(h.prediction.source, 'original-workflow-admission');
      assert.ok(h.prediction.atMs <= Date.parse(h.at)); assert.ok(Date.parse(h.at) <= endMs && Date.parse(h.at) >= original.decisionAtMs, 'actual history stays in its original execution window'); eq(h.prediction.executionCostRaw, original.execution.chargedRaw);
      const phase = original.execution.phase; assert.equal(h.outcome, phase === 'Succeeded' ? 'succeeded' : phase === 'Failed' ? 'failed' : 'pending');
      eq(h.realized.executionCostRaw, original.execution.chargedRaw);
      if (phase === 'Failed') { eq(h.realized.failureLossRaw, original.execution.chargedRaw); eq(h.realized.taskRevenueRaw, 0n); }
      if (phase === 'Succeeded') eq(h.realized.taskRevenueRaw, original.execution.settlement.values.toAgent);
      if (phase === 'Paused') { assert.equal(h.realized.status, 'pending'); assert.equal(h.realized.taskRevenueRaw, null); assert.equal(h.executionCostDeviationRaw, null); }
      else { assert.equal(h.realized.status, 'confirmed'); eq(h.executionCostDeviationRaw, raw(h.realized.executionCostRaw) - raw(h.prediction.executionCostRaw)); eq(h.realized.borrowingFeeRaw, 0n); eq(h.realized.planningCostRaw, 0n); eq(h.realized.taskContributionRaw, raw(h.realized.taskRevenueRaw) - raw(h.realized.executionCostRaw)); eq(h.realized.netAfterPlanningRaw, h.realized.taskContributionRaw); }
    }
    const next = i < 3 ? d.rounds[i + 1].decision : d.stop.decision;
    assert.equal(r.nextChoice.selectedTaskId, next.selectedTaskId ?? null); assert.equal(r.nextChoice.stopReason, next.stopReason ?? null); assert.equal(r.nextChoice.policyHash, d.policySha256);
    history = actual.history.entries; prior = r.after;
  }
  assert.notEqual(d.rounds[1].decision.selectedTaskId, d.rounds[1].counterfactual.withoutSuccessSelectedTaskId, 'success must affect next actual selection');
  assert.notEqual(d.rounds[2].decision.selectedTaskId, d.rounds[2].counterfactual.withoutFailureSelectedTaskId, 'paid failure must affect next actual selection');
  assert.equal(d.stop.reason, 'UNRESOLVED_PAYMENT_OR_HISTORY'); assert.equal(d.stop.decision.stopReason, d.stop.reason); assert.equal(d.stop.decision.status, 'stopped'); assert.equal(d.stop.decision.selectedTaskId, undefined); assert.deepEqual(d.stop.before, d.stop.after); assert.deepEqual(d.stop.before, prior);
  assert.ok(Number.isSafeInteger(d.stop.decisionAtMs) && d.stop.decisionAtMs <= endMs && d.stop.decisionAtMs >= d.rounds[3].decisionAtMs);
  const stoppedCandidates = d.rounds[3].candidates.filter(c => c.taskId !== d.rounds[3].execution.taskId).map(c => ({ ...c, observedAtMs: d.stop.decisionAtMs }));
  validateBoundedDecision(d.stop.decision, stoppedCandidates, history, p, raw(prior.cashRaw), spent, { stopReason: d.stop.reason, nowMs: d.stop.decisionAtMs });
  const u = d.unknownRecovery, last = d.rounds[3].execution; assert.equal(u.originalRequestId, last.requestId, 'bounded Unknown original request'); assert.equal(u.paymentId, last.paymentId, 'bounded Unknown original payment');
  assert.equal(u.originalPolicySha256, d.policySha256); digest(u.changedPolicySha256); assert.notEqual(u.changedPolicySha256, u.originalPolicySha256); assert.equal(u.changedPolicyDecision.policyHash, u.changedPolicySha256); assert.equal(u.changedPolicyDecision.stopReason, 'UNRESOLVED_PAYMENT_OR_HISTORY'); assert.equal(u.changedPolicyDecision.status, 'stopped');
  const changedPolicy = { ...p, id: 'bounded-local-v2-recovery-probe', minProfitRaw: '1' }; assert.equal(u.changedPolicySha256, objectHash(changedPolicy), 'recovery probe changed-policy binding');
  assert.ok(Number.isSafeInteger(u.changedPolicyDecisionAtMs) && u.changedPolicyDecisionAtMs >= d.stop.decisionAtMs && u.changedPolicyDecisionAtMs <= endMs);
  validateBoundedDecision(u.changedPolicyDecision, stoppedCandidates.map(c => ({ ...c, observedAtMs: u.changedPolicyDecisionAtMs })), history, changedPolicy, raw(prior.cashRaw), spent, { stopReason: d.stop.reason, nowMs: u.changedPolicyDecisionAtMs });
  for (const k of ['originalIntentSha256', 'originalAcceptBytesSha256', 'originalPaymentBytesSha256']) digest(u[k]);
  assert.equal(u.phaseBefore, 'Paused'); assert.equal(u.phaseAfter, 'Paused'); assert.deepEqual(u.before, u.after, 'original Unknown recovery preserves balance, nonce, payments and dispatch'); assert.deepEqual(u.before, prior); assert.equal(u.quoteCallsBeforeRecovery, u.quoteCallsAfterRecovery); assert.equal(u.policyChangeIgnoredByOriginalRecovery, true); assert.equal(u.recoveryTargetReconstructedFromDurableIntent, true);
  assert.equal(u.recoveryMode, 'same-worker-new-executor-from-durable-intent');
  const journalNames = d.rounds.flatMap(r => [`decision-${r.round}.json`, `completion-${r.round}.json`, `${r.execution.requestId}/session.json`, `${r.execution.requestId}/workflow/session.json`]);
  assert.deepEqual(Object.keys(d.journalSha256).sort(), journalNames.sort(), 'bounded original journal references'); Object.values(d.journalSha256).forEach(digest);
  assert.equal(u.originalIntentSha256, d.journalSha256['decision-4.json'], 'Unknown recovery binds the saved original decision intent');
  assert.deepEqual(Object.keys(d.artifactSha256).sort(), ['AgentAccount', 'CreditManager', 'TaskEscrow', 'ERC8004Adapter', 'MockERC20', 'MockIdentityRegistry'].sort()); Object.values(d.artifactSha256).forEach(digest);
  eq(d.chain.finalAgentCashRaw, raw(d.initialFunding.startupCapitalRaw) + revenue - spent, 'bounded final cash reconciliation'); eq(d.chain.providerNetReceivedRaw, spent); assert.equal(d.chain.providerPaidEventCount, d.rounds.length);
  return { spentRaw: String(spent), taskRevenueRaw: String(revenue), finalCashRaw: d.chain.finalAgentCashRaw, confirmedOperatingResultRaw: null, lastConfirmedOperatingResultRaw: d.rounds[2].actuals.totals.netOperatingRaw, failedExpenseRaw: d.rounds[1].execution.chargedRaw };
}

export function validateBoundedShadowReport(d, options = {}) {
  assert.equal(d.version, 1); assert.equal(d.suite, 'local-bounded-economy'); assert.equal(d.mode, 'shadow'); assert.equal(d.status, 'passed'); localEnvironment(d, options); cleanup(d); validateRawFields(d); checkHashMap(d.sourceSha256, BOUNDED_SOURCES);
  const startMs = Date.parse(iso(d.startedAt)), endMs = Date.parse(iso(d.completedAt)); assert.equal(d.durationMs, endMs - startMs); assert.ok(endMs >= startMs);
  assert.equal(d.provenance.controller, 'bounded-deterministic-local-cash-only'); assert.equal(d.scope.creditOptionsExercised, false);
  assert.equal(d.policySha256, objectHash(d.policy));
  const p = d.policy;
  keys(p, ['version', 'id', 'chainId', 'maxTasks', 'totalSpendRaw', 'maxPaymentRaw', 'reserveCashRaw', 'minProfitRaw', 'minMarginBps', 'coldStartCushionRaw', 'coldStartMaxPriceRaw', 'maxObservationAgeMs', 'startedAtMs', 'deadlineMs', 'allowedProviderIds'], 'bounded shadow policy fields');
  assert.equal(p.version, 1); assert.equal(p.chainId, '31337'); assert.ok(p.startedAtMs >= startMs && p.startedAtMs <= endMs && p.deadlineMs > endMs && p.deadlineMs - p.startedAtMs <= 300000);
  assert.match(p.id, /^[a-z0-9-]{1,64}$/); for (const key of ['startedAtMs', 'deadlineMs']) assert.ok(Number.isSafeInteger(p[key]) && p[key] >= 0);
  assert.ok(Number.isSafeInteger(p.maxTasks) && p.maxTasks > 0 && p.maxTasks <= 32); assert.ok(Number.isSafeInteger(p.maxObservationAgeMs) && p.maxObservationAgeMs > 0 && p.maxObservationAgeMs <= 30000);
  assert.ok(raw(p.maxPaymentRaw) > 0n && raw(p.maxPaymentRaw) <= raw(p.totalSpendRaw)); assert.ok(raw(p.coldStartMaxPriceRaw) <= raw(p.maxPaymentRaw)); assert.ok(unsigned(p.minMarginBps) <= 10000n); unique(p.allowedProviderIds); assert.ok(p.allowedProviderIds.length > 0 && p.allowedProviderIds.length <= 8); for (const id of p.allowedProviderIds) assert.match(id, /^[a-zA-Z0-9._-]{1,64}$/);
  assert.deepEqual(d.rounds, [], 'default shadow cannot execute business rounds');
  for (const field of ['initialFunding', 'chain', 'stop', 'unknownRecovery', 'taskStateDriftProbe']) assert.equal(d[field], undefined, 'default shadow cannot claim execution evidence');
  const predicates = ['shadowKeepsNoncePaymentsCashAndModelCallsUnchanged', 'actualCashShortfallStopsNewPayment', 'candidatesUseFundedChainStateAndGenuineProviderQuotes'];
  assert.deepEqual(Object.keys(d.predicates).sort(), predicates.sort()); for (const name of predicates) assert.equal(d.predicates[name], true);
  assert.equal(d.publishedTasks.length, 7); unique(d.publishedTasks.map(t => t.taskId));
  for (const task of d.publishedTasks) { receipt(task.creation, 'TaskCreated'); assert.equal(task.creation.values.taskId, task.taskId); eq(task.rewardRaw, task.fundedEscrowRaw); eq(task.creation.values.reward, task.rewardRaw); }
  const s = d.shadow; assert.equal(s.setupTransactionsExcluded, true); assert.deepEqual(s.before, s.after, 'default shadow preserves cash, nonce, payments and model calls');
  assert.ok(s.quoteCallsAfter > s.quoteCallsBefore); assert.ok(Number.isSafeInteger(s.decisionAtMs) && s.decisionAtMs >= p.startedAtMs && s.decisionAtMs < p.deadlineMs && s.decisionAtMs <= endMs);
  assert.equal(s.candidates.length, d.publishedTasks.length); validateBoundedCandidates(s.candidates, d.publishedTasks, startMs, endMs);
  validateBoundedDecision(s.decision, s.candidates, [], p, raw(s.before.cashRaw), 0n, { nowMs: s.decisionAtMs }); assert.equal(s.decision.stopReason, 'CASH_RESERVE');
  assert.deepEqual(Object.keys(d.artifactSha256).sort(), ['AgentAccount', 'CreditManager', 'TaskEscrow', 'ERC8004Adapter', 'MockERC20', 'MockIdentityRegistry'].sort()); Object.values(d.artifactSha256).forEach(digest);
  return { defaultMode: 'shadow', setupTransactionsExcluded: true, observedFundedTasks: s.candidates.length, cashRaw: s.before.cashRaw, reserveCashRaw: p.reserveCashRaw, businessPaymentsAdded: 0, modelCallsAdded: 0, nonceIncrease: 0, stopReason: 'CASH_RESERVE' };
}

const CAPABILITIES = Object.freeze({
  'automatic-game:usdc': ['autonomy.game-to-task.usdc', 'Automatic game → USDC task'],
  'automatic-game:llm-credits': ['autonomy.game-to-task.tokens', 'Automatic game → token task'],
  'game-refill:original-task': ['recovery.token-refill.original-task', 'Original task after token refill'],
  'budget-model-routing': ['inference.budget-routing', 'Budget-based model routing'],
  'external-agent-hiring': ['collaboration.external-hiring', 'External Agent hiring'],
  'credit-loop': ['credit.two-task-loop', 'Two-task credit loop'],
  'presenter-credit-loop': ['credit.two-task-loop', 'Presenter two-task credit loop'],
  external: ['collaboration.external-hiring', 'Public external Agent hiring'],
  'fallback-fresh': ['inference.budget-routing', 'Public model budget downgrade'],
  'automatic-fresh': ['autonomy.game-to-task.usdc', 'Public game → USDC → settled task'],
  'token-supplement': ['autonomy.game-to-task.tokens', 'Public token game and task'],
  'settlement-recovery': ['recovery.original-settlement', 'Original settlement recovery'],
  'presenter-resource-snapshot': ['resources.read-only-snapshot', 'Read-only resource snapshot'],
});
const factKeys = new Set(['games', 'tasks', 'cashAfterRaw', 'debtAfterRaw', 'replayAddedCalls', 'taskId', 'childRequestId', 'taskIdPreserved', 'acceptTxHashPreserved', 'modelSequence', 'budgetRaw', 'chargedRaw', 'provider', 'unknownRefundRaw', 'taskIds', 'finalCashRaw', 'finalDebtRaw', 'replayAddedEffects', 'externalPayments', 'creditsGranted', 'tokensConsumed', 'newLoanRaw', 'originalSettlementTxHash', 'verifierNonceIncrease', 'addedModelRequests', 'legacyDockerReevaluation', 'spentRaw', 'remainingBudgetRaw', 'chainWrites', 'modelCalls']);
function legacyFacts(facts) {
  const result = {};
  for (const [key, value] of Object.entries(facts)) {
    assert.ok(factKeys.has(key), 'unregistered public fact field');
    const check = v => { assert.ok(typeof v === 'boolean' || (typeof v === 'number' && Number.isSafeInteger(v)) || (typeof v === 'string' && /^[a-zA-Z0-9:_.-]+$/.test(v)), 'public fact scalar'); return v; };
    result[key] = Array.isArray(value) ? value.map(check) : check(value);
  }
  return result;
}
function emptyBindings() { return { requestIds: [], taskIds: [], paymentIds: [], transactionHashes: [] }; }
function economicBindings(d) {
  return {
    requestIds: [...new Set(d.scenarios.map(s => uuid(s.requestId)))],
    taskIds: d.scenarios.slice(0, 6).map(s => s.taskId),
    paymentIds: d.scenarios.filter(s => s.payment).map(s => chainHash(s.payment.values.paymentId)),
    transactionHashes: [...new Set([...d.publishedTasks.map(t => t.creation.txHash), ...d.scenarios.flatMap(s => [s.payment?.txHash, s.settlement?.txHash, s.refund?.txHash].filter(Boolean))])],
  };
}
function createEvent(claim, type, title, description, values = {}) {
  const event = { id: `${claim.id}:${claim.timeline.length + 1}`, claimId: claim.id, reportId: claim.reportId, type, title, description };
  // All keys and labels are selected by this module; report content is never
  // recursively copied. Payment bytes, responses and operator URLs are excluded.
  for (const key of ['requestId', 'taskId', 'paymentId', 'txHash', 'amountRaw', 'blockNumber', 'at']) if (values[key] !== undefined) event[key] = values[key];
  claim.timeline.push(event); return event;
}
function economicTimeline(c, d) {
  for (const t of d.publishedTasks) createEvent(c, 'task-published', 'Task reward funded', 'Publisher pre-funded the task reward on the isolated chain.', { taskId: t.taskId, txHash: t.creation.txHash, amountRaw: t.rewardRaw, blockNumber: t.creation.blockNumber });
  for (const s of d.scenarios) {
    const ownership = { requestId: s.requestId, taskId: s.taskId };
    if (s.name === 'reject-loss-before-payment') createEvent(c, 'admission-rejected', 'Unprofitable task rejected', 'Cash, nonce, model-call and quote counters stayed unchanged.', ownership);
    if (s.payment) createEvent(c, 'provider-paid', 'Original inference payment', 'Cash and task-bound credit fund the recorded provider charge.', { ...ownership, paymentId: s.payment.values.paymentId, txHash: s.payment.txHash, amountRaw: s.chargedRaw, blockNumber: s.payment.blockNumber });
    if (s.settlement) createEvent(c, s.settlement.values.passed ? 'task-settled' : 'task-failed', s.settlement.values.passed ? 'Independent task settlement' : 'Paid hidden-test failure', s.settlement.values.passed ? 'The reward repays principal and fees, then credits residual cash.' : 'The paid expense is retained; task revenue is zero.', { ...ownership, txHash: s.settlement.txHash, amountRaw: s.taskRevenueRaw, blockNumber: s.settlement.blockNumber });
    if (s.name === 'unknown-original-request-recovery') createEvent(c, 'unknown-recovered', 'Original Unknown request remains paused', 'Recovery preserves original payment bytes, cash, nonce and model-call count.', { ...ownership, paymentId: s.paymentId, amountRaw: s.chargedRaw });
    if (s.refund) createEvent(c, 'original-payment-refunded', 'Original payment refunded', 'The original payment is refunded without creating successful task revenue.', { ...ownership, taskId: d.scenarios[5].taskId, paymentId: s.paymentId, txHash: s.refund.txHash, amountRaw: s.refundedRaw, blockNumber: s.refund.blockNumber });
  }
}
function independentTimeline(c, d) {
  const rounds = d.rounds ?? [];
  c.bindings = { requestIds: rounds.map(r => r.requestId), taskIds: d.publication.tasks.map(t => t.taskId), paymentIds: rounds.map(r => r.quote.paymentId), transactionHashes: [...new Set([...d.publication.tasks.map(t => t.creation.txHash), ...rounds.flatMap(r => [r.acceptance.txHash, r.payment.txHash, r.settlement.txHash]), ...(d.unknown ? [d.unknown.resolution.receipt.txHash] : [])])] };
  for (const task of d.publication.tasks) createEvent(c, 'task-published', 'External publisher funded task', 'The independent publisher signed the manifest and funded the recorded local task.', { taskId: task.taskId, txHash: task.creation.txHash, blockNumber: task.creation.blockNumber, amountRaw: task.rewardRaw });
  if (d.mode === 'shadow') { createEvent(c, 'shadow-observed', 'Independent Worker observed funded tasks', 'The measured observation adds no payment, model request, acceptance, settlement or wallet nonce.', { at: new Date(d.shadow.observation.nowMs).toISOString(), amountRaw: d.shadow.before.cashRaw }); return; }
  const restartTitles = {
    'before-payment': 'Worker restarted before original payment',
    'after-payment': 'Worker restarted after committed payment',
    'after-settlement': 'Worker restarted after original settlement',
    'after-unknown': 'Worker restarted after explicit Unknown resolution',
  };
  const restart = (round, checkpoint) => {
    const interruption = d.interruptions.find(i => i.original.requestId === round.requestId && i.checkpoint === checkpoint);
    if (interruption) createEvent(c, 'worker-process-restarted', restartTitles[checkpoint], 'The old operating-system process exited. A distinct process retained the original policy, handles, signed-byte hashes, gross spend, reservation and pending request without duplicate business effects.', { requestId: interruption.original.requestId, taskId: round.taskId, paymentId: interruption.original.paymentId });
  };
  for (const round of rounds) {
    const binding = { requestId: round.requestId, taskId: round.taskId, paymentId: round.quote.paymentId };
    createEvent(c, 'decision-selected', 'Bounded choice from signed funded tasks', 'The Worker independently selected the highest eligible surplus using previous actual outcomes and the original cash-only limits.', { ...binding, at: new Date(round.observation.nowMs).toISOString() });
    createEvent(c, 'task-accepted', 'Original task accepted by the Worker', 'The acceptance event binds the selected task to the same Agent before its cash payment.', { ...binding, txHash: round.acceptance.txHash, blockNumber: round.acceptance.blockNumber });
    restart(round, 'before-payment');
    createEvent(c, 'provider-paid', 'Original quote paid once', 'The cash payment belongs to the exact observed original quote and request.', { ...binding, txHash: round.payment.txHash, blockNumber: round.payment.blockNumber, amountRaw: round.chargedRaw });
    restart(round, 'after-payment');
    if (round.outcome === 'refunded') {
      createEvent(c, 'payment-unknown', 'Original paid Unknown blocks new work', 'The original paid dispatch remains unresolved. The blocked snapshots preserve cash, nonce, payment, model, acceptance and settlement counters, and a replacement journal is rejected.', binding);
      createEvent(c, 'original-payment-refunded', 'Original Unknown payment explicitly refunded', 'The original full provider refund returns the recorded service charge without creating successful task income. The original task must also terminate before work may continue.', { ...binding, txHash: d.unknown.resolution.receipt.txHash, blockNumber: d.unknown.resolution.receipt.blockNumber, amountRaw: d.unknown.resolution.amountRaw });
    }
    createEvent(c, round.outcome === 'succeeded' ? 'task-settled' : 'task-failed', round.outcome === 'refunded' ? 'Original Unknown task explicitly terminated' : round.outcome === 'failed' ? 'Paid Docker failure retained' : 'Independent Docker settlement', round.outcome === 'refunded' ? 'Authorized failure terminates the original task after its explicit provider refund; it does not establish a Docker success.' : 'The independent verifier recorded the actual public and hidden Docker test verdict.', { ...binding, txHash: round.settlement.txHash, blockNumber: round.settlement.blockNumber, amountRaw: round.revenueRaw });
    restart(round, 'after-settlement');
    if (round.outcome === 'refunded') {
      createEvent(c, 'unknown-resolved', 'Original Unknown continuation requirements satisfied', 'The original full refund and terminal failed task jointly establish explicit resolution. Further work retains the original policy and gross spending budget.', binding);
      restart(round, 'after-unknown');
    }
  }
}
function checkedAccounting(d) {
  const t = d.accounting.totals;
  return {
    currency: 'USDC', decimals: 6, startupCapitalRaw: t.startupCapitalRaw, taskRevenueRaw: t.taskRevenueRaw,
    netServiceCostRaw: t.inferenceCostRaw, refundsRaw: t.refundsRaw, borrowingFeeRaw: t.borrowingFeeRaw,
    operatingResultRaw: t.netOperatingRaw, finalCashRaw: d.chain.finalAgentCashRaw, providerNetReceivedRaw: d.chain.providerNetReceivedRaw,
    paymentEventCount: d.chain.providerPaidEventCount, profitableTasks: 3, cashOnlyRetainedEarningsTask: true,
    failedExpenseRaw: d.scenarios[4].chargedRaw, unknownRefundsOriginalPayment: true, replayAddedEffects: 0,
  };
}
function roleFacts(d) {
  const o = d.operatingReports.at(-1).operating;
  return { ...checkedAccounting(d), supplierGrossReceiptsRaw: o.suppliers.grossReceiptsRaw, supplierRefundsRaw: o.suppliers.refundsRaw, supplierNetReceiptsRaw: o.suppliers.netReceiptsRaw, roleTotalsAdditive: false, actualProfitRaw: null,
    hypotheticalRunway: d.operatingReports.map(r => ({ point: r.label, spendableCashRaw: r.operating.cash.spendableCashRaw, horizonMs: r.operating.runway.horizonMs, fullTasks: r.operating.runway.fullTasks, source: 'owner-hypothetical' })) };
}
function sourceEnvironment(r, d, options = {}) {
  if (['local-economic', 'local-bounded', 'local-bounded-shadow'].includes(r.kind)) return localEnvironment(d, options);
  if (['local-independent', 'local-independent-shadow'].includes(r.kind)) return { kind: 'local-anvil', chainId: '31337', modelMode: 'controlled', execution: r.kind === 'local-independent-shadow' ? 'external-installed-SDK-shadow-observation' : 'external-installed-SDK-real-process-recovery' };
  if (r.kind === 'local-consumer') return { kind: 'local-anvil', chainId: '31337', modelMode: 'controlled', execution: 'real-local-contracts-and-Docker' };
  if (r.kind.startsWith('offline-')) return offlineEnvironment(d);
  return r.kind === 'public-monad' ? { kind: 'public-monad', chainId: '10143', modelMode: r.reportId.endsWith('-resources') ? 'read-only-snapshot' : r.reportId.endsWith('-settlement-recovery') ? 'saved-original-recovery' : 'saved-real-vendor', execution: 'historical-public-chain-report' }
    : { kind: 'local-anvil', chainId: '31337', modelMode: 'controlled', execution: 'historical-local-chain-report' };
}
function limitations(r) {
  return [...LIMITATIONS,
    ...(r.kind.includes('local') || r.kind === 'historical-anvil' ? ['Local contracts and Docker evaluation do not establish a fresh public-chain or real-vendor execution.'] : []),
    ...(r.kind === 'local-consumer' ? ['Independent installation demonstrates separate roles, not independent-team adoption. Signed task specifications are admitted off-chain by a trusted operator.'] : []),
    ...(r.kind.startsWith('offline-') ? ['Synthetic scenario clocks and declared costs are controlled inputs; operator declarations are not authenticated invoices.'] : []),
    ...(r.evidenceStatus === 'earlier' ? ['Retained earlier observation: final missing-grant handling is established only by its separately named final report.'] : []),
  ];
}
function command(r) {
  if (r.kind === 'local-independent') return 'node scripts/check-independent-economy.mjs --execute-local --report <new absolute file>';
  if (r.kind === 'local-independent-shadow') return 'node scripts/check-independent-economy.mjs --report <new absolute file>';
  if (r.kind === 'local-bounded') return 'node scripts/check-bounded-economy.mjs --execute-local --report <new absolute file>';
  if (r.kind === 'local-bounded-shadow') return 'node scripts/check-bounded-economy.mjs --report <new absolute file>';
  if (r.kind === 'local-economic') return 'npm run economics:local -- --report <new absolute file>';
  if (r.kind === 'local-consumer') return 'npm run test:publisher-worker -- --report <new absolute file>';
  if (r.kind === 'offline-strategy') return 'npm run strategy:demo -- --report <new absolute file>';
  if (r.kind === 'offline-role') return 'npm run operating:demo -- --report <new absolute file>';
  return 'node scripts/check-acceptance-evidence.mjs --json';
}
function addClaim(claims, source, capabilityId, title, summary, checkedFacts, bindings = emptyBindings()) {
  const c = {
    id: `${source.reportId}:${capabilityId}`, capabilityId, title, summary, reportId: source.reportId,
    source: { file: source.file, sha256: source.sha256 }, environment: source.environment, implementation: source.implementation,
    evidenceStatus: source.evidenceStatus, reproductionCommand: command(REPORTS.get(source.file) ?? source),
    scope: source.kind.startsWith('offline-') ? 'controlled-offline-observation' : source.kind === 'public-monad' ? 'historical-saved-public-observation' : 'isolated-local-chain-observation',
    limitations: limitations(source), checkedFacts, bindings, timeline: [],
  };
  claims.push(c); return c;
}

/** Build a public, deterministic manifest from the fixed repository registry.
 * overrides exists for in-process negative tests only. CLI accepts no input path.
 * It never changes or writes evidence files and never loads operator env files.
 */
export function buildReviewEvidence({ overrides = {} } = {}) {
  const allowed = new Set([...REPORTS.keys(), ...NARRATIVES.map(([f]) => f)]);
  for (const file of Object.keys(overrides)) assert.ok(allowed.has(file), `unregistered evidence input: ${file}`);
  const cache = new Map();
  function load(file) {
    assert.ok(allowed.has(file), 'unregistered evidence reference');
    if (cache.has(file)) return cache.get(file);
    const saved = repoBytes(file), value = overrides[file];
    const data = value === undefined ? (file.endsWith('.json') ? JSON.parse(saved) : saved.toString('utf8')) : structuredClone(value);
    const bytes = value === undefined ? saved : typeof data === 'string' ? Buffer.from(data) : Buffer.from(JSON.stringify(data));
    const result = { file, data, sha256: sha256(bytes) }; cache.set(file, result); return result;
  }
  const sources = [], claims = [];
  for (const r of EVIDENCE_REGISTRY) {
    const loaded = load(r.file), d = loaded.data;
    if (r.file.startsWith(ACCEPTANCE)) validateRawFields(d);
    if (r.kind === 'local-economic') validateEconomic(d);
    if (r.kind === 'local-bounded') validateBoundedEconomyReport(d);
    if (r.kind === 'local-bounded-shadow') validateBoundedShadowReport(d);
    if (r.kind === 'local-independent') validateIndependentEconomyReport(d);
    if (r.kind === 'local-independent-shadow') validateIndependentShadowReport(d);
    if (r.kind === 'local-consumer') validateConsumer(d);
    if (r.kind === 'offline-strategy') validateOfflineStrategy(d);
    if (r.kind === 'offline-role') validateOfflineRole(d, r.evidenceStatus === 'final');
    const source = { ...r, sha256: loaded.sha256, environment: sourceEnvironment(r, d), implementation: implementation(d), documentation: [] };
    sources.push(source);
    if (['local-independent', 'local-independent-shadow'].includes(r.kind)) {
      const facts = r.kind === 'local-independent' ? validateIndependentEconomyReport(d) : validateIndependentShadowReport(d);
      const c = addClaim(claims, source, r.kind === 'local-independent' ? 'economy.independent-bounded-process-recovery' : 'economy.independent-default-shadow', r.kind === 'local-independent' ? 'Independent publisher and bounded Worker process recovery' : 'Independent Worker default shadow observation', r.kind === 'local-independent' ? 'An externally installed SDK consumer selects signed funded tasks, retains actual paid failure, recovers killed Worker processes, resolves the original Unknown payment and continues under its original cash-only policy.' : 'The externally installed Worker observes signed funded tasks and genuine provider quotes without measured business effects.', facts);
      c.limitations.push('The publisher uses a trusted signed task catalog. This local observation does not establish independent-team adoption, commercial demand or an autonomous LLM planner.', 'Saved byte hashes establish internal fingerprint consistency. The review does not independently authenticate signatures, provider responses or chain provenance.', 'Cash-only policy uses a fixed cold-start cushion and paid failure loss. It does not estimate success probability, supplier profit or native gas cost.');
      if (r.kind === 'local-independent') c.limitations.push('A full refund and an explicitly authorized failed-task termination resolve Unknown. The termination is separate from Docker success. A lock claim with uncertain ownership remains blocked for explicit reconciliation.');
      independentTimeline(c, d);
    } else if (r.kind === 'local-bounded-shadow') {
      const c = addClaim(claims, source, 'economy.bounded-default-shadow', 'Default bounded shadow observation', 'The default command observes funded local tasks and genuine quotes; its measured window adds no payments, model calls or Agent nonce changes.', validateBoundedShadowReport(d), { ...emptyBindings(), taskIds: d.publishedTasks.map(t => t.taskId), transactionHashes: d.publishedTasks.map(t => t.creation.txHash) });
      c.limitations.push('Fixture setup deployed and funded local contracts before the measured shadow window; the command as a whole is not transaction-free.', 'This shadow summary does not retain an independent final chain-head number.');
      createEvent(c, 'local-fixture-funded', 'Local fixture setup precedes measurement', 'TaskCreated receipts establish funded local tasks before the read-only shadow window.');
      createEvent(c, 'shadow-observed', 'Default shadow stops at cash reserve', 'Genuine provider quotes are reads. The measured cash, nonce, payment-event and model-call snapshots are identical.', { at: new Date(d.shadow.decisionAtMs).toISOString(), amountRaw: d.shadow.before.cashRaw });
    } else if (r.kind === 'local-bounded') {
      const facts = validateBoundedEconomyReport(d);
      const c = addClaim(claims, source, 'economy.bounded-feedback-execution', 'Bounded local decision → execution → feedback', 'A frozen cash-only controller selects from observed funded tasks, uses real local success and paid failure in later choices, then stops and recovers the original Unknown payment.', {
        ...facts, currency: 'USDC', decimals: 6, startupCapitalRaw: d.initialFunding.startupCapitalRaw, actualTaskStateDriftBlocked: true, successChangesNextSelection: true, paidFailureChangesNextSelection: true, inputOrderIndependent: true, unknownStopsNewPayment: true, recoveryMode: 'same-worker-new-executor-from-durable-intent',
        policy: { maxTasks: d.policy.maxTasks, totalSpendRaw: d.policy.totalSpendRaw, maxPaymentRaw: d.policy.maxPaymentRaw, reserveCashRaw: d.policy.reserveCashRaw, minProfitRaw: d.policy.minProfitRaw, minMarginBps: d.policy.minMarginBps, coldStartCushionRaw: d.policy.coldStartCushionRaw, maxObservationAgeMs: d.policy.maxObservationAgeMs },
        decisions: d.rounds.map(r => ({ round: r.round, taskId: r.execution.taskId, phase: r.execution.phase, selectedSurplusRaw: r.decision.candidates.find(c => c.taskId === r.execution.taskId).surplusRaw, selectedWithoutSuccessTaskId: r.counterfactual.withoutSuccessSelectedTaskId, selectedWithoutFailureTaskId: r.counterfactual.withoutFailureSelectedTaskId, cashAfterRaw: r.after.cashRaw })),
      }, { requestIds: d.rounds.map(r => r.execution.requestId), taskIds: d.publishedTasks.map(t => t.taskId), paymentIds: d.rounds.map(r => r.execution.paymentId), transactionHashes: [...d.publishedTasks.map(t => t.creation.txHash), d.taskStateDriftProbe.competingAcceptance.txHash, ...d.rounds.flatMap(r => [r.execution.payment.txHash, r.execution.settlement?.txHash].filter(Boolean))] });
      c.limitations.push('Deterministic local controller with a trusted task catalog, controlled delivery responses and a fixed cold-start cushion; this is not an autonomous LLM planner or permissionless market.', 'The final paid Unknown request keeps total operating result unknown. The last confirmed operating result is shown separately.', 'Recovery reconstructs durable intent in the same worker with a new executor; no full operating-system or process restart is claimed.');
      createEvent(c, 'policy-frozen', 'Cash-only execution limits frozen', 'Task count, total spend, payment cap, reserve, profit requirements and deadline are frozen before new payments.', { at: new Date(d.policy.startedAtMs).toISOString() });
      createEvent(c, 'state-drift-blocked', 'Real task-state drift rejected before payment', 'Another local Agent accepted the selected guard task. Fresh observations removed it and preflight rejected the stale selection while Agent business counters stayed unchanged.', { taskId: d.taskStateDriftProbe.decision.selectedTaskId, txHash: d.taskStateDriftProbe.competingAcceptance.txHash, blockNumber: d.taskStateDriftProbe.competingAcceptance.blockNumber });
      for (const r of d.rounds) {
        const e = r.execution, ownership = { requestId: e.requestId, taskId: e.taskId, paymentId: e.paymentId };
        createEvent(c, 'decision-selected', 'Observed candidate selected', 'The selected task has the highest eligible surplus under the frozen policy and prior actual outcomes.', { ...ownership, at: new Date(r.decisionAtMs).toISOString() });
        createEvent(c, 'preflight-verified', 'Exact task and quote revalidated', 'The fresh candidate hash equals the original selection and the provider payment status remains Quoted.', { ...ownership, at: new Date(r.preflight.freshDecisionAtMs).toISOString() });
        createEvent(c, 'provider-paid', 'Original cash inference payment', 'The payment event belongs to the selected task quote; no new credit is drawn.', { ...ownership, txHash: e.payment.txHash, blockNumber: e.payment.blockNumber, amountRaw: e.chargedRaw });
        if (e.settlement) createEvent(c, e.phase === 'Succeeded' ? 'task-settled' : 'task-failed', e.phase === 'Succeeded' ? 'Independent local settlement' : 'Paid hidden-test failure retained', e.phase === 'Succeeded' ? 'The full local task reward returns to Agent cash.' : 'The paid expense remains and task revenue stays zero.', { ...ownership, txHash: e.settlement.txHash, blockNumber: e.settlement.blockNumber, amountRaw: e.settlement.values.toAgent });
        else createEvent(c, 'payment-unknown', 'Original paid dispatch remains Unknown', 'No settlement or successful task income is invented; new work stops.', ownership);
        if (r.round < 4) createEvent(c, 'actual-feedback-read', 'Actual outcome feeds the next decision', 'The read preserves journal digests and business counters before the next deterministic choice.', ownership);
      }
      createEvent(c, 'new-work-stopped', 'Unresolved history blocks new payment', 'The controller stops with the original Unknown liability; its stop snapshots are identical.', { requestId: d.unknownRecovery.originalRequestId, paymentId: d.unknownRecovery.paymentId });
      createEvent(c, 'unknown-recovered', 'Original durable Unknown request recovered', 'A new executor reconstructs the original request from durable intent in the same worker, preserving payment bytes, nonce, payments, quotes and model calls.', { requestId: d.unknownRecovery.originalRequestId, paymentId: d.unknownRecovery.paymentId });
    } else if (r.kind === 'local-economic') {
      const b = economicBindings(d);
      const c = addClaim(claims, source, 'economy.capital-to-retained-cash', 'Local economic lifecycle', 'Three profitable tasks, a retained paid failure and an original Unknown refund reconcile cash to capital plus operating result.', checkedAccounting(d), b); economicTimeline(c, d);
      if (d.strategyAdvice) {
        const s = addClaim(claims, source, 'strategy.read-only-feedback', 'Read-only decision feedback', 'Historical prediction and actual failure change hypothetical advice while every read preserves business state.', {
          failureLossRaw: d.scenarios[4].chargedRaw, readPoints: 4, unchangedCounters: true, unknownBlocksAdvice: true, candidatesAreOwnerHypothetical: true,
          reads: d.strategyAdvice.map(x => ({ point: x.label, cashRaw: x.advice.cash.cashRaw, spendableCashRaw: x.advice.cash.spendableCashRaw, recommendation: x.advice.recommendation.status })),
        }, b);
        for (const read of d.strategyAdvice) createEvent(s, 'advice-read', 'Read-only strategy preview', 'Advice uses explicitly hypothetical candidates and preserves the journal, balances, nonce, quotes and model calls.', { at: read.advice.observedAt });
      }
      if (d.operatingReports) {
        const o = addClaim(claims, source, 'accounting.three-role-and-runway', 'Agent / platform / supplier accounting', 'Net supplier receipts equal Agent service cost; loan principal and credit-vault fees retain their separate treatment.', roleFacts(d), b);
        for (const read of d.operatingReports) createEvent(o, 'operating-read', 'Read-only operating report', 'Cash and subsidy assumptions remain separate; incomplete liabilities withhold a numeric runway.', { at: read.operating.observedAt });
      }
    } else if (r.kind === 'local-consumer') {
      const c = addClaim(claims, source, 'sdk.independent-publisher-worker', 'Independent publisher / Worker consumer', 'Separate local publisher, Worker and verifier settle the original payment through an independently installed SDK consumer.', {
        currency: 'USDC', decimals: 6, rewardRaw: d.economics.reward, providerCostRaw: d.economics.providerCost, creditPrincipalRaw: d.economics.principal,
        borrowingFeeRaw: d.economics.borrowFee, operatingResultRaw: d.economics.netTaskIncome, closingCashRaw: d.economics.closingCash,
        installationOutsideWorkspace: true, separateRoles: true, sameArenaRunRecovered: true, sameSettlementTransactionRecovered: true, replayAddedEffects: 0,
        originalRequestIdRetainedInSummary: false,
      }, { ...emptyBindings(), taskIds: [d.taskId], paymentIds: [d.paymentId], transactionHashes: [d.publication.txHash, d.payment.txHash, d.settlement.txHash] });
      for (const [type, title, receiptValue, amountRaw] of [['task-published', 'Publisher funded task', d.publication, d.economics.reward], ['provider-paid', 'Worker original payment', d.payment, d.economics.providerCost], ['task-settled', 'Original independent settlement', d.settlement, d.economics.closingCash]]) createEvent(c, type, title, 'Registered local consumer receipt; original request UUID was not retained in this summary.', { taskId: d.taskId, ...(type === 'provider-paid' ? { paymentId: d.paymentId } : {}), txHash: receiptValue.txHash, blockNumber: receiptValue.blockNumber, amountRaw });
    } else if (r.kind === 'offline-strategy') {
      const c = addClaim(claims, source, 'strategy.read-only-feedback', 'Controlled strategy feedback', 'Cost deviation and a paid failure change the next hypothetical route while reserves and profit floors remain explicit.', {
        originalExecutionEstimateRaw: d.costDeviation.originalPrediction.executionCostRaw, actualExecutionCostRaw: d.costDeviation.actualExecutionCostRaw, costBufferRaw: d.costDeviation.deviationRaw,
        failureLossRaw: d.paidFailure.actualLossRaw, preferredBefore: 'route-a', preferredAfter: 'route-b', unknownBlocksAdvice: true, fixtureTaskCount: 7, assertionCount: 9, syntheticScenarioClock: d.observedAt,
      });
      for (const [type, title, amountRaw] of [['cost-deviation-observed', 'Actual cost increases the route buffer', d.costDeviation.deviationRaw], ['paid-failure-observed', 'Paid failure raises required profit', d.paidFailure.actualLossRaw], ['hypothetical-choice-changed', 'Next preview prefers route B', undefined]]) createEvent(c, type, title, 'Controlled offline scenario; the fixed scenario clock is not a real execution timestamp.', { amountRaw });
    } else if (r.kind === 'offline-role') {
      const c = addClaim(claims, source, 'accounting.three-role-and-runway', 'Controlled role contribution and runway', 'Agent contribution, platform declarations, supplier receipts, grants and assumed runway use separate accounting scopes.', {
        agentContributionRaw: d.contribution.agent.settlementOperatingRaw, protocolFeesRaw: d.contribution.platform.derivedProtocolFeeRaw,
        supplierNetReceiptsRaw: d.contribution.suppliers.netReceiptsRaw, declaredPlatformContributionRaw: d.operatorDeclarations.platform.reportedContributionRaw,
        declaredSupplierContributionRaw: d.operatorDeclarations.supplier.reportedContributionRaw, platformGrantRaw: d.operatorDeclarations.platform.subsidy.grantedRaw,
        explicitlyAttributedConsumptionRaw: d.operatorDeclarations.platform.subsidy.explicitlyAllocatedRaw, distributionBudgetRemainingRaw: d.operatorDeclarations.platform.subsidy.remainingBudgetRaw,
        actualProfitRaw: null, roleTotalsAdditive: false, missingGrantBudgetWithheld: r.evidenceStatus === 'final', fixtureTaskCount: 5, assertionCount: 13, syntheticScenarioClock: d.observedAt,
      });
      createEvent(c, 'role-contributions-checked', 'Role contributions reconciled', 'Internal transfers are viewed from each role and are never summed into external system revenue.');
      createEvent(c, 'subsidy-budget-checked', 'Distribution budget checked', 'Issued grants reduce distribution budget; recipient consumption is not charged a second time.', { amountRaw: d.operatorDeclarations.platform.subsidy.remainingBudgetRaw });
    }
  }
  for (const [file, reportIds] of NARRATIVES) {
    const narrative = load(file); assert.equal(typeof narrative.data, 'string');
    for (const reportId of reportIds) {
      const source = sources.find(s => s.reportId === reportId); assert.ok(source, 'narrative registered report reference');
      const target = source.file.replace(/^docs\//, '');
      const line = narrative.data.split('\n').find(l => l.includes(`](${target})`)); assert.ok(line, `narrative must reference ${target}`);
      const checksum = line.match(/`([a-f0-9]{64})`/i); if (checksum) assert.equal(checksum[1], source.sha256, 'narrative/report SHA reference');
      if (source.implementation.revision) assert.ok(narrative.data.includes(source.implementation.revision), 'narrative/report base revision reference');
      source.documentation.push({ file, sha256: narrative.sha256 });
    }
  }
  const result = { schemaVersion: 1, scope: { mode: 'offline-registered-evidence-consistency', externalProvenanceVerified: false, networkOperations: 0, walletOperations: 0, limitations: [...LIMITATIONS] }, sources, claims, timeline: claims.flatMap(c => c.timeline) };
  validateManifestShape(result); return result;
}

/** Validate both the public shape and all values against registered source
 * reports. A modified manifest cannot validate itself by updating its checksum.
 * This is repository consistency, never authentication of external provenance.
 */
export function validateReviewEvidenceManifest(value) {
  validateManifestShape(value);
  assert.deepEqual(value, buildReviewEvidence(), 'manifest differs from registered evidence projection');
  return true;
}

const FRESH_KINDS = ['local-economic', 'local-consumer', 'local-bounded', 'local-bounded-shadow', 'local-independent', 'local-independent-shadow'];
function freshReference(source) {
  assert.ok(FRESH_KINDS.includes(source.kind), 'fresh local report kind');
  assert.ok(typeof source.file === 'string' && source.file.length <= 256, 'bounded public artifact reference');
  assert.match(source.file, /^(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+\.json$/, 'public artifact relative JSON reference');
  assert.equal(source.reportId, `fresh-${source.kind}`, 'fresh report identity');
}

/** A fresh artifact is checked against the supplied run, separately from the
 * saved-report registry. sha256 identifies the caller's public projection bytes.
 * Raw journals, arbitrary report additions and absolute paths are never copied.
 */
export function projectFreshReviewEvidence(kind, data, { file, sha256: publicSha256 }) {
  digest(publicSha256);
  const source = { reportId: `fresh-${kind}`, file, kind, evidenceStatus: 'final', supersededBy: null, sha256: publicSha256,
    environment: null, implementation: null, documentation: [] };
  freshReference(source);
  let facts;
  if (kind === 'local-economic') { validateEconomic(data, { fresh: true }); facts = checkedAccounting(data); }
  else if (kind === 'local-consumer') { validateConsumer(data, { fresh: true }); facts = { currency: 'USDC', decimals: 6, taskId: data.taskId, paymentId: data.paymentId, operatingResultRaw: data.economics.netTaskIncome, closingCashRaw: data.economics.closingCash, replayAddedEffects: 0 }; }
  else if (kind === 'local-bounded') facts = validateBoundedEconomyReport(data, { fresh: true });
  else if (kind === 'local-bounded-shadow') facts = validateBoundedShadowReport(data, { fresh: true });
  else if (kind === 'local-independent') facts = validateIndependentEconomyReport(data);
  else facts = validateIndependentShadowReport(data);
  source.environment = sourceEnvironment(source, data, { fresh: true }); source.implementation = implementation(data);
  const claims = [], c = addClaim(claims, source, 'execution.fresh-local-observation', 'Fresh local acceptance observation', 'A newly generated local report passed independent semantic checks. Its source checksum identifies the public artifact supplied with this manifest.', facts);
  const freshLimitations = ['Consistency of this newly generated controlled local run; no external provenance, vendor response or public-chain execution is authenticated.', ...LIMITATIONS.slice(1)];
  c.limitations = [...freshLimitations];
  if (kind.startsWith('local-independent')) c.limitations.push('A trusted signed task catalog and controlled model responses are used. Saved fingerprints establish internal byte consistency, not external authentication.');
  if (kind === 'local-economic') { c.bindings = economicBindings(data); economicTimeline(c, data); }
  else if (kind === 'local-consumer') {
    c.bindings = { ...emptyBindings(), taskIds: [data.taskId], paymentIds: [data.paymentId], transactionHashes: [data.publication.txHash, data.payment.txHash, data.settlement.txHash] };
    createEvent(c, 'task-settled', 'Fresh independent local settlement', 'The inspected local publisher and Worker retained the original task, payment and settlement.', { taskId: data.taskId, paymentId: data.paymentId, txHash: data.settlement.txHash, blockNumber: data.settlement.blockNumber });
  }
  else if (kind.startsWith('local-independent')) independentTimeline(c, data);
  const result = { schemaVersion: 1, scope: { mode: 'fresh-local-evidence-consistency', externalProvenanceVerified: false, networkOperations: 0, walletOperations: 0, limitations: freshLimitations }, sources: [source], claims, timeline: c.timeline };
  validateManifestShape(result, true); return result;
}

/** Shape validation is deliberately separate from saved-registry validation;
 * rebuilding a fresh manifest from its raw run is the caller's semantic check.
 */
export function validateFreshReviewEvidenceManifestShape(value) { validateManifestShape(value, true); return true; }

function validateManifestShape(value, fresh = false) {
  keys(value, ['schemaVersion', 'scope', 'sources', 'claims', 'timeline'], 'manifest fields'); assert.equal(value.schemaVersion, 1);
  keys(value.scope, ['mode', 'externalProvenanceVerified', 'networkOperations', 'walletOperations', 'limitations'], 'manifest scope');
  assert.equal(value.scope.externalProvenanceVerified, false); assert.equal(value.scope.networkOperations, 0); assert.equal(value.scope.walletOperations, 0);
  assert.equal(value.scope.mode, fresh ? 'fresh-local-evidence-consistency' : 'offline-registered-evidence-consistency');
  assert.ok(Array.isArray(value.sources)); assert.ok(Array.isArray(value.claims)); assert.ok(Array.isArray(value.timeline));
  unique(value.sources.map(s => s.reportId)); unique(value.claims.map(c => c.id)); unique(value.timeline.map(t => t.id));
  if (fresh) assert.equal(value.sources.length, 1, 'fresh manifest contains one inspected report');
  else assert.deepEqual(value.sources.map(s => s.reportId), EVIDENCE_REGISTRY.map(s => s.reportId), 'manifest fixed report registry');
  const environment = e => {
    keys(e, ['kind', 'chainId', 'modelMode', 'execution'], 'environment fields');
    assert.ok(['local-anvil', 'public-monad', 'offline-fixture'].includes(e.kind));
    assert.equal(e.chainId, e.kind === 'public-monad' ? '10143' : e.kind === 'local-anvil' ? '31337' : null, 'manifest environment/chain binding');
    assert.equal(typeof e.modelMode, 'string'); assert.equal(typeof e.execution, 'string');
  };
  const impl = i => {
    keys(i, ['revision', 'dirty', 'sourceHashes', 'savedFingerprints', 'semantics'], 'implementation fields');
    if (i.revision !== null) assert.match(i.revision, /^[a-f0-9]{40}$/i); if (i.dirty !== null) assert.equal(typeof i.dirty, 'boolean');
    assert.equal(i.semantics, SOURCE_SEMANTICS); assert.ok(Array.isArray(i.sourceHashes));
    unique(i.sourceHashes.map(s => s.file));
    for (const s of i.sourceHashes) { keys(s, ['file', 'sha256', 'currentSha256', 'matchesCurrent'], 'source fingerprint fields'); assert.ok(IMPLEMENTATION_FILES.has(s.file), 'unregistered implementation source'); digest(s.sha256); digest(s.currentSha256); assert.equal(s.matchesCurrent, s.sha256 === s.currentSha256); }
    keys(i.savedFingerprints, ['trackedDiffSha256', 'harnessSha256', 'launcherSha256', 'trustedConfigSha256', 'sdkArchiveSha256'], 'saved fingerprint fields'); Object.values(i.savedFingerprints).forEach(digest);
  };
  for (const s of value.sources) {
    keys(s, ['reportId', 'file', 'kind', 'evidenceStatus', 'supersededBy', 'sha256', 'environment', 'implementation', 'documentation'], 'source fields');
    const registered = REPORTS.get(s.file);
    if (fresh) { freshReference(s); assert.equal(s.evidenceStatus, 'final'); assert.equal(s.supersededBy, null); assert.deepEqual(s.documentation, []); }
    else { assert.ok(registered, 'unregistered manifest report reference'); for (const k of ['reportId', 'kind', 'evidenceStatus', 'supersededBy']) assert.equal(s[k], registered[k], 'manifest source registry identity'); }
    digest(s.sha256); environment(s.environment); impl(s.implementation);
    for (const ref of s.documentation) { keys(ref, ['file', 'sha256'], 'documentation fields'); assert.ok(NARRATIVES.some(([f]) => f === ref.file), 'unregistered narrative reference'); digest(ref.sha256); }
  }
  const eventFields = ['id', 'claimId', 'reportId', 'type', 'title', 'description', 'requestId', 'taskId', 'paymentId', 'txHash', 'amountRaw', 'blockNumber', 'at'];
  for (const c of value.claims) {
    keys(c, ['id', 'capabilityId', 'title', 'summary', 'reportId', 'source', 'environment', 'implementation', 'evidenceStatus', 'reproductionCommand', 'scope', 'limitations', 'checkedFacts', 'bindings', 'timeline'], 'claim fields');
    const source = value.sources.find(s => s.reportId === c.reportId); assert.ok(source, 'claim/report reference');
    assert.equal(c.id, `${c.reportId}:${c.capabilityId}`, 'stable claim id');
    keys(c.source, ['file', 'sha256'], 'claim source fields'); assert.equal(c.source.file, source.file); assert.equal(c.source.sha256, source.sha256, 'claim/report hash reference');
    assert.deepEqual(c.environment, source.environment, 'claim/report environment reference'); assert.deepEqual(c.implementation, source.implementation, 'claim/report implementation reference'); assert.equal(c.evidenceStatus, source.evidenceStatus);
    assert.equal(c.reproductionCommand, command(fresh ? source : REPORTS.get(source.file)), 'claim reproduction command');
    assert.equal(typeof c.title, 'string'); assert.equal(typeof c.summary, 'string');
    keys(c.bindings, ['requestIds', 'taskIds', 'paymentIds', 'transactionHashes'], 'binding fields');
    for (const xs of Object.values(c.bindings)) { assert.ok(Array.isArray(xs)); unique(xs); }
    c.bindings.requestIds.forEach(uuid); c.bindings.paymentIds.forEach(chainHash); c.bindings.transactionHashes.forEach(chainHash);
    for (const taskId of c.bindings.taskIds) assert.match(taskId, /^\d+$/);
    for (const t of c.timeline) {
      keys(t, eventFields, 'timeline event fields'); assert.equal(t.claimId, c.id); assert.equal(t.reportId, c.reportId);
      assert.ok(t.id.startsWith(`${c.id}:`)); assert.equal(typeof t.title, 'string'); assert.equal(typeof t.description, 'string');
      for (const [field, binding] of [['requestId', 'requestIds'], ['taskId', 'taskIds'], ['paymentId', 'paymentIds'], ['txHash', 'transactionHashes']]) if (t[field] !== undefined) assert.ok(c.bindings[binding].includes(t[field]), `timeline original ${field} ownership`);
      if (t.amountRaw !== undefined) raw(t.amountRaw); if (t.at !== undefined) iso(t.at);
      if (t.blockNumber !== undefined) assert.ok(Number.isSafeInteger(t.blockNumber) && t.blockNumber > 0);
    }
  }
  assert.deepEqual(value.timeline, value.claims.flatMap(c => c.timeline), 'top-level timeline/claim reference');
}

const stringSchema = { type: 'string' };
const shaSchema = { type: 'string', pattern: '^[a-f0-9]{64}$' };
const stringArraySchema = { type: 'array', items: stringSchema };
const closed = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, required, properties });
/** JSON Schema describes saved and fresh public shapes. Saved semantics use
 * validateReviewEvidenceManifest; fresh semantics use projectFreshReviewEvidence
 * with the original run, followed by validateFreshReviewEvidenceManifestShape.
 */
export const REVIEW_EVIDENCE_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'urn:agentfuel:review-evidence:1',
  title: 'Registered review evidence manifest',
  ...closed({
    schemaVersion: { const: 1 },
    scope: closed({ mode: { enum: ['offline-registered-evidence-consistency', 'fresh-local-evidence-consistency'] }, externalProvenanceVerified: { const: false }, networkOperations: { const: 0 }, walletOperations: { const: 0 }, limitations: stringArraySchema }),
    sources: { type: 'array', items: { $ref: '#/$defs/source' } },
    claims: { type: 'array', items: { $ref: '#/$defs/claim' } },
    timeline: { type: 'array', items: { $ref: '#/$defs/event' } },
  }),
  $defs: {
    environment: closed({ kind: { enum: ['local-anvil', 'public-monad', 'offline-fixture'] }, chainId: { enum: ['31337', '10143', null] }, modelMode: stringSchema, execution: stringSchema }),
    implementation: closed({ revision: { type: ['string', 'null'], pattern: '^[a-f0-9]{40}$' }, dirty: { type: ['boolean', 'null'] }, sourceHashes: { type: 'array', items: closed({ file: stringSchema, sha256: shaSchema, currentSha256: shaSchema, matchesCurrent: { type: 'boolean' } }) }, savedFingerprints: { type: 'object', additionalProperties: shaSchema }, semantics: stringSchema }),
    sourceRef: closed({ file: stringSchema, sha256: shaSchema }),
    source: closed({ reportId: stringSchema, file: stringSchema, kind: stringSchema, evidenceStatus: { enum: ['final', 'earlier', 'historical'] }, supersededBy: { type: ['string', 'null'] }, sha256: shaSchema, environment: { $ref: '#/$defs/environment' }, implementation: { $ref: '#/$defs/implementation' }, documentation: { type: 'array', items: { $ref: '#/$defs/sourceRef' } } }),
    fact: { anyOf: [{ type: ['string', 'boolean', 'number', 'null'] }, { type: 'array', items: { $ref: '#/$defs/fact' } }, { type: 'object', additionalProperties: { $ref: '#/$defs/fact' } }] },
    claim: closed({ id: stringSchema, capabilityId: stringSchema, title: stringSchema, summary: stringSchema, reportId: stringSchema, source: { $ref: '#/$defs/sourceRef' }, environment: { $ref: '#/$defs/environment' }, implementation: { $ref: '#/$defs/implementation' }, evidenceStatus: { enum: ['final', 'earlier', 'historical'] }, reproductionCommand: stringSchema, scope: stringSchema, limitations: stringArraySchema, checkedFacts: { type: 'object', additionalProperties: { $ref: '#/$defs/fact' } }, bindings: closed({ requestIds: stringArraySchema, taskIds: stringArraySchema, paymentIds: stringArraySchema, transactionHashes: stringArraySchema }), timeline: { type: 'array', items: { $ref: '#/$defs/event' } } }),
    event: closed({ id: stringSchema, claimId: stringSchema, reportId: stringSchema, type: stringSchema, title: stringSchema, description: stringSchema, requestId: stringSchema, taskId: stringSchema, paymentId: stringSchema, txHash: stringSchema, amountRaw: { type: 'string', pattern: '^-?\\d+$' }, blockNumber: { type: 'integer', minimum: 1 }, at: { type: 'string', format: 'date-time' } }, ['id', 'claimId', 'reportId', 'type', 'title', 'description']),
  },
});

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const flags = process.argv.slice(2);
  try {
    assert.ok(flags.every(f => ['--json', '--schema'].includes(f)), 'Only --json or --schema is supported; inputs are fixed registered repository evidence.');
    if (flags.includes('--schema')) console.log(JSON.stringify(REVIEW_EVIDENCE_SCHEMA, null, 2));
    else {
      const result = buildReviewEvidence();
      if (flags.includes('--json')) console.log(JSON.stringify(result, null, 2));
      else console.log(`Registered evidence consistency passed: ${result.sources.length} reports, ${result.claims.length} claims, ${result.timeline.length} timeline events. No network, model, signing or wallet operations; external provenance is not verified.`);
    }
  } catch {
    // Input report values may contain secrets added by mistake. Do not echo
    // assertion actual/expected values or arbitrary input paths to a public log.
    console.error('Registered evidence consistency failed. Inspect the fixed repository reports locally; no report content was printed.'); process.exitCode = 1;
  }
}
