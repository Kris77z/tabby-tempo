import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { PlayError, PlayStore } from "../src/freeplay/store.js";
import { PrivatePlayStateFile, PlayStorageError } from "../src/freeplay/persistence.js";
import { createFreeGame, restoreFreeGame } from "../src/freeplay/games.js";
import { orderedBalatroDeck } from "../src/balatro/rules.js";
import type { PlayCommand, PlaySession } from "../../../frontend/lib/play-types.js";

const requestId = () => randomUUID();
const codeError = (run: () => unknown, code: string) => assert.throws(run, error => error instanceof PlayError && error.code === code);
const ready = (store: PlayStore, session: PlaySession) => store.command({ op: "ready", matchId: session.match.id,
  version: store.get(session.match.id, session.seatToken).version, requestId: requestId() }, session.seatToken);
function temporary(t: { after(callback: () => void): void }) {
  const directory = mkdtempSync(join(tmpdir(), "agentfuel-freeplay-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, path: join(directory, "private", "state.json") };
}
const nodeArgs = ["--import", "tsx", "--input-type=module", "-e"];
const storeUrl = new URL("../src/freeplay/store.ts", import.meta.url).href;
const worker = `
  import { PlayStore } from ${JSON.stringify(storeUrl)};
  let raw = ''; for await (const part of process.stdin) raw += part;
  const input = JSON.parse(raw);
  const store = new PlayStore(Date.now, { statePath: input.path });
  try {
    const result = input.command ? store.command(input.command, input.token) : store.get(input.id, input.token);
    process.stdout.write(JSON.stringify({ result }));
  } catch (error) { process.stdout.write(JSON.stringify({ error: error.code, version: error.version })); }
  if (input.hold) setInterval(() => {}, 1000);
`;
function child(input: object) {
  const result = spawnSync(process.execPath, [...nodeArgs, worker], { cwd: process.cwd(), input: JSON.stringify(input), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { result?: PlaySession; error?: string; version?: number };
}
function concurrentChild(input: object): Promise<{ result?: PlaySession; error?: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, worker], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "";
    child.stdout.on("data", part => output += part); child.stderr.on("data", part => errors += part);
    child.on("error", reject);
    child.on("close", status => status === 0 ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    child.stdin.end(JSON.stringify(input));
  });
}
function killedChild(input: object): Promise<{ result: PlaySession }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [...nodeArgs, worker], { cwd: process.cwd(), stdio: ["pipe", "pipe", "pipe"] });
    let output = "", errors = "", killed = false;
    child.stdout.on("data", part => {
      output += part;
      try { JSON.parse(output); } catch { return; }
      killed = true; child.kill("SIGKILL");
    });
    child.stderr.on("data", part => errors += part); child.on("error", reject);
    child.on("close", (_status, signal) => killed && signal === "SIGKILL" ? resolve(JSON.parse(output)) : reject(new Error(errors)));
    child.stdin.end(JSON.stringify({ ...input, hold: true }));
  });
}

