# Day-0：Monad 测试网与 canonical registry 验证

核验日期：2026-10-01。用户已确定演示目标为 **Monad Testnet，chainId 10143，测试 USDC，6 位小数**。
本批完成公共 RPC 只读查询及 Foundry 本地 fork 验证；没有广播真实交易、使用用户私钥、领取代币或调用付费服务。
真实部署、推理转发和标准 x402 兼容联调尚未执行。

## 1. 网络与固定区块

[Monad 官方测试网资料](https://docs.monad.xyz/developer-essentials/testnet)列出 chainId `10143`、原生币 `MON`，以及以下公共 RPC。
[官方主网资料](https://docs.monad.xyz/developer-essentials/network-information)列出的 `143` 是主网 chainId，不能用于本次演示配置。

| 公共 RPC | 本次观察 |
| --- | --- |
| `https://testnet-rpc.monad.xyz` | `cast chain-id` 返回 `10143`；`cast block-number` 返回 `67277702`；真实只读调用及本地 fork 成功。部分直接 cast 请求发生 CONNECT tunnel 错误。 |
| `https://rpc-testnet.monadinfra.com` | `cast chain-id` 返回 `10143`，后续块、storage、call 查询发生 CONNECT tunnel 错误，未用于行为验证。 |
| `https://rpc.ankr.com/monad_testnet` | `cast chain-id` 返回 `10143`；本批未将它用于 fork。官方标注不提供 archive 支持。 |

后续查询固定在当次观测的区块，避免不同读取使用不同状态：

```text
RPC          https://testnet-rpc.monad.xyz
chainId      10143
block        67277702 (0x4029386)
block hash   0xd4ff9cd39736b12eb5693ec964ebccd7d09f50e615d8e0a73e5f84887fe3647e
timestamp    1790863877 = 2026-10-01T14:11:17Z
```

块头由只读 `eth_getBlockByNumber` 取得。`67277702` 是查询当时的最新块，重跑时的最新块自然可能不同。

## 2. Canonical 地址与实际代码

[ERC-8004 官方合约仓库的 Monad 地址表](https://github.com/erc-8004/erc-8004-contracts#monad-testnet)区分主网与测试网。
本批开始时工程文档 §3 中的 `0x8004A169…` / `0x8004BAa17…` 是该表的主网地址；在本次测试网固定区块上，两处 `eth_getCode` 均返回 `0x`。
测试网应使用下面两处地址。此次仅记录差异，没有改动部署脚本或协议合约。

| 合约 | 测试网地址 | Proxy code bytes | Proxy code keccak256 |
| --- | --- | --- | --- |
| IdentityRegistry | `0x8004A818BFB912233c491871b3d84c89A494BD9e` | 130 | `0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41` |
| ReputationRegistry | `0x8004B663056A597Dffe9eCcC1965A193B7388713` | 130 | `0xd0e45b1d89fa9b6cc7e97c1f155d64180e5c232aaccf9900ef9d4fd738c02b41` |

EIP-1967 implementation slot 的只读结果：

| Proxy | Implementation | Implementation code bytes | Code keccak256 |
| --- | --- | --- | --- |
| Identity | `0x7274e874ca62410a93bd8bf61c69d8045e399c02` | 14474 | `0xa5f9624ea85e45b3f4b8558581f03bfb3e6cefab278d7bf0500ec9bd065dc16f` |
| Reputation | `0x16e0fa7f7c56b9a767e34b192b51f921be31da34` | 10491 | `0x38602de97f1bd86f0a4729f7f3c0a78b1d27892e6eb581272cce5504a68fd00b` |

实际 `eth_call` 返回值经 `cast abi-decode` 解码：

| 调用 | 结果 |
| --- | --- |
| Identity `name()` | `AgentIdentity` |
| Identity `ownerOf(0)` | `0x0b3DD790A902D1E0F1782c2A130336B1398f68Ea` |
| Identity `getAgentWallet(0)` | 同上 |
| Identity `eip712Domain()` | fields `0x0f`；name `ERC8004IdentityRegistry`；version `1`；chainId `10143`；verifyingContract 为上述测试网 Identity；salt 全零；extensions `[]` |
| Reputation `getIdentityRegistry()` | 上述测试网 Identity 地址 |
| Reputation `getSummary(0,[0x000000000000000000000000000000000000dA70],"infercredit","repayment")` | `(uint64 0, int128 0, uint8 0)`；该地址仅为合成查询过滤器，不是项目 reporter。 |

以上包含实际调用与返回解码，不只是本地 selector 字符串对拍。

## 3. 本地 fork 的实际行为

`contracts/spike/Day0Canonical.t.sol` 在固定区块的真实 proxy/implementation 上执行。
测试仅使用 `vm.prank` 和公开的合成 fixture key；所有写入留在 Foundry 本地 EVM，没有真实链上交易或 tx hash。
结果为 **1 passed / 0 failed / 0 skipped，gas 3200972**；主 Agent 已独立在同区块复跑通过。

同一个测试实际完成并断言：

- `register(string)` 在本地 fork 注册 agentId `1963`，返回值与 `ownerOf` 一致；初始 wallet 为注册 owner。
- `setAgentWallet` 使用 EIP-712 domain `ERC8004IdentityRegistry` / `1`，链 `10143`，验证合约为测试网 Identity。类型为 `AgentWalletSet(uint256 agentId,address newWallet,address owner,uint256 deadline)`，由新 wallet 签名；使用 `now + 5 minutes` 的 deadline 绑定成功。
- `transferFrom` 后 owner 变化、wallet 清零；Adapter 实时检测身份变化。旧 owner 参与签名的绑定被拒绝，新 owner 对应签名成功；重新批准后 Adapter version 为 `2`。
- 实际 owner 及 ERC-721 approved operator 写反馈均因 `Self-feedback not allowed` 被拒绝。
- 独立部署的生产 `ERC8004Adapter` 用既有八参数 `giveFeedback` 和 500000 gas 上限写入成功；registry 的 client 是 Adapter。
- `readFeedback` 的编号 `0` 被拒绝，编号 `1` 返回 `(100,0,"infercredit","repayment",false)`。
- 另一独立 reporter 写入 `999` 后，`getSummary` 仅传 `[Adapter]` 仍返回 `(1,100,0)`；仅传该 reporter 返回 `(1,999,0)`。
- `getSummary` 传空 clients 数组实际因 `clientAddresses required` 被拒绝。

签名与行为核对来源：[Identity 实现](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/IdentityRegistryUpgradeable.sol)、[Reputation 实现](https://github.com/erc-8004/erc-8004-contracts/blob/master/contracts/ReputationRegistryUpgradeable.sol)、[ERC-8004 规范](https://eips.ethereum.org/EIPS/eip-8004)。上述成功结论来自真实 fork 调用。

发现的待对齐项：本批发现当时的 `MockReputationRegistry.getSummary` 接受空 clients 并聚合其他 reporter，与此次 canonical 行为不符。后续配置批已增加空 clients 拒绝回归；读取信用反馈显式传 `[Adapter]`；旧 Monad-Rebel 封装中的空 clients / 旧签名 fallback 不能作为本项目兼容证明。本批没有迁入 TS 或修改 mock。

## 4. 已锁定资产与付款边界

演示使用 **测试 USDC**：`0x534b2f3A21130d7a60830c2Df862319e593943A3`，金额按 `10^6` 最小单位表达。
该地址同时出现在 [Circle 官方 USDC 测试网地址表](https://developers.circle.com/stablecoins/usdc-contract-addresses#testnet)、[Monad 官方测试 token list](https://github.com/monad-crypto/token-list/blob/main/tokenlist-testnet.json)和 [Monad 官方 x402 指南](https://docs.monad.xyz/guides/x402)。
固定区块实际 `symbol()` 返回 `USDC`、`decimals()` 返回 `6`；code 长度 `1798`，keccak256 为 `0x96215e6049ed615cdc22fea7701e85458a8e51a2df3e7d45e8f9fa1d521b5a78`。

测试 MON 用于未来真实测试网交易的 gas；[Monad 官方 faucet](https://faucet.monad.xyz)和 [Circle 测试 USDC faucet](https://faucet.circle.com)均有官方入口证据，本批没有登录或领取，领取流程未验收。

[Monad 官方支付资料](https://docs.monad.xyz/tooling-and-infra/agentic-payments)说明其 hosted facilitator 支持 Monad 主网/测试网和 USDC。[官方指南](https://docs.monad.xyz/guides/x402)提供 `https://x402-facilitator.molandak.org`，要求 x402 v2，并给出 `GET /supported`、`POST /verify`、`POST /settle`。
本次仅尝试无认证只读 `GET https://x402-facilitator.molandak.org/supported`，发生 SSL 连接错误；因此只有官方支持声明，**没有现场确认支持列表或结算服务可用**。

本项目当前付款为 `AgentAccount.payProvider` 直接向 provider 转账，客户端采用自建 **402 quote → 链上付款 → receipt/tx 后重试** 路径。
这与标准 facilitator 的授权签名/付款 scheme 是不同接入过程；USDC 和 facilitator 存在不代表项目已兼容标准 x402。
标准 scheme、`verify/settle`、真实 402 重试和推理请求均留给后续联调，本批没有执行这些动作。

## 5. 重跑命令与执行边界

只读脚本只调用固定的 `eth_chainId`、`eth_blockNumber`、`eth_getBlockByNumber`、`eth_getCode`、`eth_getStorageAt`、`eth_call`。
它用 curl 传输和 cast 离线编码/解码，不加载 dotenv、wallet 或 key，也不包含提交交易入口。

```bash
cd /Users/jungle/Desktop/dev/agentfuel
python3 scripts/day0-readonly.py https://testnet-rpc.monad.xyz 67277702
```

只读工具可省略最后的区块参数，以重跑时最新块核验。RPC 不通、chainId 不符或 ABI 无法解码会直接失败，不自动改网络；其余返回值打印供核对，行为断言由 fork 测试完成。

本地 fork 测试显式启用 `spike` 目录，保持默认离线测试不依赖公网：

```bash
cd /Users/jungle/Desktop/dev/agentfuel/contracts
FOUNDRY_TEST=spike /Users/jungle/.foundry/bin/forge test \
  --match-contract Day0CanonicalTest \
  --fork-url https://testnet-rpc.monad.xyz \
  --fork-block-number 67277702 \
  --rpc-timeout 25 --compute-units-per-second 15 -vv
```

本批跑默认 `forge test --json`：**407 tests / 403 passed / 0 failed / 4 skipped，38 suites**。`spike` 不在默认 test path 内，不增加 skip 或公网依赖。

## 6. 失败与未完成项

- 直接 cast RPC 有多次 `MPP HTTP request ... client error (Connect): tunnel error: unsuccessful`；切换为原生 JSON-RPC/curl 后关键只读查询成功，Forge fork 也通过。失败没有被解释成 registry ABI 不兼容。
- Facilitator `/supported` 的 curl 请求返回 exit `35`、`SSL_ERROR_SYSCALL`；web 读取也未取得内容。没有调用 `verify/settle`。
- GitHub commit API 返回 `403 rate limit exceeded`，未取得源码 commit SHA；记录了官方源码 URL、固定链上区块、proxy/implementation code hash，未声称部署源码与当前仓库逐字相同。
- 尚未执行真实注册、钱包绑定、反馈广播、部署或 faucet 领取。此次 fork 注册 agentId 不是测试网上新增身份。
- 后续配置批已修正 Deploy 的网络默认 registry、ERC-20 显式原始单位限额和 mock 空 clients 语义；独立验收为 408 tests / 404 passed / 0 failed / 4 skipped。
- 本批没有收到并验证 Kimi/Qwen API key，也没有读取 `.env`/私钥；真实模型转发尚缺后续凭据配置与联调。

已解决的选择：目标网络与结算资产。仍待后续验收：真实网络部署、凭据、receipt 支付联调及标准 x402 scheme 兼容性。
