# InferCredit — 测试计划与 §4.5 清单覆盖索引

> 本文是给外部 reviewer 的导航图。
> 上游规格：`../AGENT_CREDIT_ENGINEERING.md` §4（合约实现规格 v5.3）
> 与 `../AGENT_CREDIT_RISK_AND_MVP.md`（攻击面）。
>
> **第 2 轮（2026-09-14）：已按 `REVIEW_CODEX.md` 的 R1–R6 与 24 条裁决逐条修订。**
> 修订摘要见 §5。

> **2026-10-01 文档同步**：四份 AGENT_CREDIT 文档已回填已确认裁决；ENGINEERING v5.3 是当前 P0 说明。
> §3 的 G/F 编号及 review 引述保留历史溯源，“骨架已补/文档待补”描述的是提出问题时的状态。
> §3.4 的默认口径现已同步工程规格；本地实现结果见下，fork 验证结果见下。
>
> **2026-10-01 本地实现验收完成**：六批实现均已独立复核；
> `forge test`：408 tests，404 passed / 0 failed / 4 skipped（38 suites）。
> `forge build --sizes` 通过；四业务合约最大 runtime 为 CreditManager 15,969 bytes。
> 原生/ERC-20、三单经济学、失败全回滚、分次退款与恢复舍入均已实际执行。
> `src/` 不再含 NotImplemented；4 个 skip 为原生专属路径与 ERC-20 反向正例。
> Monad 测试网 canonical fork 与钱包绑定签名已独立复跑通过，见 §3.4；链下联调仍待完成。
>
> 开工基线曾为 250 tests：19 passed / 227 failed / 4 skipped。
> 当时 NotImplemented 红灯只能证明被骨架拦住，不能证明后续断言正确。
> 实现期间将 provider 失败测试收紧为精确错误，并补实际余额、日预算回滚和有界 gas 断言；
> 未放宽原有业务断言。39/39 仍是 §4.5 清单映射，不是完整安全审计声明。

---

## 0. 开工时的骨架边界（历史记录）

下表保留开工时的接口划分，表中“未实现”项现均已完成。最初为了让 `setUp()`
能建立测试场景，只实现了管道，其余使用 `revert("NotImplemented")`：

| 开工时已实现（管道） | 当时待实现（现已完成） |
|---|---|
| 构造函数、`setProtocolContracts` / `setCreditManager` / `setReporter`（一次性接线） | `draw` / `repay` / `_liquidate` / `liquidateWithEscrow` / `liquidateExpiredLoan` |
| `setGlobalLimits` / `setDrawPaused` / `setProviderWhitelist` / `setVerifier` / `setProtocolFeeBps` | `processRefund` / `freezeAgent` / `unfreezeAgent` / `reapproveAgent` / `enrollAgent` |
| 纯存储读的 view（`getLoan` / `getTask` / `cash` / `backstop` …） | `deposit` / `withdraw` / `fundBackstop` / `depositCash` / `creditCash` / `debitForLiquidation` |
| `DOMAIN_SEPARATOR()` / `hashAuthorization()`（§4.2 明文规定的 EIP-712 线格式） | `payProvider` / `setPolicy` / `registerRefund` / `setProtocolFrozen` |
| | `createTask` / `acceptTask` / `cancelTask` / `expireTask` / `settle` / `releaseForLiquidation` / `retryFeedback` |
| | `resolveAgent` / `identityChanged` / `enroll` / `reapprove` / `reportFeedback` |

EIP-712 之所以例外，是因为它是**线格式规范**而不是业务逻辑：域名 `"InferCredit"`、
版本 `"1"` 在 §4.2 中是逐字写死的，而 §7 Week 2 明确点名这条接缝最容易翻车。
即便如此，测试仍然独立重算一遍（`InferCreditTestBase._domainSeparator` /
`_hashAuth`），两边不一致就是失败——所以这不是"自己证明自己"。

---

## 1. 文件地图

```text
contracts/
├── src/
│   ├── ERC8004Adapter.sol          §4.1  身份快照 + 声誉写入
│   ├── CreditManager.sol           §4.2  vault / 授信 / 清算 / 退款 / 全局限额
│   ├── AgentAccount.sol            §4.3  双余额 + SpendPolicy + provider 白名单
│   ├── TaskEscrow.sol              §4.4  托管 / waterfall / slashing / 声誉写回
│   ├── interfaces/                 结构体、枚举、事件、custom error 的唯一定义处
│   │   ├── IIdentityRegistry.sol      ← ERC-8004 官方 ABI 逐字抄录（见 R1）
│   │   ├── IReputationRegistry.sol    ← 同上
│   │   ├── IERC20.sol / IERC8004Adapter.sol / ICreditManager.sol
│   │   └── IAgentAccount.sol / ITaskEscrow.sol
│   └── utils/
│       ├── SafeTransferLib.sol     原生币 / ERC-20 双模式转账（手写，无 OZ 依赖）
│       └── ReentrancyGuard.sol     §4.6 "锁加在各自外部入口" 的最小实现
├── test/
│   ├── helpers/InferCreditTestBase.sol   部署 + EIP-712 签名 + 场景组合
│   ├── mocks/MockIdentityRegistry.sol    真实转让语义 + 钱包绑定需签名同意
│   ├── mocks/MockReputationRegistry.sol  官方 ABI；可注入 revert / 烧光 gas；
│   │                                     summaryValue 聚合口径可切换
│   ├── mocks/MockERC20.sol               USDT 式无返回值 + 定向转账阻塞
│   ├── mocks/MaliciousActors.sol         拒收 provider / 重入 agent-wallet / 重入 poster
│   ├── AbiConformance.t.sol  ERC-8004 selector / 返回元数 / canonical 语义 10 tests
│   ├── Identity.t.sol        身份转让→清空钱包→重绑定→重审生命周期     7 tests
│   ├── Draw.t.sol            I1–I7 逐条 + EIP-712 线格式              33 tests
│   ├── Liquidation.t.sol     清偿顺序 / push-pull / 无死锁             19 tests
│   ├── Refund.t.sol          processRefund 五个分支 + 超杠杆回补 harness 20 tests
│   ├── TaskLifecycle.t.sol   生命周期 + 费率快照 + settle/expire 竞态   35 tests
│   ├── Atomicity.t.sol       支付失败全回滚 + 主动重入（wallet 级攻击者）18 tests
│   ├── Feedback.t.sol        声誉解耦 / retry 幂等 / summaryValue 无关  16 tests
│   ├── SpendPolicy.t.sol     双冻结位 / reason codes / 三层限额         28 tests
│   ├── Economics.t.sol       demo 三单经济学 + Tier 门槛                 6 tests
│   └── Erc20Mode.t.sol       ERC-20 模式重跑 + 配对校验                 58 tests
└── script/Deploy.s.sol       四合约部署与接线（与 setUp 同构）
```

