import { createHash } from "node:crypto";
import { join } from "node:path";
import { JsonRpcProvider, Wallet } from "ethers";
import { chainRpcProvider } from "../../../../scripts/demo-rpc.js";
import { SessionStore } from "../session.js";
import { readWorkflowStatus, runTaskWorkflow, type WorkflowStatus } from "../workflow.js";
import { taskPrivateDirectory, taskPrivateFile, taskPublicProfiles, type LoadedTaskRunnerConfig } from "./config.js";
import { TaskRunnerError, taskRequestId, parseTaskRunnerCommand, parseTaskWorkflowView, type TaskRunnerCommand, type TaskRunnerRun, type TaskRunnerSnapshot, type TaskWorkflowPhase, type TaskWorkflowView } from "./types.js";

const now = () => new Date().toISOString();
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
export function taskSafeCode(error: unknown): string {
  const value = (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : "TASK_WORKFLOW_UNCERTAIN";
}
const workflowPhases = ["Selected", "AcceptPending", "Running", "Succeeded", "Failed", "Refunded", "Stopped", "Paused", "SubmissionPending", "RefundPending"];
const childPhases = ["Purchasing", "ReadyToSubmit", "SubmissionPending", "Succeeded", "Failed", "Paused", "Stopped", "RefundPending", "Refunded"];
const terminal = (phase: string) => ["Succeeded", "Failed", "Refunded", "Stopped"].includes(phase);
const integer = (value: unknown): value is string => typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value);
const hash = (value: unknown): value is string => typeof value === "string" && /^0x[0-9a-f]{64}$/i.test(value);
function alive(pid?: number) { if (!pid) return false; try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } }
/** A second closed projection protects the API even if a core status later grows private fields. */
export function taskWorkflowView(input: WorkflowStatus): TaskWorkflowView {
  if (!input || !workflowPhases.includes(input.phase) || !integer(input.reservedPrice)) throw new TaskRunnerError("TASK_STATUS_INVALID", 503);
  const view: TaskWorkflowView = { version: 1, phase: input.phase as TaskWorkflowPhase, deadlineMs: input.deadlineMs, reservedPrice: input.reservedPrice };
  if (input.reason) view.reason = taskSafeCode({ code: input.reason });
  const selected = input.choice;
  if (selected) {
    if (!integer(selected.taskId) || !["sum-integers", "unique-sorted", "balanced-brackets", "word-frequency"].includes(selected.problemId) ||
      !/^[a-zA-Z0-9_-]{1,64}$/.test(selected.providerId) || !["cheap", "strong"].includes(selected.tier) || !integer(selected.price) || !["cash", "task-credit"].includes(selected.funding)) throw new TaskRunnerError("TASK_STATUS_INVALID", 503);
    view.choice = { taskId: selected.taskId, problemId: selected.problemId, providerId: selected.providerId, tier: selected.tier, price: selected.price, funding: selected.funding };
  }
  if (input.acceptTxHash) { if (!hash(input.acceptTxHash)) throw new TaskRunnerError("TASK_STATUS_INVALID", 503); view.acceptTxHash = input.acceptTxHash; }
  if (input.paymentId) { if (!hash(input.paymentId)) throw new TaskRunnerError("TASK_STATUS_INVALID", 503); view.paymentId = input.paymentId; }
  if (input.childPhase) { if (!childPhases.includes(input.childPhase)) throw new TaskRunnerError("TASK_STATUS_INVALID", 503); view.childPhase = input.childPhase; }
  if (input.tools) view.tools = { rounds: input.tools.rounds, attempts: input.tools.attempts, passed: input.tools.passed };
  if (input.finance) {
    view.finance = { taskStatus: input.finance.taskStatus, loanStatus: input.finance.loanStatus, principal: input.finance.principal, fee: input.finance.fee };
    for (const field of ["fromCash", "fromCredit", "repaid", "slashed", "residual"] as const) if (input.finance[field] !== undefined) view.finance[field] = input.finance[field];
  }
  return parseTaskWorkflowView(view);
}
interface StoredRun extends TaskRunnerRun { workflowDirectory: string; ownerPid?: number }
interface Registry { version: 1; configDigest: string; activeRequestId?: string; runs: StoredRun[] }
export interface TaskRunnerConnection { provider: JsonRpcProvider; rpcUrl: string; close: () => void }
export interface TaskRunnerDependencies {
  /** Trusted process-only injection. HTTP commands never choose dependencies, wallets or executables. */
  connect?: (profile: LoadedTaskRunnerConfig["profiles"][number]) => Promise<TaskRunnerConnection>;
  workflow?: typeof runTaskWorkflow;
  readStatus?: typeof readWorkflowStatus;
}
export class TaskRunner {
  private readonly directory: string;
  private task?: Promise<void>;
  constructor(readonly loaded: LoadedTaskRunnerConfig, private readonly dependencies: TaskRunnerDependencies = {}) { this.directory = join(loaded.config.dataDirectory, ".task-runner"); }
  private empty(): Registry { return { version: 1, configDigest: this.loaded.digest, runs: [] }; }
  private check(state: Registry) {
    if (state.version !== 1 || state.configDigest !== this.loaded.digest || !Array.isArray(state.runs)) throw new TaskRunnerError("TASK_RUNNER_BINDING_CHANGED", 503);
    return state;
  }
  private async read(): Promise<Registry> {
    try { return this.check(JSON.parse(await taskPrivateFile(join(this.directory, "session.json")))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty(); throw error; }
  }
  private publicRun(run: StoredRun): TaskRunnerRun {
    return { requestId: run.requestId, profileId: run.profileId, status: run.status, createdAt: run.createdAt, updatedAt: run.updatedAt, recoverable: run.recoverable,
      ...(run.reason ? { reason: taskSafeCode({ code: run.reason }) } : {}), ...(run.workflow ? { workflow: taskWorkflowView(run.workflow) } : {}) };
  }
  private async refresh(run: StoredRun) {
    const status = await (this.dependencies.readStatus ?? readWorkflowStatus)(run.workflowDirectory);
    if (status) {
      run.workflow = taskWorkflowView(status);
      if (terminal(status.phase)) { run.status = status.phase as TaskRunnerRun["status"]; run.recoverable = false; }
      else if (!alive(run.ownerPid)) { run.status = "Paused"; run.recoverable = true; run.reason = run.workflow.reason ?? "TASK_PROCESS_INTERRUPTED"; }
    }
    if ((run.status === "Queued" || run.status === "Running") && !alive(run.ownerPid)) { run.status = "Paused"; run.recoverable = true; run.reason ??= "TASK_PROCESS_INTERRUPTED"; }
  }
  async snapshot(id?: string): Promise<TaskRunnerSnapshot> {
    if (id !== undefined) taskRequestId(id);
    const registry = await this.read();
    const selected = id ? registry.runs.find(run => run.requestId === id) : undefined;
    if (id && !selected) throw new TaskRunnerError("TASK_RUN_NOT_FOUND", 404);
    const recent = registry.runs.slice(-20).reverse();
    for (const run of recent) await this.refresh(run);
    if (selected && !recent.includes(selected)) await this.refresh(selected);
    return { enabled: true, profiles: taskPublicProfiles(this.loaded), runs: recent.map(run => this.publicRun(run)), ...(selected ? { run: this.publicRun(selected) } : {}) };
  }
  async command(input: TaskRunnerCommand): Promise<TaskRunnerSnapshot> {
    const command = parseTaskRunnerCommand(input);
    if (command.action === "start" && !this.loaded.profiles.some(profile => profile.preset.id === command.profileId)) throw new TaskRunnerError("TASK_PROFILE_NOT_ALLOWED", 403);
    const observed = await this.read(), previous = observed.runs.find(run => run.requestId === command.requestId);
    if (command.action === "start" && previous) {
      if (previous.profileId !== command.profileId) throw new TaskRunnerError("TASK_REQUEST_ID_CONFLICT", 409);
      return this.snapshot(command.requestId);
    }
    const store = new SessionStore<Registry>(this.directory);
    try { await store.start(command.action === "recover"); }
    catch (error) {
      const code = taskSafeCode(error), saved = (await this.read()).runs.find(run => run.requestId === command.requestId);
      if (command.action === "start" && saved && code === "SESSION_BUSY") {
        if (saved.profileId !== command.profileId) throw new TaskRunnerError("TASK_REQUEST_ID_CONFLICT", 409);
        return this.snapshot(command.requestId);
      }
      throw new TaskRunnerError(code === "SESSION_BUSY" ? "TASK_RUNNER_BUSY" : code, 409);
    }
    let retained = false;
    try {
      const state = this.check(await store.read() ?? this.empty()); let run = state.runs.find(run => run.requestId === command.requestId);
      if (command.action === "start") {
        if (run) { if (run.profileId !== command.profileId) throw new TaskRunnerError("TASK_REQUEST_ID_CONFLICT", 409); return this.snapshot(command.requestId); }
        if (!state.activeRequestId) {
          for (const saved of [...state.runs].reverse()) {
            if (saved.status !== "Stopped" && terminal(saved.status)) continue;
            await this.refresh(saved);
            if (!terminal(saved.status)) {
              state.activeRequestId = saved.requestId;
              await store.write(state);
              throw new TaskRunnerError("TASK_RECOVER_ORIGINAL_REQUIRED", 409);
            }
          }
        }
        if (state.activeRequestId) {
          const active = state.runs.find(run => run.requestId === state.activeRequestId); if (active) await this.refresh(active);
          if (!active || !terminal(active.status) || alive(active.ownerPid)) throw new TaskRunnerError("TASK_RECOVER_ORIGINAL_REQUIRED", 409);
          delete state.activeRequestId;
        }
        if (state.runs.length >= 1000) throw new TaskRunnerError("TASK_REGISTRY_LIMIT_REACHED", 503);
        const workflowDirectory = join(this.loaded.config.dataDirectory, "runs", command.requestId); await taskPrivateDirectory(workflowDirectory);
        run = { requestId: command.requestId, profileId: command.profileId, status: "Queued", createdAt: now(), updatedAt: now(), recoverable: false, workflowDirectory };
        state.runs.push(run);
      } else {
        if (!run) throw new TaskRunnerError("TASK_RUN_NOT_FOUND", 404);
        await this.refresh(run);
        if (terminal(run.status)) return this.snapshot(command.requestId);
        if (state.activeRequestId && state.activeRequestId !== command.requestId) throw new TaskRunnerError("TASK_RECOVER_ORIGINAL_REQUIRED", 409);
        if (alive(run.ownerPid)) throw new TaskRunnerError("TASK_RUNNER_BUSY", 409);
      }
      state.activeRequestId = run.requestId; run.ownerPid = process.pid; run.status = "Queued"; run.updatedAt = now(); delete run.reason;
      await store.write(state);
      const selected = run;
      this.task = this.execute(state, selected, store, command.action === "recover").finally(() => { this.task = undefined; });
      void this.task.catch(() => undefined); retained = true;
      return { enabled: true, profiles: taskPublicProfiles(this.loaded), runs: state.runs.slice(-20).reverse().map(run => this.publicRun(run)), run: this.publicRun(selected) };
    } finally { if (!retained) await store.close(); }
  }
  async waitUntilIdle() { await this.task; }
  private async connect(profile: LoadedTaskRunnerConfig["profiles"][number]): Promise<TaskRunnerConnection> {
    if (this.dependencies.connect) return this.dependencies.connect(profile);
    const rpcUrl = (await taskPrivateFile(profile.preset.rpcUrlFile)).trim();
    if (profile.workflow.chainId !== "31337") {
      const connection = await chainRpcProvider(rpcUrl, BigInt(profile.workflow.chainId), profile.preset.rpcTransport);
      const publicRpcUrl = profile.workflow.chainId === "42431" ? "https://rpc.moderato.tempo.xyz" : "https://testnet-rpc.monad.xyz";
      return { provider: connection.provider, rpcUrl: publicRpcUrl, close: () => connection.close() };
    }
    const provider = new JsonRpcProvider(rpcUrl, 31337, { staticNetwork: true, cacheTimeout: -1, pollingInterval: 100 });
    return { provider, rpcUrl, close: () => provider.destroy() };
  }
  private async execute(state: Registry, run: StoredRun, store: SessionStore<Registry>, recoverLock: boolean) {
    const persist = async () => { run.updatedAt = now(); await store.write(state); };
    let connection: TaskRunnerConnection | undefined;
    try {
      run.status = "Running"; await persist();
      const profile = this.loaded.profiles.find(value => value.preset.id === run.profileId); if (!profile) throw new TaskRunnerError("TASK_PROFILE_NOT_ALLOWED");
      await taskPrivateDirectory(this.loaded.walletLockDirectory);
      const key = (await taskPrivateFile(this.loaded.config.keyFile)).trim();
      if (sha(key) !== this.loaded.keyDigest) throw new TaskRunnerError("TASK_SIGNER_KEY_CHANGED");
      connection = await this.connect(profile);
      const signer = new Wallet(key, connection.provider); if (signer.address !== this.loaded.config.wallet) throw new TaskRunnerError("TASK_SIGNER_WALLET_MISMATCH");
      const result = await (this.dependencies.workflow ?? runTaskWorkflow)(run.workflowDirectory, structuredClone(profile.workflow), {
        signer, provider: connection.provider, rpcUrl: connection.rpcUrl, arenaUrl: profile.preset.arenaUrl, underwriterUrl: profile.preset.underwriterUrl,
        walletLockDirectory: this.loaded.walletLockDirectory, recoverLock,
        timeoutMs: profile.preset.timeoutMs, pollTimeoutMs: profile.preset.pollTimeoutMs,
      });
      run.workflow = taskWorkflowView(result); run.status = terminal(result.phase) ? result.phase as TaskRunnerRun["status"] : "Paused";
      run.recoverable = !terminal(result.phase); if (run.workflow.reason) run.reason = run.workflow.reason;
      if (terminal(result.phase)) delete state.activeRequestId;
    } catch (error) { run.status = "Paused"; run.reason = taskSafeCode(error); run.recoverable = true; }
    finally {
      try { connection?.close(); }
      finally { delete run.ownerPid; try { await persist(); } finally { await store.close(); } }
    }
  }
}
