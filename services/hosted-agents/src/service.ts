import { createHash, randomBytes, randomUUID } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { open } from "node:fs/promises";
import { Wallet, getAddress, verifyMessage } from "ethers";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { taskPrivateDirectory } from "../../../packages/pi-loop/src/task-runner/config.js";
import { HostedError, type AgentSettings, type HostedAgent, type HostedConfig, type HostedExecution, type HostedExecutor, type HostedFinance, type HostedResult, type HostedRun } from "./types.js";
import { validateHostedFinance } from "./finance-projection.js";
import { assertTestSponsorshipActor, loadTestSponsorship, type TestSponsorshipState } from "./test-sponsorship.js";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const amount = (v: unknown): v is string => typeof v === "string" && /^(0|[1-9][0-9]{0,29})$/.test(v);
const hash = (v: string) => createHash("sha256").update(v).digest("hex");
const now = () => new Date().toISOString();
const safeCode = (e: unknown) => { const v = (e as any)?.code ?? (e as any)?.message; return typeof v === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(v) ? v : "HOSTED_EXECUTION_UNCERTAIN"; };
function fail(code: string, status = 400): never { throw new HostedError(code, status); }
function object(v: unknown, fields: string[]): asserts v is Record<string, any> {
  if (!v || typeof v !== "object" || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) fail("HOSTED_INPUT_INVALID");
}
function id(v: unknown): asserts v is string { if (typeof v !== "string" || !uuid.test(v)) fail("HOSTED_REQUEST_ID_INVALID"); }
function owner(v: string) { try { return getAddress(v); } catch { return fail("HOSTED_WALLET_INVALID"); } }
interface Challenge { id: string; wallet: string; message: string; expiresAt: number }
interface Session { digest: string; owner: string; expiresAt: number }
interface Creation { owner: string; requestId: string; agentId: string; digest: string }
interface State { version: 1; configBinding: string; challenges: Challenge[]; sessions: Session[]; agents: HostedAgent[]; runs: HostedRun[]; creations: Creation[]; sponsoredOwners: Record<string, number>; sponsoredTotal: number; testSponsorship?: TestSponsorshipState }
export interface HostedCommand { action: "provision" | "deposit" | "task" | "game" | "credits" | "reward-task" | "metered-task" | "autonomous"; requestId: string; rewardKind?: "usdc" | "llm-credits"; amountRaw?: string }

export function validateHostedConfig(value: unknown): HostedConfig {
  object(value, ["directory", "origin", "chainId", "models", "maxAgentsPerOwner", "maxTotalBudgetRaw", "maxPerRunBudgetRaw", "testSponsorshipFile"]);
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
  return structuredClone(config);
}

