# InferCredit — Agent Credit 参考架构与 ERC-8004 集成方案

> **Tempo 独立迁移（2026-10-12）**：本目录目标网络为 Tempo Moderato 42431，PathUSD 结算和手续费。产品保留 10-12 双模型、任务额度包、同任务续跑和有界 Pi 自主能力；下文的 Monad/USDC 验收是源项目历史。Tempo 运行与独立链上结论以 [Tempo 运行说明](docs/tempo-runtime.md) 和本目录的新证据为准。

## 当前产品主线（2026-10-11 确认）

**AgentFuel 让用户创建的托管 Agent，在预算内采购模型与能力、执行任务赚取收入，并把可核验的履约信誉转化为后续任务的信用条件。** InferCredit 是其中的任务信用机制。核心痛点是：Agent 有任务、有交付能力，却需要先支付推理等执行成本，收入要等验收后才能收到；有资金的 Agent 同样可以直接购买推理并接单。

Agent 的身份与它在某个任务中的角色分开。同一个 Agent 可以在任务 A 中接单，在任务 B 中作为发布者采购专家服务；用户是它的 owner。当前 Demo 主角是平台创建的托管执行 Agent，接取平台提供的任务、购买推理并交付。合约已有发布与接单机制，但面向用户的自主发布子任务、发现/雇佣专家 Agent 和多级委托尚未实现，不能把 Agora Mesh 的完整服务市场视为已迁入。

### 六项核心能力

| 能力 | 在闭环中的作用 | 当前实现与 Demo 边界 |
| --- | --- | --- |
| 信誉 | 让履约记录成为评分与后续交易条件的依据 | ERC-8004 反馈与 InferScore/Tier 已接入；当前评分使用成功、还款、违约记录，影响额度/费用，不是通用智能评分，也不能单凭高分无条件借款。 |
| 借贷 | 补足交付前的推理购买资金 | 已实现具体任务的 USDC 信用、报酬托管保障、直接支付白名单 Provider、结算还本付费。每任务一次提款；借款不是任意可提取余额。按量借入推理额度与中途自动补额续跑属于后续扩展。 |
| 游戏赚 token / 资金 | 提供另一条运行资源补充路径 | 免费德州可奖励测试 USDC 或 Agent 专属推理 token 额度；四种练习游戏使用虚拟筹码、不发真实奖励。游戏不借贷，游戏奖励不伪装成任务还款或信用升级。 |
| 模型 LLM 统一网关 | 统一采购入口，并表达不同模型的不同成本 | Magpie 承担模型网关，Relay 提供模型/服务档位报价；Demo 范围限定两个底层 LLM，不扩展为全模型市场。已有真实 Magpie → K2.6 固定价链路、K3 工具验证；两模型同时通过托管入口与 Magpie 的联合部署仍需单独验收。 |
| 执行与验收任务 | 将报酬与真实交付绑定 | 已支持平台任务选择、接单、固定价求解、独立 Arena 隐藏测试与结算；Pi 自测不能替代独立验收。 |
| Agent 自主决策（Pi） | 在授权边界内推进交付 | Pi 已可生成解答、调用公开测试工具并按反馈修正，受到轮数、工具和预算限制；选单/选档是配置规则驱动，下一轮需用户发起；目标驱动的接单/选模型/补资决策与连续运行尚未落地，不宣称模型已自主经营、任意委派或自行放宽资金权限。 |

### 完整闭环与演示顺序

**创建托管 Agent → 完成链上开户并设置模型、策略和预算 → 准备运行资源 → 接取有报酬托管的任务 → 按报价购买推理（现金不足时申请任务信用）→ Pi 执行并提交 → 独立验收 → 收入结算、偿还本金与费用、更新信誉 → 下一单。**

游戏奖励是资源补充支路，可以先参赛获取测试资金，也可以在任务之间补充资源；不是每个任务的必经步骤。奖励资金已经可以支持后续推理购买；奖励 token 当前按 Agent 记账、按实际 usage 消费，托管工作台已支持用 Kimi K2.6 奖励额度执行目录任务，额度不足可参赛补充后恢复原任务；尚未与信用购买和其它模型统一为一套按量钱包。

黑客松主张是 **“Reputation you can spend.”：让 Agent 的可验证履约信誉参与执行信用决策，用已托管的未来任务报酬支持当下推理成本。** 主演示展示现金不足 → 授信购买 → Pi 交付 → 独立验收 → 还款/信誉变化 → 下一单；游戏展示资源来源，两个模型展示报价与执行选择，二者围绕同一 Agent 账户展开。

### 术语与范围约定

- “借报酬”指由任务托管报酬支持的执行资金预支；“借 token”指拟扩展的推理使用额度，不是借入/交易 LLM token 代币，也不承诺补充 Claude Code 等订阅配额。后者应单独定义额度预留、计价、偿还与恢复，再实现验收；不能把游戏奖励额度当作借贷完成证据。
- 不同模型/档位报价、上游实际 token usage/账单、借贷费用分别展示。当前任务购买的是固定价求解服务 B，按 token 储值包 A 与逐轮续费仍属扩展。
- 产品入口采用平台托管 Agent；不要求外部 Agent 接入。当前产品不提供 gas 赞助，已有可选工程能力不作为宣传或演示前提。
- 本节固定产品主线，不扩大任何既有验收结论。下文保留原架构与研究记录；实现状态以 [状态表](docs/implementation-status.md)、[工程计划](AGENT_CREDIT_ENGINEERING.md) 与各项验收证据为准。

> **2026-10-11 核心实现续批**：游戏奖励额度已接入托管 Pi 任务与独立验收；支持额度不足暂停、参赛补额和原任务恢复。当前绑定 Kimi K2.6，按量 token 借贷、两模型统一网关联合验证及 Pi 连续经营决策仍待完成。详见 [实现状态](docs/implementation-status.md)。

> **2026-10-07 产品定位补充**：用户在平台创建和管理托管 Agent，平台负责执行与钱包保管；不要求用户部署外部 Agent。新增 owner/session/Agent/预算调度层，继续共用四合约；Arena 可按链上实际接单者验签，游戏对手首版仍是平台 bot。见 [托管后端交付与边界](docs/hosted-acceptance.md)。公共 LP、外部 Agent API 和多手赛事不是此路径前置条件。

> Working Capital Infrastructure for Autonomous AI Agents

**项目内部代号：AgentFuel**  
**当前工作名：InferCredit**  
**目标网络：Monad**  
**目标赛事：Monad Metropolis Hackathon**

