# InferCredit — 风险补充与 MVP 裁剪（Hackathon 版）

> **2026-10-07 托管范围补充**：当前推进的是用户创建平台托管 Agent，不是外部程序接入。owner 签名会话、随机独立钱包、消费预算预留、原请求恢复和奖励归属已实现；游戏不借款。首版免费参赛按 owner 累计最多 3 局、平台累计最多 100 局，开户 gas 另有运营配置总额上限，未知结果不返还名额或预算。它们是本机试点的成本约束，不宣称已解决公开平台注册、女巫攻击或规模化运营。见 [交付说明](docs/hosted-acceptance.md)。

> 本文是 `AGENT_CREDIT_ARCHITECTURE.md` 的配套文档。
> 主文档回答"协议应该长什么样"；本文回答两个更现实的问题：
>
> 1. 任务授信的主要攻击面在哪里，黑客松阶段怎么处理？
> 2. 主文档的 13 个合约，P0 到底做哪几个？

> **2026-10-05 同步**：P0 行为以 ENGINEERING v5.3 §4 与 TEST_PLAN 裁决为准。
> 本文区分当前 escrow-backed task loan 与长期无 escrow 保障的信用产品；
> 公共 LP、Senior/Junior 分层尚未开放。“P0 实现”是范围标签，不是逐项状态：当前四合约、本地风控测试及 Monad 真实正反向演示已验收，具体证据见 [工程状态](docs/implementation-status.md)。新增边界的推进顺序见 §9。

每一条都标注了处理级别：

```text
[P0 实现]     黑客松期间写进代码
[P0 文案]     写进文档 / Pitch，代码不做
[P1 推迟]     明确说"我们知道，但现在不做"
```

评委问到风控时，"我们知道这个攻击、这是缓解路线图"和"没想过"是完全不同的分数。

---

# 1. 攻击面分析

主文档在"防好人做错事"上很完整（SpendPolicy、限额、冻结），
任务授信仍需防范“坏人合谋套现”。但 P0 的风险归属必须说清：
I6 将含 fee 的授权债务上限约束在扣除快照协议费的 escrow × LTV 内；LTV ≤100% 且资产/托管正常时，
agent cash 与 escrow 足以覆盖债务，backstop/池子信用损失层不可达。
有 Active loan 的任务失败清算仍记 Defaulted，诚实 poster 可能承担 escrow 罚没；不能把违约次数直接当作 LP 损失。
以下攻击分析区分缺少这些约束时的攻击与 P0 的实际缓解。

## 1.1 Provider 合谋套现 — 最重要的攻击

Purpose-bound credit 的真正安全边界**不是 SpendPolicy，而是 ProviderRegistry 准入**。

攻击路径：

```text
攻击者注册 / 收买一个 approved provider
        ↓
Agent 借款支付给该 provider
        ↓
Provider 提现（credit 变成了现金）
        ↓
任务故意失败 → 违约
        ↓
缺少 escrow/LTV 保障时，损失可能落在资金池；P0 则先扣 cash / poster escrow
```

"借来的钱只能花给白名单"在这里完全失效——白名单里有内鬼即可。

**缓解与处理：**

- `[P0 实现]` ProviderRegistry 只放**自营 provider**：由协议自己代理 Kimi / Qwen / Search API 的 relay 服务。黑客松阶段没有第三方 provider 准入，收窄第三方准入攻击面，但仍需保护自营 relay 的密钥、收款与退款入口。
- `[P0 文案]` 在文档中写明长期方案：第三方 provider 准入需要 **staking + 延迟结算（T+N 提现）+ 单期收款上限**，异常违约率触发罚没。
- `[P1 推迟]` provider 收入图谱分析（与 1.2 的三方聚类合并做）。

## 1.2 Poster–Agent 自融

