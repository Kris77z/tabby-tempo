# 网页 GameFi runner

`/arena` 的真实开局通过同源 `/api/arena/gamefi` 调用固定的德州流程：

1. `holdem-live.ts` 发起真实 Kimi 决策，服务端裁判洗牌、执行合法动作并保存可信 replay。
2. USDC 奖励调用原 `holdem-monad.ts` 和 `holdem-monad-purchase.ts`：固定 0.1 TEST USDC 奖励入 cash，再为每个获奖座位购买一次固定推理。
3. 推理额度奖励跳过 Monad 交易，从可信 replay 重新计算赢家，向固定运营账户的额度 ledger 发放总计 4096 tokens。消费入口由 `/api/arena/credits` 提供。

`holdem-live.ts` 内部的本地 mock-USDC 奖励及受控推理属于本地验证证据。它们与 Monad TEST USDC 或额度奖励分别展示；真钱领奖依赖后续对应阶段。

## 运营配置

保存下列 JSON 为运营用户拥有的 `0600` 文件，设置 `GAMEFI_RUNNER_CONFIG`。配置选择现有 `holdem-monad` 私有配置作为模板；原模板与旧 evidence 不会被改写。每局产生新的 `holdem.json`，将 `sourceDirectory` 绑定到该局新 evidence。

```json
{
  "version": 1,
  "dataDirectory": "/absolute/private/gamefi-state",
  "holdemConfigFile": "/absolute/private/holdem-delivery.json",
  "rpcUrlFile": "/absolute/private/monad-rpc-url",
  "rpcTransport": "direct",
  "rewardKinds": ["usdc", "llm-credits"]
}
```

模板中的 `monadConfigFile`、`deploymentStateFile` 也须为 `0600` 本地文件。数据目录、私有 replay 和账本使用 `0700` 目录、`0600` 文件。符号链接和非运营用户拥有的配置会被拒绝。私钥只由原 CLI 从模板指定的 key file 读取，不进入网页输入、运行摘要或子进程日志。

从仓库或 frontend 目录启动前端，使用 Node 22；`forge`、`anvil` 应在运营进程 PATH 中。前端默认使用 webpack 的 `.js` → `.ts` 解析以支持现有 Node ESM 脚本。

```sh
GAMEFI_RUNNER_CONFIG=/absolute/private/gamefi.json npm run dev --workspace @agentfuel/frontend -- --port 3023
```

runner 子进程固定传入 `AGENTFUEL_RPC_INTERVAL_MS=500` 和 `AGENTFUEL_RPC_RETRY_READ_503=1`。只读 RPC 的 503 与 native `ECONNRESET` 共用最多三次重试，全部尝试受原始单请求 deadline 与取消控制；广播、batch 和模型请求不做自动重试。

对省略 `eth_call` gas 时拒绝请求的 RPC，运营进程可设置 `AGENTFUEL_RPC_CALL_GAS_LIMIT=100000`。此开关默认关闭，只接受 `21000` 至 `1000000` 的十进制整数；复杂 getter 应先通过完整只读预检验证所选上限。`monadProvider` 仅为缺少 gas 的 `eth_call` 填入此值，保留显式 gas、block tag 和其他参数；`eth_estimateGas`、广播及已签名交易均不变。该环境变量由运营进程传给 worker 和原 CLI，浏览器无法设置，且不改变原比赛 config digest。

```sh
AGENTFUEL_RPC_CALL_GAS_LIMIT=100000 node --import tsx scripts/holdem-monad.ts \
  --config /absolute/private/run/holdem.json \
  --rpc-url-file /absolute/private/rpc-url --rpc-transport system-https-proxy
```

上述命令只读核验完整链上预检。确认 `ready` 后，运营恢复仍使用同一 UUID、原 journal 和原签名；此开关不会降低预检条件或产生新的交易 nonce。

## 网页契约与恢复

`POST /api/arena/gamefi` 只接受 `{action:"start",requestId:UUID,rewardKind:"usdc"|"llm-credits"}` 或 `{action:"recover",requestId:UUID}`。同一个 UUID 与奖励类型返回同一局；换奖励类型会返回 `409`。`GET` 查询最近 20 局，或用 `?requestId=UUID` 查询某一局。只允许 loopback Host；付费写请求必须带完全匹配的 Origin。浏览器不能设置路径、命令、模型、RPC、钱包、私钥或赢家。

