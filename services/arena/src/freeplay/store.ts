import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { resolve } from "node:path";
import { createFreeGame, restoreFreeGame, type FreeGame, type FreeGameReplay } from "@agentfuel/arena/freeplay-games";
import { PrivatePlayStateFile, PlayStorageError } from "./persistence.js";
import type { PlayAction, PlayCommand, PlayGame, PlayList, PlayLog, PlayMatchSummary, PlayMatchView, PlayOutcome, PlaySeat, PlaySession } from "../../../../frontend/lib/play-types.js";

export class PlayError extends Error {
  constructor(public code: string, public status = 400, public version?: number) { super(code); }
}
interface PrivatePlayer { seat: PlaySeat; name: string; kind: "human" | "bot"; ready: boolean; token: string }
interface StoredMatch {
  id: string; game: PlayGame; mode: "challenge" | "invite"; status: "waiting" | "playing" | "finished" | "cancelled";
  version: number; createdAt: string; updatedAt: string; players: PrivatePlayer[];
  deadlineMs: number | null; config: PlayMatchSummary["config"]; outcome: PlayOutcome | null;
  inviteCode?: string; engine?: FreeGame; logs: PlayLog[];
  requests: Map<string, { digest: string; result: PlaySession }>;
}
type SavedRequest = { digest: string; result: PlaySession };
interface SavedMatch extends Omit<StoredMatch, "engine" | "requests"> {
  engine?: FreeGameReplay; requests: [string, SavedRequest][];
}
interface SavedState { schema: 1; matches: SavedMatch[]; creations: [string, SavedRequest][] }
export interface PlayStoreOptions { statePath?: string }
const timeoutMs = 10 * 60 * 1000;
const games: PlayGame[] = ["holdem", "gomoku", "chess", "balatro"];
const token = () => randomBytes(32).toString("base64url");
const equalToken = (a: string, b: string) => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
};
const nameOf = (value: unknown, fallback: string) => {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !value.trim() || value.trim().length > 40 || /[\u0000-\u001f]/.test(value)) throw new PlayError("INVALID_NAME");
  return value.trim();
};
const allowedKeys = (value: object, allowed: string[]) => Object.keys(value).every(key => allowed.includes(key));
function normalized(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalized);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, normalized(item)]));
  return value;
}

