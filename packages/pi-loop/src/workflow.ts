import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { Contract, Interface, JsonRpcProvider, Transaction, Wallet, keccak256 } from "ethers";
import { ACCOUNT_ABI, MANAGER_ABI, PaymentError, canonical, requestDigest, sameAddress, uint, type Json, type PaymentHandle } from "@agentfuel/sdk";
import type { DockerExecutor } from "@agentfuel/arena/docker";
import { runRewardTask, type RewardTaskSession, type RewardTaskOptions } from "./reward-task.js";
import { SessionStore } from "./session.js";
import { selectInference, type SelectionCandidate, type SelectionConfig, type SelectionDecision, type SelectionProvider, type SelectionRoute } from "./selector.js";
import { validateSolveSpec, type SolveSpec } from "./provider.js";
import { runFixedPriceTask, type FixedTaskConfig, type FixedTaskSession } from "./fixed-task.js";

export type WorkflowSolvePlan = Omit<SolveSpec, "problemId" | "deadlineMs">;
export interface WorkflowRoute extends SelectionRoute { solve: WorkflowSolvePlan }
export interface WorkflowProvider extends Omit<SelectionProvider, "routes"> { routes: WorkflowRoute[] }
export interface WorkflowConfig extends Omit<SelectionConfig, "providers"> { providers: WorkflowProvider[]; funding?: "reward-tokens" | "inference-allowance" }
export interface WorkflowOptions {
  onProgress?: (status: WorkflowStatus) => Promise<void>;
  signer: Wallet; provider: JsonRpcProvider; rpcUrl: string; arenaUrl: string; underwriterUrl: string; walletLockDirectory: string;
  reward?: Pick<RewardTaskOptions, "solver" | "creditsUsed">;
  metered?: (config: FixedTaskConfig, onHandle: (handle: PaymentHandle) => Promise<void>) => Promise<Pick<RewardTaskOptions, "solver" | "creditsUsed"> & { close(): Promise<void> }> ;
  runner?: DockerExecutor; recoverLock?: boolean; timeoutMs?: number; pollTimeoutMs?: number;
}
export type WorkflowPhase = "Selected" | "AcceptPending" | "Running" | "Succeeded" | "Failed" | "Refunded" | "Stopped" | "Paused" | "SubmissionPending" | "RefundPending";
interface AcceptJournal { rawTransaction: string; txHash: string; from: string; nonce: number; confirmed: boolean; receipt?: unknown }
interface TaskObservation { taskId: string; status: string; agentId: string; deadlineMs: number; loanStatus: string }
export interface WorkflowSession {
  version: 1; binding: string; config: WorkflowConfig; signer: string; decision: SelectionDecision; observations: TaskObservation[];
  phase: WorkflowPhase; reason?: string; rewardChild?: RewardTaskSession; accept?: AcceptJournal; childConfig?: FixedTaskConfig; child?: FixedTaskSession; handle?: PaymentHandle; reservedPrice: string;
  chainTermination?: { blockNumber: number; blockHash: string; timestamp: number; paymentId: string; paymentTxHash: string };
  finance?: { taskStatus: string; loanStatus: string; principal: string; fee: string; fromCash?: string; fromCredit?: string; repaid?: string; slashed?: string; residual?: string };
}
interface WalletJournal { chainId: string; signer: string; account: string; directory: string; binding: string; phase: WorkflowPhase }
export interface WorkflowStatus {
  version: 1; phase: WorkflowPhase; reason?: string; deadlineMs: number; reservedPrice: string;
  choice?: Omit<Pick<SelectionCandidate, "taskId" | "problemId" | "providerId" | "tier" | "price" | "funding">, "funding"> & { funding: SelectionCandidate["funding"] | "reward-tokens" | "inference-allowance" };
  acceptTxHash?: string; acceptConfirmed?: boolean; paymentId?: string; paymentTxHash?:string; childPhase?: string;
  payment?: {paymentId:string;txHash:string;fromCash:string;fromCredit:string;price:string}; tools?: { rounds: number; attempts: number; passed: number }; finance?: WorkflowSession["finance"];
}
const terminal = (phase: string) => ["Succeeded", "Failed", "Refunded", "Stopped"].includes(phase);
const effectivePhase = (state: WorkflowSession): WorkflowPhase => state.phase === "Stopped" && (state.child?.inference || state.config.funding === "inference-allowance" && state.handle?.submission) ? (state.child?.submission || state.rewardChild?.submission) ? "SubmissionPending" : "Paused" : state.phase;
const digest = (value: unknown) => createHash("sha256").update(canonical(JSON.parse(JSON.stringify(value)) as Json)).digest("hex");
function stop(code: string): never { throw new PaymentError(code, code); }
const safeCode = (error: unknown) => { const code = error instanceof PaymentError ? error.code : (error as { message?: unknown })?.message; return typeof code === "string" && /^[A-Z_0-9]{1,80}$/.test(code) ? code : "WORKFLOW_UNCERTAIN"; };
const escrowAbi = ["function acceptTask(uint256,uint256)", "function adapter() view returns(address)",
  "function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))",
  "event TaskAccepted(uint256 indexed taskId,uint256 indexed agentId,address wallet)",
  "event TaskSettled(uint256 indexed taskId,bool passed,uint256 repaid,uint256 slashed,uint256 agentResidual)"];
