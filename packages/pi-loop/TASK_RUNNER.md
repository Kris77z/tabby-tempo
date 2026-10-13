# 本机任务运行入口

`scripts/task-runner.ts` 将可信预设接到 [统一工作流](WORKFLOW.md)：选择候选、Open 接单或 Assigned 确认、一次固定价 B 服务、Pi 公开工具、独立 Arena 判题、原贷款结算。题型只来自现有四题目录。HTTP 不接收钱包、金额、prompt、代码、RPC、文件路径或任意命令；浏览器只能选择运营人员已经配置的 profile。

入口监听 `127.0.0.1`。它检查连接来源、Host 和可选 Origin，不启用 CORS、不信任代理请求头。浏览器通过同源 Next `/api/tasks/runs` 桥接，服务端使用固定 `TASK_RUNNER_URL=http://127.0.0.1:8790`；CLI 可以直接访问本机入口。钱包 writer 由工作流 core 持有，HTTP registry 使用另外的锁。

## 私有配置与启动

所有配置、workflow profile、RPC URL 文件和钱包 key 文件必须为当前用户所有的普通文件、权限 `0600`，使用 canonical 绝对路径，不经过 symlink。运行目录为 `0700`。RPC 认证 URL 只从私有文件读入 provider；不返回浏览器，也不写入 workflow journal。Monad 子会话保存无凭证公共 RPC 标签。

`TASK_RUNNER_CONFIG` 指向以下格式。示例中的钱包、路径和服务端口须替换为该环境已有配置；此文件不生成或充值账户。

```json
{
  "version": 1,
  "dataDirectory": "/absolute/private/task-runs",
  "port": 8790,
  "wallet": "0x3C44CdDdB6a900fa2b585dd299e03d12FA4293BC",
  "keyFile": "/absolute/private/agent-wallet.key",
  "profiles": [
    {
      "id": "fixed-python",
      "label": "固定价 Python 任务",
      "workflowConfigFile": "/absolute/private/fixed-python.json",
      "rpcUrlFile": "/absolute/private/rpc-url",
      "rpcTransport": "direct",
      "arenaUrl": "http://127.0.0.1:8788",
      "underwriterUrl": "http://127.0.0.1:8787",
      "timeoutMs": 180000,
      "pollTimeoutMs": 180000
    }
  ]
}
```

profile 使用 `validateWorkflowConfig` 的格式，见 [WORKFLOW.md](WORKFLOW.md)。其 task ID、四题之一的 problem ID、原任务 deadline、价格和授信上限、provider/payTo、固定 B 档位计划均由宿主预先绑定。全局 `deadlineMs` 是绝对时间，恢复不能重新计算。修改 profile、key 或 runner 配置会改变 binding；有未完成 journal 时必须保留原配置。

支持链 `31337` 和 `10143`。Anvil RPC 必须为 loopback HTTP；Monad RPC 必须为私有文件中的 HTTPS URL，transport 可选 `direct` 或现有 `system-https-proxy`。provider relay、Arena 和 underwriter 都必须为 loopback HTTP，URL 不含 userinfo、query 或 fragment；underwriter 即使走现金也须配置。实际链 ID、账户和合约身份仍由 core 核验。配置支持 Monad 不代表本入口已完成公网链验收。

`timeoutMs` 和 `pollTimeoutMs` 为可选整数，范围 `1000..300000` 毫秒，传给原 SDK 请求与结果轮询；未配置时使用工作流默认值。它们不会增加模型轮数、延长持久 deadline 或重试付款。最多 16 个 profile，HTTP 端口范围 `1024..65535`，Host 固定为 loopback。

启动需要 Node `>=22.19`、已安装的 workspace 依赖，以及运行 Pi 工具所需的 Docker。先启动该 profile 已配置的 underwriter、固定价 relay、settler 和 Arena；统一服务入口由 `scripts/backend.ts` 管理。

```sh
TASK_RUNNER_CONFIG=/absolute/private/task-runner.json \
node --import tsx scripts/task-runner.ts
# 或将 TASK_RUNNER_CONFIG 放在当前用户的 0600 私有 env 文件
node --env-file=/absolute/private/task-runner.env --import tsx scripts/task-runner.ts
```

不接受 CLI 参数。监听成功输出一行：

```json
{"ready":true,"service":"task-runner","host":"127.0.0.1","port":8790}
```

`SIGINT`/`SIGTERM` 先关闭 HTTP admission，再等待当前工作流持久化、释放锁；不会中止后立即另起付款。被外部终止或机器重启后，按下述原 ID 恢复。

## HTTP 合同

固定路径为 `/api/tasks/runs`。POST 使用 `application/json`，body 上限 2048 bytes；requestId 为小写 UUID。接口不自动重试请求或创建替代 ID。

