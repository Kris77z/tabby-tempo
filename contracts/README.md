# InferCredit — contracts (Foundry)

P0 的四个合约与它们的 Foundry 测试套件。
规格来源：`../AGENT_CREDIT_ENGINEERING.md` §4（实现规格 v5.3）
与 `../AGENT_CREDIT_RISK_AND_MVP.md`（攻击面与裁剪）。

## 当前状态（2026-10-01）

四个 P0 合约已按六批实现并独立验收：基础权限与资金、无债务任务与 cash 支付、
授信与混合支付、还款结算与反馈、清算、退款回补。

```text
forge build --sizes   编译通过，四个业务合约均在大小限制内
forge test            408 tests: 404 passed / 0 failed / 4 skipped
```

原生币与 ERC-20 均已验证；三单 demo 残值为 0.058 / 0.0787 / 0.105396，
第三单 710 分升 A。4 个 skip 是原生 receiver/value 专属用例的 ERC-20 镜像及反向正例。
构建仍有静态 lint 提示，未声称零告警。

本次没有部署。Monad 测试网 canonical registry 的本地 fork 与钱包绑定签名已独立复跑通过，
见 [Day-0 核验](../docs/day0-findings.md)。最小 underwriter 的 HTTP 授权已在本地 Anvil 被真实合约消费，
USDC/native 两种资产均通过，见 [服务说明](../services/underwriter/README.md)。
relay、SDK、Arena、前端与真实广播联调尚未完成。
测试索引、历史裁决与六批验收见 [TEST_PLAN.md](./TEST_PLAN.md)。

## 快速开始

```bash
curl -L https://foundry.paradigm.xyz | bash
~/.foundry/bin/foundryup
export PATH="$PATH:$HOME/.foundry/bin"

cd contracts
forge build
forge test
forge test --match-path test/Draw.t.sol -vvv     # 单个套件
```

Solidity `^0.8.24`，solc 0.8.24，evm `cancun`，optimizer 开启（200 runs）。

## 结构

```text
src/
  ERC8004Adapter.sol    §4.1  身份快照（enroll/reapprove）+ 声誉写入
  CreditManager.sol     §4.2  vault / draw / repay / 两个清算入口 / processRefund / 全局限额
  AgentAccount.sol      §4.3  cash + credit 双余额、SpendPolicy、provider 白名单
  TaskEscrow.sol        §4.4  托管、waterfall、slashing、声誉写回
  interfaces/           结构体 / 枚举 / 事件 / custom error 的唯一定义处
                        IIdentityRegistry 与 IReputationRegistry 是
                        ERC-8004 官方 ABI 的逐字子集（见下）
  utils/                SafeTransferLib、ReentrancyGuard（手写，见下）
test/
  helpers/              部署夹具 + EIP-712 签名 + 场景组合
  mocks/                Identity / Reputation / ERC20 / 恶意接收方
  AbiConformance.t.sol  用规范里的字面签名算 selector，对拍我们的接口
  Identity.t.sol        身份转让 → 清空钱包 → 重绑定 → 重审 → 旧授权失效
  Atomicity.t.sol       支付腿失败后的全账本回滚 + 主动重入
  其余 *.t.sol          见 TEST_PLAN.md §1
script/Deploy.s.sol     四合约部署与接线（与测试 setUp 同构）
```

### ERC-8004 接口的可信来源

`IIdentityRegistry` / `IReputationRegistry` 逐字抄自
<https://eips.ethereum.org/EIPS/eip-8004>，不是就手发明的方便形状：

```solidity
setAgentWallet(uint256, address newWallet, uint256 deadline, bytes signature)
giveFeedback(uint256, int128 value, uint8 valueDecimals,
             string tag1, string tag2, string endpoint,
             string feedbackURI, bytes32 feedbackHash)
getSummary(uint256, address[] clientAddresses, string tag1, string tag2)
    returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
```

`AbiConformance.t.sol` 从规范的**签名字符串**算 selector 来对拍，
所以它不可能靠"接口和 mock 一起改"来满足。

