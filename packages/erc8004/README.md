# ERC-8004 工具层（P0）

`@agentfuel/erc8004` 提供 ethers v6 的 `IdentityRegistry` 与 `ReputationRegistry`，仅使用已验证的 canonical EOA 签名 profile。registry 地址和 `expectedChainId` 必须由调用方明确传入，不写死 InferCredit 合约部署地址，不加载 dotenv 或私钥，不选择网络 fallback。

## 接口

```ts
import { JsonRpcProvider, NonceManager, Wallet } from "ethers";
import { IdentityRegistry, ReputationRegistry } from "@agentfuel/erc8004";

const provider = new JsonRpcProvider(rpcUrl);
const identity = new IdentityRegistry({
  provider, address: identityRegistryAddress, expectedChainId: BigInt(chainId),
});
const reputation = new ReputationRegistry({
  provider, address: reputationRegistryAddress, expectedChainId: BigInt(chainId),
});
const ownerSigner = new NonceManager(new Wallet(ownerKey, provider));
const newWalletSigner = new Wallet(newWalletKey); // Consent can be signed offline.

const existing = await identity.readIdentity(0n); // agentId 0 is valid.
const registration = await identity.register(ownerSigner, "ipfs://agent-metadata");
const consent = await identity.signWalletConsent(newWalletSigner, registration.agentId);
await identity.bindWallet(ownerSigner, consent);

const summary = await reputation.readSummary(
  registration.agentId, [adapterAddress], "infercredit", "repayment",
);
const feedback = await reputation.readFeedback(registration.agentId, adapterAddress, 1n);
```

交易 signer 必须连接构造时同一个 provider 对象，避免读某个 RPC 状态却从另一个 RPC 发送交易。钱包同意 signer 可以是离线 EOA；若连接 provider，其 chainId 也需匹配。每次访问都核对实际 chainId 和 registry 存在代码；使用 JSON-RPC provider 时直接查询 `eth_chainId`，不信静态 network 缓存。

`readIdentity(agentId, blockTag?)` 返回 `{agentId:bigint,owner,wallet}`，owner/wallet 在同一 blockTag 读取。`register` 返回 `{agentId,owner,agentURI,receipt}`，agentId 仅从指定 registry 的成功交易回执 `Registered` 事件提取；校验 owner、URI 与唯一事件，不用 `staticCall` 预测下一 ID。

`signWalletConsent` 从链上读取当前 owner 和 `eip712Domain()`，严格核对 domain 为 `ERC8004IdentityRegistry` / `1`、当前 chainId、指定 registry。签名类型为 `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`，由新 wallet 签名；默认 deadline 为最新链上时间加 300 秒，也可显式传入 bigint。`bindWallet` 由当前 owner signer 发送；发送前复查 owner、domain、deadline 和 EOA 签名。身份转移后的旧 owner 签名被拒绝。`transferIdentity(ownerSigner,agentId,newOwner)` 使用 canonical `transferFrom`，转移会在真实 registry 中清空 wallet。

`readSummary` 要求明确且非空、不重复的 client 地址列表；返回 `{count,summaryValue,summaryValueDecimals}`，三个字段均为 bigint，保留有符号聚合值，不假定它是 sum 或 mean。信用读取应传 `[ERC8004Adapter]`，不能把其他 reporter 的反馈混入。`readFeedback` 使用 1-based uint64 index，返回有符号 `value`、bigint `valueDecimals`、tags 与 `revoked:boolean`。薄封装 `giveFeedback`、`revokeFeedback` 用调用方 signer 提交，registry 仍负责拒绝 self-feedback。

## 来源与版本范围

签名 profile 与固定区块部署的实测依据见 [day0-findings.md](/Users/jungle/Desktop/dev/agentfuel/docs/day0-findings.md) 和 [Day0Canonical.t.sol](/Users/jungle/Desktop/dev/agentfuel/contracts/spike/Day0Canonical.t.sol)。事件与函数 ABI 另核对 [官方 Identity 实现](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/IdentityRegistryUpgradeable.sol) 和 [官方 Reputation 实现](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/ReputationRegistryUpgradeable.sol)。本工具层没有复制旧项目代码，没有双签名 profile 或 ERC-1271 兼容层。

2026-10-02 查询的官方 master 对空 client 列表已有不同处理；本项目固定区块部署实际拒绝空列表。本 wrapper 始终主动要求非空列表，保证调用方明确 reporter 范围；不把最新版源码的聚合实现当成固定部署的语义保证。

## 测试与实际结果

默认离线测试不启动 Anvil，也不依赖公网：

```sh
npm test --workspace @agentfuel/erc8004
```

四项测试覆盖准确 EIP-712 编码及 owner/chain/registry 绑定、agentId 0、真实事件布局的 receipt 提取与错事件拒绝、有符号 feedback ABI，以及不合法参数/空 client 拒绝。2026-10-02 执行结果：**4 passed / 0 failed / 0 skipped**。

真实 canonical fork 验证单独显式运行，需要 `anvil` 在 PATH 和公共 RPC 可访问：

```sh
npm run test:fork --workspace @agentfuel/erc8004
```

可以设置 `ANVIL_BIN` 为本机 Anvil 路径，`MONAD_FORK_RPC` 为明确的 Monad Testnet archive RPC。默认使用 `https://testnet-rpc.monad.xyz`，固定区块 **67277702**，测试还核对 block hash `0xd4ff9cd39736b12eb5693ec964ebccd7d09f50e615d8e0a73e5f84887fe3647e`、chainId **10143**、canonical identity/reputation 连接关系。配置错误或公网不可用会失败，不静默跳过、不改区块或链。

2026-10-02 实际结果：**1 passed / 0 failed / 0 skipped**，测试 12.1 秒。该测试用 TS wrappers 在自己创建的 localhost Anvil fork 上注册 agent **1963**、读取既有 agent 0、完成钱包绑定、转移清零、旧 owner 签名的 wrapper/canonical 双重拒绝、新 owner 绑定、错误域和 chain 拒绝。两个独立 reporter 实际写入有符号反馈，分别读取过滤结果，真实拒绝空 client 列表，并撤销反馈后读到 `revoked:true` 与 count 归零。

所有写交易仅发往测试自己启动的 `127.0.0.1` Anvil，钱包为公开合成 key、余额通过 `anvil_setBalance` 注入。测试结束只停止自己的 Anvil 进程，无真实测试网注册/绑定/反馈广播。一次单独 curl 只读查询发生 SSL 连接错误；Anvil 的实际 fork 测试成功，两个结果分别记录。Arena、真实网络部署、前端和全方案是否完成不由本工具层的测试结果代替。
