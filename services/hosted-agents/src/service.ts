import { validGoal, validateGoalView } from "./goal-types.js";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { open } from "node:fs/promises";
import { Wallet, getAddress, verifyMessage } from "ethers";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { taskPrivateDirectory } from "../../../packages/pi-loop/src/task-runner/config.js";
import { HostedError, type AgentCreation, type AgentSettings, type HostedAgent, type HostedConfig, type HostedExecution, type HostedExecutor, type HostedFinance, type HostedResult, type HostedRun } from "./types.js";
import { validateHostedFinance } from "./finance-projection.js";
import { assertTestSponsorshipActor, loadTestSponsorship, type TestSponsorshipState } from "./test-sponsorship.js";
import { assertBoundedGameActor, assertBoundedGameAdmissions, boundedGameOrigin, loadBoundedGameAuthorization, type BoundedGameAuthorizationState } from "./bounded-game-authorization.js";
import { HOSTED_ACTIVITY_LIMIT, validateHostedActivity, type HostedActivityInput } from "./scene-types.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const amount = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,29})$/.test(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const now = () => new Date().toISOString();
const safeCode = (e: unknown) => { const v = (e as any)?.code ?? (e as any)?.message; return typeof v === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(v) ? v : "HOSTED_EXECUTION_UNCERTAIN"; };
function appendActivity(run: HostedRun, input: HostedActivityInput) {
  const event = validateHostedActivity(input), activities = run.activities ??= [];
  const seq = (activities.at(-1)?.seq ?? 0) + 1;
  if (!Number.isSafeInteger(seq)) fail("HOSTED_ACTIVITY_INVALID", 503);
  activities.push({ ...event, seq, at: now() });
  if (activities.length > HOSTED_ACTIVITY_LIMIT) activities.splice(0, activities.length - HOSTED_ACTIVITY_LIMIT);
}
function runOutcomeActivity(run: HostedRun, result: HostedResult): HostedActivityInput {
  const reason = result.reason, evidence = { chargedRaw: result.chargedRaw, ...(result.refundedRaw !== undefined ? { refundedRaw: result.refundedRaw } : {}),
    ...(result.txHash?{txHash:result.txHash}:{}),...(result.taskId?{taskId:result.taskId}:{}),...(result.paymentId?{paymentId:result.paymentId}:{}),...(result.matchId?{matchId:result.matchId}:{}) };
  if (reason === "HOSTED_AGENT_PAUSED") return {scene:"interruption",state:"paused",reason,requiredAction:"resume",evidence};
  if (reason === "AUTONOMY_PLANNER_CASH_REQUIRED") return {scene:"funding",state:"blocked",reason,requiredAction:"deposit",evidence};
  if (reason === "AUTONOMY_TASK_BUDGET_REQUIRED"||reason === "HOSTED_GOAL_BUDGET_REQUIRED") return {scene:"funding",state:"blocked",reason,requiredAction:"configure",evidence};
  if (reason === "HOSTED_GOAL_NEEDS_INPUT") return {scene:"decision",state:"blocked",reason,requiredAction:"provide-input",evidence};
  if (reason === "AUTONOMY_GAME_LIMIT" && !result.terminal) return {scene:"funding",state:"blocked",reason,requiredAction:"play-game",evidence};
  if (reason === "INFERENCE_FUNDING_REQUIRED") return {scene:"funding",state:"blocked",reason,requiredAction:run.action === "reward-task"?"play-game":"deposit",evidence};
  if (["CASH_REQUIRED","HOSTED_AGENT_FUNDS_REQUIRED"].includes(reason??"")) return {scene:"funding",state:"blocked",reason,requiredAction:"deposit",evidence};
  if (["UNDERWRITER_REQUIRED","AUTHORIZATION_REJECTED","AUTHORIZATION_MISMATCH"].includes(reason??"")) return {scene:"credit",state:"blocked",reason,evidence};
  if (["ALLOWANCE_PRICE_LIMIT","HOSTED_TASK_BUDGET_INVALID","HOSTED_TASK_BUDGET_EXCEEDED"].includes(reason??"")) return {scene:"funding",state:"blocked",reason,requiredAction:"configure",evidence};
  if (reason === "HOSTED_WALLET_GAS_REQUIRED") return {scene:"funding",state:"blocked",reason,requiredAction:"fund-gas",evidence};
  if (!result.terminal) return { scene: "interruption", state: /RECONCIL|UNCERTAIN|UNKNOWN|UNCONFIRMED|INTERRUPTED|PENDING/.test(reason ?? "") ? "reconciling" : "paused", ...(reason ? { reason } : {}), evidence };
  if (result.settlement) { const s=result.settlement; return {scene:"settlement",state:"confirmed",evidence:{...evidence,txHash:s.txHash,blockNumber:s.block.number,blockHash:s.block.hash,passed:s.passed,repaidRaw:s.repaidRaw,slashedRaw:s.slashedRaw,residualRaw:s.residualRaw}}; }
  if (run.action === "provision" && result.success) return {scene:"onboarding",state:result.binding?"confirmed":"completed",...(result.binding?{evidence:{...evidence,chainId:result.binding.chainId,agentId:result.binding.agentId}}:{evidence})};
  if (run.action === "deposit" && result.success) return {scene:"funding",state:"confirmed",evidence:{...evidence,...(run.amountRaw?{amountRaw:run.amountRaw}:{}),...(result.cashRaw?{cashRaw:result.cashRaw}:{})}};
  if (run.action === "game" && result.success) {
    const rewarded=BigInt(result.rewardRaw??"0")>0n||Number(result.creditsGranted??0)>0;
    const outcome=run.activities?.slice().reverse().find(event=>event.scene==="game"&&event.evidence?.matchId===result.matchId&&event.evidence?.outcome!==undefined&&event.evidence?.outcome!=="no-reward")?.evidence?.outcome;
    return {scene:rewarded?"settlement":"game",state:rewarded?"confirmed":"completed",evidence:{...evidence,...(result.rewardRaw!==undefined?{rewardRaw:result.rewardRaw}:{}),...(result.creditsGranted!==undefined?{creditsGranted:result.creditsGranted}:{}),...(outcome?{outcome}:!rewarded?{outcome:"no-reward" as const}:{})}};
  }
  if (run.action === "credits") return {scene:"model",state:result.success?"completed":"failed",...(reason?{reason}:{}),evidence:{...evidence,...(result.creditsUsed!==undefined?{creditsUsed:result.creditsUsed}:{})}};
  if (reason === "HOSTED_GOAL_REVIEW_FAILED") return {scene:"review",state:"failed",reason,evidence:{...evidence,passed:false}};
  return { scene: result.phase === "Cancelled" || /CANCELLED|PAYMENT_VOIDED/.test(reason ?? "") ? "interruption" : "delivery",
    state: result.success ? "completed" : result.phase === "Cancelled" || reason === "HOSTED_GOAL_CANCELLED" ? "cancelled" : result.phase === "Refunded" ? "refunded" : "failed", ...(reason ? { reason } : {}), evidence };
}
function fail(code: string, status = 400): never { throw new HostedError(code, status); }
function object(v: unknown, fields: string[]): asserts v is Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) fail("HOSTED_INPUT_INVALID");
}
function id(v: unknown): asserts v is string { if (typeof v !== "string" || !uuid.test(v)) fail("HOSTED_REQUEST_ID_INVALID"); }
function owner(v: string) { try { return getAddress(v); } catch { return fail("HOSTED_WALLET_INVALID"); } }
interface Challenge { id: string; wallet: string; message: string; expiresAt: number }
interface Session { digest: string; owner: string; expiresAt: number }
interface Creation { owner: string; requestId: string; agentId: string; digest: string }
interface State { version: 1; configBinding: string; challenges: Challenge[]; sessions: Session[]; agents: HostedAgent[]; runs: HostedRun[]; creations: Creation[]; sponsoredOwners: Record<string, number>; sponsoredTotal: number;
  testSponsorship?: TestSponsorshipState;
  boundedGames?: BoundedGameAuthorizationState;
  fundingRoutes?: Record<string, { parentRequestId: string; childId: string; modelId: string }>;
  autonomousGameAdmissions?: Record<string, { parentRequestId: string; agentId: string; rewardKind?: "usdc" | "llm-credits" }> }
