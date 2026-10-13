# Foundry 测试交付 review（2026-09-14）

结论：可以继续沿现有架构实现，但当前测试不能直接作为冻结的验收标准。确认了 4 处会阻塞正确实现或真实集成的问题，另有费率生命周期和资金失败路径需要补测试。以下是 review 意见，没有修改原测试、合约或工程规格。

审查对象：`AGENT_CREDIT_ENGINEERING.md` v5.1、`contracts/src/`、`contracts/test/`、`contracts/TEST_PLAN.md`。

## 1. 已验证结果与边界

- 本地 `forge build` 编译成功；`forge test --summary` 为 **188 tests：6 passed / 181 failed / 1 skipped**，与交付报告一致。构建有 Forge lint 提示，不宜泛称“零警告”。
- 业务函数仍为 `NotImplemented`。预期的 TDD 红灯本身不是缺陷，但尚不能验证 181 个测试会在正确实现上变绿，也不能把清单有映射等同于行为覆盖完整。
- 6 个绿灯主要验证管道层和测试内的参考计算；评分参考函数通过不等于真实 underwriter 已经通过验收。
- 对下述 R3 用独立、临时的最小 Foundry 工程复现：在 `expectRevert` 后执行 getter 的版本失败（`next call did not revert as expected`），先缓存 getter 的版本通过。临时工程已删除。

## 2. 需要修正的交付问题

### R1 · P1：ERC-8004 的接口与 mock 不是 canonical ABI

位置：`src/interfaces/IReputationRegistry.sol:24`、`:35`，以及 `IIdentityRegistry.sol` / 两个 Registry mock。

当前 reputation 接口声明了五参数 `giveFeedback`，并把 `getSummary` 声明成不同参数顺序、两项返回值。官方接口为：

```solidity
giveFeedback(uint256 agentId, int128 value, uint8 valueDecimals,
             string tag1, string tag2, string endpoint,
             string feedbackURI, bytes32 feedbackHash)

getSummary(uint256 agentId, address[] clientAddresses,
           string tag1, string tag2)
    returns (uint64 count, int128 summaryValue, uint8 summaryValueDecimals)
```

参数差异会改变 selector，返回值差异也会破坏解码；`summaryValue` 不能按当前 mock 的“总和再除以次数”契约处理。mock 与自定义接口一致，只能证明自定义系统内部互通。连真实 registry 时会失败；如果写反馈被 catch，表现可能是反馈一直 pending。

Identity 的 `setAgentWallet` 也缺少 `deadline` 和签名参数。`cheatSetOwner` 注释说模拟身份转移，却没有清空 wallet；标准转移会清空 wallet，重新绑定需要验证。应保留独立篡改状态的单元测试工具，但另加真实转移生命周期测试：transfer → wallet 为零 → 重新绑定 → 重审 → 旧授权失效。

修正：先对齐目标部署实际使用的官方 ABI、返回语义和事件，再同步 mock / Adapter / 调用方。增加不依赖这份手写接口自证的集成或 ABI conformance 检查。

