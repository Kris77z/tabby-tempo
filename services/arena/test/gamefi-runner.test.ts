import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { createHand } from "../src/holdem/index.js";
import { HOLDEM_LIVE_LIMITS, publicLiveHand, type LiveHandSession } from "../src/holdem/live.js";
import { atomicJson } from "../src/protocol.js";
import { GameFiRunner, parseGameFiCommand, parseGameFiRunnerConfig, type GameFiLaunch, type LoadedGameFiConfig } from "../src/gamefi-runner/index.js";
import { InferenceRewardLedger } from "../src/inference-rewards/index.js";
import { parseGameFiStageDiagnostic } from "../src/gamefi-runner/diagnostic.js";

const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const txHash = `0x${"a".repeat(64)}`, paymentId = `0x${"b".repeat(64)}`;
async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "agentfuel-gamefi-runner-")));
  const loaded: LoadedGameFiConfig = { digest: "operator-fixed-config", config: { version: 1, dataDirectory: directory, holdemConfigFile: join(directory, "template.json"),
    rpcTransport: "direct", rewardKinds: ["usdc", "llm-credits"] }, holdem: { version: 1, sourceDirectory: join(directory, "old-evidence"), monadConfigFile: join(directory, "upstream.json"),
    deploymentStateFile: join(directory, "deployment.json"), sponsor: { wallet: `0x${"1".repeat(40)}`, keyFile: join(directory, "sponsor-key") },
    players: [{ agentId: "1", wallet: `0x${"2".repeat(40)}`, keyFile: join(directory, "player0-key") }, { agentId: "2", wallet: `0x${"3".repeat(40)}`, keyFile: join(directory, "player1-key") }] } };
  return { directory, loaded, clean: () => rm(directory, { recursive: true, force: true }) };
}
async function completeGame(input: GameFiLaunch) {
  const hand = createHand({ initialStack: 1000, smallBlind: 5, bigBlind: 10 });
  hand.act(hand.view(0).actor!, { type: "fold" });
  const session: LiveHandSession = { version: 1, matchId: `live-${randomUUID()}`, phase: "Complete", startedAtMs: Date.now(), deadlineMs: Date.now() + 600000,
    limits: HOLDEM_LIVE_LIMITS, replay: hand.exportTrustedReplay(), turns: [] };
  const game = publicLiveHand(session), replayDigest = sha(JSON.stringify(session.replay));
  await atomicJson(join(input.sourceDirectory, ".private/game/session.json"), session);
  await atomicJson(join(input.sourceDirectory, ".private/trusted-replay.json"), session.replay);
  await atomicJson(join(input.sourceDirectory, "report.json"), { mode: "holdem-live", upstreamMode: "real-kimi-system-https-proxy", phase: "Complete", verified: true,
    matchId: session.matchId, game: { result: game.result }, reward: { replayDigest }, privateKey: "MUST_NOT_ESCAPE_REPORT", rawText: "MUST_NOT_ESCAPE_REPORT" });
}
async function binding(input: GameFiLaunch) {
  const reportBytes = await readFile(join(input.sourceDirectory, "report.json"), "utf8"), report = JSON.parse(reportBytes);
  return { matchId: report.matchId, replayDigest: report.reward.replayDigest, reportDigest: sha(reportBytes) };
}
async function completeAward(input: GameFiLaunch) {
  await atomicJson(join(input.sourceDirectory, "monad-delivery-report.json"), { mode: "holdem-monad", phase: "RewardDeposited", stageComplete: true, chainId: "10143",
    plan: { source: await binding(input), reward: "100000", allocations: ["0", "100000"] }, verification: { rewardConserved: true },
    operations: [{ seat: 1, kind: "reward", amount: "100000", txHash }, { seat: 1, kind: "deposit", amount: "100000", txHash }], secret: "MUST_NOT_ESCAPE_AWARD" });
}
async function purchase(input: GameFiLaunch, complete = true) {
  await atomicJson(join(input.sourceDirectory, "monad-purchase-report.json"), { mode: "holdem-monad-purchase", phase: complete ? "Complete" : "Stopped", chainId: "10143",
    source: await binding(input), physicalInferenceAttempts: 1, purchases: [{ seat: 1, state: complete ? "Delivered" : "Unknown", receipt: { txHash, paymentId, price: "10000", authorization: "MUST_NOT_ESCAPE_PURCHASE" } }],
    verification: { cashConserved: complete }, evidence: { paymentReceiptsCanonical: complete }, rawText: "MUST_NOT_ESCAPE_PURCHASE" });
}
function assertPublic(value: unknown) {
  const output = JSON.stringify(value);
  for (const secret of ["MUST_NOT_ESCAPE", "sourceDirectory", "keyFile", "rawText", "holeCards", '"deck"', "trusted-replay", "requestDigest", "messages"])
    assert.equal(output.includes(secret), false, secret);
}

