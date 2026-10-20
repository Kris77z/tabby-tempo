import { createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";
import { realpath } from "node:fs/promises";
import { Contract, JsonRpcProvider, keccak256, Transaction, toUtf8Bytes, Wallet } from "ethers";
import { InferCredit, PaymentError } from "@agentfuel/sdk";
import { accountInterface, uint } from "@agentfuel/sdk/protocol";
import { canonicalReceipt, cliFailure, readJson, sendOnce, withJournal } from "./durable.mjs";
import { assertEconomics, configValue, digest, PROBLEM, same, SUBMISSION_TYPES, verifyPublication } from "./protocol.mjs";

async function request(url, init) {
  const response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(30000) });
  const body = await response.json();
  if (!response.ok) throw new Error(/^[A-Z_]+$/.test(body.error) ? body.error : "ARENA_UNAVAILABLE");
  return body;
}
export async function paymentAdmission(config, manifest, provider, escrow, account, handle) {
  const payment = await account.getPayment(handle.quote.paymentId);
  if (payment.fromCash + payment.fromCredit > 0n) return; // Existing paid work remains recoverable after its deadline.
  const [task, block] = await Promise.all([escrow.getTask(manifest.publication.taskId), provider.getBlock("latest")]);
  if (task.status !== 2n || String(task.agentId) !== config.agentId) throw new PaymentError("TASK_NOT_ASSIGNED", "No new payment without the original assignment");
  if (!block || BigInt(block.timestamp) >= task.deadline || Date.now() >= Number(task.deadline) * 1000
    || Date.now() >= config.solveDeadlineMs) throw new PaymentError("TASK_DEADLINE_PASSED", "No new payment after the task or solving deadline");
  if (handle.submission?.rawTransaction) {
    const transaction = Transaction.from(handle.submission.rawTransaction);
    const authorization = accountInterface.decodeFunctionData("payProvider", transaction.data)[4];
    if (authorization.feeBps > BigInt(config.maxBorrowFeeBps)) throw new PaymentError("BORROW_FEE_BOUND_EXCEEDED", "Borrowing fee exceeds the admitted bound");
  }
}
/** Called only for a new model dispatch; Delivered SDK cache never invokes it. */
export async function dispatchAdmission(config, manifest, provider, escrow, state, save, handle) {
  const check = async (own) => {
    if (state.stopped || state.terminal || state.sealed || state.stopReason || (own ? state.dispatchAdmission !== own : state.dispatchAdmission !== undefined)) throw new PaymentError("DISPATCH_NOT_AUTHORIZED", "Original dispatch cannot be repeated");
    const task=await escrow.getTask(manifest.publication.taskId), block=await provider.getBlock("latest");
    if (!block || task.status!==2n || String(task.agentId)!==config.agentId || Date.now()>=config.solveDeadlineMs || Date.now()>=Number(task.deadline)*1000 || BigInt(block.timestamp)>=task.deadline) throw new PaymentError("DISPATCH_NOT_AUTHORIZED", "No new dispatch after a stop or deadline");
  };
  await check();
  const reservation={paymentId:handle.quote.paymentId,taskId:manifest.publication.taskId,attempts:1};
  state.dispatchAdmission=reservation; await save();
  // Check again after persistence without treating our own reservation as reuse.
  if (state.dispatchAdmission !== reservation) throw new PaymentError("DISPATCH_NOT_AUTHORIZED", "Admission changed while saving");
  await check(reservation);
}
export async function resumeSubmission(state, save, allowed, taskId, post, deadlineMs) {
  const binding=()=>({runId:state.runId,taskId,submissionSha256:createHash("sha256").update(JSON.stringify(state.submission)).digest("hex"),attempts:1});
  const check=()=>{
    if (allowed !== true || !Number.isSafeInteger(deadlineMs) || Date.now()>=deadlineMs || state.stopped || state.terminal || state.sealed || state.stopReason || !state.runId || state.submission?.taskId!==taskId) throw Error("SUBMISSION_RECOVERY_NOT_AUTHORIZED");
  };
  check(); if(state.submissionRecovery!==undefined)throw Error("SUBMISSION_RECOVERY_NOT_AUTHORIZED");
  const reservation=binding(); state.submissionRecovery=reservation; await save();
  check(); if(state.submissionRecovery!==reservation || JSON.stringify(binding())!==JSON.stringify(reservation))throw Error("SUBMISSION_RECOVERY_NOT_AUTHORIZED");
  const resumed=await post();
  if(resumed.runId!==state.runId || resumed.taskId!==taskId)throw Error("ARENA_RESUME_MISMATCH");
  return resumed;
}
async function settlement(config, manifest, run, provider, escrow) {
  const result = run.result, p = manifest.publication;
  if (run.taskId !== p.taskId || result?.verdict?.taskId !== p.taskId || result.verdict.problemId !== PROBLEM.problemId
    || result.verdict.mode !== "docker" || result.verdict.agentId !== config.agentId || result.settlement.taskId !== p.taskId) throw new Error("ARENA_RESULT_MISMATCH");
  const receipt = await canonicalReceipt(provider, result.settlement.txHash);
  const transaction = await provider.getTransaction(result.settlement.txHash);
  if (!receipt || !transaction || !same(transaction.to, config.escrow) || !same(transaction.from, config.verifier)) throw new Error("SETTLEMENT_RECEIPT_INVALID");
  const events = receipt.logs.filter(log => same(log.address, config.escrow)).map(log => {
    try { return escrow.interface.parseLog(log); } catch { return null; }
  }).filter(event => event?.name === "TaskSettled" && String(event.args.taskId) === p.taskId);
  const task = await escrow.getTask(p.taskId);
  if (events.length !== 1 || events[0].args.passed !== result.verdict.passed || task.status !== (result.verdict.passed ? 3n : 4n)
    || String(task.agentId) !== config.agentId || task.escrowBalance !== 0n) throw new Error("SETTLEMENT_CHAIN_MISMATCH");
  return { passed: result.verdict.passed, txHash: receipt.hash, blockNumber: receipt.blockNumber,
    repaid: String(events[0].args.repaid), slashed: String(events[0].args.slashed), residual: String(events[0].args.agentResidual) };
}
export async function work(config, manifest, journalPath, privateKey, { stopAfterDelivery = false, allowSubmissionRecovery = false } = {}) {
  configValue(config);
  uint(config.agentId, "agentId");
  if (config.agentId === "0" || !Number.isSafeInteger(config.solveDeadlineMs)) throw new Error("INVALID_WORKER_CONFIG");
  const economics = assertEconomics(config, manifest.publication);
  const provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 100 });
  try {
    const signer = new Wallet(privateKey, provider);
    if (same(signer.address, config.poster) || same(signer.address, config.verifier)) throw new Error("WORKER_ROLE_MISMATCH");
    const { escrow, task } = await verifyPublication(config, manifest, provider);
    const adapter = new Contract(await escrow.adapter(), ["function resolveAgent(uint256) view returns(address owner,address wallet)"], provider);
    const identity = await adapter.resolveAgent(config.agentId);
    if (!same(identity.wallet, signer.address)) throw new Error("WORKER_WALLET_MISMATCH");
    const body = { service: "infercredit/solve-fixed", model: "pi-fixed-v1", messages: [{ role: "user", content: PROBLEM.prompt }],
      solve: { version: 1, problemId: PROBLEM.problemId, tiers: ["cheap", "strong"], maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 256, deadlineMs: config.solveDeadlineMs } };
    return await withJournal(journalPath, digest({ config, manifest, body }), async (state, save) => {
      if (task.status !== 1n && !(String(task.agentId) === config.agentId && [2n, 3n, 4n].includes(task.status))) throw new Error("TASK_NOT_AVAILABLE");
      if (!state.delivery && !state.payment && (BigInt((await provider.getBlock("latest")).timestamp) >= task.deadline || Date.now() >= config.solveDeadlineMs)) throw new Error("TASK_DEADLINE_PASSED");
      const account = new Contract(config.account, ["function cash(uint256) view returns(uint256)", "function getPayment(bytes32) view returns(tuple(uint256 agentId,uint256 taskId,uint256 fromCash,uint256 fromCredit,uint256 refundedAmount))"], provider);
      if (!state.opening) {
        if (task.status !== 1n) throw new Error("ORIGINAL_WORKER_JOURNAL_REQUIRED");
        state.opening = { cash: String(await account.cash(config.agentId)), economics }; await save();
      }
      if (task.status === 1n || state.transactions.accept) {
        await sendOnce(state, save, "accept", signer, await escrow.acceptTask.populateTransaction(manifest.publication.taskId, config.agentId));
      }
      if (!state.delivery) {
        const client = new InferCredit({ agentId: config.agentId, rpcUrl: config.rpcUrl, sessionKey: privateKey,
          chainId: BigInt(config.chainId), account: config.account, asset: config.asset, provider: config.provider,
          maxPrice: BigInt(config.maxPrice), underwriterUrl: config.underwriterUrl, timeoutMs: 30000,
          onHandle: async handle => { state.payment = handle; await save(); },
          beforeDispatch: handle => dispatchAdmission(config, manifest, provider, escrow, state, save, handle),
          beforePayment: handle => paymentAdmission(config, manifest, provider, escrow, account, handle) });
        try {
          const delivery = state.payment ? await client.resume(state.payment) : await client.forTask(manifest.publication.taskId).fetch(config.relayUrl, { body });
          if (delivery.result?.schema !== 1 || delivery.result.taskId !== manifest.publication.taskId || typeof delivery.result.code !== "string"
            || delivery.result.codeHash !== createHash("sha256").update(delivery.result.code).digest("hex")) throw new Error("PAID_ARTIFACT_MISMATCH");
          state.delivery = delivery; await save();
        } finally { client.close(); }
      }
      if (stopAfterDelivery) return { state: "Delivered", taskId: manifest.publication.taskId, paymentId: state.payment.quote.paymentId };
      if (!state.submission) {
        const code = state.delivery.result.code, deadline = String((await provider.getBlock("latest")).timestamp + 240);
        const message = { taskId: manifest.publication.taskId, agentId: config.agentId, codeHash: keccak256(toUtf8Bytes(code)), deadline };
        state.submission = { taskId: message.taskId, code, deadline, signature: await signer.signTypedData({ name: "InferCreditArena", version: "1", chainId: config.chainId, verifyingContract: config.escrow }, SUBMISSION_TYPES, message) };
        await save();
      }
      const recoveringRun = Boolean(state.runId);
      if (!state.runId) {
        const admitted = await request(`${config.arenaUrl}/submissions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.submission) });
        if (admitted.taskId !== manifest.publication.taskId || typeof admitted.runId !== "string") throw new Error("ARENA_ADMISSION_MISMATCH");
        state.runId = admitted.runId; await save();
      }
      if (!state.run) {
        if (recoveringRun) {
          const prior = await request(`${config.arenaUrl}/runs/${state.runId}`);
          if (prior.status === "error") {
            await resumeSubmission(state, save, allowSubmissionRecovery, manifest.publication.taskId, () => request(`${config.arenaUrl}/submissions`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(state.submission) }), config.solveDeadlineMs);
          }
        }
        const timeout = Date.now() + 120000;
        while (Date.now() < timeout) {
          const run = await request(`${config.arenaUrl}/runs/${state.runId}`);
          if (run.status === "error") throw new Error(run.error ?? "ARENA_ERROR");
          if (run.status === "settled") { state.run = run; await save(); break; }
          await delay(100);
        }
        if (!state.run) throw new Error("ARENA_PENDING");
      }
      const settled = await settlement(config, manifest, state.run, provider, escrow);
      state.settlement = settled; await save();
      return { state: "Settled", taskId: manifest.publication.taskId, paymentId: state.payment.quote.paymentId,
        agentId: config.agentId, openingCash: state.opening.cash, closingCash: String(await account.cash(config.agentId)), settlement: settled };
    });
  } finally { provider.destroy(); }
}
async function main() {
  const [configFile, manifestFile, journalFile, mode, ...extra] = process.argv.slice(2);
  if (!configFile || !manifestFile || !journalFile || extra.length || mode && !["--stop-after-delivery","--allow-submission-recovery"].includes(mode)) throw new Error("WORKER_ARGUMENTS_REQUIRED");
  if (!process.env.WORKER_PRIVATE_KEY) throw new Error("WORKER_KEY_REQUIRED");
  if (process.env.ARENA_VERIFIER_PRIVATE_KEY || process.env.PUBLISHER_PRIVATE_KEY) throw new Error("WORKER_ROLE_KEY_LEAK");
  console.log(JSON.stringify(await work(await readJson(configFile), await readJson(manifestFile), journalFile, process.env.WORKER_PRIVATE_KEY, { stopAfterDelivery: mode === "--stop-after-delivery", allowSubmissionRecovery: mode === "--allow-submission-recovery" })));
}
if (process.argv[1] && import.meta.url === pathToFileURL(await realpath(process.argv[1])).href) await main().catch(cliFailure);