不引入 OpenZeppelin：`forge init --no-git` 后仓库不是 git repo，`forge install`
无法工作，因此 `SafeTransferLib` / `ReentrancyGuard` 按任务书的退路手写在
`src/utils/`。二者合计不到 80 行，行为与 OZ 对应件一致。

### 1.1 ERC-8004 ABI 的可信来源（Codex R1）

`IIdentityRegistry` / `IReputationRegistry` 现在是官方规范
（<https://eips.ethereum.org/EIPS/eip-8004>）的逐字子集：

```solidity
setAgentWallet(uint256 agentId, address newWallet, uint256 deadline, bytes signature)
unsetAgentWallet(uint256 agentId)

giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals,
             string tag1, string tag2, string endpoint,
             string feedbackURI, bytes32 feedbackHash)

getSummary(uint256 agentId, address[] clientAddresses, string tag1, string tag2)
    returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
```

`AbiConformance.t.sol` 用**规范里的字面签名字符串**算 selector 去对拍我们的
接口，因此它无法靠"两边一起改"来满足；旧的 5 参数 `giveFeedback` 和 2 参数
`setAgentWallet` 也被显式钉成"不是官方函数"。

**已补充**：`spike/Day0Canonical.t.sol` 在 Monad 测试网固定区块 67277702
执行真实 canonical 本地 fork，1 passed / 0 failed；重跑命令见 `../docs/day0-findings.md`。
该目录显式启用，默认离线套件不依赖 RPC。

`summaryValue` 的聚合方式被 ERC 有意留给实现者。因此 InferCredit 只消费
`count`；`MockReputationRegistry.cheatSetSummaryMode` 可在 mean / sum 之间切换，
`Feedback.t.sol` 的两个测试钉死"评分只依赖 count"。

mock 同时强制以下 canonical 语义（Codex R2-D）：agent 必须存在、
**owner 不得给自己的 agent 写反馈**、`valueDecimals ≤ 18`、
**反馈编号对外从 1 开始**（内部数组仍 0-based，在 mock 内转换）。
未模拟且明确记录为缺口的：approved-operator 排除、反馈授权 / allow-list、
真实 registry 的 `summaryValue` 聚合。

## 2. §4.5 异常测试清单 → 测试函数映射

编号按 §4.5 清单的阅读顺序（每行先左后右）。**39 项全部有测试。**
"×2" 表示该测试在原生币与 ERC-20 两种结算模式下各跑一遍。

