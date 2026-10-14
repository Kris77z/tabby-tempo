import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { Contract, JsonRpcProvider, Transaction, Wallet, getAddress, keccak256, type TransactionReceipt } from "ethers";
import { SessionStore } from "../../../packages/pi-loop/src/session.js";
import { readWorkflowStatus } from "../../../packages/pi-loop/src/workflow.js";
import { taskPrivateFile } from "../../../packages/pi-loop/src/task-runner/config.js";
import { runLiveHand, HOLDEM_LIVE_LIMITS, type LiveDecisionProfile } from "../../arena/src/holdem/live.js";
import { replayHand, type Seat } from "../../arena/src/holdem/engine.js";
import { InferenceRewardLedger, INFERENCE_REWARD_POLICY, prepareRewardChat } from "../../arena/src/inference-rewards/index.js";
import { InferenceFundingRequired } from "../../../packages/pi-loop/src/provider.js";
import type { WorkflowOptions } from "../../../packages/pi-loop/src/workflow.js";
import { createKimiRewardDispatch } from "../../arena/src/inference-rewards/provider.js";
import { DemoJournal } from "../../../scripts/demo-journal.js";
import { saveJson } from "../../../scripts/demo-common.js";
import { chainRpcProvider, proxyUpstreamFetch, readRpcUrlFile, systemHttpsProxy, type RpcTransport } from "../../../scripts/demo-rpc.js";
import { HostedError, type HostedBinding, type HostedExecution, type HostedExecutor, type HostedResult, type HostedStrategy } from "./types.js";
import { TEMPO_PATH_USD } from "../../../scripts/tempo-config.js";
import { assertGameAwardEvent } from "./game-award-events.js";

export interface HostedGameExecutorConfig {
  version: 1; chainId: "31337" | "10143" | "42431"; identity: string; account: string; token: string;
  rpcUrlFile?: string; publicRpcUrl?: string; rpcTransport: RpcTransport; upstreamTransport?: RpcTransport;
  sponsorKeyFile: string;
  opponent: { binding: HostedBinding; keyFile: string; modelId: string; strategy: HostedStrategy };
  models: { id: string; baseUrl: string; keyFile: string }[];
  creditsDirectory: string; walletDirectory: string;
}
export interface HostedGameDependencies { provider?: JsonRpcProvider; upstreamFetch?: typeof fetch; gameDeadline?: (input: HostedExecution) => number | undefined }
interface WalletJournal { chainId: string; signer: string; account: string; directory: string; binding: string; phase: string }
interface OperatorJournal { directory?: string; hash?: string }
interface GameJournal {
  version: 1; binding: string; startedAtMs: number; deadlineMs: number; phase: string;
  result?: HostedResult; suspended?: WalletJournal; award?: { allocations: [string, string]; replayDigest: string; cashBefore: [string, string] };
}
const TOKEN_ABI = ["function decimals() view returns(uint8)", "function symbol() view returns(string)", "function balanceOf(address) view returns(uint256)",
  "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)",
  "event Transfer(address indexed from,address indexed to,uint256 value)", "event Approval(address indexed owner,address indexed spender,uint256 value)"];
const ACCOUNT_ABI = ["function settlementAsset() view returns(address)", "function adapter() view returns(address)",
  "function cash(uint256) view returns(uint256)", "function depositCash(uint256,uint256)",
  "event CashCredited(uint256 indexed agentId,address indexed from,uint256 amount)"];