```text
攻击者发布假 Task 并 escrow $5
        ↓
自己的 Agent 接单，借 $0.40 compute credit
        ↓
钱花掉（或经 1.1 套现）
        ↓
缺少 slashing 时：任务失败 → escrow 全额退回 poster
        ↓
攻击者净赚借款，成本只有 gas
```

**缓解与处理：**

- `[P0 实现]` **Escrow slashing**：任务失败且 Agent 有未偿 task loan 时，escrow 不全额退回 poster，先扣 agent cash，再从 escrow 补剩余债务（本金+fee），未用 escrow 才退 poster。这只是 waterfall 里多一个分支，实现成本极低，但直接封死"失败退全款"的自融闭环。
- `[P0 文案]` 说明长期方案：把 Fianza 的 fund-flow loop 检测从"Agent 收入独立性"扩展到 **poster–agent–provider 三方资金图谱聚类**，同源资金的任务不计入授信依据。
- `[P1 推迟]` 图谱聚类的实际实现。

> 注意：escrow slashing 改变了 poster 的风险结构（诚实 poster 也可能在任务失败时损失一部分 escrow）。
> P0 的 slashing 上限 = min(可用 escrow, 扣 cash 后的剩余本金+fee)，只在清算时触发。
> cash 足额时 poster 拿回全部 escrow；cash 不足时 poster 可能损失 escrow，不能只以本金说明其风险敞口。

## 1.3 Underwriter 私钥 = 系统性单点

Signed authorization 模式下，underwriter key 一旦泄露，
攻击者可能尝试批量授信并占用 vault 流动性。单个 agent/task 限额不足以控制总量，
因此全局限额不可省；P0 仍强制真实任务 escrow 和 I6，不能仅凭签名任意无担保提款。

**缓解与处理（这部分必须在链上，不能省）：**

- `[P0 实现]` CreditManager 增加三个全局参数：

```solidity
uint256 public maxTotalOutstanding;   // 全协议未偿总额上限
uint256 public maxDrawPerEpoch;       // 每 epoch 新增授信上限
bool    public drawPaused;            // guardian 可一键暂停所有 draw
```

  maxTotalOutstanding 计本金+fee，maxDrawPerEpoch 计新增本金；退款不恢复当期预算。
  这些约束限制敞口和资金周转速率，不能把“单 epoch 额度”宣传为跨 epoch 的累计损失上限。

- `[P0 文案]` 去中心化路线图沿用主文档 §44：single signer → multi-sig → validator network → ZK。

## 1.4 Identity 转让 / Wallet 轮换 = 信用记录可买卖

ERC-8004 Identity 基于 ERC-721，**agentId 连同其还款历史和 InferScore 可以被整体转让**；
Agent Wallet 也可通过 `setAgentWallet()` 轮换。
买一个高分身份然后违约，比自己刷分便宜得多。

**缓解与处理：**

- `[P0 实现]` ERC8004Adapter 缓存每个 agentId 的 `(owner, wallet)`；
  CreditManager 每次 draw 同时校验实时 owner/wallet 和授权 identityVersion，变更即拒绝旧授权。
  纯 cash 支付和 acceptTask 也核对当前 registry wallet；身份转移会清空 wallet，需先重新绑定。
- `[P0 实现]` 持久冻结走成功执行的 freezeAgent；拒绝交易的 revert 不会保留冻结写入。
  guardian 经重新审批调用 reapproveAgent 刷新快照、递增版本，旧授权永久失效；
  unfreezeAgent 只解除冻结，不刷新身份、不清除违约记录。
- `[P0 文案]` 身份变化本身不新增一条“立即清算”路径；Defaulted 由失败任务或到期清算产生。
  有未偿债务的身份变更须重审，风险判断读 Manager 账本，不能因解冻抹去历史。

## 1.5 RevenueRouter 可被绕过（Level 3 的前提条件）