test("trusted game journals restore actual private draws and chess repetition history", () => {
  const holdem = createFreeGame("holdem", 500, 3);
  holdem.act(0, { type: "fold" }); // The second hand has its own already-generated private deck.
  const restored = restoreFreeGame(holdem.exportTrustedReplay());
  for (const seat of [0, 1, null] as const) assert.deepEqual(restored.view(seat), holdem.view(seat));
  for (let step = 0; step < 5; step++) {
    const actor = holdem.actor()!, action = holdem.botAction()!;
    holdem.act(actor, action); restored.act(actor, action);
    assert.deepEqual(restored.view(0), holdem.view(0));
  }
  const balatro = restoreFreeGame({ version: 1, game: "balatro", chips: 500, hands: 1,
    random: [{ kind: "balatro-deck", values: orderedBalatroDeck() }], actions: [] });
  balatro.act(0, { type: "play", cards: orderedBalatroDeck().slice(0, 5) });
  assert.equal((balatro.view(0) as { phase: string }).phase, "reward");
  assert.deepEqual(restoreFreeGame(balatro.exportTrustedReplay()).view(0), balatro.view(0));
  balatro.act(0, balatro.botAction()!);
  const balatroCopy = restoreFreeGame(balatro.exportTrustedReplay());
  const card = (balatro.view(0) as { hand: string[] }).hand[0];
  balatro.act(0, { type: "discard", cards: [card] }); balatroCopy.act(0, { type: "discard", cards: [card] });
  assert.deepEqual(balatroCopy.view(0), balatro.view(0));
  assert.deepEqual((balatroCopy.view(null) as { hand: string[] }).hand, []);
  const chess = createFreeGame("chess", 500, 1);
  const cycle = [[0, "g1", "f3"], [1, "g8", "f6"], [0, "f3", "g1"], [1, "f6", "g8"]] as const;
  for (const [seat, from, to] of [...cycle, ...cycle.slice(0, 2)]) chess.act(seat, { type: "move", from, to });
  const chessCopy = restoreFreeGame(chess.exportTrustedReplay());
  for (const [seat, from, to] of cycle.slice(2)) chessCopy.act(seat, { type: "move", from, to });
  assert.deepEqual(chessCopy.outcome(), { kind: "draw", reason: "threefold_repetition" });
});

test("restart retains four games, both seat tokens, hidden-card boundaries and exact request retries", t => {
  const { path } = temporary(t), store = new PlayStore(Date.now, { statePath: path });
  const create: PlayCommand = { op: "create", game: "holdem", mode: "invite", chips: 500, hands: 3, requestId: requestId() };
  const first = store.command(create);
  const join: PlayCommand = { op: "join", inviteCode: first.match.inviteCode, requestId: requestId() };
  const second = store.command(join);
  ready(store, first); ready(store, second);
  const move: PlayCommand = { op: "action", matchId: first.match.id, version: store.get(first.match.id).version,
    requestId: requestId(), action: { type: "call" } };
  const accepted = store.command(move, first.seatToken);
  const sessions = [first, second];
  for (const game of ["gomoku", "chess", "balatro"] as const) {
    const session = store.command({ op: "create", game, mode: "challenge", chips: 500, hands: 1, requestId: requestId() });
    ready(store, session);
    const view = store.get(session.match.id, session.seatToken);
    store.command({ op: "action", matchId: view.id, version: view.version, requestId: requestId(), action: game === "balatro"
      ? { type: "discard", cards: [(view.gameView!.hand as string[])[0]] }
      : game === "chess" ? { type: "move", from: "e2", to: "e4" } : { type: "place", row: 7, col: 7 } }, session.seatToken);
    sessions.push(session);
  }
  const before = sessions.map(session => store.get(session.match.id, session.seatToken));
  const restarted = new PlayStore(Date.now, { statePath: path });
  assert.deepEqual(sessions.map(session => restarted.get(session.match.id, session.seatToken)), before);
  assert.deepEqual(restarted.command(create), first); assert.deepEqual(restarted.command(join), second);
  assert.deepEqual(restarted.command(move, first.seatToken), accepted);
  codeError(() => restarted.command({ ...move, action: { type: "fold" } }, first.seatToken), "REQUEST_ID_REUSED");
  codeError(() => restarted.command({ ...move, requestId: requestId() }, first.seatToken), "VERSION_CONFLICT");
  codeError(() => restarted.get(first.match.id, "wrong-token"), "UNAUTHORIZED");
  const publicText = JSON.stringify([restarted.list(), ...sessions.map(session => restarted.get(session.match.id))]);
  for (const session of sessions) assert.ok(!publicText.includes(session.seatToken!));
  assert.ok(!publicText.includes('"deck"')); assert.ok(!publicText.includes('"random"')); assert.ok(!publicText.includes('"inviteCode"'));
  assert.deepEqual(restarted.get(first.match.id).gameView!.holeCards, []);
  const balatro = restarted.get(sessions.at(-1)!.match.id);
  assert.deepEqual(balatro.gameView!.hand, []); assert.deepEqual(balatro.logs.at(-1)!.action, { type: "discard", cards: [] });
  assert.equal(statSync(path).mode & 0o777, 0o600); assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
});

