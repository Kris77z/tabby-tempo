import { BrowserProvider, Contract, ZeroAddress, ZeroHash, keccak256, toUtf8Bytes, parseUnits, type Eip1193Provider, type JsonRpcSigner } from "ethers";
import { ACCOUNT_ABI, ESCROW_ABI, TOKEN_ABI } from "./abi";
import type { PublicConfig } from "./types";
export type InjectedProvider = Eip1193Provider & {
  on?: (event: string, callback: (...args: unknown[]) => void) => void;
  removeListener?: (event: string, callback: (...args: unknown[]) => void) => void;
};
export type WalletSession = { provider: BrowserProvider; signer: JsonRpcSigner; address: string; injected: InjectedProvider };
declare global { interface Window { ethereum?: InjectedProvider } }

export async function connectWallet(config: PublicConfig, injected = window.ethereum): Promise<WalletSession> {
  if (!injected) throw new Error("未检测到 EIP-1193 钱包，请先安装或启用钱包扩展。");
  await injected.request({ method: "eth_requestAccounts" });
  const provider = new BrowserProvider(injected);
  if ((await provider.getNetwork()).chainId !== BigInt(config.chainId)) throw new Error(`请在钱包切换到 ${config.network}（chainId ${config.chainId}），再连接。`);
  const signer = await provider.getSigner();
  return { provider, signer, address: await signer.getAddress(), injected };
}
export async function assertWallet(session: WalletSession, config: PublicConfig, requiredWallet?: string) {
  const liveChain = BigInt(await session.injected.request({ method: "eth_chainId" }));
  if (liveChain !== BigInt(config.chainId)) throw new Error(`钱包网络已变化，请连接 ${config.network}。`);
  const accounts = await session.injected.request({ method: "eth_accounts" }) as string[];
  if (!accounts.some(a => a.toLowerCase() === session.address.toLowerCase())) throw new Error("钱包账号已变化，请重新连接。");
  if (requiredWallet && session.address.toLowerCase() !== requiredWallet.toLowerCase()) throw new Error("当前钱包与该 Agent 的 registry wallet 不一致。");
}
async function ensureApproval(session: WalletSession, config: PublicConfig, spender: string, value: bigint, report: (message: string) => void) {
  if (config.asset.address === ZeroAddress) return;
  const token = new Contract(config.asset.address, TOKEN_ABI, session.signer);
  const allowed: bigint = await token.getFunction("allowance").staticCall(session.address, spender);
  if (allowed < value) {
    report(`等待钱包授权 ${config.asset.symbol}（仅本次金额）。`);
    const approval = await token.getFunction("approve")(spender, value);
    const receipt = await approval.wait();
    if (!receipt || receipt.status !== 1) throw new Error("资产授权未确认。");
  }
}
export async function createTask(session: WalletSession, config: PublicConfig, reward: string, deadline: number, report: (message: string) => void) {
  await assertWallet(session, config);
  const value = parseUnits(reward, config.asset.decimals);
  if (value <= 0n) throw new Error("reward 必须大于零。");
  if (!Number.isSafeInteger(deadline) || deadline <= Date.now() / 1000) throw new Error("任务期限必须晚于当前时间。");
  await ensureApproval(session, config, config.contracts.escrow, value, report);
  report("等待钱包签名 createTask。");
  const escrow = new Contract(config.contracts.escrow, ESCROW_ABI, session.signer);
  const tx = await escrow.getFunction("createTask")(value, deadline, { value: config.asset.address === ZeroAddress ? value : 0n });
  report(`createTask 已提交：${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("创建任务交易未确认。");
  const created = receipt.logs.map((log: { topics: string[]; data: string }) => { try { return escrow.interface.parseLog(log); } catch { return null; } }).find((log: { name: string } | null) => log?.name === "TaskCreated");
  if (!created) throw new Error("交易中没有 TaskCreated 事件。");
  return { hash: tx.hash as string, taskId: String(created.args.taskId) };
}
export async function acceptTask(session: WalletSession, config: PublicConfig, taskId: string, agentId: string, wallet: string, report: (message: string) => void) {
  await assertWallet(session, config, wallet);
  if (!/^[1-9]\d*$/.test(taskId)) throw new Error("taskId 必须是正整数字符串。");
  report("等待钱包签名 acceptTask。");
  const tx = await new Contract(config.contracts.escrow, ESCROW_ABI, session.signer).getFunction("acceptTask")(taskId, agentId);
  report(`acceptTask 已提交：${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("接受任务交易未确认。");
  return { hash: tx.hash as string, taskId };
}
export async function depositCash(session: WalletSession, config: PublicConfig, agentId: string, input: string, report: (message: string) => void) {
  await assertWallet(session, config);
  const value = parseUnits(input, config.asset.decimals);
  if (value <= 0n) throw new Error("cash 金额必须大于零。");
  await ensureApproval(session, config, config.contracts.account, value, report);
  report("等待钱包签名 depositCash。");
  const tx = await new Contract(config.contracts.account, ACCOUNT_ABI, session.signer).getFunction("depositCash")(agentId, value, { value: config.asset.address === ZeroAddress ? value : 0n });
  report(`depositCash 已提交：${tx.hash}`);
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) throw new Error("cash 入金交易未确认。");
  return { hash: tx.hash as string };
}
export async function probeSpendRejection(session: WalletSession, config: PublicConfig, agentId: string, wallet: string, target: string) {
  await assertWallet(session, config, wallet);
  const account = new Contract(config.contracts.account, ACCOUNT_ABI, session.signer);
  if (await account.getFunction("providerWhitelist").staticCall(target)) throw new Error("该地址已在白名单，请换一个目标地址。");
  const auth = { agentId, taskId: "0", principalCap: "0", feeBps: 0, riskTier: 0, identityVersion: 0,
    authDeadline: 0, loanDueAt: 0, nonce: 0, evidenceHash: ZeroHash };
  // A real EVM execution, with the same caller/contract/ABI as a transaction. No broadcast or fabricated error.
  await account.getFunction("payProvider").staticCall(agentId, target, 1n, keccak256(toUtf8Bytes(crypto.randomUUID())), auth, "0x");
  throw new Error("链上调用未拒绝，请核对部署版本与目标白名单。");
}
