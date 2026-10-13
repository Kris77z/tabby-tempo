import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toUtf8Bytes, Wallet } from "ethers";
import { canonical } from "../packages/sdk/src/protocol.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { InferenceGateway } from "../services/hosted-agents/src/inference-gateway.js";
import { unsealedLedgerDigest } from "../services/hosted-agents/src/inference-closure.js";
import { findHostedAllowanceLedger, verifyHostedAllowanceClosure } from "../services/hosted-agents/src/allowance-closure-reader.js";
import { atomicJson } from "../services/arena/src/protocol.js";
import { reportDemoFailure } from "./demo-common.js";

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
/** inspect is filesystem-only; apply seals the original Unknown allowance without dispatching inference. */
export async function resolveTempoAllowance(runtimeDirectory: string, paymentId: string, mode: "inspect" | "apply" | "recover") {
  const directory = resolve(runtimeDirectory);
  assert.ok(runtimeDirectory && /^0x[0-9a-f]{64}$/.test(paymentId) && ["inspect", "apply", "recover"].includes(mode), "TEMPO_RESOLUTION_ARGUMENTS_INVALID");
  const ready = await read(join(directory, "ready.json"));
  assert.equal(ready.chainId, "42431", "TEMPO_RESOLUTION_CHAIN_REQUIRED");
  assert.equal(typeof ready.bootstrapFile, "string", "TEMPO_BOOTSTRAP_FILE_REQUIRED");
  assert.equal(resolve(ready.bootstrapFile), ready.bootstrapFile, "TEMPO_BOOTSTRAP_FILE_REQUIRED");
  const bootstrap = await read(ready.bootstrapFile);
  assert.equal(bootstrap.chainId, "42431", "TEMPO_RESOLUTION_CHAIN_REQUIRED");
  const ledgerFile = await findHostedAllowanceLedger(join(directory, "hosted"), paymentId), ledger = await read(ledgerFile);
  assert.ok(ledger.invocations?.length > 0 && ledger.invocations.every((v: any) => v.state === "Unknown" && !v.result), "Only durably Unknown invocations can enter this compensation policy");
  assert.ok(ledger.grants?.length === 1 && ledger.grants[0].source?.kind === "chain-payment" && ledger.grants[0].source.paymentId === paymentId, "Only one original paid allowance may be sealed");
  const purchase = await read(join(dirname(dirname(ledgerFile)), "allowance-purchase", "session.json"));
  const quote = purchase.handle.quote;
  assert.equal(quote.paymentId, paymentId); assert.equal(quote.chainId, "42431", "TEMPO_RESOLUTION_CHAIN_REQUIRED");
  assert.equal(quote.account.toLowerCase(), bootstrap.contracts.account.toLowerCase());
  assert.equal(quote.asset.toLowerCase(), bootstrap.asset.address.toLowerCase());
  assert.equal(ledger.grants[0].source.txHash, purchase.handle.submission.txHash);
  assert.equal(purchase.inference.result.kind, "inference-allowance");
  const db = await read(join(directory, "hosted/database/session.json"));
  assert.ok(db.runs.every((run: any) => !["Queued", "Running"].includes(run.status)), "Wait for live hosted writes to finish");
  const agent = db.agents.find((a: any) => a.binding?.agentId === quote.agentId); assert.ok(agent);
  assert.equal(agent.binding.chainId, "42431"); assert.equal(agent.wallet.toLowerCase(), ledger.binding.wallet.toLowerCase());
  assert.equal(ledger.binding.agentId, quote.agentId); assert.equal(ledger.binding.taskId, quote.taskId);
  const parent = db.runs.find((r: any) => r.agentId === agent.id && ledgerFile.includes(`/runs/${r.requestId}/`)); assert.ok(parent);
  const evidence = { version: 1, kind: "operator-compensation-for-unknown-inference", chainId: "42431", account: quote.account,
    agentId: quote.agentId, taskId: quote.taskId, paymentId, paymentTxHash: purchase.handle.submission.txHash,
    ledgerDigest: unsealedLedgerDigest(ledger), unknownCalls: ledger.invocations.map((v: any) => ({ id: v.id, requestDigest: v.requestDigest,
      state: v.state, httpStatus: v.response?.status ?? null, responseDigest: v.response ? createHash("sha256").update(canonical(v.response)).digest("hex") : null })),
    policy: "Operator assumes all uncertain supplier cost; permanently revoke the original allowance, compensate its full price once, then independently terminate the uncompleted task and return poster escrow. This does not assert zero vendor cost or hidden-test failure." };
  const evidenceDigest = keccak256(toUtf8Bytes(canonical(evidence))), operationDirectory = join(directory, "allowance-resolution", paymentId);
  if (mode === "inspect") {
    let existing: any;
    try { existing = await read(join(operationDirectory, "session.json")); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (existing) assert.equal(existing.evidenceDigest, evidenceDigest, "RESOLUTION_EVIDENCE_CHANGED");
    return { readOnly: true, paymentId, taskId: quote.taskId, parentRequestId: parent.requestId, evidenceDigest, fullCompensationRaw: quote.price,
      vendorCost: "unknown", permanentlySealed: Boolean(ledger.closure), ...(existing ? { resolutionId: existing.resolutionId, abortCompleted: Boolean(existing.abortCompleted) } : {}) };
  }
  const operation = new SessionStore<any>(operationDirectory);
  await operation.start(true); let gateway: InferenceGateway | undefined;
  try {
    let state = await operation.read();
    if (state) {
      assert.equal(state.version, 1); assert.equal(state.evidenceDigest, evidenceDigest, "RESOLUTION_EVIDENCE_CHANGED");
      assert.equal(state.parentRequestId, parent.requestId, "RESOLUTION_PARENT_CHANGED"); assert.equal(state.agentId, agent.id, "RESOLUTION_AGENT_CHANGED");
    }
    else if (mode === "recover") throw new Error("RESOLUTION_APPLY_REQUIRED");
    else { state = { version: 1, evidence, evidenceDigest, resolutionId: randomUUID(), refundId: keccak256(toUtf8Bytes(randomUUID())),
      parentRequestId: parent.requestId, agentId: agent.id, createdAt: new Date().toISOString() }; await operation.write(state); }
    if (mode === "recover") {
      assert.ok(state.abortCompleted, "Canonical task termination is required before resuming original request");
      const owner = new Wallet((await readFile(join(directory, "owner.key"), "utf8")).trim()); let cookie = "";
      const api = async (path: string, body?: unknown) => {
        const response = await fetch(ready.frontendOrigin + "/api/hosted" + path, { method: body ? "POST" : "GET", headers: { origin: ready.frontendOrigin,
          "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(60000) });
        assert.ok(response.ok, `HOSTED_HTTP_${response.status}`); if (path === "/auth/login") cookie = response.headers.get("set-cookie")!.split(";")[0]; return response.json();
      };
      const challenge = await api("/auth/challenge", { wallet: owner.address });
      assert.ok(challenge.message.startsWith(`AgentFuel hosted agent login\nOrigin: ${ready.frontendOrigin}\nWallet: ${owner.address}\nChain: 42431\nNonce: `));
      assert.ok(challenge.message.endsWith("This signature authenticates your platform account. It authorizes no blockchain transaction."));
      await api("/auth/login", { challengeId: challenge.id, signature: await owner.signMessage(challenge.message) });
      await api(`/agents/${agent.id}/runs`, { action: parent.action, requestId: parent.requestId });
      const deadline = Date.now() + 180000;
      while (Date.now() < deadline) {
        const snapshot = await api("/agents"), run = snapshot.runs.find((r: any) => r.requestId === parent.requestId);
        if (run && !["Queued", "Running"].includes(run.status)) { state.recoveredRun = run; await operation.write(state);
          assert.equal(run.status, "Failed"); return { requestId: run.requestId, status: run.status, result: run.result }; }
        await new Promise(done => setTimeout(done, 2000));
      }
      throw new Error("RESOLUTION_RECOVERY_TIMEOUT");
    }
    gateway = await InferenceGateway.open(dirname(ledgerFile), ledger.binding, ledger.catalog, async () => { throw new Error("OPERATOR_CANNOT_DISPATCH"); }, true);
    state.closure = await gateway.sealUnknown({ paymentId, resolutionId: state.resolutionId, evidenceDigest, expectedLedgerDigest: evidence.ledgerDigest }); await operation.write(state);
    assert.ok(await verifyHostedAllowanceClosure(join(directory, "hosted"), state.closure));
    const runtime = await read(join(directory, "runtime-journal/session.json"));
    assert.ok(Number.isSafeInteger(ready.ports?.allowance) && ready.ports.allowance > 0 && ready.ports.allowance <= 65535, "RESOLUTION_ALLOWANCE_PORT_INVALID");
    const ops = async (route: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${ready.ports.allowance}/ops/${route}`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${runtime.operatorToken}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const result = await response.json(); state[route] = { httpStatus: response.status, result }; await operation.write(state);
      assert.ok(response.ok, `${route}:HTTP_${response.status}:${result.error?.code ?? result.error ?? "unknown"}`); return result;
    };
    await ops("compensate-allowance", { paymentId, resolutionId: state.resolutionId, evidenceDigest, closure: state.closure,
      certificateDigest: keccak256(toUtf8Bytes(canonical(state.closure))) });
    const refund = await ops("refund", { paymentId, refundId: state.refundId, amount: quote.price });
    assert.equal(refund.state, "Refunded"); assert.equal(refund.refundedAmount, quote.price);
    const confirmed = refund.confirmedRefunds.find((r: any) => r.refundId === state.refundId && r.amount === quote.price); assert.ok(confirmed?.txHash);
    const config = { version: 1, chainId: "42431", rpcUrlFile: bootstrap.rpcUrlFile, rpcTransport: bootstrap.rpcTransport,
      verifierKeyFile: bootstrap.roleKeyFiles.verifier, journalDirectory: join(operation.directory, "abort"), account: bootstrap.contracts.account,
      manager: bootstrap.contracts.manager, escrow: bootstrap.contracts.escrow, asset: bootstrap.asset.address, agentId: quote.agentId, taskId: quote.taskId,
      wallet: ledger.binding.wallet, paymentId, paymentTxHash: purchase.handle.submission.txHash, refundTxHash: confirmed.txHash, refundId: state.refundId,
      ledgerFile, resolutionId: state.resolutionId, evidenceDigest, reason: "task-abort/provider-unknown", maxFeePerGas: bootstrap.maxFeePerGas };
    const configFile = join(operation.directory, "abort-config.json"); await atomicJson(configFile, config);
    // Only this separate verifier process reads its key; the parent never sees key bytes.
    await new Promise<void>((done, reject) => {
      const child = spawn(process.execPath, ["--import", "tsx", fileURLToPath(new URL("./monad-abort-settler.ts", import.meta.url)), configFile, "--recover"],
        { cwd: fileURLToPath(new URL("..", import.meta.url)), env: process.env, stdio: ["ignore", "inherit", "inherit"] });
      child.once("error", reject); child.once("exit", code => code === 0 ? done() : reject(new Error("ABORT_CHILD_FAILED")));
    });
    state.abortCompleted = true; state.abortResult = (await read(join(config.journalDirectory, "session.json"))).result; await operation.write(state);
    return { paymentId, taskId: quote.taskId, compensationRaw: quote.price, refundTxHash: confirmed.txHash, termination: state.abortResult };
  } finally { await gateway?.close(); await operation.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, paymentId, mode] = process.argv.slice(2);
  if (!directory || !/^0x[0-9a-f]{64}$/.test(paymentId ?? "") || !["inspect", "apply", "recover"].includes(mode ?? "")) {
    console.error("Usage: tempo-allowance-resolution.ts RUNTIME PAYMENT_ID inspect|apply|recover"); process.exitCode = 1;
  } else resolveTempoAllowance(directory, paymentId, mode as "inspect" | "apply" | "recover")
    .then(result => console.log(JSON.stringify(result))).catch(error => { reportDemoFailure(error); process.exitCode = 1; });
}