/** One daemon owns the private local database; async jobs use serial durable admission. */
export class HostedService {
  private queue: Promise<unknown> = Promise.resolve();
  private jobs = new Set<Promise<void>>();
  private financeReads = new Map<string, Promise<HostedFinance>>();
  private closed = false;
  private constructor(readonly config: HostedConfig, private executor: HostedExecutor, private store: SessionStore<State>, private state: State, private sponsorshipStore?: SessionStore<TestSponsorshipState>) {}
  static async open(config: HostedConfig, executor: HostedExecutor, options: { recover?: boolean } = {}) {
    config = validateHostedConfig(config);
    await taskPrivateDirectory(config.directory);
    const store = new SessionStore<State>(join(config.directory, "database")); await store.start(options.recover); let sponsorshipStore: SessionStore<TestSponsorshipState> | undefined;
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
      for (const run of state.runs) if (["Queued", "Running"].includes(run.status)) { run.status = "Paused"; run.recoverable = true; run.reason = "HOSTED_PROCESS_INTERRUPTED"; run.updatedAt = now(); }
      await store.write(state);
      const service = new HostedService(structuredClone(config), executor, store, state, sponsorshipStore); await service.syncSponsorship(); return service;
    } catch (e) { await sponsorshipStore?.close(); await store.close(); throw e; }
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
  gameDeadline(input: HostedExecution) {
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
  async create(who: string, input: AgentSettings & { requestId: string }) {
    const agent = await this.serial(async () => {
      object(input, ["requestId", "name", "modelId", "strategy", "perRunBudgetRaw", "totalBudgetRaw", "allowCredit"]); id(input.requestId);
      const { requestId, ...rest } = input, settings = this.settings(rest), address = owner(who), digest = hash(JSON.stringify(settings));
      const previous = this.state.creations.find(c => c.owner === address && c.requestId === requestId);
      if (previous) { if (previous.digest !== digest) fail("HOSTED_REQUEST_CONFLICT", 409); return structuredClone(this.agent(address, previous.agentId)); }
      if (this.state.creations.some(c => c.requestId === requestId) || this.state.runs.some(r => r.requestId === requestId)) fail("HOSTED_REQUEST_CONFLICT", 409);
      if (this.state.agents.filter(a => a.owner === address).length >= this.config.maxAgentsPerOwner || this.state.agents.length >= 1000) fail("HOSTED_AGENT_LIMIT", 409);
      const agentId = randomUUID(), directory = join(this.config.directory, "agents", agentId); await taskPrivateDirectory(directory);
      const wallet = Wallet.createRandom(); const file = await open(join(directory, "wallet.key"), "wx", 0o600);
      try { await file.writeFile(wallet.privateKey + "\n"); await file.sync(); } finally { await file.close(); }
      const created: HostedAgent = { ...settings, id: agentId, owner: address, wallet: wallet.address, createdAt: now(), updatedAt: now(), status: "Pending", spentRaw: "0", reservedRaw: "0" };
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
    Object.assign(a, settings, { updatedAt: now() }); await this.save(); return structuredClone(a);
  }); }
  pause(who: string, agentId: string, paused: boolean) { return this.serial(async () => {
    if (typeof paused !== "boolean") fail("HOSTED_INPUT_INVALID"); const a = this.agent(who, agentId);
    a.status = paused ? "Paused" : a.binding ? "Ready" : "Pending"; a.updatedAt = now(); await this.save(); return structuredClone(a);
  }); }
  command(who: string, agentId: string, input: HostedCommand) { return this.serial(async () => {
    object(input, ["action", "requestId", "rewardKind", "amountRaw"]); id(input.requestId);
    if (!["provision", "deposit", "task", "game", "credits", "reward-task", "metered-task", "autonomous"].includes(input.action) || (input.action === "game" ? !["usdc", "llm-credits"].includes(input.rewardKind as string) : input.rewardKind !== undefined)) fail("HOSTED_COMMAND_INVALID");
    if (input.action === "deposit" ? !amount(input.amountRaw) || BigInt(input.amountRaw) < 1n || BigInt(input.amountRaw) > BigInt(this.config.maxTotalBudgetRaw) : input.amountRaw !== undefined) fail("HOSTED_DEPOSIT_AMOUNT_INVALID");
    const a = this.agent(who, agentId), creation = this.state.creations.find(c => c.requestId === input.requestId);
    if (creation && (creation.agentId !== a.id || input.action !== "provision")) fail("HOSTED_REQUEST_CONFLICT", 409);
    const previous = this.state.runs.find(r => r.requestId === input.requestId);
    if (previous) {
      if (previous.agentId !== a.id || previous.action !== input.action || previous.rewardKind !== input.rewardKind || previous.amountRaw !== input.amountRaw) fail("HOSTED_REQUEST_CONFLICT", 409);
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
        this.launch(a, previous, true); return structuredClone(previous);
      }
      if (previous.status !== "Paused") return structuredClone(previous);
      if (a.activeRequestId !== previous.requestId) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED", 409);
      if (previous.testSponsorship) await this.syncSponsorship();
      previous.status = "Queued"; previous.recoverable = false; delete previous.reason; previous.updatedAt = now(); await this.save();
      this.launch(a, previous, true); return structuredClone(previous);
    }
    const awaiting = this.state.runs.find(r => r.requestId === a.activeRequestId);
    const fundingFor = awaiting?.status === "Paused" && awaiting.reason === "INFERENCE_FUNDING_REQUIRED"
      && (input.action === "game" && input.rewardKind === "llm-credits" && awaiting.action === "reward-task"
        || input.action === "deposit" && ["metered-task", "autonomous"].includes(awaiting.action)) ? awaiting.requestId : undefined;
    if (a.activeRequestId && !fundingFor) fail("HOSTED_RECOVER_ORIGINAL_REQUIRED", 409);
    if (input.action === "reward-task" && a.modelId !== "kimi-k2.6") fail("HOSTED_REWARD_MODEL_UNSUPPORTED", 409);
    if (a.status === "Paused") fail("HOSTED_AGENT_PAUSED", 409);
    if (input.action === "provision" ? !!a.binding : !a.binding) fail("HOSTED_AGENT_STATE_INVALID", 409);
    if (this.state.runs.length >= 10000) fail("HOSTED_RUN_LIMIT", 503);
    if (input.action === "metered-task" && !this.executor.capabilities?.inference) fail("HOSTED_METERED_NOT_CONFIGURED", 409);
    if (input.action === "autonomous" && !this.executor.capabilities?.autonomy) fail("HOSTED_AUTONOMY_NOT_CONFIGURED", 409);
    const reserve = input.action === "autonomous" ? String(BigInt(a.totalBudgetRaw) - BigInt(a.spentRaw)) : ["task", "metered-task"].includes(input.action) ? a.perRunBudgetRaw : "0";
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
    if (testSponsorship) this.state.testSponsorship!.admissions.push({ requestId: run.requestId, agentId: a.id, ordinal: testSponsorship.ordinal, admittedAt: run.createdAt, rewardKind: input.rewardKind! });
    a.reservedRaw = fundingFor ? awaiting!.reservedRaw : reserve; a.activeRequestId = run.requestId; a.updatedAt = now(); this.state.runs.push(run);
    try { await this.save(); } catch (error) { this.state = (await this.store.read())!; throw error; }
    if (testSponsorship) await this.syncSponsorship(); this.launch(a, run, false); return structuredClone(run);
  }); }
  private result(value: HostedResult, a: HostedAgent, run: HostedRun) {
    object(value, ["phase", "terminal", "success", "chargedRaw", "reason", "binding", "taskId", "paymentId", "txHash", "matchId", "cashRaw", "principalRaw", "feeRaw", "rewardRaw", "creditsGranted", "creditsUsed", "chainId", "acceptTxHash", "paymentTxHash", "fromCashRaw", "fromCreditRaw", "refundedRaw", "settlement", "autonomousTasks"]);
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
    if (value.matchId !== undefined && !/^[a-zA-Z0-9_-]{1,100}$/.test(value.matchId)) fail("HOSTED_RESULT_INVALID", 503);
    for (const f of ["creditsGranted", "creditsUsed", "autonomousTasks"] as const) if (value[f] !== undefined && (!Number.isSafeInteger(value[f]) || value[f]! < 0)) fail("HOSTED_RESULT_INVALID", 503);
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
      await this.serial(async () => { run.status = "Running"; run.updatedAt = now(); await this.save(); });
      try {
        const directory = join(this.config.directory, "agents", a.id, "runs", run.requestId); await taskPrivateDirectory(directory);
        const result = await this.executor.execute({ agent: snapshot, run: original, directory, keyFile: join(this.config.directory, "agents", a.id, "wallet.key"), recover });
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
          if (safe.reason) run.reason = safe.reason; await this.save();
        });
      } catch (e) { await this.serial(async () => { run.status = "Paused"; run.reason = safeCode(e); run.recoverable = true; run.updatedAt = now(); await this.save(); }); }
    })();
    this.jobs.add(job); void job.finally(() => this.jobs.delete(job)).catch(() => undefined);
  }
  async waitUntilIdle() {
    for (;;) {
      const observed = this.queue; await observed;
      if (this.jobs.size) { await Promise.all([...this.jobs]); continue; }
      if (observed === this.queue) return;
    }
  }
  async close() { await this.waitUntilIdle(); this.closed = true; await Promise.all(this.financeReads.values()); await this.sponsorshipStore?.close(); await this.store.close(); }
}
