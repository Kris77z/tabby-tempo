# Arena（P0）

四道手写 Python 3.12 / JSON stdin-stdout 题：`sum-integers`、`unique-sorted`、`balanced-brackets`、`word-frequency`。`GET /problems` 提供题意及可信任务映射，建议 reward `150000` 使用 USDC 的 6 位小数；实际 reward 与资产必须读链。Arena 不创建链上任务，也不自动把任意新 task 绑定到某道题。

提交代码只进入一次性 Docker 容器。宿主 controller 逐条发送输入并比较 JSON 输出，预期答案和通过计数不进入容器。打印 `PASS`、退出码 0、stderr 内容都不能代替答案。错答案、无效 JSON、非零退出、超时或输出超限均失败。缺少 Docker 或基础镜像是基础设施错误，不会执行宿主代码，也不会自动改成人工通过。

## 启动

需要 Node.js 22+、npm workspace 依赖、Docker daemon。先显式拉取镜像；执行期间不拉镜像：

```sh
docker pull python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111
```

本机创建独立 `ARENA_CONFIG` JSON 文件；`ipcDirectory` 必须是当前用户的绝对路径，且 Unix socket 路径总长不超过 100 字节：

```json
{
  "rpcUrl": "http://127.0.0.1:8545",
  "chainId": "31337",
  "escrowAddress": "0x0000000000000000000000000000000000000001",
  "ipcDirectory": "/tmp/agentfuel-arena-local",
  "allowManual": false,
  "tasks": {
    "1": { "agentId": "0", "problemId": "sum-integers" }
  }
}
```

示例地址需替换为该 chain 上的实际 TaskEscrow 地址。task 必须已 `Assigned` 给配置中的 agent；任务绑定由可信运维写入，不接受 HTTP 请求更改。`taskId`、`agentId`、`chainId`、deadline 始终使用十进制字符串，agent ID 0 有效。测试网使用其明确 RPC、chainId 与已部署 Escrow；本批验证只对本地 Anvil 和合成钱包执行真实交易。

在独立终端启动 settler；只有这个进程设置 `ARENA_VERIFIER_PRIVATE_KEY`，且钱包必须等于链上 `TaskEscrow.verifier()` 并有 gas 余额：

```sh
ARENA_CONFIG=/absolute/arena.json ARENA_VERIFIER_PRIVATE_KEY=<verifier-key> npm run settler --workspace @agentfuel/arena
```

另一个不含 verifier key 的进程启动可信 CLI controller，或供面板使用的本地 HTTP 桥：

```sh
ARENA_CONFIG=/absolute/arena.json npm run submit --workspace @agentfuel/arena -- 1 fixtures/sum.py
ARENA_CONFIG=/absolute/arena.json ARENA_PORT=8789 ARENA_UI_ORIGIN=http://127.0.0.1:3000 npm start --workspace @agentfuel/arena
```

HTTP 固定监听 `127.0.0.1`。CORS 允许配置的前端 origin；缺省允许 localhost/127.0.0.1 的 3000 端口。公开 manifest 仅放 `arenaUrl`，不要放 IPC 路径或密钥。没有人工判决 HTTP 接口。

## HTTP 钱包授权与接口

`GET /problems` 返回 `{problems:[{id,language:"python3",prompt,reward}],tasks:{[taskId]:{agentId,problemId}}}`，不含 hidden tests。每条测试使用独立容器，stdin 是一份 JSON 值加换行，stdout 必须是一份 JSON 值；没有批量测试输入。`POST /submissions` 接收 `{taskId,code,deadline,signature}`，其中 deadline 为最新链上时间加最多 300 秒。使用当前 registry agent wallet 签署如下 EIP-712 数据：

```ts
import { keccak256, toUtf8Bytes } from "ethers";
const domain = {
  name: "InferCreditArena", version: "1", chainId,
  verifyingContract: escrowAddress,
};
const types = { Submission: [
  { name: "taskId", type: "uint256" },
  { name: "agentId", type: "uint256" },
  { name: "codeHash", type: "bytes32" },
  { name: "deadline", type: "uint256" },
] };
const message = { taskId, agentId, codeHash: keccak256(toUtf8Bytes(code)), deadline };
const signature = await agentSigner.signTypedData(domain, types, message);
```

签名同时绑定任务、agent、完整代码、chain、Escrow、短 deadline。服务在同一 blockTag 读任务和 `Escrow.adapter().resolveAgent()`，校验当前 wallet 后才运行代码。无签名、他人钱包、修改代码、错域、过期或过长 deadline 被拒绝。自动提交不接受 `passed` 字段。

