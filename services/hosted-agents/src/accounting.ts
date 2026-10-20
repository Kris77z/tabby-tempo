import { settlementCurrency } from "./settlement-currency.js";
import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { HostedAccounting, HostedAccountingEntry, HostedAgent, HostedResult, HostedRun } from "./types.js";

const decimal = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,77})$/.test(v);
const integer = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const uuid = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(v);
const hash = (v: unknown): v is string => typeof v === "string" && /^0x[0-9a-f]{64}$/i.test(v);
const record = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const zero = () => ({ inferenceCostRaw: "0", refundsRaw: "0", taskRevenueRaw: "0", borrowingFeeRaw: "0", gameSubsidyRaw: "0", ownerCapitalRaw: "0", startupCapitalRaw: "0", loanPrincipalRaw: "0", creditsGranted: 0, creditsUsed: 0 });
const moneyKeys = ["inferenceCostRaw", "refundsRaw", "taskRevenueRaw", "borrowingFeeRaw", "gameSubsidyRaw", "ownerCapitalRaw", "startupCapitalRaw", "loanPrincipalRaw"] as const;

/** Project only the financial whitelist from private journals. Never return a private object or spread it into a public response. */
function financialResult(v: unknown): HostedResult | undefined {
  if (!record(v) || typeof v.phase !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(v.phase) || typeof v.terminal !== "boolean" || typeof v.success !== "boolean" || v.success && !v.terminal || !decimal(v.chargedRaw)) return;
  const result: HostedResult = { phase: v.phase, terminal: v.terminal, success: v.success, chargedRaw: v.chargedRaw };
  for (const key of ["cashRaw", "principalRaw", "feeRaw", "rewardRaw", "fromCashRaw", "fromCreditRaw", "refundedRaw", "taskId"] as const) {
    if (v[key] !== undefined) { if (!decimal(v[key])) return; result[key] = v[key]; }
  }
  for (const key of ["creditsGranted", "creditsUsed"] as const) { if (v[key] !== undefined) { if (!integer(v[key])) return; result[key] = v[key]; } }
  for (const key of ["txHash", "paymentId", "paymentTxHash"] as const) { if (v[key] !== undefined) { if (!hash(v[key])) return; result[key] = v[key]; } }
  if (typeof v.reason === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(v.reason)) result.reason = v.reason;
  const s = v.settlement;
  if (s !== undefined) {
    if (!record(s) || !record(s.block) || !hash(s.txHash) || !hash(s.block.hash) || !integer(s.block.number) || !integer(s.block.timestamp) || typeof s.passed !== "boolean" || s.passed !== v.success || !v.terminal || !["0", "2", "3", "4"].includes(s.loanStatus) || ![s.repaidRaw, s.slashedRaw, s.residualRaw].every(decimal)) return;
    result.settlement = { txHash: s.txHash, block: { number: s.block.number, hash: s.block.hash, timestamp: s.block.timestamp }, passed: s.passed, loanStatus: s.loanStatus, repaidRaw: s.repaidRaw, slashedRaw: s.slashedRaw, residualRaw: s.residualRaw };
  }
  return result;
}
function issue(entry: HostedAccountingEntry, reason: string, pending = false) {
  if (!entry.reasons.includes(reason)) entry.reasons.push(reason);
  if (pending || entry.status === "pending") entry.status = "pending"; else entry.status = "incomplete";
}
interface AccountingInput { chainId?: string; directory: string; agent: HostedAgent; runs: HostedRun[]; fundingRoutes?: Record<string, { parentRequestId: string; childId: string; modelId: string }> }