| # | §4.5 清单项 | 测试函数 | 文件 | 状态 |
|---|---|---|---|---|
| C01 | 拿他人的 auth 提款（I4 违反） | `test_RevertWhen_DrawWithForeignAuth_I4`<br>`test_RevertWhen_AuthAgentIdDoesNotMatchCaller_Reason5`<br>`test_RevertWhen_AuthIsForAnotherAgent_Reason5` | Draw / Draw / SpendPolicy | ✅ |
| C02 | 同 task 二次 draw（I5） | `test_RevertWhen_SecondDrawOnSameTask_I5` | Draw | ✅ |
| C03 | 换 nonce 重置额度（I5） | `test_RevertWhen_FreshNonceReusedOnSameTask_I5`<br>`test_RevertWhen_NonceReplayedOnAnotherTask_I5`（R4 修正：改走 `_drawDirect` 隔离）<br>`test_SmallerUnusedNonceStillValidAfterLargerOne_I5`（F15 正例） | Draw | ✅ |
| C04 | authDeadline 过期后 draw（I2） | `test_RevertWhen_AuthDeadlineExpired_I2`<br>`test_DrawAtExactAuthDeadlineSucceeds_I2`（边界） | Draw | ✅ |
| C05 | 身份轮换后旧 auth 复活（I3 版本号） | `test_RevertWhen_OldAuthReplayedAfterReapprove_I3`<br>`test_IdentityTransferLifecycle_OldAuthorizationIsDeadAfterReapprove`（真实转让全生命周期）<br>`test_AfterReapprove_FreshAuthorizationWorksAgain` | Draw / Identity | ✅ |
| C06 | 换钱包但快照未刷新时 draw/pay 被实时校验拦截（I3 实时项，r2 #2） | `test_RevertWhen_WalletRotatedAndSnapshotStale_I3`<br>`test_RevertWhen_OwnerTransferredAndSnapshotStale_I3`<br>`test_RevertWhen_StaleWalletPaysWithCashOnly_I3`（纯 cash 也拦）<br>`test_RevertWhen_AcceptTaskWithNoWalletBound` / `test_UnboundAgentHasNoValidOperator` | Draw / Identity | ✅ |
| C07 | I6 LTV 数值回归：feeBps 计入债务、协议费先扣、/10_000 不缺位（r2 #1） | `test_I6_BorderlineDrawSucceeds_DenominatorPresent`<br>`test_RevertWhen_PrincipalCapExceedsEscrowLtv_I6` | Draw | ✅ |
| C08 | principalCap 超 escrow LTV（I6） | `test_RevertWhen_PrincipalCapExceedsEscrowLtv_I6`<br>`test_RevertWhen_CapTooLargeEvenIfDrawIsSmall_I6`<br>`test_OneWeiAboveThePreClippedCapIsRefused` | Draw / Draw / Economics | ✅ |
| C09 | 清算清偿顺序逐层断言：cash 先动、escrow 只补不足（r2 #4） | `test_Liquidation_WaterfallTakesCashBeforeEscrow`<br>`test_Liquidation_AllFourLayers`<br>`test_Liquidation_EscrowLayerCappedByRemainingDebt` | Liquidation | ✅ |
| C10 | 债务 0.1 / escrow 1 / cash 0.2 场景：poster 拿回全部 escrow | `test_Liquidation_CashCoversDebt_PosterKeepsWholeEscrow` | Liquidation | ✅ |
| C11 | 无 loan 失败任务：全额退款不进清算（r2 #5） | `test_Settle_Failed_NoLoan_FullRefundNoLiquidation` ×2 | TaskLifecycle | ✅ |
| C12 | 清算足额回收仍记 Defaulted、不计正常还款（r2 #5） | `test_Liquidation_FullRecoveryStillRecordsDefault` | Liquidation | ✅ |
| C13 | 超时 liquidate 终结任务并退剩余 escrow，不等迟到 settle（r2 #5） | `test_LiquidateExpiredLoan_TerminatesTaskAndRefundsResidualEscrow` | Liquidation | ✅ |
| C14 | 被终结后 settle revert | `test_RevertWhen_SettleAfterLiquidation` | Liquidation | ✅ |
| C15 | 重复 settle / 重复 liquidate | `test_RevertWhen_SettleTwice` ×2<br>`test_RevertWhen_LiquidateTwice`<br>`test_RevertWhen_CancelTaskTwice` ×2 | TaskLifecycle / Liquidation | ✅ |
| C16 | 部分偿付后 loan 仍 Active | `test_PartialRepayment_LoanStaysActive`<br>`test_PartialRepayments_AccumulateToRepaid`<br>`test_OverPayment_SurplusReturnedToEscrow` ×2 | TaskLifecycle（`PartialRepaymentTest`：单元级 `repay` harness，见 F7） | ✅ |
| C17 | feedback 失败不阻塞清算 + retry 幂等 | `test_Settle_Passed_ReputationFailureDoesNotRollBackSettlement`<br>`test_Liquidation_ReputationFailureDoesNotBlockLiquidation`<br>`test_Settle_Passed_ReputationOutOfGasDoesNotRollBackSettlement`<br>`test_RetryFeedback_IsPermissionlessAndWritesExactlyOnce`（R3 修正：反馈类型先缓存，`expectRevert` 紧贴目标调用）<br>`test_RetryFeedback_StillFailing_StaysPending`<br>`test_RevertWhen_RetryFeedbackWithNothingPending` | Feedback | ✅ |
| C18 | 纯 cash 任务不产生 repayment 反馈 | `test_Settle_Passed_PureCashTask_WritesNoRepayment`<br>`test_SevenPureCashSuccesses_YieldZeroRepayments` | Feedback | ✅ |
| C19 | owner 解冻不能绕过协议冻结 | `test_OwnerCannotClearProtocolFreezeByRewritingPolicy`<br>`test_Liquidation_ProtocolFreezeSurvivesOwnerPolicyRewrite` | SpendPolicy / Liquidation | ✅ |
| C20 | 清算扣 cash 不受 ownerFrozen 阻止 | `test_Liquidation_DebitsCashDespiteOwnerFrozen`<br>`test_Liquidation_DebitsCashDespiteZeroPolicyLimits` | Liquidation | ✅ |
| C21 | SpendRejected 各 reason 的 revert data | reason 1 `test_RevertWhen_ProviderNotWhitelisted_Reason1` / `test_RevertWhen_PureCashToNonWhitelistedProvider_Reason1`<br>reason 2 `test_RevertWhen_CreditExceedsPolicyMaxDebtPerTx_Reason2` / `test_RevertWhen_CreditExceedsAuthPrincipalCap_Reason2` / `test_RevertWhen_CashSpendExceedsMaxCashPerTx_Reason2` / `test_RevertWhen_DailyDebtBudgetExhausted_Reason2`<br>reason 3 `test_RevertWhen_OwnerFrozen_Reason3` / `test_RevertWhen_ProtocolFrozen_Reason3`<br>reason 4 `test_RevertWhen_CreditNeededButAuthIsEmpty_Reason4` / `test_RevertWhen_CreditNeededButSignatureIsMalformed_Reason4`<br>reason 5 `test_RevertWhen_AuthIsForAnotherAgent_Reason5` | SpendPolicy | ✅ |
| C22 | 未接单取消全额退款（r3 #2） | `test_CancelTask_OpenTaskRefundsPosterInFull` ×2<br>`test_RevertWhen_CancelTaskAfterAssigned` ×2 | TaskLifecycle | ✅ |
| C23 | deadline 后无 loan 任务退款终结 | `test_ExpireTask_NoLoan_RefundsPosterAndFails` ×2<br>`test_ExpireTask_NeverAcceptedTaskRefundsPoster` ×2 | TaskLifecycle | ✅ |
| C24 | 非当前 registry wallet 接单被拒 | `test_RevertWhen_AcceptTaskFromNonRegistryWallet` ×2<br>`test_RevertWhen_AcceptTaskFromRotatedAwayWallet` ×2 | TaskLifecycle | ✅ |
| C25 | 失败路径 settle→liquidate 全程不因重入锁死锁（r3 #1） | `test_FailurePath_SettleToLiquidate_NoReentrancyDeadlock`（正向不死锁）<br>+ R6 主动重入：`test_ReentrancyGuardIsArmedOnPayProvider` ×2、`test_RevertWhen_ProviderReentersPayProvider`、`test_RevertWhen_PosterReentersCancelTask` | Liquidation / Atomicity | ✅ |
| C26 | processRefund 按比例冲减债务、fee 同步减免、不计还款次数（r3 #3） | `test_PartialRefund_ReducesPrincipalAndFeeProRata` ×2 | Refund | ✅ |
| C27 | 重复退款 revert | `test_RevertWhen_SameRefundIdReplayed` ×2<br>`test_RevertWhen_CumulativeRefundExceedsPayment` ×2<br>`test_RevertWhen_SingleRefundExceedsPayment` ×2 | Refund | ✅（v5.1 语义，见 F10） |
| C28 | 全额退款 → ClosedByRefund，到期不触发清算（r4 #2） | `test_FullRefund_ClosesLoanAsClosedByRefund` ×2<br>`test_ClosedByRefund_ExpiryDoesNotLiquidate` ×2<br>`test_RevertWhen_LiquidateClosedByRefundLoan` | Refund / Liquidation | ✅ |
| C29 | 部分退款保留剩余债务；Repaid 后退款全额入 cash 不再冲减 | `test_PartialRefund_RemainingDebtStillDue` ×2<br>`test_RefundAfterRepaid_GoesEntirelyToCash` ×2 | Refund | ✅ |
| C30 | Defaulted 后 recovery 逆序含 poster：LP → backstop → poster → cash（r4 #1） | 生产 LTV：`test_DefaultedRecovery_ProductionLtv_PosterThenCash` ×2<br>四层：`test_DefaultedRecovery_ReverseOrderCappedByRecordedBurden` ×2 | Refund（`RefundTest` / `DefaultedRecoveryOverLeveredTest`） | ✅ |
| C31 | 每层回补不超过 liquidations 记录的实际承担额 | `test_DefaultedRecovery_ZeroLossLayerReceivesNothing` ×2（生产 LTV）<br>`test_DefaultedRecovery_PartialRefundStopsMidLadder` ×2<br>`test_DefaultedRecovery_InstalmentsDoNotDoubleRefillALayer` ×2（见 F11） | Refund（后两个在超杠杆 harness） | ✅ |
| C32 | 任务到期而贷款未到期：liquidateExpiredLoan 可执行（r4 #3） | `test_LiquidateExpiredLoan_TaskExpiredButLoanStillInGrace`<br>`test_RevertWhen_LiquidateExpiredLoanTooEarly`（反向边界） | Liquidation | ✅ |
| C33 | expireTask 有 loan 走 push 路径，全程无重入死锁 | `test_ExpireTask_WithActiveLoan_PushPath_NoDeadlock` | Liquidation | ✅ |
| C34 | 纯 cash 支付（taskId=0）退款按 PaymentRecord.agentId 正确入账（r4 #4） | `test_PureCashPayment_RefundCreditedByPaymentRecordAgentId` ×2 | Refund | ✅ |
| C35 | liquidateWithEscrow 仅 TaskEscrow 可调、pull 型任何人可调 | `test_RevertWhen_LiquidateWithEscrowCalledByStranger`<br>`test_LiquidateExpiredLoan_IsPermissionless`<br>`test_RevertWhen_ReleaseForLiquidationCalledByStranger` | Liquidation | ✅ |
| C36 | ERC-20 模式分次退款：累计不超原额、每次金额显式传入（r5 #1） | `test_InstalmentRefunds_Erc20_AmountIsExplicitAndCapped`<br>`test_InstalmentRefunds_Erc20_TokensActuallyMove`<br>+ `Erc20RefundTest`（整套 Refund 规格在 ERC-20 下重跑） | Erc20Mode | ✅ |
| C37 | 同 refundId 重放被拒、不同 refundId 续退成功 | `test_RevertWhen_SameRefundIdReplayed` ×2<br>`test_SequentialRefunds_WithDistinctRefundIds_Accumulate` ×2<br>`test_SequentialRefunds_LastInstalmentClosesLoan` ×2（R6：另断言本金/fee/outstanding 清零与两腿实收）<br>`testFuzz_InstalmentRefundsEqualOneRefund` ×2（R6 舍入 fuzz）<br>`test_RefundRegistrationFailure_LeavesNoStrandedFunds` ×2（G3 原子性） | Refund / Atomicity | ✅ |
| C38 | ClosedByRefund 后任务成功：跳过 repay、记 task-success、不增还款次数（r5 #2） | `test_Settle_Passed_ClosedByRefund_SkipsRepayAndCountsNoRepayment` ×2 | TaskLifecycle | ✅ |
| C39 | ClosedByRefund 后失败/到期：退还 escrow、不进清算（r5 #2） | `test_Settle_Failed_ClosedByRefund_RefundsPosterNoLiquidation` ×2<br>`test_ClosedByRefund_ExpiryDoesNotLiquidate` ×2 | TaskLifecycle / Refund | ✅ |

