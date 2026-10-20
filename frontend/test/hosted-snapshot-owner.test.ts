import test from "node:test";
import assert from "node:assert/strict";
import { authenticatedSnapshotOwner, HostedClientError, type HostedSnapshot } from "../lib/hosted-client.js";

const owner = "0x48aEd9c702B97A18A520edA3BB04d959453f0B80", other = "0x1111111111111111111111111111111111111111";
const empty: HostedSnapshot = { agents: [], runs: [], models: [] };
test("authenticated snapshots recover a zero-Agent owner without using a local pending command or wallet hint", () => {
  assert.equal(authenticatedSnapshotOwner({ ...empty, owner }), owner);
  assert.equal(authenticatedSnapshotOwner(empty), null);
  assert.equal(authenticatedSnapshotOwner({ ...empty, pending: { owner }, wallet: other } as HostedSnapshot), null);
});
test("legacy nonempty snapshots recover only one consistent owner and explicit identity cannot conflict with an Agent", () => {
  const agents = [{ owner }, { owner: owner.toLowerCase() }] as HostedSnapshot["agents"];
  assert.equal(authenticatedSnapshotOwner({ ...empty, agents }), owner);
  assert.equal(authenticatedSnapshotOwner({ ...empty, owner, agents }), owner);
  for (const value of [
    { ...empty, owner: "invalid" }, { ...empty, owner: null },
    { ...empty, owner, agents: [{ owner: other }] },
    { ...empty, agents: [{ owner }, { owner: other }] },
    { ...empty, owner, agents: [{}] },
  ]) assert.throws(() => authenticatedSnapshotOwner(value as HostedSnapshot), (error: unknown) => error instanceof HostedClientError && error.status === 503);
});
