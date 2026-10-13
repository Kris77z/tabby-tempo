# 2026-10-07 后端交付与 UI 交接

> 本文记录较早的预设 Agent 后端收尾。随后用户明确了“平台创建托管 Agent”定位，新增范围及验收见 [托管交付](hosted-acceptance.md)。不能把本文历史范围当作用户托管功能此前已经完成。

本次收尾范围是现有 P0 四合约、四道 Python 任务的固定价信用流程，以及本机运营 GameFi/奖励消费后端。长期架构中的公共 LP、通用仓库任务、公开游戏赛事、第三方 provider 和标准 x402 兼容不在这一交付范围。

## 已连接的业务路径

`预设 profile → 规则选任务/档位 → Open 接单或继续自己的 Assigned → 一次固定价 B → 有界 Pi 工具 → 独立 Docker Arena → 结算/还款 → 持久状态`

选择步骤只决策，不购买旧 selector 的原始推理。报价、任务、provider、solve 上限和付款摘要一致才允许付款；一个任务仍只提款一次。模型不知道钱包密钥、隐藏测试答案或结算权限。独立 settler 持 verifier key，其余服务分别持各自配置。

| 交付项 | 接口和实现 |
| --- | --- |
| 统一任务与恢复 | [WORKFLOW](../packages/pi-loop/WORKFLOW.md)：原接单签名、PaymentHandle、提交和余额结果持久化；单钱包排他，未知状态必须恢复原请求。 |
| 页面可调用的后端 | [TASK_RUNNER](../packages/pi-loop/TASK_RUNNER.md)：`GET/POST /api/tasks/runs`，预设 profile、非阻塞 202、状态轮询、原 UUID 恢复；Next 只做固定 loopback 桥接。 |
| 固定价服务启动 | `npm run relay:fixed`：Docker readiness、服务 writer、退款与原请求恢复。普通 `npm run relay` 保留不同的原始推理契约。 |
| 固定五进程启动 | [backend-runtime](backend-runtime.md)：`npm run backend -- --manifest /absolute/private/backend.json --check` 离线检查，`--start` 启动固定入口、私有日志、ready 状态、退出清理。 |
| GameFi 与奖励 | [gamefi-runner](gamefi-runner.md)：沿用已验收的德州、赞助测试 USDC、Kimi 推理额度和原局恢复；不发游戏贷款，不用任务贷款参赛。 |
| Magpie 兼容 | [magpie-gateway](magpie-gateway.md)：实际进程按最新普通 Relay 未知响应语义验证，未知不重派、不自动退款；明确拒绝才进入可退款路径。 |

## 真实运行证据

root 通过 Next 同款服务端桥接和真实 HTTP 完成一次 Open 任务：真实 Kimi K2.6 **190 输入 + 39 输出 = 229 tokens**，一次调用、最多 2048 输出 tokens。SDK 付 `120000` 原始 mock-USDC（cash `40000` + credit `80000`），Arena 通过后偿还 `92000`，最终 cash `58000`，principal/fee 均为零。

接单、付款、结算三份回执逐一核对成功状态和 canonical block；生成代码另用新 Docker 执行三项复核；原 UUID 恢复及 GET 没有新增付款或模型请求。[运行报告](../demo-output/backend-live-20261007-root/report.json)与私有原始证据保存在本机，`demo-output/` 不上传 GitHub。

这是新本地 Anvil / mock-USDC 验收，未新增 Monad 交易、未经过 Magpie。已有 Monad Task11、GameFi 测试 USDC 真实消费和本轮 Magpie 实际进程回归分别证明各自范围，不混为同一次全栈运行。首轮成功不证明自然多轮修复，也不据 usage 估算供应商账单。

可复现的受控 HTTP 验收无需 API key：

```sh
node --import tsx scripts/verify-backend.ts --output /absolute/new-output --controlled
```

真实调用必须显式 `--execute --config /absolute/private/demo.json`，同样只用新本地链、最多一次 K2.6。默认只输出计划；已存在输出目录拒绝执行，避免重复消费。未知失败保留原证据，不能通过新目录自动重买。

## 本次补齐的异常恢复

已付款后的 Arena HTTP 拒绝保持 `SubmissionPending`，原候选、原签名与原付款可继续恢复；兼容旧 `Stopped` 记录，不能通过新 UUID 绕过，也不能让新请求反过来堵住原请求。已经在链上完成到期清算/失败终结的原任务，恢复时只读核对固定 canonical block、任务、贷款与原付款，确认零未偿后关闭请求并释放钱包占用；不自动清算、解冻或抹去违约。

独立 settler 的回执等待已改为有界查询原 hash，核对 canonical block，避免安静的本地链不再出块时误等超时；没有额外签名或广播。完整回归同时修复旧测试的工作目录依赖、过短墙钟竞态、无效 Relay fixture 和失败清理遮盖原错误的问题，生产资金断言未放宽。

## 回归入口

```sh
npm run typecheck:all
npm run test:all
forge test --root contracts --offline
npm run build --workspace @agentfuel/frontend
MAGPIE_BIN=/absolute/patched/magpie MAGPIE_OFFICIAL_BIN=/absolute/official/magpie npm run test:backend:integration
```

workspace 套件中的练习 HTTP 测试默认需要 `ARENA_PLAY_TEST_URL`；本轮另起隔离 Next 生产服务执行该测试，已验证真实 HTTP，并清理自己的进程和练习状态。其余默认套件使用本地链和受控模型，不能当作真实 vendor 消费。真实 Kimi 仅上文那一次。

## 最终验收结果

主 Agent 独立验收记录：[root-acceptance.json](../demo-output/backend-closeout-20261007-root/root-acceptance.json)（本机证据，不上传仓库）。

| 检查 | 结果 |
| --- | --- |
| 六个 workspace 套件 | 246 项：245 通过、0 失败、1 项需服务地址的 HTTP 测试默认跳过 |
| 上述 HTTP 测试，独立 Next 生产服务 | 1/1 通过，无跳过 |
| 后端脚本集成，包括实际 Magpie 进程 | 112/112 通过，无跳过 |
| Foundry 合约 | 408 项：404 通过、0 失败、4 项保留跳过 |
| 五服务真实启动、桥接与 Relay 独立复核 | 10/10 通过 |
| 全项目类型检查、Next 生产构建 | 均通过 |

这些检查有交叉，不将数量相加作为独立覆盖率。真实 Kimi 调用之后补齐的异常恢复与 settler 修复已通过最终受控回归；未重复购买模型调用。历史诊断失败保留在本机，最终结果以 `final-accepted-node.tap` 和 `final-accepted-integration.tap` 等验收记录为准。

## UI 侧剩余验收

1. 显示后端返回的预设任务与可用状态，发起时保存一个 UUID；按钮重复点击继续使用原 UUID。
2. 轮询展示接单、付款、工具、Arena 与最终资金状态，区分 `Failed`、`Refunded`、`Stopped` 和可恢复的 `Paused`；隐藏测试失败不等于服务未交付退款。
3. 恢复只发送原 `requestId`，处理禁用、繁忙、网络未知和预算不足文案，不在 UI 重新选择钱包、provider、价格或自动购买替代请求。
4. 验收桌面/手机布局、加载与错误状态、任务页和现有 GameFi 页面的一致性。模拟浏览器测试不能称为真实链上消费证据。

上述 UI 工作无需补一套贷款、模型循环、判题或恢复后端。运行仍依赖本机 Docker、已配置服务与可用外部 RPC/模型；外部网络长期可用性不属于一次功能验收能够保证的结论。