**映射覆盖率：39 / 39 = 100%。**
再次强调（Codex R2）：这是**清单条目 → 测试函数的映射**完整，
**不是**"行为已验证"。行为通过的判据是该测试真正跑到目标断言并变绿。

### 2.0 第 2 轮修正后必须重新检查的四条（Codex R1–R4）

| 原问题 | 之前为什么到不了目标断言 | 现在 |
|---|---|---|
| R1 ERC-8004 ABI | 接口与 mock 同源自证，selector / 返回元数都和官方不符 | 接口逐字对齐规范；`AbiConformance.t.sol` 用规范字符串算 selector 对拍；mock 实现真实转让与绑定同意语义 |
| R2 三条 recovery 测试 | 债务 0.092 对 escrow 0.05，在继承的 LTV 8000 下 I6 只允许 0.04，正确实现会先拒绝 draw | 移入独立的 `DefaultedRecoveryOverLeveredTest`（`MAX_LTV_BPS = 20_000`）；生产 LTV 的 recovery 另建 `test_DefaultedRecovery_ProductionLtv_PosterThenCash` |
| R3 `expectRevert` 被 getter 消耗 | `escrow.FEEDBACK_*()` 写在参数里，成了 `expectRevert` 之后的"下一次调用" | 反馈类型在 `setUp` 里缓存为 `FB_*`；`expectRevert` 与 `prank` 紧贴目标调用 |
| R4 nonce 重放先撞额度 | 第二次 quote 0.12 对 cap 0.08，AgentAccount 先抛 reason 2 | 改走 `_drawDirect`，`amount == cap == 0.08`，唯一无效输入就是 nonce |

### 2.1 第 3 轮（Codex R2 复核）修正的四处

| 原问题 | 之前错在哪 | 现在 |
|---|---|---|
| **A** ERC-20 重入镜像断言了不会发生的攻击 | 普通 ERC-20 `transfer` 不回调接收方，`arm()` 之后根本没有攻击，正确支付本应成功，镜像测试却期待 revert | 原生 receiver 回调用例在 ERC-20 下 `vm.skip`；新增正例 `test_PlainErc20TransferGivesReceiverNoCallback`（断言回调**没有**发生、支付成功、只付一次）；另给 `MockERC20` 加**显式的、默认关闭的** `cheatSetTransferHook`，用来模拟"敌意的、带回调的结算代币"这一独立攻击面，不与普通 ERC-20 混为一谈 |
| **B** 原生币重入期待了错误的 error | `SafeTransferLib.safeTransferNative` 丢弃内层 revert data，抛 `NativeTransferFailed`，所以 `expectRevert(ReentrantCall.selector)` 即使 guard 完全正确也匹配不上 | 拆成两个问题：外层失败用例改期待 `NativeTransferFailed(provider, amount)`；**guard 本身**由新用例证明——攻击者用低级 `call` 捕获内层 selector、正常返回，测试直接断言 `ReentrantCall`、攻击确实触发、provider 只被支付一次、内层 paymentId 未落账。后者在两种结算模式下都跑 |
| **B'** 攻击者不是该 agent 的 wallet | 删掉 guard 后内层调用仍会被 `onlyAgentWallet` 拒绝，测试会因**鉴权**而非 guard 通过 | `ReentrantAgent` 现在**同时是**该 agent 的 registry wallet 和白名单 provider，内外两层 `msg.sender` 都是合法 wallet。除 guard 外所有前置条件成立——删掉 guard，内层就会成功，用例必然失败 |
| **C** 一条 I5 用例同时违反 I6 | `test_RevertWhen_FreshNonceReusedOnSameTask_I5` 用 cap = 1（债务 1.15）对 reward 0.15（上限 0.12），却精确要求 `LoanAlreadyExists`，等于偷偷规定了 I5 早于 I6 | cap 与 amount 均改为 0.08（债务 0.092 ≤ 0.12），并在测试里用 `assertLe` **显式断言夹具自身满足 I6**，唯一违反的只剩 I5；走 `_drawDirect` 避开 Account 策略层的第二个失败源。同类问题的 `test_RevertWhen_PrincipalCapTamperedAfterSigning_I2` 一并修（篡改值 0.11 → 0.09，保持 I6 内） |
| **D** mock 仍有非标准行为 | conformance 正例让 agent owner 自评、反馈编号从 0 开始，都与官方规范相悖，"通过"不能算 canonical 行为验证 | mock 补齐官方语义：owner 自评拒绝、agent 必须存在、`valueDecimals ≤ 18`、**反馈编号对外 1-based**（内部数组仍 0-based）。conformance 用例改用独立 reporter、按 index = 1 读取，并补 4 条反例。Identity mock 的 `walletBindingDigest` 标注为**简化哈希、非 EIP-712**，不得据此声称签名兼容 |

