import { randomUUID } from "node:crypto";
import { SessionStore } from "./session.js";

export type AutonomyFunding = "cash" | "credit" | "reward-tokens";
export type AutonomyDecision = { action: "run-task"; modelId: string; funding: AutonomyFunding } | { action: "stop"; reason: string };
export interface AutonomyConfig {
  version: 1; sessionId: string; maxTasks: number; maxSpendRaw: string; deadlineMs: number; maxDecisions: number;
  models: string[]; funding: AutonomyFunding[];
  /** Conservative maximum charge of one planner call; reserved before dispatch. */
  decisionReserveRaw?: string;
}
export interface AutonomyExecutionCosts {
  planningCashRaw: string; taskPackagePriceRaw: string; taskPackageCreditsRaw: string; taskPerRunLimitRaw: string;
  taskCreditLimitRaw: string; borrowerFeeBps: string;
  modelTiers: { modelId: string; tiers: string[] }[];
  tokenRates: { tier: string; inputMicroCreditsPerToken: string; outputMicroCreditsPerToken: string }[];
}
export interface AutonomyFundingQuote {
  cashAfterPlanningRaw: string; budgetAfterPlanningRaw: string;
  options: { funding: "cash" | "credit"; feasible: boolean; fromCashRaw: string; fromCreditRaw: string; borrowerFeeRaw: string }[];
}
export interface AutonomyObservation {
  cashRaw: string; debtRaw: string; creditAvailableRaw: string; inferenceCreditsAvailable: string;
  availableTasks?: number;
  /** Optional for compatibility with saved sessions predating priced planning. */
  executionCosts?: AutonomyExecutionCosts;
}
export interface AutonomyLimits { maxSpendRaw: string; deadlineMs: number }
export interface AutonomyContext {
  observation: AutonomyObservation; completedTasks: number; startedTasks: number; decisions: number;
  remainingTasks: number; remainingSpendRaw: string; deadlineMs: number; models: string[]; funding: AutonomyFunding[];
  fundingQuote?: AutonomyFundingQuote;
}
export interface AutonomyOutcome {
  terminal: boolean; success: boolean;
  /** Total charge for this child, including earlier recovery attempts; never a delta. */
  chargedRaw: string;
  /** Cumulative refund confirmed by the trusted executor, not a model claim. */
  refundedRaw?: string; reason?: string;
}
export interface AutonomyDecisionRecovery {
  status: "unknown" | "refunded-undelivered"; chargedRaw: string; refundedRaw: string;
  /** Trusted, persisted reconciliation evidence; never supplied by the model. */
  evidence?: { paymentId: string; resolutionId: string; evidenceDigest: string };
}
export interface AutonomyProgress {
  phase:AutonomyState["phase"]; chargedRaw:string; startedTasks:number; completedTasks:number;
  decisionId?:string; decision?:{action:"stop"}|Extract<AutonomyDecision,{action:"run-task"}>; reason?:string;
}
export interface AutonomyDependencies {
  onProgress?(progress:AutonomyProgress):Promise<void>;
  observe(): Promise<AutonomyObservation>;
  /** Invoke the real planner once. The supplied ID must also bind any metering journal. */
  decide(context: AutonomyContext, decisionId: string, limits: AutonomyLimits): Promise<{ decision: unknown; chargedRaw: string; source?:"runtime"|"model" }>;
  /** Read only the original completed planner response; no network dispatch or additional charge. */
  recoverCachedDecision?(context: AutonomyContext, decisionId: string, limits: AutonomyLimits): Promise<{ decision: unknown; chargedRaw: string }>;
  /** Read-only reconciliation of the original planner payment. Must never dispatch or pay. */
  recoverDecision?(context: AutonomyContext, decisionId: string, limits: AutonomyLimits): Promise<AutonomyDecisionRecovery>;
  execute(action: Extract<AutonomyDecision, { action: "run-task" }>, childId: string, limits: AutonomyLimits): Promise<AutonomyOutcome>;
  /** Reconcile/resume this same child; never create a replacement task. */
  recover(childId: string, limits: AutonomyLimits): Promise<AutonomyOutcome>;
  now?: () => number;
}
export interface AutonomyStep {
  decisionId: string; context: AutonomyContext; decisionSource?:"runtime"|"model"; decision?: AutonomyDecision; decisionChargedRaw?: string; decisionRefundedRaw?: string; decisionRecovery?: AutonomyDecisionRecovery;
  childId?: string; childLimits?: AutonomyLimits; outcome?: AutonomyOutcome;
}
export interface AutonomyState {
  version: 1; config: AutonomyConfig; phase: "Ready" | "Deciding" | "Executing" | "Paused" | "Stopped" | "Completed";
  chargedRaw: string; startedTasks: number; completedTasks: number; steps: AutonomyStep[]; reason?: string;
}
const uint = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]{0,77})$/.test(value);
function money(value: unknown): bigint { if (!uint(value)) throw new Error("AUTONOMY_INVALID_AMOUNT"); return BigInt(value); }
function object(value: unknown): value is Record<string, unknown> { return !!value && typeof value === "object" && !Array.isArray(value); }
function exact(value: Record<string, unknown>, keys: string[]) { return Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); }
function configValue(value: AutonomyConfig): AutonomyConfig {
  if (!value || value.version !== 1 || typeof value.sessionId !== "string" || !/^[a-zA-Z0-9_-]{1,128}$/.test(value.sessionId)
    || !Number.isSafeInteger(value.maxTasks) || value.maxTasks < 1 || value.maxTasks > 100
    || !Number.isSafeInteger(value.maxDecisions) || value.maxDecisions < 1 || value.maxDecisions > 1000
    || !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs <= 0
    || !Array.isArray(value.models) || !value.models.length || value.models.length > 8 || value.models.some(model => typeof model !== "string" || !model.length || model.length > 128)
    || new Set(value.models).size !== value.models.length || !Array.isArray(value.funding) || !value.funding.length
    || value.funding.some(funding => !["cash", "credit", "reward-tokens"].includes(funding)) || new Set(value.funding).size !== value.funding.length) throw new Error("AUTONOMY_INVALID_CONFIG");
  money(value.maxSpendRaw); money(value.decisionReserveRaw ?? "0");
  return { version: 1, sessionId: value.sessionId, maxTasks: value.maxTasks, maxSpendRaw: value.maxSpendRaw, deadlineMs: value.deadlineMs,
    maxDecisions: value.maxDecisions, models: [...value.models], funding: [...value.funding], decisionReserveRaw: value.decisionReserveRaw ?? "0" };
}
/** Accept strict JSON only. Model text cannot grant new tools, models, funding sources or budgets. */
export function parseAutonomyDecision(value: unknown, allowed: Pick<AutonomyConfig, "models" | "funding">): AutonomyDecision {
  if (typeof value === "string") {
    let source = value.trim();
    if (source.startsWith("```")) {
      const fence = /^```json\r?\n([\s\S]*?)\r?\n```$/.exec(source);
      if (!fence || fence[1].includes("```")) throw new Error("AUTONOMY_INVALID_DECISION");
      source = fence[1];
    }
    try { value = JSON.parse(source); } catch { throw new Error("AUTONOMY_INVALID_DECISION"); }
  }
  if (object(value) && value.action === "stop" && exact(value, ["action", "reason"]) && typeof value.reason === "string" && value.reason.trim().length > 0 && value.reason.length <= 4096)
    return { action: "stop", reason: value.reason.trim().slice(0, 240) };
  if (object(value) && value.action === "run-task" && exact(value, ["action", "modelId", "funding"]) && typeof value.modelId === "string" && allowed.models.includes(value.modelId)
    && allowed.funding.includes(value.funding as AutonomyFunding)) return { action: "run-task", modelId: value.modelId, funding: value.funding as AutonomyFunding };
  throw new Error("AUTONOMY_INVALID_DECISION");
}
export function createAutonomyDecisionPrompt(context: AutonomyContext): { role: "system" | "user"; content: string }[] {
  return [{ role: "system", content: 'You are the Pi planner for a hosted task agent. Choose whether to run one task or stop using the observed balances, debt, credit, inference allowance and remaining budget. Cash and debt are raw integer currency units. Inference credits are a separate unit. When executionCosts and fundingQuote are supplied, this planning call costs planningCashRaw in CASH BEFORE executing your decision. Use cashAfterPlanningRaw, not the pre-planning cash balance, to choose funding. taskPackagePriceRaw is a separate upfront purchase shared by all listed models; taskPackageCreditsRaw is the purchased inference allowance, not cash. tokenRates consume that allowance at different input/output rates; modelTiers maps each allowed model to its possible solver tiers. funding=cash disables borrowing and requires enough remaining cash for the WHOLE package. funding=credit still spends available cash FIRST and borrows only the package shortfall against escrow-backed task rewards. borrowerFeeRaw is a separate estimated loan fee applied only to borrowed principal, repaid from task settlement; it is neither the planner charge nor the package price nor the token rate. fundingQuote.options already includes the observed cash balance AFTER planning, package price, remaining session budget, per-task spend limit and available principal credit limit. When an allowed option has feasible=true, do not reject it merely because cashAfterPlanningRaw is below the package price: credit combines that cash with fromCreditRaw. Compare only borrowed PRINCIPAL fromCreditRaw with the available principal credit limit; do not compare the entire package price against that credit limit. The borrower fee is repaid from the escrow reward and does not consume the upfront planner/package spending budget; do not add it to those charges or subtract it again from the principal credit limit. taskPackageCreditsRaw and inferenceCreditsAvailable are inference accounting units, never USDC cash or debt. These are conservative affordability estimates, not a guaranteed credit approval: the executor must still select an open task and pass underwriting. Choose only a feasible allowed option or stop. No model choice is mandated. Never assume credit is cash or spendable for games. A run-task action asks the trusted executor to select and independently verify a task. Return ONLY JSON: {"action":"run-task","modelId":"an allowed model","funding":"an allowed funding source"} or {"action":"stop","reason":"brief reason"}. Keep stop reason at most 240 characters. Do not invent tools, budgets, models or funding sources. Stop if another task cannot be justified within these limits.' },
    { role: "user", content: JSON.stringify(context) }];
}
function observationValue(value: AutonomyObservation): AutonomyObservation {
  money(value.cashRaw); money(value.debtRaw); money(value.creditAvailableRaw); money(value.inferenceCreditsAvailable);
  if (value.availableTasks !== undefined && (!Number.isSafeInteger(value.availableTasks) || value.availableTasks < 0)) throw new Error("AUTONOMY_INVALID_OBSERVATION");
  if (value.executionCosts) {
    const costs = value.executionCosts;
    for (const key of ["planningCashRaw", "taskPackagePriceRaw", "taskPackageCreditsRaw", "taskPerRunLimitRaw", "taskCreditLimitRaw", "borrowerFeeBps"] as const) money(costs[key]);
    if (!Array.isArray(costs.modelTiers) || costs.modelTiers.length > 8 || costs.modelTiers.some(model => typeof model.modelId !== "string" || !model.modelId || !Array.isArray(model.tiers) || !model.tiers.length || model.tiers.some(tier => !["cheap", "strong"].includes(tier)))
      || !Array.isArray(costs.tokenRates) || costs.tokenRates.length !== 2 || new Set(costs.tokenRates.map(rate => rate.tier)).size !== 2) throw new Error("AUTONOMY_INVALID_EXECUTION_COSTS");
    for (const rate of costs.tokenRates) { if (!["cheap", "strong"].includes(rate.tier)) throw new Error("AUTONOMY_INVALID_EXECUTION_COSTS"); money(rate.inputMicroCreditsPerToken); money(rate.outputMicroCreditsPerToken); }
  }
  return { cashRaw: value.cashRaw, debtRaw: value.debtRaw, creditAvailableRaw: value.creditAvailableRaw, inferenceCreditsAvailable: value.inferenceCreditsAvailable,
    ...(value.availableTasks === undefined ? {} : { availableTasks: value.availableTasks }), ...(value.executionCosts ? { executionCosts: structuredClone(value.executionCosts) } : {}) };
}

