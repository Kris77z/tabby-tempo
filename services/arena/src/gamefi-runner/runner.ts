import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { SessionStore } from "../../../../packages/pi-loop/src/session.js";
import { replayHand } from "../holdem/index.js";
import { publicLiveHand, type LiveHandSession } from "../holdem/live.js";
import { atomicJson } from "../protocol.js";
import { privateDirectory, privateFile, type LoadedGameFiConfig } from "./config.js";
import { GameFiError, requestId, type GameFiCommand, type GameFiCreditGrant, type GameFiRun, type GameFiSnapshot, type GameFiStage } from "./types.js";
import { parseGameFiStageDiagnostic, type GameFiStageDiagnostic } from "./diagnostic.js";

/** Next bundles source modules; import.meta.url can name its generated chunk rather than this source file. */
async function repositoryDirectory() {
  let candidate = process.cwd();
  for (let level = 0; level < 6; level++) {
    try {
      const manifest = JSON.parse(await readFile(join(candidate, "package.json"), "utf8"));
      if (manifest.name === "agentfuel") {
        await readFile(join(candidate, "scripts/holdem-live.ts"));
        return candidate;
      }
    } catch { /* The next ancestor may be the workspace root. */ }
    const parent = dirname(candidate); if (parent === candidate) break; candidate = parent;
  }
  throw new GameFiError("GAMEFI_WORKSPACE_REQUIRED", 503);
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const code = (error: unknown) => {
  const value = (error as { code?: unknown })?.code ?? (error as { message?: unknown })?.message;
  return typeof value === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(value) ? value : "GAMEFI_STAGE_UNCERTAIN";
};
const now = () => new Date().toISOString();
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; } };
interface StageJournal { state: "Intent" | "Complete"; childPid?: number; exitCode?: number; diagnostic?: GameFiStageDiagnostic }
interface StoredRun extends GameFiRun {
  sourceDirectory: string; holdemConfigFile: string; stages: Partial<Record<GameFiStage, StageJournal>>;
  trusted?: { matchId: string; replayDigest: string; reportDigest: string; winners: (0 | 1)[] };
}
interface Journal { version: 1; configDigest: string; activeRequestId?: string; runs: StoredRun[] }
export interface GameFiLaunch {
  stage: Exclude<GameFiStage, "credits">; sourceDirectory: string; holdemConfigFile: string;
  upstreamConfigFile: string; recover: boolean; rpcUrlFile?: string; rpcTransport: "direct" | "system-https-proxy";
}
export interface GameFiRunnerDependencies {
  /** Trusted test/operator injection only; no HTTP command selects an executable. */
  launch?: (input: GameFiLaunch, onSpawn: (pid: number) => Promise<void>, onDiagnostic?: (diagnostic: GameFiStageDiagnostic) => Promise<void>) => Promise<number>;
  grant?: (input: { grantId: string; matchId: string; replayDigest: string; winners: (0 | 1)[] }) => Promise<GameFiCreditGrant>;
}