const IDENTITY_ABI = ["function ownerOf(uint256) view returns(address)", "function getAgentWallet(uint256) view returns(address)"];
const ADAPTER_ABI = ["function identity() view returns(address)"];
const REWARD = 100000n;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const terminal = (phase: string) => ["Succeeded", "Failed", "Refunded", "Stopped"].includes(phase);
function fail(code: string): never { throw new HostedError(code, 409); }
function closed(value: unknown, fields: string[]): asserts value is Record<string, any> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(k => !fields.includes(k))) fail("HOSTED_GAME_CONFIG_INVALID");
}
function address(value: unknown): string { if (typeof value !== "string") fail("HOSTED_GAME_ADDRESS_INVALID"); try { const a = getAddress(value); if (/^0x0{40}$/.test(a)) fail("HOSTED_GAME_ADDRESS_INVALID"); return a; } catch { return fail("HOSTED_GAME_ADDRESS_INVALID"); } }
function binding(value: unknown): HostedBinding {
  closed(value, ["chainId", "agentId", "wallet"]);
  if (!["31337", "10143", "42431"].includes(value.chainId) || typeof value.agentId !== "string" || !/^[1-9][0-9]{0,77}$/.test(value.agentId)
    || BigInt(value.agentId) >= 2n ** 256n) fail("HOSTED_GAME_IDENTITY_INVALID");
  return { chainId: value.chainId, agentId: value.agentId, wallet: address(value.wallet) };
}
function path(value: unknown): asserts value is string { if (typeof value !== "string" || !isAbsolute(value) || resolve(value) !== value) fail("HOSTED_GAME_PRIVATE_PATH_REQUIRED"); }
function strategy(value: unknown): asserts value is HostedStrategy { if (!["conservative", "balanced", "aggressive"].includes(value as string)) fail("HOSTED_GAME_STRATEGY_INVALID"); }
/** Pure whitelist validation, suitable for supervisor --check. */
export function validateHostedGameExecutorConfig(value: unknown): HostedGameExecutorConfig {
  closed(value, ["version", "chainId", "identity", "account", "token", "rpcUrlFile", "publicRpcUrl", "rpcTransport", "upstreamTransport", "sponsorKeyFile", "opponent", "models", "creditsDirectory", "walletDirectory"]);
  if (value.version !== 1 || !["31337", "10143", "42431"].includes(value.chainId) || !["direct", "system-https-proxy"].includes(value.rpcTransport)
    || value.upstreamTransport !== undefined && !["direct", "system-https-proxy"].includes(value.upstreamTransport)) fail("HOSTED_GAME_CONFIG_INVALID");
  for (const key of ["sponsorKeyFile", "creditsDirectory", "walletDirectory"]) path(value[key]);
  if ((value.rpcUrlFile === undefined) === (value.publicRpcUrl === undefined)) fail("HOSTED_GAME_ONE_RPC_REQUIRED");
  if (value.rpcUrlFile !== undefined) { path(value.rpcUrlFile); if (value.chainId === "31337") fail("HOSTED_GAME_RPC_INVALID"); }
  if (value.publicRpcUrl !== undefined) {
    let url: URL; try { url = new URL(value.publicRpcUrl); } catch { return fail("HOSTED_GAME_RPC_INVALID"); }
    if (value.chainId !== "31337" || value.rpcTransport !== "direct" || url.protocol !== "http:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || url.pathname !== "/") fail("HOSTED_GAME_RPC_INVALID");
  }
  closed(value.opponent, ["binding", "keyFile", "modelId", "strategy"]); path(value.opponent.keyFile); strategy(value.opponent.strategy);
  const bot = binding(value.opponent.binding);
  if (bot.chainId !== value.chainId || !Array.isArray(value.models) || !value.models.length || value.models.length > 8) fail("HOSTED_GAME_CONFIG_INVALID");
  for (const model of value.models) {
    closed(model, ["id", "baseUrl", "keyFile"]); path(model.keyFile);
    if (typeof model.id !== "string" || !/^[A-Za-z0-9._-]{1,64}$/.test(model.id)) fail("HOSTED_GAME_MODEL_INVALID");
    // Reuse the existing official-provider whitelist without reading a key or making a request.
    createKimiRewardDispatch({ baseUrl: model.baseUrl, key: "configuration-validation" });
  }
  if (new Set(value.models.map((m: any) => m.id)).size !== value.models.length || !value.models.some((m: any) => m.id === value.opponent.modelId)
    || !value.models.some((m: any) => m.id === INFERENCE_REWARD_POLICY.model)) fail("HOSTED_GAME_MODEL_INVALID");
  if (value.chainId === "42431" && !same(address(value.token), TEMPO_PATH_USD)) fail("HOSTED_GAME_ASSET_MISMATCH");
  return { ...structuredClone(value), identity: address(value.identity), account: address(value.account), token: address(value.token), opponent: { ...value.opponent, binding: bot } } as HostedGameExecutorConfig;
}
async function privateText(file: string) {
  path(file);
  try { return (await taskPrivateFile(file)).trim(); } catch { return fail("HOSTED_GAME_PRIVATE_FILE_REQUIRED"); }
}
/** Read-only loading: no provider construction, directories, or HTTP. */
export async function loadHostedGameExecutorConfig(file: string): Promise<HostedGameExecutorConfig> {
  let value: unknown; try { value = JSON.parse(await privateText(file)); } catch (e) { if (e instanceof HostedError) throw e; return fail("HOSTED_GAME_CONFIG_UNREADABLE"); }
  const config = validateHostedGameExecutorConfig(value);
  let sponsor: Wallet, bot: Wallet;
  try { sponsor = new Wallet(await privateText(config.sponsorKeyFile)); bot = new Wallet(await privateText(config.opponent.keyFile)); }
  catch (error) { if (error instanceof HostedError) throw error; return fail("HOSTED_GAME_KEY_INVALID"); }
  if (!same(bot.address, config.opponent.binding.wallet) || same(bot.address, sponsor.address)) fail("HOSTED_GAME_KEY_BINDING_MISMATCH");
  for (const model of config.models) if (!await privateText(model.keyFile)) fail("HOSTED_GAME_MODEL_KEY_REQUIRED");
  if (config.rpcUrlFile) { await privateText(config.rpcUrlFile); await readRpcUrlFile(config.rpcUrlFile); }
  return config;
}

/** Free sponsored hand and identity-bound credits. Task borrowing is not part of this adapter. */
export class HostedGameExecutor implements HostedExecutor {
  readonly config: HostedGameExecutorConfig;
  private provider?: JsonRpcProvider;
  private connection?: Awaited<ReturnType<typeof chainRpcProvider>>;
  private connecting?: Promise<JsonRpcProvider>;
  private upstream?: ReturnType<typeof proxyUpstreamFetch>;
  private physical?: Promise<typeof fetch>;
  constructor(config: HostedGameExecutorConfig, private readonly dependencies: HostedGameDependencies = {}) {
    this.config = validateHostedGameExecutorConfig(config); this.provider = dependencies.provider;
  }
  private async rpc(): Promise<JsonRpcProvider> {
    if (!this.connecting) this.connecting = this.connectRpc().catch(error => { this.connecting = undefined; throw error; });
    return this.connecting;
  }
  private async connectRpc() {
    if (!this.provider) {
      if (this.config.publicRpcUrl) this.provider = new JsonRpcProvider(this.config.publicRpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
      else { this.connection = await chainRpcProvider(await readRpcUrlFile(this.config.rpcUrlFile!), this.config.chainId, this.config.rpcTransport); this.provider = this.connection.provider; }
    }
    return this.provider;
  }
  private upstreamFetch(): Promise<typeof fetch> {
    return this.physical ??= (async () => {
      if (this.dependencies.upstreamFetch) return this.dependencies.upstreamFetch;
      if (this.config.upstreamTransport === "system-https-proxy") { this.upstream = proxyUpstreamFetch(await systemHttpsProxy(), HOLDEM_LIVE_LIMITS.upstreamTimeoutMs); return this.upstream.fetch; }
      return fetch;
    })().catch(error => { this.physical = undefined; throw error; });
  }
  close() { if (!this.dependencies.provider) this.provider?.destroy(); this.connection?.close(); this.upstream?.close(); }
  async execute(input: HostedExecution): Promise<HostedResult> {
    if (!["game", "credits"].includes(input.run.action)) fail("HOSTED_GAME_ACTION_INVALID");
    if (!UUID.test(input.agent.id) || !UUID.test(input.run.requestId) || input.run.agentId !== input.agent.id || !input.agent.binding
      || input.run.action === "game" && !["usdc", "llm-credits"].includes(input.run.rewardKind as string)) fail("HOSTED_GAME_INPUT_INVALID");
    path(input.directory); strategy(input.agent.strategy);
    const actor = binding(input.agent.binding), bot = this.config.opponent.binding;
    if (actor.chainId !== this.config.chainId || !same(actor.wallet, input.agent.wallet) || same(actor.wallet, bot.wallet) || actor.agentId === bot.agentId
      || !this.config.models.some(m => m.id === input.agent.modelId)) fail("HOSTED_GAME_IDENTITY_MISMATCH");
    const rpc = await this.rpc(), actorWallet = new Wallet(await privateText(input.keyFile), rpc);
    const botWallet = new Wallet(await privateText(this.config.opponent.keyFile), rpc), sponsor = new Wallet(await privateText(this.config.sponsorKeyFile), rpc);
    if (!same(actorWallet.address, actor.wallet) || !same(botWallet.address, bot.wallet) || [actor.wallet, bot.wallet].some(w => same(w, sponsor.address))) fail("HOSTED_GAME_KEY_BINDING_MISMATCH");
    const profiles: [LiveDecisionProfile, LiveDecisionProfile] = [{ model: input.agent.modelId, strategy: input.agent.strategy }, { model: this.config.opponent.modelId, strategy: this.config.opponent.strategy }];
    const frozen = { owner: address(input.agent.owner), hostedAgentId: input.agent.id, requestId: input.run.requestId, action: input.run.action,
      rewardKind: input.run.rewardKind, ...(input.run.fundingFor ? { fundingFor: input.run.fundingFor } : {}), players: [actor, bot], profiles, sponsor: sponsor.address, chainId: this.config.chainId,
      identity: this.config.identity, account: this.config.account, token: this.config.token, ...(input.run.testSponsorship ? { testSponsorship: input.run.testSponsorship } : {}) };
    const bound = digest(frozen), store = new SessionStore<GameJournal>(input.directory);
    const walletStore = new SessionStore<WalletJournal>(join(this.config.walletDirectory, actor.wallet.toLowerCase()));
    await walletStore.start(input.recover); let held = false, state: GameJournal | undefined;
    const updateWallet = async (phase: string) => {
      if (state?.suspended && terminal(phase)) {
        const current = await readWorkflowStatus(state.suspended.directory);
        if (!current) fail("HOSTED_GAME_RECOVER_ORIGINAL_REQUIRED");
        await walletStore.write({ ...state.suspended, phase: current.phase });
      } else await walletStore.write({ chainId: actor.chainId, signer: actorWallet.address, account: this.config.account, directory: input.directory, binding: bound, phase });
    };
    const result = (phase: string, success: boolean, terminalValue: boolean, extra: Partial<HostedResult> = {}): HostedResult => ({ phase, terminal: terminalValue, success, chargedRaw: "0", principalRaw: "0", feeRaw: "0", ...extra });
    try {
      const active = await walletStore.read();
      if (active?.phase === "Stopped") {
        const workflow = await readWorkflowStatus(active.directory);
        if (!workflow) fail("HOSTED_GAME_RECOVER_ORIGINAL_REQUIRED");
        active.phase = workflow.phase; await walletStore.write(active);
      }
      let suspended: WalletJournal | undefined;
      if (active && !terminal(active.phase) && active.directory !== input.directory && input.run.fundingFor) {
        if (!UUID.test(input.run.fundingFor) || input.run.action !== "game" || input.run.rewardKind !== "llm-credits"
          || active.directory !== join(resolve(input.directory, ".."), input.run.fundingFor, "task-executor", "workflow")
          || !same(active.signer, actor.wallet) || active.chainId !== actor.chainId || !same(active.account, this.config.account)) fail("HOSTED_GAME_RECOVER_ORIGINAL_REQUIRED");
        const waiting = await readWorkflowStatus(active.directory);
        if (waiting?.phase !== "Paused" || waiting.reason !== "INFERENCE_FUNDING_REQUIRED" || waiting.choice?.funding !== "reward-tokens") fail("HOSTED_GAME_RECOVER_ORIGINAL_REQUIRED");
        suspended = structuredClone(active);
      }
      if (!suspended && active && (!same(active.signer, actor.wallet) || !terminal(active.phase) && (active.directory !== input.directory || active.binding !== bound))) fail("HOSTED_GAME_RECOVER_ORIGINAL_REQUIRED");
      await store.start(input.recover); held = true; state = await store.read();
      if (state && (state.version !== 1 || state.binding !== bound)) fail("HOSTED_GAME_RUN_BINDING_CHANGED");
      if (state?.result?.terminal) { await updateWallet(state.result.success ? "Succeeded" : "Failed"); return structuredClone(state.result); }
      if (!state) { const startedAtMs = Date.now(), authorizationDeadline = this.dependencies.gameDeadline?.(input);
        state = { version: 1, binding: bound, startedAtMs, deadlineMs: Math.max(startedAtMs, Math.min(startedAtMs + HOLDEM_LIVE_LIMITS.deadlineDurationMs, authorizationDeadline ?? Infinity)), phase: input.run.action === "game" ? "Game" : "CreditsPending", ...(suspended ? { suspended } : {}) }; await store.write(state); }
      await updateWallet("Running");
      await this.preflight(rpc, actor, bot);
      const account = new Contract(this.config.account, ACCOUNT_ABI, rpc);
      let output: HostedResult;
      if (input.run.action === "credits") {
        const ledger = await this.ledger(input.agent.id, actor, bot, input.recover);
        try {
          await input.activity?.({scene:"model",state:"waiting",subject:{id:INFERENCE_REWARD_POLICY.model,name:INFERENCE_REWARD_POLICY.model,kind:"model"}});
          const record = await ledger.redeem(actor, { redemptionId: input.run.requestId, prompt: "Confirm this reward-funded hosted Agent inference request.", maxCompletionTokens: 128 });
          const done = ["Completed", "Failed"].includes(record.status);
          await input.activity?.({scene:"model",state:record.status==="Completed"?"completed":done?"failed":"reconciling",evidence:{creditsUsed:record.chargedTokens??0}});
          output = result(record.status, record.status === "Completed", done, { creditsUsed: record.chargedTokens ?? 0, ...(record.error ? { reason: record.error } : {}) });
        } catch (error) {
          if ((error as Error)?.message !== "REWARD_INSUFFICIENT_AVAILABLE_TOKENS") throw error;
          output = result("Failed", false, true, { reason: "REWARD_INSUFFICIENT_AVAILABLE_TOKENS", creditsUsed: 0 });
        } finally { await ledger.close(); }
      } else {
        const matchId = `hosted-${input.run.requestId}`;
        const game = await runLiveHand(input.directory, { matchId, startedAtMs: state.startedAtMs, deadlineMs: state.deadlineMs, profiles, recover: input.recover }, {
          onProgress:async view=>{
            const attempt=view.attempts.at(-1),unknown=attempt?.outcome==="OutcomeUnknown"||view.reason==="EXISTING_GAME_NO_REDISPATCH";
            const outcome=view.result?view.result.winners.length>1?"draw":view.result.winners.includes(0)?"won":"lost":undefined;
            await input.activity?.({scene:unknown?"interruption":"game",state:view.phase==="Complete"?"completed":view.phase==="Stopped"?unknown?"reconciling":"failed":attempt?.outcome==="IntentPersisted"?"waiting":"started",subject:{id:view.matchId,name:"Heads-up Hold’em",kind:"game"},...(attempt?.seat===1&&view.phase==="Running"?{reason:"HOSTED_GAME_WAITING_OPPONENT"}:view.reason?{reason:/^[A-Z][A-Z0-9_]{0,100}$/.test(view.reason)?view.reason:"HOSTED_GAME_NOT_COMPLETE"}:{}),evidence:{matchId:view.matchId,...(outcome?{outcome}:{})}});
          },
          dispatch: async (request, signal) => {
            const model = this.config.models.find(m => m.id === request.model)!;
            const key = await privateText(model.keyFile), url = new URL(model.baseUrl);
            return (await this.upstreamFetch())(`${url.origin}/v1/chat/completions`, { method: "POST", redirect: "error", signal,
              headers: { "content-type": "application/json", authorization: `Bearer ${key}` }, body: JSON.stringify(request) });
          },
        });
        const hand = replayHand(game.replay), view = hand.view(0);
        if (game.phase !== "Complete") {
          const unknown = game.turns.some(t => ["OutcomeUnknown", "IntentPersisted"].includes(t.outcome)) || game.reason === "EXISTING_GAME_NO_REDISPATCH";
          output = result(game.phase, false, !unknown, { matchId, reason: game.reason ?? "HOSTED_GAME_NOT_COMPLETE" });
        } else {
          if (view.handStatus !== "complete" || !view.result) fail("HOSTED_GAME_REPLAY_NOT_TERMINAL");
          const wins=view.result.winners.includes(0);
          if(wins)await input.activity?.({scene:"settlement",state:"waiting",evidence:{matchId},reason:input.run.rewardKind==="usdc"?"HOSTED_GAME_REWARD_PENDING":"HOSTED_GAME_CREDITS_PENDING"});
          state.phase = input.run.rewardKind === "usdc" ? "RewardPending" : "CreditsPending"; await store.write(state);
          if (input.run.rewardKind === "llm-credits") {
            const ledger = await this.ledger(input.agent.id, actor, bot, input.recover);
            try {
              const grant = await ledger.grantTerminal({ grantId: input.run.requestId, matchId, replayDigest: digest(hand.exportTrustedReplay()), players: [actor, bot], winners: view.result.winners });
              output = result("Succeeded", true, true, { matchId, creditsGranted: grant.allocations[0], rewardRaw: "0" });
              await input.activity?.({scene:grant.allocations[0]>0?"settlement":"game",state:grant.allocations[0]>0?"confirmed":"completed",evidence:{matchId,creditsGranted:grant.allocations[0],outcome:view.result.winners.length>1?"draw":wins?"won":"lost"}});
            } finally { await ledger.close(); }
          } else {
            const reward = await this.award(input, state, store, rpc, [actorWallet, botWallet], sponsor, [actor, bot], view.result.winners, digest(hand.exportTrustedReplay()));
            output = result("Succeeded", true, true, { matchId, rewardRaw: state.award!.allocations[0], cashRaw: String(await account.getFunction("cash").staticCall(actor.agentId)), ...(reward ? { txHash: reward } : {}) });
            await input.activity?.({scene:BigInt(output.rewardRaw!)>0n?"settlement":"game",state:BigInt(output.rewardRaw!)>0n?"confirmed":"completed",evidence:{matchId,rewardRaw:output.rewardRaw!,...(reward?{txHash:reward}:{}),outcome:view.result.winners.length>1?"draw":wins?"won":"lost"}});
          }
        }
      }
      state.result = output; state.phase = output.terminal ? output.success ? "Succeeded" : "Failed" : "Paused"; await store.write(state); await updateWallet(state.phase);
      return structuredClone(output);
    } catch (error) {
      // A conflicting caller must not poison the original successful/pending journal or its wallet guard.
      if (error instanceof HostedError && error.code === "HOSTED_GAME_RUN_BINDING_CHANGED") throw error;
      if (held && state) {
        const raw = error instanceof HostedError ? error.code : (error as Error)?.message;
        const code = typeof raw === "string" && /^[A-Z][A-Z0-9_]{0,100}$/.test(raw) ? raw : "HOSTED_GAME_CHAIN_OR_PROVIDER_UNCERTAIN";
        state.result = result(state.phase, false, false, { reason: code }); await store.write(state); await updateWallet("Paused"); return structuredClone(state.result);
      }
      throw error;
    } finally { try { if (held) await store.close(); } finally { await walletStore.close(); } }
  }
  private async preflight(rpc: JsonRpcProvider, actor: HostedBinding, bot: HostedBinding) {
    if (BigInt(await rpc.send("eth_chainId", [])) !== BigInt(this.config.chainId)) fail("HOSTED_GAME_CHAIN_MISMATCH");
    for (const addr of [this.config.identity, this.config.account, this.config.token]) if (await rpc.getCode(addr) === "0x") fail("HOSTED_GAME_CONTRACT_CODE_MISSING");
    const identity = new Contract(this.config.identity, IDENTITY_ABI, rpc), account = new Contract(this.config.account, ACCOUNT_ABI, rpc), token = new Contract(this.config.token, TOKEN_ABI, rpc);
    if (!same(await account.getFunction("settlementAsset").staticCall(), this.config.token) || await token.getFunction("decimals").staticCall() !== 6n) fail("HOSTED_GAME_ASSET_MISMATCH");
    if (this.config.chainId === "42431" && (!same(this.config.token, TEMPO_PATH_USD) || await token.getFunction("symbol").staticCall() !== "PathUSD")) fail("HOSTED_GAME_ASSET_MISMATCH");
    const adapter = new Contract(await account.getFunction("adapter").staticCall(), ADAPTER_ABI, rpc);
    if (!same(await adapter.getFunction("identity").staticCall(), this.config.identity)) fail("HOSTED_GAME_REGISTRY_MISMATCH");
    for (const player of [actor, bot]) {
      if (!same(await identity.getFunction("ownerOf").staticCall(player.agentId), player.wallet) || !same(await identity.getFunction("getAgentWallet").staticCall(player.agentId), player.wallet)) fail("HOSTED_GAME_IDENTITY_CHANGED");
    }
  }
  /** Shares the exact reward ledger used by trusted game settlement. No cash or credit fallback. */
  async rewardTask(input: HostedExecution): Promise<NonNullable<WorkflowOptions["reward"]> & { close: () => Promise<void> }> {
    if (!input.agent.binding || input.agent.modelId !== INFERENCE_REWARD_POLICY.model) fail("HOSTED_REWARD_MODEL_UNSUPPORTED");
    const actor = binding(input.agent.binding), bot = this.config.opponent.binding;
    if (actor.chainId !== this.config.chainId || !same(actor.wallet, input.agent.wallet)) fail("HOSTED_GAME_IDENTITY_MISMATCH");
    await this.preflight(await this.rpc(), actor, bot);
    const ledger = await this.ledger(input.agent.id, actor, bot, input.recover);
    const prefix = `${input.run.requestId}:round:`, model = this.config.models.find(m => m.id === INFERENCE_REWARD_POLICY.model)!;
    let round = 0;
    return {
      solver: {
        routes: { cheap: { name: model.id, model: model.id, baseUrl: model.baseUrl }, strong: { name: model.id, model: model.id, baseUrl: model.baseUrl } },
        beforeDispatch: async (body, index) => {
          round = index;
          await input.activity?.({scene:"model",state:"selected",phaseId:`round-${index}`,subject:{id:model.id,name:model.id,kind:"model"}});
          const prepared = prepareRewardChat({ redemptionId: `${prefix}${index}`, request: body });
          const balance = await ledger.balance(actor);
          if (balance.blocked) throw new Error("REWARD_ACCOUNT_BLOCKED_BY_USAGE_OVERRUN");
          if (balance.availableTokens < prepared.reservedTokens) throw new InferenceFundingRequired();
        },
        recoverResponse: async (_body, index) => (await ledger.taskResponse(actor, `${prefix}${index}`)) ?? undefined,
        invoke: async (_tier, body) => {
          const redemptionId = `${prefix}${round}`;
          await input.activity?.({scene:"model",state:"waiting",phaseId:`round-${round}`,subject:{id:model.id,name:model.id,kind:"model"}});
          const record = await ledger.redeemChat(actor, { redemptionId, request: body });
          const response = await ledger.taskResponse(actor, redemptionId);
          if (!response) throw new Error(record.error ?? "REWARD_TASK_RESPONSE_UNAVAILABLE");
          await input.activity?.({scene:"model",state:"completed",phaseId:`round-${round}`,subject:{id:model.id,name:model.id,kind:"model"},evidence:{creditsUsed:record.chargedTokens??0}});
          return response;
        },
      },
      creditsUsed: () => ledger.taskUsage(actor, prefix), close: () => ledger.close(),
    };
  }
  private async ledger(hostedId: string, actor: HostedBinding, bot: HostedBinding, recover: boolean) {
    const model = this.config.models.find(m => m.id === INFERENCE_REWARD_POLICY.model)!;
    return InferenceRewardLedger.open(join(this.config.creditsDirectory, hostedId), { accounts: [actor, bot], recover,
      dispatch: createKimiRewardDispatch({ baseUrl: model.baseUrl, key: await privateText(model.keyFile), upstreamFetch: await this.upstreamFetch() }) });
  }
  private async award(input: HostedExecution, state: GameJournal, store: SessionStore<GameJournal>, rpc: JsonRpcProvider,
    wallets: [Wallet, Wallet], sponsor: Wallet, players: [HostedBinding, HostedBinding], winners: Seat[], replayDigest: string) {
    const token = new Contract(this.config.token, TOKEN_ABI, rpc), account = new Contract(this.config.account, ACCOUNT_ABI, rpc);
    const locks: SessionStore<WalletJournal>[] = [];
    // The same operator key can fund registration gas, enroll an Agent and sponsor prizes.
    // All of those operations must share one nonce writer and pending-request guard.
    const operator = new SessionStore<OperatorJournal>(join(this.config.walletDirectory, "operator", sponsor.address.toLowerCase()));
    let operatorHeld = false;
    try {
      await operator.start(input.recover); operatorHeld = true;
      const activeOperator = await operator.read();
      if (activeOperator?.directory && activeOperator.directory !== input.directory) fail("HOSTED_GAME_SPONSOR_RECOVERY_REQUIRED");
      await operator.write({ directory: input.directory });
      for (const signer of [wallets[1].address]) {
        const lock = new SessionStore<WalletJournal>(join(this.config.walletDirectory, signer.toLowerCase())); await lock.start(input.recover); locks.push(lock);
        const existing = await lock.read();
        if (existing && (!same(existing.signer, signer) || !terminal(existing.phase) && (existing.directory !== input.directory || existing.binding !== state.binding))) fail("HOSTED_GAME_SPONSOR_RECOVERY_REQUIRED");
        await lock.write({ chainId: this.config.chainId, signer, account: this.config.account, directory: input.directory, binding: state.binding, phase: "Running" });
      }
      const allocations: [string, string] = [winners.includes(0) ? String(REWARD / BigInt(winners.length)) : "0", winners.includes(1) ? String(REWARD / BigInt(winners.length)) : "0"];
      if (!state.award) { state.award = { allocations, replayDigest, cashBefore: [String(await account.getFunction("cash").staticCall(players[0].agentId)), String(await account.getFunction("cash").staticCall(players[1].agentId))] }; await store.write(state); }
      if (state.award.replayDigest !== replayDigest || JSON.stringify(state.award.allocations) !== JSON.stringify(allocations)) fail("HOSTED_GAME_AWARD_BINDING_CHANGED");
      const journal = new DemoJournal(rpc, join(input.directory, "reward-transactions.json")); await journal.load();
      let actorDeposit: string | undefined;
      for (const seat of [0, 1] as const) {
        const amount = BigInt(allocations[seat]); if (!amount) continue;
        const steps = [
          { role: "reward", wallet: sponsor, to: this.config.token, data: token.interface.encodeFunctionData("transfer", [players[seat].wallet, amount]), event: "Transfer" },
          { role: "approve", wallet: wallets[seat], to: this.config.token, data: token.interface.encodeFunctionData("approve", [this.config.account, amount]), event: "Approval" },
          { role: "deposit", wallet: wallets[seat], to: this.config.account, data: account.interface.encodeFunctionData("depositCash", [players[seat].agentId, amount]), event: "CashCredited" },
        ];
        for (const step of steps) {
          const id = `hosted:${input.run.requestId}:${replayDigest}:${seat}:${step.role}`;
          if (journal.has(id)) {
            const entry = JSON.parse(await readFile(journal.path, "utf8"))[id], original = Transaction.from(entry.rawTransaction);
            if (!same(original.from!, step.wallet.address) || !same(original.to!, step.to) || original.data !== step.data || original.chainId !== BigInt(this.config.chainId)
              || original.value !== 0n || original.hash !== entry.txHash || keccak256(entry.rawTransaction) !== entry.txHash) fail("HOSTED_GAME_AWARD_SIGNATURE_MISMATCH");
          } else if (step.role === "reward" && await token.getFunction("balanceOf").staticCall(sponsor.address) < amount) fail("HOSTED_GAME_SPONSOR_BALANCE_INSUFFICIENT");
          await journal.send(id, step.wallet, { to: step.to, data: step.data, chainId: BigInt(this.config.chainId), value: 0n });
          const receipt = await journal.receipt(id); await this.canonical(rpc, receipt);
          assertGameAwardEvent(receipt, { role: step.role as "reward" | "approve" | "deposit", contract: step.to,
            sender: step.role === "reward" ? sponsor.address : players[seat].wallet,
            recipient: step.role === "reward" ? players[seat].wallet : this.config.account, agentId: players[seat].agentId, amount });
          await saveJson(join(input.directory, `receipt-${seat}-${step.role}.json`), receipt.toJSON());
          if (seat === 0 && step.role === "deposit") actorDeposit = receipt.hash;
        }
      }
      for (const seat of [0, 1] as const) if (await account.getFunction("cash").staticCall(players[seat].agentId) !== BigInt(state.award.cashBefore[seat]) + BigInt(allocations[seat])) fail("HOSTED_GAME_AWARD_CASH_MISMATCH");
      for (const lock of locks) { const value = (await lock.read())!; value.phase = "Succeeded"; await lock.write(value); }
      await operator.write({});
      return actorDeposit;
    } finally { try { for (const lock of locks.reverse()) await lock.close(); } finally { if (operatorHeld) await operator.close(); } }
  }
  private async canonical(rpc: JsonRpcProvider, receipt: TransactionReceipt) {
    const fresh = await rpc.getTransactionReceipt(receipt.hash);
    if (!fresh || fresh.status !== 1 || fresh.blockHash !== receipt.blockHash || fresh.blockNumber !== receipt.blockNumber
      || (await rpc.getBlock(fresh.blockNumber))?.hash !== fresh.blockHash) fail("HOSTED_GAME_AWARD_RECEIPT_NOT_CANONICAL");
  }
}
export const createHostedGameExecutor = (config: HostedGameExecutorConfig, dependencies?: HostedGameDependencies) => new HostedGameExecutor(config, dependencies);