Waterfall 只对**流经协议的收入**有强制力。
TaskEscrow 的 reward 可以强制路由；
但 Agent 钱包直接收的 x402 付款（Agent Service Revenue）绕开 router 没有任何链上约束。

**处理：**

- `[P0 文案]` 在主文档中明确一条原则：

```text
只有结算经过协议 rails 的收入
才计入授信依据和自动还款来源。

链下 / 直收收入只能作为弱信号。
```

  这意味着 Level 3（Revenue-backed）实际上比 Level 2（Task-backed）**更难落地**，
  因为它要求 Agent 的服务收款全部走协议结算。四级进化顺序不变，但要写明这个前提。

---


## 1.6 预算循环与游戏奖励边界

2026-10-04 更新；对应 ENGINEERING §6.6。显式两档路由已通过本地验收，真实K2.6/K3 API各一次
128输出上限的短探针均最终OK/stop，资金仅用新本地Anvil/mock-USDC；运营价0.01/0.03不等于
上游成本或实际账单，不证明能力差异、真实链两档付款或标准x402兼容。原Anvil已关闭且首版未保存
raw receipt，本次不能独立复读原ProviderPaid事件；保存的签名交易与Relay proof/结果已离线审计。
测试网页面与旧demo配置未切换；在早期本地验收之后，固定价信用B已经实际Magpie/真实Kimi/Pi和独立Arena完成Monad Task11，root核对canonical回执通过，见[当前工程状态](docs/implementation-status.md)。一次真实首轮成功不证明自然多轮修复、strong能力或长期RPC稳定。五子棋真实模型整局已按格式违例规则终局（白方forfeit胜，非五连胜），费用结算为本地mock-USDC；德州免费赞助测试USDC首版已落地，具体真实对局与奖金消费证据见§9及运行文档；棋牌授信已明确不做，不修改当前P0合约边界。

- 模型不可用与 agent 预算不足分别处理；选档和降价发生在付款前，付款后不静默改能力、改价或追加扣款。
- loop 的总预算、轮数和截止时间由宿主强制限制；当前每 task 一次提款，不能按调用轮次重复借款。
  纯 cash 多轮试验不能作为信用多轮闭环的验收证据；固定价B早成功不返轮差，未交付原全价退款，已经Delivered而hidden失败走原任务清算；A按耗用储值/未用退款仍P1延后。
- 调试使用公开样例/自建测试，不触发最终结算，不向执行模型泄露 hidden tests。
  最终提交保留现有可信控制器和独立签名服务；恢复不得重复支付或结算。
- 游戏不提供借贷，不把预期奖金计入授信或作为还款担保；现有贷款不得用于游戏筹码。
  游戏资金/奖励额度单独记账，已结算奖励才能消费；比赛输赢与贷款还款/违约记录分开。

---

# 2. 定价模型（主文档缺失的一块）

Task loan 存续几分钟，按时间计息趋近于零——**利息不是这个产品的定价方式**。

P0 采用按实际 draw 本金收取的一次性 factor fee，Tier A/B/C 为 3%/8%/15%。
这不是已校准的预期损失模型，尤其不能把任务失败率当作 P0 池子的本金损失率。

以下概率公式与金额例子只用于 P1+ 存在实际池子信用损失的产品研究：

```text
fee = k × (1 − p_success) × principal + base_fee
```

例：

```text
principal        $0.40
p_success        93%
k                1.5（风险溢价系数）
base_fee         $0.001（覆盖 gas / 签名 / indexing）

fee = 1.5 × 7% × $0.40 + $0.001
    ≈ $0.043
    ≈ 本金的 10.8%
```

在假设损失率为 100%、不计其他成本的示例里，期望本金损失为 7% × $0.40 = $0.028。
这不是 P0 的收益预测：P0 为协议自有资金池，无公共 LP 存取或 Senior LP 产品；
费用需要覆盖流动性占用和运营成本，不能承诺 LP 正收益。

**黑客松处理：**