export interface HostedServiceOptions {
  recover?: boolean;
  /** Host-only read-only resolution of an original paused autonomous child. Browser input cannot select it. */
  autonomyFunding?(input: HostedExecution): Promise<{ childId: string; modelId: string; funding: "cash" | "reward-tokens" } | undefined>;
}
export interface HostedCommand { action: "provision" | "deposit" | "task" | "game" | "credits" | "reward-task" | "metered-task" | "autonomous" | "goal"; goal?: string; requestId: string; rewardKind?: "usdc" | "llm-credits"; amountRaw?: string }

export function validateHostedConfig(value: unknown): HostedConfig {
  object(value, ["directory", "origin", "chainId", "models", "maxAgentsPerOwner", "maxTotalBudgetRaw", "maxPerRunBudgetRaw", "testSponsorshipFile", "boundedGamesFile", "boundedGamesSealed"]);
  const config = value as HostedConfig;
  if (!Array.isArray(config.models)) fail("HOSTED_CONFIG_INVALID", 503);
  for (const model of config.models) object(model, ["id", "label"]);
    const origin = new URL(config.origin);
    if (origin.origin !== config.origin || (origin.protocol !== "https:" && !(origin.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) ||
      !["31337", "10143", "42431"].includes(config.chainId) || !Number.isSafeInteger(config.maxAgentsPerOwner) || config.maxAgentsPerOwner < 1 || config.maxAgentsPerOwner > 20 ||
      !amount(config.maxTotalBudgetRaw) || !amount(config.maxPerRunBudgetRaw) || BigInt(config.maxTotalBudgetRaw) < 1n || BigInt(config.maxPerRunBudgetRaw) < 1n ||
      !Array.isArray(config.models) || !config.models.length || config.models.length > 8 || new Set(config.models.map(m => m.id)).size !== config.models.length ||
      config.models.some(m => !/^[a-zA-Z0-9._-]{1,64}$/.test(m.id) || typeof m.label !== "string" || !m.label || m.label.length > 80) || resolve(config.directory) !== config.directory) fail("HOSTED_CONFIG_INVALID", 503);
  if (config.testSponsorshipFile !== undefined && (typeof config.testSponsorshipFile !== "string" || resolve(config.testSponsorshipFile) !== config.testSponsorshipFile
    || config.chainId !== "42431" || origin.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname))) fail("HOSTED_TEST_SPONSOR_INVALID", 503);
  if (config.boundedGamesFile !== undefined && (typeof config.boundedGamesFile !== "string" || resolve(config.boundedGamesFile) !== config.boundedGamesFile
    || config.chainId !== "42431" || !boundedGameOrigin(config.origin))) fail("HOSTED_BOUNDED_GAMES_INVALID", 503);
  if (config.boundedGamesSealed !== undefined && (config.boundedGamesSealed !== true || !config.boundedGamesFile)) fail("HOSTED_BOUNDED_GAMES_INVALID", 503);
  return structuredClone(config);
}

