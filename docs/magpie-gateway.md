# Magpie 最小实际接入

本模块运行官方 Magpie 的终端网关，而非替身或配置样例。范围是 **SDK → 原 Relay → 实际 Magpie → 受控 OpenAI Chat HTTP 上游**；cheap/strong 继续由调用方显式选择，报价、付款、退款、paymentId 和 receipt 仍使用已有实现。没有修改合约、SDK 或 Relay 核心。

官方支持 `magpie serve`、`/v1/chat/completions` 和自定义 `provider/model`。本地锁定 [v0.1.814](https://github.com/yetone/magpie/tree/v0.1.814)，commit `d6096e2fb1710ba123c0d4f59ed8e7e22165de07`。源码、Go 版本、补丁和补丁后文件 hash 见 [magpie.lock.json](../scripts/magpie.lock.json)。上游为 MIT，保留 [原 LICENSE](../scripts/magpie-UPSTREAM-LICENSE)；本模块在官方源码上应用 [小补丁](../scripts/magpie-no-retry.patch)，运行版本标记为 `0.1.814-agentfuel.1`，不把它称为未修改的官方发行版。

## 为什么有补丁

[官方 fallback.go](https://github.com/yetone/magpie/blob/d6096e2fb1710ba123c0d4f59ed8e7e22165de07/internal/gateway/fallback.go#L738) 的常量使单个候选对 408/500/502/503/504/529 最多再试两次，对短暂限流 429 最多再试三次。`Retry-After > 8s` 会停止这些重试，但不能控制无该 header 的第三方响应。实测原版的一次 502 产生 3 次受控上游请求。

补丁只处理这一接缝：

- 将 `lastRetries` 和 `rateRetries` 设为 0，停止瞬时错误的自动重试。
- 每个入站请求的 context 带一个原子尝试标志；`forwardOnce` 第二次调用在发送 HTTP 前拒绝。这也阻止 400 自动修补等隐式重发。它不按 body hash 去重、不跨请求共享、不新增模型账本。
- 禁止 HTTP redirect，并清除 POST `GetBody`；Go transport 与 Magpie 的 IPv4 replay 路径不能重放这个 body。

补丁 SHA256：`a73f41c94fd4cbee820ef2708227e35c38a575fa20b5404ae2c6c2323dfedb54`。验收范围为配置一个 key、一个显式模型、一个普通 Chat base URL 的 **非流式 OpenAI chat**。没有验收订阅、group、分类器、Anthropic、Responses、流式回复或工具调用。

一次 Magpie 入站请求最多向物理上游发送一次 HTTP；这不表示整个系统 exactly-once。两个相同 body 的独立请求各可调用一次。当前 Relay 将 5xx、408、409、断线和无效响应保留为 `Processing/UPSTREAM_UNCERTAIN`；同 paymentId 的 SDK resume 和 Relay 恢复均不能再次派发，退款也被拒绝，必须先对账原调用。完整的明确拒绝响应（400、401、403、404、413、415、422、429）才允许尝试原快照内的未调用候选，或按原付款退款；已拒绝候选本身不会因 resume 再试一次。探针使用 429 验证原报价 30000 的退款，即使运营已将新报价调为 90000。

## 复现

要求：macOS、Node 22、Go `1.26.3`、Anvil/Foundry、仓库依赖及既有合约 build。未验证 Linux 或容器启动，所以当前 launcher 会明确拒绝其他平台。

```bash
npm install
forge build --root contracts --skip-lint
npx tsx scripts/magpie-build.ts --output /absolute/magpie-runtime
MAGPIE_BIN=/absolute/magpie-runtime/magpie npx tsx --test scripts/test/magpie.test.ts
npx tsx scripts/magpie-probe.ts --binary /absolute/magpie-runtime/magpie --output /absolute/new-evidence
```

builder 下载 hash 锁定的官方源码，应用并验证补丁，编译真实网关，保存 `build.json`、binary hash 和原 LICENSE；不会安装到全局。可离线使用同一官方 archive：

```bash
MAGPIE_SOURCE_ARCHIVE=/absolute/official-source.tar.gz npx tsx scripts/magpie-build.ts --output /absolute/new-runtime
```

要复现原版自动重试的对照，下载 [官方 darwin-arm64 CLI v0.1.814](https://github.com/yetone/magpie-releases/releases/download/v0.1.814/magpie-cli-darwin-arm64)，其 SHA256 必须是 `4d3250b6a047b0fc08018ea813f7ee52d7462aa6c93913c5dd53051908d30688`，追加 `--official-binary /absolute/official-magpie`。测试可用 `MAGPIE_OFFICIAL_BIN` 指定同一原版文件。缺少 `MAGPIE_BIN` 会失败，不会静默 skip。

## 独立启动与 Relay 配置

把本次 provider 配置写到单独文件，不复用机器上的 Magpie 状态：

```json
[
  {"id":"cheap","model":"cheap-physical","baseUrl":"http://127.0.0.1:9100/v1","key":"synthetic-local-key"},
  {"id":"strong","model":"strong-physical","baseUrl":"http://127.0.0.1:9101/v1","key":"synthetic-local-key"}
]
```

```bash
npx tsx scripts/magpie-gateway.ts --binary /absolute/magpie-runtime/magpie --state /absolute/private-magpie-state --port 3425 --providers /absolute/private-providers.json
```

launcher 只允许 loopback HTTP provider，校验补丁构建记录与 binary hash，健康检查必须报告指定版本，catalog 必须恰好等于本次 provider。它保存的配置为 0600，key 不进入 catalog/receipt/报告。用于真实 Kimi 的边界可由一个本地薄桥持有私有 key、调用项目现有请求级 HTTPS proxy、保存物理请求/响应；Magpie 仍访问 loopback。此文档不把这条真实链路视为已验证。

Relay 继续用现有 `TIERS_JSON`：

```json
{
  "cheap":{"price":"10000","upstreams":[{"name":"magpie-cheap","baseUrl":"http://127.0.0.1:3425/v1","model":"cheap/cheap-physical","keyEnv":"MAGPIE_LOCAL_KEY"}]},
  "strong":{"price":"30000","upstreams":[{"name":"magpie-strong","baseUrl":"http://127.0.0.1:3425/v1","model":"strong/strong-physical","keyEnv":"MAGPIE_LOCAL_KEY"}]}
}
```

`MAGPIE_LOCAL_KEY=magpie` 只是本地网关 token，物理 vendor key 留在本次 Magpie provider 配置或薄桥。没有引入自动选档或新的路由框架。

`receipt.model` 在此接入中是快照绑定的 `provider/physical-model` 唯一路由 ID；`receipt.upstream` 是 Relay 候选名。Magpie 发到物理上游的 `request.model` 和原返回 `response.model` 是不带 provider 前缀的物理 ID，探针另存两者、usage 与原响应，不能只用路由 alias 推断实际模型。provider 的物理 URL/模型不可在已有已付请求下悄悄改指；本 spike 的受控配置在运行期间固定，生产跨 Magpie 重配置的快照恢复契约尚未实现。

官方 [Accounts()](https://github.com/yetone/magpie/blob/d6096e2fb1710ba123c0d4f59ed8e7e22165de07/internal/provider/account.go#L659) 会发现本机 agent 登录；单独设 XDG 目录不足以隔离 `~/.codex`、`~/.claude` 和 Keychain。官方 [gateway 测试入口](https://github.com/yetone/magpie/blob/d6096e2fb1710ba123c0d4f59ed8e7e22165de07/internal/gateway/main_test.go) 也专门隔离这些来源。本地 launcher 因此保持系统 HOME 原义，用 macOS `sandbox-exec` 拒绝用户 home 的读写，仅放开本次状态目录和 binary，放入惰性的 credential-discovery CLI，网络仅放开 localhost。实际 catalog 检查是这一隔离的验收证据。这里没有修改用户现有 agent 配置，也没有调用付费模型或写 Monad。

## 保存的验收证据

[2026-10-04 历史报告](../demo-output/magpie-20261004-final/report.json) 包含原版重试对照、补丁进程版本/hash、故障调用计数、两档付款、预算拒绝、同 body 两笔独立付款，以及当时的锁价重发与全退。它的“502 后显式 resume 再调用/退款”记录属于旧 Relay 规则，不能作为当前恢复契约。原始 `ProviderPaid`/退款 receipt、SDK 原签名付款、Relay 持久记录保存在同目录；[受控上游原请求/响应](../demo-output/magpie-20261004-final/upstream-calls.json) 另保留物理 model 与 usage。Anvil 和 Magpie 均在收集证据后关闭，离线读取不能重新查询原链。

当前探针保留上述网关隔离、两档价格、缓存与预算检查，另用实际 Magpie、受控 HTTP 和新 Anvil 验证：502/503/408/409、响应丢失及无效响应只调用一次，resume、读取持久记录的新 Relay 恢复及退款都不再派发或签退款交易；429 明确拒绝可按原价全退，重复退款和 refunded handle 均无额外模型调用。运行范围仍为本地合成资产与凭证。

2026-10-07 执行 Agent 实跑：集成测试 1/1、0 fail/skip，typecheck 通过；[当前兼容性报告](../demo-output/magpie-20261007-compat-agent/report.json) 保存 22 项受控检查、20 次合成上游请求（含原版 502 三次调用的历史行为对照）。root 已独立复跑同一实际进程集成测试并通过，汇总见[后端验收](backend-acceptance.md)；本次没有调用真实模型或公网链。测试自身的临时目录会清理，独立 CLI 证据保留在该报告目录。

故障覆盖 429、502、HTTP 前连接断开、端点不可连接、已收到请求但响应丢失、307 redirect 和触发 token-floor 修补的 400。每次补丁网关入站最多一次受控 HTTP dispatch 或一次失败 TCP 连接；相同 body 的两个并行独立请求各调用一次。未声称已验证自动 group fallback、真实模型能力或真实 Kimi 业务链路。

## 后续真实模型信用验收

root独立[17项网关验证](../demo-output/magpie-20261004-root/root-acceptance.json)通过后，实际锁定Magpie进程经本地薄桥调用真实Kimi K2.6，跑通固定价信用B/Pi工具/Arena本地融资还款。薄桥持真实API key并使用请求级HTTPS代理；Magpie只持本地token、仅访问loopback。网关请求model为cheap/kimi-k2.6，物理请求/响应均为kimi-k2.6；原始messages/tools/usage/response已独立对照，见[真实信用验收](../demo-output/live-local-credit-20261004-root/root-acceptance.json)与[网关来源](../demo-output/live-credit-magpie-20261004-root/gateway-provenance.json)。此一次首轮成功不能证明真实修复或自动group fallback；Monad状态另见工程状态表。

后续Monad Task11已通过[root独立验收](../demo-output/live-monad-pi-20261004-alchemy-root/root-acceptance.json)：同一实际Magpie版本/补丁与薄桥，真实K2.6一次调用，物理messages/tools/响应/usage逐项匹配；经Pi工具与独立Arena后完成测试USDC借款及还款。Alchemy直连，253次宿主RPC成功（不含独立settler请求）；此结果不保证长期RPC稳定。首次即成功，不证明自然多轮修复；固定价不等于vendor账单。