- `[P0 实现]` Demo 里用 Risk Tier 查表即可：

```text
Tier A → 3% factor fee
Tier B → 8%
Tier C → 15%
```

- `[P0 文案]` pitch 说明按任务预支与 factor fee；公共 LP 的损失/收益定价只作为长期研究，不套用上述例子宣传 P0。

---

# 3. 数据模型修正：per-task Loan

主文档 §39 的 `CreditAccount` 只有单一 `debt` 字段——这是 revolving 模型，
和 Task-backed 的核心定位不匹配。Loan 必须与 task/escrow 绑定：

```solidity
enum LoanStatus { None, Active, Repaid, Defaulted, ClosedByRefund }
struct TaskLoan {
    uint256 agentId;
    uint256 principal;     // 当前未偿本金
    uint256 fee;           // 当前未偿 factor fee，按实际 draw 计
    uint256 loanDueAt;
    LoanStatus status;
}

mapping(uint256 taskId => TaskLoan) public loans;
```

两条关键规则：

1. **Escrow lien + 原子清算**：loan 在 TaskEscrow 上登记优先受偿权；
   validation PASS 时，release 和 repay 在**同一笔交易**内完成，
   不走"钱先进 RevenueRouter 再瀑布"的两段式（中间状态会被钻空子）。

2. **违约定义**：任务验收失败，或 `now > loanDueAt + GRACE`，或 `now > task.deadline`，且 loan 仍 Active，
   任何人可触发清算，清偿顺序为：
   agent 自有 cash（先动，兑现"保护 poster"）→ escrow slashing（§1.2，只补不足）
   → backstop → 剩余为池子损失（字段 lpLoss，P0 出资方为 treasury）；随后写入 ERC-8004 `default` reputation 并冻结该 agent 信用。
   进入清算即记违约事实——即使足额回收（损失为零）也不改写为正常还款。
   push 入口为 liquidateWithEscrow（仅 TaskEscrow），pull 入口为 liquidateExpiredLoan（任何人到期可调）。
   原始 liquidations 承担额永久保留；recovery 逆序按“原始承担额 − 累计 recovered”逐层封顶。
   GRACE 只缓冲贷款到期，不延迟任务到期出口。None/ClosedByRefund 失败任务直接退 escrow，不进清算。

P0 以 taskId → TaskLoan 为债务真值，agent 级统计/冻结由 Manager 汇总；
不实现架构愿景中的独立 revolving CreditAccount。
退款按 paymentId 归属、refundedAmount 累计封顶、refundId 防重放：Active 按比例减本金/fee，
全 payment 退清转 ClosedByRefund；Repaid 的迟到退款全入 cash；Defaulted 走累计 recovery，均不增加还款次数。

---

# 4. P0 合约裁剪

主文档 §41 列了 13 个合约，黑客松做不完也不必做。P0 收敛到 4 个：

| P0 合约 | 吸收了主文档中的 | 说明 |
|---|---|---|
| `CreditManager.sol` | RiskManager + LiquidityVault | 验 underwriter 签名、记 TaskLoan、管 vault 存取、全局限额（§1.3） |
| `AgentAccount.sol` | SpendPolicy | 双余额 + cash/credit 分级限额 + provider 白名单检查 |
| `TaskEscrow.sol` | TaskVerifier + RevenueRouter | escrow、验收回调、原子清算 waterfall、slashing、写 reputation |
| `ERC8004Adapter.sol` | — | resolveAgent + owner/wallet 变更检测（§1.4） |

链下 P0 组成（准确职责见 ENGINEERING §6）：

```text
Underwriter Service     查表打分 + EIP-712 签名
Provider Relay          自营推理代理 + 402 收款/幂等交付/退款
Arena Service           容器执行 + 宿主裁决 + 独立 verifier 签名；允许明确披露的人工验收降级
Credit-aware SDK        infer.forTask(taskId).fetch()；无 task 上下文只允许纯 cash
```

