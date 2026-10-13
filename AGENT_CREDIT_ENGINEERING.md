# InferCredit — 工程实施计划（Hackathon 版）

> **2026-10-11 产品范围同步**：[当前产品主线](AGENT_CREDIT_ARCHITECTURE.md#当前产品主线2026-10-11-确认) 固定信誉、借贷、游戏奖励、Magpie 模型网关、执行/独立验收、Pi 自主执行六项能力。Agent 的发布者/接单者是任务内角色，当前用户入口仍是托管执行 Agent。Demo 限定两个底层 LLM，报价来自 Relay；固定价 B、上游 usage 与借贷费用不可混写。两模型托管网关联合验证、专家委托、按量额度借贷/自动续跑是后续工作。Pi 权限/轮数/预算有界，选单选档由配置规则决定。产品不提供 gas 赞助；下文 10-07 的受限 gas sponsor 是已有可选工程能力，不能据此宣传用户获赞助。前端最新证据见 [10-11 验收](docs/frontend-release-acceptance-20261011.md)。

> **2026-10-07 托管 Agent 扩展**：产品入口确定为用户在平台创建托管 Agent。已新增签名登录、独立托管钱包、动态链上开户、受限 gas 赞助、幂等入金、任务/比赛调度及 owner 隔离。原预设 TaskRunner/GameFi 入口保留作运营兼容；用户入口是 `/api/hosted/*`。本轮新链路已通过本地 Anvil + 受控模型整体验收，不代表新 Monad 用户已上线。见 [托管交付](docs/hosted-acceptance.md)。

> 文档四部曲的最后一篇：
>
> - `AGENT_CREDIT_ARCHITECTURE.md` —— 协议长什么样
> - `AGENT_CREDIT_RISK_AND_MVP.md` —— 攻击面与 P0 裁剪
> - `AGENT_CREDIT_TRACK_NARRATIVE.md` —— 赛道与叙事
> - 本文 —— 怎么把它做出来：技术栈、repo 结构、合约接口、服务、周计划
>
> **原计划时间盒：2026-09-14 → 2026-10-13；以下日期为原定排期，不代表已完成。**
> **Demo 冻结日定在 10-10（周六），留 3 天缓冲做视频和提交材料。**

> **2026-10-07 当前交付范围**：P0 四合约、授信、Relay/SDK、Docker 判题与前端已验收；
> Monad 测试网七轮真实业务结算已完成（六次还款、一次违约），主角第三次还款从 640/B 升至 710/A。
> 合约离线验收为 408 tests：404 passed / 0 failed / 4 skipped。详细证据和测试边界见
> [implementation-status](docs/implementation-status.md)，§9 是演示验收范围，不代表本文全部长期规划已实现。
> 2026-10-07 新统一后端已接通预设选单→Open 接单→一次固定价 Pi 消费→独立 Arena→还款；HTTP 发起、轮询、原 UUID 恢复与五进程启动入口已落地。当前验收与 UI 交接见 [后端交付](docs/backend-acceptance.md)。外部 RPC 的长期可用性不由一次成功保证。
> **§6.6 扩展已验收：真实 Magpie/Kimi/Pi 固定价信用服务在 Monad Task11 完成还款；五子棋真实模型对局以格式违例判负终局，费用仍在本地现金结算。德州真实 Kimi → Monad 赞助测试 USDC → 真实推理消费已有历史验收；网页真实开局、4096 Kimi 额度发放/消费及练习持久化已实现，当前验收见文末。真实四题固定价求解与“注入拒绝后调用真实备用模型”已于2026-10-07验收；自然多轮修复、自然供应商故障仍没有真实运行证据。**
> 后续新增范围按 [RISK_AND_MVP §9](AGENT_CREDIT_RISK_AND_MVP.md#9-下一阶段推进顺序2026-10-04评估) 判断；现有后端收尾不扩展公共 LP、通用仓库任务或公开游戏赛事，也不改变 §4 资金不变量。

## 开工依据与边界

- 本文 §4 定义 P0 行为；`contracts/src/interfaces/` 及合约公开入口提供准确类型与 ABI，`contracts/TEST_PLAN.md` 提供行为到测试的索引和实现顺序。
- 架构文档保留长期方案；公共 LP、独立 RevenueRouter、Senior/Junior、Validation Registry 等不是 P0 实现要求。
- 已裁决默认值：任务创建时快照协议费；P0 不自动补足 backstop；deadline 后 settle/expire 按链上执行顺序裁决；多条件错误优先级暂不规定。
- 如果实现暴露规格与测试冲突，按具体用例一起修正；不要为通过错误断言放宽资金或权限约束。历史 `REVIEW_CODEX*.md` 保留审查记录，不是另一个待实现版本。
- 真实链上联调前完成 §3 的网络、资产、canonical registry 和签名兼容验证；mock 与 ABI 字符串对拍不能替代真实调用。

---

# 1. 技术栈（定死，不再讨论）

```text
合约        Foundry + Solidity ^0.8.24
链下服务    TypeScript + ethers v6 + tsx        （与 Monad-Rebel 完全一致）
Monorepo    npm workspaces                      （与 Monad-Rebel 完全一致）
前端        Next.js（沿用 Monad-Rebel frontend 骨架）
Indexer     P0 不做 —— 前端直接读合约 view + 事件日志
数据库      P0 不做 —— Underwriter / Arena 用 JSON 文件存储
            （Monad-Rebel 的 feedback-store / memory 模式）
```

原则：**凡是 Monad-Rebel 已有的模式，照抄，不发明新的。**
四周时间的敌人是决策成本，不是代码量。

---

# 2. Repo 结构

```text
agentfuel/
├── contracts/                  # Foundry 项目
│   ├── src/
│   │   ├── CreditManager.sol
│   │   ├── AgentAccount.sol
│   │   ├── TaskEscrow.sol
│   │   └── ERC8004Adapter.sol
│   ├── test/
│   └── script/                 # 部署脚本
│
├── packages/
│   ├── erc8004/                # ← 从 Monad-Rebel shared/src 抽取
│   │   └── src/
│   │       ├── identity.ts     #    erc8004.ts 原样迁入
│   │       └── reputation.ts   #    erc8004-reputation.ts 原样迁入
│   └── sdk/                    # Credit-aware 402 client
│       └── src/
│           └── infer.ts        #    infer.fetch() 入口
│
├── services/
│   ├── underwriter/            # Tier 查表 + EIP-712 签名
│   ├── provider-relay/         # 自营 Provider（Kimi / Qwen 代理，402 收款）
│   └── arena/                  # 任务发布 + hidden tests 执行 + 验收回调
│
├── frontend/                   # Agent Financial Identity 档案页 + demo 面板
│
├── scripts/
│   └── demo.ts                 # 端到端飞轮脚本（对齐 Monad-Rebel `npm run demo`）
│
└── *.md                        # 本文档四部曲
```

从 Monad-Rebel 直接搬入 `packages/erc8004` 的文件：

```text
shared/src/erc8004.ts              （register / setAgentWallet / EIP-712 双 profile）
shared/src/erc8004-reputation.ts   （giveFeedback / getSummary）
shared/src/types.ts 中的 402 payment schema
```

不搬：agent-registry.ts、dynamic-service-store.ts、feedback-store.ts
（那是 Agora Mesh 自己的 service discovery，见主文档 §53）。

**外部代码复用（许可合规）**：Agent Fuel 为 Apache-2.0，
其 Spend Policy / Vault / x402 SDK 的实现可依法参考或复用——
复用代码时保留其 LICENSE、在 repo 根加 NOTICE 注明来源、
被复用文件头部保留 attribution 注释。Tutti（任务编排参考）同为 Apache-2.0，同样处理。
黑客松评审会看 originality：**建议只复用工具层代码（SDK/402 flow），
核心合约（四合约）保持自写**，README 里主动披露复用清单，比被发现更体面。

---

# 3. Day-0 Spike（可与本地合约实现并行，真实部署与联调前完成）

以下保留 Day-0 当时的核验记录，框内“尚未执行/待确认”仅指该历史阶段，不代表当前状态。后续测试资产、真实注册/反馈、部署及 Kimi 推理均已完成，当前证据以 [implementation-status](docs/implementation-status.md) 为准；标准 x402 兼容性仍未验收。原检查顺序如下：

```text
✓ 1. 用户确定演示网络为 Monad Testnet，chainId 10143。
     143 是主网。faucet 领取、真实部署以及赛事对提交网络的要求仍需后续确认。

✓ 2. 测试网 canonical registry 的只读与本地 fork 验证已通过：
     Identity   0x8004A818BFB912233c491871b3d84c89A494BD9e
     Reputation 0x8004B663056A597Dffe9eCcC1965A193B7388713
     固定区块 67277702；钱包绑定、transfer 清空 wallet、Adapter 报告者过滤、
     1-based feedback 均实际通过。详情与重跑命令见 docs/day0-findings.md。
     主网 0x8004A169… / 0x8004BAa17… 在该测试网区块无代码，不可混用。
     fork 写入只在本地发生，真实注册与反馈广播尚未执行。

✓ 3. 用户确定结算资产为测试 USDC（6 位小数）：
     0x534b2f3A21130d7a60830c2Df862319e593943A3
     本轮只读核对了 symbol / decimals。测试 MON 用于 gas。
     P0 付款路径仍为自建 402 quote → AgentAccount.payProvider → receipt 重试。
     官方 facilitator 存在不代表当前合约已兼容标准 x402；标准 scheme 和
     verify/settle 尚未联调，不能据此声称兼容。facilitator 只读连接本轮失败。
     合约构造参数仍同时支持 address(0) 原生 MON 与 ERC-20；
     原生币入金校验 msg.value，ERC-20 入金用 approve + safeTransferFrom。
     Tier 金额用整数最小单位，USDC 为 10^6；MON 固定换算，不引入 oracle。

□ 4. Kimi / Qwen API key 就位，provider-relay 能真实转发一次推理请求。
```

Day-0 结束时必须能回答："demo 里那笔钱，是什么资产，走哪条路。"

---

# 4. P0 合约实现规格（v5.3 —— 本地实现已验收）

> v5.3（2026-10-01）：六批实现与独立验收完成。补齐退款后零债务提前关闭、
> 已收 fee 按累计退款进度返还、default 反馈由 Manager 持有并由 Escrow 代理重试、
> ERC-20 push 清算的确切 allowance 金额通道，以及到期 OR 条件的防溢出判断。
> 部署脚本在转 uint16 前校验 BPS ≤ 10_000；超杠杆只保留在隔离测试夹具。

> v5.2（2026-10-01）：同步 Task 枚举与字段、费率快照、registerRefund、
> 累计 recovery、身份重审/解冻、canonical ABI、错误分层和 P0 风险归属。
> 只回填已确认规则，不新增产品范围。下面 v2–v5.1 为历史变更记录。

> v5.1（review r5，两处局部修正）：processRefund 增加 amount 与
> refundId 参数（ERC-20 可表达退款额；分次退款累计封顶 + refundId
> 防重放，取代与部分退款矛盾的"二次调用 revert"）；Escrow 的
> settle/expireTask 分流改按 loan.status 判定（Active 才还款/清算，
> None/ClosedByRefund 直接分配资金），ClosedByRefund 正式接入任务分支。

> v5（review r4）：清算入口拆分 push（liquidateWithEscrow payable）/
> pull（liquidateExpiredLoan，贷款超时与任务到期均为独立触发原因，
> underwriter 保证 loanDueAt ≤ task.deadline）；expireTask 有 loan 走
> push 防调用环；退款状态转换闭合（ClosedByRefund / 部分退款 /
> Repaid 后退款 / Defaulted recovery 逆序含 poster，按 liquidations
> 记录的实际承担额封顶）；creditCash 扩权给 Manager；PaymentRecord
> 增加 agentId。三单 demo 数值已经外部复核成立（0.058 / 0.0787 /
> 0.105396，第三单 710 分升 Tier A）。
> **本版冻结：后续问题以 Foundry 测试暴露为准，不再做纯文档轮次。**

> v2：授信绑定任务状态机与调用者、每任务单次 draw、双期限、
> 统一清算入口、声誉写入非阻塞、paymentId、custom error、identityVersion。
> v3（review r2）：I6 修正 /10_000 与 fee 计入债务侧；I3 双重校验；
> 清偿顺序 cash 优先；清算状态机三分支；Adapter enroll/reapprove；
> relay 付款状态机；容器隔离；Tier 还款门槛。
> v4（review r3）：补齐跨合约资金入口（creditCash / debitForLiquidation /
> releaseForLiquidation）与 §4.6 调用表 + 防重入原则；任务 deadline 与
> cancel/expire 出口；processRefund 退款冲减债务；裁决改为宿主持答案
> 比对输出；underwriter 按 I6 预裁剪 principalCap；demo 余额工程化。
> §4.5–§4.6 是实现验收标准；对应 P0 业务实现和合约验收已完成，当前状态以 implementation-status 为准。
> 下列代码为接口摘要，完整声明以 `contracts/src/interfaces/` 和对应合约公开入口为准。

公共约定：金额单位统一为结算资产最小单位；`taskId` 全局唯一由 TaskEscrow 分配。

## 4.1 ERC8004Adapter.sol

Canonical 接口使用八参数 `giveFeedback(uint256,int128,uint8,string,string,string,string,bytes32)`；
`getSummary(uint256,address[],string,string)` 返回 `(uint64,int128,uint8)`。
取自评审时核对的 [ERC-8004 规范](https://eips.ethereum.org/EIPS/eip-8004)，目标部署仍须 §3 验证。
反馈作者不得为 agent owner/approved operator；外部 feedbackIndex 从 1 开始。
钱包绑定接口为 `setAgentWallet(agentId,newWallet,deadline,signature)`；身份转移会清空 wallet。
测试替身的签名、operator approval 等简化见 TEST_PLAN §3.4，不构成真实部署兼容证明。

```solidity
contract ERC8004Adapter {
    IIdentityRegistry   public immutable identity;    // canonical 地址
    IReputationRegistry public immutable reputation;

    struct AgentSnapshot { address owner; address wallet; uint64 version; }
    mapping(uint256 agentId => AgentSnapshot) public snapshots;

    /// 实时读 canonical registry（支付/授信的钱包核对一律用它，不用快照）
    function resolveAgent(uint256 agentId)
        external view returns (address owner, address wallet);

    /// 实时值与快照比对；owner 或 wallet 变化 → true
    /// draw 的 I3 必须同时满足：!identityChanged() && 版本号匹配
    /// （review r2 #2：版本号不替代实时校验，缓存未刷新时二者仍相等）
    function identityChanged(uint256 agentId) external view returns (bool);

    /// 快照生命周期（仅 CreditManager 可调）：
    /// enroll(agentId)    首次初始化，version = 1
    /// reapprove(agentId) 重新审批入口 —— 唯一能刷新快照并递增 version 的路径，
    ///                    由 underwriter 重审后经 CreditManager 触发；
    ///                    version 递增即作废所有旧 CreditAuthorization
    function enroll(uint256 agentId) external onlyCreditManager;
    function reapprove(uint256 agentId) external onlyCreditManager;

    /// TaskEscrow 结算时写声誉（tag1="infercredit"）
    function reportFeedback(
        uint256 agentId, string calldata tag2,
        int128 value, uint8 valueDecimals
    ) external returns (bool ok);   // onlyReporter (TaskEscrow / CreditManager)
    // Adapter 内部 catch registry 失败并返回 false；调用者登记 pendingFeedback。
    // registry 的 client 是直接调用它的 Adapter，与 catch 位于哪层无关。
    // 外部反馈失败（包括耗尽转发 gas）不能回滚资金清算，需为后续记账保留 gas。
}
```

## 4.2 CreditManager.sol（含 vault + 全局限额）

```solidity
struct CreditAuthorization {
    uint256 agentId;
    uint256 taskId;
    uint256 principalCap;    // 最多可 draw 的本金
    uint16  feeBps;          // factor fee，按实际 draw 金额计（review #2）
    uint8   riskTier;
    uint64  identityVersion; // 身份轮换后旧授权作废（review #9）
    uint256 authDeadline;    // draw 时 block.timestamp <= authDeadline（含等号）
    uint256 loanDueAt;       // 还款期限：此后 + GRACE 可经 liquidateExpiredLoan 清算
    uint256 nonce;
    bytes32 evidenceHash;
}
// EIP-712 domain: name="InferCredit", version="1", chainId, verifyingContract
// P0 规则（review #2）：每 task 仅允许一次信用提款。
// draw 时同时消费 nonce 和 taskId，多次/分次提款整体后移到 P1。
// nonce 是每 agent 的未消费集合，不要求链上单调；客户端递增仅为生成策略。

enum LoanStatus { None, Active, Repaid, Defaulted, ClosedByRefund }
// ClosedByRefund：退款后剩余债务归零即关闭（v5.3）——
// 不计正常还款、不写 repayment 反馈、也不进入违约

struct TaskLoan {
    uint256 agentId;
    uint256 principal;
    uint256 fee;            // draw 时按 principal × feeBps 定格
    uint256 loanDueAt;
    LoanStatus status;
}

contract CreditManager {
    // ---- 资金池：P0 为协议自有资金池（review #8）----
    // 不开放公共 LP 存取；deposit/withdraw 仅 treasury 多签可调。
    // LP 份额会计（存款权益/费用归属/损失扣减/可提流动性）P1 再定，
    // 定不清楚之前接口不对外。backstop 独立记账，永不计入可贷余额。
    // 原生币模式下所有入金函数（deposit / fundBackstop / depositCash / repay）
    // 一律 payable 且校验 msg.value == amount；ERC-20 模式校验 msg.value == 0
    // 并 safeTransferFrom（review r2 联调细节 #1）
    function deposit(uint256 amount) external payable onlyTreasury;
    function withdraw(uint256 amount) external onlyTreasury;

    // ---- 全局限额（RISK_AND_MVP §1.3，一行不能省）----
    uint256 public maxTotalOutstanding;  // 未偿本金 + 未偿 fee 的上限
    uint256 public maxDrawPerEpoch;      // epoch = 1 day，只计新增本金；退款不恢复本 epoch 预算
    bool    public drawPaused;           // guardian 一键暂停
    mapping(uint256 => uint256) public drawnInEpoch;

    // ---- Owner backstop ----
    mapping(uint256 agentId => uint256) public backstop;
    function fundBackstop(uint256 agentId, uint256 amount) external payable;

    // ---- 借款：仅 AgentAccount 可调，同笔交易内钱必须流向 provider ----
    function draw(
        CreditAuthorization calldata auth,
        bytes calldata underwriterSig,
        uint256 amount
    ) external onlyAgentAccount;
    // 校验清单 = §4.5 不变量 I1–I7，逐条 require，缺一不可：
    // 尤其是 I4（task 存在且 Assigned 且 task.agentId == auth.agentId）
    // 和 I6（含 fee 的债务总额 ≤ 扣协议费后 escrow × LTV，
    //        完整公式以 §4.5 I6 为准，此处不重复以免两处失同步）

    // ---- 退款冲减（review r3 #3 + r4 #1/#2 + r5 #1）----
    function processRefund(bytes32 paymentId, uint256 amount, bytes32 refundId)
        external payable onlyRelayRefunder;
    // amount = 本次退款额（原生币校验 msg.value == amount；
    //          ERC-20 校验 msg.value == 0 并 safeTransferFrom）
    // 幂等与部分退款统一（r5 #1，二者不再互相矛盾）：
    //   支持分次退款，累计 refundedAmount 不得超过原支付金额；
    //   防重放靠独立 refundId（每个 refundId 只执行一次，重试携同一 ID）
    // Active 分支按 PaymentRecord 的 fromCash/fromCredit 原比例拆分；
    // 全额 = 整笔 payment 的 fromCash + fromCredit 全退，不是仅退到 credit 金额。
    // 用累计应得份额减已分配份额，避免逐笔舍入造成残余 wei；最后一笔归零。
    // None 的纯 cash 支付按 PaymentRecord.agentId 全额退回 cash。
    //
    // 按 loan 当前状态分支（review r4 #2，退款状态转换必须闭合）：
    //   Active + 全额退款  → 冲减全部本金；未收取的 fee 直接免除
    //                        （已收取的 fee 原路退回 agent cash）；
    //                        loan → ClosedByRefund，到期不再触发清算
    //   Active + 部分退款  → 本金最多冲减当前剩余本金，已清偿部分对应退款进 cash；
    //                        fee 按累计退款额/原支付总额计算累计减免，再取本次差额，
    //                        先免未收 fee，再从实收且未返还的 fee 中退回 cash。
    //                        剩余债务为 0 即 ClosedByRefund，否则保持 Active。
    //                        部分还款或整数舍入均可能使关闭早于整笔 payment 退完。
    //   ClosedByRefund    → 后续退款全额入 cash，并返本次新增比例的已收 fee；
    //                        不因提前关闭而提前全返 fee
    //   Repaid            → 债务已清，退款全额入 agent cash，
    //                        绝不再次冲减已清偿本金
    //   Defaulted         → recovery，按各方【实际承担额】逆序回补
    //                        （review r4 #1，poster 不能漏）：
    //                        未回收 LP 损失 → backstop 实际扣额
    //                        → poster 的 escrow 实际罚没额 → agent cash 实际扣额，
    //                        每层本次可回补额 = 原始承担额 − 此前累计回补额；多余退款进 agent cash
    // 通用规则：不计正常还款次数、不写 repayment 反馈；
    //   链下 Refunded 标记必须以本入口的链上成功为依据，不得只改 JSON

    // 清算承担额记录（recovery 的依据，_liquidate 时写入）：
    struct LiquidationRecord { uint256 cashUsed; uint256 escrowSlashed;
                               uint256 backstopUsed; uint256 lpLoss;
                               address poster; }
    mapping(uint256 taskId => LiquidationRecord) internal _liquidations; // 永久保留原始承担额
    mapping(uint256 taskId => LiquidationRecord) internal _recovered;   // 各层累计已回补额
    function getLiquidation(uint256 taskId) external view returns (LiquidationRecord memory);
    function getRecovered(uint256 taskId) external view returns (LiquidationRecord memory);
    // agentId 从永久保留的 loans[taskId] 读取，不另存一份归属字段。

    // ---- 还款：仅 TaskEscrow 成功结算时调，支持部分偿付 ----
    function repay(uint256 taskId, uint256 amount)
        external payable onlyTaskEscrow returns (uint256 applied, uint256 remaining);
    // 顺序：fee 先、principal 后；applied < 债务总额时 loan 保持 Active。
    // applied 是实际偿付额，remaining 是剩余债务；超出债务的入金原路退回 Escrow。
    // 正常 LTV 下成功结算可足额还款，部分偿付分支以独立 repay harness 验证。
    // 足额偿付 → Repaid。此函数只服务成功路径；
    // 清算路径的回收走 liquidate 内部记账，终态恒为 Defaulted（review r2 #5）

    // ---- 清算入口一分为二（review r4 #3/#4：push/pull 不混用，权限对齐）----

    /// push 型：Escrow 侧发起（settle(false) 或 expireTask 有 loan），
    /// Escrow 已自行终结任务、清空 escrow，随调用把全额 escrow 打进来
    function liquidateWithEscrow(uint256 taskId, address poster)
        external payable onlyTaskEscrow;

    /// pull 型：贷款超时，任何人可调（此时不在 Escrow 调用栈内，无锁冲突）；
    /// 经 releaseForLiquidation 取 escrow 并终结任务
    function liquidateExpiredLoan(uint256 taskId) external;
    // 触发条件（review r4 #3，两个期限统一为独立清算原因，满足其一即可）：
    //   block.timestamp > loanDueAt + GRACE   （贷款超时）
    //   或 block.timestamp > task.deadline    （任务到期且有 Active loan）
    // 另一约束在授信侧收口：underwriter 保证 loanDueAt <= task.deadline，
    // 使"贷款未到期而任务已到期"只剩 GRACE 窗口这一种边界

    // 两个入口汇入同一内部函数：
    // _liquidate(taskId, escrowFunds, poster)
    // 清偿顺序（review r2 #4：cash 在前，才兑现"保护 poster"）：
    //   1. agent cash 余额（协议级扣款，不受 ownerFrozen/Policy 阻止）
    //   2. escrow slash（补不足部分，上限 = 剩余债务）
    //   3. backstop
    //   4. 剩余 = 池子损失（字段沿用 lpLoss；P0 出资方为 treasury）；未用 escrow 当场退 poster
    // 各方实际承担额写入 liquidations[taskId]（recovery 依据，r4 #1）
    // 违约事实与实际损失分离（review r2 #5）：
    //   进入清算即 loan 置 Defaulted、冻结 agent、写 default 声誉 ——
    //   足额回收（loss = 0）也不改写终态、不计正常还款

    function freezeAgent(uint256 agentId) external;   // guardian / 经验证的 identity 变更
    function enrollAgent(uint256 agentId) external;    // P0 guardian 操作，转调 Adapter.enroll
    function reapproveAgent(uint256 agentId) external; // P0 guardian 经重审后转调 Adapter.reapprove
    function unfreezeAgent(uint256 agentId) external onlyGuardian;
    // 解冻不修改 defaultCount、loan 终态或身份快照；重审才刷新快照/递增版本。
    // 身份校验失败的 revert 不会持久化冻结位；需持久冻结时另行成功调用 freezeAgent。

    event LoanOpened(uint256 indexed taskId, uint256 indexed agentId,
                     uint256 amount, uint8 tier);
    event LoanRepaid(uint256 indexed taskId, uint256 principal, uint256 fee);
    event LoanDefaulted(uint256 indexed taskId, uint256 loss,
                        uint256 escrowSlashed, uint256 cashUsed, uint256 backstopUsed);
}
```

## 4.3 AgentAccount.sol（含 SpendPolicy + Provider 白名单）

P0 用**单例合约 + 内部账户**（`mapping(agentId => Account)`），
不做每 Agent 一合约的 factory —— 省 gas 省部署，demo 足够。

```solidity
struct Policy {
    uint256 maxCashPerTx;
    uint256 maxDebtPerTx;
    uint256 maxDebtPerDay;
    bool    ownerFrozen;      // owner 自设冻结
}
// 协议冻结位（protocolFrozen）单独存放，仅 CreditManager/guardian 可写；
// 二者任一为真即拒绝支出，owner 改自己的 Policy 绕不过协议风控（review #9）

// 拒绝路径用 custom error —— revert 会回滚日志，事件发不出来（review #10）；
// 反向 demo 由 SDK/前端解码 revert data 展示拒绝原因
error SpendRejected(uint256 agentId, address target, uint8 reason);
// reason: 1=非白名单 2=超限额 3=冻结 4=授权结构性缺失 5=授权与调用者不匹配
// Account 只报告本层可判断的策略错误；Manager 的验签、期限、身份、任务、nonce 错误原样冒泡。
// amount/cap 与全局限额两层防守：Account 报 reason 2，直接 draw 报 Manager 对应错误。
// 多个条件同时违规时暂不约定报错先后；专项拒绝测试仅构造一个违规条件。

contract AgentAccount {
    mapping(uint256 agentId => uint256) public cash;
    mapping(uint256 agentId => Policy)  public policies;
    mapping(address => bool) public providerWhitelist;   // P0: 仅自营 relay

    function depositCash(uint256 agentId, uint256 amount) external payable; // owner
    function setPolicy(uint256 agentId, Policy calldata p) external;        // owner

    /// 核心入口：cash 优先，不足部分持授权 draw，原子支付给 provider
    /// 限额规则 = min(policy 上限, auth.principalCap, 全局余量)，统一在此收口
    function payProvider(
        uint256 agentId,
        address provider,
        uint256 amount,
        bytes32 paymentId,                   // 绑定 relay 报价（review #6）
        CreditAuthorization calldata auth,   // 纯 cash 支付可传空
        bytes calldata underwriterSig
    ) external onlyAgentWallet(agentId);
    // 必查（review #1）：涉及信用时 require(auth.agentId == agentId)；
    // 调用者钱包核对 Registry 的【当前】wallet（实时读，不用快照 ——
    // review r2 #2：快照未刷新时旧钱包仍会被认可，纯 cash 支付也一样）

    // ---- 协议侧入口（review r3 #1：清算与结算需要的跨合约资金通道）----
    /// 协议入账（随调用 push 资金）：TaskEscrow 结算入账，
    /// CreditManager 退款/recovery 回补入账（review r4 #4，权限对齐流程）
    function creditCash(uint256 agentId, uint256 amount)
        external payable onlyProtocol;   // TaskEscrow | CreditManager
    /// 清算扣款：尽可能扣，返回实际扣到的金额并 push 给 CreditManager；
    /// 协议级扣款，不受 ownerFrozen / Policy 限额阻止
    function debitForLiquidation(uint256 agentId, uint256 maxAmount)
        external onlyCreditManager returns (uint256 debited);

    // 每笔支付按 paymentId 留痕（processRefund 的拆分与归属依据）
    // agentId 必存：纯 cash 支付无 taskId（taskId = 0），
    // 退款时仅凭它确定入账 agent（review r4 #4）
    struct PaymentRecord { uint256 agentId; uint256 taskId;
                           uint256 fromCash; uint256 fromCredit;
                           uint256 refundedAmount; }   // 累计，≤ fromCash+fromCredit
    mapping(bytes32 refundId => bool) public refundConsumed;   // 防重放（r5 #1）
    mapping(bytes32 paymentId => PaymentRecord) public payments;

    // 仅 Manager：登记本次 refundId 与累计金额，返回登记前记录及本次 cash/credit 份额。
    // 不移动资金、不回调 Manager；与 processRefund 收款/债务调整同交易原子完成。
    function registerRefund(bytes32 paymentId, bytes32 refundId, uint256 amount)
        external onlyCreditManager
        returns (PaymentRecord memory record, uint256 cashShare, uint256 creditShare);

    event ProviderPaid(uint256 indexed agentId, address indexed provider,
                       bytes32 indexed paymentId,
                       uint256 fromCash, uint256 fromCredit);
}
```

## 4.4 TaskEscrow.sol（含 waterfall + slashing + 声誉写回）

```solidity
enum TaskStatus { None, Open, Assigned, Settled, Failed, Cancelled } // None=0，Open=1

struct Task {
    address poster;
    uint256 reward;         // 原始 reward，不随清算清零
    uint256 escrowBalance;  // 当前托管余额，释放/退款时清零
    uint256 agentId;        // 接单 agent
    uint256 deadline;
    uint16 protocolFeeBps;  // createTask 时快照；后续全局改费率不影响旧任务
    TaskStatus status;
}

contract TaskEscrow {

    function protocolFeeBps() external view returns (uint16); // 当前全局费率，只用于新任务
    function payableEscrow(uint256 taskId) external view returns (uint256);
    // payableEscrow = reward - floor(reward * task.protocolFeeBps / 10_000)。
    // draw 的 I6、underwriter 预裁剪和 settle 全部用同一快照，不能读实时全局费率。
    // 任务期限是必填项（review r3 #2：否则无 loan 的任务会永久锁死 escrow）
    function createTask(uint256 reward, uint256 deadline)
        external payable returns (uint256 taskId);

    /// 接单鉴权写进接口约束（review r3 #2）：
    /// msg.sender 必须是该 agentId 在 registry 的【当前】wallet，防替人占单
    function acceptTask(uint256 taskId, uint256 agentId) external;

    /// 未接单的任务 poster 可随时取消，全额退款（Open → Cancelled）
    function cancelTask(uint256 taskId) external onlyPoster;

    /// deadline 过后任何人可调（permissionless 出口，不依赖 loanDueAt）；
    /// 分流按 loan.status（review r5 #2）：
    ///   status ∈ {None, ClosedByRefund}
    ///     → 全额退 poster，任务终结（Assigned/Open → Failed），不进清算
    ///   status == Active
    ///     → 与 settle(false) 同型的 push 路径（review r4 #3，防调用环）：
    ///       Escrow 先终结任务、清空 escrow，
    ///       随调用 push 给 Manager.liquidateWithEscrow —— 不走 pull，不会重入自己
    function expireTask(uint256 taskId) external;

    /// 接单/借款/结算的时限统一引用 task.deadline：
    /// acceptTask 与 draw 要求 now < deadline；settle 在任务被终结前有效。
    /// deadline 后无专属 verifier 窗口：settle 与 expire 谁先执行谁终结，后者 revert。
    /// 贷款超时的 GRACE 不延迟独立的任务到期出口（清算条件保持 OR）。

    /// 超时清算取款（仅 CreditManager；push 资金、标记任务终结、
    /// 返回 poster 地址供剩余退款 —— 本函数不回调 CreditManager，防环）
    function releaseForLiquidation(uint256 taskId)
        external onlyCreditManager returns (uint256 escrowAmount, address poster);

    /// 仅 verifier role（P0 = Arena 签名服务的地址）
    function settle(uint256 taskId, bool passed) external onlyVerifier;
    //
    // 分流一律按 loan.status 判定，不按"有无 loan"（review r5 #2：
    // 全额退款后 loan 记录仍存在，按存在性分流会把 ClosedByRefund 推进清算）：
    //
    // passed == true（资金清算保持原子，RISK_AND_MVP §3）：
    //   status == Active          → reward → 1.协议 fee
    //                               → 2.CreditManager.repay(本金+fee)
    //                               → 3.剩余进 cash（P0 无自动补足 backstop）
    //   协议费按 Task.protocolFeeBps 快照扣取；demo 显式设为 0。
    //   backstop 仅通过显式 fundBackstop 或 Defaulted recovery 回补。
    //   status ∈ {None, ClosedByRefund}
    //                             → 跳过 repay，reward 扣协议费后直接进 cash；
    //                               记 task-success，但不增加还款次数
    //
    // passed == false：
    //   status == Active          → 终结任务、清空 escrow，
    //                               随调用 push 给 Manager.liquidateWithEscrow{value}
    //   status ∈ {None, ClosedByRefund}
    //                             → escrow 全额退 poster，任务终结（不进清算）
    //
    // 超时已被 liquidate 终结的任务：settle 一律 revert
    // 重复 settle：二次调用 revert（Task 状态机单向）

    // ---- 声誉写入与资金解耦（review #5）----
    // 资金清算原子完成；giveFeedback 用 try/catch 包裹，
    // 失败落 pendingFeedback[taskId][type]，不回滚清算。
    // 反馈规则（review #4）：
    //   "repayment"=100  仅当本 task 存在 Active loan 且真实清偿时写一次
    //   纯 cash 任务只写 "task-success"，绝不写 repayment（防虚增还款次数）
    function retryFeedback(uint256 taskId, uint8 feedbackType) external;
    // 任何人可调，按 taskId+type 幂等
    // v5.3：task-success/repayment 状态在 Escrow；default 状态在 Manager。
    // Manager.pendingDefaultFeedback = LoanStatus.Defaulted && !defaultFeedbackSent。
    // Escrow 的 default 查询与 retryFeedback(type=3) 单向代理 Manager；
    // Manager 清算时不回调 Escrow 反馈入口，避免重入锁环。

    event TaskSettled(uint256 indexed taskId, bool passed,
                      uint256 repaid, uint256 slashed, uint256 toAgent);
    event FeedbackPending(uint256 indexed taskId, uint8 feedbackType);
}
```

## 4.5 状态机与不变量（实现验收标准，测试基线已建立）

状态机（单向，不回头）：

```text
Task:  Open → Cancelled          （未接单，poster 取消，全额退款）
       Open|Assigned → Failed    （deadline 过后 expireTask：
                                    None/ClosedByRefund 全额退款；Active 转清算）
       Assigned → Settled | Failed
       （超时清算由 liquidate 直接终结任务并退还剩余 escrow；
         被终结后的 settle 一律 revert）
Loan:  None → Active → Repaid | Defaulted | ClosedByRefund
       Repaid         仅经成功路径的 repay 足额偿付
       Defaulted      进入清算即定格 —— 足额回收（loss=0）也不改写终态、
                      不计正常还款（违约事实 ≠ 实际损失，review r2 #5）
       ClosedByRefund 退款后剩余债务归零即关闭（v5.3）——
                      不计还款、不进违约、到期不再触发清算
```

`draw` 不变量清单：

```text
I1  !drawPaused && agent 未被协议冻结
I2  EIP-712 验签通过；nonce 未消费；block.timestamp <= authDeadline
I3  双重身份校验（review r2 #2，缺一不可）：
    !adapter.identityChanged(agentId)        —— 实时对 registry
    && 快照 version == auth.identityVersion  —— 作废重审前的旧授权
I4  task 存在；status == Assigned；task.agentId == auth.agentId；now < task.deadline
I5  该 taskId 尚无 loan（每任务一次 draw，nonce 与 taskId 同时消费）
I6  amount <= auth.principalCap，且债务总额不超过可偿付 escrow：
    principalCap × (10_000 + feeBps) / 10_000
      <= payableEscrow(taskId) × MAX_LTV_BPS / 10_000
    （review r2 #1：/10_000 不能少 —— 少了就是一万倍额度；
      费用必须计入债务侧，协议费必须先从 escrow 侧扣除）
I7  两道全局 cap（outstanding 含本金+fee；epoch 只计新增本金，退款不恢复预算）
```

异常测试清单（到测试函数的映射见 TEST_PLAN §2；复选框表示验收要求，不表示已通过）：

P0 的 MAX_LTV_BPS ≤10_000，费率条款固定、escrow 完整且资产正常时，I6 保证债务可由 escrow 覆盖。
清算仍记 Defaulted，但 backstop 和池子损失层在正常路径不可达；多层损失只在明确隔离的测试 harness 覆盖，不放宽生产 I6。

```text
□ 拿他人的 auth 提款（I4 违反）        □ 同 task 二次 draw（I5）
□ 换 nonce 重置额度（I5）             □ authDeadline 过期后 draw（I2）
□ 身份轮换后旧 auth 复活（I3 版本号）   □ 换钱包但快照未刷新时 draw/pay 被
                                       实时校验拦截（I3 实时项，r2 #2）
□ I6 LTV 数值回归：feeBps 计入债务、  □ principalCap 超 escrow LTV（I6）
  协议费先扣、/10_000 不缺位（r2 #1）
□ 清算清偿顺序逐层断言：cash 先动、    □ 债务 0.1 / escrow 1 / cash 0.2 场景：
  escrow 只补不足（r2 #4）              poster 拿回全部 escrow
□ 无 loan 失败任务：全额退款不进清算    □ 清算足额回收仍记 Defaulted、
  （r2 #5）                             不计正常还款（r2 #5）
□ 超时 liquidate 终结任务并退剩余      □ 被终结后 settle revert
  escrow，不等迟到 settle（r2 #5）
□ 重复 settle / 重复 liquidate        □ 部分偿付后 loan 仍 Active
□ feedback 失败不阻塞清算 + retry 幂等 □ 纯 cash 任务不产生 repayment 反馈
□ owner 解冻不能绕过协议冻结           □ 清算扣 cash 不受 ownerFrozen 阻止
□ SpendRejected 各 reason 的 revert data
□ 未接单取消全额退款（r3 #2）          □ deadline 后无 loan 任务退款终结
□ 非当前 registry wallet 接单被拒      □ 失败路径 settle→liquidate 全程
                                       不因重入锁死锁（r3 #1）
□ processRefund 按比例冲减债务、       □ 重复退款 revert
  fee 同步减免、不计还款次数（r3 #3）
□ 全额退款 → ClosedByRefund，          □ 部分退款有剩余债务则保留，无债务则关闭；
  到期不触发清算（r4 #2）                Repaid 后退款全额入 cash 不再冲减
□ Defaulted 后 recovery 逆序含 poster： □ 每层回补不超过 liquidations 记录的
  LP → backstop → poster → cash（r4 #1）  实际承担额
□ 任务到期而贷款仍在 GRACE：                □ expireTask 有 loan 走 push 路径，
  liquidateExpiredLoan 可执行（r4 #3）    全程无重入死锁
□ 纯 cash 支付（taskId=0）退款按        □ liquidateWithEscrow 仅 TaskEscrow
  PaymentRecord.agentId 正确入账（r4 #4）  可调、pull 型任何人可调
□ ERC-20 模式分次退款：累计不超原额、    □ 同 refundId 重放被拒、
  每次金额显式传入（r5 #1）               不同 refundId 续退成功
□ ClosedByRefund 后任务成功：跳过 repay、□ ClosedByRefund 后失败/到期：
  记 task-success、不增还款次数（r5 #2）   退还 escrow、不进清算
```

测试交付复核补充的验收项（函数索引见 TEST_PLAN §2.2）：

- 放款后全局费率变化不改变旧任务的 I6 或结算金额；新任务采用新费率。
- provider 收款失败时 cash、vault 实际资产、loan、nonce、paymentId 与全局计数完整回滚；重试仍可用。
- 主动重入用例必须真的触发回调并区分内层 ReentrantCall 与外层 NativeTransferFailed；普通 ERC-20 无接收方回调。
- 分次退款最后一笔无残余本金/fee/wei；recovery 累计不超各层实际承担额，原始记录不改写。
- 身份转移→wallet 清空→重绑定→重审→旧授权失效；解冻不抹去 default 历史。
- ABI/registry mock 正例使用独立 reporter、1-based feedbackIndex；真实部署验证仍独立执行。

## 4.6 跨合约调用表

v5.3 资金配对：原生币 push 清算金额来自 msg.value；ERC-20 的
`liquidateWithEscrow(taskId, poster)` 保持原 ABI，Escrow 先将本任务全部 escrow
按确切金额 approve，Manager 读取并一次性耗尽该 allowance。不得改用无限授权。
pull 仍由 releaseForLiquidation 直接转账并返回金额，不回调 Manager 业务入口。
贷款到期检查先允许 task.deadline 的独立出口；未到任务期限时用安全时间差
判断 loanDueAt/GRACE，避免相加溢出挡住到期清算。

| 入口 | 调用者 | 资金方向 | 账本变化 | 终态写入 |
|---|---|---|---|---|
| `Manager.draw` | AgentAccount | vault → AgentAccount → provider | loan 开账 | Loan=Active |
| `Manager.repay` | TaskEscrow（成功结算） | escrow → vault | fee+principal 清偿 | 足额时 Loan=Repaid |
| `Manager.liquidateWithEscrow`（payable，push 型） | TaskEscrow（settle(false) 或 expireTask 有 loan） | escrow 随调用 → vault/poster | 清偿 + 承担额写 liquidations | Loan=Defaulted；剩余退 poster |
| `Manager.liquidateExpiredLoan`（pull 型） | 任何人（贷款超时或任务到期） | 经 releaseForLiquidation 取 escrow | 同上 | 同上 + Task=Failed |
| `Manager.processRefund` | relay refunder 随调用入金（ERC-20 transferFrom） | relay → vault/cash/各方回补 | 按 loan 状态分支冲减/回补 | Active 退款后债务归零转 ClosedByRefund；其他终态不改写 |
| `Account.registerRefund` | CreditManager | 无资金移动、无回调 | 消费 refundId；累计 refundedAmount；返回拆分 | — |
| `Manager.enrollAgent / reapproveAgent / unfreezeAgent` | P0 guardian；重审后才刷新身份 | 无 | enroll/reapprove 转调 Adapter；unfreeze 只解除冻结 | 不清除历史 default/loan 终态 |
| `Account.creditCash` | TaskEscrow / CreditManager | 结算或退款资金 → cash | cash += | — |
| `Account.debitForLiquidation` | CreditManager | cash → vault | cash −= | — |
| `Escrow.releaseForLiquidation` | CreditManager | escrow → Manager | escrow 清零 | Task=Failed |
| `Escrow.settle` | Arena verifier | 见 §4.4 | waterfall | Task=Settled/Failed |
| `Escrow.cancelTask / expireTask` | poster / 任何人 | escrow → poster（None/ClosedByRefund） | 退款；Active 的 expire 走上列 push 清算 | Task=Cancelled/Failed |

防重入原则（避免 settle→liquidate→escrow 回调环把正常清算锁死）：

```text
清算编排避免回到已上锁的发起入口：
  失败路径  Escrow 先终结任务/清零 escrow，随调用交给 Manager.liquidateWithEscrow（Manager 不回 Escrow）
  超时路径  Manager 调 Escrow.releaseForLiquidation 取款（该函数不回 Manager）
两条路径在 Manager 内部汇入同一个 _liquidate(taskId, escrowFunds, poster)。
各合约外部业务入口分别加重入锁。原生币随调用携款；ERC-20 按入口的 approve/transferFrom 约定入金。
repay 的超额原路退款、debitForLiquidation 的原生币回款只能进入接收资金的 receive，不能重入业务入口。
锁被重入会 revert，不存在等待；验收包括正常 push/pull 路径与主动重入失败后的资金/账本结果。
```

---

# 5. 关键交易时序（happy path 全程 4 笔链上交易）

```text
tx0  初始化（不计入业务四笔，demo 开场前完成并在讲稿中说明）：
     register identity（canonical registry）→ CreditManager 触发 adapter.enroll
     → depositCash → setPolicy → fundBackstop（可选）
     ※ P0 的 "sessionKey" 就是 agent wallet 私钥本身，
       不做独立 session key —— 文档与 pitch 如实表述，独立 session key 是 P1

tx1  poster:  TaskEscrow.createTask{value: 1 MON}(reward, deadline)
tx2  agent:   TaskEscrow.acceptTask(taskId, agentId)

     —— 链下 ——
     agent SDK → relay 请求 → 402 报价单（paymentId / price / quoteExpiry）
     agent SDK → underwriter POST /authorize {agentId, taskId, nonce}
     underwriter：InferScore → Tier → principalCap / feeBps → EIP-712 签名返回

tx3  agent:   AgentAccount.payProvider(agentId, relay, 0.12, paymentId, auth, sig)
              └─ cash 0.04 + draw 0.08，原子转给 provider-relay
     —— 链下 ——
     relay 确认收款 → 转发 Kimi 推理 → 返回结果
     agent 完成任务 → arena 跑 hidden tests → 10/10 PASS

tx4  arena:   TaskEscrow.settle(taskId, true)
              └─ waterfall 清算 + 两条 giveFeedback，单笔交易完成
```

前端档案页在 tx4 后刷新：InferScore ↑、Credit Limit ↑ —— 飞轮可见。

---

# 6. 链下服务规格

## 6.1 services/underwriter

**2026-10-01 实现验收**：`services/underwriter` 已实现下述两个入口，使用 Node 22 + ethers 6 + 原生 HTTP。
主 Agent 独立执行 `npm run typecheck` 与 `npm test` 均通过：4 项 TAP 测试（含两种资产的真实 Anvil 子测试），
USDC 首单实际本金 80,000、费用 12,000、provider 收到 120,000；原生币路径同样消费真实签名。
精确拒绝 nonce 重放与授权过期，并验证声誉延迟、真实违约拦截及证据写入失败。
启动方式、配置和限制见 `services/underwriter/README.md`；此结果不代表已部署到测试网。


```text
POST /authorize   {agentId, taskId, nonce}
  1. resolveAgent 读取实时身份，identityChanged 必须为 false，取 snapshotVersion 进签名
  2. 违约判定读第一真值：CreditManager.defaultCount(agentId)
     （由 Defaulted 转移累计，不扫描全历史 loans；协议自己的账本优先，声誉只是镜像）
  3. 声誉读取必须过滤报告者（review #4，ERC-8004 反 Sybil 要求）：
       getSummary(agentId, [ERC8004Adapter 地址], "infercredit", "repayment")
       同样分别查询 "task-success" / "default"；返回 (count, summaryValue, summaryValueDecimals)。
     评分消费 count，不依赖 summaryValue 是 sum 还是 mean；只认 Adapter 的反馈。
  4. InferScore（P0 确定性公式，可复现）：
       score = 500
             + 40 × min(repayments, 10)
             + 30 × min(taskSuccesses, 10)
             − 400 × defaults
     Tier 映射（分数 + 还款门槛双条件，review r2 联调 #3：
     否则 7 次纯 cash 成功、0 次还款也能刷到 A ——
     Tier 代表经过验证的偿债能力，必须有真实还款次数背书）：
       A：score ≥700 且 repayments ≥3（cap=$2.00 fee=3%）
       B：score ≥580 且 repayments ≥1（cap=$0.50 fee=8%）
       C：其他（cap=$0.20 fee=15%）
       defaults > 0 或 Manager.defaultCount > 0 → 拒绝
       评分仍消费上述 Adapter 镜像 count；Tier 还款门槛还须 Manager.repaymentCount
       满足同一阈值，避免镜像与真实还款脱节。反馈待补写可使升级延后，不得绕过违约拒绝。
  5. principalCap 按 I6 预裁剪（review r3 #6，否则小 reward 任务
     会因签名 cap 过大而被链上拒绝）：
       escrowCap = TaskEscrow.payableEscrow(taskId) × MAX_LTV_BPS / 10_000
                   × 10_000 / (10_000 + feeBps)    // 整数向下取整，与合约一致
       principalCap = min(Tier cap, escrowCap)
     前端展示区分：agent 的 Tier 上限 vs 本任务实际可借额度
  6. EIP-712 签名 CreditAuthorization
     （authDeadline = now+30min；loanDueAt = min(now+24h, task.deadline)；客户端提供 uint256 nonce，链上按集合消费）
  7. 落盘 evidence JSON，hash 进 evidenceHash

GET /agents/:id/credit    → 档案页数据（TRACK_NARRATIVE §7 开场用）

接入约定：agentId / taskId / nonce 以十进制字符串传输，不经 JavaScript Number。
nonce 由客户端生成并传入，服务不维护另一套 nonce 数据库。一次请求的链上读取
固定同一个 blockTag，证据记录 block number/hash。签名前确认 chainId、资产精度、
Manager 当前 underwriter、身份与任务状态；证据原子落盘成功后才返回授权。
当前演示资产为测试 USDC（6 decimals），原生 MON（18 decimals）保留显式配置，
固定演示换算不引入 oracle。服务只读链并签名；本地集成测试另用 Anvil 消费签名。

Demo 部署显式设置 protocolFeeBps = 0；三单期末 cash 为 0.058 / 0.0787 / 0.105396，
前两单按 C 费率、第三单按 B 费率，第三单结算后升 A。

Demo 预置（排期建议 #3 + review r3 #5）：主角 agent 提前完成两次真实还款
（score 500 → 640，Tier C → B 已发生），现场完成第三次
（640 → 710，B → A 升级当场触发）。额度上涨必须可复现，不靠手调。

余额准备不能只预置三个相同任务 —— 结算入账会让后续任务走纯 cash，
三单结束仍只有一次还款。用任务经济参数自然造出借款需求：
  reward 只略高于成本（如 reward $0.15、报价 $0.12、债务 $0.092），
  结算残值 ≈ $0.058 < 下一单报价 → 每一单都真实触发借款。
  这恰好就是产品论点本身：利润率是真实的，营运资金缺口是结构性的。
预置脚本每单前断言 cash < quote.price，结算后断言还款计数 +1；
断言失败即脚本失败，不允许"看起来跑通了"。
```

签名私钥放 `.env`，与 deployer 分开；guardian 私钥第三把，谁都不复用。

## 6.2 services/provider-relay（自营 Provider，RISK_AND_MVP §1.1）

**2026-10-02 本地实现验收**：`services/provider-relay` 与 `packages/sdk` 已通过主 Agent 独立
`npm run test:core`，Underwriter 和 relay/SDK 各 4/4、0 skip。USDC6d/native18d 都是
SDK HTTP 报价后真实调用四合约，再确认 ProviderPaid、访问受控 HTTP 上游、取得 receipt；
测试上游不是付费 Kimi/Qwen。当前采用项目自建 402/receipt，官方 x402 facilitator 兼容性未验证。

```text
POST /v1/chat  （OpenAI 兼容格式）
  未付款 → 402 + 报价单（review #6，付款必须唯一对应请求）：
    { paymentId,            // keccak256(abi.encode(uint256 taskId, bytes32 requestDigest, bytes32 serverNonce))
      agentId, taskId, serverNonce, service,
      requestDigest,        // 请求体摘要，绑定这一次推理
      model, price, payTo, asset, chainId, account,
      quoteExpiry, createdBlock } // 报价有效期只限制付款时刻
  重试相同请求携 x-payment-id，可携 x-payment-tx
  链上确认成功 Account receipt、完整 ProviderPaid、calldata、canonical block 和确认数
  → 按 paymentId 幂等消费：同 ID 只交付一次，重复请求返回缓存结果
  → 转发 Kimi/Qwen → 返回结果 + 落盘 receipt

  付款状态机（review r2 #6，"标记已消费→调 Kimi→存结果"之间有崩溃窗口）：
    Paid       链上确认付款，推理未开始
    Processing 已持久化请求体、推理进行中（先落盘再调 Kimi）
    Delivered  结果已落盘，可重复领取
    Refunded   放弃交付、已退款（P0 由运营手动触发）
  崩溃恢复规则：
    发送前保存候选 Dispatching；结果未知保留 Processing + UPSTREAM_UNCERTAIN
    原 ID/重启只查询未知状态，不再派发；明确拒绝保存后才继续原同档候选
    已保存 Delivered 返回缓存；未知调用先运营核对，普通 Relay 不直接退款
  报价过期规则：
    付款发生在 quoteExpiry 前 → 永久有效，过期后重试照常交付，
    不得强制重新报价扣费；quoteExpiry 只约束"付款动作"的时限
  持久化实现：原子写入（write temp + rename）、进程内互斥、按 paymentId 幂等
  SDK 超时重试 = 携同一 paymentId 查询状态，绝不重新扣费
```

落盘时增加付款前 `Quoted` 状态。`requestDigest` 是包含 agentId/taskId、messages/model/service
和全部推理字段的 canonical JSON 摘要（递归排序 object keys，数组保留顺序）。报价、原请求与结果
按 paymentId 存储；同一 DATA_DIR 只允许一个进程，文件原子更新与互斥不支持跨进程共享目录。
`GET /payments/:paymentId?agentId=…&requestDigest=…` 可直接发现已付款并返回状态/缓存；
无 txHash 时按最多 1000 块扫描到已确认 head，仅推进已完整扫描且无事件的区间。
Paid/Processing 仅在候选尚未派发或已持久明确拒绝时恢复；所有候选明确拒绝回到 Paid 供运营退款，不重复被拒候选。旧 Processing 或 Paid+UPSTREAM_FAILED 无派发记录时保守按未知处理。完整受信拒绝状态限定为400/401/403/404/413/415/422/429；408/409/5xx、超时、断连或无效响应不能触发fallback。固定价B沿用其独立solve journal与未交付全额退款契约，由provider承担未知模型成本。

区块时间晚于 quoteExpiry 的真实付款保存为 `Paid + expiredPayment`，拒绝推理但保留退款出口。
运营退款是 loopback、无浏览器 Origin、bearer token 保护的 `POST /ops/refund`，也提供本地 CLI；
必须使用配置的 Manager.relayRefunder。refundId/amount 意图及已签交易先落 journal，只有链上
processRefund 成功、事件与累计金额核验通过才增加已退款额；部分退款保留 Paid/refundPending，
禁止交付，全额才 Refunded。重复同 refundId/amount 不二次转账，commit 故障恢复读取原 receipt。
完整参数、CORS 和启动方式见 `services/provider-relay/README.md`。

**上游路由（参考 magpie 的 routing group，github.com/yetone/magpie，MIT）**：

```text
逻辑服务 ID 与物理上游解耦：
  链上 ProviderRegistry 白名单的是 relay 地址 + 服务类目
  （如 infercredit/coder）；Kimi 还是 Qwen 是 relay 配置里的
  路由策略，换上游不动链上任何东西。

relay 配置显式化为 group：
  services:
    infercredit/coder:
      strategy: order          # P0 只做 order（顺序 fallback）
      upstreams: [kimi, qwen]  # 一个失败自动切下一个
  （rotate / usage 等其他策略 P1+，不做；by-intent 见下方专段）

报价锁价规则（与 402 计费模型的冲突点，必须遵守）：
  报价时锁定逻辑服务 ID 和 price，paymentId 据此生成；
  付款后允许在 group 内重路由，但只收报价价格 ——
  fallback 到更贵上游的差价由 relay 自担（这就是 margin 的理由）；
  usage receipt 记录实际使用的上游，供审计和
  后续 Compute Underwriter 的成本模型喂数据。

失败上游冷却（P1）：失败的上游退避递增的一段时间再试，
  收到 Retry-After 按头部执行；P0 只做同请求内的顺序切换。
```

**By-intent 路由（我们的P1候选设计，尚未实现）**：

```text
候选机制（需独立验证分类成本和效果，不归因为Magpie现成策略）：
  每个新路由会话可由便宜的小模型分类意图（实际延迟与成本需测量；首版先用显式档位）
  分类意图 → {quick-answer, code-gen, review, test-fix, …}
  → 每个意图类映射到一个 模型 + 价格档
  → 该轮及其后续 tool rounds 停留在该模型，不再重复分类

与 402 报价的时序约束（关键，否则破坏锁价规则）：
  分类必须发生在报价【之前】——
  收到请求 → 分类 → 按意图档报价（402 单里的 model/price
  就是分类结果）→ 付款 → 交付。
  付款后绝不因重新分类而改价；分类器自身成本计入 relay margin。

为什么该候选设计可能改善 InferCredit 的资金安排：
  同一任务的请求流里，杂活走便宜模型、硬活走强模型
  → 若节省通过更低报价传递给 agent，任务算力支出下降
  → 任务利润与偿债余量可能改善。
  compute-roi 纳入声誉/授信属于后续设计；当前 InferScore 不因模型变便宜而直接加分。
  即：路由优化直接改善借款人的还款经济学 ——
  "purpose-bound credit + 花得更聪明" 是信贷协议自己的护城河。

数据副产品：
  per-intent 的用量与成本分布按任务类型归档，
  正是 Compute Underwriter（主文档 §46）成本模型要的训练数据 ——
  分类器在授信侧（估成本）和执行侧（选模型）是同一个组件。

P0 不做；P1 先做二分类（cheap/strong）即可拿到大部分收益。
```

Magpie策略说明（实际接入与锁定版本见 §6.6）：官方README列出smart/order/rotate/usage/pace等routing模式，
不能把by-intent称为其第五种现成策略；上面的分类设计由我们另行评估。
OpenAI/Anthropic推理接口兼容是后续方向；改base URL只能改变请求地址，
客户端仍须接入InferCredit SDK或支付adapter，才能处理402报价、签名、付款和恢复。
API互译不等于任何coding agent自动接上信用支付，也不表示标准x402已验证。

## 6.3 services/arena

```text
任务定义 = { prompt, hiddenTests[], reward }，先手写 3–5 个编程小题

执行隔离（review #7 + r2 #3：空 env / 临时 cwd / 独立进程都挡不住
同用户权限的代码读宿主 .env 或篡改测试文件 —— 必须换执行环境）：

  P0 执行器 = Docker 容器：
    --network none、非 root 用户、只挂载一次性任务目录（只读题目 + 可写工作区）、
    CPU / 内存 / 时间限额；宿主密钥目录对容器不可见
  验收裁决 = 容器外的可信 test controller（review r3 #4：
  测试框架与提交代码同一运行时，其输出照样可被伪造 ——
  所以 P0 题型直接限定为纯函数 / stdin-stdout）：
    宿主 controller 持有预期答案，向容器逐条喂测试输入；
    容器返回的只是待比较的输出数据，通过与否由宿主比较判定。
    预期答案与通过计数永远不进容器、不交给提交代码控制。
  arena 签名服务（唯一持有 verifier key，与执行链路不同进程）：
    只接收 controller 的结论 → 调 TaskEscrow.settle()

没有 Docker 环境或排期不够 → 直接砍到人工验收（§7 砍功能预案第 3 条），
demo 讲稿明确说明；不存在"进程级隔离"的中间档 —— 那是假安全。

新增已实施任务类型：双 Agent 五子棋（2026-10-04 扩展范围，详见 §6.6）。
独立裁判验证合法落子与胜负，CLI 通过现有 SDK 支付双方独立模型费用。
德州本地闭环及真实Kimi决策→Monad赞助测试USDC→奖金购买真实推理已落地；2026-10-05 已增加本机运营网页开局、Kimi 额度奖励和持久恢复，见文末。公开“贴任意提示词即参赛”仍未开放，游戏借贷明确排除。
```

## 6.4 packages/sdk —— `infer.fetch()`

```typescript
const infer = new InferCredit({
  agentId, sessionKey, rpcUrl, // 或 signer: BrowserProvider 的 signer；二选一
  chainId: 10143n, account, asset, provider, maxPrice: 120000n,
  underwriterUrl, onHandle: persistPaymentHandle,
});

// 报价与授信都锚定在 task 上，所以任务上下文必须显式（review r2 联调 #2）
const session = infer.forTask(taskId);
const res = await session.fetch("https://relay.../v1/chat", { body });
// 内部：请求 → 402（paymentId/quote）→ 查 cash → 不足则 POST /authorize
//      → payProvider(tx3，携 paymentId) → 携 paymentId 重放请求 → 返回结果
// 无 task 上下文的 infer.fetch() 仅允许纯 cash 支付，不触发授信
// 开发者视角零金融概念，这就是主文档 §8 的卖点
```

调用方明确配置期望 chain/asset/account/provider/maxPrice，SDK 对原请求摘要与完整报价核验后才付款。
金额用 BigInt，ID 与 nonce 用十进制字符串。同 task 已有借款报 TASK_ALREADY_BORROWED，不能换 nonce 再提款。
浏览器 signer 使用其 provider，不向浏览器暴露 server RPC secrets；服务仅按精确 FRONTEND_ORIGIN 开 CORS。

`PaymentHandle` 是调用方可 JSON 持久化的公开恢复资料。广播前 await onHandle；超时/重启调用
`infer.resume(handle)`，先查 relay 状态与真实链上 payment/receipt，不另建 paymentId。
Wallet 仅能重播已保存的相同 raw bytes；已过期、已知 pending 或未知 nonce 消费明确拒绝/等待。
Browser signer 丢 hash 的不确定结果保留 from/nonce 意图，禁止二次 send；明确钱包 4001 拒绝才清除未广播意图，
允许同 handle 显式恢复。返回 `{result, receipt, handle}`，PaymentError 保留 code、handle 与 SpendRejected reason。
使用例及本地闭环测试入口见 `packages/sdk/README.md`；SDK 不提供后台 nonce 协调服务。

## 6.5 Demo 面板视觉参考（magpie 官网 usemagpie.ai 的 Routing 区块）

magpie 的路由可视化值得整体借鉴到我们的 demo 操作面板（§7 Week 3）。
实测其页面后，可搬的四个模式：

```text
1. 三栏节点图
   左：agent 卡片 ── 中：网关节点（品牌图标 + 当前策略徽章）
   ── 右：目标列表，贝塞尔曲线连接。
   我们的版本：Agent #1842 ── InferCredit 节点（徽章显示
   cash / credit-draw 当前支付方式）── Kimi / Qwen / …
   一笔支付发生时沿连线跑一个光点，评委一眼看懂钱的路径。

2. 可解释路由：右侧每行末尾一个"为什么"标签
   （magpie 用 "intent · a quick question" / "76% used"）。
   我们的版本：每笔支付行标注 "cash $0.04 + credit $0.08 · Tier B"
   —— 把授信决策的解释直接内联在流水里。

3. 行内用量条：magpie 在账号行内嵌 usage 进度条。
   我们的版本：档案页与面板的 Credit Limit 行内嵌
   已用额度条（cash 余额 / available credit 双色）。

4. 计数条："0 requests · 0 rerouted · 0 errors your agent saw"
   —— 用一个数字把网关价值讲完。我们的版本（放面板底部）：
   "N payments · M credit draws · 0 payment errors the agent saw"
   —— 这正是 SDK "零金融概念" 卖点的量化表达，pitch 可直接引用。
```

实现约束：纯前端 SVG/CSS 即可（连线是静态贝塞尔 + 一个动画光点），
不引可视化库；Week 3 排期内完成，超期则按 §7 砍功能预案降级为列表视图。

技术注记（已实测验证）：magpie 官网这套可视化本身就是零依赖的
纯 SVG/CSS —— 页面无任何可视化库，动画全部用原生原语。照做即可：
  连线      <path d="M … C …">（贝塞尔），SVG 用 viewBox 随容器缩放
  光点      SMIL <animateMotion path=同一条曲线> 或 CSS offset-path
  虚线流动  stroke-dasharray + @keyframes 偏移
  节点/徽章/用量条  普通 DOM + CSS，不进 SVG


## 6.6 下一阶段：预算路由与受限 Agent loop（2026-10-04 更新）

2026-10-04 用户扩大交付范围：真实模型信用流程、Monad Pi、Magpie 网关与棋牌均需实际落地。
按真实模型信用验证 → Monad Pi，以及独立网关/棋牌模块推进，主 Agent 独立验收后更新完成状态。
保留当前固定价 B 与原资金协议，优先最小可运行接入；未验证的部分不能因已有本地测试记为已完成。

当前进展：显式 `tier: cheap|strong` 两档报价、SDK `maxPrice` 校验、档内候选快照及恢复/退款边界
已实现。主 Agent 独立 `typecheck:all` 与 Relay/SDK 10/10 本地验收通过；2026-10-04 新本地
Anvil/mock-USDC 通过 SDK/Relay 调用真实 K2.6/K3，各一次128输出上限、零付费重试，均最终OK/stop。
运营报价0.01/0.03 mock-USDC仅验证客户价差，不等于上游成本或实际账单，也不证明能力差异。
主 Agent 已离线核验保存的请求、报价、回执、响应与签名交易；原Anvil已关闭且首版未保存raw receipt，
本次不能独立复读原ProviderPaid事件。见[报告](demo-output/live-tiers-20261004-k26-k3-128/report.json)
与[离线审计](demo-output/live-tiers-20261004-k26-k3-128/offline-audit.json)。
本次没有切换测试网页面/旧demo的provider配置，也没有新增Monad部署或链上付款。
本步由调用方显式选档，不做自动分类/自动降档；受限Pi cash loop已实现；新增真实K2.6工具调用与本地Arena结算证据见下段，此早期阶段未接Magpie或逐轮融资；随后固定价B真实模型/Magpie验收见本节末。
配置与兼容方式见 [Relay README](services/provider-relay/README.md)及[Pi README](packages/pi-loop/README.md)，验收见
[implementation-status](docs/implementation-status.md)。下文保留各阶段验收范围，最新信用/网关/竞技交付见本节末。

### 当前能力与任务范围

- Relay 已实现同一锁价报价内的顺序上游 fallback；真实业务只验证了 Kimi。
  Claude 等模型的额度耗尽/限流属于上游不可用；agent 余额/预算不足属于支付与选档问题，两者分开处理。
- 统一 workflow 由宿主配置候选任务和求解预算，规则选择后自动接 Open 任务，或继续该 Agent 的 Assigned 任务；一次购买固定价 B，内部 Pi 在轮数、工具数和 token 上限内生成/验证代码，最后提交独立 Arena 结算。旧单次脚本保留为历史与专项探针。
  旧 demo 的选任务、接单和轮次仍由脚本安排。新增 Pi 入口只处理一个已指定任务、有限 cash 修复轮次，不称为完整自主选任务或自主融资；没有引入 LangChain。
- 题库代码 `services/arena/src/problems.ts` 有四道 Python JSON stdin/stdout 题：
  `sum-integers`、`unique-sorted`、`balanced-brackets`、`word-frequency`。
  真实 Monad demo 只使用求和题；违约场景显式构造错误答案，不是模型自然失败率的测量。
  真实仓库修 bug、研究报告、网页制作尚无对应任务验收适配，不计入当前支持范围。

### 预算感知路由：先做 cheap / strong 两档

1. 调用方给出任务上下文、价格上限与所需能力，付款前选 `cheap` 或 `strong`，再生成绑定档位的报价。
   首版用显式配置/规则选档，不必新增分类模型；后续才考虑 §6.2 的 by-intent 分类。
2. 同一档位可配置按顺序尝试的兼容上游；上游完整明确拒绝可在已约定能力范围内 fallback；未知响应必须暂停。
   如无符合预算与能力的上游，返回明确不可执行结果，不能静默降低已承诺能力或突破预算。
3. 付款后报价不变、不因 fallback 二次扣费；更贵上游的差价由 Relay 承担。
   仅切换到便宜上游只降低 Relay 成本；只有付款前给 agent 更低报价，才算 agent 省钱。
   回执记录实际上游、模型、usage 与 agent 实付金额，区分上游成本和客户价格。
4. Magpie 已作为 Relay 后面的模型网关接入并验收；我们保留任务绑定、402 报价、链上支付、退款和回执。
   当前锁定版本与禁止隐式重试补丁，新增能力仍须单独验证接口和实际模型归因。
   原生 Anthropic 接口、streaming/tool calls 不能从当前非流式 chat 路径推断为已兼容。

验收：预算不足时不付款；cheap 报价确实低于 strong；fallback 不重复收费且模型归因准确；
无可用合规上游时保留现有同 paymentId 恢复/退款语义。本地受控测试与两档真实API短探针已完成；
2026-10-07 已单独验收“宿主注入完整拒绝→真实同档备用 Kimi”；这不是自然供应商故障。模型能力对比及真实链两档付款不能由早期两次 OK 输出推断。

### Pi：一个任务、有限轮次、有限花费

已接入原 `badlogic/pi-mono`（官方仓库现跳转至 `earendil-works/pi`）的 Agent 核心，
锁定 `@earendil-works/pi-agent-core`/`pi-ai` 1.0.1，Node>=22.19.0，只用于消息状态和工具执行循环，
不叠加 LangChain、coding CLI 或多 Agent 框架。自定义 `streamFn` 使用现有非流式 SDK/Relay，
默认 provider 零模型请求；工具消息逐条匹配 ID，截断工具在正常/恢复路径都拒绝执行。

目标循环：读题 → 写代码 → 跑公开样例/自建测试 → 根据错误修复 → 最终提交。
首个样例保持任务由用户或脚本指定，暂不扩展自主选单、多人协作和通用工具市场。
宿主负责总费用、最大轮数、任务截止时间与停止条件；重启沿用已保存会话和 PaymentHandle，
不能因为循环恢复重新支付。代码/工具执行沿用隔离环境，不向模型执行目录提供钱包或验收签名密钥。

必须先解决两个接缝：

- **多轮计费与一次提款**：P0 同一 task 仅可提款一次，不能假设每轮都能追加借款。
  首个 loop spike 可使用有总预算上限的纯 cash 调用，明确它不证明多轮信用融资已完成。
  当前信用版已选择本节后文固定价 B：一次购买有上限的求解服务，早成功不返轮差，未交付全退；恢复沿原 paymentId。
  按轮储值/按用量退款 A 仍未实现。不得以绕过 taskId/nonce 限制追加提款。
- **调试与最终裁决分开**：新建不结算的公开样例/自测入口；现有 Arena submission 是最终验收，
  失败可能立即清算，不能拿它反复调试。hidden tests、答案及签名控制始终留在可信验收侧。

验收：受控首轮错误能在后续轮次修复；到达费用/轮数/截止时间上限会停止；
自测不产生 settle/default；最终提交沿用原判题与结算；中断恢复不重复扣款。
纯 cash loop 通过后，再验收明确资金规则的信用 loop，不把两者合并宣称完成。

当前实现见 [packages/pi-loop](packages/pi-loop/README.md)：宿主指定一个已 Assigned 的求和任务，
每轮显式 cheap/strong，使用 `infer.fetch` 的 taskId=0 cash 路径，不借款；最大轮数、工具数、
累计 quote.price 和 deadline 由宿主限制。预算只含推理报价，不含 gas。await SDK onHandle
持久预留后再付款，beforePayment 拦截新签名/原raw重播/Browser send；已付超时保留预留。
公开样例固定 `[4,8,-3] -> 9`，复用 DockerExecutor，不调用 hiddenTests 或 settle。
最终仅提交现有 Arena HTTP，由独立 settler 结算，核验真实 TaskSettled receipt 才记录任务成败。
会话保存 messages/PaymentHandle/已付响应/自测/最终签名payload与runId；跨进程单writer锁
在崩溃后需要显式 recoverLock，配置和原deadline不得改变。截止后只领取已付结果/查询已知run，
不重新付款、执行或提交。未知HTTP/结算状态保留原意图，不用样例通过伪造任务成功。

执行器本地受控验收覆盖首错后修复、预算/轮数/工具数/deadline停止、自测不结算、独立Arena
最终真实本地链结算、已付恢复零新模型请求/扣款。主Agent已独立审代码并复跑验收：Pi 10/10、Relay/SDK 16/16（均0 fail/skip），typecheck:all含前端通过。
前一批为本地受控上游；2026-10-04新增一次真实Kimi受限验证，见
[报告](demo-output/live-pi-20261004-kimi-once/report.json)、
[最终离线审计](demo-output/live-pi-20261004-kimi-once/offline-pi-audit.json)与
[root独立验收](demo-output/live-pi-20261004-kimi-once/root-acceptance.json)。
K2.6经显式系统HTTPS代理、SDK→Relay→Pi实际`test_public_sample`工具调用，
HTTP200/finish_reason=tool_calls，usage输入190/输出45/总235（reasoning1）；
固定公开样例PASS，独立Arena Docker 5/5与本地TaskSettled PASS。仅1次模型请求，
现金报价10000（0.01 mock-USDC），无借款、无付费重试；ProviderPaid/TaskSettled原始receipt、
付款rawTx、独立settler原签名交易journal、会话与逐轮request/response均已保存。
root独立核验最终离线证据并从原提交代码重跑Docker hiddenTests 5/5，无新模型或交易。
源码hash保留原记录；执行期间只有offline auditor加强了原settle签名核验，
最终补审仍只读已存证据，见[sourcehash说明](demo-output/live-pi-20261004-kimi-once/post-run-audit.json)。

运行上限3轮、每轮2048 completion tokens、累计报价70000、5分钟；首次公开样例通过立即提交。
本次没有预置错误，首轮成功，**未使用strong、未验证真实两轮修复或K3工具兼容**；
之前受控首错修复与两档短探针各自保持原证据范围。运营报价不等于上游账单，gas另计。
新Anvil已在收集全部回执后关闭，离线审计不能重新查询其状态或独立认证API来源。
此cash阶段没有切换测试网页面或旧demo/secrets，也不证明Monad Pi、信用融资、Magpie及标准x402；最新扩展交付另见本节末。

### 最小信用loop：固定价求解服务 B

P0仍是同task一次提款；当前每轮taskId0现金请求不能冒充信用循环。暂不修改资金协议。

| 候选 | 付款与交付 | 未用额度/中断 | 新增职责与范围 |
| --- | --- | --- | --- |
| A：一次预付、逐轮耗用包 | 一次task-bound提款/预付，固定总预算；每轮动态请求认证与消费journal | 未知消费保留预留；真实未用额度退款确认后才最终提交 | 需Relay包生命周期、动态请求绑定、用量/未知/退款状态；不是现金loop的小接线，P1延后 |
| B：固定价、最多N轮求解服务（本轮本地spike） | agent经SDK forTask一次报价/付款/提款；provider内部运行有界Pi+公开样例，交付符合约定的终稿；agent再独立Arena提交 | 提前成功固定价不退差额；没交付约定终稿走既有undelivered全额退款，确认后结束；未知状态沿同handle/journal，不二付 | 新增provider求解职责和原paymentId恢复journal，无逐轮钱包储值账本；实现与root独立本地验收均通过 |

B的本轮实施范围只做本地Anvil、受控上游、一个Assigned任务、一次cash不足导致的真实draw，
固定价/最多N轮/输出与deadline上限、公开样例终稿条件、已付与未知恢复、未交付全额真实退款，
交付后再由原独立Arena最终结算。终稿条件不等于hidden tests保证；最终失败仍按原P0规则处理。
同一个PaymentHandle不能改body来消费新轮次，provider需按原paymentId持久请求/响应与调用上限，
原服务边界内完成求解，费用与实际上游耗用分开；不靠换taskId/nonce追加借款。
B采用独立服务 `infercredit/solve-fixed`、逻辑模型 `pi-fixed-v1`，沿用 `/v1/chat`、原SDK `forTask`、PaymentHandle和受保护运营退款入口。请求只绑定固定公开题、Assigned task与版本1求解规格：显式各轮tiers、最多3轮/4工具、每轮最多2048 completion tokens、最多5分钟deadline。运营固定价与模型耗用分别记录；receipt.model/upstream/usage仅为最后一轮摘要，完整各轮物理请求model、响应自报model和usage保存在run，不把混合模型tokens当作一个模型的账单。

本地资金例为固定价120000原始mock-USDC、cash40000、一次真实draw80000，利率读取原Underwriter条款。专用provider收款钱包同时是原Manager已配置refunder，初始代币余额为0；退款必须使用这笔实际收款，不另mint或从测试treasury垫付。模型与provider求解模块没有agent、verifier或refunder密钥。独立agent宿主保存唯一付款handle并验证公开样例，最终提交复用cash入口同一个Arena helper；provider不读hidden tests或执行settle。

未认证/未付款quote不能占用task。确认真实ProviderPaid后原子写task→原paymentId/digest；已付task只恢复该原请求，其他未付quote在付款前返回不可履约，新digest拒绝。每次新model dispatch先确认Assigned、链上deadline和当前身份，再写Dispatching意图后发送。原响应落盘后可继续Pi；Dispatching缺响应保留Unknown，不自动重发，由provider承担不确定成本并允许运营全退。恢复不创造新task、paymentId、签名或nonce绕过原借款限制。

交付仅定义为有完整code/codeHash且公开样例通过的终稿及有界run；提前成功仍收固定价，不返未用轮差。未交付只退原全价，退款准备先禁用交付，原refundId/已签raw恢复；client只查询并核验Account全额退款和原贷款合法零债务终态，不拿退款密钥。任务若已违约仍保留违约状态，退款不记成功。已Delivered但hidden tests失败属于独立Arena任务失败/原贷款清算，不能改成未交付退款。

以下本地场景已由root独立复跑通过：受控首错修复但只有一次LoanOpened/ProviderPaid，最终独立Arena真实还款；首轮成功仍同价；丢失已付交付恢复不二付；未知model dispatch不重发；轮数/deadline未交付使用provider款全退及退款commit故障同ID恢复；超时清算后的合法退款；公开样例过而hidden失败真实Defaulted且不能退款；恶意未付quote不占任务、已付原请求绑定。provider单测21/21、固定价1项集成（8场景/9负例）、cash原11/11、Relay/SDK16/16及旧live-Pi脚本33/33回归通过，typecheck:all含前端通过。root另独立解析7笔原签付款、4笔全额退款与3笔Arena结算回执，核对provider收退款余额360000、agent cash75396、未偿贷款0；首笔手续费由原付款calldata复算12000。原报告与独立证据见[root验收](demo-output/fixed-price-credit-20261004-root/root-acceptance.json)。验收仅本地链/受控模型，不声称真实Kimi信用循环或Monad Pi。模块/接口与命令见[固定价README](packages/pi-loop/FIXED_PRICE.md)。

更新范围：真实模型信用 B、Monad Pi、Magpie 网关、棋牌已获用户明确要求实施。A 逐轮储值/按用量退款、分类模型与完整自主选单不因此自动加入；游戏定位已明确为德州赢取推理额度/USDC，不做共享奖金授信。B 继续只做固定价服务，不引入通用钱包储值账本。

### 扩展交付验收（2026-10-04）

- **真实模型信用 B**：已独立跑通 SDK 一次固定价购买 → 实际 Magpie → 真实 Kimi K2.6 → Pi 样例工具 → 独立 Arena 判题及还款。本地 mock-USDC 的 cash40000 + draw80000 支付120000，fee12000，偿还92000，首轮成功。原签名、原始回执和网关前后的物理请求响应均已核验；不以首轮成功声称验证了真实多轮修复。见[独立验收](demo-output/live-local-credit-20261004-root/root-acceptance.json)。
- **Monad Pi**：Task 11 已通过真实 Monad 测试网全链验收：SDK固定价购买 → 实际Magpie/真实Kimi K2.6 → Pi工具 → 独立Arena hidden 5/5 → 链上结算还款。测试USDC为6位小数：cash105396 + draw14604支付120000，fee438，偿还15042，最终cash134958、还款4、违约0、未偿0。root独立核对物理模型请求响应、签名和canonical链上回执，见[最终验收](demo-output/live-monad-pi-20261004-alchemy-root/root-acceptance.json)。Alchemy直连、宿主请求间隔500ms，本次253次宿主RPC全部成功（独立settler不计入）；不保证长期可用。Task9 gas回滚和Task10读取503均保留为历史失败，托管款已全退，见[工程状态](docs/implementation-status.md)。旧部署与旧demo配置保留，本次provider/poster/refunder复用已在证据中披露。
- **Magpie**：锁定官方 v0.1.814 源码及小型无隐式重试补丁，实际进程17项独立检查通过；上述真实Kimi信用任务已通过它。显式cheap/strong映射，402报价/付款/退款仍由Relay和SDK负责，不宣称自动分类或跨重配置恢复已完成。见[接入与复现](docs/magpie-gateway.md)。
- **五子棋**：15×15自由规则、双Agent独立现金预算、逐步模型决策、持久付款与棋谱、独立裁判及CLI已实现。受控9步黑胜及恢复由root独立验收；新真实Kimi对局已终局：12步合法落子、13次模型调用与付款，黑方第13次响应达到256输出上限而不符合JSON落子格式，按既定规则判白方forfeit胜，非五连胜。root独立重放棋谱、核对13笔原签付款/回执和物理模型请求响应，见[真实整局验收](demo-output/gomoku-live-20261004-retry-root/root-acceptance.json)、[规则与运行](docs/gomoku-arena.md)。费用结算使用本地Anvil/mock-USDC；旧11步503暂停局保留为历史。

棋牌首版采用双方独立模型费用；没有把共享奖金抵押、借款、奖励分配或声誉写回伪装为已经实现。德州奖励闭环的当前实现见下文，不推进游戏借款。


### 2026-10-04 用户确认：德州/GameFi 是预算获取路径，不做游戏借贷

Agent 推理预算不足或希望使用更强模型时，有两条并列路径：满足现有任务授信条件后借款购买推理；或参加德州扑克/GameFi，赢取可兑换的 LLM 推理额度或 USDC，再用于推理消费。借款不是无条件提款，继续遵守现有任务、身份、用途与额度约束。

游戏模块不发放贷款，不以预期奖金授信，也不把现有用途受限借款转作参赛筹码。“上杠杆”在此表达扩大可用推理预算的产品动机，不表示游戏内新增金融杠杆。游戏所得只有实际结算到账后，才成为可消费资源；输赢不直接记作任务还款/违约或提高信用评分。

目标玩法以德州扑克为先，五子棋验收不单独证明德州/GameFi 能力。当前已有双人单手规则、隐藏手牌隔离、可信裁判随机发牌、赞助测试 USDC 奖励与现金推理消费；2026-10-05 增加固定两位 Agent 的网页开局，以及总计 4096 的 Kimi 专用额度发放和实际 usage 消费。LLM token 指运营方发放的推理使用额度，不是加密代币或跨模型通用价格。

用户已确认首版免费参赛、赞助测试 USDC 奖励，保留 LLM 额度奖励方向。德州双人单手规则与本地赞助奖励→现金购买推理闭环已由root验收：规则23项、集成4项通过，随机牌局获奖100000、推理支出10000、cash净增90000、债务0，见[德州运行与边界](docs/holdem-arena.md)。上述为第一阶段受控证据；后续真实Kimi、Monad赞助奖与现金推理及只读UI交付见[运行与最新证据](docs/holdem-arena.md)。LLM 额度发行/兑换当前已实现；公开报名/任意提示词参赛与完整赛事平台仍未开放。

参考：[Magpie](https://github.com/yetone/magpie)、
[Pi Agent 核心](https://github.com/earendil-works/pi/tree/main/packages/agent)。
Pi接口以锁定1.0.1及上述测试为准；Magpie实际锁版本、补丁和验收证据见接入文档。

---

# 7. 实现推进顺序与原排期

当前从 TEST_PLAN §5 的依赖顺序开工：基础接线/身份/入金 → 任务与纯 cash → draw/payProvider
→ repay/settle/feedback → 清算 → 退款与端到端。每一步确认测试到达目标断言，再验收转绿。
以下 Week 1–4 是 9/14 制定的历史排期，不能视作这些里程碑已完成，也不是重新要求先写一次测试。

## Week 1（9/14 – 9/20）：合约 + 地基

```text
周一二   Day-0 Spike（§3，全员）
周三     先写 §4.5 的状态机转换表 + 异常测试清单（先于合约编码，
         测试即规格；覆盖跨 agent 授权 / 重复提款 / 超时清算 /
         重复请求 / 外部反馈失败五类）
周三四   contracts 四合约实现 + Foundry 单测逐条打勾 §4.5 清单
         （每条对应 RISK_AND_MVP 的一个攻击面，测试即答辩证据）
周三四   并行：packages/erc8004 迁移 + 在目标网络真实注册一个 agent
周五六   合约部署测试网；scripts/demo.ts 骨架能跑 tx1/tx2
里程碑   ✅ 四合约上链，单测绿，canonical registry 真实写入过声誉
```

## Week 2（9/21 – 9/27）：钱真正流动

```text
underwriter 服务 + EIP-712 链上验签联调（这是全项目最容易翻车的接缝，
  chainId / domain / struct hash 逐字段对拍，留一整天）
provider-relay 402 流 + payProvider 原子 draw+pay 跑通
SDK infer.fetch() 完成
里程碑   ✅ scripts/demo.ts 跑通 tx1→tx3：借到的钱真实买到了一次 Kimi 推理
```

## Week 3（9/28 – 10/4）：闭环 + 可见

```text
arena 服务 + settle 原子清算 + 声誉写回（tx4）
frontend：Agent Financial Identity 档案页（pitch 开场画面，优先级最高）
         + demo 操作面板（触发任务/借款/结算，评委能看懂状态变化；
           视觉规格见 §6.5，参考 magpie 的路由可视化）
反向 demo 两个场景接入面板（SpendRejected / identityChanged 冻结）
里程碑   ✅ 完整飞轮 demo.ts 一键跑完，档案页数字实时动
```

## Week 4（10/5 – 10/13）：打磨与提交

```text
10/5–10/9   多 agent 数据填充（档案页别只有一个 Agent #1）、
            文案对齐 TRACK_NARRATIVE §7、录 demo 视频、README
10/10       Demo 冻结。之后只修 P0 bug，不加 feature
10/11–13    提交材料、备用录屏、buffer
```

**砍功能预案**（进度落后时按此顺序砍，不讨论）：

```text
1. 砍 frontend 操作面板 → 全用 demo.ts 终端输出 + 档案页
2. 砍 SDK 通用性 → demo.ts 里内联
3. 砍 arena 沙箱 → 人工验收并触发 settle（demo 讲稿明确说明，不能声称自动 hidden tests 已运行）
永不砍：原子清算、全局限额、SpendRejected 反向 demo、声誉写回
```

---

# 8. 分工（按 3 人配置；2 人则 B 兼 C 的面板部分）

```text
A  合约 + Foundry 测试 + 部署          （Week1 重心，Week3 起支援联调）
B  underwriter + relay + arena + SDK   （Week2/3 重心）
C  frontend 档案页 + demo.ts + pitch   （贯穿，兼任 PM 盯里程碑）
```

每天一次 15 分钟同步，只回答一个问题：**"demo.ts 今天能跑到第几笔 tx？"**
—— 这是全项目唯一的进度真值。

---

# 9. Demo Definition of Done

对照 TRACK_NARRATIVE §7 的 3 分钟结构，缺一项不算完成：

```text
□ 档案页展示 ≥3 个 agent，含一个高分 Tier A 和一个有 default 记录的
□ 主角 agent 预置两次真实还款（Tier 已到 B），现场第三次触发 B→A 升级
  —— InferScore 按 §6.1 公式可复现，不靠手调
□ 飞轮 live：tx0 初始化（讲稿说明）→ createTask → accept →
             借款买推理 → PASS → 原子清算 → 档案页数字现场上涨
□ 反向 demo：借款转非白名单地址 → 交易 revert，
  前端解码 SpendRejected custom error 并展示拒绝原因
  （不是事件 —— revert 会回滚日志，review #10）
□ 链上证据：Monad explorer 打开 tx4，能指着看到 repay + giveFeedback
□ 一条命令复现：npm run demo
□ 备用录屏（测试网抽风时放视频）
```

## GameFi 当前实现（2026-10-05）

`/arena` 保留参考站的 UI/UX，业务使用 AgentFuel 的规则、真实模型流程与奖励政策。本机运营用户可在网页选择测试 USDC 或 Kimi 推理额度并发起德州比赛；`/api/arena/gamefi` 只调用服务端固定的两位 Agent 与原 CLI，浏览器不能指定钱包、模型、路径或赢家。`/arena/holdem` 继续作为历史公开回放与资金证据入口。尚未开放远程账号报名、任意提示词参赛、多手真实赛事或可验证随机，游戏始终不发贷款。

Kimi 额度由可信服务端重放终局发放：每局共 4096 token，独胜全额、平局各 2048；绑定 `kimi-k2.6` 和固定运营身份。`/api/arena/credits` 在调用前持久化兑换意图与预算预留，完成后按供应商实际输入和输出 usage 扣减。未知结果保留预留，重复兑换 ID 返回原状态或缓存，不再派发；超额用量保留实际扣减并阻止继续消费。它不是加密代币、USDC 余额或 Magpie 周期预算。

runner、额度 ledger 与四游戏练习均有本地持久化和 writer 锁。真实比赛按原 UUID、evidence 和交易 journal 恢复，不重开未知模型请求；练习保存规则重放、日志、席位和幂等请求，默认 `.data/arena-freeplay.json`，可由 `ARENA_PLAY_STATE_PATH` 指定。原子写入与 fsync 支持进程重启恢复，不能据此声称已有公网身份平台或分布式存储。练习 Bot 不调用真实模型，练习胜负不发放 USDC 或额度。

本轮真实额度局已向 Agent1999 发放 4096 token，实际 Kimi 消费 24，余额 4072；同兑换 ID 返回缓存。2026-10-06 新 USDC 局已完成独立验收：Agent1998获0.1测试USDC，原存款签名确认入cash，消费0.01完成1次真实Kimi推理（21输入+8输出=29 tokens），cash剩0.09、借款0。root fresh核对存款/付款canonical回执、付款块cash及本地原始模型响应；原对局报告未变，没有重复派奖。RPC仍可能间歇失败，本次成功不代表网络问题已消失。详见[本轮完成验收](demo-output/gamefi-complete-20261005-root/root-usdc-complete-20261006.json)。浏览器 16 项为受控接口测试，全部拦截 start/recover/redeem，不是交易证据。当前汇总见[本轮验收](demo-output/gamefi-complete-20261005-root/root-acceptance.json)，配置和恢复见[网页 runner](docs/gamefi-runner.md)、[额度规则](services/arena/src/inference-rewards/README.md)和[练习 API](docs/free-arena.md)。2026-10-04 的[UI 复刻验收](demo-output/arena-clone-20261004-root/root-acceptance.json)保留为历史，其仅内存存储与网页只读边界已由本轮实现替代。


## 2026-10-06 下一阶段：未知模型响应保护

2026-10-06 普通Relay失败处理已独立验收：派发前记录候选意图，未知响应不fallback、不重发、不直接退款；受信明确拒绝后才继续原同档候选。root新Anvil/受控上游Relay与SDK44/44、固定价B兼容28/28及全项目typecheck通过。固定价B原未交付全退契约保留。本批没有新增真实模型或Monad交易；真实strong工具、自然修复及真实fallback仍待有界验收。 运行规则与拒绝响应契约见[Relay README](services/provider-relay/README.md)，独立结果见[本轮验收](demo-output/relay-uncertain-20261006-root/root-acceptance.json)。


## 2026-10-06 Strong 工具真实验收（当前）

2026-10-06 strong-only真实工具验收已完成：新本地Anvil固定价信用任务经直营Kimi K3一次调用，输入307/输出86/总393 tokens，实际test_public_sample一次通过，独立Arena5/5并结算。现金40000+借款80000支付120000原始mock-USDC，费用12000、还款92000，最终cash58000、未偿0。root独立复跑12项受控脚本测试、全项目typecheck，校验原请求响应/签名/资金回执，并重新Docker判题5/5。首轮成功即停，没有人为错误或第二次模型调用，不证明自然多轮修复或真实fallback；本轮没有新增Monad交易、未经过Magpie，也不据usage推算vendor账单。 [独立验收](demo-output/live-strong-only-20261006-root/root-acceptance.json)，[复现与限制](packages/pi-loop/FIXED_PRICE.md)。这补齐此前“仅K3短探针、未验证工具”的缺口，旧运行仍保留各自原始范围。


## 2026-10-07 扩展任务与备用路由

固定价 B 保持一次 task-bound 付款，将原求和白名单扩展到现有四道 Python 题。题目绑定贯穿公开样例、solve spec、请求摘要、提交裁决与离线审计；不接受任意提示词或模型自称通过。`--catalog` 仅本地，每题一轮、最多四次模型调用，任一题未完成就停止。真实 K2.6 四题各一次成功，独立 Arena 19项和 root 新 Docker 19项均通过，各任务贷款结清。旧 Monad Task11 与默认求和绑定兼容，未新增测试网交易。

普通 Relay 另完成“宿主注入完整拒绝 → 真实同档备用 Kimi”单次验收，付款回放/重启没有额外扣款或调用。它不等于自然供应商故障、跨档自动降级或模型能力对比。详细结果和后续边界见[当前工程状态](docs/implementation-status.md)，复现入口见[固定价 B](packages/pi-loop/FIXED_PRICE.md)和[Relay](services/provider-relay/README.md)。


规则选择入口 `@agentfuel/pi-loop/selector` 已实现，按宿主白名单的能力、价格、cash/creditLimit、Assigned状态和期限做确定性筛选，决策与报价先持久化再付款。真实单次验收从两个候选中选括号题cheap并完成现金购买；受控测试另覆盖显式forTask信用、资金变化与未知恢复。当前不自动接单、不执行生成代码、不接网页调度，host creditLimit也不改变原链上policy；[选择器边界与复现](packages/pi-loop/README.md)及[当前状态](docs/implementation-status.md)为准。


## 2026-10-07 后端收尾与 UI 交接

现有 P0 / 四道 Python 任务 / 本机运营 GameFi 后端的本轮交付见 [后端验收](docs/backend-acceptance.md)。新 `workflow` 使用纯规则选择，不先购买旧 selector 的原始推理；Open 接单、固定价 B、Pi 工具、独立 Arena、偿还与安全状态查询在一个持久请求中完成。HTTP 仅接受预设 profile 与 UUID，恢复复用原接单签名、PaymentHandle 和提交；未知请求不能靠换 UUID 重买。`npm run backend` 提供固定五角色启动和退出，GameFi 保留现有独立入口。

root 通过同款 Next 服务端桥接与真实 HTTP 完成一次 Kimi K2.6：190 输入 + 39 输出 = 229 tokens，付款120000（cash40000 + credit80000），偿还92000、最终cash58000、未偿0。接单/付款/结算三份回执已核对 canonical block，生成代码另经3项新Docker复判，原UUID恢复无新增消费。此为新本地Anvil/mock-USDC验证，没有新增Monad交易，也没有经过Magpie；旧Monad Task11和本轮Magpie实际进程回归分别作为各自证据。

剩余 UI 工作是预设任务控件、阶段/资金/错误展示、原请求恢复交互和桌面/手机浏览器验收。自然模型错误修复的观察证据、通用仓库任务、公开报名、第三方provider、公共LP和标准x402兼容，不应借“后端收尾”改写为已完成。