/** Reads existing atomic journal snapshots without taking writer locks, replaying requests or contacting a paid/chain service. */
export async function readHostedAccounting(input: AccountingInput): Promise<HostedAccounting> {
  const { agent } = input, runs = input.runs.filter(run => run.agentId === agent.id);
  const entries: HostedAccountingEntry[] = [], seen = new Set<string>(), payments = new Set<string>(), tasks = new Set<string>();
  const root = resolve(input.directory, "agents", agent.id, "runs");
  let reads = 0, bytes = 0;
  const walletMatches = (value: unknown) => typeof value === "string" && value.toLowerCase() === agent.wallet.toLowerCase();
  async function journal(path: string, entry: HostedAccountingEntry): Promise<Record<string, any> | undefined> {
    if (++reads > 1000) { issue(entry, "ACCOUNTING_HISTORY_LIMIT"); return; }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      // A compromised journal must not turn this financial reader into an arbitrary file reader.
      if (!path.startsWith(root + sep) || await realpath(path) !== path) throw Error("invalid path");
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) { issue(entry, "ACCOUNTING_HISTORY_LIMIT"); return; }
      const value = JSON.parse(await file.readFile("utf8"));
      if (!record(value) || value.version !== 1) { issue(entry, "ACCOUNTING_HISTORY_INVALID"); return; }
      return value;
    } catch (error) {
      issue(entry, (error as NodeJS.ErrnoException).code === "ENOENT" ? "ACCOUNTING_HISTORY_MISSING" : "ACCOUNTING_HISTORY_INVALID"); return;
    } finally { await file?.close(); }
  }
  function entryFor(run: HostedRun, parentRequestId?: string): HostedAccountingEntry {
    const entry: HostedAccountingEntry = { id: run.requestId, requestId: run.requestId, ...(parentRequestId ? { parentRequestId } : {}), action: run.action,
      at: run.updatedAt, status: "confirmed", ...zero(), reasons: [] };
    entries.push(entry); return entry;
  }
  function apply(run: HostedRun, result: HostedResult | undefined, entry: HostedAccountingEntry) {
    if (!result) { if (decimal(run.chargedRaw)) entry.inferenceCostRaw = run.chargedRaw; issue(entry, "ACCOUNTING_HISTORY_MISSING"); if (!["Succeeded", "Failed"].includes(run.status)) issue(entry, "ACCOUNTING_PENDING", true); return; }
    entry.inferenceCostRaw = result.chargedRaw; entry.refundsRaw = result.refundedRaw ?? "0";
    entry.creditsGranted = result.creditsGranted ?? 0; entry.creditsUsed = result.creditsUsed ?? 0;
    if (result.taskId) entry.taskId = result.taskId;
    if (result.paymentId) entry.paymentId = result.paymentId;
    if (result.txHash ?? result.paymentTxHash) entry.txHash = result.txHash ?? result.paymentTxHash;
    if (!result.terminal) issue(entry, "ACCOUNTING_PENDING", true);
    if (/UNKNOWN|UNCERTAIN|UNCONFIRMED|RECONCIL|INTERRUPTED/.test(result.reason ?? "")) issue(entry, "ACCOUNTING_PAYMENT_UNRESOLVED", true);
    const originalCash = result.fromCashRaw, originalCredit = result.fromCreditRaw;
    if (originalCredit !== undefined) entry.loanPrincipalRaw = originalCredit;
    if (originalCash !== undefined && originalCredit !== undefined && BigInt(originalCash) + BigInt(originalCredit) !== BigInt(entry.inferenceCostRaw) + BigInt(entry.refundsRaw)) issue(entry, "ACCOUNTING_COST_MISMATCH");
    // chargedRaw is already net of refunds. Principal financed that same charge and is never a second expense.
    if (run.action === "deposit" && result.terminal && result.success) {
      if (decimal(run.amountRaw)) entry.ownerCapitalRaw = run.amountRaw; else issue(entry, "ACCOUNTING_CAPITAL_UNKNOWN");
    }
    if (run.action === "provision" && result.terminal && result.success) {
      if (result.cashRaw !== undefined) entry.startupCapitalRaw = result.cashRaw; else issue(entry, "ACCOUNTING_CAPITAL_UNKNOWN");
    }
    if (run.action === "game" && result.terminal && result.success) {
      entry.gameSubsidyRaw = result.rewardRaw ?? "0";
      if (run.rewardKind === "usdc" ? result.rewardRaw === undefined : run.rewardKind === "llm-credits" ? result.creditsGranted === undefined : result.rewardRaw === undefined && result.creditsGranted === undefined) issue(entry, "ACCOUNTING_SUBSIDY_UNKNOWN");
    }
    if (["reward-task", "credits"].includes(run.action) && result.terminal && result.success && result.creditsUsed === undefined) issue(entry, "ACCOUNTING_TOKEN_USAGE_UNKNOWN");
    if (["task", "metered-task", "reward-task"].includes(run.action)) {
      const s = result.settlement;
      if (s) {
        if (s.passed !== result.success || !result.terminal) issue(entry, "ACCOUNTING_HISTORY_INVALID");
        // TaskSettled splits protocol-fee-net reward between debt repayment and cash residual.
        // Adding principal here or subtracting it from revenue would double count financing.
        if (s.passed) entry.taskRevenueRaw = (BigInt(s.residualRaw) + BigInt(s.repaidRaw)).toString();
        if (s.loanStatus === "0" || s.loanStatus === "4") {
          if (BigInt(s.repaidRaw) !== 0n) issue(entry, "ACCOUNTING_BORROWING_FEE_UNKNOWN");
        } else if (s.loanStatus === "2" && originalCredit !== undefined && BigInt(entry.refundsRaw) === 0n && BigInt(s.repaidRaw) >= BigInt(originalCredit)) {
          entry.borrowingFeeRaw = (BigInt(s.repaidRaw) - BigInt(originalCredit)).toString();
        } else issue(entry, "ACCOUNTING_BORROWING_FEE_UNKNOWN");
      } else if (result.success || result.taskId && !["Refunded", "Stopped", "Cancelled"].includes(result.phase)) issue(entry, "ACCOUNTING_SETTLEMENT_MISSING");
      // Current principalRaw/feeRaw are outstanding amounts after settlement, often zero, not historical loan cost.
      if (!s && originalCredit !== undefined && BigInt(originalCredit) > 0n && result.phase !== "Refunded") issue(entry, "ACCOUNTING_BORROWING_FEE_UNKNOWN");
    }
    if (result.paymentId) {
      if (payments.has(result.paymentId)) {
        entry.inferenceCostRaw = "0"; entry.refundsRaw = "0"; entry.loanPrincipalRaw = "0";
        issue(entry, "ACCOUNTING_DUPLICATE_PAYMENT");
      } else payments.add(result.paymentId);
    }
    if (result.taskId && result.settlement) {
      if (tasks.has(result.taskId)) { entry.taskRevenueRaw = "0"; entry.borrowingFeeRaw = "0"; issue(entry, "ACCOUNTING_DUPLICATE_TASK"); }
      else tasks.add(result.taskId);
    }
  }
  async function simple(run: HostedRun, directory: string, parentRequestId?: string, child = false, fallback?: unknown) {
    if (seen.has(run.requestId)) return; seen.add(run.requestId);
    const entry = entryFor(run, parentRequestId);
    let result = financialResult(run.result);
    if (child) {
      result = undefined;
      const value = await journal(join(directory, ...(run.action === "game" || run.action === "credits" ? [] : ["task-executor"]), "session.json"), entry);
      if (value) {
        if (run.action !== "game" && run.action !== "credits" && (value.snapshot?.agent !== agent.id || value.snapshot?.owner !== agent.owner || !walletMatches(value.snapshot?.wallet) || value.snapshot?.request !== run.requestId || value.snapshot?.action !== run.action)) issue(entry, "ACCOUNTING_BINDING_MISMATCH");
        else result = financialResult(value.result);
      }
      if (!result && record(fallback) && decimal(fallback.chargedRaw)) result = financialResult({ phase: fallback.terminal ? "Stopped" : "Paused", terminal: fallback.terminal === true, success: fallback.success === true, chargedRaw: fallback.chargedRaw, refundedRaw: fallback.refundedRaw ?? "0" });
    }
    apply(run, result, entry);
  }
  async function autonomy(run: HostedRun, directory: string) {
    if (seen.has(run.requestId)) return; seen.add(run.requestId);
    const summary = entryFor(run), loop = await journal(join(directory, "autonomy-loop", "session.json"), summary), host = await journal(join(directory, "autonomy-host", "session.json"), summary);
    if (!loop || !host || !Array.isArray(loop.steps) || loop.steps.length > 1000 || !record(host.children) || host.input?.agent?.id !== agent.id || host.input?.agent?.owner !== agent.owner || !walletMatches(host.input?.agent?.wallet) || host.input?.run?.requestId !== run.requestId || loop.config?.sessionId !== run.requestId) {
      summary.inferenceCostRaw = decimal(run.result?.chargedRaw) ? run.result!.chargedRaw : run.chargedRaw;
      summary.refundsRaw = decimal(run.result?.refundedRaw) ? run.result!.refundedRaw! : "0";
      if (loop && host) issue(summary, "ACCOUNTING_BINDING_MISMATCH");
      if (!["Succeeded", "Failed"].includes(run.status)) issue(summary, "ACCOUNTING_PENDING", true);
      return;
    }
    summary.action = "planning";
    let parentCost = 0n, parentRefund = 0n;
    for (const step of loop.steps) {
      if (!record(step)) { issue(summary, "ACCOUNTING_HISTORY_INVALID"); continue; }
      if (decimal(step.decisionChargedRaw)) parentCost += BigInt(step.decisionChargedRaw); else if (step.decisionSource !== "runtime") issue(summary, "ACCOUNTING_PAYMENT_UNRESOLVED", true);
      if (decimal(step.decisionRefundedRaw)) parentRefund += BigInt(step.decisionRefundedRaw);
      if (step.decisionRecovery?.status === "unknown") issue(summary, "ACCOUNTING_PAYMENT_UNRESOLVED", true);
      if (step.childId !== undefined) {
        const child = uuid(step.childId) ? host.children[step.childId] : undefined;
        if (!record(child) || !record(child.run) || child.run.requestId !== step.childId || child.run.agentId !== agent.id || child.agent?.id !== agent.id || child.agent?.owner !== agent.owner || !walletMatches(child.agent?.wallet) || !["task", "metered-task", "reward-task", "game", "credits"].includes(child.run.action)) { issue(summary, "ACCOUNTING_BINDING_MISMATCH"); continue; }
        await simple({ ...child.run, updatedAt: run.updatedAt } as HostedRun, join(directory, "children", step.childId), run.requestId, true, step.outcome);
      }
    }
    summary.inferenceCostRaw = parentCost.toString(); summary.refundsRaw = parentRefund.toString();
    const children = entries.filter(entry => entry.parentRequestId === run.requestId), total = parentCost + children.reduce((sum, child) => sum + BigInt(child.inferenceCostRaw), 0n);
    const recorded = decimal(run.result?.chargedRaw) ? BigInt(run.result!.chargedRaw) : decimal(run.chargedRaw) ? BigInt(run.chargedRaw) : 0n;
    const known = decimal(loop.chargedRaw) && BigInt(loop.chargedRaw) > recorded ? BigInt(loop.chargedRaw) : recorded;
    if (!decimal(loop.chargedRaw) || BigInt(loop.chargedRaw) !== total || run.result?.terminal && recorded !== BigInt(loop.chargedRaw)) {
      issue(summary, "ACCOUNTING_COST_MISMATCH");
      // Retain a known aggregate charge even when a child journal has been lost; never invent its income.
      if (known > total) summary.inferenceCostRaw = (parentCost + known - total).toString();
    }
    if (!["Stopped", "Completed"].includes(loop.phase)) issue(summary, "ACCOUNTING_PENDING", true);
  }
  async function goal(run: HostedRun, directory: string) {
    if (seen.has(run.requestId)) return; seen.add(run.requestId);
    const entry = entryFor(run), state = await journal(join(directory, "mission", "session.json"), entry);
    // A goal's chargedRaw is cumulative over all model/specialist calls. Count it once, never add mission.calls again.
    apply(run, financialResult(run.result), entry);
    if (!state) return;
    if (state.input?.agentId !== agent.id || state.input?.owner !== agent.owner || !walletMatches(state.input?.wallet) || !Array.isArray(state.calls) || state.calls.length > 100) { issue(entry, "ACCOUNTING_BINDING_MISMATCH"); return; }
    let cost = 0n, refunds = 0n;
    for (const call of state.calls) {
      if (!record(call)) { issue(entry, "ACCOUNTING_HISTORY_INVALID"); continue; }
      const charged = call.response?.chargedRaw ?? call.recovery?.chargedRaw ?? "0", refunded = call.recovery?.refundedRaw ?? "0";
      if (!decimal(charged) || !decimal(refunded)) { issue(entry, "ACCOUNTING_HISTORY_INVALID"); continue; }
      cost += BigInt(charged); refunds += BigInt(refunded);
      if (call.started && !call.response && !call.unpaid && !call.recovery?.resolved) issue(entry, "ACCOUNTING_PAYMENT_UNRESOLVED", true);
    }
    const aggregateCost = BigInt(entry.inferenceCostRaw), aggregateRefunds = BigInt(entry.refundsRaw);
    if (run.result?.terminal && (aggregateCost !== cost || aggregateRefunds !== refunds)) issue(entry, "ACCOUNTING_COST_MISMATCH");
    // A truncated child history must not erase a known parent charge. Conflicts remain partial.
    entry.inferenceCostRaw = (aggregateCost > cost ? aggregateCost : cost).toString(); entry.refundsRaw = (aggregateRefunds > refunds ? aggregateRefunds : refunds).toString();
  }
  // Resolve parent-owned children first, regardless of database/list ordering. A
  // duplicate top-level child must retain that association instead of causing
  // the parent's aggregate reconciliation to add its charge a second time.
  const ordered = [...runs.filter(run => run.action === "autonomous"), ...runs.filter(run => run.action !== "autonomous")];
  for (const run of ordered) {
    if (!uuid(run.requestId)) continue;
    const route = input.fundingRoutes?.[run.requestId];
    const directory = route && uuid(route.parentRequestId) ? join(root, route.parentRequestId, "children", run.requestId) : join(root, run.requestId);
    if (run.action === "autonomous") await autonomy(run, directory);
    else if (run.action === "goal") await goal(run, directory);
    else await simple(run, directory);
  }
  const totals: HostedAccounting["totals"] = { ...zero(), netOperatingRaw: null };
  for (const entry of entries) {
    for (const key of moneyKeys) totals[key] = (BigInt(totals[key]) + BigInt(entry[key])).toString();
    for (const key of ["creditsGranted", "creditsUsed"] as const) {
      if (Number.isSafeInteger(totals[key] + entry[key])) totals[key] += entry[key]; else issue(entry, "ACCOUNTING_HISTORY_LIMIT");
    }
  }
  const terminalSpend = runs.filter(run => ["Succeeded", "Failed"].includes(run.status)).reduce((sum, run) => sum + (decimal(run.chargedRaw) ? BigInt(run.chargedRaw) : 0n), 0n);
  const uncoveredSpent = decimal(agent.spentRaw) && BigInt(agent.spentRaw) > terminalSpend ? BigInt(agent.spentRaw) - terminalSpend : 0n;
  const reasons = [...new Set([...entries.flatMap(entry => entry.reasons), ...(uncoveredSpent > 0n ? ["ACCOUNTING_HISTORY_MISSING"] : [])])].sort(), partial = reasons.length > 0;
  if (!partial) totals.netOperatingRaw = (BigInt(totals.taskRevenueRaw) - BigInt(totals.inferenceCostRaw) - BigInt(totals.borrowingFeeRaw)).toString();
  const recent = entries.map((entry, index) => ({ entry, index })).sort((a, b) => b.entry.at.localeCompare(a.entry.at) || b.index - a.index).slice(0, 200).map(row => row.entry);
  return { version: 1, observedAt: new Date().toISOString(), agentId: agent.id, currency: settlementCurrency(input.chainId ?? agent.binding?.chainId), decimals: 6, costScope: "settlement-asset-only", chainFeesRaw: null, actualProfitRaw: null, status: partial ? "partial" : "complete", totals,
    coverage: { scope: "retained-hosted-history", since: runs.length ? runs.map(run => run.createdAt).sort()[0] : null, runCount: runs.length, entryCount: entries.length,
      pendingCount: entries.filter(entry => entry.status === "pending").length, incompleteCount: entries.filter(entry => entry.status === "incomplete").length,
      returnedEntryCount: recent.length, entriesTruncated: entries.length > recent.length, uncoveredSpentRaw: uncoveredSpent.toString(), reasons }, entries: recent };
}