const escrowInterface = new Interface(escrowAbi);
function selectionConfig(config: WorkflowConfig): SelectionConfig {
  const { funding: _funding, ...selection } = config;
  return { ...selection, providers: config.providers.map(provider => ({ ...provider, routes: provider.routes.map(({ solve: _solve, ...route }) => route) })) };
}
function decide(config: WorkflowConfig, snapshot: SelectionDecision["snapshot"]): SelectionDecision {
  const decision = selectInference(selectionConfig(config), snapshot);
  if (config.funding) {
    // Cash quotes still describe the alternative service. Reward tasks never purchase that service.
    for (const candidate of decision.candidates) candidate.rejected = candidate.rejected.filter(reason => reason !== "FUNDS" && reason !== "PRICE_LIMIT");
    decision.selected = decision.candidates.find(candidate => !candidate.rejected.length);
  }
  return decision;
}
export function validateWorkflowConfig(value: unknown): WorkflowConfig {
  const config = structuredClone(value) as WorkflowConfig;
  if (!config || config.funding !== undefined && config.funding !== "reward-tokens" && config.funding !== "inference-allowance" || !Array.isArray(config.providers)) stop("INVALID_WORKFLOW_CONFIG");
  for (const provider of config.providers) {
    if (provider.service !== "infercredit/solve-fixed" || provider.model !== "pi-fixed-v1" || !Array.isArray(provider.routes)) stop("INVALID_WORKFLOW_PROVIDER");
    for (const route of provider.routes) {
      const spec = validateSolveSpec({ ...route.solve, problemId: "sum-integers", deadlineMs: config.deadlineMs }, false);
      if (Object.keys(route.solve).sort().join(",") !== "maxCompletionTokens,maxRounds,maxToolCalls,tiers,version" ||
        spec.tiers[0] !== route.tier || spec.maxCompletionTokens > config.maxCompletionTokens || (route.tier === "strong" && spec.tiers.some(tier => tier !== "strong"))) stop("INVALID_WORKFLOW_SOLVE_PLAN");
    }
  }
  const selection = selectionConfig(config);
  selectInference(selection, { atMs: 0, cash: "0", creditEnabled: false, tasks: config.tasks.map(task => ({ ...task, assigned: false })) });
  return config;
}
function project(state: WorkflowSession): WorkflowStatus {
  const selected = state.decision.selected, run = state.rewardChild?.solve ?? (state.child?.inference?.result as unknown as { run?: { rounds?: unknown[]; tools?: { result?: { passed?: boolean } }[] } })?.run;
  const choice = selected ? { taskId: selected.taskId, problemId: selected.problemId, providerId: selected.providerId, tier: selected.tier, price: state.config.funding === "reward-tokens" ? "0" : state.config.funding === "inference-allowance" ? state.reservedPrice : selected.price, funding: state.config.funding ?? selected.funding } : undefined;
  return { version: 1, phase: effectivePhase(state), ...(state.reason ? { reason: safeCode(new Error(state.reason)) } : {}), deadlineMs: state.config.deadlineMs, reservedPrice: state.reservedPrice,
    ...(choice ? { choice } : {}), ...(state.accept ? { acceptTxHash: state.accept.txHash, acceptConfirmed: state.accept.confirmed } : {}), ...(state.handle ? { paymentId: state.handle.quote.paymentId,...(state.handle.submission?{paymentTxHash:state.handle.submission.txHash}:{}) } : {}),
    ...(state.child ? { childPhase: state.child.phase } : {}), ...(run ? { tools: { rounds: run.rounds?.length ?? 0, attempts: run.tools?.length ?? 0, passed: run.tools?.filter(tool => tool.result?.passed).length ?? 0 } } : {}),
    ...(state.finance ? { finance: structuredClone(state.finance) } : {}) };
}
function validateState(state: WorkflowSession) {
  const config = validateWorkflowConfig(state.config);
  if (state.version !== 1 || state.binding !== digest(config) || digest(state.decision) !== digest(decide(config, state.decision.snapshot)) ||
    !["Selected", "AcceptPending", "Running", "Succeeded", "Failed", "Refunded", "Stopped", "Paused", "SubmissionPending", "RefundPending"].includes(state.phase)) stop("WORKFLOW_STATE_INVALID");
  uint(state.reservedPrice, "reservedPrice");
  if (config.funding ? state.child || (config.funding === "reward-tokens" && (state.handle || state.reservedPrice !== "0")) : state.rewardChild) stop("WORKFLOW_STATE_INVALID");
  if (state.accept && !/^0x[a-f0-9]{64}$/.test(state.accept.txHash) || state.handle && !/^0x[a-f0-9]{64}$/.test(state.handle.quote.paymentId)) stop("WORKFLOW_STATE_INVALID");
  if (state.child && !["Purchasing", "ReadyToSubmit", "Succeeded", "Failed", "Refunded", "Stopped", "Paused", "SubmissionPending", "RefundPending"].includes(state.child.phase)) stop("WORKFLOW_STATE_INVALID");
  if (state.finance) for (const [key, value] of Object.entries(state.finance)) {
    if (!["taskStatus", "loanStatus", "principal", "fee", "fromCash", "fromCredit", "repaid", "slashed", "residual"].includes(key)) stop("WORKFLOW_STATE_INVALID");
    uint(value, key);
  }
}
export async function readWorkflowStatus(directory: string): Promise<WorkflowStatus | undefined> {
  try { const state = JSON.parse(await readFile(join(resolve(directory), "session.json"), "utf8")) as WorkflowSession; validateState(state); return project(state); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; stop("WORKFLOW_STATE_INVALID"); }
}