/** Affordability estimates contain no model selection and never replace task underwriting. */
export function quoteAutonomyFunding(observation: AutonomyObservation, remainingSpendRaw: string, allowed: AutonomyFunding[]): AutonomyFundingQuote | undefined {
  const cost = observation.executionCosts; if (!cost) return undefined;
  const planner = money(cost.planningCashRaw), before = money(observation.cashRaw), budget = money(remainingSpendRaw);
  const cash = before > planner ? before - planner : 0n, remaining = budget > planner ? budget - planner : 0n;
  const price = money(cost.taskPackagePriceRaw), cashUsed = cash < price ? cash : price, shortfall = price - cashUsed;
  const credit = money(observation.creditAvailableRaw) < money(cost.taskCreditLimitRaw) ? money(observation.creditAvailableRaw) : money(cost.taskCreditLimitRaw);
  const withinLimits = before >= planner && budget >= planner && remaining >= price && money(cost.taskPerRunLimitRaw) >= price;
  return { cashAfterPlanningRaw: cash.toString(), budgetAfterPlanningRaw: remaining.toString(), options: [
    { funding: "cash", feasible: allowed.includes("cash") && withinLimits && cash >= price, fromCashRaw: price.toString(), fromCreditRaw: "0", borrowerFeeRaw: "0" },
    { funding: "credit", feasible: allowed.includes("credit") && withinLimits && shortfall <= credit, fromCashRaw: cashUsed.toString(), fromCreditRaw: shortfall.toString(), borrowerFeeRaw: (shortfall * money(cost.borrowerFeeBps) / 10000n).toString() },
  ] };
}

