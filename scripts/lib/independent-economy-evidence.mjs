import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// A fresh run can be checked without importing the Worker, reading its private
// directory, or loading a saved repository report. The arithmetic below is an
// independent implementation of the published, deliberately small policy.
export const INDEPENDENT_CONSUMER_FILES = Object.freeze(['package.json', 'package-lock.json', 'protocol.mjs', 'policy.mjs', 'durable.mjs', 'publisher.mjs', 'controller.mjs']);
export const INDEPENDENT_SOURCE_FILES = Object.freeze([
  ...INDEPENDENT_CONSUMER_FILES.map(file => `examples/economic-worker/${file}`),
  'scripts/independent-economy-local.ts', 'scripts/check-independent-economy.mjs',
  'packages/sdk/src/protocol.ts', 'packages/sdk/src/index.ts', 'packages/pi-loop/test/workflow-fixture.ts',
  'services/provider-relay/src/fixed-price.ts', 'services/provider-relay/src/relay.ts', 'services/provider-relay/src/refunder.ts',
  'services/arena/src/http.ts', 'services/arena/src/settler-main.ts', 'packages/pi-loop/src/provider.ts',
]);
const RAW = /^(?:0|[1-9]\d{0,77})$/, SIGNED = /^(?:0|[1-9]\d{0,77}|-[1-9]\d{0,77})$/;
const raw = value => { assert.equal(typeof value, 'string', 'raw amount is a string'); assert.match(value, RAW, 'canonical unsigned raw amount'); const n = BigInt(value); assert.ok(n < 1n << 256n, 'raw amount exceeds uint256'); return n; };
const signed = value => { assert.equal(typeof value, 'string'); assert.match(value, SIGNED, 'canonical signed raw amount'); const n = BigInt(value); assert.ok(n > -(1n << 256n) && n < 1n << 256n); return n; };
const eq = (actual, expected, why) => assert.equal(signed(actual), typeof expected === 'bigint' ? expected : signed(expected), why);
const digest = value => { assert.match(value, /^[a-f0-9]{64}$/, 'SHA-256 fingerprint'); return value; };
const hex = value => { assert.match(value, /^0x[a-f0-9]{64}$/i, 'transaction/payment digest'); return value; };
const id = value => { assert.match(value, /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i, 'original request UUID'); return value; };
const integer = (value, label, minimum = 0) => { assert.ok(Number.isSafeInteger(value) && value >= minimum, label); return value; };
const unique = (values, label) => assert.equal(new Set(values).size, values.length, label);
const canonical = value => value === null || typeof value !== 'object' ? JSON.stringify(value) : Array.isArray(value) ? `[${value.map(canonical).join(',')}]` : `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
export const independentEvidenceHash = value => createHash('sha256').update(canonical(value)).digest('hex');
const boundedArray = (value, max, label) => { assert.ok(Array.isArray(value) && value.length <= max, label); return value; };
const safeName = value => { assert.match(value, /^[a-zA-Z][a-zA-Z0-9._-]{0,63}$/, 'public bounded identifier'); return value; };
const iso = value => { assert.equal(typeof value, 'string'); assert.match(value, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/); const n = Date.parse(value); assert.ok(Number.isSafeInteger(n)); return n; };
const SNAPSHOT_FIELDS = ['cashRaw', 'walletNonce', 'paymentEvents', 'settlementEvents', 'acceptanceEvents', 'modelCalls'];
function snapshot(value) {
  assert.ok(value && typeof value === 'object', 'business snapshot required'); raw(value.cashRaw);
  for (const field of SNAPSHOT_FIELDS.slice(1)) integer(value[field], `snapshot ${field}`);
}
function sameSnapshot(before, after, label) {
  snapshot(before); snapshot(after);
  for (const field of SNAPSHOT_FIELDS) assert.equal(after[field], before[field], label);
}
function receipt(value, event) {
  assert.ok(value && typeof value === 'object', `${event} receipt required`); hex(value.txHash); hex(value.blockHash); integer(value.blockNumber, 'receipt block number', 1);
  assert.equal(value.status, 1, 'receipt success'); assert.equal(value.event, event, 'receipt event'); assert.equal(value.eventCount, 1, 'exactly one original event');
  assert.ok(value.values && typeof value.values === 'object', 'receipt event values');
}
function policy(value, start, end) {
  assert.equal(value.version, 1); safeName(value.id); assert.equal(value.chainId, '31337');
  integer(value.maxTasks, 'task bound', 1); assert.ok(value.maxTasks <= 32);
  for (const field of ['totalSpendRaw', 'maxPaymentRaw', 'reserveCashRaw', 'minProfitRaw', 'coldStartCushionRaw']) raw(value[field]);
  assert.ok(raw(value.maxPaymentRaw) > 0n && raw(value.maxPaymentRaw) <= raw(value.totalSpendRaw));
  integer(value.startedAtMs, 'policy start'); integer(value.deadlineMs, 'policy deadline');
  assert.ok(value.startedAtMs >= start && value.deadlineMs > value.startedAtMs && value.deadlineMs - value.startedAtMs <= 300000, 'bounded policy clock');
  assert.ok(end >= value.startedAtMs, 'policy begins within report');
}
function provenance(data) {
  const p = data.provenance; assert.ok(p && typeof p === 'object', 'independent provenance required');
  assert.equal(p.chainId, '31337'); assert.equal(p.environment, 'owned-local-anvil'); assert.equal(p.consumer, 'external-directory-installed-sdk');
  assert.equal(p.model, 'controlled-response-injection'); assert.equal(p.evaluation, 'real-pinned-Docker-public-and-hidden-tests'); assert.equal(p.settlement, 'independent-Arena-settler-process');
  const source = p.source ?? data.source; assert.ok(source, 'recorded base revision required'); assert.match(source.revision, /^[a-f0-9]{40}$/i); assert.equal(typeof source.dirty, 'boolean'); digest(source.trackedDiffSha256);
  const hashes = p.sourceSha256 ?? data.sourceSha256; assert.ok(hashes && Object.keys(hashes).length, 'implementation source fingerprints');
  for (const [file, hash] of Object.entries(hashes)) { assert.ok(INDEPENDENT_SOURCE_FILES.includes(file), 'registered independent implementation source'); digest(hash); }
  for (const file of INDEPENDENT_SOURCE_FILES) assert.ok(hashes[file], 'complete critical implementation fingerprints');
  digest(p.sdkArchiveSha256);
  assert.deepEqual(Object.keys(p.consumerSha256).sort(), [...INDEPENDENT_CONSUMER_FILES].sort(), 'complete external consumer fingerprints'); Object.values(p.consumerSha256).forEach(digest);
  for (const name of INDEPENDENT_CONSUMER_FILES) if (hashes[`examples/economic-worker/${name}`]) assert.equal(hashes[`examples/economic-worker/${name}`], p.consumerSha256[name], 'installed consumer source fingerprint binding');
  const nodeVersion = /^v?(\d+)\.\d+\.\d+$/.exec(p.node); assert.ok(nodeVersion && Number(nodeVersion[1]) >= 22, 'Node 22 or newer runtime');
  assert.equal(data.scope.productionNetworkUsed, false); assert.equal(data.scope.publicVendorCalls, false); assert.equal(data.scope.autonomousPlannerExercised, false); assert.equal(data.scope.creditOptionsExercised, false);
  return { source, hashes };
}
function catalog(data) {
  const tasks = boundedArray(data.publication.tasks, 32, 'bounded funded task catalog'); assert.ok(tasks.length > 0); unique(tasks.map(task => task.taskId), 'unique published task ownership');
  for (const task of tasks) {
    integer(task.publisherPid, 'external publisher process', 1);
    assert.ok(raw(task.taskId) > 0n); safeName(task.problemId); assert.ok(raw(task.rewardRaw) > 0n); eq(task.fundedEscrowRaw, task.rewardRaw, 'publisher funds exact reward');
    assert.ok(raw(task.protocolFeeBps) <= 10000n); digest(task.manifestSha256); assert.equal(task.signatureVerified, true, 'external publication signature verified');
    receipt(task.creation, 'TaskCreated'); assert.equal(task.creation.values.taskId, task.taskId, 'publication event task ownership'); eq(task.creation.values.reward, task.rewardRaw, 'publication receipt reward');
    if (task.creationTxHash !== undefined) assert.equal(task.creationTxHash, task.creation.txHash, 'original publication transaction'); integer(task.deadlineMs, 'funded task deadline'); assert.equal(task.deadlineMs % 1000, 0); eq(task.creation.values.deadline, BigInt(task.deadlineMs) / 1000n, 'publication deadline binding');
  }
  return tasks;
}
function candidate(value, tasks, start, end) {
  const task = tasks.find(task => task.taskId === value.taskId); assert.ok(task, 'candidate references published manifest'); assert.equal(value.problemId, task.problemId, 'candidate problem binding');
  eq(value.rewardRaw, task.rewardRaw, 'candidate published reward'); eq(value.escrowBalanceRaw, task.fundedEscrowRaw, 'candidate escrow funding'); raw(value.priceRaw); assert.ok(raw(value.priceRaw) > 0n);
  eq(value.protocolFeeBps, task.protocolFeeBps, 'candidate published protocol fee'); assert.equal(value.status, '1');
  integer(value.observedAtMs, 'candidate observation'); assert.ok(value.observedAtMs >= start && value.observedAtMs <= end, 'candidate real observation window'); integer(value.expiresAtMs, 'quote expiry'); assert.ok(value.expiresAtMs > value.observedAtMs);
  assert.equal(value.deadlineMs, task.deadlineMs, 'candidate funded task deadline'); hex(value.paymentId); hex(value.requestDigest);
  integer(value.blockNumber, 'observed block', task.creation.blockNumber); hex(value.blockHash);
}
function historyEntry(value, rounds, now) {
  id(value.requestId); const round = rounds.find(round => round.requestId === value.requestId); assert.ok(round, 'history retains actual original request');
  assert.equal(value.taskId, round.taskId); assert.equal(value.problemId, round.problemId); assert.equal(value.outcome, round.outcome);
  for (const field of ['chargedRaw', 'refundedRaw', 'revenueRaw']) eq(value[field], round[field], 'history actual contribution');
  assert.ok(round.observation.nowMs <= now, 'actual history precedes next decision');
  if (value.atMs !== undefined) assert.ok(integer(value.atMs, 'history clock') <= now, 'no future history');
}
function decision(p, input) {
  for (const field of ['cashRaw', 'spentRaw', 'reservedRaw']) raw(input[field]); integer(input.nowMs, 'decision clock');
  const stop = input.unresolved ? 'UNRESOLVED_PAYMENT_OR_HISTORY' : input.nowMs >= p.deadlineMs ? 'TIME_LIMIT' : input.history.length >= p.maxTasks ? 'TASK_LIMIT' : raw(input.spentRaw) >= raw(p.totalSpendRaw) ? 'TOTAL_SPEND_LIMIT' : null;
  const assessments = input.candidates.map(c => {
    const comparable = input.history.filter(h => h.problemId === c.problemId), failures = comparable.filter(h => h.outcome === 'failed');
    const coldStart = comparable.length === 0, failureCushion = failures.reduce((max, h) => { const n = raw(h.chargedRaw) - raw(h.refundedRaw); return max > n ? max : n; }, 0n);
    const netRevenue = raw(c.rewardRaw) - raw(c.rewardRaw) * raw(c.protocolFeeBps) / 10000n, required = raw(p.minProfitRaw) + failureCushion + (coldStart ? raw(p.coldStartCushionRaw) : 0n), profit = netRevenue - raw(c.priceRaw), reasons = [];
    if (stop) reasons.push(stop);
    if (c.status !== '1') reasons.push('TASK_NOT_OPEN'); if (raw(c.rewardRaw) === 0n || raw(c.escrowBalanceRaw) < raw(c.rewardRaw)) reasons.push('TASK_NOT_FUNDED');
    if (input.nowMs >= c.deadlineMs || input.nowMs >= c.expiresAtMs) reasons.push('QUOTE_OR_TASK_EXPIRED'); if (c.observedAtMs > input.nowMs || input.nowMs - c.observedAtMs > 10000) reasons.push('OBSERVATION_STALE');
    if (raw(c.priceRaw) > raw(p.maxPaymentRaw)) reasons.push('PAYMENT_LIMIT'); if (raw(input.spentRaw) + raw(input.reservedRaw) + raw(c.priceRaw) > raw(p.totalSpendRaw)) reasons.push('TOTAL_SPEND_LIMIT');
    if (raw(input.cashRaw) - raw(input.reservedRaw) - raw(c.priceRaw) < raw(p.reserveCashRaw)) reasons.push('CASH_RESERVE'); if (profit < required) reasons.push('MINIMUM_PROFIT');
    return { taskId: c.taskId, problemId: c.problemId, coldStart, comparableCount: comparable.length, failedComparableCount: failures.length, failureCushionRaw: String(failureCushion), netRevenueRaw: String(netRevenue), requiredProfitRaw: String(required), completionProfitRaw: String(profit), surplusRaw: String(profit - required), reasons, status: reasons.length ? 'rejected' : 'eligible' };
  });
  const best = assessments.filter(a => a.status === 'eligible').sort((a, b) => signed(a.surplusRaw) === signed(b.surplusRaw) ? raw(a.taskId) < raw(b.taskId) ? -1 : 1 : signed(a.surplusRaw) > signed(b.surplusRaw) ? -1 : 1)[0];
  return { status: best ? 'selected' : 'stopped', selectedTaskId: best?.taskId ?? null, stopReason: best ? null : stop ?? 'NO_ELIGIBLE_CANDIDATE', assessments };
}
function observation(value, tasks, rounds, p, start, end, expectedSpent) {
  boundedArray(value.candidates, 32, 'bounded observed candidates'); boundedArray(value.history, 32, 'bounded actual history'); unique(value.candidates.map(c => c.taskId), 'candidate ownership');
  value.candidates.forEach(c => candidate(c, tasks, start, end)); unique(value.history.map(h => h.requestId), 'history unique requests'); value.history.forEach(h => historyEntry(h, rounds, value.nowMs));
  assert.equal(value.history.length, rounds.length, 'all prior actual history retained'); eq(value.spentRaw, expectedSpent, 'gross spent budget never reset by refund'); eq(value.reservedRaw, 0n, 'no hidden pending reservation at new choice');
  assert.ok(value.nowMs >= p.startedAtMs && value.nowMs <= end, 'real decision within report window');
}
function base(data, mode) {
  assert.equal(data.version, 1); assert.equal(data.suite, 'local-independent-economy'); assert.equal(data.mode, mode); assert.equal(data.status, 'passed');
  const start = iso(data.startedAt), end = iso(data.completedAt); assert.ok(end >= start); assert.equal(data.durationMs, end - start, 'actual run duration'); provenance(data); policy(data.policy, start, end); assert.equal(data.policySha256, independentEvidenceHash(data.policy), 'frozen policy fingerprint');
  for (const field of ['ownedProcessesStopped', 'ownedContainersRemoved', 'privateTempDirectoryRemoved', 'ownedIpcDirectoryRemoved']) assert.equal(data.cleanup[field], true, 'complete owned local cleanup'); assert.deepEqual(data.cleanup.failures, []);
  return { start, end, tasks: catalog(data) };
}

export function validateIndependentShadowReport(data) {
  const { start, end, tasks } = base(data, 'shadow'), shadow = data.shadow; sameSnapshot(shadow.before, shadow.after, 'shadow creates no business effects');
  observation(shadow.observation, tasks, [], data.policy, start, end, 0n); eq(shadow.observation.cashRaw, shadow.before.cashRaw);
  assert.deepEqual(shadow.decision, decision(data.policy, shadow.observation), 'shadow decision arithmetic');
  assert.deepEqual(data.rounds, []); assert.deepEqual(data.interruptions, []); assert.equal(data.unknown, undefined); assert.equal(data.final, undefined);
  return { observedTasks: tasks.length, measuredPaymentsAdded: 0, measuredModelCallsAdded: 0, measuredNonceIncrease: 0, reserveCashRaw: data.policy.reserveCashRaw };
}

export function validateIndependentEconomyReport(data) {
  const { start, end, tasks } = base(data, 'execute-local'), p = data.policy, rounds = boundedArray(data.rounds, 32, 'bounded execution rounds'); assert.ok(rounds.length > 0 && rounds.length <= p.maxTasks);
  const funding = data.initialFunding; assert.ok(raw(funding.initialAgentId ?? funding.agentId) > 0n, 'original funded Agent'); assert.ok(raw(funding.startupCapitalRaw) > 0n); eq(funding.ownerTopupsAfterProvisionRaw, 0n, 'no owner topups'); eq(funding.gameSubsidyRaw, 0n, 'no game subsidy');
  eq(funding.taskPublisherFundedRewardsRaw, tasks.reduce((n, t) => n + raw(t.rewardRaw), 0n), 'publisher reward funding separate from Agent capital');
  unique(rounds.map(round => id(round.requestId)), 'unique original requests'); unique(rounds.map(round => round.taskId), 'unique executed tasks'); unique(rounds.map(round => hex(round.quote.paymentId)), 'unique original payments');
  unique(rounds.map(round => hex(round.acceptance.txHash)), 'unique acceptance transaction ownership'); unique(rounds.map(round => hex(round.payment.txHash)), 'unique payment transaction ownership'); unique(rounds.map(round => hex(round.settlement.txHash)), 'unique settlement transaction ownership');
  let spent = 0n, refunded = 0n, revenue = 0n, cash = raw(funding.startupCapitalRaw), last = null;
  for (const [index, round] of rounds.entries()) {
    const previous = rounds.slice(0, index); observation(round.observation, tasks, previous, p, start, end, spent); eq(round.observation.cashRaw, cash, 'new choice uses actual cash');
    assert.deepEqual(round.decision, decision(p, round.observation), 'independent decision arithmetic and actual history'); assert.equal(round.decision.status, 'selected'); assert.equal(round.taskId, round.decision.selectedTaskId, 'execution follows highest surplus choice');
    const selected = round.observation.candidates.find(c => c.taskId === round.taskId); assert.ok(selected); assert.equal(round.problemId, selected.problemId);
    if (index > 0) { assert.ok(round.observation.nowMs >= rounds[index - 1].observation.nowMs, 'continuous real decision clock'); assert.ok(round.payment.blockNumber > rounds[index - 1].settlement.blockNumber, 'each new payment follows prior terminal settlement'); }
    assert.equal(round.nextChoice, rounds[index + 1]?.taskId ?? null, 'actual next execution follows saved next choice');
    assert.equal(round.quote.paymentId, selected.paymentId, 'exact original quote payment'); assert.equal(round.quote.requestDigest, selected.requestDigest, 'exact request digest'); eq(round.quote.priceRaw, selected.priceRaw, 'original quote price'); eq(round.chargedRaw, selected.priceRaw, 'paid cost binds selected quote');
    for (const field of ['intentSha256', 'quoteSha256', 'inputSha256', 'acceptSignedBytesSha256', 'paymentSignedBytesSha256']) digest(round.bindings[field]);
    assert.equal(round.policySha256 ?? data.policySha256, data.policySha256, 'round original frozen policy');
    receipt(round.payment, 'ProviderPaid'); assert.equal(round.payment.values.paymentId, round.quote.paymentId, 'payment event original ownership'); eq(round.payment.values.fromCredit, 0n, 'cash only payment'); eq(round.payment.values.fromCash, round.chargedRaw);
    assert.match(round.payment.values.provider, /^0x[a-f0-9]{40}$/i); assert.equal(round.payment.values.provider.toLowerCase(), rounds[0].payment.values.provider.toLowerCase(), 'single allowlisted quote/payment provider');
    if (round.payment.values.amount !== undefined) eq(round.payment.values.amount, round.chargedRaw, 'payment event amount binds original quote');
    assert.equal(round.payment.values.agentId, funding.initialAgentId ?? funding.agentId, 'payment original Agent'); assert.ok(round.payment.blockNumber > tasks.find(t => t.taskId === round.taskId).creation.blockNumber);
    receipt(round.acceptance, 'TaskAccepted'); assert.equal(round.acceptance.values.taskId, round.taskId, 'original task acceptance ownership'); assert.equal(round.acceptance.values.agentId, funding.initialAgentId ?? funding.agentId, 'original Agent acceptance ownership');
    assert.ok(round.acceptance.blockNumber > tasks.find(t => t.taskId === round.taskId).creation.blockNumber && round.acceptance.blockNumber < round.payment.blockNumber, 'original acceptance precedes original cash payment');
    receipt(round.settlement, 'TaskSettled'); assert.equal(round.settlement.values.taskId, round.taskId, 'settlement original task'); assert.ok(round.settlement.blockNumber > round.payment.blockNumber); eq(round.settlement.values.repaid, 0n); eq(round.settlement.values.slashed, 0n);
    assert.ok(['succeeded', 'failed', 'refunded'].includes(round.outcome)); raw(round.refundedRaw); raw(round.revenueRaw);
    if (round.outcome === 'succeeded') { eq(round.refundedRaw, 0n); assert.equal(round.settlement.values.passed, true); eq(round.revenueRaw, raw(selected.rewardRaw) - raw(selected.rewardRaw) * raw(selected.protocolFeeBps) / 10000n); }
    else { assert.equal(round.settlement.values.passed, false); eq(round.revenueRaw, 0n, 'failed or refunded task has no invented income'); if (round.outcome === 'failed') eq(round.refundedRaw, 0n); else eq(round.refundedRaw, round.chargedRaw, 'original full refund'); }
    eq(round.settlement.values.agentResidual ?? round.settlement.values.toAgent, round.revenueRaw, 'settlement reward conservation');
    for (const field of ['agentResidual', 'toAgent']) if (round.settlement.values[field] !== undefined) eq(round.settlement.values[field], round.revenueRaw, 'settlement residual aliases agree');
    if (round.outcome === 'refunded') assert.equal(round.settlement.mode, 'authorized-failure', 'Unknown task termination is not Docker success');
    else { assert.equal(round.settlement.mode, 'docker'); assert.ok(integer(round.settlement.cases, 'real hidden/public Docker cases', 1) > 0); }
    spent += raw(round.chargedRaw); refunded += raw(round.refundedRaw); revenue += raw(round.revenueRaw); cash += raw(round.revenueRaw) - raw(round.chargedRaw) + raw(round.refundedRaw);
    assert.ok(spent <= raw(p.totalSpendRaw) && raw(round.chargedRaw) <= raw(p.maxPaymentRaw), 'all attempts stay inside original budget'); assert.ok(cash >= raw(p.reserveCashRaw), 'cash reserve retained');
    snapshot(round.before); snapshot(round.after); eq(round.before.cashRaw, round.observation.cashRaw); eq(round.after.cashRaw, cash, 'round cash conservation');
    if (last) for (const field of SNAPSHOT_FIELDS) assert.equal(round.before[field], last[field], 'round business counter continuity');
    assert.equal(round.after.paymentEvents, round.before.paymentEvents + 1, 'exactly one payment per original request'); assert.equal(round.after.modelCalls, round.before.modelCalls + 1, 'exactly one original dispatch'); assert.equal(round.after.settlementEvents, round.before.settlementEvents + 1); assert.equal(round.after.acceptanceEvents, round.before.acceptanceEvents + 1); assert.equal(round.after.walletNonce, round.before.walletNonce + 2, 'only original acceptance and cash payment wallet transactions'); last = round.after;
    const cf = round.counterfactual; assert.ok(cf, 'independent input-order and feedback counterfactuals');
    for (const field of ['reversedSelectedTaskId', 'rotatedSelectedTaskId']) assert.equal(cf[field], round.taskId, 'input order cannot prescribe task');
    for (const [field, excluded] of [['withoutFailuresSelectedTaskId', 'failed'], ['withoutSuccessesSelectedTaskId', 'succeeded']]) assert.equal(cf[field], decision(p, { ...round.observation, history: round.observation.history.filter(h => h.outcome !== excluded) }).selectedTaskId, 'actual-history counterfactual');
    assert.equal(round.bindings.requestId, round.requestId); assert.equal(round.bindings.paymentId, round.quote.paymentId); assert.equal(round.bindings.policySha256, data.policySha256); eq(round.bindings.spentRaw, spent, 'round durable gross budget'); eq(round.bindings.reservedRaw, round.outcome === 'refunded' ? round.chargedRaw : '0', 'pending original reservation before accounting checkpoint'); assert.equal(round.bindings.completedTasks, index); assert.equal(round.bindings.pendingRequestId, round.requestId);
  }
  assert.ok(rounds.some(r => r.observation.history.some(h => h.outcome === 'succeeded') && r.counterfactual.withoutSuccessesSelectedTaskId !== r.taskId), 'real success changes subsequent choice');
  assert.ok(rounds.some(r => r.observation.history.some(h => h.outcome === 'failed') && r.counterfactual.withoutFailuresSelectedTaskId !== r.taskId), 'paid failure changes subsequent choice');
  validateInterruptions(data, rounds);
  const u = data.unknown, original = rounds.find(r => r.requestId === u.requestId); assert.ok(original && original.outcome === 'refunded', 'Unknown retains original refunded request'); assert.equal(u.paymentId, original.quote.paymentId); assert.equal(u.blockedReason, 'UNRESOLVED_PAYMENT_OR_HISTORY');
  sameSnapshot(u.before, u.after, 'unresolved Unknown blocks every new business effect'); assert.equal(u.extraPayments, 0); assert.equal(u.extraModelCalls, 0);
  eq(u.before.cashRaw, raw(original.before.cashRaw) - raw(original.chargedRaw), 'Unknown retains original paid cash liability');
  for (const [field, increase] of [['walletNonce', 2], ['paymentEvents', 1], ['settlementEvents', 0], ['acceptanceEvents', 1], ['modelCalls', 1]]) assert.equal(u.before[field], original.before[field] + increase, 'Unknown snapshot belongs to original paid request');
  assert.equal(u.newJournalBypassRejected, true, 'new journal cannot bypass original Unknown wallet history');
  const resolution = u.resolution; assert.equal(resolution.kind, 'provider-full-refund-and-authorized-task-failure'); assert.equal(resolution.proofVerified, true); assert.equal(resolution.paymentId, u.paymentId, 'resolution original payment'); eq(resolution.amountRaw, original.refundedRaw); receipt(resolution.receipt, 'RefundProcessed'); if (resolution.txHash !== undefined) assert.equal(resolution.txHash, resolution.receipt.txHash); assert.equal(resolution.receipt.values.paymentId, u.paymentId, 'refund event original payment'); eq(resolution.receipt.values.amount, resolution.amountRaw); eq(resolution.receipt.values.toCash, resolution.amountRaw); eq(resolution.receipt.values.debtReduced, 0n);
  if (resolution.receipt.values.taskId !== undefined) eq(resolution.receipt.values.taskId, 0n, 'pure cash payment record intentionally has taskId zero');
  receipt(resolution.taskTermination, 'TaskSettled'); assert.equal(resolution.taskTermination.txHash, original.settlement.txHash, 'resolution terminates original task transaction'); assert.equal(resolution.taskTermination.values.taskId, original.taskId); assert.equal(resolution.taskTermination.values.passed, false);
  assert.ok(resolution.receipt.blockNumber > original.payment.blockNumber && resolution.receipt.blockNumber < original.settlement.blockNumber, 'original refund precedes authorized failed task termination'); assert.equal(resolution.terminalTaskStatus, '4'); eq(resolution.terminalEscrowBalanceRaw, 0n, 'old task terminal before continuing');
  const continuation = rounds.find(r => r.requestId === u.continuedRequestId); assert.ok(continuation && rounds.indexOf(continuation) > rounds.indexOf(original), 'controller continues new work after explicit original resolution'); assert.equal(continuation.policySha256 ?? data.policySha256, data.policySha256); assert.ok(continuation.payment.blockNumber > original.settlement.blockNumber, 'continuation follows both resolution and original task termination');
  const f = data.final; eq(f.cashRaw, cash, 'final actual cash'); eq(f.spentRaw, spent, 'gross lifetime spend preserved'); eq(f.reservedRaw, 0n); eq(f.taskRevenueRaw, revenue); eq(f.refundRaw, refunded); eq(f.netOperatingRaw, revenue - spent + refunded, 'net operating excludes startup funding'); eq(f.cashRaw, raw(funding.startupCapitalRaw) + signed(f.netOperatingRaw), 'cash equals capital plus operating result');
  observation(f.observation, tasks, rounds, p, start, end, spent); eq(f.observation.cashRaw, cash); assert.deepEqual(f.decision, decision(p, f.observation), 'final stop independently follows original policy'); assert.equal(f.decision.status, 'stopped'); assert.equal(f.stopReason, f.decision.stopReason);
  sameSnapshot(data.replay.before, data.replay.after, 'terminal replay adds no business effect'); for (const field of SNAPSHOT_FIELDS) assert.equal(data.replay.before[field], f[field], 'replay original final state');
  return { currency: 'USDC', decimals: 6, executedTasks: rounds.length, grossSpendRaw: String(spent), refundsRaw: String(refunded), taskRevenueRaw: String(revenue), operatingResultRaw: f.netOperatingRaw, finalCashRaw: f.cashRaw, interruptedProcesses: data.interruptions.length, originalPolicyPreserved: true, unknownExplicitlyResolvedBeforeContinuation: true,
    decisions: rounds.map((round, index) => ({ round: index + 1, taskId: round.taskId, phase: round.outcome === 'succeeded' ? 'Succeeded' : round.outcome === 'failed' ? 'Failed' : 'Refunded', selectedWithoutSuccessTaskId: round.counterfactual.withoutSuccessesSelectedTaskId, selectedWithoutFailureTaskId: round.counterfactual.withoutFailuresSelectedTaskId, selectedSurplusRaw: round.decision.assessments.find(a => a.taskId === round.taskId).surplusRaw, cashAfterRaw: round.after.cashRaw })) };
}

function validateInterruptions(data, rounds) {
  const values = boundedArray(data.interruptions, 4, 'four process interruption boundaries'); assert.equal(values.length, 4);
  assert.deepEqual(values.map(v => v.checkpoint).sort(), ['before-payment', 'after-payment', 'after-settlement', 'after-unknown'].sort(), 'exact interrupted process boundaries');
  for (const value of values) {
    safeName(value.checkpoint); integer(value.beforePid, 'killed Worker PID', 1); integer(value.afterPid, 'replacement Worker PID', 1); assert.notEqual(value.beforePid, value.afterPid, 'OS process actually replaced'); assert.ok(data.publication.tasks.every(t => t.publisherPid !== value.beforePid && t.publisherPid !== value.afterPid), 'publisher and Worker independent processes');
    assert.equal(value.signal, 'SIGKILL'); assert.equal(value.originalProcessExited, true, 'old Worker exited before replacement');
    const original = value.original, recovered = value.recovered, round = rounds.find(r => r.requestId === original.requestId); assert.ok(round, 'interruption original request retained');
    assert.equal(original.paymentId, round.quote.paymentId); assert.equal(original.policySha256, data.policySha256);
    for (const field of ['quoteSha256', 'inputSha256', 'acceptSignedBytesSha256', 'paymentSignedBytesSha256']) { digest(original[field]); assert.equal(original[field], round.bindings[field], 'saved execution bytes match original round'); }
    const index = rounds.indexOf(round), priorSpent = rounds.slice(0, index).reduce((n, r) => n + raw(r.chargedRaw), 0n), charged = ['after-settlement', 'after-unknown'].includes(value.checkpoint);
    eq(original.spentRaw, priorSpent + (charged ? raw(round.chargedRaw) : 0n), 'recovery durable gross spend equals original attempt boundary'); eq(original.reservedRaw, value.checkpoint === 'after-settlement' ? 0n : raw(round.chargedRaw), 'recovery original reservation'); assert.equal(original.completedTasks, index, 'recovery prior completed history count'); assert.equal(original.pendingRequestId, original.requestId, 'pending original handle');
    for (const field of ['requestId', 'paymentId', 'quoteSha256', 'inputSha256', 'acceptSignedBytesSha256', 'paymentSignedBytesSha256', 'policySha256', 'spentRaw', 'reservedRaw', 'completedTasks', 'pendingRequestId']) assert.equal(recovered[field], original[field], 'restart preserves original handle, bytes, policy and gross budget');
    sameSnapshot(value.before, value.after, 'recovery itself adds no business effect');
    const expected = { ...round.before };
    expected.acceptanceEvents++; expected.walletNonce++;
    if (value.checkpoint !== 'before-payment') { expected.walletNonce++; expected.paymentEvents++; expected.modelCalls++; expected.cashRaw = String(raw(expected.cashRaw) - raw(round.chargedRaw)); }
    if (['after-settlement', 'after-unknown'].includes(value.checkpoint)) { expected.settlementEvents++; expected.cashRaw = round.after.cashRaw; }
    for (const field of SNAPSHOT_FIELDS) assert.equal(value.before[field], expected[field], 'restart snapshot belongs to its original process boundary');
    if (value.killedAt) {
      const killed = { ...expected }; if (value.checkpoint === 'after-payment') killed.modelCalls--;
      for (const field of SNAPSHOT_FIELDS) assert.equal(value.killedAt[field], killed[field], 'SIGKILL occurred at the declared original boundary');
    }
    for (const field of ['extraPayments', 'extraModelCalls', 'extraSettlements', 'extraAcceptances']) assert.equal(value[field], 0, 'no replay business effects');
  }
}

// Every public property is named here. In particular, never spread a report,
// provenance object, event values, policy or a durable state into an artifact.
const publicSnapshot = value => Object.fromEntries(SNAPSHOT_FIELDS.map(field => [field, value[field]]));
const publicReceipt = value => ({ txHash: value.txHash, blockHash: value.blockHash, blockNumber: value.blockNumber, status: 1, event: value.event, eventCount: 1 });
export function projectIndependentEconomyPublicReport(data) {
  const facts = data.mode === 'shadow' ? validateIndependentShadowReport(data) : validateIndependentEconomyReport(data), { source, hashes } = provenance(data);
  const out = { version: 1, suite: 'local-independent-economy', mode: data.mode, status: 'passed', startedAt: data.startedAt, completedAt: data.completedAt, durationMs: data.durationMs,
    environment: { chainId: '31337', kind: 'owned-local-anvil', consumer: 'external-directory-installed-sdk', model: 'controlled-response-injection', productionNetworkUsed: false, publicVendorCalls: false },
    implementation: { revision: source.revision, dirty: source.dirty, trackedDiffSha256: source.trackedDiffSha256, sdkArchiveSha256: data.provenance.sdkArchiveSha256,
      sourceSha256: Object.fromEntries(INDEPENDENT_SOURCE_FILES.filter(file => hashes[file]).map(file => [file, hashes[file]])), consumerSha256: Object.fromEntries(INDEPENDENT_CONSUMER_FILES.map(file => [file, data.provenance.consumerSha256[file]])) },
    policy: { version: 1, id: data.policy.id, chainId: '31337', maxTasks: data.policy.maxTasks, totalSpendRaw: data.policy.totalSpendRaw, maxPaymentRaw: data.policy.maxPaymentRaw, reserveCashRaw: data.policy.reserveCashRaw, minProfitRaw: data.policy.minProfitRaw, coldStartCushionRaw: data.policy.coldStartCushionRaw, startedAtMs: data.policy.startedAtMs, deadlineMs: data.policy.deadlineMs }, policySha256: data.policySha256,
    publication: { tasks: data.publication.tasks.map(task => ({ publisherPid: task.publisherPid, taskId: task.taskId, problemId: task.problemId, rewardRaw: task.rewardRaw, manifestSha256: task.manifestSha256, signatureVerified: true, creation: publicReceipt(task.creation) })) }, facts };
  if (data.mode === 'shadow') out.shadow = { before: publicSnapshot(data.shadow.before), after: publicSnapshot(data.shadow.after), selectedTaskId: data.shadow.decision.selectedTaskId, stopReason: data.shadow.decision.stopReason, observedTasks: data.shadow.observation.candidates.length };
  else {
    out.rounds = data.rounds.map(round => ({ requestId: round.requestId, taskId: round.taskId, problemId: round.problemId, paymentId: round.quote.paymentId, requestDigest: round.quote.requestDigest, chargedRaw: round.chargedRaw, refundedRaw: round.refundedRaw, revenueRaw: round.revenueRaw, outcome: round.outcome, acceptance: publicReceipt(round.acceptance), payment: publicReceipt(round.payment), settlement: { ...publicReceipt(round.settlement), mode: round.settlement.mode, cases: round.settlement.cases ?? 0 },
      selectedSurplusRaw: round.decision.assessments.find(a => a.taskId === round.taskId).surplusRaw, before: publicSnapshot(round.before), after: publicSnapshot(round.after) }));
    out.interruptions = data.interruptions.map(value => ({ checkpoint: value.checkpoint, beforePid: value.beforePid, afterPid: value.afterPid, signal: 'SIGKILL', originalProcessExited: true, requestId: value.original.requestId, paymentId: value.original.paymentId, policySha256: value.original.policySha256, preservedOriginalHandleAndBytes: true, preservedGrossBudgetAndPending: true, replayAddedEffects: 0 }));
    out.unknown = { requestId: data.unknown.requestId, paymentId: data.unknown.paymentId, blockedReason: 'UNRESOLVED_PAYMENT_OR_HISTORY', resolution: { kind: 'provider-full-refund-and-authorized-task-failure', amountRaw: data.unknown.resolution.amountRaw, txHash: data.unknown.resolution.receipt.txHash, terminalTaskStatus: '4', terminalEscrowBalanceRaw: '0' }, continuedRequestId: data.unknown.continuedRequestId };
  }
  out.cleanup = { ownedProcessesStopped: true, ownedContainersRemoved: true, privateTempDirectoryRemoved: true, ownedIpcDirectoryRemoved: true, failures: [] };
  return out;
}
