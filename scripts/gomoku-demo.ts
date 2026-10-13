import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { read, key } from "../services/underwriter/test/fixture.js";
import { createGomokuFixture } from "./gomoku-fixture.js";
import { replayMatch, type MatchSession } from "../services/arena/src/gomoku/match.js";

export async function runGomokuDemo(outputPath: string) {
  const output = resolve(outputPath); const local = await createGomokuFixture(output);
  const config = local.config("controlled-black-win"); const configFile = join(output, "match-config.json"); const sessionDirectory = join(output, "match");
  const blackKey = join(output, ".synthetic-black.key"); const whiteKey = join(output, ".synthetic-white.key");
  const cli = async (extra: string[] = [], matchConfig = configFile, matchDirectory = sessionDirectory) => {
    const child = spawn(process.execPath, ["--import", "tsx", new URL("./gomoku.ts", import.meta.url).pathname, "--config", matchConfig, "--output", matchDirectory,
      "--black-key-file", blackKey, "--white-key-file", whiteKey, ...extra], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; child.stdout!.on("data", data => { stdout += String(data); }); child.stderr!.on("data", data => { stderr += String(data); });
    const [code] = await once(child, "exit"); if (code !== 0) throw new Error(`Gomoku CLI failed: ${stderr}`);
    return JSON.parse(stdout.trim());
  };
  try {
    await writeFile(configFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
    await writeFile(blackKey, key(2), { mode: 0o600 }); await writeFile(whiteKey, key(5), { mode: 0o600 });
    const before = { blackCash: await read(local.f.account, "cash", [1n]), whiteCash: await read(local.f.account, "cash", [2n]), provider: await local.f.providerBalance(),
      blackNonce: await local.f.provider.getTransactionCount(config.players.black.wallet), whiteNonce: await local.f.provider.getTransactionCount(config.players.white.wallet) };
    const paused = await cli(["--stop-after-plies", "3"]); assert.equal(paused.phase, "Paused"); assert.equal(paused.moves, 3); assert.equal(local.calls.length, 3);
    const pausedSession = JSON.parse(await readFile(join(sessionDirectory, "session.json"), "utf8")); await writeFile(join(output, "pause-checkpoint.json"), JSON.stringify(pausedSession, null, 2) + "\n");
    const finished = await cli(); const session = JSON.parse(await readFile(join(sessionDirectory, "session.json"), "utf8")) as MatchSession;
    assert.deepEqual(session.result, { kind: "win", winner: "black" }); assert.equal(replayMatch(session).moves.length, 9); assert.equal(local.calls.length, 9);
    const after = { blackCash: await read(local.f.account, "cash", [1n]), whiteCash: await read(local.f.account, "cash", [2n]), provider: await local.f.providerBalance(),
      blackNonce: await local.f.provider.getTransactionCount(config.players.black.wallet), whiteNonce: await local.f.provider.getTransactionCount(config.players.white.wallet) };
    assert.equal(before.blackCash - after.blackCash, 5000n); assert.equal(before.whiteCash - after.whiteCash, 4000n); assert.equal(after.provider - before.provider, 9000n);
    assert.equal(after.blackNonce - before.blackNonce, 5); assert.equal(after.whiteNonce - before.whiteNonce, 4);
    const replayed = await cli(); assert.equal(replayed.phase, "Finished"); assert.equal(local.calls.length, 9);
    const unknownConfig = local.config("lost-model-response"); const unknownFile = join(output, "unknown-config.json"); const unknownDirectory = join(output, "unknown");
    await writeFile(unknownFile, JSON.stringify(unknownConfig, null, 2) + "\n", { mode: 0o600 });
    const unknownBefore = { calls: local.calls.length, provider: await local.f.providerBalance() };
    const unknownInitial = await cli([], unknownFile, unknownDirectory); assert.equal(unknownInitial.phase, "Paused"); assert.equal(unknownInitial.result, null);
    const unknownResume = await cli([], unknownFile, unknownDirectory); assert.equal(unknownResume.reason, "PAID_INFERENCE_UNKNOWN"); assert.equal(unknownResume.result, null);
    assert.equal(local.calls.length - unknownBefore.calls, 1); assert.equal(await local.f.providerBalance() - unknownBefore.provider, 1000n);
    const cachedConfig = local.config("cached-recovery"); const cachedFile = join(output, "cached-config.json"); const cachedDirectory = join(output, "cached");
    await writeFile(cachedFile, JSON.stringify(cachedConfig, null, 2) + "\n", { mode: 0o600 });
    const cachedBefore = { calls: local.calls.length, provider: await local.f.providerBalance() }; const relay = local.relays[0]; const originalWrite = relay.store.write.bind(relay.store); let replyLoss = true;
    relay.store.write = async record => { await originalWrite(record); if (replyLoss && record.state === "Delivered") { replyLoss = false; throw new Error("Controlled CLI reply loss after Delivered commit"); } };
    let cachedInitial;
    try { cachedInitial = await cli([], cachedFile, cachedDirectory); assert.equal(cachedInitial.phase, "Paused"); }
    finally { relay.store.write = originalWrite; }
    const cachedCheckpoint = JSON.parse(await readFile(join(cachedDirectory, "session.json"), "utf8")); await writeFile(join(output, "cached-checkpoint.json"), JSON.stringify(cachedCheckpoint, null, 2) + "\n", { mode: 0o600 });
    const cachedResume = await cli([], cachedFile, cachedDirectory); assert.deepEqual(cachedResume.result, { kind: "win", winner: "black" });
    assert.equal(local.calls.length - cachedBefore.calls, 9); assert.equal(await local.f.providerBalance() - cachedBefore.provider, 9000n);
    const report = { verified: true, scope: "actual two-agent CLI -> SDK cash -> dedicated Relay -> controlled OpenAI HTTP; independent deterministic referee; local Anvil/mock-USDC", paused, finished,
      result: session.result, moves: session.turns.length, modelCalls: 9, totalControlledCalls: local.calls.length, reservedPrice: session.reservedPrice, before, after,
      unknownPaidResponse: { initial: unknownInitial, resumed: unknownResume, modelCalls: 1, paid: "1000", automaticRedispatches: 0 },
      cachedResponseRecovery: { initial: cachedInitial, resumed: cachedResume, modelCalls: 9, paid: "9000", repeatedInitialCall: false },
      limitations: ["No real public models or Monad writes", "No shared prize pool, collateral, credit, reward settlement or reputation update", "Controlled response strategy is scripted; no model-skill claim", "Anvil is closed after original payment receipts/signatures are saved", "Unknown paid inference pauses; no automatic model re-dispatch by match runner"] };
    const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v, 2) + "\n";
    await writeFile(join(output, "report.json"), json(report), { mode: 0o600 }); await writeFile(join(output, "upstream-calls.json"), json(local.calls), { mode: 0o600 });
    return report;
  } finally { await local.close(); await rm(blackKey, { force: true }); await rm(whiteKey, { force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (process.argv.length !== 4 || process.argv[2] !== "--output") throw new Error("Usage: tsx scripts/gomoku-demo.ts --output /absolute/new-evidence");
  const report = await runGomokuDemo(process.argv[3]); console.log(JSON.stringify({ verified: report.verified, result: report.result, moves: report.moves, modelCalls: report.modelCalls, output: resolve(process.argv[3]) }));
}