/** Durable, single-writer loop. Resume reconciles an existing child, and never redispatches an uncertain planner call. */
export async function runAutonomy(directory: string, config: AutonomyConfig, deps: AutonomyDependencies, recover = false): Promise<AutonomyState> {
  const input = configValue(config), store = new SessionStore<AutonomyState>(directory), now = deps.now ?? Date.now;
  await store.start(recover);
  try {
    let state = await store.read();
    if (state && (state.version !== 1 || JSON.stringify(state.config) !== JSON.stringify(input))) throw new Error("AUTONOMY_CONFIG_MISMATCH");
    if (!state) { state = { version: 1, config: input, phase: "Ready", chargedRaw: "0", startedTasks: 0, completedTasks: 0, steps: [] }; await store.write(state); }
    const current = state;
    const save = async () => { await store.write(current);const step=current.steps.at(-1);await deps.onProgress?.({phase:current.phase,chargedRaw:current.chargedRaw,startedTasks:current.startedTasks,completedTasks:current.completedTasks,...(step?{decisionId:step.decisionId}:{}),...(step?.decision?{decision:step.decision.action==="stop"?{action:"stop" as const}:{...step.decision}}:{}),...(current.reason?{reason:step?.decision?.action==="stop"&&step.decisionSource!=="runtime"?"AUTONOMY_MODEL_STOPPED":current.reason}:{})}); };
    const end = async (phase: AutonomyState["phase"], reason: string) => { current.phase = phase; current.reason = reason; await save(); return current; };
    // Refunds lower the reported net charge, but never reopen this session's spending ceiling.
    const grossSpent = () => money(current.chargedRaw) + current.steps.reduce((sum, step) => sum + money(step.outcome?.refundedRaw ?? "0") + money(step.decisionRefundedRaw ?? "0"), 0n);
    const remaining = () => money(input.maxSpendRaw) - grossSpent();
    async function reconcile(step: AutonomyStep, result: AutonomyOutcome): Promise<boolean> {
      if (typeof result.terminal !== "boolean" || typeof result.success !== "boolean" || (!result.terminal && result.success)) {
        await end("Paused", "AUTONOMY_INVALID_OUTCOME"); return false;
      }
      const total = money(result.chargedRaw), previous = money(step.outcome?.chargedRaw ?? "0");
      const refunded = money(result.refundedRaw ?? "0"), previousRefund = money(step.outcome?.refundedRaw ?? "0"), gross = total + refunded;
      if (gross < previous + previousRefund || refunded < previousRefund) { await end("Paused", "AUTONOMY_CHARGE_REGRESSION"); return false; }
      current.chargedRaw = (money(current.chargedRaw) + total - previous).toString();
      step.outcome = { terminal: result.terminal, success: result.success, chargedRaw: result.chargedRaw, refundedRaw: refunded.toString(), ...(result.reason ? { reason: result.reason.slice(0, 240) } : {}) };
      if (gross > money(step.childLimits!.maxSpendRaw) || remaining() < 0n) { await end("Paused", "AUTONOMY_BUDGET_EXCEEDED"); return false; }
      if (!result.terminal) { await end("Paused", result.reason ?? "AUTONOMY_CHILD_PENDING"); return false; }
      if (!result.success) { await end("Stopped", result.reason ?? "AUTONOMY_CHILD_FAILED"); return false; }
      current.completedTasks++; current.phase = "Ready"; delete current.reason; await save(); return true;
    }
    async function dispatchDecision(step: AutonomyStep): Promise<boolean> {
      if (step.decision!.action === "stop") { await end("Stopped", step.decision!.reason); return false; }
      if (now() >= input.deadlineMs) { await end("Stopped", "AUTONOMY_DEADLINE"); return false; }
      step.childId = randomUUID(); step.childLimits = { maxSpendRaw: remaining().toString(), deadlineMs: input.deadlineMs };
      current.startedTasks++; current.phase = "Executing"; delete current.reason; await save();
      try { return await reconcile(step, await deps.execute(step.decision as Extract<AutonomyDecision, { action: "run-task" }>, step.childId, step.childLimits)); }
      catch { await end("Paused", "AUTONOMY_CHILD_UNKNOWN"); return false; }
    }
    if (recover && current.phase === "Stopped" && current.reason === "AUTONOMY_INVALID_DECISION" && deps.recoverCachedDecision
      && current.steps.length === 1 && current.startedTasks === 0 && current.completedTasks === 0 && !current.steps[0].decision && !current.steps[0].childId) {
      if (now() >= input.deadlineMs) return current;
      const step = current.steps[0];
      try {
        const cached = await deps.recoverCachedDecision(step.context, step.decisionId, { maxSpendRaw: input.decisionReserveRaw!, deadlineMs: input.deadlineMs });
        if (cached.chargedRaw !== step.decisionChargedRaw || cached.chargedRaw !== current.chargedRaw || money(cached.chargedRaw) > money(input.decisionReserveRaw!) || remaining() < 0n) return current;
        step.decision = parseAutonomyDecision(cached.decision, input);
      } catch { return current; }
      if (!await dispatchDecision(step)) return current;
    }
    if (current.phase === "Stopped" || current.phase === "Completed") return current;
    async function reconcileDecision(step: AutonomyStep): Promise<boolean> {
      if (!deps.recoverDecision) { await end("Paused", "AUTONOMY_DECISION_UNKNOWN"); return false; }
      try {
        const result = await deps.recoverDecision(step.context, step.decisionId, { maxSpendRaw: input.decisionReserveRaw!, deadlineMs: input.deadlineMs });
        const charged = money(result.chargedRaw), refunded = money(result.refundedRaw), gross = charged + refunded;
        const previous = money(step.decisionChargedRaw ?? "0"), priorRefund = money(step.decisionRefundedRaw ?? "0");
        if (!["unknown", "refunded-undelivered"].includes(result.status) || gross < previous + priorRefund || refunded < priorRefund) {
          await end("Paused", "AUTONOMY_CHARGE_REGRESSION"); return false;
        }
        current.chargedRaw = (money(current.chargedRaw) + charged - previous).toString();
        step.decisionChargedRaw = charged.toString(); step.decisionRefundedRaw = refunded.toString(); step.decisionRecovery = structuredClone(result);
        if (gross > money(input.decisionReserveRaw!) || remaining() < 0n) { await end("Paused", "AUTONOMY_BUDGET_EXCEEDED"); return false; }
        if (result.status !== "refunded-undelivered" || charged !== 0n || refunded === 0n || !result.evidence) {
          await end("Paused", "AUTONOMY_DECISION_UNKNOWN"); return false;
        }
        current.phase = "Ready"; delete current.reason; await save(); return true;
      } catch { await end("Paused", "AUTONOMY_DECISION_UNKNOWN"); return false; }
    }
    if (current.phase === "Paused" && ["AUTONOMY_BUDGET_EXCEEDED", "AUTONOMY_INVALID_OUTCOME", "AUTONOMY_CHARGE_REGRESSION"].includes(current.reason ?? "")) return current;
    if (current.phase === "Deciding" || current.phase === "Paused" && current.reason === "AUTONOMY_DECISION_UNKNOWN") {
      const step = current.steps.at(-1);
      if (!step || step.decision || !await reconcileDecision(step)) return current;
    }
    const unfinished = current.steps.at(-1);
    if (unfinished?.childId && !unfinished.outcome?.terminal) {
      current.phase = "Executing"; await save();
      try { if (!await reconcile(unfinished, await deps.recover(unfinished.childId, unfinished.childLimits!))) return current; }
      catch { return await end("Paused", "AUTONOMY_CHILD_UNKNOWN"); }
    }
    while (true) {
      if (current.startedTasks >= input.maxTasks) return await end("Completed", "AUTONOMY_TASK_LIMIT");
      if (now() >= input.deadlineMs) return await end("Stopped", "AUTONOMY_DEADLINE");
      if (current.steps.length >= input.maxDecisions) return await end("Stopped", "AUTONOMY_DECISION_LIMIT");
      if (remaining() < money(input.decisionReserveRaw!)) return await end("Stopped", "AUTONOMY_BUDGET_LIMIT");
      let observation: AutonomyObservation;
      try { observation = observationValue(await deps.observe()); } catch { return await end("Paused", "AUTONOMY_OBSERVATION_UNAVAILABLE"); }
      if (now() >= input.deadlineMs) return await end("Stopped", "AUTONOMY_DEADLINE");
      const context: AutonomyContext = { observation, completedTasks: current.completedTasks, startedTasks: current.startedTasks, decisions: current.steps.length,
        remainingTasks: input.maxTasks - current.startedTasks, remainingSpendRaw: remaining().toString(), deadlineMs: input.deadlineMs, models: [...input.models], funding: [...input.funding] };
      const fundingQuote = quoteAutonomyFunding(observation, context.remainingSpendRaw, input.funding);
      if (fundingQuote) context.fundingQuote = fundingQuote;
      const step: AutonomyStep = { decisionId: randomUUID(), context }; current.steps.push(step); current.phase = "Deciding"; delete current.reason; await save();
      let planned: { decision: unknown; chargedRaw: string; source?:"runtime"|"model" };
      try { planned = await deps.decide(context, step.decisionId, { maxSpendRaw: input.decisionReserveRaw!, deadlineMs: input.deadlineMs }); }
      catch { if (!await reconcileDecision(step)) return current; continue; }
      try {
        const charged = money(planned.chargedRaw); current.chargedRaw = (money(current.chargedRaw) + charged).toString(); step.decisionChargedRaw = charged.toString();
        if (charged > money(input.decisionReserveRaw!) || remaining() < 0n) return await end("Paused", "AUTONOMY_BUDGET_EXCEEDED");
      } catch { return await end("Paused", "AUTONOMY_DECISION_UNKNOWN"); }
      try { step.decision = parseAutonomyDecision(planned.decision, input); step.decisionSource=planned.source??"model"; } catch { return await end("Stopped", "AUTONOMY_INVALID_DECISION"); }
      if (!await dispatchDecision(step)) return current;
    }
  } finally { await store.close(); }
}
