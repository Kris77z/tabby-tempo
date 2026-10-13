# 预设任务的统一工作流

`@agentfuel/pi-loop/workflow` 将受信候选选择、必要时接单、一次固定价 B 求解、公开工具自测、独立 Arena 判题和原贷款终态查询接成一个持久入口。只处理现有四题型：`sum-integers`、`unique-sorted`、`balanced-brackets`、`word-frequency`。任务 ID、题型、原 deadline、授信上限和 provider 能力标签均由可信宿主配置；不解析任意任务文本，不接受模型改价或改地址，不发现新任务，不引入新的资金协议。

选择复用纯 `selectInference`；不会调用 `runSelectedInference` 后再购买 B。选中的 route 报价是整个 B 服务的固定价，`tier` 表示受信求解计划的首轮档位，计划中的每轮档位显式列出。strong route 只能含 strong 轮次。提前成功仍按固定价，provider 的公开样例交付与 Arena 的 hidden tests 成功是两个状态。各轮物理请求模型、上游返回模型和 usage 保存在原 B run；包报价不是 vendor 账单。

```ts
import { runTaskWorkflow, readWorkflowStatus, validateWorkflowConfig,
  type WorkflowConfig } from "@agentfuel/pi-loop/workflow";

const config: WorkflowConfig = validateWorkflowConfig({
  agentId: "1", chainId: "31337", account, asset, escrowAddress,
  tasks: [{ taskId, problemId: "unique-sorted",
    deadlineMs: taskDeadlineSeconds * 1000, creditLimit: "80000" }],
  allowCredit: true, maxPrice: "120000", deadlineMs: hostDeadlineMs,
  minRemainingMs: 5000, maxCompletionTokens: 2048,
  providers: [{ id: "trusted-fixed", payTo, relayUrl,
    service: "infercredit/solve-fixed", model: "pi-fixed-v1", routes: [
      { tier: "cheap", price: "120000",
        capabilities: ["python3-json-stdio", "unique-sorted"],
        solve: { version: 1, tiers: ["cheap", "strong"],
          maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 2048 } },
    ] }],
});
const status = await runTaskWorkflow(workflowDirectory, config, {
  signer, provider, rpcUrl: publicRpcLabel, arenaUrl, underwriterUrl,
  walletLockDirectory, timeoutMs: 10000, pollTimeoutMs: 30000,
});
// 原 directory、config、deadline 和 runtime 绑定恢复；不生成替代 requestId。
const recovered = await runTaskWorkflow(workflowDirectory, config, {
  signer, provider, rpcUrl: publicRpcLabel, arenaUrl, underwriterUrl,
  walletLockDirectory, recoverLock: true,
});
const view = await readWorkflowStatus(workflowDirectory); // 不取得 writer 锁
```

宿主注入 `ethers.Wallet` 和同一个 `JsonRpcProvider`。RPC 实际认证 URL 只留在 provider 内存；`rpcUrl` 是供子会话保存的无凭证公共标签。所有运行 URL 拒绝 userinfo、query 和 fragment。provider、Arena、underwriter 是已配置服务，模型不能传入这些依赖。`runner` 可选，默认仍为隔离 DockerExecutor；不提供任意 shell、钱包或 refunder key 给模型。运营 HTTP/CLI 的私有 profile、启动与恢复命令见[运行手册](TASK_RUNNER.md)。

入口先读取当前现金和候选任务。只有 Open，或 Assigned 且属于本 agent、原 deadline 一致、没有已有贷款的任务参与选择。按能力、固定价、现金加该任务明确授信上限、时间筛选；排序沿用报价、最近 deadline、数值 taskId、providerId、tier。所有金额使用 BigInt。没有可行项保存 `Stopped/NO_FEASIBLE_CANDIDATE`，没有接单交易或报价请求。

决策、受信配置 hash 和链上快照先保存。Open 接单时，保存原 accept 的 signed raw/hash/nonce 后才广播；确认原交易所在 canonical block，并核对指定 escrow 的 `TaskAccepted(taskId, agentId, wallet)` 后才能付款。响应未知只暂停，恢复先查询原 hash，必要时仅重播原 bytes，不新签或换 nonce；deadline 后不能重播未确认 accept。已 Assigned 的选中任务跳过接单。选择后的配置、价格、档位计划或 runtime 发生变化时停止推进，不能静默重选。

