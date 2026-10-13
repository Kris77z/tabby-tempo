import { Contract, isError, JsonRpcProvider, keccak256, toUtf8Bytes, Wallet, ZeroAddress } from "ethers";
import { mkdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { Config } from "./config.js";
import { UINT256_MAX } from "./config.js";
import { creditTerms, principalCap } from "./rules.js";

const MANAGER_ABI = [
  "function adapter() view returns(address)", "function agentAccount() view returns(address)",
  "function taskEscrow() view returns(address)", "function underwriter() view returns(address)",
  "function settlementAsset() view returns(address)", "function MAX_LTV_BPS() view returns(uint16)",
  "function maxTotalOutstanding() view returns(uint256)", "function maxDrawPerEpoch() view returns(uint256)",
  "function drawPaused() view returns(bool)", "function protocolFrozen(uint256) view returns(bool)",
  "function repaymentCount(uint256) view returns(uint256)", "function defaultCount(uint256) view returns(uint256)",
  "function usedNonces(uint256,uint256) view returns(bool)",
  "function getLoan(uint256) view returns(tuple(uint256 agentId,uint256 principal,uint256 fee,uint256 loanDueAt,uint8 status))",
];
const ADAPTER_ABI = [
  "function identity() view returns(address)", "function reputation() view returns(address)",
  "function resolveAgent(uint256) view returns(address owner,address wallet)",
  "function snapshotVersion(uint256) view returns(uint64)", "function identityChanged(uint256) view returns(bool)",
];
const ACCOUNT_ABI = ["function settlementAsset() view returns(address)", "function protocolFrozen(uint256) view returns(bool)"];
const ESCROW_ABI = [
  "function settlementAsset() view returns(address)", "function payableEscrow(uint256) view returns(uint256)",
  "function getTask(uint256) view returns(tuple(address poster,uint256 reward,uint256 escrowBalance,uint256 agentId,uint256 deadline,uint16 protocolFeeBps,uint8 status))",
];
const REPUTATION_ABI = [
  "function getIdentityRegistry() view returns(address)",
  "function getSummary(uint256,address[],string,string) view returns(uint64 count,int128 summaryValue,uint8 summaryValueDecimals)",
];

export const AUTH_TYPES = { CreditAuthorization: [
  { name: "agentId", type: "uint256" }, { name: "taskId", type: "uint256" },
  { name: "principalCap", type: "uint256" }, { name: "feeBps", type: "uint16" },
  { name: "riskTier", type: "uint8" }, { name: "identityVersion", type: "uint64" },
  { name: "authDeadline", type: "uint256" }, { name: "loanDueAt", type: "uint256" },
  { name: "nonce", type: "uint256" }, { name: "evidenceHash", type: "bytes32" },
] };

export class Rejection extends Error {
  constructor(public code: string, message: string, public status = 409) { super(message); }
}
export const json = (value: unknown) => JSON.stringify(value, (_, v) => typeof v === "bigint" ? v.toString() : v);
const sameAddress = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
const reject = (condition: boolean, code: string, message: string) => {
  if (condition) throw new Rejection(code, message);
};

export class Underwriter {
  private readonly provider: JsonRpcProvider;
  private readonly ownsProvider: boolean;
  private readonly signer: Wallet;

  constructor(private readonly config: Config, provider?: JsonRpcProvider) {
    this.ownsProvider = provider === undefined;
    this.provider = provider ?? new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1 });
    this.signer = new Wallet(config.privateKey); // Deliberately not connected to a provider.
  }

  close() { if (this.ownsProvider) this.provider.destroy(); }

  async initialize() { await this.context(); }

  private async assertChain() {
    const chainId = BigInt(await this.provider.send("eth_chainId", []));
    reject(chainId !== this.config.chainId, "NETWORK_MISMATCH", "RPC chainId does not match CHAIN_ID");
  }

  private async context() {
    await this.assertChain();
    const block = await this.provider.getBlock("latest");
    if (!block?.hash) throw new Error("RPC did not return a block hash");
    const read = (contract: Contract, method: string, args: unknown[] = []) =>
      contract.getFunction(method).staticCall(...args, { blockTag: block.number });
    const manager = new Contract(this.config.managerAddress, MANAGER_ABI, this.provider);
    const [adapterAddress, accountAddress, escrowAddress, signerAddress, asset, ltvBps, totalLimit, epochLimit] =
      await Promise.all(["adapter", "agentAccount", "taskEscrow", "underwriter", "settlementAsset", "MAX_LTV_BPS",
        "maxTotalOutstanding", "maxDrawPerEpoch"].map(method => read(manager, method)));
    reject(!sameAddress(signerAddress, this.signer.address), "SIGNER_MISMATCH", "Key does not match Manager.underwriter");
    reject(!sameAddress(asset, this.config.settlementAsset), "ASSET_MISMATCH", "Manager settlement asset does not match configuration");
    const adapter = new Contract(adapterAddress, ADAPTER_ABI, this.provider);
    const account = new Contract(accountAddress, ACCOUNT_ABI, this.provider);
    const escrow = new Contract(escrowAddress, ESCROW_ABI, this.provider);
    const [identityAddress, reputationAddress, accountAsset, escrowAsset] = await Promise.all([
      read(adapter, "identity"), read(adapter, "reputation"), read(account, "settlementAsset"), read(escrow, "settlementAsset"),
    ]);
    const addresses: string[] = [this.config.managerAddress, adapterAddress, accountAddress, escrowAddress, identityAddress, reputationAddress];
    if (!sameAddress(asset, ZeroAddress)) addresses.push(asset);
    const codes = await Promise.all(addresses.map(address => this.provider.getCode(address, block.number)));
    reject(codes.some(code => code === "0x"), "CONTRACT_MISSING", "Protocol address has no contract code");
    reject(!sameAddress(asset, accountAsset) || !sameAddress(asset, escrowAsset), "ASSET_MISMATCH", "Protocol settlement assets differ");
    const reputation = new Contract(reputationAddress, REPUTATION_ABI, this.provider);
    const decimals = sameAddress(asset, ZeroAddress) ? 18n :
      BigInt(await read(new Contract(asset, ["function decimals() view returns(uint8)"], this.provider), "decimals"));
    reject(decimals !== BigInt(this.config.assetDecimals), "DECIMALS_MISMATCH", "Asset decimals do not match configuration");
    const registryIdentity = await read(reputation, "getIdentityRegistry");
    reject(!sameAddress(registryIdentity, identityAddress), "REGISTRY_MISMATCH", "Registry identity reference does not match Adapter");
    return {
      block, read, manager, adapter, account, escrow, reputation,
      addresses: { manager: this.config.managerAddress, adapter: adapterAddress as string, account: accountAddress as string,
        escrow: escrowAddress as string, identity: identityAddress as string, reputation: reputationAddress as string },
      configuration: { chainId: this.config.chainId, settlementAsset: asset as string, assetDecimals: decimals,
        tokenUsdPrice: this.config.tokenUsdPrice, underwriter: signerAddress as string,
        ltvBps: BigInt(ltvBps), maxTotalOutstanding: BigInt(totalLimit), maxDrawPerEpoch: BigInt(epochLimit) },
    };
  }

  private async agent(ctx: Awaited<ReturnType<Underwriter["context"]>>, agentId: bigint) {
    const { read, manager, adapter, account, reputation, addresses } = ctx;
    let identity;
    try { identity = await read(adapter, "resolveAgent", [agentId]); }
    catch (error) {
      if (isError(error, "CALL_EXCEPTION")) throw new Rejection("AGENT_NOT_FOUND", "Registry agent does not exist");
      throw error;
    }
    const [version, repayments, defaults, managerFrozen, accountFrozen, paused] = await Promise.all([
      read(adapter, "snapshotVersion", [agentId]), read(manager, "repaymentCount", [agentId]),
      read(manager, "defaultCount", [agentId]), read(manager, "protocolFrozen", [agentId]),
      read(account, "protocolFrozen", [agentId]), read(manager, "drawPaused"),
    ]);
    const identityChanged = version === 0n ? false : await read(adapter, "identityChanged", [agentId]);
    const summaries = await Promise.all(["repayment", "task-success", "default"].map(tag =>
      read(reputation, "getSummary", [agentId, [addresses.adapter], "infercredit", tag])));
    const mirror = { repayment: BigInt(summaries[0].count), success: BigInt(summaries[1].count), default: BigInt(summaries[2].count) };
    const truth = { repayment: BigInt(repayments), default: BigInt(defaults) };
    const terms = creditTerms(mirror, truth.repayment);
    const reason = truth.default > 0n ? "PROTOCOL_DEFAULT" : mirror.default > 0n ? "MIRRORED_DEFAULT" :
      version === 0n ? "NOT_ENROLLED" : identityChanged ? "IDENTITY_CHANGED" :
      sameAddress(identity.owner, ZeroAddress) || sameAddress(identity.wallet, ZeroAddress) ? "IDENTITY_UNBOUND" :
      managerFrozen || accountFrozen ? "PROTOCOL_FROZEN" : paused ? "DRAW_PAUSED" : null;
    return { agentId, identity: { owner: identity.owner as string, wallet: identity.wallet as string, version: BigInt(version), changed: Boolean(identityChanged) },
      truth, mirror, terms, managerFrozen: Boolean(managerFrozen), accountFrozen: Boolean(accountFrozen), drawPaused: Boolean(paused),
      eligible: reason === null, rejection: reason };
  }

  private async finishSnapshot(ctx: Awaited<ReturnType<Underwriter["context"]>>) {
    await this.assertChain();
    const current = await this.provider.getBlock(ctx.block.number);
    reject(current?.hash !== ctx.block.hash, "SNAPSHOT_REORG", "Snapshot block changed; retry the request");
  }

  async credit(agentId: bigint) {
    const ctx = await this.context();
    const agent = await this.agent(ctx, agentId);
    await this.finishSnapshot(ctx);
    const { tierCap } = principalCap(agent.terms.capUsdCents, this.config.assetDecimals, this.config.tokenUsdPrice, 0n, 0n, agent.terms.feeBps);
    return { ...agent, tierCap, block: { number: ctx.block.number, hash: ctx.block.hash, timestamp: ctx.block.timestamp },
      configuration: ctx.configuration, addresses: ctx.addresses };
  }

  async authorize(agentId: bigint, taskId: bigint, nonce: bigint) {
    const ctx = await this.context();
    const agent = await this.agent(ctx, agentId);
    if (agent.rejection) throw new Rejection(agent.rejection, "Agent is not eligible for credit");
    const [task, loan, nonceUsed, payableEscrow] = await Promise.all([
      ctx.read(ctx.escrow, "getTask", [taskId]), ctx.read(ctx.manager, "getLoan", [taskId]),
      ctx.read(ctx.manager, "usedNonces", [agentId, nonce]), ctx.read(ctx.escrow, "payableEscrow", [taskId]),
    ]);
    const now = BigInt(ctx.block.timestamp);
    reject(task.status !== 2n, "TASK_NOT_ASSIGNED", "Task must be Assigned");
    reject(task.agentId !== agentId, "TASK_AGENT_MISMATCH", "Task belongs to a different agent");
    reject(now >= task.deadline, "TASK_EXPIRED", "Task deadline has been reached");
    reject(nonceUsed, "NONCE_USED", "Nonce has already been consumed on chain");
    reject(loan.status !== 0n, "LOAN_EXISTS", "Task already has a loan record");
    const caps = principalCap(agent.terms.capUsdCents, this.config.assetDecimals, this.config.tokenUsdPrice,
      BigInt(payableEscrow), ctx.configuration.ltvBps, agent.terms.feeBps);
    reject(caps.principalCap === 0n, "ZERO_CAP", "Integer credit cap is zero");
    reject(caps.principalCap > UINT256_MAX, "CAP_OUT_OF_RANGE", "Credit cap exceeds uint256");
    const authDeadline = now + 1800n;
    const loanDueAt = now + 86400n < task.deadline ? now + 86400n : BigInt(task.deadline);
    await this.finishSnapshot(ctx);
    // Fixed field order, decimal strings for bigint; the exact bytes are saved and hashed.
    const evidence = json({ schema: 1, block: { number: ctx.block.number, hash: ctx.block.hash, timestamp: ctx.block.timestamp },
      configuration: ctx.configuration, addresses: ctx.addresses, agent,
      task: { taskId, poster: task.poster, reward: task.reward, escrowBalance: task.escrowBalance,
        agentId: task.agentId, deadline: task.deadline, protocolFeeBps: task.protocolFeeBps, status: task.status, payableEscrow },
      caps, nonce, authDeadline, loanDueAt });
    const evidenceHash = keccak256(toUtf8Bytes(evidence));
    const authorization = { agentId, taskId, principalCap: caps.principalCap, feeBps: agent.terms.feeBps,
      riskTier: agent.terms.riskTier, identityVersion: agent.identity.version, authDeadline, loanDueAt, nonce, evidenceHash };
    const domain = { name: "InferCredit", version: "1", chainId: this.config.chainId, verifyingContract: this.config.managerAddress };
    const signature = await this.signer.signTypedData(domain, AUTH_TYPES, authorization);
    const file = join(this.config.evidenceDir, `${evidenceHash}.json`);
    const temporary = `${file}.${randomUUID()}.tmp`;
    await mkdir(this.config.evidenceDir, { recursive: true });
    try {
      await writeFile(temporary, evidence, { flag: "wx", mode: 0o600 });
      await rename(temporary, file);
    } finally { await unlink(temporary).catch(() => {}); }
    return { authorization, signature, domain, block: { number: ctx.block.number, hash: ctx.block.hash }, evidenceHash };
  }
}
