# 最小双 Agent 五子棋 Arena

> 2026-10-04 产品定位更新：本模块保留为已验收对战原型。目标产品为德州/GameFi，赢取推理额度或USDC，不做游戏借贷；德州规则与奖励闭环尚未实现，见[工程文档](../AGENT_CREDIT_ENGINEERING.md)。

这是可运行的现金付款对局：两个独立 Agent 钱包与 `agentId`，各自逐步使用现有 SDK 向 Relay 付款，再由 OpenAI 兼容 HTTP 上游返回坐标。独立裁判决定棋盘和胜负。没有新增合约、共享奖金、抵押、借款、奖励结算或 reputation 更新；`taskId=0`、每笔 `fromCredit=0`。五子棋收益分配尚未确认，因此本实现只落实双方独立模型费用。

## 复现与证据

需要项目依赖、Node 22、现有 Foundry `anvil`。在项目根目录运行：

```bash
npx tsx --test scripts/test/gomoku.test.ts
npx tsx scripts/gomoku-demo.ts --output /absolute/new-gomoku-evidence
npx tsx scripts/gomoku.ts --replay /absolute/new-gomoku-evidence/match/session.json
```

demo 启动独立本地 Anvil、mock-USDC、双方独立现金账本、两个只有一个候选的 Relay，以及实际监听 `/v1/chat/completions` 的受控上游。它通过真实子进程 CLI 跑三种场景，保存证据后关闭服务和 Anvil，删除本次合成私钥文件。没有公网付费模型请求或 Monad 写入。

受控 [report.json](../demo-output/gomoku-20261004-final/report.json) 验证黑方在第 9 步获得横向五连。黑方 5 笔付款共 `5000`、白方 4 笔共 `4000`，均为结算资产最小单位；两边钱包 nonce 分别增加 5 和 4。主局第 3 步暂停并由新 CLI 进程恢复，完成后再次启动没有新增调用。另一个已付模型响应丢失的局只调用一次，恢复后仍暂停；Relay 已持久保存响应、HTTP 回包丢失的局恢复成完整 9 步且总共只有 9 次调用。三种场景共 19 次受控 HTTP 调用，不代表公网模型能力或费用。

[棋谱日记](../demo-output/gomoku-20261004-final/match/session.json) 保存每步原请求、前后棋盘 hash、报价、付款 handle、已签名交易、完整模型响应、Relay receipt 和原始链上 `ProviderPaid` receipt。[上游请求/响应](../demo-output/gomoku-20261004-final/upstream-calls.json) 保存双方物理 model、坐标与 usage；`pause-checkpoint.json` 和 `cached-checkpoint.json` 保存恢复前的状态。`unknown/session.json` 保存响应未知时的原 handle，`relay-black` 下记录保存已付状态。离线重放验证规则、签名/calldata、receipt 与棋谱的一致性；原 Anvil 已关闭，因此不将离线重放宣称为重新核查链的独立最终性证明。

当前真实验收已有完整终局：2026-10-04 授权启动的独立新局保存在 [运行报告](../demo-output/gomoku-live-20261004-retry-root/report.json)、[棋谱](../demo-output/gomoku-live-20261004-retry-root/match/session.json) 和 [root 独立验收](../demo-output/gomoku-live-20261004-retry-root/root-acceptance.json)。它完成 12 个合法落子、13 次真实 `kimi-k2.6` 模型调用及 13 笔付款，所有模型 HTTP 响应均为 200。黑方 [第 13 次原响应](../demo-output/gomoku-live-20261004-retry-root/ply-13/response.json) 输出了分析文字并达到 256 个 completion token，`finish_reason=length`；裁判按既定规则记录 `INVALID_MODEL_RESPONSE`，终态为 `Finished`、白方 `forfeit` 胜。第 13 子没有落入棋盘，这不是五连胜或平局。

root 逐笔核验了新局的原请求/响应、签名交易、`ProviderPaid`/token transfer、余额、源码 hash 和独立重放。黑方 7 笔共付 `70000`、白方 6 笔共付 `60000`，关闭前现金分别为 `430000`、`440000`，收款方余额 `130000`、`totalOutstanding=0`。这些费用均为本地 Anvil/mock-USDC 最小单位，不是 vendor 账单或 Monad 游戏结算；无借款、共享奖金或 reputation 更新。原链已关闭，当前验收基于保存证据的一致性。

