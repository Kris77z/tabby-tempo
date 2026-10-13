# InferCredit：3 分钟本地链演示稿

本页脚本保留为可复现的本地排练：`chainId 31337 / Local Anvil / MOCK registries / FAKE inference`。四合约、USDC-6 转账、SDK / Relay / Underwriter、Python Docker 验收和独立 settler 都实际执行；推理文本由受控本地上游返回。Monad canonical registries、付费模型和 Task11 信用闭环已有真实验收；本页数字只对应该本地排练，最新真实路径及新HTTP闭环见 [工程状态](implementation-status.md) 与 [后端交付](backend-acceptance.md)。

## 录制步骤

从仓库根目录，在交互终端运行。需要 Node 22、Foundry、运行中的 Docker 及 Arena 指定的已缓存 Python image。输出目录必须是新目录。

```sh
DEMO_RUN_DIR="$PWD/demo-output/rehearsal-$(date +%Y%m%d-%H%M%S)"
npm run demo -- --mode local --serve --pause-before-third --output "$DEMO_RUN_DIR"
```

看到 `LIVE starting point: hero 640 / Tier B / two real repayments` 和 `Press Enter` 后保持暂停。前两次还款、另外两个 Agent 和反向交易已经在这条本地链上执行；第三单尚未创建或接受。复制输出的 `Manifest:` 绝对路径，在另一终端启动同一部署的前端：

```sh
npm run build --workspace @agentfuel/frontend
FRONTEND_MODE=chain FRONTEND_MANIFEST_PATH="<本次 Manifest 绝对路径>" \
  npm start --workspace @agentfuel/frontend -- --port 3000
```

只运行一个 3000 前端进程；若之前打开的是 fixture 预览，先停止该预览。打开 `http://127.0.0.1:3000`，选择主角 Agent，确认 640 / Tier B、两次还款与 `0.0787 USDC` 现金。录制桌面画面，保留网络标记 `Local Anvil · MOCK registries · FAKE inference`；不要裁掉此说明。用 macOS `Shift-Command-5` 选取浏览器和所需终端区域并开始录制，无需新增录屏框架。

到讲稿第三单位置，在 demo 终端按 Enter。脚本现场创建任务、接受任务、付款和提交实际返回代码；浏览器用于显示同一清单的链上结果，不要再在面板重复创建或支付这一单。终端的 `LIVE tx1=... tx2=...` 是任务开始节点，随后付款行给出 tx3 / paymentId / fromCash / principal / fee；`hero order 3: PASS...` 和 `DEMO_RESULT` 是完成节点。完成后点前端“刷新”，展开对应 Provider payment / 任务验收回执。每 20 秒读取可能略过中间的 Active loan，付款本金与 fee 以本次证据文件为准。

录制结束，先停止录屏，再停止前端和 demo；demo 的 Ctrl-C 会清理它启动的进程。保留本次 `manifest.json`、`evidence/` 与视频。`private/` 是本地运行状态和合成角色资料，不作为演示附件。

## 讲稿与镜头

| 时间 | 镜头 | 旁白 |
| --- | --- | --- |
| 0:00–0:20 | 主角信用档案，保留本地网络说明 | 这是 InferCredit 的 Agent Financial Identity。身份、还款、违约、现金和债务出现在同一份档案里。今天展示的是本地 Anvil 链，Registry 和推理输出使用本地模拟；资金合约、支付和 Docker 验收实际运行。 |
| 0:20–0:45 | 640 / Tier B、两次还款、现金与额度 | Agent 完成任务之前，需要先支付算力。这个 Agent 已有两次真实本地还款，评分是 640，属于 Tier B，现金只有 0.0787 USDC。InferCredit 把任务应收款和还款记录变成可使用的授信。 |
| 0:45–1:10 | 演示面板的 Agent → InferCredit → Provider 路径 | 第三单奖励 0.15 USDC，推理费用 0.12 USDC。资金经过 AgentAccount，先用现金，再补上任务借款。授权绑定 Agent、任务、资产和白名单 Provider，任务额度也受净 escrow 与 LTV 限制。 |
| 1:10–1:40 | demo 终端按 Enter，显示本次 tx1 / tx2，随后付款与验收 | 现在现场创建并接受第三单。SDK 通过 Relay 获取付款请求，Underwriter 校验链上状态，付款使用 0.0787 USDC 现金和 0.0413 USDC 借款。本次借款 fee 为 0.003304 USDC。受控上游返回 Python 代码，再交给 Arena 执行。 |
| 1:40–2:15 | 完成节点；刷新档案，展开 TaskSettled / LoanRepaid / FeedbackSent | Arena 在隔离 Docker 中运行 hidden tests，独立 settler 提交实际结算。PASS 后，0.15 USDC 奖励先归还本金和 fee，余款进入 Agent cash。现在现金为 0.105396 USDC，未偿债务为零，还款次数从二变成三，评分升至 710，Tier A。回执记录付款、还款和声誉反馈。 |
| 2:15–2:40 | 打开本次 evidence/demo.json 的 reverse.spendRejected，再切换身份变更与违约 Agent | 资金路径也受限制。准备阶段实际发送的非白名单付款交易，被 SpendRejected 拦截，receipt status 为零且没有日志；拒绝原因由 eth_call 解码。身份绑定变化会停止授信。第三份档案来自真实本地失败清算，可以看到 default 与冻结。 |
| 2:40–3:00 | 回到主角档案与资金路径 | ERC-8004 提供身份与声誉，Relay 通过 HTTP 402 报价请求付款，InferCredit 把这些信号连接到任务资金和可偿还借款。我们接下来用 Monad canonical registries 与真实付费模型复现这一流程，届时展示目标链回执。Reputation you can spend. |

## 本次镜头的证据

`evidence/demo.json` 的 `beforeLive` / `afterLive`、第三次 hero `rounds` 与 `reverse` 是讲稿数字和拒绝结果的来源。`inference-{taskId}.json` 保存付款 receipt 与原始受控输出；`settlement-{taskId}.json` 保存 Docker verdict、真实 TaskSettled / LoanRepaid / feedback 事件；`chain-receipts.json` 保存本次链上回执。金额原值使用 USDC 6 decimals，例如 `41300 → 0.0413`。执行服务的详细要求与清理方式见 [demo-runbook.md](demo-runbook.md)。

面板历史付款只显示该回执的 cash / credit，当前 Tier 放在档案中，避免把升级后的 Tier A 当作旧借款条件。Local Anvil 没有公开 explorer；展开 txHash 与事件即可，与证据文件对应。最终 Monad 版需要替换为实际 manifest、真实上游响应和可访问的目标链交易链接，重新录制并按当次结果更新数字。