/** One daemon owns the private local database; async jobs use serial durable admission. */
export class HostedService {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Set<Promise<void>>();
  private financeReads = new Map<string, Promise<HostedFinance>>();
  private closed = false;
  private constructor(readonly config: HostedConfig, private executor: HostedExecutor, private store: SessionStore<State>, private state: State, private sponsorshipStore?: SessionStore<TestSponsorshipState>, private boundedGameStore?: SessionStore<BoundedGameAuthorizationState>, private options: HostedServiceOptions = {}) {}
  static async open(config: HostedConfig, executor: HostedExecutor, options: HostedServiceOptions = {}) {
    config = validateHostedConfig(config);
    await taskPrivateDirectory(config.directory);
    const store = new SessionStore<State>(join(config.directory, "database")); await store.start(options.recover); let sponsorshipStore: SessionStore<TestSponsorshipState> | undefined, boundedGameStore: SessionStore<BoundedGameAuthorizationState> | undefined;
    try {
      const binding = hash(JSON.stringify({ origin: config.origin, chainId: config.chainId }));
      const state = await store.read() ?? { version: 1, configBinding: binding, challenges: [], sessions: [], agents: [], runs: [], creations: [], sponsoredOwners: {}, sponsoredTotal: 0 };
      if (state.version !== 1 || state.configBinding !== binding) fail("HOSTED_CONFIG_BINDING_CHANGED", 503);
      if (config.testSponsorshipFile) {
        const authorization = await loadTestSponsorship(config.testSponsorshipFile, config);
        if (state.testSponsorship) {
          if (state.testSponsorship.digest !== authorization.digest || JSON.stringify(state.testSponsorship.grant) !== JSON.stringify(authorization.grant)) fail("HOSTED_TEST_SPONSOR_BINDING_CHANGED", 503);
        } else {
          if (authorization.grant.expiresAtMs <= Date.now() || (state.sponsoredOwners[authorization.grant.owner] ?? 0) !== authorization.grant.baselineGames) fail("HOSTED_TEST_SPONSOR_BASELINE_CHANGED", 503);
          for (const actor of authorization.grant.actors) { const agent = state.agents.find(agent => agent.id === actor.hostedAgentId); if (!agent) fail("HOSTED_TEST_SPONSOR_INVALID", 503); assertTestSponsorshipActor(authorization.grant, agent); }
          state.testSponsorship = { ...authorization, admissions: [] };
        }
        sponsorshipStore = new SessionStore(join(dirname(config.testSponsorshipFile), "admissions")); await sponsorshipStore.start(options.recover);
      }
      if (config.boundedGamesFile) {
        const authorization = await loadBoundedGameAuthorization(config.boundedGamesFile, config);
        if (state.boundedGames) {
          if (state.boundedGames.digest !== authorization.digest || JSON.stringify(state.boundedGames.grant) !== JSON.stringify(authorization.grant)) fail("HOSTED_BOUNDED_GAMES_BINDING_CHANGED", 503);
        } else {
          if (authorization.grant.expiresAtMs <= Date.now() || (state.sponsoredOwners[authorization.grant.owner] ?? 0) !== authorization.grant.baselineOwnerGames
            || state.sponsoredTotal !== authorization.grant.baselineTotalGames) fail("HOSTED_BOUNDED_GAMES_BASELINE_CHANGED", 503);
          if (authorization.grant.id === state.testSponsorship?.grant.id || state.runs.some(run => run.requestId === authorization.grant.parentRequestId)
            || state.creations.some(creation => creation.requestId === authorization.grant.parentRequestId) || state.autonomousGameAdmissions?.[authorization.grant.parentRequestId]) fail("HOSTED_BOUNDED_GAMES_BINDING_CHANGED", 503);
          const actor = state.agents.find(agent => agent.id === authorization.grant.actor.hostedAgentId);
          if (!actor) fail("HOSTED_BOUNDED_GAMES_INVALID", 503);
          assertBoundedGameActor(authorization.grant, actor);
          state.boundedGames = { ...authorization, admissions: [] };
        }
        assertBoundedGameAdmissions(state.boundedGames);
        const bounded = state.boundedGames;
        if ((state.sponsoredOwners[bounded.grant.owner] ?? 0) < bounded.grant.baselineOwnerGames + bounded.admissions.length
          || state.sponsoredTotal < bounded.grant.baselineTotalGames + bounded.admissions.length || state.sponsoredTotal > 100) fail("HOSTED_BOUNDED_GAMES_BASELINE_CHANGED", 503);
        for (const row of bounded.admissions) {
          const admission = state.autonomousGameAdmissions?.[row.childRequestId], parent = state.runs.find(run => run.requestId === row.parentRequestId);
          if (!admission || admission.parentRequestId !== row.parentRequestId || admission.agentId !== row.agentId || admission.rewardKind !== row.rewardKind
            || !parent || parent.action !== "autonomous" || parent.agentId !== row.agentId) fail("HOSTED_BOUNDED_GAMES_BINDING_CHANGED", 503);
        }
        boundedGameStore = new SessionStore(join(dirname(config.boundedGamesFile), "bounded-admissions")); await boundedGameStore.start(options.recover);
      }
      for (const run of state.runs) if (["Queued", "Running"].includes(run.status)) { run.status = "Paused"; run.recoverable = true; run.reason = "HOSTED_PROCESS_INTERRUPTED"; run.updatedAt = now(); appendActivity(run, { scene: "interruption", state: "reconciling", reason: "HOSTED_PROCESS_INTERRUPTED", requiredAction: "reconcile" }); }
      await store.write(state);
      const service = new HostedService(structuredClone(config), executor, store, state, sponsorshipStore, boundedGameStore, options); await service.syncSponsorship(); await service.syncBoundedGames(); return service;
    } catch (e) { await boundedGameStore?.close(); await sponsorshipStore?.close(); await store.close(); throw e; }
  }
  private serial<T>(fn: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new HostedError("HOSTED_SERVICE_CLOSED", 503));
    const operation = this.queue.then(fn); this.queue = operation.catch(() => undefined); return operation;
  }
  private save() { return this.store.write(this.state); }
  private async syncSponsorship() {
    if (!this.sponsorshipStore) return;
    const primary = this.state.testSponsorship!, audit = await this.sponsorshipStore.read();
    if (audit && (audit.digest !== primary.digest || JSON.stringify(audit.grant) !== JSON.stringify(primary.grant)
      || audit.admissions.length > primary.admissions.length || audit.admissions.some((row, index) => JSON.stringify(row) !== JSON.stringify(primary.admissions[index])))) fail("HOSTED_TEST_SPONSOR_AUDIT_CONFLICT", 503);
    // The database commits run + owner counter + authorization admission atomically.
    // Its independent audit mirror must fsync before any executor can start.
    await this.sponsorshipStore.write(primary);
  }
  private async syncBoundedGames() {
    if (!this.boundedGameStore) return;
    const primary = this.state.boundedGames!, audit = await this.boundedGameStore.read();
    if (audit && (audit.digest !== primary.digest || JSON.stringify(audit.grant) !== JSON.stringify(primary.grant) || !Array.isArray(audit.admissions)
      || audit.admissions.length > primary.admissions.length || audit.admissions.some((row, index) => JSON.stringify(row) !== JSON.stringify(primary.admissions[index])))) fail("HOSTED_BOUNDED_GAMES_AUDIT_CONFLICT", 503);
    // The main database is authoritative. Mirror fsync precedes every dispatch,
    // including retries after an interrupted database-before-mirror admission.
    await this.boundedGameStore.write(primary);
  }
  gameDeadline(input: HostedExecution) {
    const bounded = this.state.boundedGames, row = bounded?.admissions.find(row => row.childRequestId === input.run.requestId);
    if (row) {
      const admission = this.state.autonomousGameAdmissions?.[row.childRequestId];
      if (!this.boundedGameStore || input.run.action !== "game" || input.run.rewardKind !== "llm-credits" || input.run.agentId !== row.agentId
        || !admission || admission.parentRequestId !== row.parentRequestId || admission.agentId !== row.agentId || admission.rewardKind !== row.rewardKind) fail("HOSTED_BOUNDED_GAMES_BINDING_CHANGED", 503);
      assertBoundedGameActor(bounded!.grant, input.agent);
      return Math.min(bounded!.grant.expiresAtMs, input.deadlineMs ?? Infinity);
    }
    const tag = input.run.testSponsorship; if (!tag) return undefined;
    const state = this.state.testSponsorship, admission = state?.admissions.find(row => row.requestId === input.run.requestId);
    if (!state || !admission || !this.sponsorshipStore || tag.grantId !== state.grant.id || tag.digest !== state.digest || admission.ordinal !== tag.ordinal || admission.agentId !== input.agent.id) fail("HOSTED_TEST_SPONSOR_BINDING_CHANGED", 503);
    return state.grant.expiresAtMs;
  }
  private agent(who: string, agentId: string) {
    id(agentId); const found = this.state.agents.find(a => a.id === agentId && a.owner === owner(who));
    if (!found) fail("HOSTED_AGENT_NOT_FOUND", 404); return found;
  }
  private settings(input: unknown): AgentSettings {
    object(input, ["name", "modelId", "strategy", "perRunBudgetRaw", "totalBudgetRaw", "allowCredit"]);
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f\x7f]/.test(input.name) ||
      !this.config.models.some(m => m.id === input.modelId) || !["conservative", "balanced", "aggressive"].includes(input.strategy) || typeof input.allowCredit !== "boolean" ||
      !amount(input.perRunBudgetRaw) || !amount(input.totalBudgetRaw) || BigInt(input.perRunBudgetRaw) < 1n || BigInt(input.perRunBudgetRaw) > BigInt(this.config.maxPerRunBudgetRaw) ||
      BigInt(input.totalBudgetRaw) < BigInt(input.perRunBudgetRaw) || BigInt(input.totalBudgetRaw) > BigInt(this.config.maxTotalBudgetRaw)) fail("HOSTED_SETTINGS_INVALID");
    return { name: input.name.trim(), modelId: input.modelId, strategy: input.strategy, perRunBudgetRaw: input.perRunBudgetRaw, totalBudgetRaw: input.totalBudgetRaw, allowCredit: input.allowCredit };
  }
  challenge(wallet: string) { return this.serial(async () => {
    const address = owner(wallet), t = Date.now(), challengeId = randomUUID();
    this.state.challenges = this.state.challenges.filter(c => c.expiresAt > t);
    if (this.state.challenges.length >= 1000 || this.state.challenges.filter(c => c.wallet === address).length >= 5) fail("HOSTED_AUTH_RATE_LIMIT", 429);
    const expiresAt = t + 5 * 60_000;
    const message = `AgentFuel hosted agent login\nOrigin: ${this.config.origin}\nWallet: ${address}\nChain: ${this.config.chainId}\nNonce: ${challengeId}\nExpires: ${new Date(expiresAt).toISOString()}\nThis signature authenticates your platform account. It authorizes no blockchain transaction.`;
    this.state.challenges.push({ id: challengeId, wallet: address, message, expiresAt }); await this.save();
    return { id: challengeId, message, expiresAt };
  }); }
  login(challengeId: string, signature: string) { return this.serial(async () => {
    id(challengeId); const c = this.state.challenges.find(c => c.id === challengeId);
    if (!c || c.expiresAt <= Date.now() || typeof signature !== "string" || signature.length > 200) fail("HOSTED_AUTH_INVALID", 401);
    let signed: string; try { signed = verifyMessage(c.message, signature); } catch { return fail("HOSTED_AUTH_INVALID", 401); }
    if (signed !== c.wallet) fail("HOSTED_AUTH_INVALID", 401);
    const token = randomBytes(32).toString("hex"), expiresAt = Date.now() + 24 * 60 * 60_000;
    this.state.challenges = this.state.challenges.filter(v => v.id !== challengeId);
    this.state.sessions = this.state.sessions.filter(s => s.expiresAt > Date.now());
    if (this.state.sessions.length >= 10000) fail("HOSTED_SESSION_LIMIT", 503);
    this.state.sessions.push({ digest: hash(token), owner: c.wallet, expiresAt }); await this.save(); return { token, expiresAt };
  }); }
  authenticate(token: string): Promise<string> { return this.serial(async () => {
    if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) fail("HOSTED_AUTH_REQUIRED", 401);
    const s = this.state.sessions.find(s => s.digest === hash(token) && s.expiresAt > Date.now());
    if (!s) fail("HOSTED_AUTH_REQUIRED", 401); return s.owner;
  }); }
  logout(token: string) { return this.serial(async () => { this.state.sessions = this.state.sessions.filter(s => s.digest !== hash(token)); await this.save(); }); }
  async finance(who: string, agentId: string): Promise<HostedFinance> {
    const agent = await this.serial(async () => structuredClone(this.agent(who, agentId)));
    const key = `${agent.id}:${agent.binding?.agentId ?? "unbound"}:${agent.wallet}`;
    const pending = this.financeReads.get(key); if (pending) return structuredClone(await pending);
    const operation = (async (): Promise<HostedFinance> => {
      try {
        if (!this.executor.finance) return { status: "unavailable", observedAt: now(), reason: "HOSTED_FINANCE_NOT_CONFIGURED" };
        return validateHostedFinance(await this.executor.finance(agent), agent, this.config.chainId);
      } catch { return { status: "unavailable", observedAt: now(), reason: "HOSTED_FINANCE_UNCONFIRMED" }; }
    })();
    this.financeReads.set(key, operation);
    try { return structuredClone(await operation); } finally { this.financeReads.delete(key); }
  }
  mayContinue(agentId: string) { return this.serial(async () => this.state.agents.some(agent => agent.id === agentId && agent.status === "Ready")); }
  /** Daemon-only durable admission. There is deliberately no HTTP command for selecting a child ID. */
  admitAutonomyGame(parentRequestId: string, childRequestId: string, agentId: string, rewardKind?: "usdc" | "llm-credits") { return this.serial(async () => {
    id(parentRequestId); id(childRequestId); id(agentId);
    const agent = this.state.agents.find(agent => agent.id === agentId), parent = this.state.runs.find(run => run.requestId === parentRequestId);
    if (!agent || !parent || parent.action !== "autonomous" || parent.agentId !== agentId || agent.activeRequestId !== parentRequestId
      || !["Queued", "Running"].includes(parent.status) || childRequestId === parentRequestId || this.state.runs.some(run => run.requestId === childRequestId)
      || this.state.creations.some(creation => creation.requestId === childRequestId)) fail("HOSTED_AUTONOMY_GAME_ADMISSION_INVALID", 409);
    const prior = this.state.autonomousGameAdmissions?.[childRequestId];
    if (prior) {
      if (prior.parentRequestId !== parentRequestId || prior.agentId !== agentId || prior.rewardKind !== undefined && prior.rewardKind !== rewardKind) fail("HOSTED_AUTONOMY_GAME_ADMISSION_INVALID", 409);
      const row = this.state.boundedGames?.admissions.find(row => row.childRequestId === childRequestId);
      if (row) {
        if (!this.boundedGameStore || row.parentRequestId !== parentRequestId || row.agentId !== agentId || rewardKind !== "llm-credits") fail("HOSTED_AUTONOMY_GAME_ADMISSION_INVALID", 409);
        try { assertBoundedGameActor(this.state.boundedGames!.grant, agent); } catch { fail("HOSTED_AUTONOMY_GAME_ADMISSION_INVALID", 409); }
        await this.syncBoundedGames();
      }
      return;
    }
    if (agent.status === "Paused") fail("HOSTED_AGENT_PAUSED", 409);
    const bounded = this.state.boundedGames?.grant.owner === agent.owner ? this.state.boundedGames : undefined;
    if (bounded) {
      if (!this.boundedGameStore || rewardKind !== "llm-credits" || parentRequestId !== bounded.grant.parentRequestId) fail("HOSTED_AUTONOMY_GAME_ADMISSION_INVALID", 409);
      try { assertBoundedGameActor(bounded.grant, agent); } catch { fail("HOSTED_AUTONOMY_GAME_ADMISSION_INVALID", 409); }
      if (this.config.boundedGamesSealed || Date.now() >= bounded.grant.expiresAtMs || bounded.admissions.length >= bounded.grant.maxAdditionalGames) fail("HOSTED_SPONSOR_LIMIT", 409);
    } else if ((this.state.sponsoredOwners[agent.owner] ?? 0) >= 3) fail("HOSTED_SPONSOR_LIMIT", 409);
    if (this.state.sponsoredTotal >= 100) fail("HOSTED_SPONSOR_LIMIT", 409);
    const ownerBefore = this.state.sponsoredOwners[agent.owner] ?? 0, totalBefore = this.state.sponsoredTotal;
    this.state.sponsoredOwners[agent.owner] = ownerBefore + 1; this.state.sponsoredTotal++;
    (this.state.autonomousGameAdmissions ??= {})[childRequestId] = { parentRequestId, agentId, ...(rewardKind ? { rewardKind } : {}) };
    if (bounded) bounded.admissions.push({ parentRequestId, childRequestId, agentId, ordinal: bounded.admissions.length + 1, admittedAt: now(), rewardKind: "llm-credits" });
    try { await this.save(); } catch (error) {
      this.state.sponsoredOwners[agent.owner] = ownerBefore; this.state.sponsoredTotal = totalBefore; delete this.state.autonomousGameAdmissions[childRequestId];
      if (bounded) bounded.admissions.pop();
      this.state = await this.store.read() ?? this.state;
      throw error;
    }
    if (bounded) await this.syncBoundedGames();
  }); }
  snapshot(who: string) { return this.serial(async () => {
    const address = owner(who), agents = this.state.agents.filter(a => a.owner === address), ids = new Set(agents.map(a => a.id));
    const activeRequestIds = new Set(agents.map(a => a.activeRequestId));
    const ownedRuns = this.state.runs.map((run, index) => ({ run, index })).filter(({ run }) => ids.has(run.agentId))
      .sort((a, b) => b.run.updatedAt.localeCompare(a.run.updatedAt) || b.index - a.index);
    // Keep unfinished requests reachable, and a recovered result in the latest updated history.
    const runs = ownedRuns.filter(({ run }, index) => index < 100 || activeRequestIds.has(run.requestId) || !["Succeeded", "Failed"].includes(run.status)).map(({ run }) => run);
    const extension = this.config.testSponsorshipFile && this.state.testSponsorship?.grant.owner === address ? this.state.testSponsorship : undefined;
    const active = !!extension && extension.grant.expiresAtMs > Date.now(), used = this.state.sponsoredOwners[address] ?? 0, limit = active ? extension!.grant.baselineGames + extension!.grant.maxAdditionalGames : 3;
    const sponsorship = { used, limit, remaining: Math.max(0, Math.min(limit - used, 100 - this.state.sponsoredTotal)), globalLimit: 100,
      ...(extension ? { testAuthorization: { id: extension.grant.id, maxTotalGames: 9, expiresAt: new Date(extension.grant.expiresAtMs).toISOString(), active, additionalUsed: extension.admissions.length,
        actorRewards: extension.grant.actors.map(({ hostedAgentId, rewardKind }) => ({ hostedAgentId, rewardKind })) } } : {}) };
    return structuredClone({ agents, runs, models: this.config.models, sponsorship, ...(this.executor.capabilities ? { capabilities: this.executor.capabilities } : {}) });
  }); }
  async create(who: string, input: AgentCreation & { requestId: string }) {
    const agent = await this.serial(async () => {
      object(input, ["requestId", "name", "modelId", "strategy", "perRunBudgetRaw", "totalBudgetRaw", "allowCredit"]); id(input.requestId);
      const { requestId, ...rest } = input;
      const deferred = Object.keys(rest).length === 1 && "name" in rest;
      if (deferred && (typeof rest.name !== "string" || !rest.name.trim() || rest.name.length > 80 || /[\x00-\x1f\x7f]/.test(rest.name))) fail("HOSTED_SETTINGS_INVALID");
      const settings: AgentSettings = deferred
        ? { name: rest.name.trim(), modelId: "", strategy: "balanced", perRunBudgetRaw: "0", totalBudgetRaw: "0", allowCredit: false }
        : this.settings(rest);
      const address = owner(who), digest = hash(JSON.stringify(deferred ? { name: settings.name } : settings));
      const previous = this.state.creations.find(c => c.owner === address && c.requestId === requestId);
      if (previous) { if (previous.digest !== digest) fail("HOSTED_REQUEST_CONFLICT", 409); return structuredClone(this.agent(address, previous.agentId)); }
      if (this.state.creations.some(c => c.requestId === requestId) || this.state.runs.some(r => r.requestId === requestId) || this.state.autonomousGameAdmissions?.[requestId]) fail("HOSTED_REQUEST_CONFLICT", 409);
      if (this.state.agents.filter(a => a.owner === address).length >= this.config.maxAgentsPerOwner || this.state.agents.length >= 1000) fail("HOSTED_AGENT_LIMIT", 409);
      const agentId = randomUUID(), directory = join(this.config.directory, "agents", agentId); await taskPrivateDirectory(directory);
      const wallet = Wallet.createRandom(); const file = await open(join(directory, "wallet.key"), "wx", 0o600);
      try { await file.writeFile(wallet.privateKey + "\n"); await file.sync(); } finally { await file.close(); }
      const created: HostedAgent = { ...settings, ...(deferred ? { configurationRequired: true } : {}), id: agentId, owner: address, wallet: wallet.address, createdAt: now(), updatedAt: now(), status: "Pending", spentRaw: "0", reservedRaw: "0" };
      this.state.agents.push(created); this.state.creations.push({ owner: address, requestId, agentId, digest }); await this.save(); return structuredClone(created);
    });
    // A retry of creation addresses the same provisioning request; it never regenerates a wallet.
    await this.command(who, agent.id, { action: "provision", requestId: input.requestId });
    return this.serial(async () => structuredClone(this.agent(who, agent.id)));
  }
  update(who: string, agentId: string, input: AgentSettings) { return this.serial(async () => {
    const a = this.agent(who, agentId), settings = this.settings(input);
    if (a.activeRequestId) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED", 409);
    if (BigInt(settings.totalBudgetRaw) < BigInt(a.spentRaw)) fail("HOSTED_BUDGET_BELOW_SPENT", 409);
    Object.assign(a, settings, { updatedAt: now() }, a.configurationRequired ? { configurationRequired: false } : {}); await this.save(); return structuredClone(a);
  }); }
  pause(who: string, agentId: string, paused: boolean) { return this.serial(async () => {
    if (typeof paused !== "boolean") fail("HOSTED_INPUT_INVALID"); const a = this.agent(who, agentId);
    a.status = paused ? "Paused" : a.binding ? "Ready" : "Pending"; a.updatedAt = now();
    const active = this.state.runs.find(run => run.requestId === a.activeRequestId && run.agentId === a.id);
    if (active && paused) appendActivity(active, { scene: "interruption", state: "stopping", reason: "HOSTED_AGENT_PAUSED" });
    await this.save(); return structuredClone(a);
  }); }
  command(who: string, agentId: string, input: HostedCommand) { return this.serial(async () => {
    object(input, ["action", "requestId", "rewardKind", "amountRaw", "goal"]); id(input.requestId);
    if (!["provision", "deposit", "task", "game", "credits", "reward-task", "metered-task", "autonomous", "goal"].includes(input.action) || (input.action === "game" ? !["usdc", "llm-credits"].includes(input.rewardKind as string) : input.rewardKind !== undefined)) fail("HOSTED_COMMAND_INVALID");
    if (input.action === "deposit" ? !amount(input.amountRaw) || BigInt(input.amountRaw) < 1n || BigInt(input.amountRaw) > BigInt(this.config.maxTotalBudgetRaw) : input.amountRaw !== undefined) fail("HOSTED_DEPOSIT_AMOUNT_INVALID");
    if (input.action === "goal" ? !validGoal(input.goal) : input.goal !== undefined) fail("HOSTED_GOAL_INVALID");
    const a = this.agent(who, agentId), creation = this.state.creations.find(c => c.requestId === input.requestId);
    if (creation && (creation.agentId !== a.id || input.action !== "provision")) fail("HOSTED_REQUEST_CONFLICT", 409);
    if (this.state.autonomousGameAdmissions?.[input.requestId]) fail("HOSTED_REQUEST_CONFLICT", 409);
    const previous = this.state.runs.find(r => r.requestId === input.requestId);
    if (previous) {
      if (previous.agentId !== a.id || previous.action !== input.action || previous.rewardKind !== input.rewardKind || previous.amountRaw !== input.amountRaw || previous.goal !== input.goal) fail("HOSTED_REQUEST_CONFLICT", 409);
      if (previous.status === "Failed" && previous.action === "autonomous" && previous.reason === "AUTONOMY_INVALID_DECISION") {
        if (previous.terminalRecovery || !previous.result?.terminal || previous.result.success || previous.result.reason !== previous.reason
          || previous.result.chargedRaw !== previous.chargedRaw || previous.result.autonomousTasks !== 0 || BigInt(previous.chargedRaw) <= 0n
          || previous.fundingFor || a.status !== "Ready" || !a.binding || a.activeRequestId || a.reservedRaw !== "0"
          || this.state.runs.some(run => run.agentId === a.id && run.requestId !== previous.requestId && !["Failed", "Succeeded"].includes(run.status))) fail("HOSTED_CACHED_DECISION_RECOVERY_UNAVAILABLE", 409);
        const rebasedSpent = BigInt(a.spentRaw) - BigInt(previous.chargedRaw);
        if (rebasedSpent < 0n || rebasedSpent + BigInt(previous.reservedRaw) > BigInt(a.totalBudgetRaw)) fail("HOSTED_BUDGET_EXHAUSTED", 409);
        const directory = join(this.config.directory, "agents", a.id, "runs", previous.requestId);
        if (!this.executor.canRecoverTerminal || !await this.executor.canRecoverTerminal({ agent: structuredClone(a), run: structuredClone(previous), directory,
          keyFile: join(this.config.directory, "agents", a.id, "wallet.key"), recover: true })) fail("HOSTED_CACHED_DECISION_RECOVERY_UNAVAILABLE", 409);
        const beforeAgent = structuredClone(a), beforeRun = structuredClone(previous);
        previous.terminalRecovery = { kind: "cached-planner", at: now(), rebasedChargedRaw: previous.chargedRaw, previousReason: previous.reason, previousResult: structuredClone(previous.result) };
        a.spentRaw = rebasedSpent.toString(); a.reservedRaw = previous.reservedRaw; a.activeRequestId = previous.requestId; a.updatedAt = now();
        previous.status = "Queued"; previous.recoverable = false; delete previous.reason; delete previous.result; previous.updatedAt = now();
        try { await this.save(); } catch (error) {
          for (const key of Object.keys(a)) delete (a as any)[key]; Object.assign(a, beforeAgent);
          for (const key of Object.keys(previous)) delete (previous as any)[key]; Object.assign(previous, beforeRun); throw error;
        }
        appendActivity(previous, { scene: "idle", state: "queued", reason: "HOSTED_CACHED_DECISION_RECOVERY" }); await this.save();
        this.launch(a, previous, true); return structuredClone(previous);
      }
      if (previous.status !== "Paused") return structuredClone(previous);
      if (a.activeRequestId !== previous.requestId) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED", 409);
      if (previous.testSponsorship) await this.syncSponsorship();
            previous.status = "Queued"; previous.recoverable = false; delete previous.reason; delete previous.fundingNeed; previous.updatedAt = now(); appendActivity(previous, { scene: "idle", state: "queued", reason: "HOSTED_RECOVERY_QUEUED" }); await this.save();
      this.launch(a, previous, true); return structuredClone(previous);
    }
    if (a.configurationRequired && !["provision", "deposit"].includes(input.action)) fail("HOSTED_CONFIGURATION_REQUIRED", 409);
    const awaiting = this.state.runs.find(r => r.requestId === a.activeRequestId);
    let fundingFor = awaiting?.status === "Paused" && awaiting.reason === "INFERENCE_FUNDING_REQUIRED"
      && (input.action === "game" && input.rewardKind === "llm-credits" && awaiting.action === "reward-task"
        || input.action === "deposit" && (["metered-task", "goal"].includes(awaiting.action)
          || awaiting.action === "autonomous" && !this.options.autonomyFunding && !this.executor.capabilities?.autonomy?.games)) ? awaiting.requestId : undefined;
    let fundingRoute: NonNullable<State["fundingRoutes"]>[string] | undefined;
    if (awaiting?.status === "Paused" && awaiting.action === "autonomous" && ["INFERENCE_FUNDING_REQUIRED", "AUTONOMY_GAME_LIMIT"].includes(awaiting.reason ?? "")
      && (input.action === "game" && input.rewardKind === "llm-credits" || input.action === "deposit") && this.options.autonomyFunding) {
      const directory = join(this.config.directory, "agents", a.id, "runs", awaiting.requestId);
      const target = await this.options.autonomyFunding({ agent: structuredClone(a), run: structuredClone(awaiting), directory,
        keyFile: join(this.config.directory, "agents", a.id, "wallet.key"), recover: true });
      if (target && uuid.test(target.childId) && this.config.models.some(model => model.id === target.modelId)
        && (input.action === "game" ? target.funding === "reward-tokens" : target.funding === "cash")) {
        fundingFor = awaiting.requestId; fundingRoute = { parentRequestId: awaiting.requestId, childId: target.childId, modelId: target.modelId };
      }
    }
    if (a.activeRequestId && !fundingFor) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED", 409);
    if (input.action === "reward-task" && a.modelId !== "kimi-k2.6") fail("HOSTED_REWARD_MODEL_UNSUPPORTED", 409);
    if (a.status === "Paused") fail("HOSTED_AGENT_PAUSED", 409);
    if (input.action === "provision" ? !!a.binding : !a.binding) fail("HOSTED_AGENT_STATE_INVALID", 409);
    if (this.state.runs.length >= 10000) fail("HOSTED_RUN_LIMIT", 503);
    if (input.action === "metered-task" && !this.executor.capabilities?.inference) fail("HOSTED_METERED_NOT_CONFIGURED", 409);
    if (input.action === "autonomous" && !this.executor.capabilities?.autonomy) fail("HOSTED_AUTONOMY_NOT_CONFIGURED", 409);
    if (input.action === "goal" && !this.executor.capabilities?.goals) fail("HOSTED_GOAL_NOT_CONFIGURED", 409);
    const reserve = input.action === "autonomous" ? String(BigInt(a.totalBudgetRaw) - BigInt(a.spentRaw)) : ["task", "metered-task", "goal"].includes(input.action) ? a.perRunBudgetRaw : "0";
    if (BigInt(a.spentRaw) + BigInt(reserve) > BigInt(a.totalBudgetRaw)) fail("HOSTED_BUDGET_EXHAUSTED", 409);
    // Bounded free sponsorship, independent of how many agents an owner creates. Unknown games retain the slot.
    let testSponsorship: HostedRun["testSponsorship"];
    if (input.action === "game") {
      const used = this.state.sponsoredOwners[a.owner] ?? 0, extension = this.config.testSponsorshipFile ? this.state.testSponsorship : undefined;
      if (used >= 3 && extension?.grant.owner === a.owner) {
        assertTestSponsorshipActor(extension.grant, a, input.rewardKind);
        if (Date.now() >= extension.grant.expiresAtMs || used !== extension.grant.baselineGames + extension.admissions.length || extension.admissions.length >= extension.grant.maxAdditionalGames) fail("HOSTED_SPONSOR_LIMIT", 409);
        testSponsorship = { grantId: extension.grant.id, digest: extension.digest, ordinal: extension.admissions.length + 1 };
      }
      if (used >= 3 && !testSponsorship || this.state.sponsoredTotal >= 100) fail("HOSTED_SPONSOR_LIMIT", 409);
      this.state.sponsoredOwners[a.owner] = (this.state.sponsoredOwners[a.owner] ?? 0) + 1; this.state.sponsoredTotal++;
    }
    const run: HostedRun = { ...input, ...(testSponsorship ? { testSponsorship } : {}), ...(fundingFor ? { fundingFor } : {}), agentId: a.id, status: "Queued", createdAt: now(), updatedAt: now(), reservedRaw: reserve, chargedRaw: "0", recoverable: false };
    appendActivity(run, { scene: "idle", state: "queued" });
    if (testSponsorship) this.state.testSponsorship!.admissions.push({ requestId: run.requestId, agentId: a.id, ordinal: testSponsorship.ordinal, admittedAt: run.createdAt, rewardKind: input.rewardKind! });
    if (fundingRoute) (this.state.fundingRoutes ??= {})[run.requestId] = fundingRoute;
    a.reservedRaw = fundingFor ? awaiting!.reservedRaw : reserve; a.activeRequestId = run.requestId; a.updatedAt = now(); this.state.runs.push(run);
    try { await this.save(); } catch (error) { this.state = (await this.store.read())!; throw error; }
    if (testSponsorship) await this.syncSponsorship(); this.launch(a, run, false); return structuredClone(run);
  }); }
  private result(value: HostedResult, a: HostedAgent, run: HostedRun) {
    object(value, ["phase", "terminal", "success", "chargedRaw", "reason", "binding", "taskId", "paymentId", "txHash", "matchId", "cashRaw", "principalRaw", "feeRaw", "rewardRaw", "creditsGranted", "creditsUsed", "chainId", "acceptTxHash", "paymentTxHash", "fromCashRaw", "fromCreditRaw", "refundedRaw", "settlement", "autonomousTasks", "autonomousGames", "mission"]);
    if (typeof value.phase !== "string" || !/^[A-Za-z][A-Za-z0-9_]{0,80}$/.test(value.phase) || typeof value.terminal !== "boolean" || typeof value.success !== "boolean" ||
      !amount(value.chargedRaw) || BigInt(value.chargedRaw) > BigInt(run.reservedRaw) || (value.success && !value.terminal)) fail("HOSTED_RESULT_INVALID", 503);
    if (value.reason !== undefined && !/^[A-Z][A-Z0-9_]{0,100}$/.test(value.reason)) fail("HOSTED_RESULT_INVALID", 503);
    for (const f of ["cashRaw", "principalRaw", "feeRaw", "rewardRaw", "taskId", "fromCashRaw", "fromCreditRaw", "refundedRaw"] as const) if (value[f] !== undefined && !amount(value[f])) fail("HOSTED_RESULT_INVALID", 503);
    for (const f of ["paymentId", "txHash", "acceptTxHash", "paymentTxHash"] as const) if (value[f] !== undefined && !/^0x[0-9a-f]{64}$/i.test(value[f]!)) fail("HOSTED_RESULT_INVALID", 503);
    if (value.chainId !== undefined && value.chainId !== this.config.chainId) fail("HOSTED_RESULT_INVALID", 503);
    if (value.settlement) {
      const s = value.settlement; object(s, ["txHash", "block", "passed", "loanStatus", "repaidRaw", "slashedRaw", "residualRaw"]); object(s.block, ["number", "hash", "timestamp"]);
      if (!["task", "reward-task", "metered-task"].includes(run.action) || !/^0x[0-9a-f]{64}$/i.test(s.txHash) || !/^0x[0-9a-f]{64}$/i.test(s.block.hash) ||
        ![s.block.number, s.block.timestamp].every(v => Number.isSafeInteger(v) && v >= 0) || typeof s.passed !== "boolean" || s.passed !== value.success ||
        !["0", "2", "3", "4"].includes(s.loanStatus) || ![s.repaidRaw, s.slashedRaw, s.residualRaw].every(amount)) fail("HOSTED_RESULT_INVALID", 503);
    }
    if (value.mission) { if (run.action !== "goal") fail("HOSTED_RESULT_INVALID", 503); value.mission = validateGoalView(value.mission); }
    if (value.matchId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(value.matchId)) fail("HOSTED_RESULT_INVALID", 503);
    for (const f of ["creditsGranted", "creditsUsed", "autonomousTasks", "autonomousGames"] as const) if (value[f] !== undefined && (!Number.isSafeInteger(value[f]) || value[f]! < 0)) fail("HOSTED_RESULT_INVALID", 503);
    if (value.binding) {
      object(value.binding, ["wallet", "agentId", "chainId"]);
      if (run.action !== "provision" || value.binding.wallet !== a.wallet || value.binding.chainId !== this.config.chainId || !amount(value.binding.agentId) || value.binding.agentId === "0" || this.state.agents.some(other => other.id !== a.id && other.binding?.agentId === value.binding!.agentId)) fail("HOSTED_RESULT_BINDING_INVALID", 503);
    }
    if (run.action === "provision" && value.success && !value.binding) fail("HOSTED_RESULT_BINDING_REQUIRED", 503);
    return structuredClone(value);
  }
  private launch(a: HostedAgent, run: HostedRun, recover: boolean) {
    const snapshot = structuredClone(a), original = structuredClone(run);
    const job = (async () => {
      await this.serial(async () => { run.status = "Running"; run.updatedAt = now(); appendActivity(run, { scene: run.action === "provision" ? "onboarding" : run.action === "deposit" ? "funding" : run.action === "game" ? "game" : run.action === "credits" ? "model" : run.action === "autonomous" ? "decision" : run.action === "goal" ? "decision" : "task", state: "started" }); await this.save(); });
      try {
        const directory = join(this.config.directory, "agents", a.id, "runs", run.requestId); await taskPrivateDirectory(directory);
        const route = this.state.fundingRoutes?.[run.requestId];
        if (route && (route.parentRequestId !== run.fundingFor || !uuid.test(route.parentRequestId) || !uuid.test(route.childId)
          || !this.state.runs.some(parent => parent.requestId === route.parentRequestId && parent.agentId === a.id && parent.action === "autonomous")
          || !this.config.models.some(model => model.id === route.modelId) || !["game", "deposit"].includes(run.action))) fail("HOSTED_FUNDING_ROUTE_INVALID", 503);
        const execution:HostedExecution={ agent: route ? { ...snapshot, modelId: route.modelId, ...(run.action === "game" ? { allowCredit: false } : {}) } : snapshot,
          run: route ? { ...original, fundingFor: route.childId } : original,
          directory: route ? join(this.config.directory, "agents", a.id, "runs", route.parentRequestId, "children", run.requestId) : directory,
          keyFile: join(this.config.directory, "agents", a.id, "wallet.key"), recover,
          ...(run.action === "goal" ? { progress: (view: import("./goal-types.js").GoalView) => this.serial(async () => { run.mission = validateGoalView(view); run.updatedAt = now(); await this.save(); }) } : {}) };
        // Keep legacy whole-input snapshots cloneable; callbacks never belong in durable custody state.
        Object.defineProperty(execution,"activity",{value:(event:HostedActivityInput)=>this.serial(async()=>{if(["Succeeded","Failed"].includes(run.status))return;appendActivity(run,event);run.updatedAt=now();await this.save();}),enumerable:false});
        const result = await this.executor.execute(execution);
        await this.serial(async () => {
          const safe = this.result(result, a, run); run.result = safe; run.updatedAt = now();
          if (safe.terminal) {
            run.status = safe.success ? "Succeeded" : "Failed"; run.recoverable = false; run.chargedRaw = safe.chargedRaw;
            a.spentRaw = String(BigInt(a.spentRaw) + BigInt(safe.chargedRaw));
            if (run.fundingFor) {
              const parent = this.state.runs.find(candidate => candidate.requestId === run.fundingFor && candidate.agentId === a.id);
              if (!parent) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED", 503);
              a.activeRequestId = parent.requestId; a.reservedRaw = parent.reservedRaw;
            } else { a.reservedRaw = "0"; delete a.activeRequestId; }
            if (safe.binding) { a.binding = safe.binding; if (a.status !== "Paused") a.status = "Ready"; }
          } else { run.status = "Paused"; run.recoverable = true; }
          if (safe.reason) run.reason = safe.reason; else delete run.reason;
          delete run.fundingNeed;
          if (!safe.terminal && run.action === "autonomous" && this.options.autonomyFunding) {
            try {
              const target = await this.options.autonomyFunding({ agent: structuredClone(a), run: structuredClone(run), directory,
                keyFile: join(this.config.directory, "agents", a.id, "wallet.key"), recover: true });
              if (target && ["cash", "reward-tokens"].includes(target.funding)) run.fundingNeed = target.funding;
            } catch { /* A failed read cannot grant a refuel route or alter the original paused outcome. */ }
          }
          appendActivity(run, runOutcomeActivity(run, safe)); await this.save();
        });
      } catch (e) { await this.serial(async () => { run.status = "Paused"; run.reason = safeCode(e); run.recoverable = true; run.updatedAt = now(); appendActivity(run, { scene: "interruption", state: "reconciling", reason: run.reason, requiredAction: "reconcile" }); await this.save(); }); }
    })();
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
  }
  goalControl(agentId: string, requestId: string) { return this.serial(async () => {
    const agent = this.state.agents.find(a=>a.id===agentId), run = this.state.runs.find(r=>r.agentId===agentId&&r.requestId===requestId);
    return { paused: agent?.status === "Paused", cancelled: !!run?.stopRequested };
  }); }
  cancelGoal(who: string, agentId: string, requestId: string) { return this.serial(async () => {
    const agent=this.agent(who,agentId), run=this.state.runs.find(r=>r.agentId===agent.id&&r.requestId===requestId);
    if (!run || run.action!=="goal") fail("HOSTED_GOAL_NOT_FOUND",404);
    if (["Succeeded","Failed"].includes(run.status)) return structuredClone(run);
    if (agent.activeRequestId !== requestId) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED",409);
    run.stopRequested=true; appendActivity(run, { scene: "interruption", state: "stopping", reason: "HOSTED_GOAL_CANCELLED" }); await this.save();
    if(run.status==="Paused"){run.status="Queued";run.recoverable=false;await this.save();this.launch(agent,run,true);}
    return structuredClone(run);
  }); }
  async waitUntilIdle() {
    for (;;) {
      const observed = this.queue; await observed;
      if (this.jobs.size) { await Promise.all([...this.jobs]); continue; }
      if (observed === this.queue) return;
    }
  }
  async close() { await this.waitUntilIdle(); this.closed = true; await Promise.all(this.financeReads.values()); await this.boundedGameStore?.close(); await this.sponsorshipStore?.close(); await this.store.close(); }
}
