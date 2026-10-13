import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gomokuLivePlan, main } from "../gomoku-live.js";
import { replayMatch } from "../../services/arena/src/gomoku/match.js";

test("live Gomoku defaults to a secret-free bounded plan and refuses existing evidence execution", async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-gomoku-live-plan-")); const keyFile = join(directory, "key"); const config = join(directory, "private.json");
  const secret = "synthetic-live-gomoku-key"; await writeFile(keyFile, secret, { mode: 0o600 }); await writeFile(config, JSON.stringify({ upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: keyFile } }), { mode: 0o600 });
  const log = console.log; const output: string[] = []; console.log = value => { output.push(String(value)); };
  try {
    await main(["--config", config]); const plan = JSON.parse(output[0]); assert.equal(plan.mode, "plan-only"); assert.equal(plan.maxPlies, 31); assert.equal(plan.maxCompletionTokens, 256); assert.equal(plan.model, "kimi-k2.6");
    assert.equal(plan.inferenceRetries, 0); assert.equal(plan.preseededMoves, false); assert.deepEqual(plan.maxTotalPriceRaw, { black: "160000", white: "150000" }); assert.equal(plan.deadlineDurationMs, 1200000);
    assert.equal(output[0].includes(secret), false); assert.equal(output[0].includes(keyFile), false);
    await assert.rejects(main(["--config", config, "--execute"]), /ABSOLUTE_NEW_OUTPUT_REQUIRED/);
    await assert.rejects(main(["--config", config, "--output", directory, "--execute"]), { code: "EEXIST" });
    assert.equal(await readFile(keyFile, "utf8"), secret); assert.deepEqual(gomokuLivePlan.thinking, { type: "disabled" });
  } finally { console.log = log; await rm(directory, { recursive: true, force: true }); }
});

test("live entry controlled injection crosses actual HTTP, saves each decision/receipt and labels source", { timeout: 60000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-gomoku-live-controlled-")); const keyFile = join(directory, "key"); const config = join(directory, "private.json"); const output = join(directory, "evidence");
  const secret = "synthetic-live-gomoku-key"; await writeFile(keyFile, secret, { mode: 0o600 }); await writeFile(config, JSON.stringify({ upstream: { name: "kimi", baseUrl: "https://api.moonshot.cn/v1", apiKeyFile: keyFile } }), { mode: 0o600 });
  let requests = 0;
  try {
    const report = await main(["--config", config, "--output", output, "--execute"], async (url, init) => {
      requests++; assert.equal(String(url), "https://api.moonshot.cn/v1/chat/completions"); assert.equal(new Headers(init?.headers).get("authorization"), `Bearer ${secret}`);
      const body = JSON.parse(String(init?.body)); const game = JSON.parse(body.messages.at(-1).content); const marker = game.side === "black" ? "X" : "O";
      const count = game.board.join("").split("").filter((value: string) => value === marker).length;
      assert.equal(body.model, "kimi-k2.6"); assert.deepEqual(body.thinking, { type: "disabled" }); assert.equal(body.max_completion_tokens, 256); assert.equal(body.tools, undefined);
      return Response.json({ model: body.model, choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify({ row: game.side === "black" ? 7 : 8, col: 3 + count }) } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
    });
    assert.equal(report.upstreamMode, "controlled-upstream"); assert.equal(report.phase, "Finished"); assert.deepEqual(report.result, { kind: "win", winner: "black" }); assert.equal(report.replayVerified, true); assert.deepEqual(report.evidenceCollectionErrors, []);
    assert.equal(requests, 9); assert.equal(report.paidInferenceAttempts, 9); assert.equal(report.localChain.after.provider, "90000"); assert.equal(report.localChain.after.blackCash, "450000"); assert.equal(report.localChain.after.whiteCash, "460000"); assert.equal(report.localChain.after.totalOutstanding, "0");
    assert.equal(JSON.stringify(report).includes(secret), false); const session = JSON.parse(await readFile(join(output, "match/session.json"), "utf8")); assert.equal(replayMatch(session).moves.length, 9);
    for (let ply = 1; ply <= 9; ply++) {
      const response = JSON.parse(await readFile(join(output, `ply-${ply}/response.json`), "utf8")); const receipt = JSON.parse(await readFile(join(output, `ply-${ply}/transaction-receipt.json`), "utf8"));
      assert.equal(response.httpStatus, 200); assert.equal(response.body.model, "kimi-k2.6"); assert.equal(receipt.status, 1); assert.equal(receipt.hash, session.turns[ply - 1].handle.submission.txHash);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});