test("GameFi request grammar only allows start/recover with a UUID and an enumerated reward", () => {
  const requestId = randomUUID();
  assert.deepEqual(parseGameFiCommand({ action: "start", requestId, rewardKind: "usdc" }), { action: "start", requestId, rewardKind: "usdc" });
  for (const command of [{ action: "start", requestId, rewardKind: "usdc", output: "/tmp/evidence" }, { action: "start", requestId, rewardKind: "usdc", command: "curl" },
    { action: "recover", requestId, winner: 1 }, { action: "start", requestId: "../../tmp", rewardKind: "usdc" }]) assert.throws(() => parseGameFiCommand(command));
  assert.throws(() => parseGameFiRunnerConfig({ version: 1, dataDirectory: "/tmp/data", holdemConfigFile: "/tmp/private", rewardKinds: ["usdc"], executable: "curl" }));
});

test("CLI failure evidence only keeps a fixed code and whitelisted transport diagnostics", () => {
  const raw = 'HOLDEM_PREFLIGHT_NOT_READY\n{"diagnostic":{"ethersCode":"SERVER_ERROR","httpStatus":503,"rpcCode":-32005,"url":"https://secret.invalid/private-key","signedTransaction":"PRIVATE"}}\nPRIVATE KEY VALUE';
  assert.deepEqual(parseGameFiStageDiagnostic(raw), { code: "HOLDEM_PREFLIGHT_NOT_READY", diagnostic: { ethersCode: "SERVER_ERROR", rpcCode: -32005, httpStatus: 503 } });
  assert.equal(JSON.stringify(parseGameFiStageDiagnostic(raw)).includes("PRIVATE"), false);
});

test("GameFi runs the three fixed stages once and a repeated request returns the same terminal run", async () => {
  const f = await fixture(), calls: GameFiLaunch[] = [], runner = new GameFiRunner(f.loaded, { launch: async input => {
    calls.push(input); if (input.stage === "game") await completeGame(input); else if (input.stage === "award") await completeAward(input); else await purchase(input); return 0;
  } });
  try {
    const requestId = randomUUID(); await runner.command({ action: "start", requestId, rewardKind: "usdc" }); await runner.waitUntilIdle();
    const first = await runner.snapshot(requestId); assert.equal(first.run!.status, "Complete"); assert.equal(first.run!.stage, "purchase");
    assert.deepEqual(calls.map(call => [call.stage, call.recover]), [["game", false], ["award", false], ["purchase", false]]);
    const afterRestart = new GameFiRunner(f.loaded, { launch: async () => { throw new Error("MUST_NOT_LAUNCH"); } });
    assert.deepEqual(await afterRestart.command({ action: "start", requestId, rewardKind: "usdc" }), first);
    await assert.rejects(afterRestart.command({ action: "start", requestId, rewardKind: "llm-credits" }), /GAMEFI_REQUEST_ID_CONFLICT/);
    assertPublic(first); assert.equal(JSON.stringify(calls[0]).includes("old-evidence"), false);
    const runConfig = JSON.parse(await readFile(calls[0].holdemConfigFile, "utf8")); assert.equal(runConfig.sourceDirectory, calls[0].sourceDirectory);
    assert.equal(f.loaded.holdem.sourceDirectory, join(f.directory, "old-evidence"));
  } finally { await f.clean(); }
});