/** Fixed existing CLIs, no shell, no output logging. CLI evidence is the result boundary. */
export async function launchGameFiStage(input: GameFiLaunch, onSpawn: (pid: number) => Promise<void>, onDiagnostic?: (diagnostic: GameFiStageDiagnostic) => Promise<void>): Promise<number> {
  if (Number(process.versions.node.split(".")[0]) < 22) throw new GameFiError("GAMEFI_NODE_22_REQUIRED", 503);
  const repository = await repositoryDirectory();
  const script = input.stage === "game" ? "holdem-live.ts" : input.stage === "award" ? "holdem-monad.ts" : "holdem-monad-purchase.ts";
  const args = ["--import", join(repository, "node_modules/tsx/dist/loader.mjs"), join(repository, "scripts", script), "--config",
    input.stage === "game" ? input.upstreamConfigFile : input.holdemConfigFile, "--execute"];
  if (input.stage === "game") args.push("--output", input.sourceDirectory);
  else {
    if (input.recover) args.push("--recover");
    if (input.rpcUrlFile) args.push("--rpc-url-file", input.rpcUrlFile);
    args.push("--rpc-transport", input.rpcTransport);
  }
  const child = spawn(process.execPath, ["--import", join(repository, "node_modules/tsx/dist/loader.mjs"), join(repository, "scripts/gamefi-runner-worker.ts")],
    { cwd: repository, shell: false, stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: { ...process.env, AGENTFUEL_RPC_INTERVAL_MS: "500", AGENTFUEL_RPC_RETRY_READ_503: "1" } });
  // Listen before persisting the PID: a child can exit while the journal write is in progress.
  const completion = new Promise<number>((done, reject) => {
    child.once("error", () => reject(new GameFiError("GAMEFI_CHILD_START_FAILED", 503)));
    child.once("exit", (status, signal) => done(signal ? -1 : status ?? -1));
  });
  let diagnostics = Promise.resolve();
  child.on("message", (input: any) => {
    if (input?.version !== 1 || input?.type !== "diagnostic" || typeof input.code !== "string") return;
    const safe = parseGameFiStageDiagnostic(`${input.code}\n${JSON.stringify({ diagnostic: input.diagnostic })}`);
    if (safe && onDiagnostic) diagnostics = diagnostics.then(() => onDiagnostic(safe));
  });
  const timeout = setTimeout(() => child.kill("SIGTERM"), 20 * 60_000); timeout.unref();
  try {
    if (!child.pid) { await completion; throw new GameFiError("GAMEFI_CHILD_START_FAILED", 503); }
    await onSpawn(child.pid);
    // The worker cannot run a CLI before this durable write. A disconnected pre-dispatch worker exits.
    await new Promise<void>((done, reject) => child.send({ version: 1, script, args }, error => error ? reject(new GameFiError("GAMEFI_CHILD_HANDSHAKE_FAILED", 503)) : done()));
    const status = await completion; await diagnostics; return status;
  } catch (error) { child.kill("SIGTERM"); await completion.catch(() => undefined); throw error; }
  finally { clearTimeout(timeout); }
}

