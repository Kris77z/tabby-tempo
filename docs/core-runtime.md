# 托管 Agent 核心运行闭环

2026-10-12。本页描述新增实现；[本地真实双模型联调](local-real-acceptance-20261012.md)和[本地连接 Monad 测试网的核心业务验收](monad-hosted-acceptance-20261012.md)已完成。Monad 共五单成功结算，其中新自主窗口连续完成两单；自主 Agent 累计三次还款、信誉710/A、债务0。原 Task 14 Unknown 经封存、全额运营补偿和独立终止收口，保留全部失败记录。

主线：创建托管 Agent、链上开户与充值 → 接取托管报酬任务 → 使用可用奖励额度，或以现金/任务信用购买推理额度包 → Pi 调用两个受信模型、运行公开测试并修复 → 独立 Arena 隐藏测试 → 链上还款/失败清算、收入与信誉入账 → 模型决定下一单或停止。游戏仍是用户发起的免费补资支路，不自动借钱参赛，不赞助 gas。

## 三种任务入口

- `task`：保留原固定价求解服务。
- `reward-task`：明确只用 Kimi 奖励 tokens，不足暂停；免费比赛补额后恢复原 UUID，不自动付 USDC。
- `metered-task`：使用任务绑定的双模型额度账本。配置 Kimi 奖励适配时，匹配 Kimi 的轮次优先消费奖励；不足或下一轮换模型时，在原接单、原 Pi 对话和轮次内购买额度包。现金优先，只有 `allowCredit=true` 才可申请任务信用。没有第二次接单，也不重启已完成的模型/工具轮次。

`autonomous` 是上述 `metered-task` 的连续运行入口。付费 LLM 根据资金、负债、信用、预算和已完成任务决定 `run-task(modelId,funding)` 或 `stop`；宿主校验模型与融资白名单，再由 Pi 执行并独立验收。最多任务数、决策次数、持续时间、单任务预算和累计预算均有硬限制。用户暂停 Agent 后不再派发下一单，已派发任务继续核对结果。失败停止；未知结果暂停、保留原请求；恢复只读/续原子请求，不创建替代任务。规划费只用 cash，因此首次规划需少量现金。自动参加游戏、自动发布任务和专家转包不在本轮范围。

## 额度、费用和还款

额度包购买前明确缺资金时，可从资金页充值，然后恢复原任务；单次与自主运行的当前子任务均支持。充值子请求保留父任务预算与钱包状态，重复恢复不重复接单或覆盖已完成结果。本演示每任务只购买一个包；包内额度耗尽是另一种暂停，不能用充值重置额度或再次借款。

合约仍每任务最多一次借款。`infercredit/allowance` 通过现有 SDK `forTask`、402 报价、原签名付款和授信购买一个预付额度包；资金直接支付白名单 Provider。包额度与模型目录摘要绑定在请求摘要中，服务重配置不能改变已付款权益。额度不能转账或兑现，也不是借走别人的 API key/订阅。

包价 `priceRaw` 是 USDC 最小单位（6位小数），`creditsRaw` 是包内微额度。每模型分别固定 `inputMicroCreditsPerToken`、`outputMicroCreditsPerToken`。调用前按保守输入上界及输出上限预留，收到可信模型 usage 后按实际输入/输出计费，释放未用预留。例：输入10、输出20，便宜模型费率1/2扣50微额度，较贵模型3/6扣150微额度。

**包价不是供应商逐 token 账单。** 借款按已付包价的现金缺口产生，结算按链上本金与 fee 还款。包内未用额度留在原任务，不能跨任务使用或自动退款；已交付额度包不适用未交付退款。已付但尚未发券的包可按现有 Refunder 退款，恢复会核对退款与贷款关闭再结束请求。

公开样例失败但已有候选代码时，额度任务把最后候选交给独立 Arena 判定，不能自己宣称失败或通过。隐藏测试失败按合约清算并更新信誉。没有可验收结果、供应商调用未知等情况先保留任务和债务，不能直接释放钱包去接新单；原请求可核对外部确认的任务到期清算。未知调用禁止自动重发，也不会假装退款/还款已完成。

已交付额度包的未知调用另有明确的运营补偿路径：运营方承担未知供应商成本，绑定原付款与账本摘要，永久封存额度，再用原付款全额退款；独立终止器核验 canonical 退款、`ClosedByRefund` 和原任务身份后终止任务，将托管报酬退给发布方。原未知调用、已交付收据和补偿决议全部保留，不将供应商成本记为零，也不计成功任务、还款或违约。仅在这些链上事实确认后，原自主请求才终止并释放活动锁。运行入口为 `scripts/monad-allowance-resolution.ts RUNTIME PAYMENT_ID inspect|apply|recover`，重启沿用同一决议、退款和签名交易。

