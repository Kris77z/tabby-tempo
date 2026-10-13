# 第二轮测试交付复核（2026-09-14）

结论：未发现新增架构级 P1，可以开始分步实现。第一轮 R1 的关键函数 ABI、R2 超杠杆 recovery 夹具、R3 getter 消耗 cheatcode、R4 nonce 重放入口均已修正；费率快照、生产 LTV recovery、分次退款 fuzz 等新增方向正确。下面仍有局部 P2，应在对应模块实现前修正，不能把当前套件直接当成已经证明正确的验收标准。

本轮仅新增此 review 文件，未修改业务实现、测试或原工程规格。

## 验证结果及其含义

本地重新运行 `forge build` 成功；`forge test --summary` 与报告的 **244 tests / 15 passed / 227 failed / 2 skipped** 一致。

`grep -v NotImplemented` 为空只能说明当前可见失败被骨架挡住，不能推出“测试自身没有错误”。测试在 `_standardSetup` 的入金或 enroll 阶段提前退出时，后面写错的期望值根本没有运行。TEST_PLAN 开头及 §4 的相关断言应改成这个准确含义；39/39 应称“清单映射覆盖”，不等于行为验证已经通过。

独立最小 Foundry 工程复用了本项目的 `SafeTransferLib`、`ReentrancyGuard`、`ReentrantProvider`、`MockERC20`，用一个只有转账入口的 harness 排除 NotImplemented 干扰。两项通过：

```text
test_erc20NeverCallsProviderAttack                         PASS
test_nativeGuardErrorIsWrappedByExistingLibrary            PASS
```

前者验证 ERC-20 转账成功、receiver 没有执行回调；后者验证原生币重入在内部被 guard 拦截后，调用方收到的是 `NativeTransferFailed(provider, amount)`。临时工程已删除；这不是对完整业务实现的运行验证。

## 需要修正的测试

### A · P2：ERC-20 镜像中两条 provider 重入用例期待了不会发生的 revert

位置：`test/Atomicity.t.sol:188`、`:226`，及文件末尾的 `Erc20AtomicityTest`。

这两条测试被 ERC-20 套件原样继承。当前 `MockERC20.transfer` 不会调用接收方的 `receive`，所以 `evilReentrant.arm(...)` 之后并没有任何攻击发生，正确支付应当成功。`MaliciousActors.sol` 虽然提供 `attackNow()`，测试没有调用；在支付返回后单独调用它也不是重入。

修正：普通 ERC-20 模式跳过这两条 native receiver callback 用例，并新增“普通 ERC-20 收款不触发 receiver callback”的正例。若需测试 token 合约主动重入，应另用在 `transfer` 内回调 Account 的恶意 token，不能把它混同于普通 ERC-20 接收方回调。

### B · P2：native 用例期待内层 ReentrantCall，但转账库已包装错误

位置：`test/Atomicity.t.sol:234`；`src/utils/SafeTransferLib.sol:28`。

调用链是 Account → provider.receive → Account。内层 `ReentrantCall` 导致 provider 的收款调用失败；`safeTransferNative` 丢弃其 revert data，改抛 `NativeTransferFailed(to, amount)`。因此即使 guard 正确工作，当前精确期待 `ReentrantCall.selector` 的测试仍失败。

修正：外层失败与账本回滚测试期待现有库的包装错误。要单独证明 guard，让攻击者在回调中以低级调用捕获内层错误，保存 selector 并正常返回，再由测试断言 `ReentrantCall`、攻击确实发生、只支付一次、没有内部重复消费。

同时，当前攻击者不是该 agent 的 wallet。只写宽泛的 `expectRevert()` 时，即使删掉 guard，正常的 wallet 鉴权也可能拒绝回调，使测试错误地通过。应保证重入调用除 guard 外满足其余前置条件，或使用隔离的 guard harness，避免将鉴权失败当成重入保护证据。

### C · P2：另一个 I5 用例仍同时违反 I6，暗中规定了错误优先级

位置：`test/Draw.t.sol:367–376`，`test_RevertWhen_FreshNonceReusedOnSameTask_I5`。

nonce 重放的原 R4 已修好，但相邻这个用例仍使用 reward = 0.15、cap = 1、fee = 15%、LTV = 80%。cap 对应债务 1.15，远超允许的 0.12。它同时违反“任务已有 loan”和 I6，却精确要求 `LoanAlreadyExists`，与 TEST_PLAN“暂不规定多条件优先级”的口径不一致。

修正：用有效 cap/amount（例如各 0.08），保留新 nonce 和已有任务 loan，使唯一失败条件是 I5。可以继续使用 `_drawDirect` 隔离 Account 策略层。无需为了这个测试新增全局错误优先级规则。

### D · P2：ABI 已修，但新增 conformance 正例仍依赖非标准 mock 行为

位置：`test/AbiConformance.t.sol` 的 `test_ReputationRegistry_GetSummaryReturnsThreeValues`、`test_ReputationRegistry_ValueIsSignedAndSurvivesRoundTrip`；`test/mocks/MockReputationRegistry.sol` 的 `giveFeedback` / `readFeedback`。

两条正例把 agent owner 设为测试合约本身，再由它给自己反馈；signed-value 用例读取 feedbackIndex = 0。官方规范禁止 owner / approved operator 给该 agent 反馈，而且反馈编号从 1 开始。当前 mock 未检查前者，并采用从 0 开始的编号，因此这些通过结果还不能称为 canonical 行为验证。

修正：使用独立 reporter；第一条 feedback 使用 index = 1；mock 的外部反馈索引从 1 开始、内部数组再转换为从 0 开始，并补“owner 自评拒绝”的反例。规范还要求 agent 存在、valueDecimals ≤18，应在 mock 明确模拟或明确列为未覆盖约束。

此外，Identity mock 的 `walletBindingDigest` 是自定义哈希，并非标准 EIP-712 编码；可作为协议单元测试替身，但应标注简化，不能据此声称 canonical 钱包签名兼容。SDK 绑定钱包的签名兼容性留到真实 ABI/部署验证时检查。

来源：[ERC-8004 官方规范](https://eips.ethereum.org/EIPS/eip-8004) 的 On-chain metadata / Giving Feedback 部分。本轮重新核对了网页；未进行链上 fork。

## 五个“待拍板项”的处理建议

不需要把五项都交给用户审批。当前已有可执行口径，可以按以下默认继续：

| 项 | 建议 |
|---|---|
| 费率变更 | 保留已写入骨架与测试的“任务创建时快照”，旧任务使用同一快照进行 I6 和结算。 |
| backstop 补足 | P0 无自动补足；显式 fundBackstop 和 Defaulted recovery 保留。同步修正文档旧 waterfall 文案即可。 |
| verifier 窗口 | 保留当前既定链上顺序裁决，不在本轮新增窗口；两种交易顺序已有测试。 |
| 多条件错误优先级 | 暂不规定；修 C，确保专项拒绝测试只有一个失败条件。 |
| canonical fork | 属于缺少真实部署验证的技术待办，不是产品取舍。可与本地实现并行准备，完成真实联调前必须验证；缺 RPC 时明确记录缺口。 |

下一步按 TEST_PLAN §5 分模块推进即可。A–D 是局部修正，不需要再开架构讨论；实现过程中检查每个测试是否真正到达目标行为，再判断该项是否通过。
