import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { canonical, type Json } from "@agentfuel/sdk";
import { selectInference, type SelectionSnapshot } from "../../../packages/pi-loop/src/selector.js";
import { validateWorkflowConfig, type WorkflowConfig } from "../../../packages/pi-loop/src/workflow.js";
import { readHostedAccounting } from "./accounting.js";
import { assessHostedStrategyAdvice, validateStrategyAdvicePreview } from "./strategy-advice.js";
import { validateHostedFinance } from "./finance-projection.js";
import { HostedError, type HostedAgent, type HostedFinance, type HostedRun } from "./types.js";
import type { HostedStrategyAdvice, StrategyAdvicePreview, StrategyHistory, StrategyHistoryEntry, StrategyPrediction } from "./strategy-types.js";

const uuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
const raw = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value) && BigInt(value) < 1n << 256n;
const record = (value: unknown): value is Record<string, any> => !!value && typeof value === "object" && !Array.isArray(value);
const hash = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
const same = (a: unknown, b: unknown) => typeof a === "string" && typeof b === "string" && a.toLowerCase() === b.toLowerCase();
const tasks = ["task", "metered-task", "reward-task"];
const uniq = (values: string[]) => [...new Set(values)].sort();
export interface ReadStrategyAdviceInput {
  directory: string; chainId?: string; agent: HostedAgent; runs: HostedRun[]; finance: HostedFinance;
  fundingRoutes?: Record<string, { parentRequestId: string; childId: string; modelId: string }>;
  preview?: StrategyAdvicePreview; observedAt?: string;
}
/** Read bounded retained journals only. Never load keys, acquire writer locks, recover, redispatch or contact a service. */
export async function readHostedStrategyAdvice(input: ReadStrategyAdviceInput): Promise<HostedStrategyAdvice> {
  const preview = validateStrategyAdvicePreview(input.preview ?? {}), agent = input.agent;
  if (!uuid(agent.id)) throw new HostedError("HOSTED_AGENT_NOT_FOUND", 404);
  const runs = input.runs.filter(run => run.agentId === agent.id), root = resolve(input.directory, "agents", agent.id, "runs");
  const accounting = await readHostedAccounting({ directory: input.directory, chainId: input.chainId, agent, runs, fundingRoutes: input.fundingRoutes });
  const history: StrategyHistory = { scope: "retained-hosted-history", entries: [], entryCount: 0, entriesTruncated: accounting.coverage.entriesTruncated, gaps: [] };
  let reads = 0, bytes = 0;
  const cache = new Map<string, Record<string, any> | undefined>();
  async function journal(path: string, gaps: string[], optional = false): Promise<Record<string, any> | undefined> {
    if (cache.has(path)) { const found = cache.get(path); if (!found && !optional) gaps.push("STRATEGY_HISTORY_MISSING"); return found; }
    if (++reads > 1000) { gaps.push("STRATEGY_HISTORY_LIMIT"); return; }
    let file: Awaited<ReturnType<typeof open>> | undefined;
    try {
      if (!path.startsWith(root + sep) || await realpath(path) !== path) throw Error("binding");
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW); const stat = await file.stat();
      if (!stat.isFile() || stat.size > 16 * 1024 * 1024 || (bytes += stat.size) > 64 * 1024 * 1024) { gaps.push("STRATEGY_HISTORY_LIMIT"); return; }
      const value: unknown = JSON.parse(await file.readFile("utf8"));
      if (!record(value) || value.version !== 1) throw Error("version");
      cache.set(path, value); return value;
    } catch (error) {
      const missing = (error as NodeJS.ErrnoException).code === "ENOENT";
      if (!missing || !optional) gaps.push(missing ? "STRATEGY_HISTORY_MISSING" : "STRATEGY_HISTORY_INVALID");
      cache.set(path, undefined); return;
    } finally { await file?.close(); }
  }
  async function prediction(directory: string, row: StrategyHistoryEntry): Promise<StrategyPrediction | null> {
    const state = await journal(join(directory, "task-executor", "session.json"), row.gaps);
    if (!state) return null;
    const snapshot = state.snapshot;
    if (!record(snapshot) || snapshot.agent !== agent.id || snapshot.owner !== agent.owner || !same(snapshot.wallet, agent.wallet) || snapshot.request !== row.requestId || snapshot.action !== row.action || state.binding !== hash(snapshot)) {
      row.gaps.push("STRATEGY_ADMISSION_BINDING_MISMATCH"); return null;
    }
    try {
      const config = validateWorkflowConfig(snapshot.workflow);
      if (!agent.binding || config.agentId !== agent.binding.agentId || config.chainId !== agent.binding.chainId || !same(agent.binding.wallet, agent.wallet)) throw Error("domain");
      const models = snapshot.config?.models;
      const original = Array.isArray(models) ? models.filter((model: any) => model?.id === snapshot.settings?.modelId) : [];
      const template = original[0]?.templates?.[snapshot.settings?.strategy];
      if (original.length !== 1 || !record(template) || !isDeepStrictEqual(original[0].physicalModels, snapshot.physicalModels) ||
        ["chainId", "account", "asset", "escrowAddress"].some(key => !same(template[key], (config as any)[key]))) throw Error("template");
      if (state.result) {
        const current = runs.find(run => run.requestId === row.requestId)?.result;
        if (current && ["phase", "terminal", "success", "chargedRaw", "taskId", "fromCashRaw", "fromCreditRaw", "refundedRaw", "settlement"].some(key =>
          (current as any)[key] !== undefined && state.result[key] !== undefined && !isDeepStrictEqual((current as any)[key], state.result[key]))) throw Error("result");
      }
      const beforeRead = row.gaps.length;
      const saved = await journal(join(directory, "task-executor", "workflow", "session.json"), row.gaps, true);
      if (row.gaps.length > beforeRead) throw Error("journal");
      if (saved && (saved.binding !== hash(saved.config) || !isDeepStrictEqual(saved.config, config) || !same(saved.signer, agent.wallet))) throw Error("workflow");
      const decision = saved?.decision ?? state.admission;
      if (!record(decision) || !record(decision.snapshot)) { row.gaps.push("STRATEGY_ORIGINAL_PREDICTION_MISSING"); return null; }
      const { funding, ...selection } = config;
      const verified = selectInference({ ...selection, providers: config.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) }, decision.snapshot as SelectionSnapshot);
      if (funding && !config.economics) {
        for (const candidate of verified.candidates) candidate.rejected = candidate.rejected.filter(reason => reason !== "FUNDS" && reason !== "PRICE_LIMIT");
        verified.selected = verified.candidates.find(candidate => !candidate.rejected.length);
      }
      if (hash(verified) !== hash(decision)) throw Error("decision");
      const selected = verified.selected;
      if (!selected) { row.gaps.push("STRATEGY_ORIGINAL_ADMISSION_REJECTED"); return null; }
      const accountingEntry = accounting.entries.find(entry => entry.requestId === row.requestId);
      if (accountingEntry?.taskId !== selected.taskId) throw Error("task");
      if (!selected.economics || !config.economics) { row.gaps.push("STRATEGY_ORIGINAL_PREDICTION_MISSING"); return null; }
      const provider = config.providers.find(provider => provider.id === selected.providerId)!, route = provider.routes.find(route => route.tier === selected.tier)!;
      // A provider label can survive a physical model, price-plan or asset change. Never pool those routes.
      const routeBinding = hash({ domain: { chainId: config.chainId, account: config.account.toLowerCase(), asset: config.asset.toLowerCase(), escrowAddress: config.escrowAddress.toLowerCase() },
        provider: { ...provider, routes: [route] }, physicalModels: snapshot.physicalModels ?? null, modelId: snapshot.settings?.modelId ?? null, funding: funding ?? selected.funding });
      const economics = selected.economics;
      return { source: "original-workflow-admission", atMs: verified.snapshot.atMs, snapshotHash: verified.snapshotHash, routeBinding,
        taskId: selected.taskId, problemId: selected.problemId, providerId: selected.providerId, tier: selected.tier, funding: funding ?? selected.funding,
        executionCostRaw: economics.executionCostRaw, planningCostRaw: economics.planningCostRaw, borrowerFeeRaw: economics.borrowerFeeRaw,
        netRevenueRaw: economics.netRevenueRaw, netRewardRaw: economics.netRewardRaw, originalMinNetRewardRaw: config.economics.minNetRewardRaw };
    } catch { row.gaps.push("STRATEGY_ADMISSION_BINDING_MISMATCH"); return null; }
  }
  async function planning(row: StrategyHistoryEntry): Promise<string | null> {
    if (!row.parentRequestId) return "0";
    const loop = await journal(join(root, row.parentRequestId, "autonomy-loop", "session.json"), row.gaps);
    if (!loop || loop.config?.sessionId !== row.parentRequestId || !Array.isArray(loop.steps) || loop.steps.length > 1000) { row.gaps.push("STRATEGY_PLANNING_ATTRIBUTION_UNKNOWN"); return null; }
    const steps = loop.steps.filter((step: unknown) => record(step) && step.childId === row.requestId);
    if (steps.length !== 1) { row.gaps.push("STRATEGY_PLANNING_ATTRIBUTION_UNKNOWN"); return null; }
    const step = steps[0], charged = step.decisionChargedRaw ?? (step.decisionSource === "runtime" ? "0" : undefined);
    const parentEntry = accounting.entries.find(entry => entry.requestId === row.parentRequestId && entry.action === "planning");
    const child = await journal(join(root, row.parentRequestId, "children", row.requestId, "task-executor", "session.json"), row.gaps);
    const fundingMatches = row.prediction?.funding === "inference-allowance" ? ["cash", "credit"].includes(step.decision?.funding)
      : step.decision?.funding === (row.prediction?.funding === "reward-tokens" ? "reward-tokens" : row.prediction?.funding === "task-credit" ? "credit" : "cash");
    if (!raw(charged) || step.decisionRecovery?.status === "unknown" || parentEntry?.status !== "confirmed" ||
      step.decision?.action !== "run-task" || step.decision?.modelId !== child?.snapshot?.settings?.modelId ||
      row.prediction && (row.prediction.planningCostRaw !== charged || !fundingMatches)) {
      row.gaps.push("STRATEGY_PLANNING_ATTRIBUTION_UNKNOWN"); return null;
    }
    return charged;
  }
  for (const entry of accounting.entries) {
    if (!tasks.includes(entry.action) || !uuid(entry.requestId) || entry.parentRequestId !== undefined && !uuid(entry.parentRequestId)) continue;
    const run = runs.find(run => run.requestId === entry.requestId);
    const row: StrategyHistoryEntry = { requestId: entry.requestId, ...(entry.parentRequestId ? { parentRequestId: entry.parentRequestId } : {}), at: entry.at, action: entry.action,
      outcome: entry.status === "pending" ? "pending" : "unknown", prediction: null,
      realized: { status: entry.status, executionCostRaw: entry.inferenceCostRaw, borrowingFeeRaw: null, taskRevenueRaw: null, planningCostRaw: null,
        taskContributionRaw: null, netAfterPlanningRaw: null, failureLossRaw: null, knownFailureLossLowerBoundRaw: null }, executionCostDeviationRaw: null, gaps: [...entry.reasons] };
    const parent = entry.parentRequestId ?? input.fundingRoutes?.[entry.requestId]?.parentRequestId;
    const directory = parent && uuid(parent) ? join(root, parent, "children", entry.requestId) : join(root, entry.requestId);
    row.prediction = await prediction(directory, row);
    let result = run?.result;
    if (entry.parentRequestId) {
      const saved = await journal(join(directory, "task-executor", "session.json"), row.gaps);
      result = saved?.snapshot?.agent === agent.id && saved.snapshot.owner === agent.owner && same(saved.snapshot.wallet, agent.wallet) && saved.snapshot.request === row.requestId ? saved.result : undefined;
    }
    if (entry.status !== "pending" && result?.terminal === true && typeof result.success === "boolean") row.outcome = result.success ? "succeeded" : "failed";
    else if (entry.status !== "pending" && run && ["Succeeded", "Failed"].includes(run.status)) row.outcome = run.status === "Succeeded" ? "succeeded" : "failed";
    const settled = !entry.reasons.some(reason => ["ACCOUNTING_SETTLEMENT_MISSING", "ACCOUNTING_HISTORY_MISSING", "ACCOUNTING_HISTORY_INVALID", "ACCOUNTING_BINDING_MISMATCH", "ACCOUNTING_DUPLICATE_TASK"].includes(reason)) && entry.status !== "pending";
    row.realized.borrowingFeeRaw = entry.reasons.includes("ACCOUNTING_BORROWING_FEE_UNKNOWN") || !settled ? null : entry.borrowingFeeRaw;
    row.realized.taskRevenueRaw = settled ? entry.taskRevenueRaw : null;
    row.realized.planningCostRaw = await planning(row);
    if (row.realized.planningCostRaw === null || row.gaps.includes("STRATEGY_ADMISSION_BINDING_MISMATCH")) row.realized.status = entry.status === "pending" ? "pending" : "incomplete";
    if (row.realized.status === "confirmed" && row.realized.borrowingFeeRaw !== null && row.realized.taskRevenueRaw !== null) {
      const contribution = BigInt(entry.taskRevenueRaw) - BigInt(entry.inferenceCostRaw) - BigInt(row.realized.borrowingFeeRaw);
      row.realized.taskContributionRaw = contribution.toString();
      if (row.realized.planningCostRaw !== null) row.realized.netAfterPlanningRaw = (contribution - BigInt(row.realized.planningCostRaw)).toString();
      if (row.prediction) row.executionCostDeviationRaw = (BigInt(entry.inferenceCostRaw) - BigInt(row.prediction.executionCostRaw)).toString();
    }
    if (row.outcome === "failed") {
      if (row.realized.netAfterPlanningRaw !== null) row.realized.failureLossRaw = (-BigInt(row.realized.netAfterPlanningRaw) > 0n ? -BigInt(row.realized.netAfterPlanningRaw) : 0n).toString();
      // Known charge is a lower bound only when zero failed-task proceeds are proven; never replace an unknown receipt with zero.
      if (row.realized.taskRevenueRaw !== null && !entry.reasons.some(reason => ["ACCOUNTING_COST_MISMATCH", "ACCOUNTING_DUPLICATE_PAYMENT", "ACCOUNTING_DUPLICATE_TASK", "ACCOUNTING_HISTORY_INVALID", "ACCOUNTING_BINDING_MISMATCH"].includes(reason))) row.realized.knownFailureLossLowerBoundRaw = (BigInt(entry.inferenceCostRaw) + BigInt(row.realized.borrowingFeeRaw ?? "0") + BigInt(row.realized.planningCostRaw ?? "0") > BigInt(row.realized.taskRevenueRaw)
        ? BigInt(entry.inferenceCostRaw) + BigInt(row.realized.borrowingFeeRaw ?? "0") + BigInt(row.realized.planningCostRaw ?? "0") - BigInt(row.realized.taskRevenueRaw) : 0n).toString();
    }
    row.gaps = uniq([...row.gaps, ...(!row.prediction ? ["STRATEGY_ORIGINAL_PREDICTION_MISSING"] : []), ...(row.outcome === "unknown" ? ["STRATEGY_OUTCOME_UNKNOWN"] : [])]);
    history.entries.push(row);
  }
  history.entryCount = history.entries.length;
  history.gaps = uniq(history.entries.flatMap(row => row.gaps));
  const childIds = new Set(accounting.entries.filter(entry => entry.parentRequestId).map(entry => entry.requestId));
  let commitments = 0n;
  for (const run of runs) if (!["Succeeded", "Failed"].includes(run.status) && !childIds.has(run.requestId)) {
    if (raw(run.reservedRaw)) commitments += BigInt(run.reservedRaw); else history.gaps = uniq([...history.gaps, "STRATEGY_RESERVATION_UNKNOWN"]);
  }
  let finance: HostedFinance;
  try { finance = validateHostedFinance(input.finance, agent, agent.binding?.chainId ?? ""); }
  catch { finance = { status: "unavailable", observedAt: input.observedAt ?? new Date().toISOString(), reason: "HOSTED_FINANCE_UNCONFIRMED" }; }
  return assessHostedStrategyAdvice({ agent, finance, accounting, history, preview, observedAt: input.observedAt ?? new Date().toISOString(), pendingCommitmentsRaw: commitments.toString() });
}
