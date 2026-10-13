import assert from "node:assert/strict";
import test from "node:test";
import type { ChildProcess } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, toUtf8Bytes, TypedDataEncoder } from "ethers";
import { loadConfig, uint256, UINT256_MAX } from "../src/config.js";
import { creditTerms, principalCap } from "../src/rules.js";
import { createHttpServer } from "../src/http.js";
import { AUTH_TYPES, Rejection, Underwriter } from "../src/underwriter.js";
import { key, tx, read, startAnvil, stopAnvil, fixture } from "./fixture.js";

test("rules preserve count gates, exact units, and two independent integer floors", () => {
  const counts = (repayment: bigint, success: bigint, defaults = 0n) => ({ repayment, success, default: defaults });
  assert.equal(creditTerms(counts(0n, 10n), 0n).tier, "C"); // Success alone cannot establish repayment.
  assert.equal(creditTerms(counts(3n, 3n), 0n).tier, "C");
  assert.equal(creditTerms(counts(3n, 3n), 1n).tier, "B");
  assert.equal(creditTerms(counts(1n, 2n), 3n).tier, "B"); // A needs both mirror and truth >= 3.
  assert.equal(creditTerms(counts(3n, 3n), 3n).tier, "A");
  assert.equal(creditTerms(counts(0n, 0n), 3n).tier, "C"); // Delayed mirror never upgrades the agent.
  assert.equal(creditTerms(counts(100n, 100n, 2n), 100n).score, 400n);
  assert.deepEqual(principalCap(20n, 6, 10n ** 18n, 150000n, 8000n, 1500n),
    { tierCap: 200000n, escrowCap: 104347n, principalCap: 104347n });
  assert.equal(principalCap(20n, 18, 10n ** 18n, 10n ** 18n, 8000n, 1500n).principalCap, 200000000000000000n);
  assert.equal(principalCap(20n, 6, 2n * 10n ** 18n, 1000000n, 8000n, 1500n).tierCap, 100000n);
  assert.equal(principalCap(20n, 6, 10n ** 18n, 1n, 8000n, 1500n).principalCap, 0n);
  assert.equal(uint256(UINT256_MAX.toString(), "id"), UINT256_MAX);
  for (const value of [1, "01", "-1", "1e6", (UINT256_MAX + 1n).toString()]) assert.throws(() => uint256(value, "id"));
  assert.throws(() => loadConfig({}), /RPC_URL is required/);
});

test("borrowed RPC survives Underwriter close, restart and rejected initialization", { timeout: 30_000 }, async () => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-underwriter-provider-"));
  let child: ChildProcess | undefined;
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  try {
    const local = await startAnvil(); child = local.child;
    f = await fixture(local.rpc, directory, 6);
    // An unusable configured URL makes accidental direct connections observable.
    const config = { ...f.config, rpcUrl: "http://127.0.0.1:1" };
    const borrowed = new Underwriter(config, f.provider);
    try { await borrowed.initialize(); assert.equal((await borrowed.credit(1n)).terms.tier, "C"); }
    finally { borrowed.close(); }
    assert.equal(f.provider.destroyed, false);
    assert.equal(await f.provider.send("eth_chainId", []), "0x7a69");
    const restarted = new Underwriter(config, f.provider);
    try { await restarted.initialize(); }
    finally { restarted.close(); }
    const wrongChain = new Underwriter({ ...config, chainId: 10143n }, f.provider);
    try { await assert.rejects(wrongChain.initialize(), (error: unknown) => error instanceof Rejection && error.code === "NETWORK_MISMATCH"); }
    finally { wrongChain.close(); }
    assert.equal(await f.provider.send("eth_chainId", []), "0x7a69");
    const owned = new Underwriter(f.config);
    owned.close();
    await assert.rejects(owned.initialize(), { code: "UNSUPPORTED_OPERATION" });
  } finally { await f?.close(); if (child) await stopAnvil(child); await rm(directory, { recursive: true, force: true }); }
});

