import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Contract, getAddress, JsonRpcProvider, Transaction, Wallet, ZeroAddress, ZeroHash, type TransactionReceipt } from "ethers";
import { IDENTITY_ABI, REPUTATION_ABI } from "../packages/erc8004/src/index.js";
import { SessionStore } from "../packages/pi-loop/src/session.js";
import { replayHand, type HandResult, type Seat } from "../services/arena/src/holdem/index.js";
import { json, reportDemoFailure, saveJson } from "./demo-common.js";
import { DemoJournal } from "./demo-journal.js";
import { deployedContracts, loadMonadConfig, MONAD_CHAIN_ID, MONAD_USDC, readSecret, secretMetadata,
  type ContractAddresses, type MonadConfig } from "./demo-monad-config.js";
import { monadProvider, readRpcUrlFile, type RpcTransport } from "./demo-rpc.js";

export const HOLDEM_MONAD_REWARD = 100000n;
export const HOLDEM_MONAD_INFERENCE_PRICE = 10000n;
const seats = [0, 1] as const;
type PublicResult = Pick<HandResult, "reason" | "winners" | "contestedPot" | "payouts" | "refunds" | "finalStacks">;
export interface HoldemMonadSigner { wallet: string; keyFile: string }
export interface HoldemMonadPlayer extends HoldemMonadSigner { agentId: string }
export interface HoldemMonadConfig {
  version: 1; sourceDirectory: string; monadConfigFile: string; deploymentStateFile: string;
  sponsor: HoldemMonadSigner; players: [HoldemMonadPlayer, HoldemMonadPlayer];
}
export interface HoldemMonadPlan {
  version: 1; mode: "holdem-monad"; stage: "award-and-deposit"; chainId: "10143";
  configDigest: string; sourceDirectory: string; journalDirectory: string;
  source: { matchId: string; reportDigest: string; replayDigest: string; network: "local-anvil";
    upstreamMode: "real-kimi-system-https-proxy"; wallets: [string, string] };
  asset: { address: string; symbol: "USDC"; decimals: 6 }; identity: string; reputation: string;
  contracts: ContractAddresses; sponsor: string; provider: string;
  players: [{ seat: 0; agentId: string; wallet: string }, { seat: 1; agentId: string; wallet: string }];
  reward: string; allocations: [string, string]; result: PublicResult;
  signatureRoles: { sponsor: string; player0: string; player1: string };
  entryFee: "0"; taskIdForLaterPurchase: "0"; inferencePriceRaw: string;
}
export interface HoldemMonadRuntime { provider: JsonRpcProvider; token: Contract; account: Contract; manager: Contract }
export interface HoldemMonadSnapshot {
  blockNumber: number; blockHash: string; sponsorToken: string; walletsToken: [string, string];
  cash: [string, string]; providerToken: string; accountToken: string; totalOutstanding: string; task0LoanStatus: string;
}
interface OperationEvidence { id: string; seat: Seat; kind: "reward" | "approve" | "deposit"; amount: string;
  txHash: string; blockNumber: number; blockHash: string; receipt: unknown;
  transaction: { hash: string; from: string; to: string; data: string; chainId: string; value: string; nonce: number } }
interface DeliverySession {
  version: 1; binding: HoldemMonadPlan; before: HoldemMonadSnapshot;
  afterAward?: HoldemMonadSnapshot; afterDeposit?: HoldemMonadSnapshot; operations: OperationEvidence[]; report?: unknown;
}
const sha = (value: string) => createHash("sha256").update(value).digest("hex");
const publicResult = (result: HandResult): PublicResult => ({ reason: result.reason, winners: [...result.winners],
  contestedPot: result.contestedPot, payouts: [...result.payouts], refunds: [...result.refunds], finalStacks: [...result.finalStacks] });
