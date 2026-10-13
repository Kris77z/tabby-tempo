# InferCredit — 赛道对齐与 Pitch 叙事

## 当前产品叙事（2026-10-11）

**Agent 交付后才能收到报酬，但交付前就需要购买推理与其他能力。AgentFuel 用信誉和已托管的任务报酬支持这笔执行信用。** 用户创建托管 Agent；同一个 Agent 可在不同任务中发布或接单，当前 Demo 以接单执行者展示，不宣称已有完整专家委托市场。

六项核心能力是信誉、借贷、游戏赚 token/资金、模型 LLM 统一网关、任务执行与独立验收、Pi 自主执行。演示聚焦两个底层 LLM 的报价与受限执行；免费德州奖励是资源补充支路。核心展示顺序为：现金不足 → 任务授信购买推理 → Pi 工具执行 → 独立验收 → 收入偿还本金与费用 → 信誉参与下一单授信。保留 **“Reputation you can spend.”** 作为主张，以实际记录说明信誉如何进入交易条件。

当前任务采用固定价求解；借入按量 token 额度、自动补额续跑与自主专家委托尚未完成。游戏奖励 token 是模型使用额度，不能描述为借贷代币；Pi 不能自行扩大预算。产品不提供 gas 赞助。角色定义与实现边界统一见 [当前产品主线](AGENT_CREDIT_ARCHITECTURE.md#当前产品主线2026-10-11-确认)。下文赛道、奖金和生态研究保留历史记录，未在本轮重新核实。

> **2026-10-01 开工口径同步**：P0 的具体行为以 ENGINEERING v5.3 与 TEST_PLAN 为准。
> 下文 demo 是验收目标，不是已上线状态；外部赛事/生态信息为研究时记录，提交前需核对。
> P0 使用协议自有资金池，为有 escrow 保障的 task loan 预支 API 成本；不开放公共 LP，
> 不宣传“无担保 LP 承担任务失败损失”。agent 不另交足额抵押，poster 的 escrow 承担不足部分。

> 配套文档三部曲：
>
> - `AGENT_CREDIT_ARCHITECTURE.md` —— 协议应该长什么样
> - `AGENT_CREDIT_RISK_AND_MVP.md` —— 攻击面与 P0 裁剪
> - 本文 —— 打哪个赛道、怎么讲故事、创新性与可落地性如何论证

---

# 1. 赛道结论

**主赛道：Track 4 — Trust, Identity & AI Infrastructure。**

Metropolis 四个赛道各 $30,000（3 队平分，每队 $10k），另有 $25,000 Grand Champion。

选 Track 4 的理由：

```text
官方示例直接点名
"agent identity/reputation under ERC-8004"
        ↓
我们的 ERC-8004 集成是深度集成
（金融声誉写回 + 信用飞轮）
        ↓
在一堆身份 / 溯源工具类项目里
"让 trust 产生经济后果" 是对赛道命题最有力的回答
```

**Pitch 弹药**：Track 1（Onchain Finance）的官方示例里有一条——

```text
"undercollateralized lending using onchain credit history"
```

这几乎就是我们。可以在 pitch 里点出：
**我们做的东西同时出现在 Monad 自己另一条赛道的示例里** ——
说明方向踩在主办方的期待上。
但不建议主打 Track 1：那边 best fit 是已上线的 DeFi 团队，
我们的信贷机制（无预言机、无清算）会被拿传统 DeFi 标准审。

---

# 2. Monad 上的官方事实（方案随之调整）

## 2.1 不要自己部署 ERC-8004 Registry

本次演示选用 Monad 测试网（chainId 10143）的 canonical registries：

```text
Identity Registry
0x8004A818BFB912233c491871b3d84c89A494BD9e

Reputation Registry
0x8004B663056A597Dffe9eCcC1965A193B7388713
```

ERC8004Adapter 直接指向官方地址。本地 fork 已验证钱包绑定与声誉写入；
真实部署尚未执行，证据见 `docs/day0-findings.md`。
这是加分项："我们跑在 Monad 的 canonical trust layer 上"。

## 2.2 Validation Registry = "coming soon"

Monad 上尚未部署。我们把 Validation 推迟到 P1 的决策
从"scoping 取舍"升级为"客观不可行"——
答辩标准回答：用 Tiered Validation 过渡，registry 上线即接入。

## 2.3 x402 是 Monad 官方认可的方向

Monad 官方 ERC-8004 文档明确写了
"agents can discover, verify, and pay each other autonomously using x402"。
叙事安全；但 facilitator / USDC 的实际可用性检查
（见 RISK_AND_MVP §6）依然要在动手前做完。

## 2.4 Smart Agent Account 蹭赛道另一个示例

Track 4 的第一条示例是 passkey-native accounts（P256 / WebAuthn, no seed phrase）。
我们的 Session Key + Spending Policy（主文档 §37）与之同源，pitch 里一句话连上：

```text
Agent 的密钥管理问题，
我们用 session key policy 解 ——
这是本赛道 passkey 命题的 agent 版。
```

---

# 3. 叙事倒装：Trust 当主语

主文档的叙事是 finance-first（主语是信贷，ERC-8004 是配角）。
Track 4 的评委不是 DeFi 评委，命题是 "trust 为什么是 infrastructure"。
所以整条叙事倒过来：**trust 是主语，credit 是 trust 的第一个杀手级应用。**

核心句：

```text
ERC-8004 回答了
Who can you trust?

InferCredit 回答了
What is that trust worth?
—— 用美元计价。
```

展开：

```text
今天 Agent 的 reputation
只是一个数字，没有任何经济后果。

InferCredit 是第一个给 ERC-8004 声誉定价的协议：

一个 Agent 的 InferScore
直接决定它能调动多少资本。

信用额度 = trust 的市场价格。
```

One-liner（按推荐排序）：

```text
1. Reputation you can spend.

2. Trust is the collateral.

3. The credit bureau of the agent economy,
   built on Monad's canonical ERC-8004.
```

Pitch 开场顺序调整：先展示 §38 的 **Agent Financial Identity 档案页**
（它是全部素材里最贴 Track 4 的资产，不要埋在中段），
再讲这份档案是如何被赚出来的。

---

# 4. 创新性论证（评委问"新在哪"时的答辩词）

三个创新点（主文档 §63）都能对照出"前人做到哪、我们多走一步"：

```text
Agent Fuel      Agent 怎么安全地花钱        （Spending）
Fianza          Agent 赚过钱才能借钱        （Past Revenue）
ERC-8004        Agent 是谁、信誉如何        （Trust）

InferCredit     这个 Agent × 这个 Task
                值不值得被融资              （Future Work）
```

一句话答辩词：

```text
所有前人都在回答 "Agent 有没有资格借钱"。

我们回答的是
"这个 Agent 接下来这一单活，值多少启动资金" ——

授信对象从 Agent 变成了 Agent × Task，
这是 Invoice Financing 第一次出现在 agent 经济里。
```

第二层创新（技术）：**Compute Underwriting** ——
协议不是问 Agent 想借多少，而是自己估算这单任务需要多少算力成本，
按 worst-case compute 授信。没有任何竞品做这件事。

第三层创新（生态）：**声誉的闭环定价** ——
还款结果写回 canonical Reputation Registry，
让 ERC-8004 第一次拥有"违约记录"这种硬金融信号。
我们不只是消费 trust layer，我们在反哺它。

---

# 5. 可落地性论证

评委对信贷类项目的天然怀疑是："哪来的真实借款需求？"
我们的答案分两层：

## 5.1 Demo 层：全链路真实运行，资金路径零 mock

这里定义交付标准：真实资金、registry 和服务联调通过后才使用“全真实”表述。
当前已通过的 Foundry mock 测试不构成该真实运行证明；缺容器而改人工验收时，讲稿必须明确披露。
三单金额与分数统一采用 ENGINEERING §6.1：协议费为 0，cash 依次 0.058 / 0.0787 / 0.105396；
前两单真实预置，第三单按 B 费率、结算后 710 分升 A；可借额度仍受本任务 LTV 限制。

```text
4 个合约（见 RISK_AND_MVP §4）
+
Monad canonical ERC-8004 registries
+
自营 Provider（Kimi / Qwen relay）
+
自营 Arena（见 §6）
        ↓
借款 → 买算力 → 完成任务 → 验收 → 还款 → 声誉上升 → 额度上升

整个飞轮在 demo 里现场跑完，
每一步都是真实链上交易。
```

外加 30 秒反向 demo（攻击被链上拦截，见 RISK_AND_MVP §7）。

## 5.2 冷启动层：任务从哪来（这就是 Arena 的真正角色）

双边市场的冷启动问题（没任务就没借款需求），
我们的答案是：**第一个任务市场由协议自营。**

见下一节。

---

# 6. Arena / 游戏的正确用法：是证明，不是故事

团队内部有一个直觉：「earn 也可以打，游戏赚 token」。
这个直觉**一半是对的**，但方向要摆正。

## 6.1 为什么不能当主叙事

```text
"游戏赚 token"
        ↓
评委 pattern-match 到
Play-to-Earn / GameFi
        ↓
这是一个已经被证伪过一轮的叙事
```

主文档 §64 自己写了"我们不是 Agent GameFi"——这条红线保留。
Track 4 的评委要 infrastructure，不要 GameFi。

## 6.2 为什么它又是必需的

InferCredit 最难的落地问题是**任务供给冷启动**：
Task-backed credit 需要"真实存在、reward 已托管、可验收"的任务，
黑客松期间外部任务供给是零。

**Arena（Coding Arena）恰好是这个问题的解**：

```text
协议自营 Arena
        ↓
发布带 hidden tests 的编程任务
reward 真实托管
        ↓
任务天然可验收（10/10 tests PASS）
        ↓
Agent 借算力 → 参赛 → earn → 还款
        ↓
信用飞轮有了第一个真实转动的场景
```

所以 Arena 的定位是：

```text
不是 "Agent 玩游戏赚钱"（GameFi）

而是 "协议自营的第一个任务市场"
（可验证工作的受控实验场）
```

类比着讲：**Uber 早期自己雇司机，Amazon 早期自己进货。**
双边市场先自营供给侧，是最经典的冷启动打法——
这样讲，Arena 从"游戏噱头"变成"冷启动方法论"，评委听到的是成熟度。

## 6.3 Earn 在 pitch 里的位置

```text
✓ 放在可落地性论证里：
  "任务哪来？我们自营 Arena，demo 全真实"

✓ 放在飞轮 demo 里：
  earn 是还款来源，是闭环的必要一环

✗ 不放在开场，不当 headline，
  不使用 "play to earn" / "游戏赚币" 字眼
```

对外话术统一用：

```text
Verifiable Work Arena
```

不用 "game"。

2026-10-03 展示口径补充：当前实际题库是求和、去重排序、括号匹配、词频统计四道 Python 题，
真实 Monad 演示使用求和题。当前 Agent 由脚本安排一次模型生成，没有自主选单或多轮修复；
违约样例为显式构造失败。外部修 bug 任务是扩展方向，不应由下表的渠道规划推断为已有接入。

显式cheap/strong路由已通过本地验收；2026-10-04真实K2.6/K3 API各一次128输出上限短探针均
最终OK/stop，资金只用新本地Anvil/mock-USDC，测试网页面与旧demo配置未切换。运营价0.01/0.03
不是上游成本/实际账单，不证明能力差异或真实链两档付款；原链关闭且首版未存raw receipt，
本次保存证据审计不能独立复读原ProviderPaid事件。受限Pi cash循环已通过受控验收，新增真实K2.6单轮工具调用、公开样例PASS与独立Arena本地结算。只1次模型请求，无预置错误，未证明真实两轮修复/strong工具/Monad Pi；不称为自主选单或多轮借款。细节见ENGINEERING §6.6。
不能宣称换便宜上游就自动降低客户账单或提高 InferScore，也不能宣称接入 Pi 后自动具备多轮借款。
棋牌现金对战已在扩展范围落地，验收状态见文末；“能判断胜负”不等于“奖金是每个 Agent 的确定应收款”，共享奖金不能重复授信。

## 6.4 Earn 渠道全景（评委问 "Agent 怎么赚钱" 时的一页答案）

Play 只是 Arena 的一个子类型，Arena 又只是三条 earn 渠道之一：

| Earn 渠道 | 形态 | 可验收性 | 支撑的信用等级 | 状态 |
|---|---|---|---|---|
| **Task Reward** 外部任务佣金 | 真实任务 + reward 托管（如修 bug） | Hidden tests / 验收回调 | Level 2 Task-backed | **P0 demo 主线** |
| **Arena Reward** 自营竞赛 | 编程题竞赛；五子棋现金对战 | Hidden tests；独立裁判验证对局胜负 | 编程题为 Level 2 Task-backed；五子棋为对战原型；德州免费赞助测试USDC奖励及奖后真实推理已落地，游戏不做借贷 | 编程信用路径已验收；棋牌规则与付款已实现，真实整局限制见文末 |
| **Service Revenue** A2A 服务收入 | Agent 经 x402 向人类/其他 Agent 卖服务 | 收款流水（须走协议 rails 才计入，RISK §1.5） | Level 3 Revenue-backed | 叙事层（Agora Mesh 已验证方向） |

一句话版本：

```text
Agent 靠三种方式赚钱：
接单（Task）、比赛（Arena）、卖服务（Service）。

前两种 reward 可托管、结果可验收
—— 所以它们能撑起 Task-backed credit；

第三种是持续现金流
—— 它撑起下一阶段的 Revenue-backed credit。
```

出处索引：三条渠道的正式定义在主文档 §48（RevenueRouter 认可收入），
A2A 服务方向在主文档 §51，协议 rails 约束在 RISK_AND_MVP §1.5。

---

# 7. Pitch 结构建议（3 分钟版）

```text
0:00  Agent Financial Identity 档案页亮相
      "这是 Agent #1842 的信用档案，
       它的 reputation 可以花。"

0:30  问题：Agent 赚钱之前也要先花钱。
      谁给它第一笔钱？为什么？

1:00  答案：ERC-8004 告诉你能不能信它，
      InferCredit 告诉你这份信任值多少钱。
      Agent × Task 授信 + Compute Underwriting。

1:30  Live demo：Arena 任务 → 借款 → 调用 API →
      验收 PASS → 原子还款 → 链上声誉上升 → 额度上升。

2:15  反向 demo：借来的钱转向未白名单地址 → revert。

2:30  生态位：跑在 Monad canonical ERC-8004 上，
      给 trust layer 反哺违约/还款信号；
      x402 是支付层，我们是资本层。

2:50  收尾 one-liner：
      "Reputation you can spend."
```

---

# 8. 创新 × 可落地 自检表

| 评委追问 | 答案所在 |
|---|---|
| 和 Fianza 什么区别？ | §4：授信对象 Agent → Agent × Task |
| 和 Aave credit delegation 什么区别？ | 信用属于 Agent 而非 Owner；主文档 §16 |
| Agent 没有抵押，资金如何保障？ | P0 的托管 reward 与 I6 覆盖债务；失败先扣 cash，再补扣 poster escrow；RISK_AND_MVP §1 |
| 任务需求哪来的？ | 自营 Arena 冷启动；本文 §6 |
| Agent 怎么赚钱？ | 三条渠道：接单 / 比赛 / 卖服务；本文 §6.4 |
| 资金从哪里来、如何收费？ | P0 为协议自有资金池，按实际提款收 factor fee；公共 LP 的份额与收益模型属于 P1+；RISK_AND_MVP §2 |
| ERC-8004 是不是贴 logo？ | canonical 地址 + 声誉写回闭环；本文 §2、§4 |
| Validation Registry 为什么没接？ | Monad 上 coming soon，Tiered Validation 过渡；本文 §2.2 |


2026-10-04更新：固定价信用B不仅有受控测试，也已通过实际Magpie→真实Kimi→Pi工具→独立Arena本地融资还款验收（draw80000/fee12000）。随后Monad Task11经真实Magpie/Kimi/Pi和独立Arena完成链上结算：借款14604、fee438、偿还15042，最终cash134958、还款4、未偿0（6位测试USDC），root复读canonical回执与余额通过，见[工程状态](docs/implementation-status.md)。五子棋双Agent现金对战与独立裁判已落地；受控整局胜负/恢复通过，新真实Kimi对局12合法步、13次调用付款后，黑方截断响应格式无效，白方按既定规则forfeit胜（非五连胜），root独立重放与付款审计通过；仅本地mock-USDC结算，旧503暂停局保留历史。共享奖金授信、A按用量退款、自动by-intent不能作为已实现能力对外叙述。

### 2026-10-04 用户确认：德州/GameFi 是预算获取路径，不做游戏借贷

Agent可以按现有任务规则借款购买推理，也可以参与德州赢取推理额度或USDC。两条路径并列；游戏不放贷，不以预期奖金授信。目标是德州，五子棋只是已验收原型，德州规则及赞助测试USDC奖励购买受控推理的本地闭环已验收；后续真实Kimi对局、Monad赞助测试USDC入cash及奖金购买真实推理和只读回放页也已落地；LLM额度兑换及公开报名仍待实现，见[德州运行](docs/holdem-arena.md)。完整范围以 [ENGINEERING §6.6](AGENT_CREDIT_ENGINEERING.md) 和 [风险文档 §9](AGENT_CREDIT_RISK_AND_MVP.md#9-下一阶段推进顺序2026-10-04评估) 为准。
