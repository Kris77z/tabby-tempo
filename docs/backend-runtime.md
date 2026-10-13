# 本机后端统一启动

`scripts/backend.ts` 从可信私有 manifest 启动五个固定服务：Underwriter、固定价 Relay、独立 settler、Arena HTTP、task-runner。先准备已部署合约、受信任务绑定、角色资金、Docker daemon 和已锁定 Python 镜像。它不创建钱包、不领币、不部署、不创建任务、不启动新的 runner workflow。

默认 `--check` 只读本机配置并检查端口可绑定；不连接 RPC、不启动服务、不创建运行目录。它检查配置/引用文件权限与端口，离线校验完整 workflow、runner wallet/key 对应关系、支持的 chain 与 RPC/Relay URL 边界；链上地址、余额、gas、当前身份和模型有效性仍由已有服务在运行时验证。`--start` 沿用 Relay 的已有 `refunder.recover()/relay.recover()`：旧已付款且尚未派发的记录可能继续模型调用，原退款 journal 可能继续原交易；未知 dispatch 仍按原规则阻止重发。先核对配置的数据目录与旧业务记录。服务持续运行；任何 child 退出或启动失败都会关闭该 supervisor 的所有 child，保留原业务 journal。没有任意 command、shell、entrypoint 或自动重启字段。

## Operator 配置

以下路径是占位符，先替换为本机绝对路径。manifest、每个角色 env、Arena JSON、runner JSON、runner key/profile/RPC 文件均须为当前用户所有的普通文件，权限 `0600`，不能是文件符号链接。运行目录已有时必须为当前用户所有、`0700`；没有则仅在 `--start` 时创建。五个 env 文件必须各自独立。

```json
{
  "version": 1,
  "runtimeDirectory": "/Users/YOU/.config/agentfuel/backend/runtime",
  "startupTimeoutMs": 90000,
  "roles": {
    "underwriter": {
      "envFile": "/Users/YOU/.config/agentfuel/backend/underwriter.env",
      "port": 8787
    },
    "fixed-relay": {
      "envFile": "/Users/YOU/.config/agentfuel/backend/relay.env",
      "port": 8788
    },
    "settler": {
      "envFile": "/Users/YOU/.config/agentfuel/backend/settler.env",
      "configFile": "/Users/YOU/.config/agentfuel/backend/arena.json"
    },
    "arena": {
      "envFile": "/Users/YOU/.config/agentfuel/backend/arena.env",
      "configFile": "/Users/YOU/.config/agentfuel/backend/arena.json",
      "port": 8789
    },
    "task-runner": {
      "envFile": "/Users/YOU/.config/agentfuel/backend/task-runner.env",
      "configFile": "/Users/YOU/.config/agentfuel/backend/task-runner.json",
      "port": 8790
    }
  }
}
```

所有 HTTP 监听固定为 `127.0.0.1`，端口必须不同且在 `1024..65535`。Underwriter/Relay env 的 `HOST` 与 `PORT` 可省略，由 manifest 注入；如果指定，必须一致。Arena 的 `ARENA_PORT` 同理。task-runner 私有 JSON 的 `port` 必须与 manifest 一致。`startupTimeoutMs` 是每个服务的等待上限，允许 `100..300000`，缺省 90000。

| 角色 | 私有配置内容 | 固定入口 |
| --- | --- | --- |
| Underwriter | `RPC_URL`、`CHAIN_ID`、`MANAGER_ADDRESS`、`SETTLEMENT_ASSET`、`ASSET_DECIMALS`、`UNDERWRITER_PRIVATE_KEY`；显式配置私有 `EVIDENCE_DIR` | `services/underwriter/src/main.ts` |
| fixed-relay | 原 Relay env；服务 `infercredit/solve-fixed`、逻辑模型 `pi-fixed-v1`、固定 `PRICE`，`UPSTREAMS_JSON` 为 cheap/strong 两路；私有 `DATA_DIR`、`REFUNDER_PRIVATE_KEY`、`OPERATOR_TOKEN`、各 `keyEnv` 的 API key | `scripts/fixed-relay.ts` |
| settler | **只有此 env 设置 `ARENA_VERIFIER_PRIVATE_KEY`**；`ARENA_CONFIG` 可省略，由 manifest 的 `configFile` 注入 | `services/arena/src/settler-main.ts` |
| Arena HTTP | 可为空 env，或设置 `ARENA_UI_ORIGIN`、`ARENA_DOCKER_IMAGE`；共用同一个不含密钥的 Arena JSON | `services/arena/src/http-main.ts` |
| task-runner | 可为空 env；`TASK_RUNNER_CONFIG` 由 manifest 注入，若手写必须一致 | `scripts/task-runner.ts` |

Relay JSON env 使用正常 `.env` 单引号包围 JSON，例如 `UPSTREAMS_JSON='[{"name":"cheap",...},{"name":"strong",...}]'`，两路物理模型/API key 按运营配置填写。见[固定价接口](../packages/pi-loop/FIXED_PRICE.md)与 [Arena 配置/受控 IPC](../services/arena/README.md)。Arena JSON 只含 `rpcUrl/chainId/escrowAddress/tasks/ipcDirectory/allowManual/settlementTimeoutMs`；映射必须与该链实际任务一致，agent ID 0 有效。

