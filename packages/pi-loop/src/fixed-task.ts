import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { Contract, JsonRpcProvider, getAddress, type Signer } from "ethers";
import { ACCOUNT_ABI, MANAGER_ABI, accountInterface, InferCredit, PaymentError, type Inference, type PaymentHandle } from "@agentfuel/sdk";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { publicSampleFor, testPublicSample, type SampleResult } from "./public-sample.js";
import { validateSolveSpec, type SolveSpec, type ProviderSolveState } from "./provider.js";
import { SessionStore } from "./session.js";
import { submitProgrammingCandidate, type SubmissionState, type SubmissionConfig } from "./submission.js";

export interface FixedTaskConfig extends SubmissionConfig {
  account: string; asset: string; provider: string; relayUrl: string; underwriterUrl: string; maxServicePrice: string; solve: SolveSpec;
}
export interface FixedTaskSession extends SubmissionState {
  version: 1; binding: string; config: FixedTaskConfig; reservedPrice: string;
  handle?: PaymentHandle; inference?: Inference; qualification?: SampleResult; qualificationCodeHash?: string;
  refundConfirmation?: { amount: string; loanStatus: string; taskStatus: string };
}
export interface FixedTaskOptions { signer: Signer; provider?: JsonRpcProvider; runner?: DockerExecutor; recoverLock?: boolean; timeoutMs?: number; pollTimeoutMs?: number;
  onHandle?: (handle: PaymentHandle) => Promise<void> | void; beforePayment?: (handle: PaymentHandle) => Promise<void> | void }
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function stop(code: string): never { throw new PaymentError(code, code); }
interface SolveResult { schema: number; taskId: string; code: string; codeHash: string; run: ProviderSolveState }
function deliveredResult(state: FixedTaskSession, config: FixedTaskConfig): SolveResult {
  try {
    const receipt = state.inference?.receipt, quote = state.handle?.quote;
    const result = state.inference?.result as unknown as SolveResult;
    const run = result?.run;
    if (!receipt || !quote || !result || !run || !Array.isArray(run.rounds) || !Array.isArray(run.tools)) throw new Error();
    const last = run.rounds.at(-1);
    if (receipt.paymentId !== quote.paymentId || receipt.taskId !== config.taskId || receipt.agentId !== config.agentId || receipt.price !== quote.price ||
      receipt.requestDigest !== quote.requestDigest || receipt.service !== quote.service || receipt.chainId !== config.chainId ||
      receipt.account.toLowerCase() !== config.account.toLowerCase() || receipt.asset.toLowerCase() !== config.asset.toLowerCase() || receipt.payTo.toLowerCase() !== config.provider.toLowerCase() ||
      result.schema !== 1 || result.taskId !== config.taskId || typeof result.code !== "string" || !result.code || result.codeHash !== createHash("sha256").update(result.code).digest("hex") ||
      run.phase !== "Delivered" || !isDeepStrictEqual(run.spec, config.solve) || run.candidate !== result.code || run.codeHash !== result.codeHash ||
      !last || receipt.model !== last.model || receipt.upstream !== last.tier || !isDeepStrictEqual(receipt.usage, last.response?.usage ?? null) ||
      run.rounds.length > config.solve.maxRounds || run.tools.length > config.solve.maxToolCalls ||
      !run.tools.some(tool => tool?.code === result.code && tool.result?.passed === true) ||
      run.rounds.some((round, i) => !round || !round.body || round.state !== "Responded" || !round.response || round.tier !== config.solve.tiers[i] || round.body.model !== round.model || round.body.max_completion_tokens !== config.solve.maxCompletionTokens)) throw new Error();
    return result;
  } catch { stop("SERVICE_RESULT_INVALID"); }
}
export async function confirmPaidDelivery(state: Pick<FixedTaskSession, "inference" | "handle">, config: Pick<FixedTaskConfig, "chainId" | "account" | "agentId" | "provider" | "taskId">, rpc: JsonRpcProvider, signer: Signer) {
  try {
    if (BigInt(await rpc.send("eth_chainId", [])) !== BigInt(config.chainId)) stop("NETWORK_MISMATCH");
    const receipt = state.inference!.receipt, quote = state.handle!.quote;
    const account = new Contract(config.account, ACCOUNT_ABI, rpc);
    const [payment, transaction, rawReceipt] = await Promise.all([account.getFunction("getPayment").staticCall(quote.paymentId), rpc.getTransaction(receipt.txHash), rpc.getTransactionReceipt(receipt.txHash)]);
    const cash = BigInt(receipt.fromCash), credit = BigInt(receipt.fromCredit);
    if (payment.agentId !== BigInt(config.agentId) || cash + credit !== BigInt(quote.price) || payment.fromCash !== cash || payment.fromCredit !== credit || payment.refundedAmount !== 0n ||
      (credit > 0n && payment.taskId !== BigInt(config.taskId)) || !transaction || !transaction.to || transaction.to.toLowerCase() !== config.account.toLowerCase() ||
      transaction.from.toLowerCase() !== (await signer.getAddress()).toLowerCase() || (state.handle!.submission?.txHash && state.handle!.submission.txHash !== receipt.txHash) ||
      (state.handle!.submission && (state.handle!.submission.nonce !== transaction.nonce || state.handle!.submission.from.toLowerCase() !== transaction.from.toLowerCase())) ||
      rawReceipt?.status !== 1 || rawReceipt.blockNumber !== receipt.blockNumber || rawReceipt.blockHash !== receipt.blockHash) throw new Error();
    const block = await rpc.getBlock(rawReceipt.blockNumber);
    const call = accountInterface.parseTransaction({ data: transaction.data, value: transaction.value });
    const events = rawReceipt.logs.filter(log => log.address.toLowerCase() === config.account.toLowerCase()).map(log => { try { return accountInterface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "ProviderPaid" && event.args.paymentId === quote.paymentId);
    if (!block || block.hash !== rawReceipt.blockHash || block.timestamp !== receipt.timestamp || events.length !== 1 ||
      events[0]!.args.agentId !== BigInt(config.agentId) || events[0]!.args.provider.toLowerCase() !== config.provider.toLowerCase() || events[0]!.args.fromCash !== cash || events[0]!.args.fromCredit !== credit ||
      !call || call.name !== "payProvider" || call.args[0] !== BigInt(config.agentId) || call.args[1].toLowerCase() !== config.provider.toLowerCase() || call.args[2] !== BigInt(quote.price) || call.args[3] !== quote.paymentId ||
      (credit > 0n && call.args[4].taskId !== BigInt(config.taskId))) throw new Error();
  } catch (error) { if (error instanceof PaymentError) throw error; stop("SERVICE_PAYMENT_INVALID"); }
}

/** One task-bound fixed-price purchase. Only SDK.forTask may finance this service. */
export async function runFixedPriceTask(directory: string, config: FixedTaskConfig, options: FixedTaskOptions): Promise<FixedTaskSession> {
  validateSolveSpec(config.solve, false);
  const sample = publicSampleFor(config.solve.problemId);
  if (config.deadlineMs !== config.solve.deadlineMs || !/^[1-9][0-9]*$/.test(config.taskId) ||
    !/^[1-9][0-9]*$/.test(config.agentId) || !/^[1-9][0-9]*$/.test(config.chainId) || !/^[1-9][0-9]*$/.test(config.maxServicePrice)) throw new Error("INVALID_FIXED_TASK_CONFIG");
  for (const address of [config.account, config.asset, config.provider, config.escrowAddress]) getAddress(address);
  for (const url of [config.rpcUrl, config.relayUrl, config.underwriterUrl, config.arenaUrl]) {
    const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("INVALID_FIXED_TASK_URL");
  }
  const store = new SessionStore<FixedTaskSession>(directory); await store.start(options.recoverLock);
  if (options.provider && options.signer.provider !== options.provider) { await store.close(); throw new Error("SIGNER_PROVIDER_MISMATCH"); }
  const rpc = options.provider ?? new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 50 });
  const runner = options.runner ?? new DockerExecutor(); let state: FixedTaskSession | undefined;
  const save = async () => store.write(state!);
  const assertTime = () => { if (Date.now() >= config.deadlineMs) stop("SESSION_DEADLINE"); };
  try {
    const prior = await store.read();
    if (prior && (prior.version !== 1 || prior.binding !== hash(config) || !isDeepStrictEqual(prior.config, config))) throw new Error("SESSION_CONFIG_MISMATCH");
    state = prior ?? { version: 1, binding: hash(config), config: structuredClone(config), reservedPrice: "0", phase: "Purchasing" };
    if (state.reservedPrice !== (state.handle?.quote.price ?? "0") || BigInt(state.reservedPrice) > BigInt(config.maxServicePrice)) throw new Error("SESSION_BUDGET_INVALID");
    // Earlier versions treated an Arena 4xx as terminal even after payment. Resume that same delivery/payload, never purchase again.
    if (state.phase === "Stopped" && state.inference) { state.phase = state.submission ? "SubmissionPending" : "Paused"; await save(); }
    if (["Succeeded", "Failed", "Stopped", "Refunded"].includes(state.phase)) return structuredClone(state);
    await save();
    if (!state.inference) {
      if (!state.handle) assertTime();
      const infer = new InferCredit({ agentId: config.agentId, ...(options.provider ? {} : { rpcUrl: config.rpcUrl }), chainId: BigInt(config.chainId), account: config.account,
        asset: config.asset, provider: config.provider, signer: options.signer, underwriterUrl: config.underwriterUrl,
        maxPrice: BigInt(config.maxServicePrice), timeoutMs: options.timeoutMs ?? 10000,
        onHandle: async handle => {
          if (handle.input.taskId !== config.taskId || (state!.handle && state!.handle.quote.paymentId !== handle.quote.paymentId)) stop("SESSION_HANDLE_MISMATCH");
          state!.handle = structuredClone(handle); state!.reservedPrice = handle.quote.price; await save();
          await options.onHandle?.(structuredClone(handle));
        }, beforePayment: async handle => { assertTime(); if (!state!.handle) stop("HANDLE_NOT_PERSISTED"); await options.beforePayment?.(structuredClone(handle)); },
      });
      try {
        state.inference = state.handle ? await infer.resume(structuredClone(state.handle)) : await infer.forTask(config.taskId).fetch(config.relayUrl, {
          body: { service: "infercredit/solve-fixed", model: "pi-fixed-v1", messages: [{ role: "user", content: sample.prompt }], solve: JSON.parse(JSON.stringify(config.solve)) },
        });
        await save(); // Crash here restores the original paid delivery, never another purchase.
      } catch (error) {
        if (error instanceof PaymentError && error.code === "REFUNDED" && state.handle) {
          const account = new Contract(config.account, ACCOUNT_ABI, rpc);
          const payment = await account.getFunction("getPayment").staticCall(state.handle.quote.paymentId);
          const manager = new Contract(await account.getFunction("creditManager").staticCall(), MANAGER_ABI, rpc);
          const loan = await manager.getFunction("getLoan").staticCall(config.taskId);
          if (payment.agentId !== BigInt(config.agentId) || payment.fromCash + payment.fromCredit !== BigInt(state.handle.quote.price) ||
            payment.refundedAmount !== BigInt(state.handle.quote.price) || (payment.fromCredit > 0n && (payment.taskId !== BigInt(config.taskId) || ![2n, 3n, 4n].includes(loan.status) || loan.principal + loan.fee !== 0n))) stop("REFUND_UNCONFIRMED");
          const escrow = new Contract(config.escrowAddress, ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], rpc);
          const task = await escrow.getFunction("getTask").staticCall(config.taskId);
          state.refundConfirmation = { amount: payment.refundedAmount.toString(), loanStatus: loan.status.toString(), taskStatus: task.status.toString() };
          state.phase = "Refunded"; state.reason = "SERVICE_UNDELIVERED_REFUNDED"; await save(); return structuredClone(state);
        }
        throw error;
      } finally { infer.close(); }
    }
    const result = deliveredResult(state, config); await confirmPaidDelivery(state, config, rpc, options.signer);
    if (state.submission || state.phase === "ReadyToSubmit") {
      if (state.candidate !== result.code || !state.qualification?.passed || state.qualificationCodeHash !== result.codeHash ||
        (state.submission && (state.submission.payload.code !== result.code || state.submission.payload.taskId !== config.taskId))) stop("SESSION_CANDIDATE_MISMATCH");
      await submitProgrammingCandidate(state, config, { ...options, rpc, save }, config.solve.problemId); return structuredClone(state);
    }
    // The provider promises only a passing public sample. The agent verifies that condition independently.
    if (!state.qualification) {
      assertTime(); await runner.ready(); assertTime();
      state.qualification = await testPublicSample(runner, result.code, AbortSignal.timeout(Math.max(1, config.deadlineMs - Date.now())), config.solve.problemId); state.qualificationCodeHash = result.codeHash; await save();
    }
    if (!state.qualification.passed || state.qualificationCodeHash !== result.codeHash) stop("SERVICE_PUBLIC_SAMPLE_FAILED");
    state.candidate = result.code; state.phase = "ReadyToSubmit"; delete state.reason; await save();
    await submitProgrammingCandidate(state, config, { ...options, rpc, save }, config.solve.problemId);
    return structuredClone(state);
  } catch (error) {
    if (!state || !(error instanceof PaymentError)) throw error;
    state.reason = error.code;
    state.phase = error.code === "PAYMENT_REVERTED" ? "Stopped" : state.submission ? "SubmissionPending" : ["REFUND_IN_PROGRESS", "REFUND_UNCONFIRMED"].includes(error.code) ? "RefundPending" : state.handle ? "Paused" : "Stopped";
    await save(); return structuredClone(state);
  } finally { if (!options.provider) rpc.destroy(); await store.close(); }
}