明确推迟：

```text
BackstopVault    → Owner backstop 先做成 CreditManager 里的一个 mapping
Arena.sol 独立合约 → P1；P0 的链下 Coding Arena / 验收服务保留
独立 RiskManager  → 合并进 CreditManager
Senior/Junior 分层 → 文案预留，代码不拆
ProviderRegistry  → 先做成 AgentAccount 里的 mapping（自营 provider，见 §1.1）
UsageSettlement   → 先合并进 AgentAccount 的 spend 流程
```

---

# 5. 两个实现细节

## 5.1 失败路径

主文档只画了 happy path。Credit draw 之后 x402 支付失败 / 服务未交付时：

```text
draw 成功 → 支付失败
        ↓
同一交易 revert（draw 和 pay 必须原子）
        ↓
链下调用失败（已付款但无响应）
        ↓
记 receipt，争议走 provider 结算层（自营 provider 阶段 = 直接退款）
```

`[P0 实现]` draw + pay 失败必须原子回滚；已付款未交付则按 paymentId 恢复或由运营触发链上 processRefund。
relay 只有链上退款成功后才标记 Refunded；重复请求不得再次扣款。通用争议仲裁为 `[P1 推迟]`。

## 5.2 三层限额的优先级

P0 在 AgentAccount.payProvider 收口：policy 上限、auth.principalCap、全局剩余额度取最小值，
再受每日累计债务限额约束；不使用长期 CreditAccount.creditLimit。Manager 仍独立验证 I1–I7。
本地策略拒绝用 SpendRejected，Manager 不变量错误原样冒泡；多条件违规先后暂不规定。

---

# 6. Monad 可行性：已验证结果与兼容边界

2026-10-04：演示网络已确定为 Monad Testnet（10143），测试 USDC（6位）及 gas MON 已用于真实部署和业务付款。canonical registry 注册、钱包绑定与声誉写入已有目标链证据；原演示及 Task11 信用闭环见 [工程状态](docs/implementation-status.md)。不再把测试资产或基础支付可行性列为未完成阻塞。

当前支付是自建 HTTP 402 quote → AgentAccount 原子 draw/pay → Relay 交付/退款，不宣称已兼容标准 x402 scheme/facilitator。外部 facilitator 当前可用性未经本轮复核；只有接入标准生态成为明确产品需求时，才另做兼容验证，不为此重写已验收支付路径。

---

# 7. Demo 建议：演示一次被拦截的攻击

主文档 §56 的正向 demo（借款 → 完成任务 → 还款 → 信用上升）很好。
建议追加 30 秒的反向 demo：

```text
Agent 试图把借来的钱付给未白名单地址
        ↓
AgentAccount revert
        ↓
（或）Identity 被转让
        ↓
旧授权/旧钱包调用被拒；需要持久冻结时单独执行 freezeAgent
```

