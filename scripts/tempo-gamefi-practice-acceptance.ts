import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { atomicJson, digest } from "../services/arena/src/protocol.js";

const [originArg, directoryArg] = process.argv.slice(2);
assert.equal(originArg, "http://127.0.0.1:3028", "Only the local Tempo frontend is in this acceptance scope");
assert.ok(directoryArg, "Usage: tempo-gamefi-practice-acceptance.ts ORIGIN PRIVATE_DIRECTORY [--recover]");
const directory = resolve(directoryArg), file = join(directory, "session.json");
const lock = new SessionStore(join(directory, "writer")); await lock.start(process.argv.includes("--recover"));
let state: any;
try {
  try { state = JSON.parse(await readFile(file, "utf8")); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  state ??= { version: 1, origin: originArg, startedAt: new Date().toISOString(), games: {} };
  assert.equal(state.origin, originArg);
  const save = () => atomicJson(file, state);
  const request = async (body: unknown, token?: string) => {
    const response = await fetch(originArg + "/api/arena/play", { method: "POST", headers: { origin: originArg, "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body), signal: AbortSignal.timeout(20000) });
    const result = await response.json(); assert.equal(response.status, 200, result.error); return result;
  };
  const read = async (id: string, token?: string) => {
    const response = await fetch(originArg + "/api/arena/play?matchId=" + id, { headers: token ? { authorization: `Bearer ${token}` } : {}, signal: AbortSignal.timeout(20000) });
    assert.equal(response.status, 200); return response.json();
  };
  for (const game of ["holdem", "gomoku", "chess", "balatro"]) {
    const entry = state.games[game] ??= { commands: {} }; await save();
    const command = async (name: string, input: object, token?: string) => {
      const row = entry.commands[name] ??= { input: { ...input, requestId: randomUUID() } }; await save();
      row.response ??= await request(row.input, token); await save();
      assert.deepEqual(await request(row.input, token), row.response, "Original command replay must return its persisted response");
      row.replayMatched = true; await save(); return row.response;
    };
    const created = await command("create", { op: "create", game, mode: "challenge", name: "Tempo local practice acceptance", chips: 1000, hands: 1 });
    const id = created.match.id, token = created.seatToken;
    assert.ok(token); assert.equal(created.match.game, game);
    const ready = await command("ready", { op: "ready", matchId: id, version: created.match.version }, token);
    assert.equal(ready.match.status, "playing");
    const acted = await command("auto", { op: "auto", matchId: id, version: ready.match.version }, token);
    assert.ok(acted.match.logs.some((log: any) => log.kind === "action"));
    let final = await read(id, token);
    if (final.status === "playing") final = (await command("resign", { op: "resign", matchId: id, version: final.version }, token)).match;
    assert.equal(final.status, "finished"); assert.ok(final.outcome);
    const publicView = await read(id); assert.equal(publicView.yourSeat, null);
    assert.ok(!JSON.stringify(publicView).includes(token));
    entry.summary = { matchId: id, status: final.status, outcome: final.outcome, actionCount: final.logs.filter((log: any) => log.kind === "action").length,
      finishMethod: entry.commands.resign ? "explicit acceptance resignation after legal play" : "game rules", finalVersion: final.version,
      originalRequestsReplayMatched: Object.values(entry.commands).every((row: any) => row.replayMatched), spectatorHasNoSeatToken: true,
      commandDigests: Object.fromEntries(Object.entries(entry.commands).map(([name, row]: [string, any]) => [name, { requestId: row.input.requestId, requestDigest: digest(JSON.stringify(row.input)), responseDigest: digest(JSON.stringify(row.response)) }])) };
    await save(); console.log(JSON.stringify({ game, ...entry.summary }));
  }
  const evidence = { version: 1, observedAt: new Date().toISOString(), origin: originArg, source: "real local HTTP API", modelsDispatched: 0, chainTransactions: 0, rewards: 0,
    scope: "All four games are server-refereed local practice with virtual assets and strategy bots. Resignation is not a rules victory.", games: Object.fromEntries(Object.entries(state.games).map(([game, entry]: [string, any]) => [game, entry.summary])) };
  await atomicJson(join(directory, "public-evidence.json"), evidence);
} finally { await lock.close(); }