/** Local free games only: no RPC, paid model, escrow, prize or loan path exists here. */
export class PlayStore {
  #matches = new Map<string, StoredMatch>();
  #creations = new Map<string, SavedRequest>();
  #storage?: PrivatePlayStateFile;
  #dirty = false;
  #generation = 0;
  #views = new Map<string, { version: number; view: PlayMatchView }>();
  #listCache?: { generation: number; list: PlayList };
  #nextDeadline = Infinity;
  constructor(private now: () => number = Date.now, options: PlayStoreOptions = {}) {
    if (options.statePath !== undefined) {
      this.#storage = new PrivatePlayStateFile(options.statePath);
      this.#read();
    }
  }
  #changed() { this.#dirty = true; this.#generation++; }
  #saved(): SavedState {
    return { schema: 1, matches: [...this.#matches.values()].map(({ engine, requests, ...match }) => ({
      ...structuredClone(match), ...(engine ? { engine: engine.exportTrustedReplay() } : {}), requests: structuredClone([...requests]),
    })), creations: structuredClone([...this.#creations]) };
  }
  #restore(input: unknown) {
    if (input === undefined) {
      this.#matches = new Map(); this.#creations = new Map();
    } else {
      const state = input as SavedState;
      const bad = () => { throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE"); };
      if (!state || typeof state !== "object" || !allowedKeys(state, ["schema", "matches", "creations"])
        || state.schema !== 1 || !Array.isArray(state.matches) || state.matches.length > 500 || !Array.isArray(state.creations)) bad();
      const matches = new Map<string, StoredMatch>();
      for (const saved of state.matches) {
        if (!saved || !allowedKeys(saved, ["id", "game", "mode", "status", "version", "createdAt", "updatedAt", "players", "deadlineMs", "config", "outcome", "inviteCode", "engine", "logs", "requests"])
          || typeof saved.id !== "string" || !/^[a-f0-9-]{36}$/.test(saved.id) || matches.has(saved.id)
          || !games.includes(saved.game) || !["invite", "challenge"].includes(saved.mode)
          || !["waiting", "playing", "finished", "cancelled"].includes(saved.status) || !Number.isSafeInteger(saved.version) || saved.version < 1
          || !Number.isFinite(Date.parse(saved.createdAt)) || !Number.isFinite(Date.parse(saved.updatedAt))
          || (saved.deadlineMs !== null && !Number.isFinite(saved.deadlineMs))
          || !Array.isArray(saved.players) || saved.players.length < 1 || saved.players.length > 2
          || saved.players.some((player, index) => !player || !allowedKeys(player, ["seat", "name", "kind", "ready", "token"])
            || player.seat !== index || typeof player.name !== "string" || !["human", "bot"].includes(player.kind)
            || typeof player.ready !== "boolean" || typeof player.token !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(player.token))
          || !saved.config || !allowedKeys(saved.config, ["chips", "hands", "actionTimeoutMs"])
          || ![500, 1000, 5000].includes(saved.config.chips) || !Number.isInteger(saved.config.hands) || saved.config.hands < 0 || saved.config.hands > 100
          || saved.config.actionTimeoutMs !== timeoutMs || !Array.isArray(saved.logs) || !Array.isArray(saved.requests)
          || (saved.status === "playing" && !saved.engine)
          || (saved.engine && (saved.engine.game !== saved.game || saved.engine.chips !== saved.config.chips || saved.engine.hands !== saved.config.hands))) bad();
        const { engine, requests, ...match } = saved;
        const requestMap = this.#requestMap(requests);
        const restored = { ...structuredClone(match), ...(engine ? { engine: restoreFreeGame(engine) } : {}), requests: requestMap };
        matches.set(restored.id, restored);
      }
      const creations = this.#requestMap(state.creations);
      this.#matches = matches; this.#creations = creations;
    }
    this.#dirty = false; this.#generation++; this.#views.clear(); this.#listCache = undefined;
    this.#deadlines();
  }
  #requestMap(entries: [string, SavedRequest][]) {
    const result = new Map<string, SavedRequest>();
    for (const entry of entries) {
      if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || result.has(entry[0])
        || !entry[1] || !allowedKeys(entry[1], ["digest", "result"]) || typeof entry[1].digest !== "string"
        || !entry[1].result || typeof entry[1].result !== "object" || !entry[1].result.match) throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE");
      result.set(entry[0], structuredClone(entry[1]));
    }
    return result;
  }
  #deadlines() {
    this.#nextDeadline = Math.min(Infinity, ...[...this.#matches.values()].map(match => match.deadlineMs ?? Infinity));
  }
  #read(force = false) {
    try {
      const snapshot = this.#storage?.readIfChanged(force);
      if (snapshot) this.#restore(snapshot.state);
    } catch {
      // A syntactically valid snapshot can still fail schema/game validation.
      this.#storage?.invalidate();
      throw new PlayError("ARENA_STORAGE_UNAVAILABLE", 503);
    }
  }
  #commit() {
    if (this.#dirty) this.#storage?.save(this.#saved());
    this.#dirty = false; this.#deadlines();
  }
  #mutation<T>(action: () => T): T {
    const before = this.#saved();
    try { const result = action(); this.#commit(); return result; }
    catch (error) {
      // Restore private class state as well as tokens, deadlines and retry records.
      this.#restore(before);
      if (error instanceof PlayStorageError) {
        // A directory-fsync failure can happen after rename; reload the actual commit.
        this.#read(true);
        throw new PlayError(error.code, 503);
      }
      throw error;
    }
  }
  #write<T>(action: () => T): T {
    try {
      const run = () => { this.#read(); return action(); };
      return this.#storage ? this.#storage.withLock(run) : run();
    } catch (error) { if (error instanceof PlayStorageError) throw new PlayError(error.code, 503); throw error; }
  }
  #expirations() {
    if (this.now() < this.#nextDeadline) return;
    this.#mutation(() => { for (const match of this.#matches.values()) this.#expire(match); });
  }
  #refresh() {
    this.#read();
    if (this.now() >= this.#nextDeadline) this.#write(() => this.#expirations());
  }

  #log(match: StoredMatch, kind: PlayLog["kind"], message: string, seat?: PlaySeat, action?: PlayAction) {
    match.logs.push({ sequence: match.logs.length + 1, time: new Date(this.now()).toISOString(), kind, message,
      ...(seat === undefined ? {} : { seat }), ...(action ? { action: structuredClone(action) } : {}) });
  }
  #change(match: StoredMatch) { match.version++; match.updatedAt = new Date(this.now()).toISOString(); this.#changed(); }
  #finish(match: StoredMatch, outcome: PlayOutcome) {
    match.status = "finished"; match.outcome = outcome; match.deadlineMs = null;
    this.#change(match);
    this.#log(match, "finished", match.game === "balatro" ? outcome.winner === 0 ? "挑战成功：通过全部 12 个关卡。" : `挑战结束：${outcome.reason}`
      : outcome.kind === "draw" ? `对局结束：${outcome.reason}` : `${match.players.find(player => player.seat === outcome.winner)?.name ?? "玩家"} 获胜：${outcome.reason}`);
  }
  #cancel(match: StoredMatch, reason: string) {
    match.status = "cancelled"; match.outcome = null; match.deadlineMs = null;
    this.#change(match); this.#log(match, "finished", `对局已取消：${reason}`);
  }
  #expire(match: StoredMatch) {
    if (!match.deadlineMs || this.now() < match.deadlineMs || ["finished", "cancelled"].includes(match.status)) return;
    if (match.status === "waiting") this.#cancel(match, "READY_TIMEOUT");
    else {
      const actor = match.engine!.actor();
      this.#finish(match, actor === null ? { kind: "draw", reason: "ACTION_TIMEOUT" }
        : { kind: "win", winner: actor === 0 ? 1 : 0, reason: "ACTION_TIMEOUT" });
    }
  }
  #seat(match: StoredMatch, bearer?: string): PlaySeat | null {
    if (!bearer) return null;
    const player = match.players.find(player => player.kind === "human" && equalToken(player.token, bearer));
    if (!player) throw new PlayError("UNAUTHORIZED", 401);
    return player.seat;
  }
  #summary(match: StoredMatch): PlayMatchSummary {
    return { id: match.id, game: match.game, mode: match.mode, status: match.status, version: match.version,
      createdAt: match.createdAt, updatedAt: match.updatedAt,
      players: match.players.map(({ token: _token, ...player }) => player),
      actor: match.status === "playing" ? match.engine!.actor() : null,
      deadline: match.deadlineMs === null ? null : new Date(match.deadlineMs).toISOString(),
      config: { ...match.config }, outcome: match.outcome ? { ...match.outcome } : null };
  }
  #view(match: StoredMatch, seat: PlaySeat | null): PlayMatchView {
    const key = `${match.id}:${seat ?? "public"}`, cached = this.#views.get(key);
    if (cached?.version === match.version) return structuredClone(cached.view);
    const view: PlayMatchView = { ...this.#summary(match), yourSeat: seat,
      ...(seat !== null && match.inviteCode ? { inviteCode: match.inviteCode } : {}),
      gameView: match.engine ? { ...match.engine.view(seat) } : null,
      logs: match.logs.map(log => log.action?.type === "discard" && seat !== log.seat
        ? { ...log, action: { type: "discard", cards: [] } } : structuredClone(log)) };
    this.#views.set(key, { version: match.version, view });
    return structuredClone(view);
  }
  #match(id: unknown) {
    if (typeof id !== "string" || !/^[a-f0-9-]{36}$/.test(id)) throw new PlayError("INVALID_MATCH_ID");
    const match = this.#matches.get(id);
    if (!match) throw new PlayError("MATCH_NOT_FOUND", 404);
    return match;
  }
  list(): PlayList {
    this.#refresh();
    if (this.#listCache?.generation === this.#generation) return structuredClone(this.#listCache.list);
    const all = [...this.#matches.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const list: PlayList = { matches: all.filter(match => !["finished", "cancelled"].includes(match.status)).slice(0, 50).map(match => this.#summary(match)),
      history: all.filter(match => ["finished", "cancelled"].includes(match.status)).slice(0, 50).map(match => this.#summary(match)),
      bot: { name: "AgentFuel Bot", description: "免费的服务端策略 Bot，按合法规则行动，不调用 LLM。" },
      storage: this.#storage ? "本地文件保存练习会话，刷新与服务重启可恢复。虚拟筹码与 USDC 奖励分开。"
        : "本地服务内存会话；刷新可恢复，服务重启后清空。虚拟筹码与 USDC 奖励分开。" };
    this.#listCache = { generation: this.#generation, list };
    return structuredClone(list);
  }
  get(id: string, bearer?: string): PlayMatchView {
    this.#refresh();
    const match = this.#match(id);
    const seat = this.#seat(match, bearer);
    return this.#view(match, seat);
  }
  #validate(raw: unknown): asserts raw is PlayCommand {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PlayError("INVALID_COMMAND");
    const c = raw as Record<string, unknown>;
    if (typeof c.requestId !== "string" || !/^[A-Za-z0-9_-]{16,100}$/.test(c.requestId.replaceAll("-", "_"))) throw new PlayError("INVALID_REQUEST_ID");
    const base = ["op", "requestId"];
    const extras = c.op === "create" ? ["game", "mode", "name", "chips", "hands"]
      : c.op === "join" ? ["matchId", "inviteCode", "name"]
      : c.op === "action" ? ["matchId", "version", "action"]
      : ["matchId", "version"];
    if (!["create", "join", "ready", "action", "auto", "resign", "cancel"].includes(c.op as string) || !allowedKeys(c, [...base, ...extras])) throw new PlayError("INVALID_COMMAND");
    if (!["create", "join"].includes(c.op as string) && (!Number.isSafeInteger(c.version) || (c.version as number) < 1)) throw new PlayError("INVALID_VERSION");
  }
  command(raw: unknown, bearer?: string): PlaySession {
    this.#validate(raw);
    return this.#write(() => {
      // Commit elapsed deadlines before validating versions against that verdict.
      this.#expirations();
      return this.#mutation(() => this.#command(raw, bearer));
    });
  }
  #command(c: PlayCommand, bearer?: string): PlaySession {
    const digest = JSON.stringify(normalized(c));
    if (c.op === "create") {
      const prior = this.#creations.get(c.requestId);
      if (prior) {
        if (prior.digest !== digest) throw new PlayError("REQUEST_ID_REUSED", 409);
        return structuredClone(prior.result);
      }
      if (!games.includes(c.game) || !["challenge", "invite"].includes(c.mode) || (c.chips !== undefined && ![500, 1000, 5000].includes(c.chips))) throw new PlayError("INVALID_CONFIG");
      if (c.game === "balatro" && c.mode !== "challenge") throw new PlayError("BALATRO_SOLO_ONLY");
      const hands = c.hands ?? (c.mode === "challenge" ? 10 : 3);
      if (!Number.isInteger(hands) || hands < 0 || hands > 100) throw new PlayError("INVALID_HANDS");
      if (this.#matches.size >= 500) {
        const completed = [...this.#matches.values()].filter(match => ["finished", "cancelled"].includes(match.status)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (!completed.length) throw new PlayError("ARENA_BUSY", 429);
        this.#matches.delete(completed[0].id);
        for (const [key, creation] of this.#creations) if (creation.result.match.id === completed[0].id) this.#creations.delete(key);
        for (const key of this.#views.keys()) if (key.startsWith(`${completed[0].id}:`)) this.#views.delete(key);
      }
      const seatToken = token();
      const stamp = new Date(this.now()).toISOString();
      const match: StoredMatch = { id: randomUUID(), game: c.game, mode: c.mode, status: "waiting", version: 1,
        createdAt: stamp, updatedAt: stamp, players: [{ seat: 0, name: nameOf(c.name, "我的 Agent"), kind: "human", ready: false, token: seatToken }],
        deadlineMs: this.now() + timeoutMs, config: { chips: c.chips ?? 1000, hands, actionTimeoutMs: timeoutMs }, outcome: null,
        logs: [], requests: new Map(), ...(c.mode === "invite" ? { inviteCode: randomBytes(16).toString("hex") } : {}) };
      if (c.mode === "challenge") match.players.push({ seat: 1, name: c.game === "balatro" ? "关卡主持" : "AgentFuel Bot", kind: "bot", ready: true, token: token() });
      this.#log(match, "created", c.game === "balatro" ? "免费小丑牌关卡挑战已创建，等待你准备。"
        : c.mode === "challenge" ? "免费官方 Bot 挑战已创建，等待你准备。" : "免费邀请对局已创建，等待另一位玩家加入。", 0);
      this.#matches.set(match.id, match);
      this.#changed();
      const result = { match: this.#view(match, 0), seatToken };
      this.#creations.set(c.requestId, { digest, result: structuredClone(result) });
      return result;
    }
    if (c.op === "join") {
      if (typeof c.inviteCode !== "string" || !/^[a-f0-9]{32}$/.test(c.inviteCode)) throw new PlayError("INVITE_CODE_REQUIRED");
      const match = [...this.#matches.values()].find(match => match.inviteCode === c.inviteCode && (!c.matchId || match.id === c.matchId));
      if (!match) throw new PlayError("INVITE_NOT_FOUND", 404);
      const prior = match.requests.get(`join:${c.requestId}`);
      if (prior) {
        if (prior.digest !== digest) throw new PlayError("REQUEST_ID_REUSED", 409);
        return structuredClone(prior.result);
      }
      if (match.status !== "waiting" || match.players.length !== 1) throw new PlayError("INVITE_FULL_OR_CLOSED", 409);
      const seatToken = token();
      match.players.push({ seat: 1, name: nameOf(c.name, "受邀 Agent"), kind: "human", ready: false, token: seatToken });
      this.#change(match);
      this.#log(match, "joined", `${match.players[1].name} 加入对局。`, 1);
      const result = { match: this.#view(match, 1), seatToken };
      match.requests.set(`join:${c.requestId}`, { digest, result: structuredClone(result) });
      this.#dirty = true;
      return result;
    }
    const match = this.#match(c.matchId);
    const seat = this.#seat(match, bearer);
    if (seat === null) throw new PlayError("UNAUTHORIZED", 401);
    const requestKey = `${seat}:${c.requestId}`;
    const prior = match.requests.get(requestKey);
    if (prior) {
      if (prior.digest !== digest) throw new PlayError("REQUEST_ID_REUSED", 409);
      return structuredClone(prior.result);
    }
    if (c.version !== match.version) throw new PlayError("VERSION_CONFLICT", 409, match.version);
    if (["finished", "cancelled"].includes(match.status)) throw new PlayError("GAME_FINISHED", 409, match.version);
    if (c.op === "cancel") {
      if (match.status !== "waiting") throw new PlayError("ALREADY_STARTED", 409, match.version);
      this.#cancel(match, "PLAYER_CANCELLED");
    } else if (c.op === "resign") {
      if (match.status !== "playing") throw new PlayError("NOT_STARTED_USE_CANCEL", 409, match.version);
      this.#finish(match, { kind: "win", winner: seat === 0 ? 1 : 0, reason: "RESIGNED" });
    }
    else if (c.op === "ready") {
      if (match.status !== "waiting") throw new PlayError("ALREADY_STARTED", 409, match.version);
      const player = match.players.find(player => player.seat === seat)!;
      if (!player.ready) { player.ready = true; this.#change(match); this.#log(match, "ready", `${player.name} 已准备。`, seat); }
      if (match.players.length === 2 && match.players.every(player => player.ready)) {
        match.engine = createFreeGame(match.game, match.config.chips, match.config.hands);
        match.status = "playing"; match.deadlineMs = this.now() + timeoutMs;
        this.#change(match); this.#log(match, "ready", "双方就绪，裁判开始对局。每次行动限时 10 分钟。");
        this.#botTurn(match);
      }
    } else {
      if (match.status !== "playing") throw new PlayError("NOT_STARTED", 409, match.version);
      if (match.engine!.actor() !== seat) throw new PlayError("OUT_OF_TURN", 409, match.version);
      const action = c.op === "action" ? c.action : match.engine!.botAction();
      if (!action) throw new PlayError("NO_LEGAL_ACTION", 409, match.version);
      this.#act(match, seat, action);
      this.#botTurn(match);
    }
    const result = { match: this.#view(match, seat) };
    match.requests.set(requestKey, { digest, result: structuredClone(result) });
    this.#dirty = true;
    return result;
  }
  #act(match: StoredMatch, seat: PlaySeat, action: PlayAction) {
    try { match.engine!.act(seat, action); }
    catch (error) { throw new PlayError(error instanceof Error && /^[A-Z][A-Z0-9_]+$/.test(error.message) ? error.message : "ILLEGAL_ACTION"); }
    this.#change(match); match.deadlineMs = this.now() + timeoutMs;
    this.#log(match, "action", `${match.players.find(player => player.seat === seat)!.name} · ${action.type}`, seat, action);
    const outcome = match.engine!.outcome();
    if (outcome) this.#finish(match, outcome);
  }
  #botTurn(match: StoredMatch) {
    let steps = 0;
    while (match.status === "playing") {
      const actor = match.engine!.actor();
      if (actor === null || match.players.find(player => player.seat === actor)?.kind !== "bot") return;
      if (++steps > 100) throw new PlayError("BOT_STEP_LIMIT", 500);
      const action = match.engine!.botAction();
      if (!action) throw new PlayError("BOT_NO_LEGAL_ACTION", 500);
      this.#act(match, actor, action);
    }
  }
}

const globalStore = globalThis as typeof globalThis & { agentfuelFreePlay?: PlayStore };
export const playStore = globalStore.agentfuelFreePlay ??= new PlayStore(Date.now, {
  statePath: process.env.ARENA_PLAY_STATE_PATH?.trim() || resolve(process.cwd(), ".data", "arena-freeplay.json"),
});