### 2.2 第 2 轮新增的验收约束（Codex R5–R6 与裁决）

| 来源 | 测试 | 文件 |
|---|---|---|
| R5 协议费快照 | `test_ProtocolFeeIsSnapshottedAtTaskCreation` ×2、`test_RateChangeAfterDrawDoesNotBreakAnExistingLoan` ×2、`test_RateChangeAppliesToTasksCreatedAfterwards` ×2 | TaskLifecycle |
| R6 支付失败全回滚 | `test_PaymentLegFailure_RollsBackEveryLedger` ×2、`test_AfterPaymentLegFailure_SameAuthorizationStillWorks` ×2、`test_PureCashPaymentLegFailure_RollsBack` ×2、`test_PaymentLegFailure_NoAssetsStrandedInTheAccount` ×2 | Atomicity |
| R6 主动重入 | `test_ReentrancyGuardIsArmedOnPayProvider` ×2（精确断言 `ReentrantCall`）、`test_RevertWhen_ProviderReentersPayProvider`（原生，期待 `NativeTransferFailed`）、`test_PlainErc20TransferGivesReceiverNoCallback`（ERC-20 正例）、`test_RevertWhen_PosterReentersCancelTask`（原生） | Atomicity |
| R6 分次退款舍入与守恒 | `testFuzz_InstalmentRefundsEqualOneRefund` ×2、`test_SequentialRefunds_LastInstalmentClosesLoan` ×2 | Refund |
| R1 身份生命周期 | `IdentityTest` 全部 7 个 | Identity |
| R2-D canonical 反馈语义 | `test_ReputationRegistry_OwnerMayNotReviewItsOwnAgent`、`test_ReputationRegistry_FeedbackIndicesAreOneBased`、`test_ReputationRegistry_RejectsFeedbackForUnknownAgent`、`test_ReputationRegistry_RejectsOversizedValueDecimals` | AbiConformance |
| R1 summaryValue 无关性 | `test_InferScoreDependsOnCountOnlyNotOnSummaryValue`、`test_SummaryValueDivergesButCountDoesNot` | Feedback |
| G3 登记与资金同交易 | `test_RefundRegistrationFailure_LeavesNoStrandedFunds` ×2 | Atomicity |
| G4 解冻不改写历史 | `test_UnfreezeDoesNotEraseDefaultHistory`、`test_UnfreezeDoesNotRefreshTheIdentitySnapshot`、`test_RevertWhen_UnfreezeCalledByStranger` | SpendPolicy |
| F3 退款不恢复 epoch 预算 | `test_RefundDoesNotRestoreEpochDrawBudget` ×2 | Refund |
| F8 实收以真实余额验证 | `test_Settle_Passed_WaterfallOrderAndAmounts` ×2（新增余额断言）、`test_OverPayment_SurplusReturnedToEscrow` ×2 | TaskLifecycle |
| F13 settle / expire 竞态 | `test_AfterDeadline_SettleFirstWins` ×2、`test_AfterDeadline_ExpireFirstWins` ×2 | TaskLifecycle |
| F15 nonce 集合语义正例 | `test_SmallerUnusedNonceStillValidAfterLargerOne_I5` | Draw |

### 2.1 不变量 I1–I7 的额外覆盖（清单未逐条列出，但 §4.5 要求"逐条 require"）

| 不变量 | 测试 |
|---|---|
| I1 drawPaused / 协议冻结 | `test_RevertWhen_DrawPaused_I1`、`test_RevertWhen_AgentProtocolFrozen_I1`、`test_PureCashPaymentUnaffectedByDrawPause_I1` |
| I2 验签 / nonce / authDeadline | `test_RevertWhen_SignerIsNotUnderwriter_I2`、`test_RevertWhen_PrincipalCapTamperedAfterSigning_I2`、C03、C04 |
| I3 双重身份校验 | C05、C06（版本号项与实时项各自独立成测） |
| I4 task 存在 / Assigned / agent 匹配 / 未过期 | C01、`test_RevertWhen_TaskStillOpen_I4`、`test_RevertWhen_TaskDoesNotExist_I4`、`test_RevertWhen_TaskDeadlinePassed_I4` |
| I5 每任务单次 draw | C02、C03 |
| I6 额度与 LTV | C07、C08、`test_FeeIsChargedOnActualDrawNotOnCap_I6`、`test_RevertWhen_AmountExceedsPrincipalCap_I6` |
| I7 两道全局 cap | `test_RevertWhen_TotalOutstandingCapExceeded_I7`、`test_RevertWhen_EpochDrawCapExceeded_I7`、`test_EpochBudgetResetsNextEpoch_I7`、`test_RevertWhen_VaultHasNoLendableLiquidity` |
| §4.6 权限表 | `test_RevertWhen_DrawCalledDirectlyByEOA`、`test_RevertWhen_RepayCalledByStranger`、`test_RevertWhen_ProcessRefundCalledByStranger`、`test_RevertWhen_CreditCashCalledByStranger`、`test_RevertWhen_DebitForLiquidationCalledByStranger`、`test_RevertWhen_RegisterRefundCalledByStranger`、`test_RevertWhen_SettleByNonVerifier`、`test_RevertWhen_ReportFeedbackFromNonReporter`、`test_RevertWhen_EnrollFromNonCreditManager`、`test_RevertWhen_ReapproveFromNonCreditManager` |
| §6.1 demo 经济学 | `test_DemoThreeOrderEconomics_ResiduesMatchTheDocument`、`test_TierA_RequiresBothScoreAndRepaymentHistory`、`test_UnderwriterPreClippedCapAlwaysPassesI6` |

---

## 3. 规格疑点：Codex 裁决与落实状态

第 1 轮提出 24 条，Codex 逐条裁决。下表是**裁决后的最终状态**，
"落实"列写清代码里实际怎么做的。原始裁决全文见 `REVIEW_CODEX.md` §4。

图例：✅ 已按裁决落实 · 📝 规格待补（代码已留出位置） · 🔒 维持原立场（裁决同意）

### 3.1 接口缺口裁决（已于 2026-10-01 同步 ENGINEERING v5.3）