function publicRun(run: StoredRun): GameFiRun {
  return structuredClone({ requestId: run.requestId, rewardKind: run.rewardKind, status: run.status, stage: run.stage,
    createdAt: run.createdAt, updatedAt: run.updatedAt, recoverable: run.recoverable,
    ...(run.matchId ? { matchId: run.matchId } : {}), ...(run.reason ? { reason: run.reason } : {}), ...(run.game ? { game: run.game } : {}),
    ...(run.award ? { award: run.award } : {}), ...(run.purchase ? { purchase: run.purchase } : {}), ...(run.credits ? { credits: run.credits } : {}) });
}
async function optionalJson(path: string): Promise<any | undefined> {
  try { return JSON.parse(await privateFile(path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
function awardSummary(report: any, trusted: NonNullable<StoredRun["trusted"]>): NonNullable<GameFiRun["award"]> {
  if (report?.mode !== "holdem-monad" || report.phase !== "RewardDeposited" || report.stageComplete !== true || report.chainId !== "10143"
    || report.plan?.source?.matchId !== trusted.matchId || report.plan.source.replayDigest !== trusted.replayDigest
    || report.plan.source.reportDigest !== trusted.reportDigest || report.verification?.rewardConserved !== true) throw new Error("GAMEFI_AWARD_NOT_VERIFIED");
  const hash = /^0x[0-9a-f]{64}$/i;
  if (report.plan.reward !== "100000" || !Array.isArray(report.plan.allocations) || report.plan.allocations.length !== 2
    || report.plan.allocations.some((value: unknown) => typeof value !== "string" || !/^[0-9]+$/.test(value))
    || report.plan.allocations.reduce((total: bigint, value: string) => total + BigInt(value), 0n) !== 100000n) throw new Error("GAMEFI_AWARD_NOT_VERIFIED");
  if (!Array.isArray(report.operations) || report.operations.some((item: any) => ![0, 1].includes(item.seat)
    || !["reward", "approve", "deposit"].includes(item.kind) || !hash.test(item.txHash) || !/^[0-9]+$/.test(item.amount))) throw new Error("GAMEFI_AWARD_NOT_VERIFIED");
  return { asset: "USDC", chainId: "10143", rewardRaw: report.plan.reward, allocations: report.plan.allocations,
    transactions: report.operations.map((item: any) => ({ seat: item.seat, kind: item.kind, amount: item.amount, txHash: item.txHash })) };
}
function purchaseSummary(report: any, trusted: NonNullable<StoredRun["trusted"]>): NonNullable<GameFiRun["purchase"]> {
  if (report?.mode !== "holdem-monad-purchase" || !["Complete", "Stopped"].includes(report.phase) || report.chainId !== "10143"
    || report.source?.matchId !== trusted.matchId || report.source.replayDigest !== trusted.replayDigest || report.source.reportDigest !== trusted.reportDigest
    || !Number.isSafeInteger(report.physicalInferenceAttempts) || !Array.isArray(report.purchases)) throw new Error("GAMEFI_PURCHASE_NOT_VERIFIED");
  return { phase: report.phase, physicalInferenceAttempts: report.physicalInferenceAttempts, purchases: report.purchases.map((item: any) => {
    if (![0, 1].includes(item.seat) || !["Delivered", "Unknown", "Stopped"].includes(item.state)) throw new Error("GAMEFI_PURCHASE_NOT_VERIFIED");
    if (item.receipt && (!/^0x[0-9a-f]{64}$/i.test(item.receipt.txHash) || !/^[0-9]+$/.test(item.receipt.price)
      || !/^0x[0-9a-f]{64}$/i.test(item.receipt.paymentId))) throw new Error("GAMEFI_PURCHASE_NOT_VERIFIED");
    return { seat: item.seat, state: item.state, ...(item.receipt ? { receipt: { txHash: item.receipt.txHash, price: item.receipt.price, paymentId: item.receipt.paymentId } } : {}) };
  }) };
}

export class GameFiRunner {
  private readonly directory: string;
  private task?: Promise<void>;
  constructor(readonly loaded: LoadedGameFiConfig, private readonly dependencies: GameFiRunnerDependencies = {}) {
    this.directory = join(loaded.config.dataDirectory, ".runner");
  }
  private empty(): Journal { return { version: 1, configDigest: this.loaded.digest, runs: [] }; }
  private check(state: Journal): Journal {
    if (state.version !== 1 || state.configDigest !== this.loaded.digest || !Array.isArray(state.runs)) throw new GameFiError("GAMEFI_JOURNAL_CONFIG_MISMATCH", 503);
    return state;
  }
  private async read(): Promise<Journal> {
    try { return this.check(JSON.parse(await readFile(join(this.directory, "session.json"), "utf8"))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return this.empty(); throw error; }
  }
  private async refresh(run: StoredRun) {
    const session = await optionalJson(join(run.sourceDirectory, ".private/game/session.json"));
    if (session) {
      run.game = publicLiveHand(session as LiveHandSession); run.matchId = run.game.matchId;
      if (run.stages.game?.state === "Intent" && run.status === "Running" && !this.task) {
        const pid = run.stages.game.childPid;
        if (!pid || !alive(pid)) { run.status = "Paused"; run.reason = "GAMEFI_PROCESS_INTERRUPTED"; run.recoverable = run.game.phase === "Complete"; }
      }
    }
    const award = await optionalJson(join(run.sourceDirectory, "monad-delivery-report.json"));
    if (award && run.trusted) run.award = awardSummary(award, run.trusted);
    const purchase = await optionalJson(join(run.sourceDirectory, "monad-purchase-report.json"));
    if (purchase && run.trusted) run.purchase = purchaseSummary(purchase, run.trusted);
    if (["Queued", "Running"].includes(run.status) && !this.task) {
      const pid = run.stages[run.stage]?.childPid;
      if (!pid || !alive(pid)) { run.status = "Paused"; run.reason = "GAMEFI_PROCESS_INTERRUPTED";
        run.recoverable = run.stage !== "game" || run.stages.game === undefined || run.game?.phase === "Complete"; }
    }
  }
  async snapshot(id?: string): Promise<GameFiSnapshot> {
    if (id) requestId(id);
    const state = await this.read(), runs = state.runs.slice(-20).reverse();
    if (id) {
      const run = state.runs.find(item => item.requestId === id); if (!run) throw new GameFiError("GAMEFI_RUN_NOT_FOUND", 404);
      await this.refresh(run); return { enabled: true, rewardKinds: this.loaded.config.rewardKinds, run: publicRun(run), runs: runs.map(publicRun) };
    }
    for (const run of runs) await this.refresh(run);
    return { enabled: true, rewardKinds: this.loaded.config.rewardKinds, runs: runs.map(publicRun) };
  }
  /** A persistent global writer lock remains held until every launched stage has ended. */
  async command(command: GameFiCommand): Promise<GameFiSnapshot> {
    if (command.action === "start" && !this.loaded.config.rewardKinds.includes(command.rewardKind)) throw new GameFiError("GAMEFI_REWARD_DISABLED", 403);
    requestId(command.requestId);
    // An identical request is read-only even while its first dispatch holds the writer lock.
    const observed = await this.read(), previous = observed.runs.find(run => run.requestId === command.requestId);
    if (command.action === "start" && previous) {
      if (previous.rewardKind !== command.rewardKind) throw new GameFiError("GAMEFI_REQUEST_ID_CONFLICT", 409);
      return this.snapshot(command.requestId);
    }
    const store = new SessionStore<Journal>(this.directory);
    try { await store.start(command.action === "recover"); }
    catch (error) {
      const failure = code(error);
      if (command.action === "start" && failure === "SESSION_BUSY") {
        const started = (await this.read()).runs.find(item => item.requestId === command.requestId);
        if (started) {
          if (started.rewardKind !== command.rewardKind) throw new GameFiError("GAMEFI_REQUEST_ID_CONFLICT", 409);
          return this.snapshot(command.requestId);
        }
      }
      throw new GameFiError(failure === "SESSION_BUSY" ? "GAMEFI_BUSY" : failure, 409);
    }
    let retained = false;
    try {
      const state = this.check(await store.read() ?? this.empty());
      let run = state.runs.find(item => item.requestId === command.requestId);
      if (command.action === "start") {
        if (run) {
          if (run.rewardKind !== command.rewardKind) throw new GameFiError("GAMEFI_REQUEST_ID_CONFLICT", 409);
          return this.snapshot(command.requestId);
        }
        if (state.activeRequestId) {
          const active = state.runs.find(item => item.requestId === state.activeRequestId);
          if (active) await this.refresh(active);
          // A stopped/unknown game cannot dispatch again. A new request has a new deck and journal.
          if (!active || active.stage !== "game" || !["Paused", "Stopped"].includes(active.status)
            || (active.stages.game?.childPid && alive(active.stages.game.childPid))) throw new GameFiError("GAMEFI_RECOVERY_REQUIRED", 409);
          delete state.activeRequestId;
        }
        if (state.runs.length >= 1000) throw new GameFiError("GAMEFI_JOURNAL_CAP_REACHED", 503);
        const root = join(this.loaded.config.dataDirectory, "runs", command.requestId); await privateDirectory(root);
        const holdemConfigFile = join(root, "holdem.json"), sourceDirectory = join(root, "evidence");
        await atomicJson(holdemConfigFile, { ...this.loaded.holdem, sourceDirectory });
        run = { requestId: command.requestId, rewardKind: command.rewardKind, status: "Queued", stage: "game", createdAt: now(), updatedAt: now(),
          recoverable: false, sourceDirectory, holdemConfigFile, stages: {} };
        state.runs.push(run);
      } else {
        if (!run) throw new GameFiError("GAMEFI_RUN_NOT_FOUND", 404);
        if (run.status === "Complete" || run.status === "Stopped") return this.snapshot(command.requestId);
        if (state.activeRequestId && state.activeRequestId !== run.requestId) throw new GameFiError("GAMEFI_BUSY", 409);
        const pid = run.stages[run.stage]?.childPid;
        if (pid && alive(pid)) throw new GameFiError("GAMEFI_CHILD_STILL_RUNNING", 409);
      }
      state.activeRequestId = run.requestId; run.status = "Queued"; delete run.reason; run.updatedAt = now();
      await store.write(state);
      const selected = run;
      this.task = this.execute(state, selected, store).finally(() => { this.task = undefined; });
      void this.task.catch(() => undefined); // Durable failure evidence is read on the next query/recovery.
      retained = true;
      // Detach only the Promise from the HTTP request; the cross-process lock is retained.
      return { enabled: true, rewardKinds: this.loaded.config.rewardKinds, run: publicRun(selected) };
    } finally { if (!retained) await store.close(); }
  }
  async waitUntilIdle() { await this.task; }
  private async trustedGame(run: StoredRun) {
    const reportBytes = await privateFile(join(run.sourceDirectory, "report.json")), report = JSON.parse(reportBytes);
    if (report.mode !== "holdem-live" || report.upstreamMode !== "real-kimi-system-https-proxy" || report.phase !== "Complete" || report.verified !== true) throw new Error("GAMEFI_GAME_NOT_VERIFIED");
    const session = JSON.parse(await privateFile(join(run.sourceDirectory, ".private/game/session.json"))) as LiveHandSession;
    const replay = JSON.parse(await privateFile(join(run.sourceDirectory, ".private/trusted-replay.json"))), hand = replayHand(replay), view = hand.view(0);
    if (view.handStatus !== "complete" || !view.result || session.phase !== "Complete" || session.matchId !== report.matchId) throw new Error("GAMEFI_TRUSTED_TERMINAL_REQUIRED");
    assert.deepEqual(session.replay, hand.exportTrustedReplay(), "GAMEFI_SESSION_REPLAY_MISMATCH");
    run.game = publicLiveHand(session); assert.deepEqual(run.game.result, report.game.result, "GAMEFI_RESULT_MISMATCH");
    const trusted = { matchId: report.matchId, replayDigest: sha(JSON.stringify(hand.exportTrustedReplay())), reportDigest: sha(reportBytes), winners: [...view.result.winners] };
    if (report.reward?.replayDigest !== trusted.replayDigest) throw new Error("GAMEFI_TRUSTED_REPLAY_DIGEST_REQUIRED");
    if (run.trusted) assert.deepEqual(run.trusted, trusted, "GAMEFI_TRUSTED_SOURCE_CHANGED");
    run.trusted = trusted; run.matchId = trusted.matchId;
  }
  private async grant(run: StoredRun): Promise<GameFiCreditGrant> {
    const input = { grantId: run.requestId, matchId: run.trusted!.matchId, replayDigest: run.trusted!.replayDigest, winners: run.trusted!.winners };
    if (this.dependencies.grant) return this.dependencies.grant(input);
    const { InferenceRewardLedger } = await import("../inference-rewards/index.js");
    const ledger = await InferenceRewardLedger.open(join(this.loaded.config.dataDirectory, "credits"), { accounts: this.loaded.holdem.players, recover: true });
    try { return await ledger.grantTerminal({ ...input, players: this.loaded.holdem.players }); }
    finally { await ledger.close(); }
  }
  private async execute(state: Journal, run: StoredRun, store: SessionStore<Journal>) {
    const persist = async () => { run.updatedAt = now(); await store.write(state); };
    try {
      while (run.status !== "Complete" && run.status !== "Stopped") {
        const stage = run.stage, previous = run.stages[stage];
        run.status = "Running"; run.recoverable = false; await persist();
        if (stage === "game" && previous?.state === "Intent") {
          // This is inspection only. A game dispatch intent is never run a second time.
          await this.refresh(run);
          try { await this.trustedGame(run); }
          catch {
            run.status = run.game?.phase === "Stopped" && !run.game.attempts.some(item => item.outcome === "OutcomeUnknown" || item.outcome === "IntentPersisted") ? "Stopped" : "Paused";
            run.reason = run.game?.reason ?? "GAMEFI_GAME_RESULT_UNKNOWN_NO_REDISPATCH"; run.recoverable = false;
            if (run.status === "Stopped") delete state.activeRequestId;
            await persist(); break;
          }
        } else {
          run.stages[stage] = { state: "Intent" }; await persist();
          if (stage === "credits") {
            await this.trustedGame(run);
            const grant = await this.grant(run);
            run.credits = { grantId: grant.grantId, matchId: grant.matchId, replayDigest: grant.replayDigest, model: grant.model,
              allocations: grant.allocations, winners: grant.winners, createdAt: grant.createdAt };
          } else {
            if (stage !== "game") await this.trustedGame(run);
            const exitCode = await (this.dependencies.launch ?? launchGameFiStage)({ stage, sourceDirectory: run.sourceDirectory, holdemConfigFile: run.holdemConfigFile,
              upstreamConfigFile: this.loaded.holdem.monadConfigFile, recover: previous !== undefined, rpcUrlFile: this.loaded.config.rpcUrlFile,
              rpcTransport: this.loaded.config.rpcTransport }, async pid => { run.stages[stage]!.childPid = pid; await persist(); },
              async diagnostic => { run.stages[stage]!.diagnostic = diagnostic; await persist(); });
            delete run.stages[stage]!.childPid; run.stages[stage]!.exitCode = exitCode; await persist(); await this.refresh(run);
            if (stage === "game") {
              try { await this.trustedGame(run); }
              catch {
                run.status = run.game?.phase === "Stopped" && !run.game.attempts.some(item => item.outcome === "OutcomeUnknown" || item.outcome === "IntentPersisted") ? "Stopped" : "Paused";
                run.reason = run.game?.reason ?? (exitCode ? "GAMEFI_GAME_PROCESS_FAILED" : "GAMEFI_GAME_RESULT_UNKNOWN_NO_REDISPATCH"); run.recoverable = false;
                if (run.status === "Stopped") delete state.activeRequestId;
                await persist(); break;
              }
            } else if (stage === "award") {
              const report = await optionalJson(join(run.sourceDirectory, "monad-delivery-report.json"));
              if (!report && exitCode !== 0) throw new Error(run.stages[stage]!.diagnostic?.code ?? "GAMEFI_STAGE_PROCESS_FAILED");
              run.award = awardSummary(report, run.trusted!);
            } else {
              const report = await optionalJson(join(run.sourceDirectory, "monad-purchase-report.json"));
              if (!report && exitCode !== 0) throw new Error(run.stages[stage]!.diagnostic?.code ?? "GAMEFI_STAGE_PROCESS_FAILED");
              run.purchase = purchaseSummary(report, run.trusted!);
              if (run.purchase.phase !== "Complete" || report.verification?.cashConserved !== true || report.evidence?.paymentReceiptsCanonical !== true) throw new Error("GAMEFI_PURCHASE_OUTCOME_UNKNOWN_NO_REDISPATCH");
            }
          }
        }
        run.stages[stage]!.state = "Complete";
        if (stage === "game") run.stage = run.rewardKind === "usdc" ? "award" : "credits";
        else if (stage === "award") run.stage = "purchase";
        else { run.status = "Complete"; run.recoverable = false; delete state.activeRequestId; }
        await persist();
      }
    } catch (error) {
      run.status = "Paused"; run.reason = code(error); run.recoverable = run.stage !== "game";
      await persist();
    } finally { await store.close(); }
  }
}