依据：[ERC-8004 官方规范](https://eips.ethereum.org/EIPS/eip-8004)。本轮核对了规范；尚未对项目指定链上的部署做 fork 验证。

### R2 · P1：三条 recovery 测试到不了清算阶段

位置：`test/Refund.t.sol:315`、`:366`、`:408`；基础 LTV 在 `test/helpers/InferCreditTestBase.sol:84`。

三个场景均为 reward = 0.05、principalCap = 0.08、feeBps = 1500，要求债务 0.092。它们继承的 LTV 是 8000，因此 I6 允许的债务只有 0.04，正确的 `draw` 必须拒绝。注释称“over-levered fixture”，实际却没有切换夹具。ERC-20 继承套件也受影响，共 6 个测试。

修正：把这些场景移到明确隔离的清算/回补测试 harness，或专门的测试配置。正常 LTV 的真实流程继续覆盖 cash / poster recovery；不可为了让测试通过而放宽生产 I6。`LiquidationOverLeveredTest` 已有隔离的做法，Refund 这三项遗漏了。

### R3 · P2：`expectRevert` 被常量 getter 消耗

位置：`test/Feedback.t.sol:208`、`:225`。

`vm.expectRevert(...)` 后调用 `escrow.retryFeedback(taskId, escrow.FEEDBACK_...())`，实际下一次外部调用是参数里的 getter。getter 正常返回，Foundry 因而报错，尚未执行期望失败的 `retryFeedback`。同类 getter 还会消耗前面的单次 `vm.prank`，削弱“任意调用者可重试”的验证。

修正：先缓存 `uint8 feedbackType`，然后设置 `prank` / `expectRevert`，最后只调用目标函数。检查同文件所有 `vm.prank` 后的 getter 参数，不仅两条 revert 用例。

### R4 · P2：nonce 重放场景先违反了借款额度

位置：`test/Draw.t.sol:383–397`。

`_demoOrderOne()` 完成支付后 cash 为零，未结算。第二次 quote 仍是 0.12，但授权 cap 只有 0.08。因此按 TEST_PLAN F14 自己选择的错误分层，Account 应先抛 `SpendRejected(reason=2)`，无法到 Manager 的 `NonceAlreadyUsed`。

修正：第二次 quote 改成不超过 cap 的金额，或补齐所需 cash，或用 `_drawDirect` 隔离 nonce 校验。应只有目标 nonce 条件不满足，其余输入全部有效。

## 3. 实现前应补的验收约束

### R5 · P2：协议费缺少跨交易的稳定规则

位置：`src/TaskEscrow.sol:96–99`、`src/interfaces/ITaskEscrow.sol` 的 `Task`，TEST_PLAN G5。

G5 解决了“从哪读协议费”，没有解决“读哪个时点的费率”。当前 setter 随时可改，Task 没有费率快照。按骨架的实时读法，reward = 0.15、债务 = 0.092、放款时协议费为零可通过 I6；随后改为 5000 bps，成功结算先扣费后只剩 0.075，无法足额偿债。

建议：创建任务时快照费率/费用，此后 I6 和结算都使用同一份快照；或明确禁止存在相关敞口时更改费率。新增“放款后修改全局费率，旧任务经济条款不变”的回归。当前业务实现为空，这里指出的是可执行规格缺口，不是已经复现的资金损失。

### R6 · P2：原子性与分次退款需要验证失败后状态和舍入

位置：`test/Draw.t.sol:30`、`test/Refund.t.sol:225`，现有两个 NoDeadlock 测试。

目前 happy path 验证 provider 收到钱，但 provider 是普通地址。需要补充：provider 拒收原生币 / token 转账失败时，cash、vault 实际余额、loan、nonce、paymentId、epoch 与 outstanding 账本全部回滚；再用同一授权重试可正常成功。重入测试需要主动回调的接收方，正常路径“不死锁”无法替代。

分次退款最后一笔目前只核验 `ClosedByRefund` 和累计退款额，没有核验本金、fee、outstanding 清零及双方实收。增加任意分拆的 fuzz：多次退款与一次退款最终一致，累计份额不超原支付两腿，最终无残余 wei；recovery 每层累计回补不超实际承担额。建议用累计应得额减已分配额处理舍入，避免逐笔向下取整积累误差。

## 4. TEST_PLAN §3 的 24 条疑点逐项判断

| 项 | 判断 | 建议裁决 |
|---|---|---|
| G1 | 同意 | 补 Cancelled；注意首位加 None 实际改变已有枚举数值，不能再声称所有原值不变。当前尚未部署可统一调整。 |
| G2 | 同意 | deadline 与可变 escrowBalance 都必要，reward 保留原额。 |
| G3 | 同意补入口 | Manager → Account 登记退款可行。资金到账、登记、债务调整必须同交易原子完成；登记失败不能留下已收款。 |
| G4 | 同意需要重审出口 | 明确 guardian 的操作权限；解冻不得清除真实违约历史，身份快照刷新应与重审关联。不要把手工解除冻结当成所有风险条件已满足。 |
| G5 | 同意统一来源，但不充分 | 补 R5 的费率快照/变更规则。 |
| G6 | 不同意因果解释 | `Escrow → Adapter → Registry` 中 registry 看到的 client 仍是 Adapter，无论 catch 在哪。外层 `try adapter.reportFeedback(...)` 也可以正确归属。内部 catch + bool 是可行实现选择，不是修复 client 错位的必要条件。 |
| F1 | 同意按显式不变量统一 | authDeadline 使用 `<=`；task 的 accept/draw 仍按 `< deadline`。写清两种边界。 |
| F2 | 保留现有 cap 规则 | I6 验证授权上限，fee 按实际提款计，两者不矛盾。underwriter 预裁剪已解决正常路径，不必重新打开架构选择。 |
| F3 | 接受所选口径 | epoch 按新增本金、outstanding 按本金加 fee；明确退款不应恢复“本 epoch 已新增”预算，除非另有周转额度设计。 |
| F4 | 同意 | poster slash 补剩余债务，包含 fee，并以可用 escrow 为限；RISK 文案同步。 |
| F5 | 同意缺少目标，死代码说法需限定 | 若指本任务 default 后再 settle，确实不通；若 backstop 按 agent 共享，跨任务补足是另一种可定义规则。P0 可明确没有自动补足，而不是让实现者猜目标水位。 |
| F6 | 同意，补前提 | LTV ≤100%、费用条款稳定、escrow 完整且资产正常时，贷款有足额或超额 escrow 保障，backstop/LP 信用损失层不可达。借款 agent 没交抵押不代表池子无保障；poster 承担 escrow 罚没敞口。不要通过放宽生产 LTV 强行制造 demo 损失。 |
| F7 | 部分同意 | 正常成功结算不会部分偿付；不代表 `repay` 单元级分支不能测试，也不能仅因 happy path 不可达就直接删掉已约定接口。用隔离 harness 验证，避免正常任务已 Settled 却还留下 Active 债务的混合场景。 |
| F8 | 同意必须明确实收 | 选原路退回可行，也可让 Escrow 只传应付额；二者应选定一个，并用合约实际资产余额验证，不能只查 vaultBalance 账本。 |
| F9 | 同意按终态分支 | Active 按比例；Repaid 全额回 cash；Defaulted 按回补顺序；None 的纯 cash 退款也需明确。 |
| F10 | 接受全 payment 退款关闭，但反例错误 | 0.04 cash + 0.08 credit 按比例退 0.08，只冲减约 0.053333 credit，仍有约 0.026667 本金，不能关闭。所谓“退 0.08 就能关闭”需要信用优先退款，会违反当前按比例规则。补累计舍入测试。 |
| F11 | 同意累计封顶，当前回归受 R2 阻塞 | 每层限额必须减去此前累计回补。建议保留原始 LiquidationRecord，另记已回补额，方便审计；不必破坏原始承担额记录才能实现“消耗”。 |
| F12 | 接受现有 OR 条件 | GRACE 是贷款到期分支的缓冲，不是任务到期后的统一宽限。改为 `max(...)` 会推迟原有贷款到期出口，不是等价澄清，当前不建议改。 |
| F13 | 风险判断成立 | 当前规格允许 deadline 后、终结前 settle，和 expire 的顺序确实影响结果。至少增加两种交易顺序的测试并明确由链上执行顺序裁决；要给 verifier 单独窗口属于产品规则变更。 |
| F14 | 接受可诊断分层 | 本地策略错误归 SpendRejected，Manager 不变量错误原样冒泡。拒绝测试应隔离单一违规条件，先修 R4；如要规定多条件同时违规的优先级，需单列测试。 |
| F15 | 保留未消费集合语义 | 客户端生成递增 nonce，不等于链上强制单调；增加先消费较大 nonce 再消费较小未用 nonce 的正例可固定该语义。 |
| F16 | 同意信任边界描述，但验收不足 | Manager 信任唯一 Account；完整约束由组合调用保证。补 R6 中转账失败和重入后的资金/账本原子性验证。 |
| F17 | 同意 | demo 明确 protocolFeeBps = 0；第三单按 B 计费、结算后升 A。参考数学通过之后仍需真实 underwriter/SDK 集成验证。 |
| F18 | 不需要额外冗余字段 | 若 taskId → loan 的记录永久保留且 agentId 不变，读取 loan.agentId 足够。加重复字段没有必要，避免引入两份归属数据。 |

这些项目混合了真实规格缺口、已定义行为的解释和实现选择，不能统一称为“24 个 bug”或全部无条件采纳。

## 5. 实现推进顺序

原顺序总体依赖方向正确，但开头应调整。当前测试大量经 `_registerAndEnroll`、`_seedVault` 等公共步骤建场景，单独实现 Adapter 并不会让报告所列的所有 I3 / Feedback 测试立即转绿。

1. 先修 R1–R4，确定 R5 费率条款，补 R6 测试；同步 ABI 与 mock。
2. 打通部署接线、Adapter 身份生命周期、enroll、vault/cash/backstop 入金、策略和 whitelist；先给这些基础功能可独立执行的测试。
3. 实现任务 create / accept / cancel / expire 的无债务分支，以及纯 cash 支付。原生币和 ERC-20 同步验收。
4. 实现 draw + payProvider，验证 I1–I7、支付失败回滚、真实 identity 变更与旧授权失效。
5. 实现 repay + settle + 反馈失败与重试；固定物理余额和账本共同守恒。
6. 实现正常 LTV 的两条清算入口，再运行隔离的多层损失 harness。
7. 实现退款各状态分支，跑累计退款、recovery、舍入 fuzz 和完整端到端流程。

每一步先确认失败已到达目标断言，再以测试变绿作为该行为的证据。无需再做一轮泛泛的架构扩写。
