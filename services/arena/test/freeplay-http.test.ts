import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import type { PlayMatchView, PlaySession } from "../../../frontend/lib/play-types.js";

const base = process.env.ARENA_PLAY_TEST_URL;
test("free arena HTTP: two independent seats, replay, conflict, private cards and transport boundaries", { skip: !base }, async () => {
  const api = new URL("/api/arena/play", base).toString();
  async function post(body: object, seatToken?: string, extra: Record<string, string> = {}) {
    const response = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json", Origin: new URL(base!).origin,
      ...(seatToken ? { Authorization: `Bearer ${seatToken}` } : {}), ...extra }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function get(id: string, seatToken?: string): Promise<PlayMatchView> {
    const response = await fetch(`${api}?matchId=${id}`, { headers: seatToken ? { Authorization: `Bearer ${seatToken}` } : undefined });
    assert.equal(response.status, 200); return response.json();
  }
  const create = { op: "create", game: "holdem", mode: "invite", chips: 500, hands: 1, requestId: randomUUID() };
  const a = await post(create); assert.equal(a.status, 200);
  const owner = a.body as PlaySession;
  assert.deepEqual((await post(create)).body, owner);
  const joined = await post({ op: "join", inviteCode: owner.match.inviteCode, requestId: randomUUID() });
  assert.equal(joined.status, 200); const guest = joined.body as PlaySession;
  assert.notEqual(owner.seatToken, guest.seatToken);
  for (const client of [owner, guest]) {
    const view = await get(owner.match.id, client.seatToken);
    assert.equal((await post({ op: "ready", matchId: owner.match.id, version: view.version, requestId: randomUUID() }, client.seatToken)).status, 200);
  }
  const view = await get(owner.match.id, owner.seatToken);
  assert.equal((view.gameView!.holeCards as string[]).length, 2);
  const publicView = await get(owner.match.id);
  assert.deepEqual(publicView.gameView!.holeCards, []);
  assert.equal(publicView.inviteCode, undefined);
  assert.ok(!JSON.stringify(publicView).includes(owner.seatToken!));
  const ownMove = { op: "action", matchId: owner.match.id, version: view.version, requestId: randomUUID(), action: { type: "call" } };
  const move = await post(ownMove, owner.seatToken); assert.equal(move.status, 200);
  assert.deepEqual((await post(ownMove, owner.seatToken)).body, move.body);
  assert.equal((await post({ ...ownMove, requestId: randomUUID() }, owner.seatToken)).status, 409);
  assert.equal((await post({ ...ownMove, action: { type: "fold" } }, owner.seatToken)).body.error, "REQUEST_ID_REUSED");
  const wrongToken = await fetch(`${api}?matchId=${owner.match.id}`, { headers: { Authorization: "Bearer false-token" } });
  assert.equal(wrongToken.status, 401);
  const fakeWinner = await post({ ...create, requestId: randomUUID(), winner: 0, deck: [] }); assert.equal(fakeWinner.status, 400);
  assert.equal((await post(create, undefined, { Origin: "https://malicious.example" })).status, 403);
  assert.equal((await post({ ...create, extra: "x".repeat(20001) })).status, 413);
  const invalid = await fetch(api, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }); assert.equal(invalid.status, 400);
  const wrongType = await fetch(api, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }); assert.equal(wrongType.status, 415);
  let turns = 0;
  while ((await get(owner.match.id)).status === "playing") {
    const current = await get(owner.match.id);
    const client = current.actor === 0 ? owner : guest;
    assert.equal((await post({ op: "auto", matchId: current.id, version: current.version, requestId: randomUUID() }, client.seatToken)).status, 200);
    assert.ok(++turns < 20);
  }
  const final = await get(owner.match.id);
  assert.ok(final.outcome); assert.equal(final.deadline, null);
  const list = await (await fetch(api)).json();
  assert.ok(list.history.some((match: { id: string }) => match.id === owner.match.id));
  assert.ok(!JSON.stringify(list).includes(owner.seatToken!)); assert.ok(!JSON.stringify(list).includes(guest.seatToken!));
});