固定价子会话直接复用 `runFixedPriceTask` 和 SDK `forTask`。现金足够时原协议走 cash，只有选择明确允许信用时才使用该任务的原授信流程。SDK `onHandle` 先持久保存子会话，再 await 工作流核对精确原价、任务、请求 digest、原 paymentId 与 credit nonce，保存父会话和报价预留；失败不得付款。签名、广播及原 raw 重播之前重新检查当前资金、任务归属和 deadline。现金变少不能将原 cash 决策升级成信用，不购买第二份服务。`creditLimit` 是宿主准入上限，未改原合约 policy 或 underwriter 授权额度；报价预算不含 gas，也不等于模型成本。

公开样例和工具由 provider 内 Pi/Docker 执行；agent 复核终稿后复用现有最终提交 helper，独立 Arena/settler 运行 hidden tests 和结算。工作流只有核对 canonical `TaskSettled`、任务终态及零未偿债务后才发布 `Succeeded` 或 `Failed`。Arena明确4xx仍保留 `SubmissionPending` 和原签名 payload，不能因HTTP拒绝释放已付、未结算的贷款；截止前恢复配置后只重发原提交，不重买服务。旧版误写为 `Stopped` 的已交付记录也按可恢复状态读取，并继续阻止同钱包新会话。hidden tests 失败记 `Failed`，信用走原 Defaulted/清算；已交付固定价服务不能以“任务失败”走未交付退款。未交付或未知模型派发保留原 handle/预留，恢复不再派发模型；受保护的既有 operator refunder 可从 provider 原收款全额退款，client 只查询确认，并保存 task/loan 终态，不将退款当任务成功。

钱包锁由 core 唯一持有。所有同钱包 profile 和 HTTP/CLI 宿主应注入同一个 `walletLockDirectory`；runtime registry 使用另外的锁。钱包 journal 保留当前工作流目录与 binding；`Paused`、`SubmissionPending`、`RefundPending` 等非终局阻止另一个目录或链/account 开始消费，只允许恢复原会话。终局 `Succeeded`、`Failed`、`Refunded`、`Stopped` 后，同 signer 可启动下一次已授权工作流。SessionStore 活 PID 拒绝并发；崩溃必须确认原进程停止后显式 `recoverLock`，不自动抢锁。该锁不覆盖旧入口或外部钱包操作，其他消费者仍需遵守同钱包顺序执行规则。

`readWorkflowStatus` 返回封闭、安全投影：选中 task/provider/tier、固定价、预留、accept hash、paymentId、子会话阶段、工具次数和已确认财务终态。不会返回密钥、原签名交易、代码、URL、完整配置或模型上下文。私有目录 0700、文件 0600，保存决策、原 accept raw/receipt、child config、PaymentHandle 和完整子会话。到期后保留未知付款与派发；可领取已付缓存或查询已有 Arena runId，不新签付款、运行新轮或发起新提交。

如果该已付任务已在链上结束，原会话显式恢复还会只读核对同一个固定 canonical block 的 task、loan、原 Payment 和 ProviderPaid：只有原任务已 Failed、合法贷款终态且本金/费用为零才记录 `Failed/WORKFLOW_CHAIN_TERMINATED`，保存区块及原付款 hash 后释放本钱包。该状态包含外部 expiry、liquidation 或失败结算，不能仅凭读取区块的时间推断实际结束原因。不会伪称 Arena 判题或模型任务成功，不自动清算或解冻，也不更改原服务退款策略；违约冻结及历史仍由原协议保留。未确认或区块不一致时继续 `Paused`。

受控测试使用新 Anvil/mock-USDC、隔离 Docker、独立 settler，覆盖四题 Open 接单到真实本地结算、预置错误后的工具修复、一次 cash40000+draw80000 的固定价120000购买、原贷款还款92000、hidden tests 失败与未交付全退的区分、canonical accept 检查、未知恢复零新增模型/付款、单钱包跨目录保护、变价零付款和到期禁止重播。已付 Arena403、旧版 Stopped journal 恢复及外部 expiry 的 canonical 只读关闭均有回归；后者下一任务由 fixture 显式 guardian 解冻和 agent 自有资金入金准备，core 不发送这些操作。预置错误是受控 fixture，不是模型自然错误。本入口尚未在该测试中调用真实模型或公网链；历史真实 B/Monad 报告不能替代统一入口验收。

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
node --import tsx --test --test-concurrency=1 packages/pi-loop/test/workflow.test.ts
node --import tsx --test --test-concurrency=1 packages/pi-loop/test/fixed-task.test.ts packages/pi-loop/test/loop.test.ts
npm run typecheck:all
```