该全额补偿规则仅适用于原付款的一笔 grant、已有调用全部 Unknown、没有已完成或仍在途结果的账本。多个 grant 或混合已完成推理仍保持冻结，不能用本轮规则自动补偿。

Docker 启动等待与候选代码执行分别计时。启动失败属于验收基础设施错误，不产生代码失败判定、失败结算或罚没；代码真正开始后仍受原执行时限约束。

## 配置与启动

保留原 hosted task/game 配置。task 配置新增可选 `metered`：

```json
{
  "relayUrl": "http://127.0.0.1:8789/v1/chat",
  "payTo": "<existing-whitelisted-provider-address>",
  "priceRaw": "120000",
  "creditsRaw": "100000",
  "keyFile": "/absolute/private/magpie-local.key",
  "catalog": [
    {"id":"cheap","model":"cheap/kimi-k2.6","responseModel":"kimi-k2.6","route":"http://127.0.0.1:3425/v1/chat/completions","inputMicroCreditsPerToken":"1","outputMicroCreditsPerToken":"2","maxCompletionTokens":512},
    {"id":"strong","model":"strong/second-model","responseModel":"second-model","route":"http://127.0.0.1:3425/v1/chat/completions","inputMicroCreditsPerToken":"3","outputMicroCreditsPerToken":"6","maxCompletionTokens":512}
  ]
}
```

这是配置结构示例；替换第二模型、白名单地址与私有路径后使用。数组顺序为 cheap、strong，模型目录恰好两个、同一 Magpie endpoint；费用是 Demo 运营配置，不声称市场报价。对两个服务使用完全相同的目录。`modelCatalogDigest(catalog)` 导出于 `services/hosted-agents/src/metered-task.ts`，是 canonical JSON 的 SHA256 加 `0x`。

按既有 Relay 环境配置启动 `npx tsx scripts/allowance-relay.ts`，另设 `ALLOWANCE_CREDITS_RAW`、`MODEL_CATALOG_DIGEST`、`PRICE` 和 `PORT`，与 task 配置一致。Magpie 仍用项目锁定版本、禁止隐式重试的 launcher，见 [网关运行说明](magpie-gateway.md)。物理供应商 key 留在网关/薄桥，不能传给前端或保存进额度账本。

hosted daemon 顶层新增可选 `autonomy`：

```json
{
  "maxTasks": 2,
  "maxDecisions": 3,
  "durationMs": 180000,
  "plannerRelayUrl": "http://127.0.0.1:8790/v1/chat",
  "plannerProvider": "<existing-whitelisted-provider-address>",
  "plannerPriceRaw": "10000",
  "plannerService": "infercredit/plan",
  "plannerModel": "logical-planner",
  "plannerPhysicalModel": "kimi-k2.6"
}
```

planner 是普通现金 Relay，可路由同一 Magpie 中已有模型，不引入第三个模型。`plannerPhysicalModel` 核验 Relay 路由回执；经 Magpie 时可为 `cheap/kimi-k2.6`，另设 `plannerResponseModel: "kimi-k2.6"` 核验实际响应。省略后者时两者同名。决策输入包含规划扣费后余额、额度包成本、现金/信用可行性和各模型费率，不能把信用、现金与微额度混为一谈。设置 `HOSTED_AGENTS_CONFIG=/absolute/private/hosted.json` 后，预检 `npm run hosted-agents -- --check`，通过后 `--start`；断点使用原私有目录加 `--start --recover`。未配置能力时 API 拒绝新增操作，网页不显示对应按钮；已有任务与游戏保持可用。

前端工作台显示额度包价、两个模型输入/输出费率、连续运行边界，以及实际付款、借款、还款与完成单数。所有资金结果来自后端核验的链上回执，页面测试中的 synthetic 成功不构成交易证据。

## 可复现验证

Node 22、Foundry、Docker 就绪后：

```bash
npx tsx --test --test-concurrency=1 services/provider-relay/test/allowance.test.ts services/hosted-agents/test/inference-gateway.test.ts services/hosted-agents/test/metered-task.test.ts services/hosted-agents/test/metered-recovery.test.ts services/hosted-agents/test/metered-deposit.test.ts services/hosted-agents/test/autonomy-live.test.ts packages/pi-loop/test/autonomy.test.ts services/hosted-agents/test/autonomy-executor.test.ts
npm run typecheck:all
```

这些自动化测试使用真实本地 Anvil 合约、SDK、Pi、独立 Docker Arena/settler；模型响应受控。网关单元测试另覆盖并发预留、费率差异、来源幂等、usage 越界、未知冻结、重启恢复。另有[真实双模型本地记录](local-real-acceptance-20261012.md)和[本地启动器](local-hosted-testing.md)；Monad 核心业务及链上独立核验已完成；真实扩展钱包与公网联合部署仍需另验收。
