import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { Wallet } from "ethers";
import { Relay } from "../../provider-relay/src/relay.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { key, tx, read } from "../../underwriter/test/fixture.js";
import { createAutonomyGameFixture } from "./autonomy-game-fixture.js";
import { HostedGoalExecutor } from "../src/goals/executor.js";
import { missionSystem, reviewSystem } from "../src/goals/commander.js";
import { ExternalSpecialistRelay, createExternalServiceServer } from "../src/external/service.js";
import type { ExternalServiceTrust } from "../src/external/registry.js";
import { replayHand } from "../../arena/src/holdem/engine.js";
import { goalExecutionEvidence } from "../src/goals/execution-evidence.js";
import { specialistPrompt } from "../src/specialists/execution.js";
import { specialistSystem } from "../src/goals/commander.js";

const listen = async (server: Server) => { server.listen(0, "127.0.0.1"); await once(server, "listening"); return `http://127.0.0.1:${(server.address() as { port: number }).port}`; };
const close = async (server: Server) => { server.closeAllConnections(); await new Promise<void>(done => server.close(() => done())); };
const response = (model: string, content: string) => ({ model, choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 21, completion_tokens: 12, total_tokens: 33 } });
const good = "Task credit is an inference loan backed by an escrowed task reward, repaid with fees. Personal Goals use cash only. Same-identity game tokens fund reward-tasks.";
const bad = "Task credit is a free internal allowance. Personal Goals use cash only.";

/** Engineering acceptance only: owned Anvil, real payment/contracts/registry,
 * loopback deterministic models and separate Docker/Arena verifier. These
 * fixtures do not establish real-model review quality or a natural win rate. */