> **P0 开工口径（2026-10-01）**：本文保留长期架构和 benchmark 研究。
> 当前实现以 `AGENT_CREDIT_ENGINEERING.md` v5.3 §4 与 `contracts/TEST_PLAN.md` 为准。
> P0 只有 CreditManager、AgentAccount、TaskEscrow、ERC8004Adapter 四个合约；
> 13 合约拆分、公共 LP/Senior–Junior、独立 RevenueRouter、循环授信属于后续设计。
> P0 是有托管任务 reward 保障的营运资金预支：agent 不另交足额抵押，不等于协议池子无保障。
> 正常 I6/LTV 与完整 escrow 下，失败先扣 agent cash，再扣 poster escrow，池子信用损失层不可达。
> 2026-10-05 状态：四个 P0 合约本地实现已验收（408 项：404 通过、0 失败、4 跳过），Monad 原演示和追加的 Task11 真实 Magpie/Kimi/Pi 信用结算均已验收。五子棋真实模型终局使用本地现金结算。GameFi 已增加本机网页真实德州、4096 Kimi 额度发行/消费与持久恢复（见文末）；本文件长期架构尚未全部实现。
> 当前证据见 [工程状态](docs/implementation-status.md)，后续优先级见 [风险文档 §9](AGENT_CREDIT_RISK_AND_MVP.md#9-下一阶段推进顺序2026-10-04评估)。文中外部生态事实为研究时记录，不代替当前验证。

---

# 1. 文档目标

InferCredit 的核心问题是：

> **AI Agent 在赚钱之前，也需要先支付推理、数据、API 和其他 Agent 服务费用。**

传统 Agent Payment 解决的是：

```text
Agent 有钱
→ 如何支付
```

InferCredit 希望解决的是：

```text
Agent 没钱
→ 为什么有人愿意先给它钱
→ 这笔钱只能花在哪里
→ 如何判断它能否偿还
→ 如何自动回收资金
→ 如何形成长期信用
```

因此整个系统需要同时解决五件事：

```text
Identity
+
Reputation
+
Underwriting
+
Credit
+
Settlement
```

本文重点回答两个问题：

1. 现有开源项目哪些值得 InferCredit 借鉴？
2. ERC-8004 是否应该成为 InferCredit 的 Agent Identity / Reputation 基础设施？

最终结论：

# 应该使用 ERC-8004。

但 ERC-8004 不承担借贷协议。

更准确的分工应该是：

```text
ERC-8004
=
Who is this Agent?
What has this Agent done?
Can its work be trusted?

InferCredit
=
Should we finance this Agent for this Task?
How much?
Under what conditions?
How do we get repaid?
```

---

# 2. 核心架构判断

InferCredit 不应该 Fork 一个传统 DeFi Lending Protocol，然后把：

```text
User
```

改名成：

```text
Agent
```

这没有意义。

我们真正需要构建的是：

# Agent-native Working Capital Protocol

传统 DeFi：

```text
Collateral
    ↓
Oracle
    ↓
LTV
    ↓
Borrow
    ↓
Liquidation
```

InferCredit：

```text
Agent Identity
      +
Reputation
      +
Task
      +
Escrowed Reward
      +
Historical Revenue
      +
Compute Requirement
      +
Owner Backstop
      ↓
Underwriting
      ↓
Credit Limit
      ↓
Purpose-bound Spending
      ↓
Work
      ↓
Revenue
      ↓
Automatic Repayment
```

所以真正的新东西不是 Lending Pool。

而是：

# Agent × Task × Compute Underwriting

---

# 3. Benchmark Landscape

目前最值得研究的项目可以分为六类。

| 项目 | 核心能力 | InferCredit 借鉴内容 | 是否直接 Fork |
|---|---|---|---|
| Agent Fuel | Agent Vault + Spend Policy + Reputation + x402 | Spending Control | 部分思想/SDK |
| Fianza | Revenue-backed Agent Credit | Credit Engine / Auto Draw / Anti-Sybil | 不直接 Fork |
| Goldfinch | Undercollateralized Credit | CreditLine / First-loss / Waterfall | 借鉴架构 |
| Aave V3 | Overcollateralized Lending + Credit Delegation | Owner-backed Credit | Adapter / 借鉴 |
| Morpho Blue | Isolated Lending Markets | Risk Isolation | 借鉴市场设计 |
| ERC-8004 | Agent Identity / Reputation / Validation | Financial Identity Layer | **直接集成** |
| Token Arena (jiqiren.ai) | Agent 竞技赚 Token（"Battle for Tokens"） | Arena 产品形态 / Earn 场景 | 场景参考 |
| Tutti | 多 Agent 协作工作台 + 任务编排（Apache-2.0） | Agent 任务编排 / Demo 工程 | 工程参考 |

> **许可说明**：Agent Fuel 为 **Apache-2.0**，可依法复用其实现思路与代码，
> 复用时保留 LICENSE 与 attribution（NOTICE / 文件头注释）。Tutti 同为 Apache-2.0。

最终：

```text
Agent Fuel
        ↓
Spending Control

Fianza
        ↓
Revenue Credit

Goldfinch / Aave / Morpho
        ↓
Capital Architecture

ERC-8004
        ↓
Identity + Reputation + Validation

InferCredit
        ↓
Task-backed Working Capital
```

---

# 4. Agent Fuel：最值得参考的 Spending Layer

Agent Fuel 当前定位是：

> x402-native credit and reputation layer for autonomous agents。

它已经实现：

- USDC Agent Vault
- Owner / Agent 权限分离
- Per-transaction limit
- Per-hour limit
- Lifetime limit
- Service whitelist
- Emergency freeze
- Reputation
- x402 SDK
- Service Registry

其支付流程大致是：

```text
Agent
  ↓
Request API
  ↓
402 Payment Required
  ↓
Agent Fuel SDK
  ↓
Spend Policy Check
  ↓
Vault Spend
  ↓
USDC Payment
  ↓
API Response
```

这些限制由链上程序执行，而不是简单放在前端。Agent Fuel 同时根据 volume、consistency、diversity、longevity 和 disputes 等因素形成 Agent reputation。

---

# 5. Agent Fuel 最值得 InferCredit 复用的设计

## 5.1 Owner / Agent 权限隔离

Agent 不应该拥有资金账户的全部权限。

建议：

```text
Owner
├── Fund
├── Configure Policy
├── Freeze
├── Revoke Agent
└── Configure Backstop

Agent
├── Request Service
├── Spend
├── Accept Task
├── Execute Task
└── Receive Revenue

InferCredit
├── Set Credit Limit
├── Draw Credit
├── Repay Debt
├── Restrict Credit Usage
└── Freeze Credit
```

这是比普通：

```text
Wallet + Private Key
```

安全得多的模型。

---

# 6. SpendPolicy

建议 InferCredit 独立设计：

```text
SpendPolicy.sol
```

至少包含：

```solidity
struct SpendingPolicy {

    uint256 maxPerTx;

    uint256 maxPerHour;

    uint256 maxPerDay;

    uint256 maxLifetime;

    uint256 maxDebtPerTx;

    uint256 maxDebtPerDay;

    bool frozen;
}
```

同时维护：

```text
providerWhitelist

serviceCategoryWhitelist

modelWhitelist
```

这里需要特别区分：

```text
Cash Spending
```

和：

```text
Credit Spending
```

例如：

```text
Agent 自己的钱

Max per tx
$10
```

但是：

```text
借来的钱

Max per tx
$0.50
```

原因非常简单：

> 花自己的钱与花 LP 的钱风险完全不同。

---

# 7. 双余额模型

InferCredit Agent Account 建议表现为：

```text
Alice Coding Agent

Cash Balance
$0.04

Credit Limit
$1.20

Outstanding Debt
$0.32

Available Credit
$0.88

────────────────

Total Spending Power
$0.92
```

Agent 请求：

```text
Kimi API

Estimated Cost
$0.10
```

系统自动：

```text
Cash
$0.04

Credit Draw
$0.06
```

Provider 最终收到：

```text
$0.10
```

Agent Debt：

```text
+$0.06
```

但 Agent 本身无需理解：

```text
borrow()
```

这个概念。

---

# 8. Credit-aware x402

Agent Fuel 最值得借鉴的第二个东西是 SDK。

InferCredit 应该把它升级成：

# Credit-aware x402 Client

流程：

```text
Agent
  ↓
GET /resource
  ↓
HTTP 402
  ↓
Parse payment requirement
  ↓
Estimate cost
  ↓
Check Cash
  ↓
Cash enough?
  │
  ├── YES ─────────────┐
  │                    │
  └── NO               │
       ↓               │
 Check Credit          │
       ↓               │
 Eligible?             │
       │               │
 ┌─────┴─────┐         │
 YES         NO        │
 │            │        │
Draw Credit   Fail     │
 │                     │
 └──────────┬──────────┘
            ↓
      Spend Policy
            ↓
       x402 Payment
            ↓
       API Response
```

Developer 最终只需要：

```typescript
const result = await infer.fetch(url)
```

不需要：

```text
borrow()
approve()
pay()
settle()
```

全部自动化。

---

# 9. Agent Fuel 的局限

Agent Fuel 虽然使用：

```text
Credit Vault
```

这个词，但它当前更接近：

# Programmable Spending Account

核心逻辑依然是：

```text
Owner
↓
Fund Vault
↓
Agent Spend
```

而不是完整：

```text
Lender
↓
Liquidity Pool
↓
Credit Underwriting
↓
Borrow
↓
Debt
↓
Interest
↓
Repayment
```

因此：

```text
Agent Fuel
=
How can an Agent safely spend money?
```

而 InferCredit 要回答：

```text
Who gives the Agent money
when it doesn't have any?
```

---

# 10. Fianza：目前最接近 InferCredit 的竞争参考

Fianza 已经把事情推进到了更深的一层：

# Revenue-backed Agent Credit

其模型是：

```text
Agent Revenue
       ↓
Indexer
       ↓
Anti-Sybil / Independence
       ↓
Underwriter
       ↓
Credit Score
       ↓
Credit Line
       ↓
Isolated Lending Vault
       ↓
Borrow
```

Fianza 当前已经实现：

- AI Agent 无抵押信用
- 基于真实 x402 Revenue 授信
- isolated Agent lending vault
- Agent autonomous borrow / repay
- `payWithCredit()`
- Revenue Independence 检测
- Fund-flow loop 检测
- x402 自动补充支付差额

其 MVP 已在 Stellar testnet 跑通完整的 earn → underwrite → borrow → repay → default 流程。

这是我们必须认真研究的项目。

---

# 11. Fianza 对我们的最大启示

以前我们可能认为：

```text
Revenue-backed Agent Lending
```

本身就是足够大的创新。

现在不够了。

Fianza 已经做了。

所以 InferCredit 必须进一步向前：

# Work-backed Credit

Fianza：

```text
Past Revenue
     ↓
Underwriting
     ↓
Future Credit
```

InferCredit：

```text
Future Task
     +
Escrowed Reward
     +
Agent Reputation
     +
Expected Compute Cost
     +
Success Probability
     ↓
Underwriting
     ↓
Just-in-time Working Capital
```

这是非常关键的区别。

---

# 12. InferCredit 的真正核心：Task-backed Credit

例如：

```text
Task

Fix repository bug

Reward:
$5.00

Reward Escrowed:
YES
```

Agent：

```text
InferScore
742

Coding Success Rate
93%

Repayment Rate
100%
```

系统预计：

```text
Compute Cost
$0.28

Worst Case Compute
$0.40
```

那么：

```text
Expected Revenue

$5 × 93%
=
$4.65
```

再经过 haircut：

```text
$4.65 × 50%
=
$2.325
```

协议最终可能批准：

```text
Task Credit

$0.40
```

这笔钱不是基于：

```text
ETH collateral
```

也不是纯粹：

```text
Past Revenue
```

而是：

# Future Work

---

# 13. 这是什么金融产品？

它更接近：

```text
Working Capital
```

+

```text
Invoice Financing
```

+

```text
Purchase Order Financing
```

+

```text
Revenue-based Financing
```

AI Agent 接到一个确定存在的订单：

```text
Task
```

并且：

```text
Reward 已锁定
```

只是缺少完成订单需要的生产成本：

```text
Compute
API
Data
Other Agents
```

InferCredit 为这个生产过程提供：

# Working Capital

---

# 14. Goldfinch：最值得借鉴的 Credit Architecture

Goldfinch 的价值不是：

```text
把代码 Fork 过来
```

而是它已经验证了一套非常适合 InferCredit 的金融架构：

```text
Borrower
+
CreditLine
+
Borrower Pool
+
Junior Capital
+
Senior Capital
```

Goldfinch 的 TranchedPool 包含 CreditLine，并通过 Senior / Junior tranche 实现风险 waterfall；Junior capital 先承担风险，再引入 Senior liquidity。

这个模型非常适合我们。

---

# 15. InferCredit 的 First-loss Architecture

> 本节是 P1+ 的分层风险资本设计，不是 P0 已开放的资金池产品。
> P0 使用 treasury 管理的协议自有 vault，backstop 独立记账且不可贷出；
> 清算顺序为 agent cash → poster escrow（仅补剩余本金+fee）→ backstop → 池子剩余损失。
> 在 MAX_LTV_BPS ≤100%、任务费用快照固定、escrow 完整和正常资产条件下，后两层不会实际承担损失。
> 不能据下方长期示例宣称 P0 的公共 LP 正在承担无抵押信用风险。

建议：

```text
Loss
 ↓
Agent / Owner Backstop
 ↓
Protocol Reserve
 ↓
Junior Risk Capital
 ↓
Senior LP
```

例如：

```text
Credit
$1.00

Owner Backstop
$0.20

Protocol Risk Reserve
$0.10

Junior
$0.20

Senior LP Exposure
$0.50
```

早期可以简化成：

```text
Backstop
+
LiquidityVault
```

暂时不真正拆 Senior / Junior。

但协议架构预留。

---

# 16. Aave：Owner-backed Credit

Aave V3 有一个特别适合我们第一阶段的能力：

# Credit Delegation

Delegator 可以通过：

```text
approveDelegation()
```

把某个 Debt Token 的 borrowing allowance 授权给 Delegatee；Delegatee 在 borrow 时把 delegator 作为 `onBehalfOf` 使用。

这非常适合 InferCredit 的：

# Level 1 Credit

即：

```text
Human Owner
↓
Provide Collateral / Backstop
↓
Delegate Credit
↓
Agent Spend
```

但它的问题也很明显：

> 信用属于 Owner，不属于 Agent。

所以我们应该把它视为 Bootstrap。

---

# 17. InferCredit 信用进化

建议分四个等级。

## Level 0 — Prepaid

```text
Agent Credit
$0
```

只能：

```text
Deposit → Spend
```

---

## Level 1 — Owner-backed

```text
Owner Backstop
$10

Agent Credit
$5
```

本质：

```text
Secured Agent Credit Card
```

---

## Level 2 — Task-backed

```text
Escrowed Task Reward
+
Task Probability
+
Agent Reputation
```

形成：

```text
Task-specific Credit
```

---

## Level 3 — Revenue-backed

根据：

```text
30d Revenue

Repayment

Task History

Counterparty Diversity
```

提供：

```text
Revolving Credit Line
```

---

## Level 4 — Agent-native Credit

最终：

```text
Agent Identity
+
Long-term Revenue
+
Task Track Record
+
Repayment History
+
Economic Graph
```

Agent 可以在没有 Owner Backstop 的情况下获得资本。

这才是真正的：

# Autonomous Agent Credit

---

# 18. Morpho Blue：Risk Isolation

Morpho Blue 的市场由五个参数定义：

```text
Loan Asset

Collateral Asset

Oracle

IRM

LLTV
```

并且每个市场风险独立。

InferCredit 不需要直接使用：

```text
LLTV
```

但非常应该借鉴：

# Isolated Risk Markets

未来：

```text
Coding Agent Credit Pool

Research Agent Credit Pool

Trading Agent Credit Pool

Commerce Agent Credit Pool
```

甚至：

```text
Task-backed Pool

Revenue-backed Pool

Owner-backed Pool
```

风险完全不同。

不能全部：

```text
混在一个 lending pool
```

---

# 19. ERC-8004 是否应该使用？

结论：

# 强烈建议使用。

而且不是为了 Hackathon 拼一个 ERC Logo。

ERC-8004 与 InferCredit 天然互补。

截至 2026-09-13，ERC-8004 仍是 **Draft Standards Track ERC**，定义的核心正是：

- Identity Registry
- Reputation Registry
- Validation Registry

并明确说明 Payment 本身属于协议之外的 orthogonal layer。

这句话其实对 InferCredit 极其有利。

可以理解成：

```text
ERC-8004
解决 Trust

x402
解决 Payment

InferCredit
解决 Credit
```

组合起来：

```text
Identity
  ↓
Trust
  ↓
Credit
  ↓
Payment
  ↓
Work
```

---

# 20. ERC-8004 在 InferCredit 中的定位

不要：

```text
InferCredit = ERC-8004
```

正确关系：

```text
                    InferCredit

                        │
       ┌────────────────┼────────────────┐
       │                │                │
       ▼                ▼                ▼
   Identity        Reputation       Validation
       │                │                │
       └──────────── ERC-8004 ───────────┘

                        │
                        ▼

              InferCredit Risk Engine

                        │
                        ▼

                 CreditManager

                        │
                        ▼

                LiquidityVault
```

---

# 21. Identity Registry

ERC-8004 Identity Registry 基于 ERC-721。

Agent 拥有：

```text
agentRegistry

+

agentId
```

共同组成全局身份。标准允许 Agent Registration File 描述：

```text
name

description

services

MCP endpoint

A2A endpoint

supportedTrust

x402Support
``` 


所以 InferCredit 不需要再创造：

```text
InferCreditAgentNFT
```

这种重复身份标准。

直接：

# ERC-8004 Agent ID

作为整个协议主键。

---

# 22. Agent Wallet

ERC-8004 当前规范已经提供：

```solidity
getAgentWallet(agentId)

setAgentWallet(
    agentId,
    newWallet,
    deadline,
    signature
)

unsetAgentWallet(agentId)
```

更换 Agent Wallet 需要新钱包通过 EIP-712 / ERC-1271 证明控制权。

这和 InferCredit 非常重要。

因为：

```text
Identity
```

不应该：

```text
= Wallet
```

Wallet 可以轮换。

Agent Identity 应该长期存在。

---

# 23. 你们 Monad-Rebel 已经实现了这部分

这部分基本不需要重新研究。

`Monad-Rebel/shared/src/erc8004.ts` 已经实现：

```text
registerAgentOnIdentityRegistry()

setAgentWalletOnIdentityRegistry()
```

而且兼容：

```text
ERC-8004 v1.1 EIP-712 signature

+

legacy signature profile
```

代码中已经封装：

```text
register(agentURI)

ownerOf(agentId)

getAgentWallet(agentId)

setAgentWallet(...)
```



Hunter 启动时也已经存在：

```text
registerHunterIdentityOnChain()
```

会自动：

```text
register identity

↓

取得 agentId

↓

绑定 Agent Wallet

↓

记录 transaction hash
```



所以 InferCredit 完全可以把这部分直接抽成：

```text
packages/erc8004
```

继续复用。

---

# 24. Reputation Registry

这是 ERC-8004 对 InferCredit 最有价值的一部分。

标准允许任何 Client：

```text
giveFeedback()
```

向 Agent 发布：

```text
value

valueDecimals

tag1

tag2

endpoint

feedbackURI

feedbackHash
```

并且官方规范本身已经举例：

```text
successRate

revenues

uptime

responseTime
```

这些 reputation signals。

这意味着：

# Financial Reputation

完全符合 ERC-8004 的设计方向。

---

# 25. InferCredit Reputation Schema

建议制定自己的 Tag Convention。

例如：

## Repayment

```text
tag1:
infercredit

tag2:
repayment
```

value：

```text
100
```

表示成功偿还。

---

## Default

```text
tag1:
infercredit

tag2:
default
```

```text
value:
1
```

---

## Task Success

```text
tag1:
infercredit

tag2:
task-success
```

```text
100
```

或：

```text
0
```

---

## Revenue

```text
tag1:
infercredit

tag2:
verified-revenue-usd
```

例如：

```text
value:
12534

valueDecimals:
2
```

即：

```text
$125.34
```

---

## Compute Efficiency

```text
tag1:
infercredit

tag2:
compute-roi
```

例如：

```text
800

valueDecimals:
2
```

表示：

```text
8.00x
```

---

# 26. Monad-Rebel 的 Reputation 实现也可以直接复用

你们已经有：

```text
giveOnchainFeedback()
```

以及：

```text
readOnchainReputationSummary()
```

底层直接调用 ERC-8004：

```solidity
giveFeedback(...)
```

和：

```solidity
getSummary(...)
```



所以建议：

```text
Monad-Rebel
shared/src/erc8004-reputation.ts
```

直接演进成：

```text
packages/erc8004/src/reputation.ts
```

然后增加 InferCredit 的：

```text
tag conventions
```

即可。

---

# 27. 一个重要安全点

不能：

```text
读取 ERC-8004 所有 Reputation
↓
简单求平均
↓
InferScore
```

这是危险的。

ERC-8004 官方规范自己明确提醒：

```text
Sybil / Spam
```

风险。

复杂 reputation aggregation 应该放到 Off-chain scoring system，而不是简单信任所有 reviewer。

所以必须存在：

# Trusted Attestor Set

例如：

```text
InferCredit Protocol

TaskEscrow

Arena Verifier

Approved x402 Providers

Partner Marketplaces
```

只有这些地址产生的：

```text
Financial Reputation
```

进入核心 Underwriting。

其他 reputation 只能作为弱信号。

---

# 28. ERC-8004 不是 Credit Score

特别重要：

不要把：

```text
ERC-8004 Reputation
```

等同于：

```text
InferScore
```

应该：

```text
ERC-8004
=
Raw Verifiable Signals
```

而：

```text
InferScore
=
Risk Model Output
```

即：

```text
ERC-8004 Signals
       +
Task Data
       +
Revenue Graph
       +
Repayment History
       +
Compute History
       +
Sybil Detection
       ↓
Risk Engine
       ↓
InferScore
```

---

# 29. 为什么 Risk Engine 应该 Off-chain

InferScore 不应该全部在 Solidity 中计算。

原因：

### 1. 模型需要快速迭代

今天：

```text
Repayment 30%
Revenue 20%
```

明天可能：

```text
Repayment 35%
Revenue 15%
```

不应该每次升级合约。

---

### 2. 防止攻击者完全知道风控规则

如果：

```text
Risk Model
```

全部公开且固定：

攻击者更容易反向优化：

```text
Sybil farming
```

---

### 3. 很多计算不适合链上

例如：

```text
Revenue graph analysis

Counterparty clustering

Wallet funding graph

Task similarity

Compute ROI

Fraud model
```

这些适合 Off-chain。

---

# 30. On-chain / Off-chain 数据划分

## On-chain

必须上链：

```text
ERC-8004 agentId

Agent Wallet

Credit Limit

Outstanding Debt

Borrow

Repayment

Default

Task Escrow

Task Reward

Backstop

Usage Receipt Hash

Revenue Settlement

Credit Freeze

Risk Tier

Score Attestation Hash
```

---

## ERC-8004 Reputation

写：

```text
Repayment Result

Default

Verified Revenue

Task Result

Service Quality

Arena Result
```

但尽量存：

```text
summary signal
```

而不是完整数据。

---

## Off-chain

保留：

```text
Raw Prompt

Raw Response

Task Private Data

Detailed Model Usage

Revenue Graph

Counterparty Graph

Fraud Features

Risk Model Weights

Success Probability Model

Compute Cost Model

InferScore Feature Vector
```

然后可以：

```text
Hash
↓
On-chain
```

完整数据：

```text
Database / IPFS
```

---

# 31. InferScore

> 本节的多因素权重与 A–E 属于长期评分研究。P0 使用 ENGINEERING §6.1 的确定性计数公式、A/B/C 三档及真实还款门槛；不要实现此处的权重示例。

建议：

```text
0 → 1000
```

但它只是 UX 层的风险摘要。

例如：

```text
Repayment History       30%

Verified Revenue        20%

Task Success            15%

Compute ROI             10%

Counterparty Diversity  10%

Account Longevity        5%

Owner Backstop           5%

Validation History       5%
```

最终：

```text
InferScore
742
```

然后进一步映射：

```text
Risk Tier

A
B
C
D
E
```

CreditManager 真正读取：

```text
Risk Tier
+
Credit Authorization
```

而不是直接信任前端展示的数字。

---

# 32. Validation Registry 值不值得接？

值得。

但我建议：

# P1，而不是 P0。

原因是 Validation Registry 对我们的：

```text
Task-backed Credit
```

非常合适。

---

# 33. Validation Registry 可以解决什么？

假设：

```text
Task

Fix Contract Vulnerability
```

Agent 提交：

```text
Patch
```

Validator：

```text
Hidden Tests
```

执行。

结果：

```text
PASS
```

可以产生：

```text
Validation Request

↓

Validation Response = 100
```

ERC-8004 Validation Registry 正是为了记录这种独立验证结果；标准允许 validator 使用 re-execution、TEE、zkML 或 trusted judge 等机制。

---

# 34. InferCredit Task Verification

未来：

```text
Agent
↓
Accept Task
↓
Borrow Compute
↓
Produce Result
↓
Validation
↓
PASS
↓
Release Escrow
↓
Repay Loan
```

这样：

```text
Credit
```

和：

```text
Verifiable Work
```

真正绑在一起。

这是非常漂亮的一套闭环。

---

# 35. 但 Validation Registry 不应该强绑所有任务

比如：

```text
$0.02 Search Task
```

没必要：

```text
Validation Registry transaction
```

所以应该：

```text
LOW VALUE

Internal Verifier
```

```text
MEDIUM VALUE

Trusted Verifier
+
Result Hash
```

```text
HIGH VALUE

ERC-8004 Validation
```

形成：

# Tiered Validation

---

# 36. 一个值得注意的 ERC-8004 细节

当前 ERC-8004 规范要求：

```text
validationRequest()
```

由 Agent Identity 的：

```text
owner / operator
```

发起。

所以不要草率设计成：

```text
TaskEscrow
→ 自动替 Agent 调 validationRequest()
```

否则权限模型可能不成立。

第一阶段更简单的方案：

```text
Agent SDK
↓
完成 Task
↓
请求 Owner / Authorized Account
↓
Validation Request
```

长期可以使用：

```text
Smart Agent Account
```

让 Agent Account 成为 Identity 的控制主体，再通过 Session Key Policy 让 Agent 安全请求 Validation。

---

# 37. Smart Agent Account

长期我们应该考虑：

```text
Agent Identity
      │
      ▼
Smart Agent Account
```

而不是：

```text
Agent Identity
      │
      ▼
Raw Private Key
```

Smart Agent Account 可以控制：

```text
Session Keys

Spending Policy

Validation Permission

Daily Limits

Provider Whitelist

Emergency Recovery
```

Agent Runtime 只获得：

```text
Limited Session Key
```

不能：

```text
Transfer Identity

Change Owner

Withdraw Capital
```

这和 Agent Fuel 的 Spend Policy 思路可以很好结合。

---

# 38. ERC-8004 Financial Identity

这是 InferCredit 一个非常值得强化的产品概念：

# Agent Financial Identity

ERC-8004 原本解决：

```text
Who is the agent?
```

InferCredit 在它上面构建：

```text
What has this Agent earned?

How much has it borrowed?

Has it repaid?

How profitable is its work?

What kinds of work can it reliably complete?
```

于是 Agent Profile 可以变成：

```text
Agent #1842

ERC-8004 Identity
Verified ✓

Coding Agent

────────────────────

InferScore
824

Revenue
$348.22

Compute Spend
$42.18

Compute ROI
8.25x

Tasks
216

Success
94.2%

Loans
83

Repayment
100%

Defaults
0

Credit Limit
$25

────────────────────

Supported Trust

✓ Reputation
✓ Task Validation
✓ x402 Payment
✓ InferCredit
```

这就是一个：

# AI Agent Credit Bureau Profile

---

# 39. InferCredit 不需要自己的 Agent NFT

> 下方 CreditAccount 是长期循环额度模型示意；P0 使用按 taskId 记账的 TaskLoan，接口与终态见 ENGINEERING §4.2。

以前可能会设计：

```text
InferCreditAgent.sol
ERC721
```

现在建议：

# 删掉。

直接使用：

```text
ERC-8004 agentId
```

协议内部：

```solidity
struct CreditAccount {
    address identityRegistry;
    uint256 agentId;

    uint256 creditLimit;
    uint256 debt;

    RiskTier tier;

    bool frozen;
}
```

这样未来一个 Agent 离开 InferCredit：

它的 Identity 和 Reputation 仍然存在。

这是开放协议应该有的结构。

---

# 40. 推荐最终合约架构

> 以下是长期模块拆分。P0 合并成四合约，独立模块不构成本次开发任务，详见 RISK_AND_MVP §4。

```text
                   ERC-8004

         ┌────────────┼────────────┐
         │            │            │
         ▼            ▼            ▼

    Identity      Reputation    Validation
    Registry       Registry      Registry

         │            │            │
         └────────────┼────────────┘
                      │
                      ▼

              AgentIdentityAdapter

                      │
                      ▼

              ┌──────────────┐
              │ Risk Manager │
              └──────┬───────┘
                     │
                 Authorization
                     │
                     ▼
              ┌───────────────┐
              │ CreditManager │
              └───────┬───────┘

          ┌────────────┼─────────────┐
          │            │             │

          ▼            ▼             ▼

 LiquidityVault   BackstopVault   AgentAccount

                                      │
                               ┌──────┴──────┐
                               │             │

                               ▼             ▼

                         SpendPolicy    ProviderRegistry

                               │             │
                               └──────┬──────┘

                                      ▼

                               UsageSettlement

                                      │
                                      ▼

                            Compute / API / Agent

                                      │
                                      ▼

                               RevenueRouter

                                      │
                           ┌──────────┴──────────┐
                           │                     │

                           ▼                     ▼

                       Repayment             Agent Balance
```

---

# 41. 推荐合约列表

> 这是长期目录建议；当前 contracts/ 的四合约与测试套件是 P0 实际工程结构，不新增下列全部合约。

```text
contracts/

├── credit/
│   ├── CreditManager.sol
│   ├── RiskManager.sol
│   ├── LiquidityVault.sol
│   └── BackstopVault.sol
│
├── agent/
│   ├── AgentAccount.sol
│   ├── SpendPolicy.sol
│   └── ERC8004Adapter.sol
│
├── task/
│   ├── TaskEscrow.sol
│   ├── TaskVerifier.sol
│   └── Arena.sol
│
├── payment/
│   ├── ProviderRegistry.sol
│   └── UsageSettlement.sol
│
└── revenue/
    └── RevenueRouter.sol
```

不再：

```text
AgentRegistry.sol
```

因为：

```text
ERC-8004 Identity Registry
```

已经负责这一层。

---

# 42. ERC8004Adapter

> 本节仅说明适配层职责。P0 入口为 resolveAgent、identityChanged、enroll/reapprove、snapshotVersion 和返回 bool 的 reportFeedback；完整 ABI 见 ENGINEERING §4.1 与 IERC8004Adapter。hasValidIdentity 是早期示意，不是待补接口。

单独做一层：

```solidity
ERC8004Adapter.sol
```

避免整个 Protocol 与 ERC-8004 ABI 强耦合。

例如：

```solidity
function resolveAgent(
    uint256 agentId
)
external view returns (
    address owner,
    address wallet
);
```

以及：

```solidity
function hasValidIdentity(
    uint256 agentId
)
external view returns (bool);
```

长期 ERC-8004 Draft 标准继续调整时：

只更新：

```text
Adapter
```

不需要动：

```text
CreditManager
```

这是尤其重要的，因为截至目前 ERC-8004 仍处于 Draft 状态。

---

# 43. RiskManager

RiskManager 不负责计算完整 InferScore。

它验证：

```text
Off-chain Underwriter
```

签出的 Credit Authorization。

例如：

```text
agentId

taskId

creditLimit

expiresAt

riskTier

modelVersion

evidenceHash
```

Underwriter：

```text
EIP-712 Sign
```

链上：

```text
RiskManager.verify()
```

然后：

```text
CreditManager
```

执行。

---

# 44. 为什么使用 Signed Authorization

这样可以快速更新：

```text
Underwriting Algorithm
```

而不升级合约。

例如：

```text
Risk Engine v1

↓

Risk Engine v2
```

链上只知道：

```text
Approved Underwriter Signer
```

以及：

```text
Evidence Hash
```

未来可以进一步去中心化：

```text
Single Underwriter
↓
Multi-sig Underwriter
↓
Validator Network
↓
ZK Risk Proof
```

---

# 45. Task Underwriter

> 以下为长期输入/输出示例。P0 的签名载荷是 ENGINEERING §4.2 的 CreditAuthorization（principalCap / feeBps / identityVersion / 双期限 / nonce），并按任务快照净 escrow 预裁剪；不照抄示例 creditLimit 字段签名。

这是 InferCredit 真正应该重点投入的模块。

Input：

```text
Agent

Task

Reward

Escrow Status

Task Type

Compute Estimate

Historical Success

Revenue

Debt

Backstop

Counterparty

Validation Requirements
```

Output：

```json
{
  "approved": true,
  "creditLimit": 0.42,
  "riskTier": "B",
  "estimatedCompute": 0.28,
  "maxCompute": 0.40,
  "successProbability": 0.91
}
```

这才是：

# InferCredit Core IP

---

# 46. Compute Underwriter

Task Underwriter 下面还应该有：

# Compute Cost Estimator

例如 Coding Task：

```text
Repo Size

Files

Language

Test Count

Task Complexity

Model

Historical Token Usage
```

预测：

```text
P50 Compute Cost
$0.18

P90
$0.34

P99
$0.48
```

Credit：

```text
$0.40
```

而不是：

```text
Agent 自己说我要借 $100
```

这对风控极其关键。

P1 补充：Compute Underwriter 的任务分类器与 relay 的
by-intent 路由（ENGINEERING §6.2）是同一个组件的两面 ——
授信时用它估成本，执行时用它选模型；
执行侧按意图归档的用量数据反过来喂成本模型，
形成"估 → 花 → 学"的闭环。

---

# 47. Purpose-bound Credit

CreditManager 不应该：

```text
transfer USDC to Agent
```

正确做法：

```text
Credit Authorization
```

只能被：

```text
AgentAccount
```

用于：

```text
ProviderRegistry
```

认可的 Provider。

例如：

```text
Kimi

Qwen

Search API

Data API

Storage

Approved Agent Service
```

不能提现：

```text
Withdraw
✗

Swap
✗

Random Transfer
✗
```

Purpose-bound 支付减少资金用途失控，但不能单独消除 provider 合谋风险。
P0 还依赖自营 provider 准入、任务 reward 托管、I6 和全局限额；
真正无 escrow 保障的 Uncollateralized Credit 属于长期扩展。

---

# 48. RevenueRouter

所有协议认可收入：

```text
Task Reward

Arena Reward

Agent Service Revenue
```

不要直接进入 Agent wallet。

先进入：

```text
RevenueRouter
```

P0 的路由由 TaskEscrow 在同一交易内完成，不部署独立 RevenueRouter：

```text
Task reward
  → 协议费（任务创建时快照，demo 为 0）
  → 本 task 的未偿 factor fee
  → 本 task 的未偿本金
  → 剩余进入 AgentAccount.cash
```

P0 不按时间计息，不自动补足 backstop；后者只能由显式 fundBackstop 或 Defaulted recovery 回补。
None/ClosedByRefund 的成功任务跳过 repay，不增加还款次数；失败/到期时退 escrow。
独立服务收入路由、利息模型与目标 backstop 水位均属后续产品规则。

例如：

```text
Task Reward
$2.00

Debt
$0.20

Fee
$0.01
```

最终：

```text
$0.01
→ Fee

$0.20
→ Loan Repayment

$1.79
→ Agent
```

Agent 自动完成还款。

---

# 49. ERC-8004 + RevenueRouter

还款成功后：

```text
RevenueRouter
```

可以触发：

```text
FinancialReputationReporter
```

提交：

```text
tag1 = infercredit

tag2 = repayment

value = 100
```

然后：

```text
Agent ERC-8004 Reputation
↑
```

下一次：

```text
Underwriter
```

读取：

```text
Repayment History
```

Credit：

```text
↑
```

形成：

# Credit Flywheel

---

# 50. 最终闭环

```text
ERC-8004 Identity

        ↓

Agent accepts Task

        ↓

Task Reward Escrowed

        ↓

Task Underwriter

        ↓

Credit Approved

        ↓

AgentAccount

        ↓

Credit-aware x402

        ↓

Compute / API

        ↓

Agent works

        ↓

Task Validation

        ↓

Revenue Released

        ↓

RevenueRouter

        ↓

Loan Repaid

        ↓

ERC-8004 Reputation

        ↓

InferScore ↑

        ↓

Credit Limit ↑
```

这就是 InferCredit 最完整的：

# Agent Economic Flywheel

---

# 51. 与 Monad-Rebel 的关系

这两个项目其实可以形成非常漂亮的技术连续性。

## Monad-Rebel / Agora Mesh

解决：

```text
Agent
↓
Discover Agent
↓
Trust Agent
↓
Pay Agent
↓
Receive Service
```

仓库 README 本身已经使用：

```text
HTTP 402

MON settlement

Agent Registry

Reputation

ERC-8004
```

作为 Agent-to-Agent commerce 基础。

---

## InferCredit

继续向下一层：

```text
Agent
↓
Discover Work
↓
Need Capital
↓
Borrow
↓
Buy Compute
↓
Perform Work
↓
Earn
↓
Repay
```

所以可以在 Pitch 里说：

```text
Our previous work explored:

How autonomous agents transact.

InferCredit explores the next question:

Who finances them?
```

这个故事是连续的。

---

# 52. 可以复用 Monad-Rebel 什么？

第一批直接搬：

```text
shared/src/erc8004.ts

shared/src/erc8004-reputation.ts

onchain identity storage

EIP-712 wallet binding

ERC-8004 config

x402 payment schema

HTTP 402 flow
```

`Monad-Rebel` 当前工程已经把：

```text
Identity registration

Agent wallet binding

Reputation feedback
```

跑通，不需要重新造轮子。

---

# 53. 不建议直接复用的东西

Monad-Rebel 中：

```text
Registry JSON

Local Feedback Store

Service Registry
```

属于那个项目自己的 service discovery architecture。

InferCredit 应该重新设计为：

```text
ERC-8004
+
On-chain ProviderRegistry
+
Indexer
```

避免长期出现：

```text
两套 Identity

两套 Reputation
```

---

# 54. ERC-8004 Implementation Roadmap

## Phase 1

直接复用：

```text
Identity Registry

Agent Registration

Agent Wallet Binding
```

P0。

---

## Phase 2

接：

```text
Reputation Registry
```

写入：

```text
repayment

default

task-success

verified-revenue（P1+）

compute-roi（P1+）
```

P0 只接 repayment / default / task-success；扩展指标不影响当前 Tier 计算。

---

## Phase 3

接：

```text
Validation Registry
```

用于：

```text
Coding Arena

Task Completion

High-value Work
```

P1。

---

## Phase 4

构建：

```text
Agent Financial Identity API
```

例如：

```text
GET /agents/:id/credit
```

返回：

```json
{
  "agentId": 1842,
  "inferScore": 824,
  "riskTier": "A",
  "creditLimit": 25,
  "availableCredit": 20.8,
  "revenue30d": 128.6,
  "repaymentRate": 1,
  "taskSuccessRate": 0.942,
  "computeRoi": 7.8
}
```

---

# 55. Hackathon P0

> 当前已完成接口与测试基线准备，以下勾号表示 P0 范围，不是实现进度。具体推进与验收依 TEST_PLAN §5。

ERC-8004 不应该拖慢主产品。

必须做：

```text
✓ Identity

✓ Agent Wallet

✓ Repayment Reputation

✓ Task Reputation
```

可以延后：

```text
Validation Registry

Complex Reputation Aggregation

Cross-chain Identity

ZK Attestation

TEE
```

---

# 56. 最值得展示的 ERC-8004 Demo

以 ENGINEERING §6.1 的确定性三单脚本为准，不再使用概念示例中的任意分数/额度：

| 阶段 | 本单费率 Tier | reward / API 报价 | 结算后 cash | 结算后分数 / Tier |
|---|---|---|---|---|
| 第 1 单（初始 cash 0.04） | C，15% | 0.15 / 0.12 | 0.058 | 570 / C |
| 第 2 单 | C，15% | 0.15 / 0.12 | 0.0787 | 640 / B |
| 第 3 单 | B，8% | 0.15 / 0.12 | 0.105396 | 710 / A |

金额按 demo 固定换算展示，协议费显式为零。前两单需真实完成，现场第三单在结算后升 A。
每单 cash 不足报价才 draw；结算后验证真实还款计数 +1，并写 repayment / task-success。
Tier cap（C=0.20、B=0.50、A=2.00）还要按本任务净 escrow/LTV 预裁剪，不能宣称 Tier cap 都可借出。

这展示的是可复现的 Credit Evolution。canonical registry 的本地 fork 已通过（见 `docs/day0-findings.md`）；真实链上资金路径与 SDK 仍需联调验证，
本地 mock 和参考数学测试不等于 demo 已完成。

---

# 57. 最终 Protocol Positioning

三个协议形成：

```text
ERC-8004
Who are you?
Can I trust you?

       ↓

InferCredit
Can I finance you?

       ↓

x402
How do you pay?
```

这句话非常适合 Pitch。

---

# 58. Competitive Positioning

## Agent Fuel

```text
Can this agent safely spend?
```

---

## Fianza

```text
Has this agent earned enough
to qualify for credit?
```

---

## ERC-8004

```text
Who is this agent
and what trust signals does it have?
```

---

## InferCredit

```text
Is this Agent × Task
worth financing?
```

这就是我们的核心差异。

---

# 59. 最终技术组合

建议最终组合：

```text
ERC-8004
        │
        ├── Identity
        ├── Reputation
        └── Validation
               │
               ▼
        InferCredit Risk Engine
               │
        ┌──────┴───────┐
        │              │
Task Underwriter   Revenue Underwriter
        │              │
        └──────┬───────┘
               ▼
        CreditManager
               │
        LiquidityVault
               │
        AgentAccount
               │
        SpendPolicy
               │
     Credit-aware x402
               │
        Compute / APIs
               │
             Work
               │
         RevenueRouter
               │
           Repayment
               │
     ERC-8004 Reputation
```

---

# 60. 开源项目研究优先级

## Tier S — 直接深挖

### Agent Fuel

学习：

```text
Agent Vault

Spend Policy

Owner / Agent Permission

Service Registry

x402 SDK

Reputation Pipeline
```

---

### Fianza

学习：

```text
Revenue Underwriting

Anti-Sybil

Counterparty Independence

Isolated Vault

Auto Draw

payWithCredit()
```

---

### ERC-8004

直接集成：

```text
Identity

Reputation

Validation
```

---

# 61. Tier A

### Goldfinch

学习：

```text
CreditLine

First Loss

Junior / Senior Capital

Repayment Waterfall
```

---

### Aave V3

学习：

```text
Credit Delegation

Allowance

Owner-backed Credit

Risk Limits
```

---

### Morpho

学习：

```text
Risk Isolation

Minimal Markets

Immutable Risk Parameters
```

---

# 61.5 Tier B — 场景与工程参考

不进入协议设计，但影响 Arena 产品形态与 Demo 工程。

### Token Arena（token.jiqiren.ai）

定位 "Battle for Tokens" —— Agent 对战竞技场，目前形态还比较早期：

```text
游戏          德州扑克（不完全信息 · 概率与博弈）
              五子棋（完全信息 · 布局与推演）

对局方式      用户复制对局页提示词粘贴给 Codex，
              Agent 读取规则后通过内置浏览器接管对局

经济模型      练习赛免费开放中；
              正式赛（未开放）：双方投入虚拟积分下注，
              按对局结果结算；积分不可提现
```

对 InferCredit 真正可迁移的三点：

```text
1. 对局胜负 = 最便宜的 Verifiable Work
   确定性裁决、零争议，比 hidden tests 还容易验收
   → Arena 的 P1 任务类型（P0 仍是编程题）

2. 双方质押积分 + 按结果结算
   = 我们 TaskEscrow（托管 + settle）的积分版
   它验证了这个循环的产品可行性，我们把它搬上链

3. 零 SDK 接入（贴提示词即参赛）
   → 我们 Arena 的 onboarding 参考：
     任务同样可以做成"贴给 Claude Code / Codex 就能接单"
```

注意：对外话术仍遵守 TRACK_NARRATIVE §6 —— 我们叫 Verifiable Work Arena，
参考它的产品形态，不复用它的 GameFi 叙事。
它的积分刻意不可提现（合规考量）；我们的结算在链上真实发生，
这既是差异点，也意味着我们要自己扛住它不用扛的风控（见 RISK_AND_MVP §1）。

---

### Tutti（github.com/tutti-os/tutti，Apache-2.0）

多 Agent 协作工作台：共享上下文、任务自动拆分编排、Control Center。

参考：

```text
Task Orchestration
（goal → sub-tasks → 分配给合适的 Agent）

多 Agent Demo 的工程组织方式
```

与 InferCredit 的关系：它解决 Agent 怎么协同干活，
我们解决干活的钱从哪来 —— 未来 Tutti 类工作台里的 Agent
正是 InferCredit 的目标借款人画像。

---

### magpie（github.com/yetone/magpie，MIT，Go）

本地模型网关：一个 gateway 暴露 OpenAI / Anthropic / Gemini 三种
标准 API，routing group 把多个上游聚成一个逻辑模型 ID，
官方当前README列smart/order/rotate/usage/pace等模式；by-intent分类器是我们的P1候选，未接入。

参考（细节见 ENGINEERING §6.2 / §6.5）：

```text
Relay 架构     逻辑服务 ID 与物理上游解耦 + order fallback
               + 报价锁价规则（402 计费下重路由只收报价价）

Demo 可视化    三栏节点图 / 可解释路由标签 / 行内用量条 /
               "0 errors your agent saw" 式计数条

P1 接口        双API面互译可减少推理接口适配；客户端仍需
               SDK/支付adapter处理402签名、付款与恢复
```

不借鉴：订阅凭证复用（把包月订阅当 provider 转卖）——
与"算力是计量商品"的产品前提冲突，且有 ToS 风险。

---


### 2026-10-04 工程补充：路由、执行与竞技的边界

固定演示与受限Pi入口并存，不把受限执行说成完整自主选单。Pi Agent core锁1.0.1，经自定义streamFn接SDK/Relay；公开样例Docker不结算，最终由独立Arena/settler裁决，未叠加LangChain。

显式cheap/strong与预算检查已实现。早期真实K2.6/K3短探针只验证了API和本地mock-USDC报价，未保存原始链receipt的限制保留在对应报告。后续真实信用B已完整保存并独立核验付款、LoanOpened、模型工具调用和TaskSettled：实际Magpie网关→K2.6、本地融资80000、手续费12000、还款92000。一次固定价服务内部最多三轮，首轮成功不能证明自然多轮修复；没有逐轮融资或储值退款账本。

Magpie已从候选变为实际接入：锁官方版本和无隐式重试小补丁，使用显式provider/model映射。付款、报价与退款仍属于InferCredit；自动分类、订阅凭证复用、跨网关重配置恢复未作为已完成能力。Monad Pi Task11已独立验收：实际Magpie/Kimi/Pi与独立Arena跑通测试USDC借款14604、fee438、偿还15042；最终cash134958、还款4、未偿0，见[工程状态](docs/implementation-status.md)。

五子棋15×15自由规则、双Agent独立现金预算、模型决策、独立裁判、持久棋谱与CLI已实现。完整受控胜负/恢复验收通过；新真实Kimi整局12合法步/13次调用付款，黑方响应截断且格式无效，按规则白方forfeit胜（非五连胜）；独立重放与付款审计通过，结算仍为本地mock-USDC。旧11步503暂停局保留为历史。比赛胜负不代表奖金确定可收取，首版没有共享奖金借款，不能把同一奖金抵押给两名参赛者。

实际范围、代码入口与证据以[ENGINEERING §6.6](AGENT_CREDIT_ENGINEERING.md)、[Magpie接入](docs/magpie-gateway.md)、[棋牌运行](docs/gomoku-arena.md)为准。便宜上游只有通过更低报价才能降低agent支出，评分不因模型降价直接增加。

---

# 62. 不建议做的方案

## 不要 Fork Aave

因为：

```text
Collateral Lending
≠
Agent Working Capital
```

---

## 不要 Fork Morpho

因为：

```text
Token Price Oracle
+
Liquidation
```

不是我们的核心问题。

---

## 不要只做 Revenue Credit

Fianza 已经在做。

---

## 不要只做 Agent Vault

Agent Fuel 已经在做。

---

## 不要自己再造 Identity NFT

ERC-8004 已经解决。

---

## 不要把所有 Risk Logic 放 Solidity

迭代慢，而且容易被攻击者反向优化。

---

# 63. 最终创新点

InferCredit 的真正创新点应该明确写成三个。

## 1. Work-backed Credit

借款能力来自：

```text
future work
```

而不是只有：

```text
collateral
```

或者：

```text
historical revenue
```

---

## 2. Compute Underwriting

协议不是问：

```text
这个 Agent 可以借多少钱？
```

而是问：

```text
这个 Agent 完成这个 Task
需要多少钱？
```

---

## 3. Agent Financial Identity

使用：

```text
ERC-8004
```

把：

```text
Identity

Work

Revenue

Credit

Repayment
```

关联成长期金融身份。

---

# 64. 最终一句话

整个产品最终可以定义为：

# InferCredit is the working-capital protocol for autonomous AI agents.

或者：

> **InferCredit finances the compute an agent needs today against the work it will complete tomorrow.**

技术层一句：

> **ERC-8004 tells us who the agent is. InferCredit decides whether the agent's next job is worth financing.**

而整个协议真正应该形成的循环是：

```text
IDENTITY
   ↓
WORK
   ↓
CREDIT
   ↓
COMPUTE
   ↓
EXECUTION
   ↓
REVENUE
   ↓
REPAYMENT
   ↓
REPUTATION
   ↓
MORE CREDIT
```

最终我们不是在做：

```text
AI Token Lending
```

也不是：

```text
Agent GameFi
```

更不是：

```text
Another x402 Wallet
```

而是在构建：

# The Capital Layer for the Agent Economy.

---

# 65. 风险补充与 MVP 裁剪

本文档回答"协议应该长什么样"。

配套文档：

```text
AGENT_CREDIT_RISK_AND_MVP.md
```

回答两个更现实的问题：

1. 无抵押信贷的主要攻击面（Provider 合谋套现、Poster–Agent 自融、Underwriter 私钥、Identity 转让、RevenueRouter 绕过）以及黑客松阶段的处理级别。

2. 定价模型、per-task Loan 数据模型、13 个合约收敛到 4 个的 P0 裁剪、Monad 上 x402 的可行性检查清单。

实现前请先读该文档 —— 其中每一条都标注了 `[P0 实现]` / `[P0 文案]` / `[P1 推迟]`。

---

# 66. 赛道对齐与 Pitch 叙事

参赛赛道与故事线见：

```text
AGENT_CREDIT_TRACK_NARRATIVE.md
```

核心结论：

1. 主打 Metropolis **Track 4 — Trust, Identity & AI Infrastructure**（官方示例直接点名 ERC-8004 agent identity/reputation）。

2. 集成 Monad 测试网 chainId 10143 已部署的 **canonical ERC-8004 registries**（Identity `0x8004A818...4BD9e`、Reputation `0x8004B663...88713`，完整地址与 fork 证据见 `docs/day0-findings.md`），不自己部署；Validation Registry 在 Monad 上 coming soon，Tiered Validation 过渡。

3. 叙事倒装为 trust-first：**"ERC-8004 回答 who can you trust，InferCredit 回答 what is that trust worth。"** One-liner：**Reputation you can spend.**

4. Arena 定位为**协议自营的第一个任务市场**（冷启动方法论），对外称 Verifiable Work Arena，不用 GameFi / play-to-earn 话术。

---

# 67. 工程实施计划

具体怎么做见：

```text
AGENT_CREDIT_ENGINEERING.md
```

内容：技术栈定稿（Foundry + npm workspaces，与 Monad-Rebel 对齐）、repo 结构、Day-0 spike 清单、四合约接口草案（含 EIP-712 CreditAuthorization）、链下三服务规格、四周里程碑与砍功能预案、Demo Definition of Done。

### 2026-10-04 用户确认：德州/GameFi 是预算获取路径，不做游戏借贷

Agent可以按现有任务规则借款购买推理，也可以参与德州赢取推理额度或USDC。两条路径并列；游戏不放贷，不以预期奖金授信。目标是德州，五子棋只是已验收原型，德州规则及赞助测试USDC奖励购买受控推理的本地闭环已验收；后续真实Kimi对局、Monad赞助测试USDC入cash及奖金购买真实推理和历史只读回放页也已落地；2026-10-05 已增加本机网页开局、Kimi 专用额度发放/兑换与持久恢复，公开远程报名仍未开放，见[德州运行](docs/holdem-arena.md)。完整范围以 [ENGINEERING §6.6](AGENT_CREDIT_ENGINEERING.md) 和 [风险文档 §9](AGENT_CREDIT_RISK_AND_MVP.md#9-下一阶段推进顺序2026-10-04评估) 为准。

## GameFi 当前实现（2026-10-05）

`/arena` 保留参考站的 UI/UX，业务使用 AgentFuel 的规则、真实模型流程与奖励政策。本机运营用户可在网页选择测试 USDC 或 Kimi 推理额度并发起德州比赛；`/api/arena/gamefi` 只调用服务端固定的两位 Agent 与原 CLI，浏览器不能指定钱包、模型、路径或赢家。`/arena/holdem` 继续作为历史公开回放与资金证据入口。尚未开放远程账号报名、任意提示词参赛、多手真实赛事或可验证随机，游戏始终不发贷款。

Kimi 额度由可信服务端重放终局发放：每局共 4096 token，独胜全额、平局各 2048；绑定 `kimi-k2.6` 和固定运营身份。`/api/arena/credits` 在调用前持久化兑换意图与预算预留，完成后按供应商实际输入和输出 usage 扣减。未知结果保留预留，重复兑换 ID 返回原状态或缓存，不再派发；超额用量保留实际扣减并阻止继续消费。它不是加密代币、USDC 余额或 Magpie 周期预算。

runner、额度 ledger 与四游戏练习均有本地持久化和 writer 锁。真实比赛按原 UUID、evidence 和交易 journal 恢复，不重开未知模型请求；练习保存规则重放、日志、席位和幂等请求，默认 `.data/arena-freeplay.json`，可由 `ARENA_PLAY_STATE_PATH` 指定。原子写入与 fsync 支持进程重启恢复，不能据此声称已有公网身份平台或分布式存储。练习 Bot 不调用真实模型，练习胜负不发放 USDC 或额度。

本轮真实额度局已向 Agent1999 发放 4096 token，实际 Kimi 消费 24，余额 4072；同兑换 ID 返回缓存。2026-10-06 新 USDC 局已完成独立验收：Agent1998获0.1测试USDC，原存款签名确认入cash，消费0.01完成1次真实Kimi推理（21输入+8输出=29 tokens），cash剩0.09、借款0。root fresh核对存款/付款canonical回执、付款块cash及本地原始模型响应；原对局报告未变，没有重复派奖。RPC仍可能间歇失败，本次成功不代表网络问题已消失。详见[本轮完成验收](demo-output/gamefi-complete-20261005-root/root-usdc-complete-20261006.json)。浏览器 16 项为受控接口测试，全部拦截 start/recover/redeem，不是交易证据。当前汇总见[本轮验收](demo-output/gamefi-complete-20261005-root/root-acceptance.json)，配置和恢复见[网页 runner](docs/gamefi-runner.md)、[额度规则](services/arena/src/inference-rewards/README.md)和[练习 API](docs/free-arena.md)。2026-10-04 的[UI 复刻验收](demo-output/arena-clone-20261004-root/root-acceptance.json)保留为历史，其仅内存存储与网页只读边界已由本轮实现替代。


## 2026-10-06 下一阶段：未知模型响应保护

2026-10-06 普通Relay失败处理已独立验收：派发前记录候选意图，未知响应不fallback、不重发、不直接退款；受信明确拒绝后才继续原同档候选。root新Anvil/受控上游Relay与SDK44/44、固定价B兼容28/28及全项目typecheck通过。固定价B原未交付全退契约保留。本批没有新增真实模型或Monad交易；真实strong工具、自然修复及真实fallback仍待有界验收。 运行规则与拒绝响应契约见[Relay README](services/provider-relay/README.md)，独立结果见[本轮验收](demo-output/relay-uncertain-20261006-root/root-acceptance.json)。


## 2026-10-06 Strong 工具真实验收（当前）

2026-10-06 strong-only真实工具验收已完成：新本地Anvil固定价信用任务经直营Kimi K3一次调用，输入307/输出86/总393 tokens，实际test_public_sample一次通过，独立Arena5/5并结算。现金40000+借款80000支付120000原始mock-USDC，费用12000、还款92000，最终cash58000、未偿0。root独立复跑12项受控脚本测试、全项目typecheck，校验原请求响应/签名/资金回执，并重新Docker判题5/5。首轮成功即停，没有人为错误或第二次模型调用，不证明自然多轮修复或真实fallback；本轮没有新增Monad交易、未经过Magpie，也不据usage推算vendor账单。 [独立验收](demo-output/live-strong-only-20261006-root/root-acceptance.json)，[复现与限制](packages/pi-loop/FIXED_PRICE.md)。这补齐此前“仅K3短探针、未验证工具”的缺口，旧运行仍保留各自原始范围。


## 2026-10-07 当前扩展边界

固定价 B 的题目白名单已覆盖求和、去重排序、括号匹配和词频统计；四题真实 Kimi 调用、独立 Arena 和本地信用结算已验收。普通 Relay 完成注入拒绝后的真实同档备用调用，仍在原报价内一次付费。两项均复用原四合约/SDK/Relay/Pi/Arena，没有增加合约、通用 Agent 框架或游戏贷款。本轮未新增 Monad 交易，未证明自然多轮修复或自然供应商故障。逐项证据与尚未开放的范围见[工程状态](docs/implementation-status.md)及[风险文档§9](AGENT_CREDIT_RISK_AND_MVP.md#9-下一阶段推进顺序2026-10-04评估)。

规则驱动选择器也已落地：在预设Assigned任务与宿主能力/价格配置内选择一次SDK推理购买，受控现金/信用路径与真实现金购买均已验收。它不等于任务自动发现、接单、完整自主调度或链上独立预算隔离；没有叠加LangChain或新增分类模型。


## 2026-10-07 后端收尾与 UI 交接

现有 P0 / 四道 Python 任务 / 本机运营 GameFi 后端的本轮交付见 [后端验收](docs/backend-acceptance.md)。新 `workflow` 使用纯规则选择，不先购买旧 selector 的原始推理；Open 接单、固定价 B、Pi 工具、独立 Arena、偿还与安全状态查询在一个持久请求中完成。HTTP 仅接受预设 profile 与 UUID，恢复复用原接单签名、PaymentHandle 和提交；未知请求不能靠换 UUID 重买。`npm run backend` 提供固定五角色启动和退出，GameFi 保留现有独立入口。

root 通过同款 Next 服务端桥接与真实 HTTP 完成一次 Kimi K2.6：190 输入 + 39 输出 = 229 tokens，付款120000（cash40000 + credit80000），偿还92000、最终cash58000、未偿0。接单/付款/结算三份回执已核对 canonical block，生成代码另经3项新Docker复判，原UUID恢复无新增消费。此为新本地Anvil/mock-USDC验证，没有新增Monad交易，也没有经过Magpie；旧Monad Task11和本轮Magpie实际进程回归分别作为各自证据。

剩余 UI 工作是预设任务控件、阶段/资金/错误展示、原请求恢复交互和桌面/手机浏览器验收。自然模型错误修复的观察证据、通用仓库任务、公开报名、第三方provider、公共LP和标准x402兼容，不应借“后端收尾”改写为已完成。


## 2026-10-12 核心运行补齐

新增 `metered-task` 与 `autonomous`：任务报酬担保购买不可转移的推理额度包，包内双模型按输入/输出 usage 差异扣费；奖励不足时可在同一 Pi 任务补额，独立验收后按合约还款/清算。有界 LLM 决策选择下一单、模型与现金/信用，宿主限制预算、任务数与截止时间。游戏不借贷、无 gas 赞助。包价与供应商账单分开，未用包额度绑定原任务；规划费现金支付。

本节替代上文这三项“尚未实现”的当前判断；历史外部验收范围保持原样。详细配置、边界与复现见 [核心运行说明](docs/core-runtime.md)。