test("failed disk commit exposes no applied action or retry record and retry succeeds once", t => {
  const { path } = temporary(t), store = new PlayStore(Date.now, { statePath: path });
  const session = store.command({ op: "create", game: "balatro", mode: "challenge", requestId: requestId() });
  ready(store, session);
  const before = store.get(session.match.id, session.seatToken), disk = readFileSync(path, "utf8");
  const command: PlayCommand = { op: "action", matchId: before.id, version: before.version, requestId: requestId(),
    action: { type: "discard", cards: [(before.gameView!.hand as string[])[0]] } };
  const creation: PlayCommand = { op: "create", game: "chess", mode: "invite", requestId: requestId() };
  const save = PrivatePlayStateFile.prototype.save;
  try {
    PrivatePlayStateFile.prototype.save = function (state) {
      if (this.path === path) throw new PlayStorageError("ARENA_STORAGE_UNAVAILABLE");
      save.call(this, state);
    };
    codeError(() => store.command(command, session.seatToken), "ARENA_STORAGE_UNAVAILABLE");
    codeError(() => store.command(creation), "ARENA_STORAGE_UNAVAILABLE");
  } finally { PrivatePlayStateFile.prototype.save = save; }
  assert.equal(readFileSync(path, "utf8"), disk);
  assert.deepEqual(store.get(before.id, session.seatToken), before);
  assert.deepEqual(new PlayStore(Date.now, { statePath: path }).get(before.id, session.seatToken), before);
  const result = store.command(command, session.seatToken);
  assert.equal(result.match.version, before.version + 1);
  assert.deepEqual(store.command(command, session.seatToken), result);
  const created = store.command(creation);
  assert.deepEqual(store.command(creation), created); assert.equal(store.list().matches.length, 2);
});

test("restored deadlines commit once, reads do not rewrite snapshots and external commits invalidate caches", t => {
  const { path } = temporary(t); let clock = 0;
  const store = new PlayStore(() => clock, { statePath: path });
  const waiting = store.command({ op: "create", game: "gomoku", mode: "invite", requestId: requestId() });
  const active = store.command({ op: "create", game: "chess", mode: "challenge", requestId: requestId() }); ready(store, active);
  const fingerprint = () => { const stat = statSync(path, { bigint: true }); return `${stat.ino}:${stat.mtimeNs}:${stat.size}`; };
  const original = fingerprint();
  for (let i = 0; i < 100; i++) { store.get(active.match.id, active.seatToken); store.list(); }
  assert.equal(fingerprint(), original);
  const owned = store.get(active.match.id, active.seatToken); owned.logs.length = 0;
  assert.ok(store.get(active.match.id, active.seatToken).logs.length > 0);
  const other = new PlayStore(() => clock, { statePath: path }), view = other.get(active.match.id, active.seatToken);
  other.command({ op: "action", matchId: view.id, version: view.version, action: { type: "move", from: "e2", to: "e4" }, requestId: requestId() }, active.seatToken);
  assert.deepEqual(store.get(view.id, active.seatToken), other.get(view.id, active.seatToken));
  clock = 10 * 60 * 1000;
  const restarted = new PlayStore(() => clock, { statePath: path });
  codeError(() => restarted.command({ op: "cancel", matchId: waiting.match.id, version: waiting.match.version,
    requestId: requestId() }, waiting.seatToken), "VERSION_CONFLICT");
  assert.equal(restarted.get(waiting.match.id).status, "cancelled");
  assert.deepEqual(restarted.get(active.match.id).outcome, { kind: "win", winner: 1, reason: "ACTION_TIMEOUT" });
  const expired = fingerprint(); restarted.list(); restarted.get(active.match.id); assert.equal(fingerprint(), expired);
  assert.equal(new PlayStore(() => clock, { statePath: path }).get(active.match.id).version, restarted.get(active.match.id).version);
});