`summaryValue` 的聚合方式被 ERC 有意留空，因此协议只消费 `count`；
mock 可在 mean / sum 之间切换以证明这一点。

**已验证**：测试网 canonical 部署的本地 fork，见 `spike/Day0Canonical.t.sol`。
固定区块与命令见 [Day-0 核验](../docs/day0-findings.md)；默认离线套件不访问 RPC。

### 为什么没有 OpenZeppelin

`forge init --no-git` 后目录不是 git 仓库，`forge install`（依赖 git submodule）
无法工作。按任务书给的退路，`SafeTransferLib` 与 `ReentrancyGuard`
保留在 `src/utils/`，使用项目需要的最小接口：

- `SafeTransferLib` 同时处理原生币与 ERC-20 两条结算路径（§3 item 3），
  并容忍 USDT 式无返回值的代币（`MockERC20.cheatSetReturnsNothing` 覆盖）。
- `ReentrancyGuard` 只提供 `nonReentrant`。§4.6 的防重入靠的是
  **调用图无环 + 资金单向 push**，锁只是兜底；
  `test_FailurePath_SettleToLiquidate_NoReentrancyDeadlock` 与
  `test_ExpireTask_WithActiveLoan_PushPath_NoDeadlock` 专门钉住
  "三个合约的锁不会互相卡死"。

后续若要接入 OZ，把这两个文件替换成 `SafeERC20` / `ReentrancyGuard` 即可，
需要同步修改调用点并重跑资金与重入测试。

## 实现边界

P0 保持四合约，没有引入公共 LP、代理升级、通用退款框架或额外服务。
权限和金额类型见 `src/interfaces/`；行为以 ENGINEERING v5.3 §4 为准。
源码已无 `NotImplemented` 业务骨架。

## 结算资产双模式

构造参数 `settlementAsset`：`address(0)` = 原生币（MON），否则是 ERC-20 地址。

- 原生币：所有入金函数 `payable` 且校验 `msg.value == amount`。
- ERC-20：校验 `msg.value == 0`，走 `approve + safeTransferFrom`。

测试默认跑原生币模式；ERC-20 覆盖通过"继承 + 覆写 `_useErc20()`"把
`Draw`、`Refund`、`TaskLifecycle`、`Atomicity`、`PartialRepayment`、`Feedback`、
清算与多层 recovery harness 复用执行，另有配对校验用例（`msg.value` 必须为 0、
无 allowance 必须失败、USDT 式无返回值代币必须被接受、分次退款的显式 amount）。

## 部署

以下命令尚未执行。脚本读取 BPS 配置时先验证 `0..10_000` 再转 uint16；
测试中的 `MAX_LTV_BPS=20_000` 不可用于该 P0 部署脚本。

测试网配置见 [`.env.monad-testnet.example`](./.env.monad-testnet.example)：
RPC 为 Monad Testnet，结算资产为 6 位测试 USDC；示例角色与私钥留空，必须先填写。
`MAX_TOTAL_OUTSTANDING=50000000` / `MAX_DRAW_PER_EPOCH=20000000` 分别表示 50 / 20 USDC。
ERC-20 模式必须显式设置两个原始单位限额；只有原生币模式才沿用 50e18 / 20e18 默认值。

`IDENTITY_REGISTRY` / `REPUTATION_REGISTRY` 按实际 chainId 选默认值：10143 为测试网，
143 为主网；其他网络必须显式提供完整地址对。任何网络都不允许只覆盖其中一个或传零地址。
广播前脚本检查两个地址有代码、Reputation 的 Identity 引用匹配。

```bash
# 填好配置并加载到环境后，先执行不广播的模拟：
forge script script/Deploy.s.sol:Deploy --rpc-url "$RPC_URL"
# 真实部署时才添加 --broadcast；本轮没有执行。
```

部署后还需要 `AgentAccount.setProviderWhitelist(relay, true)` 才能付款。

demo 部署必须把 `PROTOCOL_FEE_BPS` 设为 `0`，否则 §6.1 的三单残值
（0.058 / 0.0787 / 0.105396）对不上，见 TEST_PLAN.md F17。