test("isolated same-identity external Goal -> cash shortfall -> game -> reward-task, with content rejection and no-award stop", { timeout: 240000 }, async () => {
  const t = await createAutonomyGameFixture(), servers: Server[] = [], relays: Relay[] = [];
  const modelRequests: any[] = [], reviewInputs: any[] = []; let incorrect = false;
  const reviewSystems = new Set([reviewSystem]);
  if (process.env.TEMPO_MONAD_REFERENCE) {
    const referencePrompt = await import(pathToFileURL(join(process.env.TEMPO_MONAD_REFERENCE, "services/hosted-agents/src/goals/commander.ts")).href);
    reviewSystems.add(referencePrompt.reviewSystem);
  }
  try {
    const upstream = createServer(async (req, res) => {
      try {
        const parts: Buffer[] = []; for await (const part of req) parts.push(Buffer.from(part));
        const body = JSON.parse(Buffer.concat(parts).toString()); modelRequests.push(body);
        let content: string;
        if (body.model === "isolated-expert") content = incorrect ? bad : good;
        else if (body.messages[0].content === missionSystem) content = JSON.stringify({ phases: [{ name: "Protocol explanation", taskType: "writer", goal: "Explain task credit, personal Goals and game rewards accurately." }] });
        else if (reviewSystems.has(body.messages[0].content)) {
          const input = JSON.parse(body.messages[1].content); reviewInputs.push(input);
          const evidence = input.executionEvidence, phase = evidence?.phases?.[0], proof = phase?.proof;
          // This deterministic review program actually checks host evidence and
          // content separately. A valid payment never excuses wrong content.
          if (!evidence) {
            content = JSON.stringify({ passed: false, summary: "Fixture requires host evidence for the requested external delivery.", checks: ["Artifact text alone does not prove an external paid assignment"] });
            res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response(body.model, content))); return;
          }
          assert.equal(evidence.deliveryScope, "paid-text-delivery-only");
          assert.equal(evidence.reviewer.result, "pending"); assert.equal(evidence.reviewer.mode, "separate-model-call");
          assert.equal(evidence.artifact.sha256, createHash("sha256").update(input.artifact).digest("hex"));
          assert.equal(phase.source, "external-specialist"); assert.equal(proof.service.identity.agentId, providerId);
          assert.notEqual(proof.service.provider, t.f.fx.f.payee);
          assert.equal((await t.f.fx.f.provider.getTransactionReceipt(proof.txHash))!.status, 1);
          const passed = input.artifact === good;
          content = JSON.stringify({ passed, summary: passed ? "Paid external text and protocol content verified by fixture." : "Task credit was incorrectly described as free internal allowance.", checks: ["Host paid-delivery proof is present", passed ? "Task-reward-backed loan and cash-only Goal are accurate" : "Wrong task-credit explanation must fail"] });
        } else content = incorrect ? bad : good; // Built-in revision fixture.
        res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response(body.model, content)));
      } catch (error) { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: String(error) })); }
    }); servers.push(upstream); const upstreamUrl = await listen(upstream);
    const providerWallet = new Wallet(key(8)).address;
    const providerId = String(await t.f.fx.f.identity.getFunction("nextAgentId").staticCall());
    t.f.fx.f.admin.reset(); await tx(t.f.fx.f.identity, t.f.fx.f.admin, "registerFor", [providerWallet, providerWallet]);
    await tx(t.f.fx.f.account, t.f.fx.f.admin, "setProviderWhitelist", [providerWallet, true]);
    const trust: ExternalServiceTrust = { id: "isolated-writer", name: "Isolated Writer", taskType: "writer", endpoint: "http://127.0.0.1:1/v1/chat",
      provider: providerWallet, priceRaw: "10000", serviceId: "external/isolated-writer", modelId: "isolated-writer", physicalModel: "isolated-expert",
      identity: { chainId: "31337", registry: await t.f.fx.f.identity.getAddress(), agentId: providerId, wallet: providerWallet } };
    const external = new ExternalSpecialistRelay({ ...t.f.fx.relayConfig, dataDir: join(t.directory, "external"), payTo: providerWallet,
      service: { id: trust.serviceId, model: trust.modelId, price: 10000n, upstreams: [{ name: "expert", model: trust.physicalModel, baseUrl: `${upstreamUrl}/v1`, key: "isolated-synthetic" }] } }, trust, { provider: t.f.fx.f.provider });
    relays.push(external); await external.initialize(); const externalRefunder = new Refunder(external); await externalRefunder.initialize();
    const externalServer = createExternalServiceServer(external, externalRefunder, { score: null, samples: 0 }); servers.push(externalServer);
    trust.endpoint = `${await listen(externalServer)}/v1/chat`;
    const internal = new Relay({ ...t.f.fx.relayConfig, dataDir: join(t.directory, "internal"), service: { id: "tabby/mission", model: "isolated-goal", price: 10000n,
      upstreams: [{ name: "review", model: "isolated-internal", baseUrl: `${upstreamUrl}/v1`, key: "isolated-synthetic" }] } }, { provider: t.f.fx.f.provider });
    relays.push(internal); await internal.initialize(); const internalRefunder = new Refunder(internal); await internalRefunder.initialize();
    const internalServer = createHttpServer(internal, internalRefunder); servers.push(internalServer); const internalUrl = await listen(internalServer);
    const goals = new HostedGoalExecutor({ durationMs: 120000, models: [{ id: "kimi-k2.6", relayUrl: `${internalUrl}/v1/chat`, provider: t.f.fx.f.payee,
      priceRaw: "10000", service: "tabby/mission", model: "isolated-goal", physicalModel: "isolated-internal" }],
      external: { version: 1, registryUrl: new URL("/services", trust.endpoint).href, services: [trust] } }, t.f.config);
    t.tasks.config.initialCashRaw = "150000";
    const originalGoal = "Explain task credit, cash-only personal Goals and same-identity game rewards. Hire an external writer and use an independent reviewer.";
    if (process.env.TEMPO_MONAD_REFERENCE) {
      // Explicit opt-in, read-only reference import. Same Goal, service, local
      // contracts and deterministic reviewer policy; no Monad runtime is run.
      const { HostedGoalExecutor: Reference } = await import(pathToFileURL(join(process.env.TEMPO_MONAD_REFERENCE, "services/hosted-agents/src/goals/executor.ts")).href);
      const referenceActor = await t.f.actor(7, "kimi-k2.6", 150000n); referenceActor.agent.allowCredit = false;
      const provision = await t.tasks.execute(referenceActor.input("provision")); referenceActor.agent.binding = provision.binding; referenceActor.agent.status = "Ready";
      const request = referenceActor.input("task"); request.run.action = "goal"; request.run.goal = originalGoal;
      const baseline = await new Reference(goals.config, t.f.config).execute(request);
      assert.equal(baseline.success, false); assert.equal(baseline.reason, "HOSTED_GOAL_REVIEW_FAILED");
      assert.equal(modelRequests.length, 5); assert.equal(reviewInputs.length, 2); assert.ok(reviewInputs.every(input => input.executionEvidence === undefined));
      console.log(JSON.stringify({ comparison: "same-goal-service-contracts-deterministic-review-policy", reference: "Monad source, local-only execution", referenceOutcome: baseline.reason,
        reason: "host evidence omitted from review payload", physicalCalls: modelRequests.length, realModelConclusion: false }));
      modelRequests.length = 0; reviewInputs.length = 0;
    }
    const actor = await t.f.actor(5, "kimi-k2.6", 150000n); actor.agent.allowCredit = false;
    const ready = await t.tasks.execute(actor.input("provision")); assert.equal(ready.success, true); actor.agent.binding = ready.binding; actor.agent.status = "Ready";
    const input = actor.input("task"); input.run.action = "goal"; input.run.goal = originalGoal;
    let interruptReview = true;
    input.progress = async view => { if (interruptReview && view.stage === "reviewing") { interruptReview = false; throw Error("SYNTHETIC_PRE_REVIEW_CRASH"); } };
    const interrupted = await goals.execute(input); assert.equal(interrupted.terminal, false); assert.equal(interrupted.chargedRaw, "20000"); assert.equal(modelRequests.length, 2);
    const completed = await goals.execute({ ...input, recover: true }); assert.equal(completed.success, true, JSON.stringify(completed));
    assert.equal(completed.chargedRaw, "30000"); assert.equal(reviewInputs.length, 1); assert.equal(modelRequests.length, 3);
    const journal = JSON.parse(await readFile(join(input.directory, "mission/session.json"), "utf8"));
    assert.equal(goalExecutionEvidence(journal, "review", good).actor.agentId, actor.agent.binding!.agentId);
    for (const mutate of [
      (s: any) => { s.view.calls[1].external.assignmentDigest = "a".repeat(64); },
      (s: any) => { s.calls[1].inference.receipt.agentId = "999"; },
      (s: any) => { s.calls[1].inference.receipt.fromCredit = "10000"; },
      (s: any) => { s.view.phases[0].output = "forged report"; },
      (s: any) => { s.calls[1].response.txHash = "0x" + "1".repeat(64); },
    ]) { const changed = structuredClone(journal); mutate(changed); assert.throws(() => goalExecutionEvidence(changed, "review", good), /HOSTED_GOAL_EXECUTION_EVIDENCE_INVALID/); }
    // Compatibility contract: this is the pre-repair Tempo external writer
    // system digest. New protocol context never rewrites a saved system prompt.
    assert.equal(specialistPrompt("writer", specialistSystem, "42431").promptDigest, "6b02c9d5c1a904350482b1ec7d813f2ea705abdf419aa5913ad1711426e918fb");
    assert.equal(await read(t.f.fx.f.account, "cash", [actor.agent.binding!.agentId]), 120000n);
    assert.equal((await t.games.rewardBalance(actor.agent)).availableTokens, 0);
    const nonce = await t.f.fx.f.provider.getTransactionCount(actor.wallet.address), count = modelRequests.length;
    assert.deepEqual(await goals.execute({ ...input, recover: true }), completed);
    assert.equal(modelRequests.length, count); assert.equal(await t.f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    const parent = actor.input("task"); parent.run.action = "autonomous"; parent.run.reservedRaw = "130000";
    const automatic = t.autonomous(["llm-credits"]), result = await automatic.execute(parent);
    assert.equal(result.success, true, JSON.stringify(result)); assert.equal(result.autonomousGames, 1); assert.equal(result.autonomousTasks, 1); assert.equal(result.chargedRaw, "0");
    const host = JSON.parse(await readFile(join(parent.directory, "autonomy-host/session.json"), "utf8"));
    const children = Object.values(host.children) as any[], game = children.find(child => child.run.action === "game"), task = children.find(child => child.run.action === "reward-task");
    assert.ok(game); assert.ok(task);
    for (const child of children) { assert.equal(child.agent.id, actor.agent.id); assert.deepEqual(child.agent.binding, actor.agent.binding); assert.equal(child.keyFile, actor.keyFile); }
    const gameState = JSON.parse(await readFile(join(game.directory, "game/session.json"), "utf8")); assert.deepEqual(replayHand(gameState.replay).view(0).result!.winners, [0]);
    const settled = JSON.parse(await readFile(join(task.directory, "task-executor/session.json"), "utf8")).result;
    assert.equal(settled.settlement.passed, true); assert.equal(settled.fromCreditRaw ?? "0", "0"); assert.ok(settled.creditsUsed > 0); assert.ok(t.samples.length);
    const receipt = (await t.f.fx.f.provider.getTransactionReceipt(settled.settlement.txHash))!;
    assert.equal(receipt.status, 1); assert.equal((await t.f.fx.f.provider.getBlock(receipt.blockNumber))!.hash, receipt.blockHash);
    const modelCount = t.requests.length, actorNonce = await t.f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.deepEqual(await automatic.execute({ ...parent, recover: true }), result); assert.equal(t.requests.length, modelCount); assert.equal(await t.f.fx.f.provider.getTransactionCount(actor.wallet.address), actorNonce);

    // A fresh Goal with valid execution proof and wrong protocol content must
    // remain failed through its one revision and separate re-review.
    incorrect = true;
    const invalid = actor.input("task"); invalid.run.action = "goal"; invalid.run.goal = input.run.goal;
    const rejected = await goals.execute(invalid); assert.equal(rejected.success, false); assert.equal(rejected.terminal, true); assert.equal(rejected.reason, "HOSTED_GOAL_REVIEW_FAILED");
    assert.equal(rejected.mission!.calls.length, 5); assert.equal(reviewInputs.length, 3);

    // Separate zero-cash identity, deterministic fold policy: real game engine
    // computes losses. No fabricated award or identity replacement funds a task.
    t.tasks.config.initialCashRaw = "0"; t.loseEveryGame();
    const loser = await t.f.actor(6, "kimi-k2.6", 0n); loser.agent.allowCredit = false;
    const loserReady = await t.tasks.execute(loser.input("provision")); loser.agent.binding = loserReady.binding; loser.agent.status = "Ready";
    const stoppedParent = loser.input("task"); stoppedParent.run.action = "autonomous"; stoppedParent.run.reservedRaw = "130000";
    const stopped = await automatic.execute(stoppedParent);
    assert.equal(stopped.reason, "AUTONOMY_GAME_LIMIT"); assert.equal(stopped.autonomousGames, 2); assert.equal(stopped.autonomousTasks, 0); assert.equal(stopped.terminal, true);
    assert.equal((await t.games.rewardBalance(loser.agent)).availableTokens, 0);
    const lostHost = JSON.parse(await readFile(join(stoppedParent.directory, "autonomy-host/session.json"), "utf8"));
    assert.equal(Object.values(lostHost.children).filter((child: any) => child.run.action !== "game").length, 0);
    console.log(JSON.stringify({ evidence: "isolated-engineering-only", chainId: "31337", models: "deterministic-loopback-http", verifier: "Docker + separate Arena settler",
      externalIdentity: providerId, actorIdentity: actor.agent.binding!.agentId, goalChargesRaw: completed.chargedRaw, cashBeforeParentRaw: "120000",
      games: result.autonomousGames, rewardTasks: result.autonomousTasks, canonicalSettlement: true, badContentRejected: true,
      noAward: { games: stopped.autonomousGames, tasks: stopped.autonomousTasks, reason: stopped.reason }, extraReplayDispatches: 0 }));
  } finally { for (const server of servers.reverse()) await close(server); for (const relay of relays) relay.close(); await t.close(); }
});
