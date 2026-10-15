# 2026-10-15 上游恢复、模型降档与可选协作迁移

本轮选择性迁入 Docker 私密 umask 下的执行修复、SDK 重定向拒绝、预算约束下的模型降档、原付款恢复，以及可选外部专家和自主游戏代码。新增路径只使用独立 Anvil、合成角色、受控 HTTP 模型和浏览器 fixture 验证；没有公网链业务、真实模型调用、资金操作或 VPS 变更。

本文记录提交前的验收快照，不宣称本轮代码已生产发布。当前部署结果以 [main 的 Actions](https://github.com/Kris77z/tabby-tempo/actions/workflows/tempo-ci.yml) 和受限部署回执为准。2026-10-14 的 [PR #1](https://github.com/Kris77z/tabby-tempo/pull/1)、[Actions 38544850009](https://github.com/Kris77z/tabby-tempo/actions/runs/38544850009) 已完成首次自动发布；该历史版本为 `40647f0dc9f966bbbe98bf3e474cfbe612c0ffa8`。普通更新继续走 PR → Offline checks → main CI → production，不手动发布或更新可信引擎。

## 冻结与分类

源 `/Users/jungle/Desktop/dev/agentfuel` 全程只读。冻结干净 commit `ce1409d0db0f210fb3804c9ec52807b499b8f1b9`，1248 个跟踪文件，94,444,181 内容字节。完整 Git archive SHA-256 为 `1b30045796bd0d822d2aa101217204dd6116bf6757cae6ec03548ae4e7df06c1`；快照文件 SHA-256 为 `4e904597f7aad400fffb2fa688ed9eb28b7baa2503998f7538b0bcd390a2cb78`。之后的源改动不在本次范围。

共同上游基线使用源 `0526070240fedc48b9ce3587bc7bc284a3abb967`，逐文件叠加[上一轮机器清单](evidence/upstream-sync-20261014/migration-evidence.json)对应的 308 项主冻结和 24 项文档补充冻结；不能只做两个 Git HEAD 的差。对这个有效基线，新源有 124 个差异（61 新增、63 修改、0 删除），此前已迁的文档不再次计为新功能。

| 初始分类 | 文件数 | 处理 |
| --- | ---: | --- |
| 功能、测试、工具与 metadata | 59 | 50 适配迁入、2 已有覆盖、2 排除、5 延后；精确决策见机器清单 |
| 文档 | 20 | 更新产品、架构、验证和 Hosted 入口；历史工程设计与 Monad 实跑记录不覆盖 |
| Monad 运维与实跑脚本 | 22 | 不迁入 |
| 源截图、验收 JSON 与设计预览 | 21 | 不迁入，不作为 Tempo 结果 |
| 源 AGENTS | 1 | 不导入源项目指令 |
| 已在 Tempo 的 Linux Magpie helper | 1 | 原 hash 保持 |

[机器迁移清单](evidence/upstream-sync-20261015/migration-evidence.json)列出全部差异、source/base/target-before/final hash、采纳理由、目标内容集合摘要、测试与失败日志摘要。目标 Git SHA 先记录已知基线，最终提交由独立验收线程处理，不预造 commit。私密冻结副本和原日志保留在 ignored `.data/upstream-sync-20261015/`。

## 迁入行为与保留边界

- Docker 的唯一只读 submission 显式设为 `0444`，避免 systemd `0077` umask 导致非 root sandbox 无法读取；在可信开始 marker 之前先读取 staging，基础设施失败不冒充候选代码失败。
- SDK quote、status、paid HTTP 统一 `redirect: error`。307 不会把 prompt 或付款请求带到另一个服务；原 handle 保留，不换服务重付。
- Goal 新调用把 route、后续保留额与 paid handle 分次持久化；仅在尚无 handle 时从冻结批准模型中选更便宜的 route。现金必须同时覆盖本次价格和后续/独立复核保留额；没有可负担 route 时在 quote 前暂停。已签名、已付款或 Unknown 调用仍用原 handle/provider/model，不靠降档重派。
- Metered/Pi 新轮次按剩余预算选择批准的低价模型，记录实际 tier、请求和 fallback 来源；原 allowance、旧响应和 Unknown 冻结继续恢复原记录。
- 可选外部专家固定绑定 operator allowlist、注册身份、模型、价格、assignment/prompt digest 与规范付款凭证。host/provider 的链域 prompt 一致，公开卡片只展示身份、价格和实际信誉样本；无评分显示“未评级”。畸形 metadata URL 返回 400，服务继续可用。
- 可选自主 games 通过既有游戏执行器、owner/global admission 和预算/次数/时限边界获取现金或绑定 Agent 的奖励 tokens。旧自主 journal 没有 games/fundingNeed 时保留原配置和 cash 补给；明确 reward child 不被 UI 当现金入账。

外部专家和自动 games **生产默认未启用**。当前 Tempo runtime 未增加 `externalProvider`、`goals.external`、`autonomy.games` 或端口，也未改变 hosted config、赞助、Origin 或旧任务模板。源 provider 准备器包含 Monad 身份和 whitelist 写入，standalone launcher 启动会 recover 付款/退款；两者均延后，不提供一个貌似 Tempo-ready 的入口。保留的 external stack 供 owned fixture 或以后单独批准的配置使用，Tempo 分支要求原退款 fee cap、10m gas 和同钱包串行器。

生产使用 Tempo Moderato `42431`、6 位 PathUSD、固定物理路径与 VPS 唯一 writer。既有 transport/pacing、frontend 1m read cap、gas/fee、规范付款与退款/结算行为、`--recover`、过期 sponsorship、CI/CD 受限入口保持不变。没有修改 `contracts/src` 或四个 root-owned 可信部署文件。源 Monad 状态、密钥、journal、provider 身份与证据均未导入。

### Policy 未确认时停止的修复

复现：保存 `setPolicy` 签名字节并广播后丢失确认响应；随后取消旧 run。原判断仅凭没有 SDK handle 就写 `unpaid=true`，executor 可能把未知链写变成 terminal，使原部署 guard 误判静止。旧 `state.policy` 与新 `call.policy` 都受影响。

修复验证原签名字节、hash、sender、chain、account、agent 和 calldata；恢复/取消只按原 hash 读取规范 receipt/block。未知、伪回执或 reorg 保持 `started=true/unpaid=false`、Paused、terminal=false，已安装 guard 拒绝发布。仅当前新签名的首次执行可广播；既有 policy 不重播、不替 nonce。规范 success/revert 后才可安全取消。policy 未确认时也不能被另一个 handle 的 void 结果覆盖为终态。

此前已验收的 SDK 过期未付款 handle void 机制继续保留，只有规范 void/refund 后才可结束；这与新增 policy 只读恢复是两条不同边界。原 paid/delivered/refunded 记录不清空、不恢复冷备业务数据。

### 明确延后的模板截止时间变更

源新增模板 helper 会取 `max(journal.templateDeadlineMs, task.deadlineMs)`。对保留的本地私密快照做纯数值演算，旧值 `1791897508421`，八个 task 为 `1792069908000`，会改变生成配置；该演算不当作当前 VPS 实时状态。普通发布不能重写受保护历史 config，本轮保留 Tempo runtime 和其测试原 hash，延期到独立受控迁移。

## 验证与失败过程

当前验证摘要和日志 SHA-256 以机器清单为准，各组可能重叠，不相加宣传独立用例总数。

| 分组 | 结果与范围 |
| --- | --- |
| Frontend 完整单元 | 86/86；另新增 public projection 定向 15/15，含已有用例重叠 |
| Pi autonomy/provider | 73/73；受控输入 |
| Arena 完整组 | 105 pass、1 fail、1 skip；唯一旧 startup 600ms 测试随后独跑 1/1 通过，未放宽时限 |
| Hosted 完整组 | 234 项中 233 pass、1 旧现金 fixture fail、0 skip；修正 fixture 后原失败定向 1/1 通过 |
| Policy 恢复与组合门禁 | 最终文件 22/22；包括未知 policy 与可 void expired handle 同时存在，原 guard 拒绝 |
| 串行脚本组 | 25 pass、1 Linux-only skip；Ubuntu CI 显式安装 bubblewrap/socat 后执行真实 namespace 用例 |
| Browser | 6/6，desktop/mobile；旧 cash/reward 补给与外部 identity/PathUSD/未评级卡片 |
| SDK redirect | 1/1，真实 loopback HTTP 307；target 零请求、handle 零保存、零广播 |
| Workflow boundary/candidate | 17/17；串行离线脚本集合增加 external-stack 与 linux-magpie，deploy job 不变 |
| 构建 | Next 生产构建成功，fixture BUILD `O-Ma7nFcMEsRbP_mDRH6_`，Hosted 上游为不可用 loopback |
| 类型、文档、格式 | `typecheck:all`、`docs:check`、`git diff --check` 通过 |

失败过程保留：首次类型检查遇三方测试拼接的闭合括号错误；去除已在 Tempo 覆盖的源 TLS 重复用例后通过。SDK 新测试最初未处理 ethers JSON-RPC batch，mock 抛错并挂起；停止本次自有进程、修 mock 后通过。浏览器首轮 6 项在读取 harness 不存在的 errors 字段时失败，界面断言已过；改为真实 pageerror 收集后 6/6 通过。新链域测试最初用无历史链条款的 writer 角色，改用 gas specialist 验证实际跨链 prompt 差异后通过。Arena 的一次 600ms 超时与构建并行发生，负载影响只能作为推测；独跑成功是已确认事实。Hosted 的唯一旧用例在首个 30000 目标后只剩 10000 cash，不满足新目标的后续复核保留额；把两个目标的初始 cash 设为 60000，并新构造使用该配置的执行器、断言实际初始 cash 后，原 Unknown/退款/nonce/replay 断言通过。中间一次只改配置对象未替换已 clone 的执行器，仍失败，也保留日志。

Arena 的 skip 是既有需显式 live URL 的 Free Arena HTTP 用例；Linux namespace 用例因本机是 macOS 而跳过，不能声称本机完成 Linux 实测。CI 保持该项在 Linux 执行，不以 skip 或裸宿主进程替代隔离。

所有浏览器 API 都被合成拦截，没有钱包 RPC 或写命令。两张[合成身份卡截图](../frontend/acceptance/tempo-upstream-sync-20261015/README.md)仅证明显示，不是已支付、注册、评分或 Tempo 新实跑证据。既有真实结果仍以[核心验收](tempo-root-acceptance-20261012.md)、[奖励验收](tempo-gamefi-extra-root-acceptance-20261013.md)和[验证索引](VERIFICATION.md)为准。