```sh
curl http://127.0.0.1:8790/api/tasks/runs
curl 'http://127.0.0.1:8790/api/tasks/runs?requestId=6f8a6c25-79c0-4dac-91e6-c7d8d3c41484'
curl -X POST http://127.0.0.1:8790/api/tasks/runs \
  -H 'content-type: application/json' \
  -d '{"action":"start","requestId":"6f8a6c25-79c0-4dac-91e6-c7d8d3c41484","profileId":"fixed-python"}'
curl -X POST http://127.0.0.1:8790/api/tasks/runs \
  -H 'content-type: application/json' \
  -d '{"action":"recover","requestId":"6f8a6c25-79c0-4dac-91e6-c7d8d3c41484"}'
```

start/recover 返回 `202` 与安全 snapshot，后台执行不阻塞 GET。相同 requestId、相同 profile 的重复 start 只返回原状态；不同 profile 返回 `409 TASK_REQUEST_ID_CONFLICT`。活 writer 返回 `409 TASK_RUNNER_BUSY`。Paused 或未完成原会话阻止新 ID，必须恢复原 ID；终局 recover 返回缓存，不产生新付款或模型调用。registry 上限 1000 个 run，普通 GET 返回最近 20 个；指定 requestId 可以读取更早的原 run。

snapshot 类型和纯校验导出在 `@agentfuel/pi-loop/task-runner-types`：`parseTaskRunnerCommand`、`parseTaskRunnerSnapshot`。顶层为 `{enabled:true,profiles,runs,run?}`。profile 只含 `profileId,label,chainId,agentId,problemIds`。run 只含 ID、profile、状态、时间、recoverable、安全 reason 和可选 workflow；workflow 包含已选 task/provider/tier、固定价与预留、accept hash/paymentId、子阶段、工具计数及已确认财务终态。额外字段被 schema 拒绝，不透传 raw 签名、key、URL、代码、模型上下文或配置。

run 状态为 `Queued/Running/Paused/Succeeded/Failed/Refunded/Stopped`。更细阶段在 `workflow.phase/childPhase`。错误只返回 `{error:"SAFE_CODE"}`；未知内部错误为 `TASK_RUNNER_UNAVAILABLE`。GET 是原子 journal 的安全投影，不取得 wallet writer、不发 RPC；它展示已保存的 canonical 结果，不能当作一次新链上核验。

## 原 ID 恢复

每个 requestId 的工作流保存在 `<dataDirectory>/runs/<requestId>`，registry 在 `<dataDirectory>/.task-runner`。钱包锁固定在 `~/.config/agentfuel/pi-task-wallets/<lowercase-wallet>`，不受 profile 或 dataDirectory 选择影响；其他调用 core 的宿主须使用同一钱包目录。旧入口和外部钱包操作不受此锁覆盖，仍须遵守同钱包顺序运行。

进程失联后 GET 将原 `Queued/Running` 显示为 `Paused`。确认旧进程已停止后，对原 requestId 发 recover；该动作允许 SessionStore 取得死 PID 的原锁，不会抢占活进程。保留原 profile、journal、deadline、付款 handle、signed raw/hash/nonce 和 Arena runId；不删除 `.writer` 或移动 journal 来绕过恢复。

接单或交易响应未知时，core 查询原 hash，只允许原签名恢复。模型派发未知保留原 child handle，恢复不能再次派发。`SubmissionPending` 只查原 Arena 提交；`RefundPending` 只查原退款。未知阶段不会以新 ID、另一钱包、另一 quote 或付款替代。到期不延长原 deadline、不新签付款或运行新模型轮；能领取已付款缓存和查询原提交的行为由原 core 决定。安全 reason 和 phase 应向运营人员显示，不能把 Paused 显示为成功。

## 受控验收与 UI 接入

```sh
node --import tsx --test --test-concurrency=1 \
  packages/pi-loop/test/task-runner.test.ts \
  packages/pi-loop/test/task-runner-integration.test.ts
npm run typecheck
```

HTTP 集成使用新 Anvil、真实本地合约/SDK 付款、受控模型、Pi/Docker、独立 settler/Arena。它核对 Open→accept canonical receipt、一次 B 购买、5 个 sum hidden tests、还款和现金终态，并经 HTTP 原 ID 恢复核对零新增模型、钱包 nonce 与余额不变。安全、幂等、死 PID 恢复、单 writer admission 和私有配置另有定向覆盖。四题 core 测试见 [WORKFLOW.md](WORKFLOW.md)。这些受控结果不冒充真实模型或 Monad 验收。

`test/task-runner-fixture.ts` 的 `createTaskRunnerFixture` 为可信宿主提供可复用验收入口。可注入 `modelFetch/models/upstreams/upstreamTimeoutMs`；`maxCompletionTokens` 最大 2048，`workflowTimeoutMs` 为 `5000..300000`。全部最终 profile 在写私有文件、计算 digest 前定稿。默认仍为受控模型、256 tokens 和 90 秒全局 deadline；helper 将 B 计划固定为一轮，最多一次物理模型调用。真实上游验收由宿主显式注入并独立审计，HTTP 无这些参数。

UI 可直接使用同源桥接：展示 profiles、生成并保留 start UUID、轮询安全 GET、显示 phase/reason/固定价与财务终态，并在 recoverable 时提交原 ID recover。活任务或未知结果时不能用新 ID 重开。UI 尚需页面操作与状态展示验收；后端配置、付款和恢复无需浏览器再接线。