历史首局仍保留在 [原运行报告](../demo-output/gomoku-live-20261004-root/report.json)、[原棋谱](../demo-output/gomoku-live-20261004-root/match/session.json) 与 [原 root 验收](../demo-output/gomoku-live-20261004-root/root-acceptance.json)：11 个合法落子、12 次真实调用/付款，第 12 次白方 [原始上游响应](../demo-output/gomoku-live-20261004-root/ply-12/response.json) 为 HTTP 503 空响应体，Relay 保留 `Paid`、对局 `Paused/UPSTREAM_FAILED`，没有自动重发。该历史局仍没有胜方；黑白各付 `60000`，关闭前各自现金 `440000`、收款方 `120000`、债务为零。随后新局使用新的本地链和输出目录独立开局，旧局记录保持不变。

## 规则和输出

固定规则 ID 为 `gomoku-freestyle-15-v1`：15×15，黑先、双方交替落一子，坐标为 0..14 的整数，横/竖/两斜向连续五子或更多即胜，无禁手。只有 225 个合法落子且没有胜方才产生 `draw`。模型只提供严格 JSON `{"row":7,"col":3}`，裁判不接受模型声称的胜负，也不给它付款或结算工具。

完整、已付的模型回答如果 JSON 非法、越界、重复落子、包含额外字段，或以截断/工具返回结束，该方判 `forfeit`。网络、RPC、Relay 超时和付费调用结果未知属于基础设施问题，产生 `Paused`，不伪造败方。预算耗尽、现金不足、最大步数和截止时间产生 `Stopped`，没有胜方，也不改写为棋盘平局。

请求限制每步 `max_completion_tokens` 为配置值（1..1024）；模型输入只包含有界的 15×15 棋盘与最多 225 步历史。这是每步输出 token 上限，实际费用由每步绑定报价控制，不宣称有 vendor 侧总 token 扣费器。双方 `maxTotalPrice` 和 `maxPricePerMove` 独立，收到报价时先保守预留该笔费用，持久化之后才付款；不确定/已退/尚未付报价不自动释放此预留。`reservedPrice` 表示费用承诺上限，不替代链上实际扣费。

## 运行已有 Relay 对局

```bash
npx tsx scripts/gomoku.ts --config /private/match.json --output /private/match-session \
  --black-key-file /private/black.key --white-key-file /private/white.key \
  --timeout-ms 10000
```

两份私钥文件只保存各自钱包私钥，必须归当前用户且无 group/world 访问权限。它们不进入配置、prompt、棋谱或报告。公开配置可参考 demo 的 `match-config.json`；双方分别指定 `agentId`、`wallet`、`rpcUrl`、`chainId`、`account`、`asset`、收款 `provider`、`relayUrl`、`service`、逻辑 `model`、显式 `cheap/strong` 档、独立费用上限和输出 token 上限。两边钱包和账本身份必须不同。vendor key 留在已有 Relay 或 Magpie 薄桥。本 CLI 无自动凭据发现。

`matchId`、规则、双方身份、费用与绝对 `deadlineMs` 全部绑定本次 session，恢复时必须使用原配置。可选 `thinking:{"type":"disabled"}`、`reasoning_effort:"low"` 原样进入请求，便于已有 Kimi 路由控制输出。真实 Kimi 的当前验收包括前述白方 `forfeit` 胜的完整终局与首局 503 暂停记录；真实五连胜和经 Magpie 的五子棋对局尚未验收。接入已有服务时仍需运营方准备双方现金和自己的 Relay。

`--stop-after-plies 3` 在 3 个已裁定步之后保存并暂停；去掉该参数，再用相同配置/目录即可继续。底层复用现有 `SessionStore` 的单写者锁、fsync 和原子替换。进程硬中断留下的锁必须显式 `--recover-lock true`，只允许接管已不存在的原进程；活跃写者仍拒绝接管。

## 恢复与失败边界

每步先保存请求与 dispatch intent；SDK 的 `onHandle` 在付款前保存报价、费用预留和原签名交易。恢复只对同一 `paymentId`、Agent 和请求摘要查询 Relay 状态：