| 项 | 裁决 | 落实 |
|---|---|---|
| **G1** `TaskStatus` 缺 `Cancelled` | 同意，但**首位加 `None` 会改变已有成员的数值**，不能声称原值不变 | ✅ 枚举改为 `{None, Open, Assigned, Settled, Failed, Cancelled}`；`ITaskEscrow.sol` 的注释已改成"Open 现在是 1 不是 0，尚未部署所以现在改是免费的，但任何引用旧序号的链下代码/文档必须同步" |
| **G2** `Task` 缺 `deadline` 与可变托管余额 | 同意，`reward` 保留原额 | ✅ 加 `deadline` + `escrowBalance`，`reward` 不可变 |
| **G3** `processRefund` 与 `payments`/`refundConsumed` 不同合约 | 同意补入口；**资金到账、登记、债务调整必须同交易原子完成，登记失败不能留下已收款** | ✅ `IAgentAccount.registerRefund(paymentId, refundId, amount) onlyCreditManager`；原子性由 `test_RefundRegistrationFailure_LeavesNoStrandedFunds` ×2 钉住 |
| **G4** 协议冻结没有出口 | 同意需要重审出口；**解冻不得清除真实违约历史**，快照刷新应与重审关联 | ✅ `unfreezeAgent` onlyGuardian，骨架注释明确"不得触碰 `defaultCount` / loan 终态 / 身份快照"；三个测试钉住 |
| **G5** 协议费没有归属 | 同意统一来源，**但不充分**：还缺"读哪个时点的费率" | ✅ 归属 TaskEscrow + 📝 见 R5（下） |
| **G6** `reportFeedback` 无返回值 | **不同意我的因果解释**：`Escrow → Adapter → Registry` 里 registry 看到的 client 始终是 Adapter，与 catch 放在哪无关；内部 catch + bool 是可行的实现选择，不是修正 client 归属的必要条件 | ✅ 接受。`returns (bool)` 保留，但骨架与接口注释已改写：client 归属由"谁直接调 registry"决定，与 catch 位置无关；内部 catch 的理由改述为"把 review #5 的规则收在一处，而不是每个调用点各写一遍"。`test_FeedbackIsAttributedToTheAdapterAsClient` 仍然有效（它钉的是 client 是 Adapter，本来就与 catch 位置无关） |

### 3.2 新增：Codex 提出的两条验收缺口

| 项 | 内容 | 落实 |
|---|---|---|
| **R5** 协议费缺跨交易稳定规则 | setter 可随时改，Task 没有费率快照。reward 0.15 / 债务 0.092 在 0 bps 下过 I6；随后改成 5000 bps，结算先扣费只剩 0.075，无法足额偿债 | ✅ `Task.protocolFeeBps` 在 `createTask` 时快照；I6 与结算 waterfall 都读 `payableEscrow(taskId)`（基于快照），**不读** `TaskEscrow.protocolFeeBps()`。三个回归测试 ×2 |
| **R6** 原子性与分次退款 | happy path 只付给 EOA（永不失败）；"不死锁"不能代替主动重入；分次退款没验本金/fee/outstanding 清零与舍入 | ✅ `Atomicity.t.sol`（16 个）+ `testFuzz_InstalmentRefundsEqualOneRefund`。失败回滚断言覆盖 cash / vaultBalance / outstanding / drawnInEpoch / loan / nonce / paymentId **以及合约的真实资产余额** |

### 3.3 语义矛盾 / 死代码 / 定义不足

| 项 | 裁决 | 落实 |
|---|---|---|
| **F1** authDeadline 边界 `<` vs `<=` | 同意按显式不变量统一：authDeadline 用 `<=`，task 的 accept/draw 仍用 `< deadline`，两种边界都要写清 | ✅ `test_DrawAtExactAuthDeadlineSucceeds_I2`（含）与 `test_RevertWhen_AcceptTaskAfterDeadline` / `test_RevertWhen_TaskDeadlinePassed_I4`（不含）分别钉住 |
| **F2** I6 左边是 `principalCap` | **保留现有 cap 规则**：I6 校验授权上限，fee 按实际提款计，两者不矛盾；underwriter 预裁剪已解决正常路径，不必重开架构选择 | 🔒 无改动。`test_RevertWhen_CapTooLargeEvenIfDrawIsSmall_I6` 与 `test_FeeIsChargedOnActualDrawNotOnCap_I6` 保留，注释改为"这是既定规则"而非疑点 |
| **F3** epoch 计本金还是债务 | 接受所选口径：epoch 按新增**本金**，outstanding 按本金 + fee；**并明确退款不恢复本 epoch 预算** | ✅ 新增 `test_RefundDoesNotRestoreEpochDrawBudget` ×2 |
| **F4** slash 上限口径不一致 | 同意：以"补剩余债务（含 fee），以可用 escrow 为限"为准，RISK 文案同步 | ✅ 测试按 §4.2；RISK_AND_MVP §1.2 已于 2026-10-01 同步为剩余本金+fee，并以 escrow 为限 |
| **F5** "补足 backstop" 无目标水位 | 同意缺目标；**死代码说法需限定**——若 backstop 按 agent 共享，跨任务补足是另一种可定义规则。P0 应明确"没有自动补足"，而不是让实现者猜 | ✅ 骨架注释改为"P0 **没有**自动补足；被消耗的 backstop 只能由显式 `fundBackstop` 或 Defaulted recovery 回补，ENGINEERING v5.3 §4.4 已删除旧“补足 backstop”步骤"。`test_Settle_Passed_DoesNotTouchUnconsumedBackstop` 保留 |
| **F6** 两层不可达 / 风险归属 | **同意，补前提**：在 LTV ≤ 100%、费用条款稳定、escrow 完整且资产正常时成立。借款 agent 没交抵押 ≠ 池子无保障；poster 承担 escrow 罚没敞口。**不要通过放宽生产 LTV 强行制造 demo 损失** | 🔒 维持立场并补全前提。生产 LTV 一行未改；超杠杆只存在于两个明确隔离、显式命名的 harness 里，且注释写明"只有配置错误才能到达" |
| **F7** 部分偿付不可达 | **部分同意**：正常结算不会部分偿付，但不代表 `repay` 的单元分支不能测，也不能只因 happy path 不可达就删掉已约定接口；用隔离 harness，**避免制造"Task 已 Settled 却还有 Active 债务"的混合状态** | ✅ 采纳。`PartialRepaymentTest` 重写为**单元级 harness**：prank 成 TaskEscrow 直接调 `repay`，不再经 `settle`，因此不产生混合状态；超杠杆夹具随之删除。新增 `test_PartialRepayments_AccumulateToRepaid` 与 `test_OverPayment_SurplusReturnedToEscrow`，并镜像到 ERC-20 |
| **F8** `repay` 多收的钱归属 | 同意必须明确实收；**用合约真实资产余额验证，不能只查 `vaultBalance` 账本** | ✅ 选定"Manager 只留 `applied`，余额原路退回 Escrow"；`test_OverPayment_SurplusReturnedToEscrow` 与 waterfall 测试都改成对 `_balanceOf(address(manager))` / `_balanceOf(address(escrow))` 断言 |
| **F9** 按比例拆分只适用 Active | 同意按终态分支；None 的纯 cash 退款也需明确 | ✅ 四个分支各有测试，纯 cash（taskId = 0）由 `test_PureCashPayment_RefundCreditedByPaymentRecordAgentId` ×2 覆盖 |
| **F10** "全额退款"的分母 | 接受"全 payment 退款才关闭"，**但我的反例算错了**：0.04 cash + 0.08 credit 按比例退 0.08 只冲减约 0.053333 credit，仍剩约 0.026667 本金，本来就关不掉；"退 0.08 就能关闭"需要信用优先退款，会违反按比例规则 | ✅ 反例已从本文删除。补累计舍入测试 `testFuzz_InstalmentRefundsEqualOneRefund` ×2 |
| **F11** recovery 与分次退款重复回补 | 同意累计封顶；**建议保留原始 `LiquidationRecord`，另记已回补额**，便于审计，不必破坏原始记录 | ✅ 采纳。新增 `mapping(taskId => LiquidationRecord) _recovered` + `getRecovered(taskId)`；每层上限 = 承担额 − 已回补额。`test_DefaultedRecovery_InstalmentsDoNotDoubleRefillALayer` 现在同时断言"原始承担额记录未被改写" |
| **F12** GRACE 被架空 | **接受现有 OR 条件**：GRACE 是贷款到期分支的缓冲，不是任务到期后的统一宽限；改成 `max(...)` 会推迟原有贷款到期出口，不是等价澄清 | ✅ 采纳，不改条件。`test_LiquidateExpiredLoan_TaskExpiredButLoanStillInGrace` 保留，注释改为"这是既定语义" |
| **F13** settle / expire 抢跑 | 风险判断成立；**至少增加两种交易顺序的测试**并明确由链上执行顺序裁决；给 verifier 单独窗口属产品规则变更 | ✅ 新增 `test_AfterDeadline_SettleFirstWins` ×2 与 `test_AfterDeadline_ExpireFirstWins` ×2 |
| **F14** reason 4 与 I1–I7 分层 | 接受可诊断分层；**拒绝测试应隔离单一违规条件**，先修 R4；多条件同时违规的优先级若要规定需单列测试 | ✅ 分层不变。R4 已修（改走 `_drawDirect`）。目前不规定多条件优先级，故**没有**多条件测试——这是有意留白，不是遗漏 |
| **F15** nonce 是否单调 | 保留未消费集合语义；**增加"先消费大 nonce 再消费小的未用 nonce"的正例** | ✅ 新增 `test_SmallerUnusedNonceStillValidAfterLargerOne_I5` |
| **F16** "钱必须流向 provider" 无法在 Manager 侧验证 | 同意信任边界描述，**但验收不足**：补转账失败与重入后的资金/账本原子性验证 | ✅ 由 R6 的 `Atomicity.t.sol` 补齐 |
| **F17** demo 隐含 protocolFeeBps = 0 | 同意；第三单按 B 计费、结算后升 A；**数学通过后仍需真实 underwriter/SDK 集成验证** | ✅ `test_DemoNumbersRequireZeroProtocolFee` 保留；集成验证属链下服务范围，不在本工程 |
| **F18** `LiquidationRecord` 缺 `agentId` | **不需要额外冗余字段**：`taskId → loan` 永久保留且 agentId 不变，读 `loan.agentId` 足够；加重复字段会引入两份归属数据 | ✅ 采纳，撤回该建议，结构体不加字段 |

