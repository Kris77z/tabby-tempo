import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toUtf8Bytes } from "ethers";
import { canonical } from "../packages/sdk/src/protocol.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { chainRpcProvider, readRpcUrlFile } from "./demo-rpc.js";
import { reportDemoFailure } from "./demo-common.js";

const read = async (file: string) => JSON.parse(await readFile(file, "utf8"));
/** Permanently resolve a paid Unknown planner without dispatching its original request. */
export async function resolveTempoPlanner(runtimeDirectory: string, paymentId: string, mode: "inspect" | "apply") {
  assert.ok(runtimeDirectory && /^0x[0-9a-f]{64}$/.test(paymentId) && ["inspect", "apply"].includes(mode));
  const directory = resolve(runtimeDirectory), ready = await read(join(directory, "ready.json"));
  assert.equal(ready.chainId, "42431");
  const bootstrap = await read(ready.bootstrapFile), record = await read(join(directory, "planner", `${paymentId}.json`));
  assert.equal(bootstrap.chainId, "42431");
  const quote = record.quote;
  assert.equal(quote.paymentId, paymentId); assert.equal(quote.chainId, "42431"); assert.equal(quote.taskId, "0");
  assert.equal(quote.service, "infercredit/plan"); assert.equal(quote.price, "10000");
  assert.equal(quote.account.toLowerCase(), bootstrap.contracts.account.toLowerCase());
  assert.equal(quote.asset.toLowerCase(), bootstrap.asset.address.toLowerCase());
  assert.equal(record.proof?.fromCash, quote.price); assert.equal(record.proof?.fromCredit, "0");
  assert.equal(record.result, undefined); assert.equal(record.receipt, undefined);
  assert.equal(record.upstreamAttempts?.length, 1); const attempt = record.upstreamAttempts[0];
  assert.equal(attempt.state, "Unknown"); assert.equal(attempt.model, "cheap/kimi-k2.6");
  const db = await read(join(directory, "hosted/database/session.json"));
  assert.ok(db.runs.every((run: any) => !["Queued", "Running"].includes(run.status)), "Wait for live hosted writes to finish");
  const agent = db.agents.find((item: any) => item.binding?.agentId === quote.agentId); assert.ok(agent);
  assert.equal(agent.binding.chainId, "42431");
  const gatewayDirectory = dirname(bootstrap.gatewayReadyFile);
  const calls = (await readFile(join(gatewayDirectory, "attempts.jsonl"), "utf8")).trim().split("\n").map(line => JSON.parse(line));
  const dispatches = calls.filter(call => call.phase === "DispatchIntent" && call.model === "kimi-k2.6" && Math.abs(Date.parse(call.at) - attempt.startedAt) < 1000);
  assert.equal(dispatches.length, 1); assert.equal(dispatches[0].maxCompletionTokens, 512);
  const outcomes = calls.filter(call => call.attempt === dispatches[0].attempt && call.phase !== "DispatchIntent");
  assert.equal(outcomes.length, 1); assert.equal(outcomes[0].phase, "OutcomeUnknown");
  const connection = await chainRpcProvider(await readRpcUrlFile(bootstrap.rpcUrlFile), "42431", bootstrap.rpcTransport);
  const operation = new SessionStore<any>(join(directory, "planner-resolution", paymentId));
  try {
    assert.equal(BigInt(await connection.provider.send("eth_chainId", [])), 42431n);
    const receipt = await connection.provider.getTransactionReceipt(record.proof.txHash);
    assert.equal(receipt?.status, 1); assert.equal(receipt?.blockHash, record.proof.blockHash);
    assert.equal((await connection.provider.getBlock(receipt!.blockNumber))?.hash, receipt!.blockHash);
    const expectedAttemptsDigest = keccak256(toUtf8Bytes(canonical(record.upstreamAttempts)));
    const evidence = { version: 1, kind: "operator-compensation-for-unknown-planner", chainId: "42431", paymentId, agentId: quote.agentId,
      priceRaw: quote.price, requestDigest: quote.requestDigest, payment: { txHash: receipt!.hash, blockNumber: receipt!.blockNumber, blockHash: receipt!.blockHash, canonical: true },
      relayAttempts: record.upstreamAttempts, gatewayDispatch: dispatches[0], gatewayOutcome: outcomes[0],
      observedDelivery: "No response result or delivery receipt; original serial gateway dispatch has OutcomeUnknown. Root cause is not established.",
      providerCost: "Unknown; operator assumes any supplier cost. This does not assert zero inference or zero cost.",
      policy: "Permanently disable this payment's original dispatch, refund the full cash-only planner price once, and reconcile the original parent UUID. A later decision uses a new ID within its original deadline and budget." };
    const evidenceDigest = keccak256(toUtf8Bytes(canonical(evidence)));
    if (mode === "inspect") return { readOnly: true, paymentId, evidenceDigest, expectedAttemptsDigest, fullRefundRaw: quote.price, vendorCost: "unknown" };
    await operation.start(true); let state = await operation.read();
    if (state) { assert.equal(state.evidenceDigest, evidenceDigest); assert.equal(state.expectedAttemptsDigest, expectedAttemptsDigest); }
    else { state = { version: 1, evidence, evidenceDigest, expectedAttemptsDigest, resolutionId: randomUUID(), refundId: keccak256(toUtf8Bytes(randomUUID())), createdAt: new Date().toISOString() }; await operation.write(state); }
    const runtime = await read(join(directory, "runtime-journal/session.json"));
    assert.ok(Number.isSafeInteger(ready.ports?.planner) && ready.ports.planner > 0 && ready.ports.planner <= 65535);
    const ops = async (route: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${ready.ports.planner}/ops/${route}`, { method: "POST", headers: {
        "content-type": "application/json", authorization: `Bearer ${runtime.operatorToken}` }, body: JSON.stringify(body), signal: AbortSignal.timeout(180000) });
      const result = await response.json(); state[route] = { httpStatus: response.status, result, observedAt: new Date().toISOString() }; await operation.write(state);
      assert.ok(response.ok, `${route}:HTTP_${response.status}:${result.error?.code ?? result.error ?? "unknown"}`); return result;
    };
    await ops("resolve-undelivered", { paymentId, resolutionId: state.resolutionId, expectedAttemptsDigest, evidenceDigest });
    const refund = await ops("refund", { paymentId, refundId: state.refundId, amount: quote.price });
    assert.equal(refund.state, "Refunded"); assert.equal(refund.refundedAmount, quote.price);
    const confirmed = refund.confirmedRefunds.find((item: any) => item.refundId === state.refundId && item.amount === quote.price); assert.ok(confirmed?.txHash);
    return { paymentId, refundedRaw: quote.price, refundTxHash: confirmed.txHash, resolutionId: state.resolutionId, journalDirectory: operation.directory, vendorCost: "unknown, assumed by operator" };
  } finally { connection.close(); await operation.close(); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [directory, paymentId, mode] = process.argv.slice(2);
  if (!directory || !/^0x[0-9a-f]{64}$/.test(paymentId ?? "") || !["inspect", "apply"].includes(mode ?? "")) {
    console.error("Usage: tempo-planner-resolution.ts RUNTIME PAYMENT_ID inspect|apply"); process.exitCode = 1;
  } else resolveTempoPlanner(directory, paymentId, mode as "inspect" | "apply")
    .then(result => console.log(JSON.stringify(result))).catch(error => { reportDemoFailure(error); process.exitCode = 1; });
}