全局 SessionStore writer 锁覆盖一局的所有阶段，同一运营配置只执行一局。子进程先等待 IPC，父进程 fsync 子进程 PID 后才发送执行命令。父进程在确认前退出时，子进程不会开始 CLI。父进程确认后退出时，已记录的 worker 可继续保存原 evidence；恢复请求在它仍存活时会被拒绝，防止重叠。

`.runner/session.json` 保存每个阶段的 intent、原 evidence 位置和公开摘要。恢复行为如下：

- 完整比赛已有可信 replay 和已验证 report：继续剩余奖励阶段。
- 已开始但没有可信终局的比赛：暂停，展示未知结果，永不再次调用该局模型。可以用新的 UUID 创建新局；旧局记录保留。
- Monad 派奖或 deposit 中断：原 CLI 用 `--recover` 读取同一交易 journal，只查询或重广播同一份已签名交易，不生成第二次派奖。
- 奖励推理结果未知：暂停。恢复只复核原 receipt/cache，原 CLI 不再次派发已有未知的模型请求。
- 额度发放中断：用同一 grantId、matchId、replayDigest 恢复。ledger 的唯一绑定确保只发放一次。

修改运营配置会改变 journal binding，已有数据目录不会被自动接管。浏览器收到固定错误码；私有路径、模型原文、牌堆、手牌和签名不进入公开返回值。

worker 会过滤原 CLI 的 stderr，仅把固定错误码和 `journalDiagnostic` 白名单写入对应 `stages.*.diagnostic`。缺少交付 report 时显示这份原因，原始错误文本、RPC URL 和签名不会进入 journal。既有未留 stderr 的历史失败无法追溯完整原因；复查与恢复的观测应分别记录。

USDC 执行阶段完成链上预检后，原 CLI 会保存 `monad-preflight-report.json`，包含公开的钱包余额、gas 门槛、白名单和身份检查。`HOLDEM_PREFLIGHT_NOT_READY` 应先依据该报告补齐运营条件，再恢复原 UUID；固定奖额不会因余额不足而下降。

## 离线验证

```sh
node --import tsx --test services/arena/test/gamefi-runner.test.ts
node --import tsx --test frontend/test/gamefi-origin.test.ts
```

测试使用可信 transport 注入及真实额度 ledger，不调用付费模型、RPC 或广播；覆盖完整串联、UUID 幂等、跨实例单并发、重启恢复、未知状态、公开输出过滤与 IPC 启动边界。

## 2026-10-05 本机交付启动

当前生产预览为 `http://127.0.0.1:3020/arena`。从仓库根目录使用以下已存在的私有配置启动；配置内容和密钥不进入仓库：

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
NEXT_DIST_DIR=.next-gamefi-final npm run build --workspace @agentfuel/frontend
NEXT_DIST_DIR=.next-gamefi-final \
GAMEFI_RUNNER_CONFIG=/Users/jungle/.config/agentfuel/gamefi-20261004/runner.json \
GAMEFI_CREDIT_ACCOUNT_AGENT_ID=1999 \
ARENA_PLAY_STATE_PATH=/Users/jungle/.config/agentfuel/gamefi-20261004/practice.json \
HOLDEM_REPORT_PATH=/Users/jungle/Desktop/dev/agentfuel/demo-output/holdem-live-20261004-root/report.json \
HOLDEM_DELIVERY_REPORT_PATH=/Users/jungle/Desktop/dev/agentfuel/demo-output/holdem-live-20261004-root/monad-delivery-report.json \
HOLDEM_PURCHASE_REPORT_PATH=/Users/jungle/Desktop/dev/agentfuel/demo-output/holdem-live-20261004-root/monad-purchase-report.json \
npm run start --workspace @agentfuel/frontend -- --port 3020
```

已有3020进程运行时无需重复启动。历史回放配置与新比赛runner记录分别保存。可见页每3秒轮询运行中的比赛，隐藏页暂停轮询；服务端继续运行。练习局使用同一持久文件，重启不会重新洗牌。RPC对只读503/ECONNRESET共享最多3次重试预算，受原超时限制；广播和模型请求不自动重发。