test("a global writer prevents a second game and duplicate requests remain readable during dispatch", async () => {
  const f = await fixture(); let finish!: () => void, count = 0;
  const gate = new Promise<void>(done => { finish = done; });
  const runner = new GameFiRunner(f.loaded, { launch: async input => { count++; await gate; await completeGame(input); return 0; },
    grant: async input => ({ ...input, model: "kimi-k2.6", allocations: [0, 4096], createdAt: new Date().toISOString() }) });
  try {
    const requestId = randomUUID(); await runner.command({ action: "start", requestId, rewardKind: "llm-credits" });
    const second = new GameFiRunner(f.loaded, { launch: async () => { throw new Error("MUST_NOT_LAUNCH"); } });
    assert.equal((await second.command({ action: "start", requestId, rewardKind: "llm-credits" })).run!.requestId, requestId);
    await assert.rejects(second.command({ action: "start", requestId: randomUUID(), rewardKind: "usdc" }), /GAMEFI_BUSY/);
    finish(); await runner.waitUntilIdle(); assert.equal(count, 1);
  } finally { finish(); await runner.waitUntilIdle(); await f.clean(); }
});

test("restart recovers the award stage from its original journal and never repeats the game", async () => {
  const f = await fixture(), calls: [string, boolean][] = [], requestId = randomUUID();
  const first = new GameFiRunner(f.loaded, { launch: async input => { calls.push([input.stage, input.recover]); if (input.stage === "game") await completeGame(input); return input.stage === "game" ? 0 : 1; } });
  try {
    await first.command({ action: "start", requestId, rewardKind: "usdc" }); await first.waitUntilIdle();
    assert.equal((await first.snapshot(requestId)).run!.status, "Paused");
    const restart = new GameFiRunner(f.loaded, { launch: async input => {
      calls.push([input.stage, input.recover]); assert.notEqual(input.stage, "game");
      if (input.stage === "award") await completeAward(input); else await purchase(input); return 0;
    } });
    await restart.command({ action: "recover", requestId }); await restart.waitUntilIdle();
    assert.equal((await restart.snapshot(requestId)).run!.status, "Complete");
    assert.deepEqual(calls, [["game", false], ["award", false], ["award", true], ["purchase", false]]);
  } finally { await f.clean(); }
});

test("a failed award CLI exposes its fixed cause instead of a missing-report error", async () => {
  const f = await fixture(), id = randomUUID();
  try {
    const runner = new GameFiRunner(f.loaded, { launch: async (input, _spawn, onDiagnostic) => {
      if (input.stage === "game") { await completeGame(input); return 0; }
      await onDiagnostic!({ code: "HOLDEM_PREFLIGHT_NOT_READY", diagnostic: { httpStatus: 503 } }); return 1;
    } });
    await runner.command({ action: "start", requestId: id, rewardKind: "usdc" }); await runner.waitUntilIdle();
    const run = (await runner.snapshot(id)).run!; assert.equal(run.status, "Paused"); assert.equal(run.reason, "HOLDEM_PREFLIGHT_NOT_READY");
    const journal = JSON.parse(await readFile(join(f.directory, ".runner/session.json"), "utf8"));
    assert.deepEqual(journal.runs[0].stages.award.diagnostic, { code: "HOLDEM_PREFLIGHT_NOT_READY", diagnostic: { httpStatus: 503 } });
  } finally { await f.clean(); }
});

test("unknown inference remains paused through recovery and a failed game is never redispatched", async () => {
  const f = await fixture(), calls: [string, boolean][] = [], requestId = randomUUID();
  const runner = new GameFiRunner(f.loaded, { launch: async input => {
    calls.push([input.stage, input.recover]); if (input.stage === "game") await completeGame(input); else if (input.stage === "award") await completeAward(input); else await purchase(input, false); return 0;
  } });
  try {
    await runner.command({ action: "start", requestId, rewardKind: "usdc" }); await runner.waitUntilIdle();
    assert.equal((await runner.snapshot(requestId)).run!.purchase!.purchases[0].state, "Unknown");
    await runner.command({ action: "recover", requestId }); await runner.waitUntilIdle();
    const stopped = await runner.snapshot(requestId); assert.equal(stopped.run!.status, "Paused"); assert.equal(stopped.run!.reason, "GAMEFI_PURCHASE_OUTCOME_UNKNOWN_NO_REDISPATCH");
    assert.deepEqual(calls, [["game", false], ["award", false], ["purchase", false], ["purchase", true]]); assertPublic(stopped);
    const other = await fixture(); let launches = 0;
    try {
      const unknownGame = new GameFiRunner(other.loaded, { launch: async () => { launches++; return 1; } });
      const id = randomUUID(); await unknownGame.command({ action: "start", requestId: id, rewardKind: "usdc" }); await unknownGame.waitUntilIdle();
      await unknownGame.command({ action: "recover", requestId: id }); await unknownGame.waitUntilIdle();
      assert.equal(launches, 1); assert.equal((await unknownGame.snapshot(id)).run!.recoverable, false);
    } finally { await other.clean(); }
  } finally { await f.clean(); }
});