/** One wallet writer and task, funded by one fixed-price purchase or a reward allowance, with independent Arena submission. */
export async function runTaskWorkflow(directory: string, input: WorkflowConfig, options: WorkflowOptions): Promise<WorkflowStatus> {
  const config = validateWorkflowConfig(input), binding = digest(config);
  if ((config.funding === "reward-tokens") !== !!options.reward || (config.funding === "inference-allowance") !== !!options.metered) stop("WORKFLOW_REWARD_RUNTIME_REQUIRED");
  directory = resolve(directory);
  if (!(options.signer instanceof Wallet) || options.signer.provider !== options.provider || !(options.provider instanceof JsonRpcProvider)) stop("SIGNER_PROVIDER_MISMATCH");
  if (resolve(options.walletLockDirectory) === directory || resolve(options.walletLockDirectory) === join(directory, "fixed-task")) stop("WORKFLOW_LOCK_PATH_CONFLICT");
  for (const url of [options.rpcUrl, options.arenaUrl, options.underwriterUrl]) { const parsed = new URL(url); if (!["http:", "https:"].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) stop("INVALID_WORKFLOW_RUNTIME_URL"); }
  const rpc = options.provider, signer = await options.signer.getAddress();
  const walletStore = new SessionStore<WalletJournal>(options.walletLockDirectory), store = new SessionStore<WorkflowSession>(directory);
  await walletStore.start(options.recoverLock);
  let state: WorkflowSession | undefined, storeHeld = false;
  const save = async () => { await store.write(state!); await walletStore.write({ chainId: config.chainId, signer, account: config.account, directory, binding, phase: state!.phase }); await options.onProgress?.(project(state!)); };
  const account = new Contract(config.account, ACCOUNT_ABI, rpc), escrow = new Contract(config.escrowAddress, escrowAbi, rpc);
  const chain = async () => { if (BigInt(await rpc.send("eth_chainId", [])) !== BigInt(config.chainId)) stop("NETWORK_MISMATCH"); };
  const time = (deadline = config.deadlineMs) => { if (Date.now() + config.minRemainingMs >= deadline) stop("WORKFLOW_DEADLINE"); };
  const observe = async (taskId: string): Promise<TaskObservation> => {
    const manager = new Contract(await account.getFunction("creditManager").staticCall(), MANAGER_ABI, rpc);
    const [task, loan] = await Promise.all([escrow.getFunction("getTask").staticCall(taskId), manager.getFunction("getLoan").staticCall(taskId)]);
    return { taskId, status: String(task.status), agentId: String(task.agentId), deadlineMs: Number(task.deadline) * 1000, loanStatus: String(loan.status) };
  };
  try {
    const active = await walletStore.read();
    if (active?.phase === "Stopped") {
      const current = await readWorkflowStatus(active.directory);
      if (!current) stop("WORKFLOW_RECOVERY_REQUIRED");
      active.phase = current.phase; // Old paid Arena rejections cannot release this wallet through stale terminal metadata.
    }
    if (active && (!sameAddress(active.signer, signer) || !terminal(active.phase) && (active.chainId !== config.chainId || !sameAddress(active.account, config.account)))) stop("WORKFLOW_WALLET_BINDING_CHANGED");
    if (active && !terminal(active.phase) && (active.directory !== directory || active.binding !== binding)) stop("WORKFLOW_RECOVERY_REQUIRED");
    await store.start(options.recoverLock); storeHeld = true;
    const prior = await store.read();
    if (prior && (prior.version !== 1 || prior.binding !== binding || digest(prior.config) !== binding || !sameAddress(prior.signer, signer) ||
      digest(prior.decision) !== digest(decide(config, prior.decision.snapshot)))) stop("WORKFLOW_CONFIG_CHANGED");
    if (prior) validateState(prior);
    state = prior;
    if (state && effectivePhase(state) !== state.phase) { state.phase = effectivePhase(state); await save(); }
    if (state && terminal(state.phase)) { await save(); return project(state); }
    await chain();
    if (!state) {
      const [cash, observations] = await Promise.all([account.getFunction("cash").staticCall(config.agentId), Promise.all(config.tasks.map(task => observe(task.taskId)))]);
      const decision = decide(config, { atMs: Date.now(), cash: String(cash), creditEnabled: Boolean(options.underwriterUrl), tasks: config.tasks.map(task => {
        const current = observations.find(value => value.taskId === task.taskId)!;
        return { ...task, assigned: (current.status === "1" || current.status === "2" && current.agentId === config.agentId) && current.deadlineMs === task.deadlineMs && current.loanStatus === "0" };
      }) });
      state = { version: 1, binding, config, signer, decision, observations, phase: decision.selected ? "Selected" : "Stopped", reservedPrice: "0", ...(!decision.selected ? { reason: "NO_FEASIBLE_CANDIDATE" } : {}) };
      await save();
    }
    const selected = state.decision.selected; if (!selected) return project(state);
    const offered = config.providers.find(provider => provider.id === selected.providerId)!, route = offered.routes.find(route => route.tier === selected.tier)!;
    const deadline = Math.min(config.deadlineMs, selected.deadlineMs);
    if (prior && options.recoverLock && state.handle) {
      const paidPrice = config.funding === "inference-allowance" ? state.handle.quote.price : selected.price;
      const paidProvider = config.funding === "inference-allowance" ? state.handle.quote.payTo : offered.payTo;
      // Recovery can observe an external expiry/liquidation, but never sends that transaction itself.
      const block = await rpc.getBlock("latest"); if (!block?.hash) stop("WORKFLOW_TERMINATION_UNCONFIRMED");
      const at = { blockTag: block.number }, manager = new Contract(await account.getFunction("creditManager").staticCall(at), MANAGER_ABI, rpc);
      const [task, loan, payment] = await Promise.all([escrow.getFunction("getTask").staticCall(selected.taskId, at), manager.getFunction("getLoan").staticCall(selected.taskId, at), account.getFunction("getPayment").staticCall(state.handle.quote.paymentId, at)]);
      if (task.status === 4n && [0n, 2n, 3n, 4n].includes(loan.status) && loan.principal + loan.fee === 0n && payment.fromCash + payment.fromCredit > 0n && (payment.refundedAmount !== BigInt(paidPrice) || loan.status === 4n)) {
        const handle = state.handle, hash = handle.submission?.txHash, raw = handle.submission?.rawTransaction;
        const receipt = hash ? await rpc.getTransactionReceipt(hash) : null, paidBlock = receipt ? await rpc.getBlock(receipt.blockNumber) : null;
        const event = receipt?.logs.filter(log => sameAddress(log.address, config.account)).map(log => { try { return account.interface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "ProviderPaid" && event.args.paymentId === handle.quote.paymentId);
        const canonicalBlock = await rpc.getBlock(block.number);
        if (!hash || !raw || keccak256(raw) !== hash || receipt?.status !== 1 || receipt.hash !== hash || !sameAddress(receipt.from, signer) || !receipt.to || !sameAddress(receipt.to, config.account) || receipt.blockNumber > block.number || paidBlock?.hash !== receipt.blockHash || canonicalBlock?.hash !== block.hash ||
          task.agentId !== BigInt(config.agentId) || task.deadline * 1000n !== BigInt(selected.deadlineMs) || (loan.status !== 0n && loan.agentId !== BigInt(config.agentId)) || payment.agentId !== BigInt(config.agentId) || payment.fromCash + payment.fromCredit !== BigInt(paidPrice) || (payment.fromCredit > 0n && (payment.taskId !== BigInt(selected.taskId) || payment.fromCredit > BigInt(selected.creditLimit))) ||
          handle.quote.price !== paidPrice || handle.quote.taskId !== selected.taskId || handle.quote.agentId !== config.agentId || handle.quote.chainId !== config.chainId || !sameAddress(handle.quote.account, config.account) || !sameAddress(handle.quote.asset, config.asset) || !sameAddress(handle.quote.payTo, paidProvider) || handle.quote.requestDigest !== requestDigest(handle.input) ||
          event?.length !== 1 || event[0]!.args.agentId !== BigInt(config.agentId) || !sameAddress(event[0]!.args.provider, paidProvider) || event[0]!.args.fromCash !== payment.fromCash || event[0]!.args.fromCredit !== payment.fromCredit) stop("WORKFLOW_TERMINATION_UNCONFIRMED");
        state.chainTermination = { blockNumber: block.number, blockHash: block.hash, timestamp: block.timestamp, paymentId: handle.quote.paymentId, paymentTxHash: hash };
        state.phase = "Failed"; state.reason = payment.refundedAmount === BigInt(paidPrice) ? "WORKFLOW_REFUNDED_TASK_TERMINATED" : "WORKFLOW_CHAIN_TERMINATED";
        state.finance = { taskStatus: "4", loanStatus: String(loan.status), principal: "0", fee: "0", fromCash: String(payment.fromCash), fromCredit: String(payment.fromCredit) };
        await save(); return project(state);
      }
    }
    const funding = async () => {
      time(deadline); if (config.funding) return; const cash = await account.getFunction("cash").staticCall(config.agentId);
      if (BigInt(selected.price) > cash + (selected.funding === "task-credit" && config.allowCredit ? BigInt(selected.creditLimit) : 0n)) stop("WORKFLOW_FUNDS_CHANGED");
    };
    const assigned = async (allowOpen = false) => {
      await chain(); time(deadline); const task = await observe(selected.taskId);
      if (task.deadlineMs !== selected.deadlineMs || !(task.status === "2" && task.agentId === config.agentId || allowOpen && task.status === "1")) stop("WORKFLOW_TASK_CHANGED");
      await funding(); return task;
    };
    if (!state.childConfig) {
      const task = await observe(selected.taskId);
      if (state.accept || task.status === "1") {
        if (!state.accept) {
          await assigned(true);
          const populated = await options.signer.populateTransaction({ to: config.escrowAddress, chainId: BigInt(config.chainId), value: 0n, data: escrowInterface.encodeFunctionData("acceptTask", [selected.taskId, config.agentId]) });
          await assigned(true); const rawTransaction = await options.signer.signTransaction(populated);
          state.accept = { rawTransaction, txHash: keccak256(rawTransaction), from: signer, nonce: Number(populated.nonce), confirmed: false };
          state.phase = "AcceptPending"; await save(); // The exact original bytes are durable before broadcasting.
        }
        const accept = state.accept, signed = Transaction.from(accept.rawTransaction);
        const call = escrowInterface.parseTransaction({ data: signed.data, value: signed.value });
        if (signed.hash !== accept.txHash || !sameAddress(signed.from!, signer) || !sameAddress(signed.to!, config.escrowAddress) || signed.chainId !== BigInt(config.chainId) || signed.nonce !== accept.nonce || !call || call.name !== "acceptTask" || call.args[0] !== BigInt(selected.taskId) || call.args[1] !== BigInt(config.agentId)) stop("WORKFLOW_ACCEPT_BINDING_CHANGED");
        let receipt = await rpc.getTransactionReceipt(accept.txHash);
        if (!receipt) {
          time(deadline);
          if (await rpc.getTransaction(accept.txHash)) stop("WORKFLOW_ACCEPT_PENDING");
          if (await rpc.getTransactionCount(signer, "latest") > accept.nonce) stop("WORKFLOW_ACCEPT_UNCERTAIN");
          await assigned(true);
          try { const sent = await rpc.broadcastTransaction(accept.rawTransaction); receipt = await sent.wait(1, options.timeoutMs ?? 10000); }
          catch { stop("WORKFLOW_ACCEPT_UNCERTAIN"); }
        }
        if (!receipt) stop("WORKFLOW_ACCEPT_UNCERTAIN");
        const block = await rpc.getBlock(receipt.blockNumber);
        if (!block || block.hash !== receipt.blockHash || receipt.hash !== accept.txHash || !sameAddress(receipt.from, signer) || !receipt.to || !sameAddress(receipt.to, config.escrowAddress)) stop("WORKFLOW_ACCEPT_UNCERTAIN");
        accept.receipt = receipt.toJSON();
        if (receipt.status === 0) { state.phase = "Stopped"; state.reason = "WORKFLOW_ACCEPT_REVERTED"; await save(); return project(state); }
        const events = receipt.logs.filter(log => sameAddress(log.address, config.escrowAddress)).map(log => { try { return escrowInterface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "TaskAccepted" && event.args.taskId === BigInt(selected.taskId) && event.args.agentId === BigInt(config.agentId) && sameAddress(event.args.wallet, signer));
        if (receipt.status !== 1 || events.length !== 1) stop("WORKFLOW_ACCEPT_UNCERTAIN");
        accept.confirmed = true; await save();
      }
      await assigned();
      state.childConfig = { taskId: selected.taskId, agentId: config.agentId, chainId: config.chainId, account: config.account, asset: config.asset, escrowAddress: config.escrowAddress,
        rpcUrl: options.rpcUrl, arenaUrl: options.arenaUrl, underwriterUrl: options.underwriterUrl, provider: offered.payTo, relayUrl: offered.relayUrl,
        maxServicePrice: selected.price, deadlineMs: deadline, solve: { ...structuredClone(route.solve), problemId: selected.problemId, deadlineMs: deadline } };
      state.phase = "Running"; delete state.reason; await save();
    }
    const expected = { taskId: selected.taskId, agentId: config.agentId, chainId: config.chainId, account: config.account, asset: config.asset, escrowAddress: config.escrowAddress,
      rpcUrl: options.rpcUrl, arenaUrl: options.arenaUrl, underwriterUrl: options.underwriterUrl, provider: offered.payTo, relayUrl: offered.relayUrl,
      maxServicePrice: selected.price, deadlineMs: deadline, solve: { ...structuredClone(route.solve), problemId: selected.problemId, deadlineMs: deadline } };
    if (digest(state.childConfig) !== digest(expected)) stop("WORKFLOW_RUNTIME_CHANGED");
    if (config.funding) {
      const childConfig = state.childConfig;
      const metered = config.funding === "inference-allowance" ? await options.metered!(childConfig, async handle => {
        if (state!.handle && state!.handle.quote.paymentId !== handle.quote.paymentId) stop("WORKFLOW_QUOTE_CHANGED");
        state!.handle = structuredClone(handle); state!.reservedPrice = handle.quote.price; await save();
      }) : undefined;
      try { state.rewardChild = await runRewardTask(join(directory, "reward-task"), {
        taskId: childConfig.taskId, agentId: childConfig.agentId, chainId: childConfig.chainId,
        escrowAddress: childConfig.escrowAddress, rpcUrl: childConfig.rpcUrl, arenaUrl: childConfig.arenaUrl,
        deadlineMs: childConfig.deadlineMs, solve: childConfig.solve,
      }, { ...options, ...(metered ?? options.reward!), onProgress:async progress=>{await options.onProgress?.({...project(state!),childPhase:progress.phase,...(progress.reason?{reason:safeCode(new Error(progress.reason))}:{})});}, submitFailedCandidate: config.funding === "inference-allowance" });
      } finally { await metered?.close(); }
      state.phase = state.rewardChild.phase as WorkflowPhase; state.reason = state.rewardChild.reason;
      state.phase = effectivePhase(state);
      if (!metered) state.reservedPrice = "0";
    } else {
    const checkHandle = (handle: PaymentHandle) => {
      if (handle.quote.price !== selected.price || handle.quote.tier !== undefined || handle.quote.taskId !== selected.taskId || handle.input.taskId !== selected.taskId ||
        handle.relayUrl !== offered.relayUrl || handle.input.service !== "infercredit/solve-fixed" || handle.input.model !== "pi-fixed-v1" || handle.input.tier !== undefined || digest(handle.input.solve) !== digest(state!.childConfig!.solve) || handle.quote.requestDigest !== requestDigest(handle.input) ||
        (state!.handle && (state!.handle.quote.paymentId !== handle.quote.paymentId || state!.handle.creditNonce !== handle.creditNonce))) stop("WORKFLOW_QUOTE_CHANGED");
    };
    state.child = await runFixedPriceTask(join(directory, "fixed-task"), state.childConfig, { ...options,
      onProgress:async progress=>{await options.onProgress?.({...project(state!),childPhase:progress.phase,...(progress.reason?{reason:safeCode(new Error(progress.reason))}:{})});},
      onPayment:async payment=>{await options.onProgress?.({...project(state!),payment});},
      onHandle: async handle => { checkHandle(handle); state!.handle = handle; state!.reservedPrice = handle.quote.price; await save(); },
      beforePayment: async handle => { checkHandle(handle); if (!state!.handle) { state!.handle = structuredClone(handle); state!.reservedPrice = handle.quote.price; await save(); } await assigned(); },
    });
    state.handle = state.child.handle ?? state.handle; state.reservedPrice = state.child.reservedPrice;
    state.phase = ["Succeeded", "Failed", "Refunded", "Stopped", "SubmissionPending", "RefundPending"].includes(state.child.phase) ? state.child.phase as WorkflowPhase : "Paused";
    state.phase = effectivePhase(state);
    state.reason = state.child.reason;
    if (["WORKFLOW_QUOTE_CHANGED", "WORKFLOW_FUNDS_CHANGED", "WORKFLOW_TASK_CHANGED", "WORKFLOW_DEADLINE", "SESSION_DEADLINE"].includes(state.reason ?? "") && state.handle && !state.handle.submission) {
      const payment = await account.getFunction("getPayment").staticCall(state.handle.quote.paymentId);
      if (payment.fromCash + payment.fromCredit === 0n) state.phase = "Stopped"; // A rejected unsigned quote is a known non-payment, not an uncertain dispatch.
    }
    }
    if (state.phase === "Succeeded" || state.phase === "Failed") {
      const manager = new Contract(await account.getFunction("creditManager").staticCall(), MANAGER_ABI, rpc);
      const [task, loan] = await Promise.all([escrow.getFunction("getTask").staticCall(selected.taskId), manager.getFunction("getLoan").staticCall(selected.taskId)]);
      const result = (state.rewardChild ?? state.child)!.submission?.result as unknown as { settlement?: { txHash?: string } }, hash = result?.settlement?.txHash;
      const receipt = hash ? await rpc.getTransactionReceipt(hash) : null, block = receipt ? await rpc.getBlock(receipt.blockNumber) : null;
      const event = receipt?.logs.filter(log => sameAddress(log.address, config.escrowAddress)).map(log => { try { return escrowInterface.parseLog(log); } catch { return null; } }).find(event => event?.name === "TaskSettled" && event.args.taskId === BigInt(selected.taskId) && event.args.passed === (state!.phase === "Succeeded"));
      if (receipt?.status !== 1 || !block || block.hash !== receipt.blockHash || !event || task.status !== (state.phase === "Succeeded" ? 3n : 4n) || ![0n, 2n, 3n, 4n].includes(loan.status) || loan.principal + loan.fee !== 0n) stop("WORKFLOW_SETTLEMENT_UNCONFIRMED");
      state.finance = { taskStatus: String(task.status), loanStatus: String(loan.status), principal: String(loan.principal), fee: String(loan.fee),
        fromCash: state.child?.inference?.receipt.fromCash ?? (state.handle ? String((await account.getFunction("getPayment").staticCall(state.handle.quote.paymentId)).fromCash) : "0"), fromCredit: state.child?.inference?.receipt.fromCredit ?? (state.handle ? String((await account.getFunction("getPayment").staticCall(state.handle.quote.paymentId)).fromCredit) : "0"), repaid: String(event.args.repaid), slashed: String(event.args.slashed), residual: String(event.args.agentResidual) };
    }
    if (config.funding === "inference-allowance" && state.reason === "REFUNDED" && state.handle) {
      const payment = await account.getFunction("getPayment").staticCall(state.handle.quote.paymentId);
      const manager = new Contract(await account.getFunction("creditManager").staticCall(), MANAGER_ABI, rpc);
      const [loan, task] = await Promise.all([manager.getFunction("getLoan").staticCall(selected.taskId), escrow.getFunction("getTask").staticCall(selected.taskId)]);
      if (payment.agentId !== BigInt(config.agentId) || payment.refundedAmount !== BigInt(state.handle.quote.price)
        || payment.fromCash + payment.fromCredit !== payment.refundedAmount || loan.principal + loan.fee !== 0n || ![0n, 2n, 3n, 4n].includes(loan.status)) stop("REFUND_UNCONFIRMED");
      state.phase = "Refunded"; state.finance = { taskStatus: String(task.status), loanStatus: String(loan.status), principal: "0", fee: "0" };
    }
    if (state.phase === "Refunded" && !config.funding) state.finance = { taskStatus: state.child!.refundConfirmation!.taskStatus, loanStatus: state.child!.refundConfirmation!.loanStatus, principal: "0", fee: "0" };
    await save(); return project(state);
  } catch (error) {
    if (!state) throw error;
    state.reason = safeCode(error);
    state.phase = state.reason === "WORKFLOW_DEADLINE" && !state.handle && (!state.accept || state.accept.confirmed) || state.reason === "WORKFLOW_QUOTE_CHANGED" && !state.handle ? "Stopped" : "Paused";
    await save(); return project(state);
  } finally { try { if (storeHeld) await store.close(); } finally { await walletStore.close(); } }
}
