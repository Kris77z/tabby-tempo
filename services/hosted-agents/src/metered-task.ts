import type {HostedActivityInput} from "./scene-types.js";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { join } from "node:path";
import { Contract, type JsonRpcProvider, type Wallet } from "ethers";
import { ACCOUNT_ABI, InferCredit, PaymentError, canonical, type Inference, type Json, type PaymentHandle } from "@agentfuel/sdk";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { confirmPaidDelivery, type FixedTaskConfig } from "@agentfuel/pi-loop/fixed-task";
import { InferenceFundingRequired, type JsonObject } from "@agentfuel/pi-loop/provider";
import type { WorkflowOptions } from "@agentfuel/pi-loop/workflow";
import { InferenceGateway, createMagpieDispatch, type GatewayModel, type GatewayDispatch } from "./inference-gateway.js";
import { prepareRewardChat } from "../../arena/src/inference-rewards/index.js";
import { allowanceBody } from "../../provider-relay/src/allowance.js";

export interface MeteredTaskConfig {
  relayUrl: string; payTo: string; priceRaw: string; creditsRaw: string;
  catalog: [GatewayModel, GatewayModel]; keyFile: string;
}
export const modelCatalogDigest = (catalog: GatewayModel[]) => `0x${createHash("sha256").update(canonical(catalog as unknown as Json)).digest("hex")}`;
/** Recompute the remaining task deadline at dispatch, including after a slow earlier round. */
export function createTaskMagpieDispatch(config: { baseUrl: string; apiKey: string; deadlineMs: number; timeoutMs?: number }): GatewayDispatch {
  const configuredTimeout = config.timeoutMs ?? 30000;
  if (!Number.isSafeInteger(configuredTimeout) || configuredTimeout < 1 || configuredTimeout > 2147483647
    || !Number.isSafeInteger(config.deadlineMs)) throw new Error("INVALID_METERED_TIMEOUT");
  return async (model, request) => {
    const remaining = config.deadlineMs - Date.now();
    if (remaining <= 0) throw new PaymentError("SESSION_DEADLINE", "Task expired before model dispatch");
    return createMagpieDispatch({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: Math.min(configuredTimeout, remaining) })(model, request);
  };
}
/** One SDK purchase attempt shares the configured timeout ceiling and original task deadline. */
export function meteredPurchaseTimeout(deadlineMs: number, timeoutMs = 10000): number {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647 || !Number.isSafeInteger(deadlineMs)) throw new Error("INVALID_METERED_TIMEOUT");
  const remaining = deadlineMs - Date.now();
  if (remaining <= 0) throw new PaymentError("SESSION_DEADLINE", "Task expired before allowance request");
  return Math.min(timeoutMs, remaining);
}
interface Purchase { version: 1; config: MeteredTaskConfig; task: FixedTaskConfig; handle?: PaymentHandle; inference?: Inference }
/** Trusted hosted custody boundary: grants are issued only after direct, canonical Account payment verification. */
export async function openMeteredTask(directory: string, config: MeteredTaskConfig, task: FixedTaskConfig,
  options: { signer: Wallet; provider: JsonRpcProvider; allowCredit: boolean; maxPrice: string; key: string; recover?: boolean; timeoutMs?: number;
    activity?: (event:HostedActivityInput)=>Promise<void>;
    reward?: NonNullable<WorkflowOptions["reward"]>;
    onHandle(handle: PaymentHandle): Promise<void>; dispatch?: Parameters<typeof InferenceGateway.open>[3] }) {
  if (BigInt(config.priceRaw) > BigInt(options.maxPrice)) throw new PaymentError("ALLOWANCE_PRICE_LIMIT", "Allowance exceeds budget");
  const store = new SessionStore<Purchase>(join(directory, "allowance-purchase")); await store.start(options.recover);
  let gateway: InferenceGateway | undefined;
  try {
    let state = await store.read();
    if (state && (!isDeepStrictEqual(state.config, config) || !isDeepStrictEqual(state.task, task))) throw new Error("ALLOWANCE_CONFIG_CHANGED");
    state ??= { version: 1, config: structuredClone(config), task: structuredClone(task) }; await store.write(state);
    const entry = config.catalog[0], baseUrl = entry.route.replace(/\/chat\/completions\/?$/, "");
    gateway = await InferenceGateway.open(join(directory, "inference-ledger"), { agentId: task.agentId, taskId: task.taskId, wallet: options.signer.address }, config.catalog,
      options.dispatch ?? createTaskMagpieDispatch({ baseUrl, apiKey: options.key, deadlineMs: task.deadlineMs, timeoutMs: options.timeoutMs }), options.recover);
    const ledger = gateway, snapshot = state;
    const checkHandle = (handle: PaymentHandle) => {
      if (handle.quote.price !== config.priceRaw || handle.quote.taskId !== task.taskId || handle.input.service !== "infercredit/allowance"
        || handle.relayUrl !== config.relayUrl || !isDeepStrictEqual(handle.input.allowance, { creditsRaw: config.creditsRaw, modelCatalogDigest: modelCatalogDigest(config.catalog) })
        || snapshot.handle && snapshot.handle.quote.paymentId !== handle.quote.paymentId) throw new PaymentError("ALLOWANCE_QUOTE_CHANGED", "Allowance quote changed");
    };
    const assigned = async () => {
      const escrow = new Contract(task.escrowAddress, ["function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))"], options.provider);
      const account = new Contract(task.account, ACCOUNT_ABI, options.provider);
      const adapter = new Contract(await account.getFunction("adapter").staticCall(), ["function identityChanged(uint256) view returns(bool)", "function resolveAgent(uint256) view returns(address owner,address wallet)"], options.provider);
      const [current, identity, changed, block] = await Promise.all([escrow.getFunction("getTask").staticCall(task.taskId), adapter.getFunction("resolveAgent").staticCall(task.agentId), adapter.getFunction("identityChanged").staticCall(task.agentId), options.provider.getBlock("latest")]);
      if (current.status !== 2n || current.agentId !== BigInt(task.agentId) || changed || identity.wallet.toLowerCase() !== options.signer.address.toLowerCase()
        || !block || block.timestamp * 1000 >= task.deadlineMs || Date.now() >= task.deadlineMs) throw new InferenceFundingRequired("ALLOWANCE_TASK_UNAVAILABLE");
    };
    const purchase = async () => {
      await options.activity?.({scene:"funding",state:"started",evidence:{taskId:task.taskId,priceRaw:config.priceRaw}});
      if (!snapshot.inference) {
        const infer = new InferCredit({ agentId: task.agentId, signer: options.signer, chainId: BigInt(task.chainId), account: task.account, asset: task.asset,
          provider: config.payTo, ...(options.allowCredit ? { underwriterUrl: task.underwriterUrl } : {}), maxPrice: BigInt(config.priceRaw), timeoutMs: meteredPurchaseTimeout(task.deadlineMs, options.timeoutMs),
          onHandle: async handle => { checkHandle(handle); snapshot.handle = structuredClone(handle); await store.write(snapshot); await options.onHandle(handle); },
          beforePayment: async handle => { checkHandle(handle); await assigned();await options.activity?.({scene:"funding",state:"waiting",evidence:{taskId:task.taskId,paymentId:handle.quote.paymentId,priceRaw:config.priceRaw}}); if (Date.now() >= task.deadlineMs) throw new PaymentError("SESSION_DEADLINE", "Task expired"); },
        });
        try { snapshot.inference = snapshot.handle ? await infer.resume(structuredClone(snapshot.handle)) : await infer.forTask(task.taskId).fetch(config.relayUrl, {
          body: allowanceBody({ creditsRaw: config.creditsRaw, modelCatalogDigest: modelCatalogDigest(config.catalog) }),
        }); await store.write(snapshot); } finally { infer.close(); }
      }
      const result = snapshot.inference.result as any, receipt = snapshot.inference.receipt;
      if (result?.kind !== "inference-allowance" || result.paymentId !== snapshot.handle!.quote.paymentId || result.agentId !== task.agentId || result.taskId !== task.taskId
        || result.creditsRaw !== config.creditsRaw || result.modelCatalogDigest !== modelCatalogDigest(config.catalog)
        || receipt.paymentId !== result.paymentId || receipt.price !== config.priceRaw || receipt.requestDigest !== snapshot.handle!.quote.requestDigest)
        throw new PaymentError("ALLOWANCE_RECEIPT_INVALID", "Invalid allowance receipt");
      await confirmPaidDelivery(snapshot, { ...task, provider: config.payTo }, options.provider, options.signer);
      await ledger.grant(result.paymentId, config.creditsRaw, { kind: "chain-payment", paymentId: result.paymentId, txHash: receipt.txHash });
      await options.activity?.({scene:BigInt(receipt.fromCredit)>0n?"credit":"funding",state:"confirmed",evidence:{taskId:task.taskId,paymentId:receipt.paymentId,txHash:receipt.txHash,fromCashRaw:receipt.fromCash,fromCreditRaw:receipt.fromCredit,chargedRaw:receipt.price}});
      await options.onHandle(snapshot.handle!);
    };
    if (snapshot.inference) await purchase();
    let round = 0, useReward = false;
    const routes = Object.fromEntries((["cheap", "strong"] as const).map((tier, i) => [tier, { name: tier, model: config.catalog[i].id, baseUrl }])) as NonNullable<WorkflowOptions["reward"]>["solver"]["routes"];
    return { solver: { routes, beforeDispatch: async (body: JsonObject, index: number) => {
      round = index; useReward = false;
      if (ledger.readResult(`round:${index}`, body)) return;
      await assigned();
      if (ledger.balance().frozen) throw new InferenceFundingRequired("GATEWAY_OUTCOME_UNKNOWN");
      const model = config.catalog.find(model => model.id === body.model)!;
      if (options.reward && (model.responseModel ?? model.model) === "kimi-k2.6") {
        // Reward grants have a smaller request policy than the paid gateway. An ineligible
        // request must retain its original model budget and continue to paid admission.
        const rewardBody = { ...body, model: "kimi-k2.6" };
        let eligible = true;
        try { prepareRewardChat({ redemptionId: `round:${index}`, request: rewardBody }); }
        catch (error) {
          if (error instanceof Error && error.message === "REWARD_INVALID_TASK_REQUEST") eligible = false;
          else throw error;
        }
        if (eligible) {
          try { await options.reward.solver.beforeDispatch?.(rewardBody, index); useReward = true; return; }
          catch (error) { if (!(error instanceof InferenceFundingRequired) || error.message !== "INFERENCE_FUNDING_REQUIRED") throw error; }
        }
      }
      const required = ledger.quote(body).reservedCredits;
      await options.activity?.({scene:"model",state:"selected",phaseId:`round-${index}`,subject:{id:model.id,name:model.id,kind:"model"},evidence:{taskId:task.taskId,inputMicroCreditsPerToken:model.inputMicroCreditsPerToken,outputMicroCreditsPerToken:model.outputMicroCreditsPerToken,reservedCreditsRaw:required}});
      if (BigInt(ledger.balance().availableCredits) < BigInt(required)) {
        if (snapshot.inference) throw new InferenceFundingRequired("ALLOWANCE_EXHAUSTED");
        if (BigInt(config.creditsRaw) < BigInt(required)) throw new InferenceFundingRequired("ALLOWANCE_TOO_SMALL");
        try { await purchase(); } catch (error) {
          if (error instanceof PaymentError && !snapshot.handle?.submission && ["UNDERWRITER_REQUIRED", "CASH_REQUIRED", "AUTHORIZATION_REJECTED", "AUTHORIZATION_MISMATCH"].includes(error.code)) throw new InferenceFundingRequired();
          throw new InferenceFundingRequired(error instanceof PaymentError ? error.code : "ALLOWANCE_PURCHASE_UNCERTAIN");
        }
      }
      if (BigInt(ledger.balance().availableCredits) < BigInt(required)) throw new InferenceFundingRequired();
    }, invoke: async (_tier: string, body: JsonObject) => {
      if (useReward) return { ...await options.reward!.solver.invoke("cheap", { ...body, model: "kimi-k2.6" }, AbortSignal.timeout(Math.max(1, task.deadlineMs - Date.now()))), model: body.model };
      await options.activity?.({scene:"model",state:"waiting",phaseId:`round-${round}`,subject:{id:String(body.model),name:String(body.model),kind:"model"},evidence:{taskId:task.taskId}});
      const delivery = await ledger.invoke(`round:${round}`, body);
      await options.activity?.({scene:"model",state:"completed",phaseId:`round-${round}`,subject:{id:String(body.model),name:String(body.model),kind:"model"},evidence:{taskId:task.taskId,promptTokens:delivery.usage.promptTokens,completionTokens:delivery.usage.completionTokens,usedCreditsRaw:delivery.chargedCredits}});
      // Pi binds its public route ID; the ledger independently checks the physical response model.
      return { ...(delivery.response as Record<string, Json>), model: body.model };
    }, recoverResponse: async (body: JsonObject, index: number) => {
      const result = ledger.readResult(`round:${index}`, body);
      if (result) return { ...(result.response as Record<string, Json>), model: body.model };
      const reward = await options.reward?.solver.recoverResponse?.({ ...body, model: "kimi-k2.6" }, index);
      return reward ? { ...reward, model: body.model } : undefined;
    } }, creditsUsed: async () => {
      const records = ledger.status();
      return (await options.reward?.creditsUsed() ?? 0) + (Array.isArray(records) ? records.reduce((sum: number, r: any) => sum + (r.result?.usage?.promptTokens ?? 0) + (r.result?.usage?.completionTokens ?? 0), 0) : 0);
    }, close: async () => { try { await ledger.close(); } finally { await store.close(); } } };
  } catch (error) { try { await gateway?.close(); } finally { await store.close(); } throw error; }
}