test("a stale process journal with a completed game grants credits once without relaunching game or USDC", async () => {
  const f = await fixture(), requestId = randomUUID(), root = join(f.directory, "runs", requestId), sourceDirectory = join(root, "evidence");
  const input: GameFiLaunch = { stage: "game", sourceDirectory, holdemConfigFile: join(root, "holdem.json"), upstreamConfigFile: "unused", recover: false, rpcTransport: "direct" };
  try {
    await completeGame(input);
    const store = new SessionStore(join(f.directory, ".runner")); await store.start();
    await store.write({ version: 1, configDigest: f.loaded.digest, activeRequestId: requestId, runs: [{ requestId, sourceDirectory, holdemConfigFile: input.holdemConfigFile,
      rewardKind: "llm-credits", status: "Running", stage: "game", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), recoverable: false,
      stages: { game: { state: "Intent", childPid: 2147483647 } } }] }); await store.close();
    let grants = 0;
    const runner = new GameFiRunner(f.loaded, { launch: async () => { throw new Error("MUST_NOT_LAUNCH"); }, grant: async trusted => {
      grants++; assert.equal(trusted.matchId.startsWith("live-"), true); assert.match(trusted.replayDigest, /^[a-f0-9]{64}$/);
      assert.deepEqual(trusted.winners, [1]); return { ...trusted, model: "kimi-k2.6", allocations: [0, 4096], createdAt: new Date().toISOString() };
    } });
    const before = await runner.snapshot(requestId); assert.equal(before.run!.status, "Paused"); assert.equal(before.run!.recoverable, true);
    await runner.command({ action: "recover", requestId }); await runner.waitUntilIdle();
    assert.equal((await runner.snapshot(requestId)).run!.status, "Complete"); assert.equal(grants, 1);
    await runner.command({ action: "recover", requestId }); assert.equal(grants, 1); assertPublic(await runner.snapshot(requestId));
  } finally { await f.clean(); }
});

test("the real credit ledger receives a terminal replay grant exactly once", async () => {
  const f = await fixture(), id = randomUUID(); let launches = 0;
  try {
    const runner = new GameFiRunner(f.loaded, { launch: async input => { launches++; assert.equal(input.stage, "game"); await completeGame(input); return 0; } });
    await runner.command({ action: "start", requestId: id, rewardKind: "llm-credits" }); await runner.waitUntilIdle();
    const completed = await runner.snapshot(id); assert.equal(completed.run!.status, "Complete"); assert.deepEqual(completed.run!.credits!.allocations, [0, 4096]);
    await runner.command({ action: "start", requestId: id, rewardKind: "llm-credits" }); assert.equal(launches, 1);
    const ledger = await InferenceRewardLedger.open(join(f.directory, "credits"), { accounts: f.loaded.holdem.players });
    try { assert.equal((await ledger.balance(f.loaded.holdem.players[1])).grantedTokens, 4096); } finally { await ledger.close(); }
    assertPublic(completed);
  } finally { await f.clean(); }
});

test("the IPC worker exits without a command and can launch the fixed CLI help without a model or chain call", async () => {
  const root = await realpath(fileURLToPath(new URL("../../../", import.meta.url))), loader = join(root, "node_modules/tsx/dist/loader.mjs"), worker = join(root, "scripts/gamefi-runner-worker.ts");
  const start = () => spawn(process.execPath, ["--import", loader, worker], { cwd: root, stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const disconnected = start();
  const closed = new Promise<number | null>(done => disconnected.once("exit", done));
  disconnected.disconnect(); await closed;
  const child = start(), completed = new Promise<number | null>(done => child.once("exit", done));
  child.send({ version: 1, script: "holdem-live.ts", args: ["--import", loader, join(root, "scripts/holdem-live.ts"), "--help"] });
  assert.equal(await completed, 0);
});