对评委来说，**现场看到一次攻击被链上拦截**，比十页风控文档更有说服力，
这两个场景均在 P0 验收范围，且已完成真实 Monad 拒绝交易、身份冻结及页面/备用录像验收，见 [ENGINEERING §9 对照](docs/implementation-status.md#engineering-9逐项-dod)。历史记录不代替未来部署的重新验证。

---

# 8. 主文档待办（文档卫生）

- 2026-10-04 检查主架构正文，未发现旧 `citeturn` 或内嵌研究引用 token；外部事实和许可如用于正式材料仍应核实来源。
- 项目代号 "AgentFuel" 与 benchmark 中的外部项目 "Agent Fuel" 撞名：
  如果那是自己的前作，在 §4 说明一句；如果不是，建议换代号，评委会混淆。
- Compute Underwriter 的 P50/P90/P99 预测保留为愿景章节，
  P0 实现明确写"task-type 查表 + 固定 multiplier"。


# 9. 下一阶段推进顺序（2026-10-04评估）

P0 已验收不等于整个架构完成。以下是基于 §1 风险约束的下一阶段建议；“待推进”不表示代码或真实验收已完成，也不自动开放公共 LP、第三方 provider ；游戏借款不在产品范围。

| 顺序 | 工作与当前缺口 | 完成判据和风险约束 |
| --- | --- | --- |
| 1 | 真实模型修复、strong 工具及 fallback：2026-10-06 K3真实工具及本地信用结算已验收；普通Relay未知保护已实现，2026-10-07已完成注入拒绝后真实备用调用；自然修复/自然供应商故障仍缺 | 用现有固定价 B 和独立 escrow 任务，在事先限定轮数、时间、模型费用和 gas 的实验内保存原始请求/响应、付款和最终判题。若自然产生错误再修复，才能记作真实自然修复；主动注入错误只能称故障演练。fallback 必须区分已知未交付和响应未知，后者暂停核对；保持一次任务提款、一次固定付款，不为了证明失败无限重试。真实模型调用不能只按运营报价控制 vendor 成本。 |
| 2 | 德州/GameFi 奖励闭环：替代原“继续迁移五子棋”的产品优先项 | 已实现本机运营网页开局、真实 Kimi 双人单手、USDC 奖后推理与 Kimi 专用额度发放/消费，练习也已持久化。每局额度总计 4096，由可信重放确认赢家；按实际 usage 扣减，未知结果保留预算，不自动重发。真实额度局已发放/消费，本轮新USDC局已于2026-10-06完成原存款及奖后真实推理，Agent1998现金余额0.09、借款0，root独立回执/usage核验通过。公开报名、多手真实赛事及可验证随机仍未开放；游戏不产生贷款、不写还款/违约。 |
| 3 | 规则驱动选档与受限选单：2026-10-07已实现并完成受控与单次真实选择消费验收 | 现有四题/受信provider/预设Open或本Agent的Assigned任务按能力、锁定报价、现金/显式creditLimit和期限选择，无可行项停止。统一workflow及HTTP接口已把自动接单、一次固定价B、Pi工具和独立Arena结算接通，并通过一次真实Kimi本地信用验收。宿主creditLimit不改变链上policy；单钱包writer、原UUID/签名/PaymentHandle恢复防止重复消费。不得信任任务文本中的改价/改收款地址指令，不引入通用多Agent框架或分类模型。 |
| 4 | 扩展任务覆盖：2026-10-07现有四题真实Kimi/本地信用结算及独立19项判题已验收；真实Monad仍主要验证求和 | 四题已用固定4次调用批次完成；下一项是选一个窄范围仓库修复任务，预先固定环境、权限、判定标准与支付条件。研究报告/网页制作没有明确验收规则前，不直接接入自动贷款清算。扩大执行权限须重新核查容器、网络、隐藏答案与密钥隔离。 |

读取性能与 RPC 稳定性作为上述步骤的共同验收条件：每步记录耗时和失败阶段，保留请求级诊断；不自动重买未知付费请求，不把一次 Alchemy 成功当作长期可用保证。现有 provider 准入、全局授信上限、身份重审、原子清算与退款防重放已有实现；后续每一步应保留这些约束，而非重新拆分13合约。

当前不应顺带实施：公共 LP/Senior–Junior、无托管收入授信、循环额度、第三方 provider 准入、独立 RevenueRouter/Validation Registry、通用仲裁。它们会改变 §1.1/§1.3/§1.5 的信任与资金风险，需要独立规格；不是完成现有 Pi/Magpie/棋牌边界的前置条件。

### 2026-10-04 用户确认：德州/GameFi 是预算获取路径，不做游戏借贷

Agent 推理预算不足或希望使用更强模型时，有两条并列路径：满足现有任务授信条件后借款购买推理；或参加德州扑克/GameFi，赢取可兑换的 LLM 推理额度或 USDC，再用于推理消费。借款不是无条件提款，继续遵守现有任务、身份、用途与额度约束。

游戏模块不发放贷款，不以预期奖金授信，也不把现有用途受限借款转作参赛筹码。“上杠杆”在此表达扩大可用推理预算的产品动机，不表示游戏内新增金融杠杆。游戏所得只有实际结算到账后，才成为可消费资源；输赢不直接记作任务还款/违约或提高信用评分。

目标玩法以德州扑克为先，五子棋验收不单独证明德州/GameFi 能力。当前已有双人单手规则、隐藏手牌隔离、可信裁判随机发牌、赞助测试 USDC 奖后消费，以及本机运营网页开局与 Kimi 额度发行/兑换。公开报名和完整赛事仍未开放；LLM token 只表示运营方发放的 Kimi 推理使用额度，不是加密代币、供应商价格或通用余额。

首版规则已确认免费参赛、赞助测试 USDC；本地双人德州和赞助奖励购买推理闭环已通过root验收（23项规则、4项集成），见[运行与证据](docs/holdem-arena.md)。后续实际Kimi单手对局、Monad赞助测试USDC入cash和奖金购买真实推理已完成，另有只读回放页。线上赞助资金治理与公开报名仍未开放。LLM 额度账本已实现累计发放、预留、实际 usage 扣减和未知状态保留；Magpie 周期预算不能代替该账本，游戏始终不做借贷。

## GameFi 当前实现（2026-10-05）

`/arena` 保留参考站的 UI/UX，业务使用 AgentFuel 的规则、真实模型流程与奖励政策。本机运营用户可在网页选择测试 USDC 或 Kimi 推理额度并发起德州比赛；`/api/arena/gamefi` 只调用服务端固定的两位 Agent 与原 CLI，浏览器不能指定钱包、模型、路径或赢家。`/arena/holdem` 继续作为历史公开回放与资金证据入口。尚未开放远程账号报名、任意提示词参赛、多手真实赛事或可验证随机，游戏始终不发贷款。

Kimi 额度由可信服务端重放终局发放：每局共 4096 token，独胜全额、平局各 2048；绑定 `kimi-k2.6` 和固定运营身份。`/api/arena/credits` 在调用前持久化兑换意图与预算预留，完成后按供应商实际输入和输出 usage 扣减。未知结果保留预留，重复兑换 ID 返回原状态或缓存，不再派发；超额用量保留实际扣减并阻止继续消费。它不是加密代币、USDC 余额或 Magpie 周期预算。

runner、额度 ledger 与四游戏练习均有本地持久化和 writer 锁。真实比赛按原 UUID、evidence 和交易 journal 恢复，不重开未知模型请求；练习保存规则重放、日志、席位和幂等请求，默认 `.data/arena-freeplay.json`，可由 `ARENA_PLAY_STATE_PATH` 指定。原子写入与 fsync 支持进程重启恢复，不能据此声称已有公网身份平台或分布式存储。练习 Bot 不调用真实模型，练习胜负不发放 USDC 或额度。

本轮真实额度局已向 Agent1999 发放 4096 token，实际 Kimi 消费 24，余额 4072；同兑换 ID 返回缓存。2026-10-06 新 USDC 局已完成独立验收：Agent1998获0.1测试USDC，原存款签名确认入cash，消费0.01完成1次真实Kimi推理（21输入+8输出=29 tokens），cash剩0.09、借款0。root fresh核对存款/付款canonical回执、付款块cash及本地原始模型响应；原对局报告未变，没有重复派奖。RPC仍可能间歇失败，本次成功不代表网络问题已消失。详见[本轮完成验收](demo-output/gamefi-complete-20261005-root/root-usdc-complete-20261006.json)。浏览器 16 项为受控接口测试，全部拦截 start/recover/redeem，不是交易证据。当前汇总见[本轮验收](demo-output/gamefi-complete-20261005-root/root-acceptance.json)，配置和恢复见[网页 runner](docs/gamefi-runner.md)、[额度规则](services/arena/src/inference-rewards/README.md)和[练习 API](docs/free-arena.md)。2026-10-04 的[UI 复刻验收](demo-output/arena-clone-20261004-root/root-acceptance.json)保留为历史，其仅内存存储与网页只读边界已由本轮实现替代。


## 2026-10-06 下一阶段：未知模型响应保护

2026-10-06 普通Relay失败处理已独立验收：派发前记录候选意图，未知响应不fallback、不重发、不直接退款；受信明确拒绝后才继续原同档候选。root新Anvil/受控上游Relay与SDK44/44、固定价B兼容28/28及全项目typecheck通过。固定价B原未交付全退契约保留。本批没有新增真实模型或Monad交易；真实strong工具、自然修复及真实fallback仍待有界验收。 运行规则与拒绝响应契约见[Relay README](services/provider-relay/README.md)，独立结果见[本轮验收](demo-output/relay-uncertain-20261006-root/root-acceptance.json)。


## 2026-10-06 Strong 工具真实验收（当前）

2026-10-06 strong-only真实工具验收已完成：新本地Anvil固定价信用任务经直营Kimi K3一次调用，输入307/输出86/总393 tokens，实际test_public_sample一次通过，独立Arena5/5并结算。现金40000+借款80000支付120000原始mock-USDC，费用12000、还款92000，最终cash58000、未偿0。root独立复跑12项受控脚本测试、全项目typecheck，校验原请求响应/签名/资金回执，并重新Docker判题5/5。首轮成功即停，没有人为错误或第二次模型调用，不证明自然多轮修复或真实fallback；本轮没有新增Monad交易、未经过Magpie，也不据usage推算vendor账单。 [独立验收](demo-output/live-strong-only-20261006-root/root-acceptance.json)，[复现与限制](packages/pi-loop/FIXED_PRICE.md)。这补齐此前“仅K3短探针、未验证工具”的缺口，旧运行仍保留各自原始范围。


2026-10-07：§9三项扩展的本轮验收已完成，详见[工程状态](docs/implementation-status.md#2026-10-07-本轮验收与剩余边界)。真实调用使用隔离本地账本，未新增Monad交易；自然故障/自然修复的证据缺口与窄范围仓库任务仍分别列为后续验证和新功能，不改写成已完成。


## 2026-10-07 后端收尾与 UI 交接

现有 P0 / 四道 Python 任务 / 本机运营 GameFi 后端的本轮交付见 [后端验收](docs/backend-acceptance.md)。新 `workflow` 使用纯规则选择，不先购买旧 selector 的原始推理；Open 接单、固定价 B、Pi 工具、独立 Arena、偿还与安全状态查询在一个持久请求中完成。HTTP 仅接受预设 profile 与 UUID，恢复复用原接单签名、PaymentHandle 和提交；未知请求不能靠换 UUID 重买。`npm run backend` 提供固定五角色启动和退出，GameFi 保留现有独立入口。

root 通过同款 Next 服务端桥接与真实 HTTP 完成一次 Kimi K2.6：190 输入 + 39 输出 = 229 tokens，付款120000（cash40000 + credit80000），偿还92000、最终cash58000、未偿0。接单/付款/结算三份回执已核对 canonical block，生成代码另经3项新Docker复判，原UUID恢复无新增消费。此为新本地Anvil/mock-USDC验证，没有新增Monad交易，也没有经过Magpie；旧Monad Task11和本轮Magpie实际进程回归分别作为各自证据。

剩余 UI 工作是预设任务控件、阶段/资金/错误展示、原请求恢复交互和桌面/手机浏览器验收。自然模型错误修复的观察证据、通用仓库任务、公开报名、第三方provider、公共LP和标准x402兼容，不应借“后端收尾”改写为已完成。
