import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { once } from "node:events";
import { mkdtemp, realpath, rm, writeFile, readFile, mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { Wallet, keccak256, toUtf8Bytes, ZeroHash } from "ethers";
import { createHostedTaskFixture } from "./task-fixture.js";
import { key, tx } from "../../underwriter/test/fixture.js";
import { Refunder } from "../../provider-relay/src/refunder.js";
import { Relay } from "../../provider-relay/src/relay.js";
import { createHttpServer } from "../../provider-relay/src/http.js";
import { upstreamAttemptsDigest } from "../../provider-relay/src/store.js";
import { validateExternalHire } from "../src/goal-types.js";
import { HostedGoalExecutor, type GoalState } from "../src/goals/executor.js";
import { missionSystem, reviewSystem } from "../src/goals/commander.js";
import { discoverExternalServices, externalAdvertisement, externalServiceView, rankExternalServices, validateExternalHiringConfig,
  type ExternalHiringConfig, type ExternalServiceSnapshot, type ExternalServiceTrust } from "../src/external/registry.js";
import { prepareExternalHire, executeExternalHire } from "../src/external/hiring.js";
import { ExternalSpecialistRelay, createExternalServiceServer } from "../src/external/service.js";

const closeServer = async (server: Server) => { if (server.listening) await new Promise<void>(done => { server.close(() => done()); server.closeIdleConnections(); }); };
const trust = (id: string, priceRaw: string): ExternalServiceTrust => ({ id, name: `${id} Expert`, taskType: "writer", endpoint: "http://127.0.0.1:9876/v1/chat",
  serviceId: `external/${id}`, modelId: `expert-${id}`, physicalModel: "controlled-expert", priceRaw, provider: new Wallet(key(8)).address });
const snapshot = (id: string, price: string, score: number | null): ExternalServiceSnapshot => {
  const approved = trust(id, price); return { trust: approved, service: externalServiceView(approved, { score, samples: score === null ? 0 : 3, source: "registry" }), registryDigest: "a".repeat(64) };
};

test("external ranking honors exact capability, minimum reputation and the phase budget, then monad-rebel 70/30 preference", () => {
  const candidates = [snapshot("budget", "5000", 1), snapshot("trusted", "10000", 4.8), snapshot("unreviewed", "2000", null)];
  assert.deepEqual(rankExternalServices(candidates, "writer", "20000", 1).map(s => s.service.id), ["trusted", "budget"]);
  assert.equal(rankExternalServices(candidates, "writer", "7000", 1)[0].service.id, "budget");
  assert.throws(() => rankExternalServices(candidates, "writer", "20000", 5), /HOSTED_EXTERNAL_REPUTATION_REQUIRED/);
  assert.throws(() => rankExternalServices(candidates, "writer", "3000", 1), /HOSTED_GOAL_BUDGET_REQUIRED/);
  assert.throws(() => rankExternalServices(candidates, "abi-interact", "20000"), /HOSTED_EXTERNAL_SERVICE_UNAVAILABLE/);
  assert.throws(() => validateExternalHiringConfig({ version: 1, registryUrl: "http://outside.test/services", services: [trust("unsafe", "10000")] }), /HOSTED_EXTERNAL_CONFIG_INVALID/);
});

test("discovery rejects an advertisement changing its trusted provider, endpoint, price or model; ignores untrusted services and follows no redirects", async () => {
  const approved = trust("approved", "10000");
  let changed: string | undefined;
  const server = createServer((req, res) => {
    const advertised = externalAdvertisement(approved, { score: 4.5, samples: 4 });
    const service: Record<string, unknown> = { ...advertised };
    if (changed === "redirect") { res.writeHead(302, { location: "http://127.0.0.1:1/identity" }); res.end(); return; }
    if (changed) service[changed] = changed === "priceRaw" ? "1" : changed === "provider" ? new Wallet(key(9)).address : "http://127.0.0.1:1/v1/chat";
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/services" ? { services: [service, { id: "unknown", endpoint: "https://untrusted.invalid" }] } : { service }));
  }); server.listen(0, "127.0.0.1"); await once(server, "listening");
  approved.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`;
  const config: ExternalHiringConfig = { version: 1, registryUrl: new URL("/services", approved.endpoint).href, services: [approved] };
  try {
    const discovered = await discoverExternalServices(config); assert.equal(discovered.length, 1); assert.equal(discovered[0].service.reputation.score, 4.5);
    assert.equal("endpoint" in discovered[0].service, false);
    for (const field of ["provider", "endpoint", "priceRaw", "modelId"]) { changed = field; await assert.rejects(discoverExternalServices(config), /HOSTED_EXTERNAL_REGISTRY_BINDING_CHANGED/); }
    changed = "redirect"; await assert.rejects(discoverExternalServices(config));
  } finally { await closeServer(server); }
});

test("real HTTP external discovery -> 402 -> Account payment -> original report + canonical proof; same-handle recovery and stop never pay twice", { timeout: 180000 }, async () => {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "tabby-external-http-")));
  const f = await createHostedTaskFixture(join(directory, "chain"));
  let dispatches = 0, unknown = false, cancelled = false;
  let internalUpstream: Server | undefined, internalServer: Server | undefined, internalRelay: Relay | undefined;
  const upstream = createServer(async (req, res) => {
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString()); assert.equal(body.model, "controlled-expert"); dispatches++;
    if (unknown) { req.socket.destroy(); return; }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ model: "controlled-expert", choices: [{ finish_reason: "stop", message: { role: "assistant", content: "Launch note: supplied facts A and B." } }], usage: { prompt_tokens: 21, completion_tokens: 12, total_tokens: 33 } }));
  }); upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
  const approved = trust("partner-writer", "10000"), externalAgentId = String(await f.fx.f.identity.getFunction("nextAgentId").staticCall());
  f.fx.f.admin.reset(); await tx(f.fx.f.identity, f.fx.f.admin, "registerFor", [approved.provider, approved.provider]);
  await tx(f.fx.f.account, f.fx.f.admin, "setProviderWhitelist", [approved.provider, true]);
  approved.identity = { chainId: "31337", registry: await f.fx.f.identity.getAddress(), agentId: externalAgentId, wallet: approved.provider };
  approved.reputation = { registry: await f.fx.f.reputation.getAddress(), clients: [await f.fx.f.admin.getAddress()], tag1: "quality", tag2: "writer", maxValue: 5 };
  await tx(f.fx.f.reputation, f.fx.f.admin, "giveFeedback", [externalAgentId, 48, 1, "quality", "writer", "", "", ZeroHash]);
  const relay = new ExternalSpecialistRelay({ ...f.fx.relayConfig, dataDir: join(directory, "external-provider"), payTo: approved.provider,
    service: { id: approved.serviceId, model: approved.modelId, price: 10000n, upstreams: [{ name: "partner", model: "controlled-expert", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, key: "controlled-http" }] } }, approved, { provider: f.fx.f.provider });
  await relay.initialize(); const refunder = new Refunder(relay); await refunder.initialize();
  const service = createExternalServiceServer(relay, refunder, { score: 1, samples: 1 });
  service.listen(0, "127.0.0.1"); await once(service, "listening"); approved.endpoint = `http://127.0.0.1:${(service.address() as { port: number }).port}/v1/chat`;
  const config: ExternalHiringConfig = { version: 1, registryUrl: new URL("/services", approved.endpoint).href, services: [approved], minReputation: 4 };
  try {
    const candidates = await discoverExternalServices(config, { provider: f.fx.f.provider });
    assert.equal(candidates[0].service.reputation.source, "erc8004"); assert.equal(candidates[0].service.reputation.score, 4.8);
    assert.equal(candidates[0].service.reputation.samples, 1); assert.ok(candidates[0].service.reputation.blockHash);
    const selected = rankExternalServices(candidates, "writer", "20000", config.minReputation)[0];
    const actor = await f.actor(5, "cheap", 40000n), provision = await f.executor.execute(actor.input("provision"));
    actor.agent.binding = provision.binding; actor.agent.status = "Ready";
    const input = actor.input("task"); input.run.action = "goal"; input.run.goal = "Write a launch note containing only supplied facts A and B.";
    const mission: GoalState = { version: 1, binding: "controlled-mission-binding", deadlineMs: Date.now() + 120000,
      route: { id: "cheap", relayUrl: "http://127.0.0.1:1/v1/chat", provider: f.fx.f.payee, priceRaw: "10000", service: "tabby/mission", model: "internal-model", physicalModel: "internal-model" },
      input: { goal: input.run.goal, owner: actor.agent.owner, wallet: actor.agent.wallet, agentId: actor.agent.id, chainAgentId: actor.agent.binding!.agentId, chainId: "31337", strategy: "balanced", reservedRaw: input.run.reservedRaw },
      view: { stage: "executing", phases: [], calls: [] }, calls: [] };
    const { hire, call } = prepareExternalHire(mission, selected, { stage: "phase-0", taskType: "writer", originalGoal: input.run.goal,
      assignment: { name: "Launch note", taskType: "writer", goal: "Use facts A and B; do not invent data." }, previous: [] });
    mission.calls.push(call); const journalPath = join(directory, "external-hire.json");
    const save = () => writeFile(journalPath, JSON.stringify({ mission, hire }), { mode: 0o600 });
    const cashBefore = await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId);
    // Frozen ranking does not authorize paying an identity whose wallet was
    // changed after discovery. Repair can resume the same unpaid child safely.
    f.fx.f.admin.reset(); await tx(f.fx.f.identity, f.fx.f.admin, "cheatSetWalletOnly", [externalAgentId, new Wallet(key(9)).address]);
    await assert.rejects(executeExternalHire(f.config, mission, call, hire, input, save, () => undefined), /HOSTED_EXTERNAL_IDENTITY_INVALID/);
    assert.equal(call.unpaid, true); assert.equal(call.handle, undefined); assert.equal(dispatches, 0);
    await tx(f.fx.f.identity, f.fx.f.admin, "cheatSetWalletOnly", [externalAgentId, approved.provider]);
    const hired = await executeExternalHire(f.config, mission, call, hire, input, save, () => Promise.resolve({ paused: false, cancelled }));
    assert.equal(call.unpaid, false);
    assert.equal(hired.output, "Launch note: supplied facts A and B."); assert.equal(dispatches, 1); validateExternalHire(hired.proof);
    assert.equal(hired.proof.service.provider, approved.provider); assert.notEqual(hired.proof.service.provider, f.fx.f.payee);
    assert.equal(await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId), cashBefore - 10000n);
    const record = await f.fx.f.account.getFunction("getPayment").staticCall(hired.proof.paymentId);
    assert.equal(record.fromCash, 10000n); assert.equal(record.fromCredit, 0n); assert.equal(record.taskId, 0n);
    const nonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    // Changing live catalog availability after payment does not rediscover or rehire.
    cancelled = true;
    const recovered = JSON.parse(await readFile(journalPath, "utf8")) as { mission: GoalState; hire: typeof hire };
    assert.deepEqual(await executeExternalHire(f.config, recovered.mission, recovered.mission.calls[0], recovered.hire, input, save,
      () => Promise.resolve({ paused: false, cancelled })), hired);
    assert.equal(dispatches, 1); assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), nonce);
    for (const field of ["price", "payTo", "requestDigest", "txHash"]) {
      const broken = structuredClone(recovered), receipt = broken.mission.calls[0].inference!.receipt as unknown as Record<string, unknown>;
      receipt[field] = field === "price" ? "1" : field === "payTo" ? new Wallet(key(9)).address : ZeroHash;
      await assert.rejects(executeExternalHire(f.config, broken.mission, broken.mission.calls[0], broken.hire, input, async () => {}, () => undefined));
    }
    const changedQuote = structuredClone(recovered); changedQuote.mission.calls[0].handle!.quote.model = "other-model";
    await assert.rejects(executeExternalHire(f.config, changedQuote.mission, changedQuote.mission.calls[0], changedQuote.hire, input, async () => {}, () => undefined), /HOSTED_GOAL_RECEIPT_INVALID/);
    assert.equal(dispatches, 1);
    // Exercise the real commander and a separate, paid independent reviewer
    // around the external hire, through three HTTP model dispatches.
    let internalDispatches = 0;
    internalUpstream = createServer(async (req, res) => {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString()); internalDispatches++;
      assert.equal(body.model, "controlled-internal");
      let content: string;
      if (body.messages[0].content === missionSystem) content = JSON.stringify({ phases: [{ name: "Launch note", taskType: "writer", goal: "Use supplied facts A and B; do not invent data." }] });
      else {
        assert.equal(body.messages[0].content, reviewSystem);
        const request = JSON.parse(body.messages[1].content); assert.equal(request.artifact, hired.output);
        content = JSON.stringify({ passed: true, summary: "Only the supplied facts are present.", checks: ["Both A and B are included", "No unsupported claims"] });
      }
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ model: "controlled-internal", choices: [{ finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 30, completion_tokens: 15, total_tokens: 45 } }));
    }); internalUpstream.listen(0, "127.0.0.1"); await once(internalUpstream, "listening");
    internalRelay = new Relay({ ...f.fx.relayConfig, dataDir: join(directory, "internal-model"), service: { id: "tabby/mission", model: "goal-model", price: 5000n,
      upstreams: [{ name: "internal", model: "controlled-internal", baseUrl: `http://127.0.0.1:${(internalUpstream.address() as { port: number }).port}/v1`, key: "controlled-http" }] } }, { provider: f.fx.f.provider });
    await internalRelay.initialize(); const internalRefunder = new Refunder(internalRelay); await internalRefunder.initialize();
    internalServer = createHttpServer(internalRelay, internalRefunder); internalServer.listen(0, "127.0.0.1"); await once(internalServer, "listening");
    const goals = new HostedGoalExecutor({ durationMs: 120000, models: [{ id: "cheap", relayUrl: `http://127.0.0.1:${(internalServer.address() as { port: number }).port}/v1/chat`,
      provider: f.fx.f.payee, priceRaw: "5000", service: "tabby/mission", model: "goal-model", physicalModel: "controlled-internal" }], external: config }, f.config);
    const completeInput = actor.input("task"); completeInput.run.action = "goal"; completeInput.run.goal = input.run.goal;
    const completeBefore = await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId), beforeDispatches = dispatches;
    const completed = await goals.execute(completeInput); assert.equal(completed.success, true, JSON.stringify(completed)); assert.equal(completed.chargedRaw, "20000");
    assert.equal(internalDispatches, 2); assert.equal(dispatches - beforeDispatches, 1); assert.equal(completed.mission!.calls.length, 3);
    assert.equal(completed.mission!.phases[0].external!.id, selected.service.id); assert.equal(completed.mission!.calls[1].external!.service.provider, approved.provider);
    const completeAfter = await f.fx.f.account.getFunction("cash").staticCall(actor.agent.binding!.agentId), completedNonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    assert.equal(completeBefore - completeAfter, 20000n);
    assert.deepEqual(await goals.execute({ ...completeInput, recover: true }), completed); assert.equal(internalDispatches, 2); assert.equal(dispatches - beforeDispatches, 1);
    assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), completedNonce);
    const acceptance = { schema: 1, observedAt: new Date().toISOString(), chainId: "31337", modelSource: "controlled-http-llm",
      requestId: completeInput.run.requestId, discoveredService: selected.service, goal: completeInput.run.goal, mission: completed.mission,
      cashBeforeRaw: String(completeBefore), cashAfterRaw: String(completeAfter), chargedRaw: completed.chargedRaw,
      modelDispatches: { commander: 1, externalSpecialist: dispatches - beforeDispatches, independentReviewer: 1 },
      replay: { sameResult: true, extraModelDispatches: 0, nonceBefore: completedNonce, nonceAfter: await f.fx.f.provider.getTransactionCount(actor.wallet.address) } };
    // An unknown external model dispatch stays on its original paid handle.
    cancelled = false; unknown = true;
    const next = actor.input("task"); next.run.action = "goal"; next.run.goal = input.run.goal;
    const nextMission: GoalState = { ...structuredClone(mission), binding: "unknown-external-mission", calls: [], view: { stage: "executing", phases: [], calls: [] }, policy: undefined };
    const nextHire = prepareExternalHire(nextMission, selected, { stage: "phase-0", taskType: "writer", originalGoal: next.run.goal,
      assignment: { name: "Launch note", taskType: "writer", goal: "Use facts A and B." } }); nextMission.calls.push(nextHire.call);
    await assert.rejects(executeExternalHire(f.config, nextMission, nextHire.call, nextHire.hire, next, async () => {}, () => undefined));
    assert.equal(dispatches, 3); assert.ok(nextHire.call.handle?.submission?.txHash);
    const paymentId = nextHire.call.handle!.quote.paymentId, unknownNonce = await f.fx.f.provider.getTransactionCount(actor.wallet.address);
    cancelled = true;
    await assert.rejects(executeExternalHire(f.config, nextMission, nextHire.call, nextHire.hire, next, async () => {}, () => Promise.resolve({ paused: false, cancelled })), /HOSTED_GOAL_RECONCILIATION_REQUIRED/);
    assert.equal(dispatches, 3); assert.equal(nextHire.call.handle!.quote.paymentId, paymentId); assert.equal(await f.fx.f.provider.getTransactionCount(actor.wallet.address), unknownNonce);
    const uncertain = await relay.store.read(paymentId);
    await relay.resolveUndelivered({ paymentId, resolutionId: randomUUID(), expectedAttemptsDigest: upstreamAttemptsDigest(uncertain.upstreamAttempts!), evidenceDigest: keccak256(toUtf8Bytes("controlled external provider accepts nondelivery cost")) });
    // This independent provider funds the protocol's existing dedicated
    // refunder; the Agent's or another provider's cash is never repurposed.
    await f.fx.f.provider.send("anvil_setBalance", [approved.provider, "0x3635c9adc5dea00000"]);
    await tx(f.fx.f.token!, new Wallet(key(8), f.fx.f.provider), "transfer", [f.fx.f.payee, 10000n]);
    await refunder.refund(paymentId, keccak256(toUtf8Bytes("external-full-refund")), "10000");
    await assert.rejects(executeExternalHire(f.config, nextMission, nextHire.call, nextHire.hire, next, async () => {}, () => Promise.resolve({ paused: false, cancelled })), /HOSTED_GOAL_UNDELIVERED_REFUNDED/);
    assert.equal(nextHire.call.recovery?.resolved, true); assert.equal(nextHire.call.recovery?.chargedRaw, "0"); assert.equal(nextHire.call.recovery?.refundedRaw, "10000");
    await assert.rejects(executeExternalHire(f.config, nextMission, nextHire.call, nextHire.hire, next, async () => {}, () => undefined), /HOSTED_GOAL_UNDELIVERED_REFUNDED/);
    assert.equal(dispatches, 3);
    if (process.env.EXTERNAL_ACCEPTANCE_OUTPUT) {
      const evidencePath = resolve(process.env.EXTERNAL_ACCEPTANCE_OUTPUT); await mkdir(dirname(evidencePath), { recursive: true });
      await writeFile(evidencePath, JSON.stringify({ ...acceptance, unknownRecovery: { requestId: next.run.requestId, paymentId, originalPaymentTxHash: nextHire.call.handle!.submission!.txHash,
        chargedRaw: nextHire.call.recovery!.chargedRaw, refundedRaw: nextHire.call.recovery!.refundedRaw, resolved: true,
        sameHandleOnStop: true, extraPaymentsOnStop: 0, extraModelDispatchesOnStop: 0, extraModelDispatchesAfterRefund: 0 } }, null, 2) + "\n");
    }
  } finally { if (internalServer) await closeServer(internalServer); if (internalUpstream) await closeServer(internalUpstream); internalRelay?.close(); await closeServer(service); await closeServer(upstream); relay.close(); await f.close(); await rm(directory, { recursive: true, force: true }); }
});