第一次有效提交返回 `202 {runId,taskId,status:"running"}`；同一个完整请求重试返回 `200` 和原 runId，新内容提交同任务返回 `409`。`GET /runs/:runId` 返回 `{runId,taskId,status:"running"|"settled"|"error",result?,error?}`。完成结果包含 `verdict`、逐条测试结果和 `settlement {taskId,runId,passed,txHash,blockNumber,feedback:[{type,sent,pending}]}`。反馈类型 1/2/3 对应 task-success/repayment/default；资金结算成功与声誉写入分别显示。API 运行记录与 HTTP 请求幂等映射仅保存在当前 HTTP 进程内，最多 100 条；HTTP 重启后旧 runId 查询返回 404，同请求领取原运行记录的保证也随该进程结束。若任务已结算，新提交会被链上状态检查拒绝；从私有 signer journal 和链上交易核对结果，signer 仍保留持久化交易幂等保证。

CLI 与 `ArenaController.submit({taskId,code})` 面向可信本机运维，不接收外部流量；HTTP 才要求钱包签名。`src/index.ts` 不导出 signer 或 Wallet。

## 隔离、结算与恢复

固定 Docker 约束：网络 `none`；UID/GID `65532`；rootfs 与仅含 `main.py` 的提交挂载只读；`/work` 是可写、不可执行的 16 MiB tmpfs；丢弃 capabilities；`no-new-privileges`；CPU 0.5、内存/含 swap 总额 64 MiB、32 pids。Python 以 `env -i`、`-I -B` 启动，没有宿主 env、宿主秘密目录、Docker socket、privileged 或自定义提交者 flags。每条测试默认 3 秒，stdout + stderr 共 16 KiB；宿主最终执行强制清理并检查容器不存在，删除本次临时目录。

Settler 仅通过 Unix socket 接收随机 controller token；IPC 目录为 0700，token/socket/journal 为 0600。controller 进程不持 verifier key；签名进程不执行提交代码。该机制信任本机运维用户，不能防同一宿主用户主动窃取本机私有文件。容器看不到 IPC。

Signer 在每次结算前复查 chain、显式 Escrow 地址、链上 verifier、task agent 和 Assigned 状态。固定 2,000,000 gas 为常规声誉写入提供预算，并报告 `sent/pending`；Registry 失败仍按合约规则不回滚资金。其私有 JSON journal 在广播前保存唯一原始签名交易，崩溃或重试使用同一 txHash；已结算 task 不接受新 verdict，重复 verdict 返回原结算结果。

正常 SIGINT/SIGTERM 会关闭 socket 和清除 owner/token。SIGKILL 后，先执行恢复命令再启动：

```sh
ARENA_CONFIG=/absolute/arena.json npm run recover --workspace @agentfuel/arena
```

恢复仅在 owner PID 已死亡且 socket 无法连接时删除残留 socket/token/owner，保留 journal；活 signer 或无法确认状态时拒绝。PID 复用会保守拒绝，需运维核对。不要手动删除活进程的 socket。

没有 Docker 时，可显式设置 `allowManual: true`，分别重启 signer 和 controller，再由可信运维执行：

```sh
ARENA_CONFIG=/absolute/arena.json npm run manual --workspace @agentfuel/arena -- 1 pass "Human reviewed the submitted code and outputs"
```

人工模式不运行任何代码，结果明确为 `mode:"manual"`、`tests:[]`；讲稿必须说明人工验收。不会把普通子进程称为安全隔离。

## 实测

2026-10-02 主 Agent 已逐段独立审查 Docker、HTTP 钱包授权、IPC、settler 与恢复流程，并独立运行 `npm test --workspace @agentfuel/arena`：**9 passed / 0 failed / 0 skipped**，用时 40.5 秒。本批验收通过。

```sh
npm test --workspace @agentfuel/arena
```

测试不会跳过缺少 Docker 的关键验证：daemon/image 不可用会直接失败。Foundry `forge`/`anvil` 需在 PATH，测试仅启动并停止自己创建的本地 Anvil，无默认账号，合成钱包用 `anvil_setBalance` 注入本地余额。

已覆盖四题真实容器、隔离参数及容器内探针、正确答案、伪 PASS、错答案、超时/输出泛滥/非零退出、取消清理、IPC 非授权拒绝、同 verdict 幂等、SIGKILL 恢复与 token 轮换、钱包授权攻击和 HTTP 轮询，以及 USDC/native 下实际成功还款/声誉和失败原子清算。此实现不包含通用 worker 调度、公开任务发布、自动测试生成或生产级抗 DoS；题库在仓库内公开，hidden 指容器运行时不接收答案。
