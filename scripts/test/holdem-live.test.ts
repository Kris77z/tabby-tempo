import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main, holdemLivePlan } from "../holdem-live.js";
import { replayHand } from "../../services/arena/src/holdem/index.js";
import type { PlayerView } from "../../services/arena/src/holdem/index.js";

async function files() {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-holdem-live-cli-")), keyFile = join(directory, "key"), config = join(directory, "private.json"), output = join(directory, "evidence");
  const secret = "synthetic-holdem-live-key";
  await writeFile(keyFile, secret, { mode: 0o600 }); await writeFile(config, JSON.stringify({ upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: keyFile } }), { mode: 0o600 });
  return { directory, keyFile, config, output, secret };
}
function noSecrets(value: unknown): void {
  const publicText = JSON.stringify(value, (_, item) => typeof item === "bigint" ? item.toString() : item);
  for (const forbidden of ["holeCards", '"deck"', '"showdown":', "synthetic-holdem-live-key", "rawText", "messages", "authorization"])
    assert.equal(publicText.includes(forbidden), false, `public report contains ${forbidden}`);
}

test("live Holdem defaults to a secret-free bounded plan and refuses existing outputs", async () => {
  const f = await files(), log = console.log; const messages: string[] = []; console.log = value => { messages.push(String(value)); };
  try {
    await main(["--config", f.config]); const plan = JSON.parse(messages[0]); assert.equal(plan.mode, "plan-only");
    assert.equal(plan.model, "kimi-k2.6"); assert.equal(plan.maxCalls, 20); assert.equal(plan.maxCompletionTokens, 512); assert.equal(plan.deadlineDurationMs, 600000);
    assert.equal(plan.entryFee, "0"); assert.equal(plan.credit, false); assert.equal(plan.inferenceRetries, 0); assert.equal(plan.predeterminedWinner, false); assert.equal(plan.seededDeck, false);
    assert.deepEqual(plan.thinking, { type: "disabled" }); assert.equal(plan.tools, false); assert.equal(plan.strategyInferenceFunding, "sponsor upstream account");
    assert.equal(messages[0].includes(f.secret), false); assert.equal(messages[0].includes(f.keyFile), false);
    await assert.rejects(main(["--config", f.config, "--execute"]), /ABSOLUTE_NEW_OUTPUT_REQUIRED/);
    await assert.rejects(main(["--config", f.config, "--output", f.directory, "--execute"]), { code: "EEXIST" });
    assert.equal(await readFile(f.keyFile, "utf8"), f.secret); assert.equal(holdemLivePlan.sponsoredRewardRaw, "100000");
  } finally { console.log = log; await rm(f.directory, { recursive: true, force: true }); }
});

test("controlled live decisions complete a random hand, award once, then buy controlled inference separately", { timeout: 120000 }, async () => {
  const f = await files(); let calls = 0;
  try {
    const report = await main(["--config", f.config, "--output", f.output, "--execute"], async (url, init) => {
      calls++; assert.equal(String(url), "https://api.moonshot.cn/v1/chat/completions");
      assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${f.secret}`);
      const request = JSON.parse(String(init?.body)), view = JSON.parse(request.messages[1].content) as PlayerView;
      assert.equal(request.max_completion_tokens, 512); assert.deepEqual(request.thinking, { type: "disabled" }); assert.equal(request.tools, undefined);
      assert.equal(view.holeCards.length, 2); assert.equal(view.actor, view.seat); assert.equal("deck" in view, false);
      const type = view.legalActions.some(action => action.type === "check") ? "check" : "call";
      return Response.json({ model: request.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ type }) } }], usage: { prompt_tokens: 18, completion_tokens: 5, total_tokens: 23 } });
    });
    assert.ok(report); assert.equal(report.version, 1); assert.equal(report.mode, "holdem-live"); assert.equal(report.phase, "Complete"); assert.equal(report.verified, true);
    assert.equal(report.upstreamMode, "controlled-upstream"); assert.equal(report.game.entryFee, "0"); assert.equal(calls, 8); assert.equal(report.strategyInference.calls, calls);
    assert.equal(report.strategyInference.funding, "sponsor upstream account"); assert.equal(report.strategyInference.vendorInvoiceVerified, false);
    assert.equal(report.game.result!.reason, "showdown"); assert.equal(report.reward!.rawAmount, "100000"); assert.equal(report.reward!.repeatedSettlementPaidAgain, false);
    assert.equal(report.inference!.mode, "controlled-reward-inference"); assert.equal(report.inference!.calls, report.game.result!.winners.length);
    assert.deepEqual(report.balances!.before, report.balances!.afterGame); assert.equal(report.verification.rewardConserved, true);
    assert.equal(report.verification.gameWalletSpend, "0"); assert.equal(report.verification.loanPrincipal, "0"); assert.equal(report.verification.totalOutstanding, "0");
    assert.deepEqual(report.evidenceCollectionErrors, []); noSecrets(report);
    const publicReport = JSON.parse(await readFile(join(f.output, "report.json"), "utf8")); noSecrets(publicReport);
    const chain = JSON.parse(await readFile(join(f.output, "chain-evidence.json"), "utf8")); noSecrets(chain); assert.equal(chain.chainId, "31337");
    const replay = JSON.parse(await readFile(join(f.output, ".private/trusted-replay.json"), "utf8")); assert.equal(replayHand(replay).view(0).handStatus, "complete");
    assert.equal((await stat(join(f.output, ".private"))).mode & 0o777, 0o700); assert.equal((await stat(join(f.output, ".private/game/session.json"))).mode & 0o777, 0o600);
    await assert.rejects(main(["--config", f.config, "--output", f.output, "--execute"]), { code: "EEXIST" }); assert.equal(calls, 8);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});

test("an illegal real-shaped response saves evidence and stops without reward, inference or wallet spend", { timeout: 120000 }, async () => {
  const f = await files(); let calls = 0;
  try {
    const report = await main(["--config", f.config, "--output", f.output, "--execute"], async () => {
      calls++; return Response.json({ choices: [{ finish_reason: "stop", message: { role: "assistant", content: '{"type":"check"}' } }] });
    });
    assert.ok(report); assert.equal(report.phase, "Stopped"); assert.equal(report.reason, "HOLDEM_INVALID_OR_ILLEGAL_RESPONSE"); assert.equal(report.verified, false);
    assert.equal(calls, 1); assert.equal(report.game.result, null); assert.equal(report.reward, null); assert.equal(report.inference, null);
    assert.equal(report.game.steps.length, 0); assert.deepEqual(report.balances!.before, report.balances!.afterGame); assert.equal(report.strategyInference.attempts[0].outcome, "ResponseInvalid");
    noSecrets(report);
    const session = JSON.parse(await readFile(join(f.output, ".private/game/session.json"), "utf8")); assert.equal(session.turns[0].dispatchIntent, true);
    assert.equal(session.turns[0].response.httpStatus, 200); assert.equal(session.turns[0].request.messages[1].role, "user"); assert.equal(session.replay.actions.length, 0);
  } finally { await rm(f.directory, { recursive: true, force: true }); }
});