### 3.4 开工默认口径——已同步工程规格，变更时同时调整测试

Codex R2 的裁决：**不需要把五项都交给审批**，现有口径可执行，按默认继续即可。
下面产品默认口径**已经落实到合约和测试**，canonical fork 已完成本地验证；若文档所有者要改，
“变更后要动什么”一列给出影响面。

| 项 | 合约与测试约定的默认口径 | 变更后要动什么 |
|---|---|---|
| **费率变更** | 任务创建时快照 `Task.protocolFeeBps`；旧任务的 I6 与结算都用同一份快照 | 改为"存在敞口时禁止改费率"则 `setProtocolFeeBps` 需加敞口检查，`Task.protocolFeeBps` 可删，3 个快照回归测试作废 |
| **backstop 补足** | P0 **无自动补足**；只有显式 `fundBackstop` 与 Defaulted recovery 会回补。ENGINEERING v5.3 §4.4 已删除旧“补足 backstop”步骤 | 若要跨任务共享补足，需要先定义目标水位，再新增对应测试 |
| **verifier 窗口** | 不设窗口，由链上交易顺序裁决；两种顺序都已有测试 | 给 verifier 宽限期属产品规则变更，`test_AfterDeadline_ExpireFirstWins` 的期望值需改写 |
| **多条件错误优先级** | **暂不规定**。配套保证：每条拒绝用例只违反一个条件（R2-C 已修两处，并在 I5 用例里用 `assertLe` 把"夹具自身满足 I6"钉成断言） | 若要规定优先级，需单列多条件测试；现有单条件用例不受影响 |
| **canonical fork 验证** | 已独立复跑：Monad 测试网 10143、区块 67277702 | `spike/Day0Canonical.t.sol` 验证真实钱包签名、转移、声誉写入与 client 过滤。详见 `../docs/day0-findings.md`；真实广播与 SDK 仍待联调 |

额外记录两条已知的"替身不等于真身"：

1. `MockIdentityRegistry.walletBindingDigest` 是简化的结构体哈希，**不是** EIP-712
   规范编码。它足以模拟"新钱包必须在 deadline 前同意"，但**不能**用来声称
   SDK 的钱包签名与 canonical registry 兼容。真实格式已由 Day-0 fork 验证，SDK 实现后仍须独立联调。
2. `MockReputationRegistry` 未模拟 approved-operator 排除（本 mock 没有 ERC-721
   approval 面）、反馈授权 / allow-list，以及真实 registry 自己的 `summaryValue`
   聚合口径。协议只消费 `count`，这一依赖由 `Feedback.t.sol` 两条测试钉住。

## 4. 怎么跑

```bash
export PATH="$PATH:$HOME/.foundry/bin"
cd contracts

forge build                 # 必须零错误
forge test                  # 408 个：404 通过 / 0 失败 / 4 跳过

forge test --match-path test/AbiConformance.t.sol -vv   # ERC-8004 ABI 对拍
forge test --match-test test_I6                          # I6 回归
forge test --match-contract Erc20                        # ERC-20 模式
forge test --match-contract Atomicity                    # 失败回滚与重入
```

每实现一个模块，先确认相关测试**从"死在更早的 require"变成"死在目标断言"**，
再以变绿作为该行为通过的证据。这是本套件目前唯一有效的正确性验证流程——
红灯本身不是证据。


## 5. 实现推进顺序（按 Codex §5 调整）

原顺序的依赖方向正确，但开头需要改：测试大量经 `_registerAndEnroll`、
`_seedVault` 等公共步骤建场景，所以单独实现 Adapter 并不会让 I3 / Feedback
的测试立刻转绿。

1. **先把 R1–R4 的修正吃透，确认 R5 费率条款，跑一遍 R6 的新测试**——
   ABI 与 mock 已同步，这一步现在是"读懂并确认口径"，不是写代码。