runner JSON 使用已实现的格式：`version:1`、私有 `dataDirectory`、`port`、`wallet`、私有 `keyFile`、`profiles`。每个 profile 固定 `id/label/workflowConfigFile/rpcUrlFile/rpcTransport/arenaUrl/underwriterUrl`；三个服务 URL 分别指向同一批本机 Relay、Arena、Underwriter。workflow 中 `providers[].relayUrl` 使用 `http://127.0.0.1:8788/v1/chat`。runner 不持 verifier 或 refunder key。

Supervisor 不继承 caller 的 key、`NODE_OPTIONS`、代理变量或其他环境；只传 `PATH/HOME/TMPDIR/NODE_ENV=production` 和该角色允许的 env。拒绝非 settler 的 verifier 变量/值复用及 runner key 复用 verifier。env 由 Node 原生 `.env` parser 读取后传给固定 Node 入口，密钥和含 key 的 URL 不出现在启动 argv、stdout 或状态 JSON。原始 child stdout/stderr 仅保存在 `0600` 私有日志；日志不能作为公开附件。

## 启动与状态

从仓库根目录使用 Node 22 和已安装 workspace 依赖。先检查，再用同一个 manifest 启动：

```sh
node --import tsx scripts/backend.ts --manifest /absolute/private/backend.json --check
node --import tsx scripts/backend.ts --manifest /absolute/private/backend.json --start
```

就绪后输出一行 `{"service":"backend","ready":true,"statusFile":"/absolute/private/runtime/status.json"}`。状态文件包含 supervisor PID、`starting/running/stopped/failed`、每个 role 的 PID/端口/状态/私有日志路径，失败可标明 `failedRole`，不含配置、URL、模型输出或密钥。端口 ready 只表示服务已监听；settler 使用其固定入口的 ready JSON，不代替链上业务验收。

```sh
cat /absolute/private/runtime/status.json
```

在 Next 的 server env 中设置 `TASK_RUNNER_URL=http://127.0.0.1:8790`；面板通过现有 `/api/tasks/runs` 桥查询/提交。backend 启动完成后，UI 无需另外补起上述五个后端。Supervisor 不启动 Next、Anvil、Docker Desktop 或 Magpie；这些基础设施需已就绪。任务和模型选择仍由受信 runner profile/workflow 控制，浏览器不能提交任意脚本、私有文件路径或付款参数。

`Ctrl-C` 或向 supervisor PID 发 `SIGTERM` 会关闭本次 child；10 秒后仍不退出的 child 才会收到 `SIGKILL`。关闭不自动退款或重跑未知模型；在途结果需按已有原 journal/handle 的恢复规则核对。`backend.pid` 是独占锁，不自动抢占或删除陈旧锁。若 supervisor 被 `SIGKILL`，先依据私有 status/log 核对并结束其中所有旧 child，再确认旧 supervisor PID 已死亡，才可移除该锁。settler 的残留 IPC 用现有 `recover-main.ts` 核对恢复，必须保留 `settlements.json`；不要删除活服务的锁/socket。

## RPC 传输边界

| 入口 | 当前支持 |
| --- | --- |
| Underwriter main | 私有 env 的 `RPC_URL`，当前为 direct |
| Arena HTTP / settler-main | 私有 Arena JSON 的 `rpcUrl`，当前为 direct |
| fixed-relay | `RPC_URL` 或 `RPC_URL_FILE`；文件覆盖 URL，允许仅配置文件；`RPC_TRANSPORT/UPSTREAM_TRANSPORT` 可显式 `direct` 或 `system-https-proxy` |
| task-runner | 每个私有 profile 的 `rpcUrlFile/rpcTransport` |

检查 `RPC_URL_FILE` 时沿用现有 HTTPS/0600 校验，但有效私有 URL 不写入 status/stdout。Supervisor 不提供全局代理或自动 endpoint fallback；现 Underwriter/Arena/settler 入口不能通过传 `HTTPS_PROXY` 获得显式代理 CONNECT。如果环境要求所有角色强制代理，需先单独完善这些入口再运行，不能把本批受控进程测试称为 Monad 联调通过。

## 本批验证

```sh
node --import tsx --test scripts/test/backend.test.ts scripts/test/backend-stack.test.ts
npm run typecheck
```

`backend.test.ts` 使用实际受控 Node child 和本机临时端口：默认检查不启动业务、坏 workflow/wallet/RPC 配置拒绝且不创建目录、RPC 私有文件配置、禁止外部 command/`NODE_OPTIONS`、角色 env/key 隔离、私有日志/状态、双启动锁、child 失败只清理自己的进程、启动时信号清理及超时强制退出。

`backend-stack.test.ts` 通过真实 backend CLI 和五个固定入口运行；没有 launch 替换。新 Anvil 上实际部署四合约与 mock registry/USDC，新随机 synthetic agent 通过 HTTP 选 Open task 并 accept，固定付款 `120000` = cash `40000` + draw `80000`，本机明确 synthetic HTTP model 仅调用一次，独立 Docker Arena 隐藏判题 5/5、真实还款本金 `80000` + fee `12000`，最终 cash `58000` / outstanding `0`。同一 UUID 重试不增 agent/verifier nonce、付款或模型调用；退出后核对五个 child 和锁清理。只删除本次私有 fixture/随机钱包 namespace，无真实模型或公网链调用；完整 UI 联动由主 Agent 另行验收。

2026-10-07 root 已独立复跑：离线 supervisor 7项、实际五入口 stack 1项、HTTP桥接完整闭环1项、独立固定价Relay入口1项，合计 **10/10 passed，0 failed / 0 skipped**。完整后端交付与UI待验范围见[验收记录](backend-acceptance.md)。