test("fresh Node processes resume tokens/retries and competing versions never both commit", async t => {
  const { path } = temporary(t);
  const create: PlayCommand = { op: "create", game: "gomoku", mode: "challenge", requestId: requestId() };
  const first = child({ path, command: create }).result!;
  assert.deepEqual(child({ path, command: create }).result, first);
  const started = (await killedChild({ path, token: first.seatToken, command: { op: "ready", matchId: first.match.id,
    version: first.match.version, requestId: requestId() } })).result;
  const commands: PlayCommand[] = [6, 8].map(col => ({ op: "action", matchId: first.match.id, version: started.match.version,
    requestId: requestId(), action: { type: "place", row: 7, col } }));
  const results = await Promise.all(commands.map(command => concurrentChild({ path, token: first.seatToken, command })));
  assert.equal(results.filter(result => result.result).length, 1);
  const losing = results.findIndex(result => !result.result);
  assert.ok(["VERSION_CONFLICT", "ARENA_STORAGE_BUSY"].includes(results[losing].error!));
  assert.equal(child({ path, token: first.seatToken, command: commands[losing] }).error, "VERSION_CONFLICT");
  const winning = results.findIndex(result => result.result);
  assert.deepEqual(child({ path, token: first.seatToken, command: commands[winning] }).result, results[winning].result);
  assert.equal(new PlayStore(Date.now, { statePath: path }).get(first.match.id).version, started.match.version + 2);
});

test("live writer locks return retryable busy, dead process locks recover and corrupt state fails closed", t => {
  const { path } = temporary(t), store = new PlayStore(Date.now, { statePath: path });
  const command: PlayCommand = { op: "create", game: "gomoku", mode: "challenge", requestId: requestId() };
  store.command(command);
  const lock = `${path}.lock`; mkdirSync(lock); writeFileSync(join(lock, "owner"), JSON.stringify({ pid: process.pid }));
  codeError(() => store.command({ ...command, requestId: requestId() }), "ARENA_STORAGE_BUSY");
  rmSync(lock, { recursive: true });
  const exited = spawnSync(process.execPath, ["-e", "process.stdout.write(String(process.pid))"], { encoding: "utf8" });
  mkdirSync(lock); writeFileSync(join(lock, "owner"), JSON.stringify({ pid: Number(exited.stdout) }));
  const second = store.command({ ...command, requestId: requestId() }); assert.ok(second.match.id);
  mkdirSync(lock); writeFileSync(join(lock, "owner"), JSON.stringify({ pid: Number(exited.stdout) }));
  mkdirSync(join(lock, "reclaim")); writeFileSync(join(lock, "reclaim", "owner"), JSON.stringify({ pid: Number(exited.stdout) }));
  assert.ok(store.command({ ...command, requestId: requestId() }).match.id);
  mkdirSync(lock); const old = new Date(Date.now() - 31_000); utimesSync(lock, old, old);
  assert.ok(store.command({ ...command, requestId: requestId() }).match.id);
  chmodSync(path, 0o644); new PlayStore(Date.now, { statePath: path }); assert.equal(statSync(path).mode & 0o777, 0o600);
  writeFileSync(path, "{");
  codeError(() => new PlayStore(Date.now, { statePath: path }), "ARENA_STORAGE_UNAVAILABLE");
  codeError(() => store.get(second.match.id), "ARENA_STORAGE_UNAVAILABLE");
  writeFileSync(path, JSON.stringify({ schema: 2, matches: [], creations: [] }));
  codeError(() => store.get(second.match.id), "ARENA_STORAGE_UNAVAILABLE");
  codeError(() => store.get(second.match.id), "ARENA_STORAGE_UNAVAILABLE");
  codeError(() => store.command({ ...command, requestId: requestId() }), "ARENA_STORAGE_UNAVAILABLE");
});