2. 打通部署接线、Adapter 身份生命周期、`enroll`、vault / cash / backstop 入金、
   Policy 与 whitelist。先让这些基础功能有可独立执行的测试
   （`Identity.t.sol`、`SpendPolicy.t.sol` 的权限组）。
3. 任务 create / accept / cancel / expire 的**无债务分支** + 纯 cash 支付。
   原生币与 ERC-20 同步验收（`Erc20TaskLifecycleTest` 会一起变绿）。
4. `draw` + `payProvider`：I1–I7、支付失败回滚（`Atomicity.t.sol`）、
   真实 identity 变更与旧授权失效（`Identity.t.sol`）。
5. `repay` + `settle` + 反馈失败与重试：**物理余额与账本必须同时守恒**
   （`test_OverPayment_SurplusReturnedToEscrow` 是这一步的验收锚点）。
6. 生产 LTV 的两条清算入口，再跑隔离的多层损失 harness
   （`LiquidationOverLeveredTest`）。
7. 退款各状态分支，最后跑累计退款、recovery、舍入 fuzz 与端到端。

每一步先确认失败已经**到达目标断言**（而不是死在更早的 require 上），
再以测试变绿作为该行为的证据。


## 6. 六批实现验收（2026-10-01）

| 批次 | 已验收行为与主要锚点 |
|---|---|
| 1 基础 | Foundations：实时身份/版本、独立双冻结、vault/backstop 分账、真实资金与重入回滚 |
| 2 任务与 cash | TaskLifecycle、CashLifecycle：创建/接单/取消/无债务到期、纯 cash 无授信依赖 |
| 3 授信 | Draw、CreditDraw、Identity、Atomicity：I1–I7、严格签名、两资产模式、付款腿精确失败与全账本回滚 |
| 4 还款结算 | PartialRepayment、Settlement、Feedback、Economics：超额退款、不足拒绝、反馈失败/retry、三单数字 |
| 5 清算 | Liquidation、LiquidationSafety：两类入口、cash 优先、原始承担额、default 幂等重试、到期计算防溢出 |
| 6 退款 | Refund、RefundSafety：累计封顶/舍入、已收 fee 比例返还、零债务关闭、回补失败全回滚 |

另由主 reviewer 补 DeployConfig：部署脚本拒绝超过 100% 的 BPS 与 uint16 截断输入。
新增场景按需要复用 native/ERC-20 套件；超杠杆夹具保持隔离，没有放宽生产 I6。

v5.3 明确的局部口径：

- 退款后剩余 principal+fee 为零即 ClosedByRefund。部分还款或 wei 舍入都可能使其早于全 payment 退款；
  后续退款继续入 cash，已收 fee 仅按原始 fee × 累计退款额 / 原支付总额的新旧差额返还。
  这修正 §3 F10 历史“全 payment 退款才关闭”的绝对表述；不会制造零债务 default。
- default 的 sent 状态由 Manager 保存，pending 从 Defaulted 且未 sent 推导；
  Escrow 原查询和 retryFeedback(type=3) 单向代理 Manager，不增加清算回调环。
- ERC-20 push 清算使用 Escrow 按确切金额授权的 allowance 传递金额，Manager 全部拉取并耗尽；
  其他任务资金和 backstop 不得被借用。不得在该通道使用无限授权。

最后独立命令：`forge test --json`（exit 0）、`forge build --sizes`、改动文件 `forge fmt --check`。
后续已完成 §3.4 canonical 本地 fork；ENGINEERING §3 的真实广播、支付与模型联调仍待完成；
本次未执行部署，也未声称 SDK / relay / Arena / 前端已完成。

## 7. Day-0 与部署配置验收（2026-10-01）

- `spike/Day0Canonical.t.sol`：Monad 测试网固定区块 67277702，本地 fork 1 passed，主 Agent 独立复跑一致。
- `DeployConfig.t.sol`：主网/测试网默认地址、未知链显式地址对、单边/零地址拒绝、广播前 code 与 Identity 引用检查。
- 原生币保留 50e18 / 20e18 默认限额；ERC-20 必须显式配置原始单位。示例 USDC 为 50_000_000 / 20_000_000，测试实际部署 Manager 后核对。
- `AbiConformance.t.sol` 新增空 clients 精确拒绝及报告者过滤；canonical 的同一行为已在 fork 验证。
- Foundry 的 `vm.setEnv` 为进程共享状态，配置断言在一个测试内顺序执行并还原公共配置，避免并行串扰。
- 本批主 Agent 独立复跑默认套件：408 tests / 404 passed / 0 failed / 4 skipped（38 suites），改动文件格式检查通过。执行 Agent 额外以 8 workers 复跑结果一致。
- 未执行真实部署；公共 RPC、资产与钱包签名证据及未完成项见 `../docs/day0-findings.md`。

## 8. Underwriter 本地接缝验收（2026-10-01）

源码与完整命令见 `../services/underwriter/README.md`。本批未改业务 Solidity。
主 Agent 独立运行 Node 22 的 `npm run typecheck`、`npm test`：均 exit 0，TAP 4 passed / 0 failed。
4 项包含一个纯规则测试、一个集成父测试及 USDC-6/native-18 两个子测试，不把父测试计作额外业务场景。

- 两种资产均经真实 HTTP 获取 TypeScript EIP-712 授权，再由本地 Anvil 四合约执行 `payProvider → draw`，校对 digest、loan、provider 实际余额、cash、nonce、totalOutstanding。
- USDC 黄金首单：reward 150_000、C cap 104_347、cash 40_000、报价 120_000、draw 80_000、fee 12_000。
- nonce 重放金额改为 80_000 以先满足 cap，精确断言 `NonceAlreadyUsed`，排除额度上限提前拒绝的假阳性；到期用独立未消费 nonce 的长任务，精确断言 `AuthExpired`。
- 拒绝错误 network/signer/asset/decimals、任务归属、身份变化、冻结/暂停、零 cap；输入 uint256、证据哈希和存储失败均有断言。
- 真实 settle 时注入镜像写入失败，断言 pending 与计数，再 retry；镜像落后只推迟升级。真实账本违约即使镜像为零也拒绝，镜像单独有违约同样拒绝。
- 反馈采用可捕获失败分支，`estimateGas` 可能只保证交易成功而不保证反馈成功；后续调用方必须检查 pending/count，必要时用充足 gas retry，不能仅看 receipt status。
- 执行 Agent 复跑 Foundry 离线基线仍为 408 tests / 404 passed / 0 failed / 4 skipped；fmt/build 通过。测试自动清理自身 Anvil 与临时证据，没有测试网广播。

后续范围：relay/SDK 的 402 receipt 流程、Arena 与演示整链联调；标准 x402 facilitator 兼容性仍未验证。