- `Delivered`：校验绑定的缓存响应和付款，直接裁定，不再发模型请求。
- `Quoted`：Relay 从链上证明仍未付；SDK 可继续原 handle，必要时只重播完全相同的签名交易，不能换 payment。
- `Paid`、`Processing`、状态未知或查询失败：暂停，保留原 handle，不调用 SDK 的付费推理恢复路径。
- `Refunded`：停止本局，保存原记录；不自动另买一次回答。

模型回答已持久保存但落子前崩溃时，恢复从回答继续独立裁定；最终棋谱重放重新计算每步合法性、四方向胜负、棋盘 hash、预算与 receipt，不信任保存的胜方摘要。测试还覆盖四方向、七连、满盘平局、轮次/整数/边界、预算/步数/截止、非法模型声明、实际上游超时、报价价帽拒绝、付款后丢响应、缓存恢复和响应保存后中断，及篡改 winner/棋盘/request/receipt/budget 的拒绝。

`--timeout-ms` 默认 10000，取值 1..60000，作用于 SDK HTTP、付款等待和恢复状态 HTTP；Relay 自己的 upstream timeout 由其现有配置决定。`deadlineMs` 在新请求、付款前及回答裁定前检查，超时后停止，不判模型输；它是主动检查的绝对截止时间，不是整个 RPC 进程的硬杀计时器。未知付费请求不得为了继续比赛重新发起新 payment。

本保证限定于这个单写者 runner 的恢复行为。生产 Relay 若配置多个候选，本身仍可能 fallback；外部 SDK/caller 手工重发 Paid 请求、链重组、替换 Relay 数据或在新目录启动同局不在本验收保证内。这里没有声称分布式 exactly-once，也没有增加通用 durable 模型账本。

## 真实 Kimi 对弈入口

`scripts/gomoku-live.ts` 复用同一 fixture 的双账户和实际 loopback HTTP，仅注入一个专用 Kimi responder，不复制裁判/付款框架。默认只校验已有私有配置并显示计划：

```bash
npx tsx scripts/gomoku-live.ts --config /absolute/private/demo.json
npx tsx scripts/gomoku-live.ts --config /absolute/private/demo.json --output /absolute/new-live-evidence --execute
```

私有配置沿用已有 `verify-live-tiers` 的 `{upstream:{name:"kimi",baseUrl:"https://api.moonshot.cn/v1",apiKeyFile:"/absolute/private/kimi.key"}}` 形态；配置和 key 文件均须当前用户所有且 0600，不输出 key 或 key 文件路径。execute 必须给新的绝对输出目录，拒绝覆盖或重新执行已有证据。

双方使用 `kimi-k2.6`、`thinking:{type:"disabled"}`、每步最多 256 个输出 token，最多 31 步、绝对期限 20 分钟。黑/白分别最多预留 `160000`/`150000` mock-USDC 最小单位，每步价帽 `10000`；费用独立，不计算共享奖金。依据 [Kimi 官方 Chat API](https://platform.kimi.com/docs/api/chat.md) 的思考开关和 `max_completion_tokens`，源码锁定这些参数。vendor 调用使用项目既有 request-local `systemHttpsProxy`/`proxyUpstreamFetch`，不改全局 proxy、无模型 HTTP 重试或候选 fallback。模型被要求只返回严格坐标，没有工具，不加入预置棋谱或强制胜方；实际回答仍由裁判验证。

每次实际 vendor dispatch 前，保存该步 paymentId、请求摘要和原请求；返回后保存 HTTP status、原始文本、解析 body/物理 model 和 usage。关闭原链前保存已签名 handle、逐步链 receipt、双方现金/nonce 和收款余额。`report.json` 明确区分 `controlled-upstream` 与 `real-kimi-system-https-proxy`。真实非法落子照常判 forfeit；费用/步数/期限照常停止；未知响应暂停。此脚本结束后关闭本地链，因此已有输出只供离线重放，不能以重新执行该入口恢复未知 paid vendor 调用。

实现阶段先运行受控注入测试，随后经授权执行真实 Kimi 对局并由 root 独立验收。当前真实完整终局为白方 `forfeit` 胜，原因是黑方第 13 次回答截断；完整横向五连胜仍来自受控演示，不能把两者混为真实 Kimi 五连胜。