function absolutePath(input: unknown) {
  if (typeof input !== "string" || !isAbsolute(input)) throw new Error("HOLDEM_ABSOLUTE_LOCAL_PATH_REQUIRED");
  return resolve(input);
}
function wallet(input: unknown) {
  try { if (typeof input !== "string") throw new Error(); const address = getAddress(input); if (address === ZeroAddress) throw new Error(); return address; }
  catch { throw new Error("HOLDEM_WALLET_REQUIRED"); }
}
export function parseHoldemMonadConfig(input: unknown): HoldemMonadConfig {
  const value = input as any;
  if (!value || value.version !== 1 || !Array.isArray(value.players) || value.players.length !== 2) throw new Error("HOLDEM_MONAD_CONFIG_REQUIRED");
  const signer = (item: any): HoldemMonadSigner => ({ wallet: wallet(item?.wallet), keyFile: absolutePath(item?.keyFile) });
  const sponsor = signer(value.sponsor);
  const players = value.players.map((item: any) => {
    if (typeof item.agentId !== "string" || !/^[1-9][0-9]*$/.test(item.agentId) || BigInt(item.agentId) >= 2n ** 256n) throw new Error("HOLDEM_EXISTING_AGENT_ID_REQUIRED");
    return { ...signer(item), agentId: item.agentId };
  }) as HoldemMonadConfig["players"];
  if (players[0].agentId === players[1].agentId || new Set([sponsor.wallet, ...players.map(item => item.wallet)]).size !== 3
    || new Set([sponsor.keyFile, ...players.map(item => item.keyFile)]).size !== 3) throw new Error("HOLDEM_INDEPENDENT_SIGNERS_REQUIRED");
  return { version: 1, sourceDirectory: absolutePath(value.sourceDirectory), monadConfigFile: absolutePath(value.monadConfigFile),
    deploymentStateFile: absolutePath(value.deploymentStateFile), sponsor, players };
}
async function privateLocal(path: string, directory = false) {
  const meta = await lstat(path);
  if (meta.isSymbolicLink() || (directory ? !meta.isDirectory() : !meta.isFile()) || (meta.mode & 0o777) !== (directory ? 0o700 : 0o600)
    || (process.getuid && meta.uid !== process.getuid())) throw new Error("HOLDEM_TRUSTED_PRIVATE_LOCAL_FILE_REQUIRED");
}
export async function loadHoldemMonadConfig(path: string) {
  const local = absolutePath(path); await privateLocal(local);
  return parseHoldemMonadConfig(JSON.parse(await readFile(local, "utf8")));
}
/** A trusted local run directory is the input boundary; this API never accepts replay URLs or arbitrary replay JSON. */
export async function buildHoldemMonadPlan(config: HoldemMonadConfig) {
  if (await realpath(config.sourceDirectory) !== config.sourceDirectory) throw new Error("HOLDEM_SOURCE_SYMLINK_REJECTED");
  await privateLocal(config.sourceDirectory, true); await privateLocal(join(config.sourceDirectory, ".private"), true);
  const reportPath = join(config.sourceDirectory, "report.json"), replayPath = join(config.sourceDirectory, ".private", "trusted-replay.json");
  await privateLocal(reportPath); await privateLocal(replayPath);
  const reportBytes = await readFile(reportPath, "utf8"), replayBytes = await readFile(replayPath, "utf8");
  const report = JSON.parse(reportBytes), replay = JSON.parse(replayBytes);
  if (report.version !== 1 || report.mode !== "holdem-live" || report.network !== "local-anvil"
    || report.upstreamMode !== "real-kimi-system-https-proxy" || report.phase !== "Complete" || report.verified !== true
    || typeof report.matchId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(report.matchId)) throw new Error("HOLDEM_COMPLETE_REAL_LOCAL_RUN_REQUIRED");
  const hand = replayHand(replay), view = hand.view(0);
  if (view.handStatus !== "complete" || !view.result) throw new Error("HOLDEM_COMPLETE_TRUSTED_REPLAY_REQUIRED");
  const verifiedReplay = hand.exportTrustedReplay(), replayDigest = sha(JSON.stringify(verifiedReplay));
  const result = publicResult(view.result);
  assert.deepEqual(report.game?.result, result, "HOLDEM_SOURCE_RESULT_MISMATCH");
  if (report.reward?.replayDigest !== replayDigest) throw new Error("HOLDEM_SOURCE_REPLAY_DIGEST_MISMATCH");
  const sourceWallets = report.localChain?.addresses?.wallets;
  if (!Array.isArray(sourceWallets) || sourceWallets.length !== 2) throw new Error("HOLDEM_SOURCE_SEAT_WALLETS_REQUIRED");
  const allocations: [string, string] = ["0", "0"], share = HOLDEM_MONAD_REWARD / BigInt(result.winners.length);
  for (const seat of result.winners) allocations[seat] = share.toString();
  if (allocations.reduce((sum, amount) => sum + BigInt(amount), 0n) !== HOLDEM_MONAD_REWARD) throw new Error("HOLDEM_REWARD_REMAINDER");
  assert.deepEqual(report.reward.allocations, allocations, "HOLDEM_SOURCE_ALLOCATION_MISMATCH");
  const monadConfig = await loadMonadConfig(config.monadConfigFile);
  const state = JSON.parse(await readFile(config.deploymentStateFile, "utf8"));
  if (state.version !== 1 || !state.addresses) throw new Error("HOLDEM_EXISTING_DEPLOYMENT_REQUIRED");
  const contracts = Object.fromEntries(["manager", "adapter", "account", "escrow"].map(key => [key, wallet(state.addresses[key])])) as ContractAddresses;
  if (new Set(Object.values(contracts)).size !== 4 || (monadConfig.contracts && JSON.stringify(monadConfig.contracts) !== JSON.stringify(contracts))) throw new Error("HOLDEM_DEPLOYMENT_BINDING_MISMATCH");
  const players = seats.map(seat => ({ seat, agentId: config.players[seat].agentId, wallet: config.players[seat].wallet })) as HoldemMonadPlan["players"];
  if ([config.sponsor.wallet, ...players.map(item => item.wallet)].includes(monadConfig.roles.provider)) throw new Error("HOLDEM_PROVIDER_MUST_BE_INDEPENDENT");
  const plan: HoldemMonadPlan = { version: 1, mode: "holdem-monad", stage: "award-and-deposit", chainId: "10143",
    configDigest: sha(json(config)), sourceDirectory: config.sourceDirectory, journalDirectory: join(config.sourceDirectory, ".private", "monad-delivery"),
    source: { matchId: report.matchId, reportDigest: sha(reportBytes), replayDigest, network: "local-anvil", upstreamMode: report.upstreamMode,
      wallets: sourceWallets.map(wallet) as [string, string] }, asset: monadConfig.asset, identity: monadConfig.registries.identity,
    reputation: monadConfig.registries.reputation, contracts, sponsor: config.sponsor.wallet, provider: monadConfig.roles.provider,
    players, reward: HOLDEM_MONAD_REWARD.toString(), allocations, result,
    signatureRoles: { sponsor: config.sponsor.wallet, player0: players[0].wallet, player1: players[1].wallet },
    entryFee: "0", taskIdForLaterPurchase: "0", inferencePriceRaw: HOLDEM_MONAD_INFERENCE_PRICE.toString() };
  return { plan, monadConfig: { ...monadConfig, contracts } };
}
const opId = (plan: HoldemMonadPlan, kind: OperationEvidence["kind"], seat: Seat) => `holdem:${plan.source.matchId}:${plan.source.replayDigest}:${kind}:${seat}`;
async function snapshot(plan: HoldemMonadPlan, runtime: HoldemMonadRuntime): Promise<HoldemMonadSnapshot> {
  const { provider, token, account, manager } = runtime, block = await provider.getBlock("latest");
  if (!block?.hash) throw new Error("HOLDEM_CHAIN_SNAPSHOT_REQUIRED");
  const readAt = (contract: Contract, method: string, args: unknown[] = []) => contract.getFunction(method).staticCall(...args, { blockTag: block.number });
  const values = await Promise.all([readAt(token, "balanceOf", [plan.sponsor]), ...plan.players.map(player => readAt(token, "balanceOf", [player.wallet])),
    ...plan.players.map(player => readAt(account, "cash", [player.agentId])), readAt(token, "balanceOf", [plan.provider]),
    readAt(token, "balanceOf", [plan.contracts.account]), readAt(manager, "totalOutstanding"), readAt(manager, "getLoan", [0n])]);
  return { blockNumber: block.number, blockHash: block.hash, sponsorToken: String(values[0]), walletsToken: [String(values[1]), String(values[2])],
    cash: [String(values[3]), String(values[4])], providerToken: String(values[5]), accountToken: String(values[6]),
    totalOutstanding: String(values[7]), task0LoanStatus: String(values[8].status) };
}
/** Read-only preflight checks no key bytes, signs nothing and does not call a model endpoint. */
export async function preflightHoldemMonad(plan: HoldemMonadPlan, config: HoldemMonadConfig, monad: MonadConfig, provider: JsonRpcProvider) {
  if (BigInt(await provider.send("eth_chainId", [])) !== MONAD_CHAIN_ID) throw new Error("NETWORK_MISMATCH");
  for (const address of [plan.asset.address, plan.identity, plan.reputation]) if (await provider.getCode(address) === "0x") throw new Error("HOLDEM_CANONICAL_CONTRACT_REQUIRED");
  const token = new Contract(plan.asset.address, ["function decimals() view returns(uint8)", "function balanceOf(address) view returns(uint256)",
    "function allowance(address,address) view returns(uint256)", "function transfer(address,uint256) returns(bool)", "function approve(address,uint256) returns(bool)",
    "event Transfer(address indexed from,address indexed to,uint256 value)", "event Approval(address indexed owner,address indexed spender,uint256 value)"], provider);
  if (await token.getFunction("decimals").staticCall() !== 6n) throw new Error("USDC_DECIMALS_MISMATCH");
  const identity = new Contract(plan.identity, IDENTITY_ABI, provider), domain = await identity.getFunction("eip712Domain").staticCall();
  if (domain.fields !== "0x0f" || domain.name !== "ERC8004IdentityRegistry" || domain.version !== "1" || domain.chainId !== MONAD_CHAIN_ID
    || getAddress(domain.verifyingContract) !== plan.identity || domain.salt !== ZeroHash || domain.extensions.length) throw new Error("CANONICAL_IDENTITY_DOMAIN_MISMATCH");
  const reputation = new Contract(plan.reputation, REPUTATION_ABI, provider);
  if (getAddress(await reputation.getFunction("getIdentityRegistry").staticCall()) !== plan.identity) throw new Error("REGISTRY_PAIR_MISMATCH");
  const contracts = await deployedContracts(monad, provider, plan.contracts), { account, manager } = contracts;
  const runtime = { provider, token, account, manager }, before = await snapshot(plan, runtime), blockTag = before.blockNumber;
  const playerChecks = await Promise.all(plan.players.map(async player => {
    const [owner, agentWallet, policy, frozen, allowance] = await Promise.all([
      identity.getFunction("ownerOf").staticCall(player.agentId, { blockTag }), identity.getFunction("getAgentWallet").staticCall(player.agentId, { blockTag }),
      account.getFunction("getPolicy").staticCall(player.agentId, { blockTag }), account.getFunction("protocolFrozen").staticCall(player.agentId, { blockTag }),
      token.getFunction("allowance").staticCall(player.wallet, plan.contracts.account, { blockTag })]);
    return { ...player, owner: getAddress(owner), agentWallet: getAddress(agentWallet), ownerWalletMatches: getAddress(owner) === player.wallet && getAddress(agentWallet) === player.wallet,
      maxCashPerTx: String(policy.maxCashPerTx), ownerFrozen: policy.ownerFrozen as boolean, protocolFrozen: frozen as boolean, allowance: String(allowance),
      readyForCashInference: getAddress(owner) === player.wallet && getAddress(agentWallet) === player.wallet && !policy.ownerFrozen && !frozen && policy.maxCashPerTx >= HOLDEM_MONAD_INFERENCE_PRICE };
  }));
  const whitelist = await account.getFunction("providerWhitelist").staticCall(plan.provider, { blockTag });
  const fee = await provider.getFeeData(), feeCap = fee.maxFeePerGas ?? fee.gasPrice;
  if (!feeCap || feeCap <= 0n) throw new Error("FEE_DATA_UNAVAILABLE");
  const journalPath = join(plan.journalDirectory, "transactions.json");
  let saved: DeliverySession | undefined, entries: Record<string, any> = {};
  try { saved = JSON.parse(await readFile(join(plan.journalDirectory, "session.json"), "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("HOLDEM_DELIVERY_SESSION_UNREADABLE"); }
  if (saved) assert.deepEqual(saved.binding, plan, "HOLDEM_DELIVERY_BINDING_MISMATCH");
  try { entries = JSON.parse(await readFile(journalPath, "utf8")); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("HOLDEM_DELIVERY_JOURNAL_UNREADABLE"); }
  let sponsorRequired = 0n;
  for (const seat of seats) {
    if (plan.allocations[seat] === "0") continue;
    const entry = entries[opId(plan, "reward", seat)];
    if (!entry || !(await provider.getTransactionReceipt(entry.txHash))?.status) sponsorRequired += BigInt(plan.allocations[seat]);
  }
  const signing = [config.sponsor, ...config.players], gasUnits = [200000n, 600000n, 600000n];
  const funding = await Promise.all(signing.map(async (signer, index) => {
    const native = await provider.getBalance(signer.wallet, blockTag), nativeRequired = gasUnits[index] * feeCap;
    return { role: index === 0 ? "sponsor" : `player-${index - 1}`, wallet: signer.wallet, native: native.toString(),
      nativeRequired: nativeRequired.toString(), gasUnits: gasUnits[index].toString(), fundedForGas: native >= nativeRequired,
      ...(index === 0 ? { token: before.sponsorToken, tokenRequired: sponsorRequired.toString(), fundedForAward: BigInt(before.sponsorToken) >= sponsorRequired } : {}) };
  }));
  const keyFiles = await Promise.all(signing.map(async (signer, index) => ({ role: index === 0 ? "sponsor" : `player-${index - 1}`, ...await secretMetadata(signer.keyFile) })));
  const report = { version: 1, mode: "holdem-monad", stage: "award-and-deposit", readOnly: true, plan: publicPlan(plan),
    snapshot: before, playerChecks, providerWhitelisted: Boolean(whitelist), funding, keyFiles, existingDelivery: Boolean(saved),
    ready: playerChecks.every(player => player.readyForCashInference) && Boolean(whitelist) && before.task0LoanStatus === "0"
      && funding.every(item => item.fundedForGas && (!("fundedForAward" in item) || item.fundedForAward)) && keyFiles.every(item => item.exists && item.privatePermissions),
    keyAddressesNotChecked: true, paidModelEndpointNotCalled: true, relayRequiredOnlyForLaterPurchase: true,
    sourceLocalMockAwardAndMonadAwardAreSeparateAssets: true };
  return { report, runtime };
}
function publicPlan(plan: HoldemMonadPlan) {
  const { sourceDirectory: _source, journalDirectory: _journal, ...safe } = plan;
  return safe;
}
function verifyFlow(plan: HoldemMonadPlan, before: HoldemMonadSnapshot, after: HoldemMonadSnapshot, deposited: boolean) {
  assert.equal(BigInt(before.sponsorToken) - BigInt(after.sponsorToken), HOLDEM_MONAD_REWARD, "HOLDEM_SPONSOR_FLOW_MISMATCH");
  for (const seat of seats) {
    const award = BigInt(plan.allocations[seat]);
    assert.equal(BigInt(after.walletsToken[seat]) - BigInt(before.walletsToken[seat]), deposited ? 0n : award, "HOLDEM_WALLET_FLOW_MISMATCH");
    assert.equal(BigInt(after.cash[seat]) - BigInt(before.cash[seat]), deposited ? award : 0n, "HOLDEM_CASH_FLOW_MISMATCH");
  }
  assert.equal(BigInt(after.accountToken) - BigInt(before.accountToken), deposited ? HOLDEM_MONAD_REWARD : 0n, "HOLDEM_ACCOUNT_FLOW_MISMATCH");
  assert.equal(after.providerToken, before.providerToken, "HOLDEM_PROVIDER_CHANGED_BEFORE_PURCHASE");
  assert.equal(after.totalOutstanding, before.totalOutstanding, "HOLDEM_NEW_BORROWING_REJECTED");
  assert.equal(before.task0LoanStatus, "0"); assert.equal(after.task0LoanStatus, "0");
}
async function operationEvidence(runtime: HoldemMonadRuntime, receipt: TransactionReceipt, id: string, kind: OperationEvidence["kind"], seat: Seat, amount: string): Promise<OperationEvidence> {
  const transaction = await runtime.provider.getTransaction(receipt.hash), block = await runtime.provider.getBlock(receipt.blockNumber);
  if (!transaction || receipt.status !== 1 || block?.hash !== receipt.blockHash) throw new Error("HOLDEM_CANONICAL_RECEIPT_REQUIRED");
  return { id, kind, seat, amount, txHash: receipt.hash, blockNumber: receipt.blockNumber, blockHash: receipt.blockHash, receipt: JSON.parse(json(receipt.toJSON())),
    transaction: { hash: transaction.hash, from: transaction.from, to: transaction.to!, data: transaction.data, chainId: transaction.chainId.toString(), value: transaction.value.toString(), nonce: transaction.nonce } };
}
/** This stage only transfers the fixed award and deposits it as cash. No loan, API call or inference dispatch exists here. */
export async function executeHoldemMonadDelivery(plan: HoldemMonadPlan, runtime: HoldemMonadRuntime, signers: { sponsor: Wallet; players: [Wallet, Wallet] }, recover = false) {
  if (BigInt(await runtime.provider.send("eth_chainId", [])) !== MONAD_CHAIN_ID || plan.chainId !== "10143" || plan.asset.address !== MONAD_USDC
    || plan.asset.decimals !== 6 || plan.reward !== HOLDEM_MONAD_REWARD.toString() || plan.inferencePriceRaw !== HOLDEM_MONAD_INFERENCE_PRICE.toString()) throw new Error("HOLDEM_FIXED_MONAD_BINDING_REQUIRED");
  if (await runtime.token.getAddress() !== plan.asset.address || await runtime.account.getAddress() !== plan.contracts.account
    || await runtime.manager.getAddress() !== plan.contracts.manager || signers.sponsor.address !== plan.sponsor
    || seats.some(seat => signers.players[seat].address !== plan.players[seat].wallet)) throw new Error("HOLDEM_SIGNER_CONTRACT_BINDING_MISMATCH");
  if (plan.journalDirectory !== join(plan.sourceDirectory, ".private", "monad-delivery")) throw new Error("HOLDEM_SINGLE_SOURCE_JOURNAL_REQUIRED");
  // Recheck the exact source after preflight, before any signature or transaction.
  const reportPath = join(plan.sourceDirectory, "report.json"), replayPath = join(plan.sourceDirectory, ".private", "trusted-replay.json");
  await privateLocal(reportPath); await privateLocal(replayPath);
  if (sha(await readFile(reportPath, "utf8")) !== plan.source.reportDigest) throw new Error("HOLDEM_SOURCE_CHANGED_AFTER_PLAN");
  const hand = replayHand(JSON.parse(await readFile(replayPath, "utf8"))), view = hand.view(0);
  if (view.handStatus !== "complete" || !view.result || sha(JSON.stringify(hand.exportTrustedReplay())) !== plan.source.replayDigest) throw new Error("HOLDEM_SOURCE_CHANGED_AFTER_PLAN");
  assert.deepEqual(publicResult(view.result), plan.result, "HOLDEM_PLAN_RESULT_MISMATCH");
  const allocations: [string, string] = ["0", "0"];
  for (const seat of view.result.winners) allocations[seat] = (HOLDEM_MONAD_REWARD / BigInt(view.result.winners.length)).toString();
  assert.deepEqual(plan.allocations, allocations, "HOLDEM_PLAN_ALLOCATION_MISMATCH");
  const store = new SessionStore<DeliverySession>(plan.journalDirectory); await store.start(recover);
  try {
    let saved = await store.read();
    if (saved) assert.deepEqual(saved.binding, plan, "HOLDEM_DELIVERY_BINDING_MISMATCH");
    else { saved = { version: 1, binding: plan, before: await snapshot(plan, runtime), operations: [] }; await store.write(saved); }
    const journal = new DemoJournal(runtime.provider, join(plan.journalDirectory, "transactions.json")); await journal.load();
    const send = async (kind: OperationEvidence["kind"], seat: Seat, signer: Wallet, contract: Contract, method: string, args: unknown[], amount: string) => {
      const id = opId(plan, kind, seat), to = await contract.getAddress(), data = contract.interface.encodeFunctionData(method, args);
      if (journal.has(id)) {
        const entries = JSON.parse(await readFile(journal.path, "utf8")), entry = entries[id], original = Transaction.from(entry.rawTransaction);
        if (original.from !== signer.address || original.to !== to || original.data !== data || original.chainId !== MONAD_CHAIN_ID || original.value !== 0n
          || original.hash !== entry.txHash || entry.from !== signer.address) throw new Error("HOLDEM_JOURNAL_BINDING_MISMATCH");
      }
      await journal.send(id, signer, { to, data, chainId: MONAD_CHAIN_ID, value: 0n });
      const receipt = await journal.receipt(id);
      const logs = receipt.logs.filter(log => getAddress(log.address) === to).flatMap(log => { try { const event = contract.interface.parseLog(log); return event ? [event] : []; } catch { return []; } });
      const matches = logs.filter(event => kind === "reward" ? event.name === "Transfer" && getAddress(event.args.from) === plan.sponsor && getAddress(event.args.to) === plan.players[seat].wallet && event.args[2] === BigInt(amount)
        : kind === "approve" ? event.name === "Approval" && getAddress(event.args.owner) === plan.players[seat].wallet && getAddress(event.args.spender) === plan.contracts.account && event.args[2] === BigInt(amount)
        : event.name === "CashCredited" && event.args.agentId === BigInt(plan.players[seat].agentId) && getAddress(event.args.from) === plan.players[seat].wallet && event.args.amount === BigInt(amount));
      if (matches.length !== 1) throw new Error("HOLDEM_OPERATION_EVENT_MISMATCH");
      const evidence = await operationEvidence(runtime, receipt, id, kind, seat, amount), previous = saved!.operations.find(item => item.id === id);
      if (previous) assert.deepEqual(previous, evidence, "HOLDEM_OPERATION_RECEIPT_CHANGED");
      else { saved!.operations.push(evidence); await store.write(saved!); }
    };
    for (const seat of seats) if (plan.allocations[seat] !== "0") await send("reward", seat, signers.sponsor, runtime.token, "transfer", [plan.players[seat].wallet, BigInt(plan.allocations[seat])], plan.allocations[seat]);
    if (!saved.afterAward) { saved.afterAward = await snapshot(plan, runtime); verifyFlow(plan, saved.before, saved.afterAward, false); await store.write(saved); }
    for (const seat of seats) if (plan.allocations[seat] !== "0") {
      await send("approve", seat, signers.players[seat], runtime.token, "approve", [plan.contracts.account, BigInt(plan.allocations[seat])], plan.allocations[seat]);
      await send("deposit", seat, signers.players[seat], runtime.account, "depositCash", [BigInt(plan.players[seat].agentId), BigInt(plan.allocations[seat])], plan.allocations[seat]);
    }
    if (!saved.afterDeposit) { saved.afterDeposit = await snapshot(plan, runtime); verifyFlow(plan, saved.before, saved.afterDeposit, true); await store.write(saved); }
    saved.report ??= { version: 1, mode: "holdem-monad", phase: "RewardDeposited", stageComplete: true, fullAcceptanceComplete: false,
      chainId: "10143", plan: publicPlan(plan), balances: { before: saved.before, afterAward: saved.afterAward, afterDeposit: saved.afterDeposit }, operations: saved.operations,
      verification: { trustedReplayRecomputed: true, reportDigestBound: true, replayDigestBound: true, singleSourceJournal: true, rewardConserved: true,
        awardedRaw: plan.reward, depositedRaw: plan.reward, entryFee: "0", newBorrowingRaw: "0", totalOutstandingUnchanged: true, task0LoanStatus: "0" },
      nextStage: { requiresRunningRelay: true, taskId: "0", priceRaw: plan.inferencePriceRaw, maxPurchasesPerAwardedSeat: 1 },
      sourceLocalMockAwardAndMonadAwardAreSeparateAssets: true };
    await store.write(saved); await saveJson(join(plan.sourceDirectory, "monad-delivery-report.json"), saved.report);
    return structuredClone(saved.report);
  } finally { await store.close(); }
}
export async function runHoldemMonad(config: HoldemMonadConfig, options: { execute?: boolean; recover?: boolean; rpcUrlFile?: string; rpcTransport?: RpcTransport } = {}) {
  const { plan, monadConfig } = await buildHoldemMonadPlan(config);
  const rpcUrl = options.rpcUrlFile ? await readRpcUrlFile(options.rpcUrlFile) : monadConfig.rpcUrl;
  const connection = await monadProvider(rpcUrl, options.rpcTransport ?? "direct");
  try {
    const { report, runtime } = await preflightHoldemMonad(plan, config, monadConfig, connection.provider);
    if (!options.execute) return report;
    // Keep the public preflight predicates when execution stops before any signature/journal.
    await saveJson(join(plan.sourceDirectory, "monad-preflight-report.json"), report);
    if (!report.ready) throw new Error("HOLDEM_PREFLIGHT_NOT_READY");
    const sponsor = new Wallet(await readSecret(config.sponsor.keyFile), connection.provider);
    const players = await Promise.all(config.players.map(async player => new Wallet(await readSecret(player.keyFile), connection.provider))) as [Wallet, Wallet];
    return await executeHoldemMonadDelivery(plan, runtime, { sponsor, players }, options.recover);
  } finally { connection.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  (async () => {
    const args = process.argv.slice(2), allowed = new Set(["--config", "--execute", "--recover", "--rpc-url-file", "--rpc-transport"]);
    for (let i = 0; i < args.length; i++) {
      if (!allowed.has(args[i])) throw new Error("HOLDEM_MONAD_UNKNOWN_OPTION");
      if (!["--execute", "--recover"].includes(args[i])) { if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error("HOLDEM_MONAD_OPTION_VALUE_REQUIRED"); i++; }
    }
    const value = (name: string) => { const index = args.indexOf(name); return index === -1 ? undefined : args[index + 1]; };
    const configPath = value("--config"); if (!configPath) throw new Error("HOLDEM_MONAD_CONFIG_PATH_REQUIRED");
    const transport = value("--rpc-transport") ?? "direct";
    if (!["direct", "system-https-proxy"].includes(transport)) throw new Error("INVALID_RPC_TRANSPORT");
    if (args.includes("--recover") && !args.includes("--execute")) throw new Error("HOLDEM_RECOVER_REQUIRES_EXECUTE");
    const result = await runHoldemMonad(await loadHoldemMonadConfig(configPath), { execute: args.includes("--execute"), recover: args.includes("--recover"),
      rpcUrlFile: value("--rpc-url-file"), rpcTransport: transport as RpcTransport });
    console.log(json(result));
  })().catch(error => { reportDemoFailure(error); process.exitCode = 1; });
}