test("real HTTP signatures are consumed by Anvil contracts in USDC-6 and native-18 modes", { timeout: 120_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "agentfuel-underwriter-"));
  let child: ChildProcess | undefined;
  try {
    const local = await startAnvil();
    child = local.child;
    const rpc = local.rpc;
    for (const decimals of [6, 18] as const) {
      await t.test(decimals === 6 ? "USDC-6 actual draw, rejection gates, evidence and mirrored defaults" : "native-18 same actual asset flow", async () => {
        const f = await fixture(rpc, join(directory, String(decimals)), decimals);
        try {
          const taskId = await f.task();
          const replayTask = await f.task();
          const shortTask = await f.task(15n * f.unit / 100n, 300);
          const nonce = 11n;
          // An independent registry client cannot manufacture protocol counts.
          await tx(f.reputation, f.admin, "giveFeedback", [f.agentId, 999, 0, "infercredit", "repayment", "", "", "0x" + "00".repeat(32)]);
          const credit = await f.request(`/agents/${f.agentId}/credit`);
          assert.equal(credit.status, 200);
          assert.equal(credit.body.mirror.repayment, "0");
          assert.equal(credit.body.terms.tier, "C");
          const authorized = await f.authorize(taskId, nonce);
          assert.equal(authorized.status, 200, JSON.stringify(authorized.body));
          const { authorization: auth, signature, domain } = authorized.body;
          const expectedCap = decimals === 6 ? 104347n : 104347826086956521n;
          assert.equal(auth.principalCap, expectedCap.toString());
          assert.equal(auth.feeBps, "1500");
          assert.equal(auth.riskTier, 3);
          const evidenceBytes = await readFile(join(f.config.evidenceDir, `${auth.evidenceHash}.json`), "utf8");
          assert.equal(keccak256(toUtf8Bytes(evidenceBytes)), auth.evidenceHash);
          assert.ok(!evidenceBytes.includes(f.config.privateKey));
          const evidence = JSON.parse(evidenceBytes);
          assert.equal(evidence.block.hash, (await f.provider.getBlock(evidence.block.number))!.hash);
          assert.equal(auth.authDeadline, String(evidence.block.timestamp + 1800));
          assert.equal(auth.loanDueAt, String(evidence.block.timestamp + 86400));
          assert.equal(TypedDataEncoder.hash(domain, AUTH_TYPES, auth), await read(f.manager, "hashAuthorization", [auth]));
          const replay = await f.authorize(replayTask, nonce); // Two unconsumed authorizations; the chain arbitrates nonce use.
          assert.equal(replay.status, 200);
          const short = await f.authorize(shortTask, 12n);
          assert.equal(short.status, 200);
          assert.equal(short.body.authorization.loanDueAt, (await read(f.escrow, "getTask", [shortTask])).deadline.toString());
          const mismatch = await f.authorize(taskId, 12n, 2n);
          assert.equal(mismatch.body.error, "AGENT_NOT_FOUND");
          await tx(f.identity, f.admin, "registerFor", [f.agentAddress, f.agentAddress]);
          assert.equal((await f.authorize(taskId, 12n, 2n)).body.error, "NOT_ENROLLED");
          await tx(f.manager, f.admin, "enrollAgent", [2n]);
          assert.equal((await f.authorize(taskId, 12n, 2n)).body.error, "TASK_AGENT_MISMATCH");
          assert.equal((await f.authorize(0n, 12n)).body.error, "TASK_NOT_ASSIGNED");
          await tx(f.manager, f.admin, "freezeAgent", [f.agentId]);
          assert.equal((await f.authorize(taskId, 12n)).body.error, "PROTOCOL_FROZEN");
          await tx(f.manager, f.admin, "unfreezeAgent", [f.agentId]);
          await tx(f.manager, f.admin, "setDrawPaused", [true]);
          assert.equal((await f.authorize(taskId, 12n)).body.error, "DRAW_PAUSED");
          await tx(f.manager, f.admin, "setDrawPaused", [false]);
          await tx(f.identity, f.admin, "cheatSetWalletOnly", [f.agentId, f.payee]);
          assert.equal((await f.authorize(taskId, 12n)).body.error, "IDENTITY_CHANGED");
          await tx(f.identity, f.admin, "cheatSetWalletOnly", [f.agentId, f.agentAddress]);
          const before = await f.providerBalance();
          const paymentId = keccak256(toUtf8Bytes(`golden-${decimals}`));
          await tx(f.account, f.agent, "payProvider", [f.agentId, f.payee, 12n * f.unit / 100n, paymentId, auth, signature]);
          const loan = await read(f.manager, "getLoan", [taskId]);
          assert.equal(loan.status, 1n);
          assert.equal(loan.principal, 8n * f.unit / 100n);
          assert.equal(loan.fee, 12n * f.unit / 1000n);
          assert.equal((await f.providerBalance()) - before, 12n * f.unit / 100n);
          assert.equal(await read(f.account, "cash", [f.agentId]), 0n);
          assert.equal(await read(f.manager, "usedNonces", [f.agentId, nonce]), true);
          assert.equal(await read(f.manager, "totalOutstanding"), 92n * f.unit / 1000n);
          assert.equal((await f.authorize(replayTask, nonce)).body.error, "NONCE_USED");
          assert.equal((await f.authorize(taskId, 13n)).body.error, "LOAN_EXISTS");
          await assert.rejects(f.account.connect(f.agent).getFunction("payProvider").staticCall(f.agentId, f.payee,
            8n * f.unit / 100n, keccak256(toUtf8Bytes(`replay-${decimals}`)), replay.body.authorization, replay.body.signature),
            (error: any) => f.manager.interface.parseError(error.data)?.name === "NonceAlreadyUsed");
          assert.equal((await read(f.manager, "getLoan", [replayTask])).status, 0n);
          // A real repayment can finish while the registry mirror fails. It must stay C until retry.
          await tx(f.reputation, f.admin, "cheatSetFailing", [true]);
          await tx(f.escrow, f.admin, "settle", [taskId, true]);
          assert.equal(await read(f.escrow, "pendingFeedback", [taskId, 1]), true);
          assert.equal(await read(f.escrow, "pendingFeedback", [taskId, 2]), true);
          const delayed = await f.request(`/agents/${f.agentId}/credit`);
          assert.equal(delayed.body.truth.repayment, "1");
          assert.equal(delayed.body.mirror.repayment, "0");
          assert.equal(delayed.body.terms.tier, "C");
          await tx(f.reputation, f.admin, "cheatSetFailing", [false]);
          await tx(f.escrow, f.admin, "retryFeedback", [taskId, 1]);
          await tx(f.escrow, f.admin, "retryFeedback", [taskId, 2]);
          assert.equal(await read(f.escrow, "pendingFeedback", [taskId, 1]), false);
          assert.equal(await read(f.escrow, "pendingFeedback", [taskId, 2]), false);
          await tx(f.adapter, f.admin, "setReporter", [await f.admin.getAddress(), true]);
          for (const tag of ["repayment", "repayment", "task-success", "task-success"]) {
            await tx(f.adapter, f.admin, "reportFeedback", [f.agentId, tag, 100, 0], { gasLimit: 1_000_000 });
          }
          const gated = await f.request(`/agents/${f.agentId}/credit`);
          assert.equal(gated.body.terms.score, "710");
          assert.equal(gated.body.mirror.repayment, "3");
          assert.equal(gated.body.truth.repayment, "1");
          assert.equal(gated.body.terms.tier, "B"); // Three claimed mirrors do not promote one true repayment to A.
          await tx(f.reputation, f.admin, "cheatSetSummaryMode", [1]);
          assert.equal((await f.request(`/agents/${f.agentId}/credit`)).body.terms.score, "710");
          await tx(f.adapter, f.admin, "reportFeedback", [2n, "default", -100, 0], { gasLimit: 1_000_000 });
          assert.equal(await read(f.manager, "defaultCount", [2n]), 0n);
          assert.equal((await f.authorize(taskId, 14n, 2n)).body.error, "MIRRORED_DEFAULT");
          const zero = await f.task(1n);
          assert.equal((await f.authorize(zero, 14n)).body.error, "ZERO_CAP");
          const expiring = await f.authorize(replayTask, 13n);
          assert.equal(expiring.status, 200);
          await f.provider.send("evm_increaseTime", [1801]);
          await f.provider.send("evm_mine", []);
          assert.equal((await f.authorize(shortTask, 14n)).body.error, "TASK_EXPIRED");
          await assert.rejects(f.account.connect(f.agent).getFunction("payProvider").staticCall(f.agentId, f.payee,
            12n * f.unit / 100n, keccak256(toUtf8Bytes(`expired-${decimals}`)), expiring.body.authorization, expiring.body.signature),
            (error: any) => { const decoded = f.manager.interface.parseError(error.data); return decoded?.name === "AuthExpired" && decoded.args.authDeadline === BigInt(expiring.body.authorization.authDeadline); });
          assert.equal(await read(f.manager, "usedNonces", [f.agentId, 13n]), false);
          // Runtime signing checks still apply even if initialization was skipped.
          for (const [patch, expected] of [
            [{ chainId: 10143n }, "NETWORK_MISMATCH"], [{ privateKey: key(5) }, "SIGNER_MISMATCH"],
            [{ settlementAsset: f.payee }, "ASSET_MISMATCH"], [{ assetDecimals: decimals === 6 ? 18 : 6 }, "DECIMALS_MISMATCH"],
          ] as const) {
            const bad = new Underwriter({ ...f.config, ...patch });
            try {
              await assert.rejects(bad.initialize(), (error: unknown) => error instanceof Rejection && error.code === expected);
              await assert.rejects(bad.authorize(f.agentId, replayTask, 14n), (error: unknown) => error instanceof Rejection && error.code === expected);
            } finally { bad.close(); }
          }
          if (decimals === 6) {
            const cors = createHttpServer(f.underwriter, "http://localhost:3000");
            cors.listen(0, "127.0.0.1"); await once(cors, "listening");
            try {
              const base = `http://127.0.0.1:${(cors.address() as { port: number }).port}`;
              const allowed = await fetch(base + "/authorize", { method: "OPTIONS", headers: { origin: "http://localhost:3000" } });
              assert.equal(allowed.status, 204); assert.equal(allowed.headers.get("access-control-allow-origin"), "http://localhost:3000");
              assert.equal((await fetch(base + "/authorize", { method: "OPTIONS", headers: { origin: "http://evil.invalid" } })).status, 403);
            } finally { await new Promise<void>(resolve => cors.close(() => resolve())); }
            for (const invalid of [ { agentId: 1, taskId: "1", nonce: "1" }, { agentId: "01", taskId: "1", nonce: "1" },
              { agentId: "1", taskId: "1", nonce: (UINT256_MAX + 1n).toString() }, { agentId: "1", taskId: "1" } ]) {
              assert.equal((await f.request("/authorize", invalid)).status, 400);
            }
            assert.equal((await f.request("/authorize", { agentId: "1", taskId: "1", nonce: "1", pad: "x".repeat(4096) })).status, 413);
            const blockedDir = join(directory, "not-a-directory");
            await writeFile(blockedDir, "file");
            const blocked = new Underwriter({ ...f.config, evidenceDir: blockedDir });
            const blockedServer = createHttpServer(blocked);
            blockedServer.listen(0, "127.0.0.1");
            await once(blockedServer, "listening");
            try {
              const response = await fetch(`http://127.0.0.1:${(blockedServer.address() as { port: number }).port}/authorize`,
                { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ agentId: "1", taskId: replayTask.toString(), nonce: "14" }) });
              assert.equal(response.status, 503);
              assert.deepEqual(await response.json(), { error: "SERVICE_UNAVAILABLE", message: "RPC or evidence storage unavailable" });
              assert.equal(await read(f.manager, "usedNonces", [f.agentId, 14n]), false);
              assert.ok((await readdir(f.config.evidenceDir)).every(file => !file.endsWith(".tmp")));
            } finally { await new Promise<void>(resolve => blockedServer.close(() => resolve())); blocked.close(); }
          }
          const defaultTask = await f.task();
          const defaultAuth = await f.authorize(defaultTask, 15n);
          assert.equal(defaultAuth.status, 200);
          await tx(f.account, f.agent, "payProvider", [f.agentId, f.payee, 12n * f.unit / 100n,
            keccak256(toUtf8Bytes(`default-${decimals}`)), defaultAuth.body.authorization, defaultAuth.body.signature]);
          await tx(f.reputation, f.admin, "cheatSetFailing", [true]);
          await tx(f.escrow, f.admin, "settle", [defaultTask, false]);
          const defaulted = await f.request(`/agents/${f.agentId}/credit`);
          assert.equal(defaulted.body.truth.default, "1");
          assert.equal(defaulted.body.mirror.default, "0");
          assert.equal(defaulted.body.eligible, false);
          assert.equal(defaulted.body.rejection, "PROTOCOL_DEFAULT");
          assert.equal((await f.authorize(replayTask, 16n)).body.error, "PROTOCOL_DEFAULT");
        } finally { await f.close(); }
      });
    }
  } finally { if (child) await stopAnvil(child); await rm(directory, { recursive: true, force: true }); }
});
