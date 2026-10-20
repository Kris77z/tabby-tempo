import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { Transaction, keccak256 } from "ethers";
import { accountInterface, canonical, paymentId, requestDigest, type Json } from "@agentfuel/sdk";
import { selectInference } from "../../../packages/pi-loop/src/selector.js";
import { validateWorkflowConfig, type WorkflowConfig } from "../../../packages/pi-loop/src/workflow.js";
import { readHostedAccounting } from "./accounting.js";
import { assessHostedOperatingReport, validateOperatingReportPreview } from "./operating-report.js";
import { HostedError, type HostedAccountingEntry, type HostedAgent, type HostedFinance, type HostedRun } from "./types.js";
import type { HostedOperatingReport, OperatingReportPreview, OperatingRoleEvidence, OperatingSupplierReceipt } from "./operating-types.js";

const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const raw = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v) && BigInt(v) < 1n << 256n;
const txHash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const address = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{40}$/i.test(v);
const label = (v: unknown): v is string => typeof v === "string" && /^[A-Za-z0-9_./:-]{1,160}$/.test(v);
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const digest = (v: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(v)) as Json)).digest("hex");
const tasks = ["task", "metered-task", "reward-task"];
export interface ReadOperatingReportInput {
  directory: string; chainId?: string; agent: HostedAgent; runs: HostedRun[]; finance: HostedFinance;
  fundingRoutes?: Record<string, { parentRequestId: string; childId: string; modelId: string }>;
  preview?: OperatingReportPreview; observedAt?: string;
}
/** Bounded, no-follow, read-only projection of original retained bindings. Never opens keys, contacts a service or replays a request. */
export async function readHostedOperatingReport(input: ReadOperatingReportInput): Promise<HostedOperatingReport> {
  const preview = validateOperatingReportPreview(input.preview ?? {}), { agent } = input;
  if (!uuid(agent.id)) throw new HostedError("HOSTED_AGENT_NOT_FOUND", 404);
  const runs = input.runs.filter(run => run.agentId === agent.id), root = resolve(input.directory, "agents", agent.id, "runs");
  const accounting = await readHostedAccounting({ directory: input.directory, chainId: input.chainId, agent, runs, fundingRoutes: input.fundingRoutes });
  const evidence: OperatingRoleEvidence = { suppliers: [], taskFees: [], gaps: [], entriesTruncated: accounting.coverage.entriesTruncated };
  const observedAt = input.observedAt ?? new Date().toISOString();
  let reads = 0, bytes = 0;
  const cache = new Map<string, Record<string, any> | undefined>();
  async function journal(path: string, required = true): Promise<Record<string, any> | undefined> {
    if (cache.has(path)) return cache.get(path);
    if (++reads > 1000) { evidence.gaps.push("OPERATING_HISTORY_LIMIT"); evidence.entriesTruncated = true; return; }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (!path.startsWith(root + sep) || await realpath(path) !== path) throw Error("path");
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024) { evidence.gaps.push("OPERATING_HISTORY_LIMIT"); evidence.entriesTruncated = true; return; }
      // Count actual bytes, including growth after stat. Never let a replaced FIFO block this read-only endpoint.
      const parts: Buffer[] = []; let fileBytes = 0;
      for (;;) {
        const chunk = Buffer.allocUnsafe(Math.min(65536, 16 * 1024 * 1024 - fileBytes + 1, 64 * 1024 * 1024 - bytes + 1));
        const read = await file.read(chunk, 0, chunk.length, null); if (read.bytesRead === 0) break;
        fileBytes += read.bytesRead; bytes += read.bytesRead;
        if (fileBytes > 16 * 1024 * 1024 || bytes > 64 * 1024 * 1024) { evidence.gaps.push("OPERATING_HISTORY_LIMIT"); evidence.entriesTruncated = true; cache.set(path, undefined); return; }
        parts.push(chunk.subarray(0, read.bytesRead));
      }
      const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(parts)));
      if (!record(value) || value.version !== 1) throw Error("version");
      cache.set(path, value); return value;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing || required) evidence.gaps.push(missing ? "OPERATING_HISTORY_MISSING" : "OPERATING_HISTORY_INVALID");
      cache.set(path, undefined); return;
    } finally { await file?.close(); }
  }
  function addReceipt(value: OperatingSupplierReceipt) {
    if (evidence.suppliers.length >= 200) { evidence.entriesTruncated = true; evidence.gaps.push("OPERATING_HISTORY_TRUNCATED"); return; }
    evidence.suppliers.push(value);
  }
  function boundSnapshot(state: Record<string, any>, request: string, action: string): WorkflowConfig {
    const s = state.snapshot;
    if (!record(s) || s.agent !== agent.id || s.owner !== agent.owner || !same(s.wallet, agent.wallet) || s.request !== request || s.action !== action || state.binding !== digest(s)) throw Error("snapshot");
    const c = validateWorkflowConfig(s.workflow), model = s.config?.models?.filter((model: any) => model?.id === s.settings?.modelId), template = model?.[0]?.templates?.[s.settings?.strategy];
    if (!agent.binding || c.chainId !== agent.binding.chainId || c.agentId !== agent.binding.agentId || !same(agent.binding.wallet, agent.wallet) || model.length !== 1 || !record(template) || !isDeepStrictEqual(model[0].physicalModels, s.physicalModels) ||
      ["chainId", "account", "asset", "escrowAddress"].some(key => !same(template[key], (c as any)[key])) || !address(c.account) || !address(c.asset)) throw Error("domain");
    const domain = { chainId: c.chainId, account: c.account.toLowerCase(), asset: c.asset.toLowerCase() };
    if (evidence.settlementDomain && !isDeepStrictEqual(evidence.settlementDomain, domain)) throw Error("domain conflict");
    evidence.settlementDomain ??= domain;
    return c;
  }
  // Provision/deposit snapshots can bind the settlement asset for later goal/planner calls without returning operator configuration.
  for (const run of runs.filter(run => ["provision", "deposit"].includes(run.action)).slice(0, 200)) {
    if (!uuid(run.requestId)) continue;
    const saved = await journal(join(root, run.requestId, "task-executor", "session.json"), false);
    if (saved) { try { boundSnapshot(saved, run.requestId, run.action); } catch { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); } }
  }
  function receipt(handle: unknown, expected: {
    requestId: string; taskId: string; providerId: string; payTo: string; service: string; model: string;
    grossRaw: string; refundedRaw: string; netRaw: string; paymentTxHash: string; originalRoute: unknown; inference?: unknown;
  }): OperatingSupplierReceipt {
    if (!record(handle) || handle.version !== 1 || !record(handle.quote) || !record(handle.input) || !record(handle.submission) || !evidence.settlementDomain) throw Error("handle");
    const q = handle.quote, submission = handle.submission, domain = evidence.settlementDomain;
    if (!agent.binding || q.agentId !== agent.binding.agentId || q.taskId !== expected.taskId || q.chainId !== domain.chainId || !same(q.account, domain.account) || !same(q.asset, domain.asset) || !same(q.payTo, expected.payTo) ||
      q.service !== expected.service || q.model !== expected.model || handle.input.agentId !== q.agentId || handle.input.taskId !== q.taskId || handle.input.service !== q.service || handle.input.model !== q.model ||
      ![q.price, expected.grossRaw, expected.refundedRaw, expected.netRaw].every(raw) || q.price !== expected.grossRaw || BigInt(expected.grossRaw) - BigInt(expected.refundedRaw) !== BigInt(expected.netRaw) ||
      !txHash(q.paymentId) || !txHash(q.requestDigest) || !txHash(q.serverNonce) || q.requestDigest !== requestDigest(handle.input as any) || q.paymentId !== paymentId(q.taskId, q.requestDigest, q.serverNonce) ||
      submission.txHash !== expected.paymentTxHash || !txHash(submission.txHash) || typeof submission.rawTransaction !== "string" || keccak256(submission.rawTransaction) !== submission.txHash ||
      !label(expected.providerId) || !label(q.service) || !label(q.model) || !address(q.payTo)) throw Error("quote");
    const signed = Transaction.from(submission.rawTransaction), op = accountInterface.parseTransaction({ data: signed.data, value: signed.value });
    if (!signed.from || !same(signed.from, agent.wallet) || !same(submission.from, agent.wallet) || signed.nonce !== submission.nonce || signed.chainId !== BigInt(domain.chainId) || !signed.to || !same(signed.to, domain.account) || signed.value !== 0n ||
      !op || op.name !== "payProvider" || op.args[0] !== BigInt(q.agentId) || !same(op.args[1], q.payTo) || op.args[2] !== BigInt(q.price) || op.args[3] !== q.paymentId) throw Error("payment");
    if (expected.inference !== undefined) {
      if (!record(expected.inference) || !record(expected.inference.receipt)) throw Error("receipt");
      const r = expected.inference.receipt;
      if (["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "chainId"].some(key => r[key] !== q[key]) || ["account", "asset", "payTo"].some(key => !same(r[key], q[key])) || r.txHash !== submission.txHash ||
        !raw(r.fromCash) || !raw(r.fromCredit) || BigInt(r.fromCash) + BigInt(r.fromCredit) !== BigInt(q.price) || !txHash(r.blockHash) || !Number.isSafeInteger(r.blockNumber) || r.blockNumber < 0 || !Number.isSafeInteger(r.timestamp) || r.timestamp < 0 || r.timestamp * 1000 > Date.parse(observedAt)) throw Error("receipt");
    }
    return { requestId: expected.requestId, paymentId: q.paymentId, paymentTxHash: submission.txHash,
      routeBinding: digest({ domain, payTo: q.payTo.toLowerCase(), providerId: expected.providerId, service: q.service, model: q.model, originalRoute: expected.originalRoute }),
      providerId: expected.providerId, payTo: q.payTo, chainId: q.chainId, account: q.account, asset: q.asset, service: q.service, model: q.model,
      grossReceiptsRaw: expected.grossRaw, refundsRaw: expected.refundedRaw, netReceiptsRaw: expected.netRaw };
  }
  async function task(entry: HostedAccountingEntry, directory: string) {
    const state = await journal(join(directory, "task-executor", "session.json"));
    const workflow = await journal(join(directory, "task-executor", "workflow", "session.json"));
    if (!state || !workflow) return;
    try {
      const config = boundSnapshot(state, entry.requestId, entry.action), s = state.snapshot, result = state.result;
      const publicRun = runs.find(run => run.requestId === entry.requestId);
      if (workflow.binding !== digest(workflow.config) || !isDeepStrictEqual(workflow.config, config) || !same(workflow.signer, agent.wallet) || !record(result) || result.terminal !== true || result.chargedRaw !== entry.inferenceCostRaw || (result.refundedRaw ?? "0") !== entry.refundsRaw || result.taskId !== entry.taskId ||
        publicRun?.result && ["phase", "terminal", "success", "chargedRaw", "taskId", "paymentId", "paymentTxHash", "fromCashRaw", "fromCreditRaw", "refundedRaw", "settlement"].some(key => !isDeepStrictEqual((publicRun.result as any)[key], result[key]))) throw Error("result");
      const { funding, ...selection } = config;
      const verified = selectInference({ ...selection, providers: config.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) }, workflow.decision?.snapshot);
      if (funding && !config.economics) {
        for (const candidate of verified.candidates) candidate.rejected = candidate.rejected.filter(reason => reason !== "FUNDS" && reason !== "PRICE_LIMIT");
        verified.selected = verified.candidates.find(candidate => !candidate.rejected.length);
      }
      const selected = verified.selected;
      // The host's earlier preview and the workflow's later original admission can observe different blocks/times.
      // Recompute the retained workflow decision itself; do not equate the two observations.
      if (!selected || digest(verified) !== digest(workflow.decision) || selected.taskId !== entry.taskId) throw Error("admission");
      const provider = config.providers.find(provider => provider.id === selected.providerId)!, route = provider.routes.find(route => route.tier === selected.tier)!;
      const settled = result.settlement;
      if (settled !== undefined) {
        if (!record(settled) || !txHash(settled.txHash) || !record(settled.block) || !txHash(settled.block.hash) || !Number.isSafeInteger(settled.block.timestamp) || settled.block.timestamp * 1000 > Date.parse(observedAt) || settled.passed !== result.success ||
          ![settled.repaidRaw, settled.residualRaw, settled.slashedRaw].every(raw) || !record(workflow.finance) || workflow.finance.repaid !== settled.repaidRaw || workflow.finance.residual !== settled.residualRaw || workflow.finance.slashed !== settled.slashedRaw || workflow.finance.loanStatus !== settled.loanStatus) throw Error("settlement");
        let protocolFeeRaw: string | null = settled.passed ? null : "0";
        const revenue = verified.snapshot.tasks.find(task => task.taskId === selected.taskId)?.revenue;
        if (settled.passed && revenue && [revenue.rewardRaw, revenue.protocolFeeBps].every(raw) && BigInt(revenue.protocolFeeBps) <= 10000n) {
          const fee = BigInt(revenue.rewardRaw) * BigInt(revenue.protocolFeeBps) / 10000n;
          // Immutable reward/fee terms plus canonical settled net proceeds support attribution, not the identity or cash balance of feeRecipient.
          if (BigInt(revenue.rewardRaw) - fee !== BigInt(settled.repaidRaw) + BigInt(settled.residualRaw) || entry.taskRevenueRaw !== (BigInt(settled.repaidRaw) + BigInt(settled.residualRaw)).toString()) throw Error("net proceeds");
          protocolFeeRaw = fee.toString();
        }
        evidence.taskFees.push({ requestId: entry.requestId, taskId: entry.taskId!, settlementTxHash: settled.txHash, protocolFeeRaw,
          creditFeeSettledRaw: entry.reasons.includes("ACCOUNTING_BORROWING_FEE_UNKNOWN") ? null : entry.borrowingFeeRaw,
          source: "settled-task-and-original-reward", gaps: protocolFeeRaw === null ? ["OPERATING_PROTOCOL_FEE_UNKNOWN"] : [] });
      } else if (result.phase === "Refunded" && entry.inferenceCostRaw === "0" && entry.borrowingFeeRaw === "0" && entry.taskRevenueRaw === "0" && workflow.finance?.principal === "0" && workflow.finance?.fee === "0" && ["0", "4"].includes(workflow.finance?.loanStatus)) {
        evidence.taskFees.push({ requestId: entry.requestId, taskId: entry.taskId!, protocolFeeRaw: "0", creditFeeSettledRaw: "0", source: "confirmed-no-fee", gaps: [] });
      } else if (entry.borrowingFeeRaw !== "0" || entry.taskRevenueRaw !== "0") throw Error("settlement");
      const gross = BigInt(entry.inferenceCostRaw) + BigInt(entry.refundsRaw);
      if (gross === 0n) return;
      if (!raw(result.fromCashRaw) || !raw(result.fromCreditRaw) || BigInt(result.fromCashRaw) + BigInt(result.fromCreditRaw) !== gross || result.paymentId !== workflow.handle?.quote?.paymentId || !txHash(result.paymentTxHash)) throw Error("payment result");
      const metered = funding === "inference-allowance", original = metered ? s.config?.metered : provider;
      if (!record(original)) throw Error("provider");
      if (metered && (workflow.handle.quote.service !== "infercredit/allowance" || workflow.handle.quote.price !== original.priceRaw || workflow.handle.relayUrl !== original.relayUrl)) throw Error("allowance");
      addReceipt(receipt(workflow.handle, { requestId: entry.requestId, taskId: entry.taskId!, providerId: selected.providerId,
        payTo: metered ? original.payTo : provider.payTo, service: metered ? "infercredit/allowance" : provider.service, model: metered ? workflow.handle.quote.model : provider.model,
        grossRaw: gross.toString(), refundedRaw: entry.refundsRaw, netRaw: entry.inferenceCostRaw, paymentTxHash: result.paymentTxHash,
        originalRoute: { provider: original, route, physicalModels: s.physicalModels }, ...(workflow.child?.inference ? { inference: workflow.child.inference } : {}) }));
    } catch { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); }
  }
  // Bound tasks establish original domains before optional planner/mission attribution.
  for (const entry of accounting.entries.filter(entry => tasks.includes(entry.action) && entry.status === "confirmed")) {
    if (entry.taskId === undefined && entry.inferenceCostRaw === "0" && entry.refundsRaw === "0" && entry.taskRevenueRaw === "0" && entry.borrowingFeeRaw === "0") continue;
    const parent = entry.parentRequestId ?? input.fundingRoutes?.[entry.requestId]?.parentRequestId;
    if (!uuid(entry.requestId) || parent !== undefined && !uuid(parent)) { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); continue; }
    await task(entry, parent ? join(root, parent, "children", entry.requestId) : join(root, entry.requestId));
  }
  for (const entry of accounting.entries.filter(entry => ["goal", "planning"].includes(entry.action) && entry.status === "confirmed" && (entry.inferenceCostRaw !== "0" || entry.refundsRaw !== "0"))) {
    if (!uuid(entry.requestId)) continue;
    if (entry.action === "planning") {
      const host = await journal(join(root, entry.requestId, "autonomy-host", "session.json")), loop = await journal(join(root, entry.requestId, "autonomy-loop", "session.json"));
      if (!host || !loop) continue;
      if (host.input?.agent?.id !== agent.id || host.input?.agent?.owner !== agent.owner || !same(host.input?.agent?.wallet, agent.wallet) || host.input?.run?.requestId !== entry.requestId || loop.config?.sessionId !== entry.requestId || !Array.isArray(loop.steps) || loop.steps.length > 1000) { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); continue; }
      for (const step of loop.steps) {
        if (step?.decisionSource === "runtime" && step.decisionChargedRaw === "0") continue;
        if (!uuid(step?.decisionId)) { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); continue; }
        const saved = await journal(join(root, entry.requestId, "planner", step.decisionId, "session.json"));
        if (!saved) continue;
        try {
          const config = host.config;
          if (!record(config) || !isDeepStrictEqual(saved.context, step.context) || !raw(step.decisionChargedRaw) || !raw(step.decisionRefundedRaw ?? "0") || step.decisionRecovery?.status === "unknown" || !saved.handle?.submission?.txHash) throw Error("planner");
          const net = step.decisionChargedRaw, refunded = step.decisionRefundedRaw ?? "0";
          addReceipt(receipt(saved.handle, { requestId: entry.requestId, taskId: "0", providerId: "autonomy-planner", payTo: config.plannerProvider, service: config.plannerService, model: config.plannerModel,
            grossRaw: (BigInt(net) + BigInt(refunded)).toString(), refundedRaw: refunded, netRaw: net, paymentTxHash: saved.handle.submission.txHash,
            originalRoute: { provider: config.plannerProvider, service: config.plannerService, model: config.plannerModel, physicalModel: config.plannerPhysicalModel, relayUrl: config.plannerRelayUrl }, ...(saved.inference ? { inference: saved.inference } : {}) }));
        } catch { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); }
      }
    } else {
      const saved = await journal(join(root, entry.requestId, "mission", "session.json"));
      if (!saved) continue;
      if (saved.input?.agentId !== agent.id || saved.input?.owner !== agent.owner || !same(saved.input?.wallet, agent.wallet) || saved.input?.chainAgentId !== agent.binding?.agentId || saved.input?.chainId !== agent.binding?.chainId ||
        saved.binding !== createHash("sha256").update(JSON.stringify({ requestId: entry.requestId, ...saved.input })).digest("hex") || !Array.isArray(saved.calls) || saved.calls.length > 100) { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); continue; }
      for (const call of saved.calls) {
        try {
          if (call.unpaid || call.recovery?.voided || call.recovery?.reverted) continue;
          const route = call.route ?? saved.route, net = call.response?.chargedRaw ?? call.recovery?.chargedRaw, refunded = call.recovery?.refundedRaw ?? "0";
          if (!record(route) || !Array.isArray(saved.routes ?? [saved.route]) || !(saved.routes ?? [saved.route]).some((candidate: unknown) => isDeepStrictEqual(candidate, route)) || !raw(net) || !raw(refunded) || !call.handle?.submission?.txHash || !call.response && !call.recovery?.resolved) throw Error("call");
          addReceipt(receipt(call.handle, { requestId: entry.requestId, taskId: "0", providerId: route.id, payTo: route.provider, service: route.service, model: route.model,
            grossRaw: (BigInt(net) + BigInt(refunded)).toString(), refundedRaw: refunded, netRaw: net, paymentTxHash: call.handle.submission.txHash, originalRoute: route,
            ...(call.inference ? { inference: call.inference } : {}) }));
        } catch { evidence.gaps.push("OPERATING_BINDING_MISMATCH"); }
      }
    }
  }
  const childIds = new Set(accounting.entries.filter(entry => entry.parentRequestId).map(entry => entry.requestId));
  let reservations = 0n;
  for (const run of runs) if (!["Succeeded", "Failed"].includes(run.status) && !childIds.has(run.requestId) && !input.fundingRoutes?.[run.requestId]) {
    if (raw(run.reservedRaw)) reservations += BigInt(run.reservedRaw); else evidence.gaps.push("OPERATING_RESERVATIONS_UNKNOWN");
  }
  if (raw(agent.reservedRaw)) { if (BigInt(agent.reservedRaw) > reservations) reservations = BigInt(agent.reservedRaw); }
  else evidence.gaps.push("OPERATING_RESERVATIONS_UNKNOWN");
  evidence.gaps = [...new Set(evidence.gaps)].sort();
  return assessHostedOperatingReport({ agent, finance: input.finance, accounting, evidence, pendingReservationsRaw: reservations.toString(), preview, observedAt });
}
