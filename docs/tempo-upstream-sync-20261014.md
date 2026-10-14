# 2026-10-14 上游场景、聊天与文档迁移

本轮迁入持久化公共活动、猫咪场景与专家联动、聊天式目标结果、统一游戏/资金工作区，以及双语首页架构；同时修复规范付款确认后活动回调失败时的费用持久化。新代码通过受控测试和隔离浏览器验收，**尚未部署到 VPS**。

现有公网应用于 2026-10-13 部署在 `https://tempo.tabbyai.xyz`，使用 Tempo Moderato `42431` 和 6 位小数 PathUSD。VPS 是该状态的唯一 writer。本轮没有启动旧本机 runtime、模型网关或 `3028`，没有真实模型调用、Tempo 业务写入、充值、新授权或游戏，也没有变更 VPS。当前启动和恢复只按 [VPS 运维说明](../deploy/tempo-vps/README.md) 执行；[初次 Tempo 运行记录](tempo-runtime.md)保留历史本机命令，不能作为现时启动指引。

## 冻结范围和取舍

源项目只读，源 Git HEAD 固定为 `0526070240fedc48b9ce3587bc7bc284a3abb967`；目标基线为 `a59d0230c3d6a33058998da40566f04fe3261cb4`。主快照在 `2026-10-14T05:21:06.499811Z` 冻结 308 个增量，没有删除项；72 个功能、测试和开发预览项逐文件合并。冻结包含该时刻工作区文件，精确内容由各文件 SHA-256 和留存副本确定，不能仅凭源 HEAD 还原未提交内容。冻结时的源文件、共同基线和目标原文件用于三方对照；后续不追逐源工作区变化。

| 主快照分类 | 数量 | 本轮决策 |
| --- | ---: | --- |
| 功能、测试、预览及关联说明 | 72 | 迁入；冲突保留 Tempo 网络、资产、Origin、付款与恢复约束 |
| Logo/design 探索资产 | 123 | 不迁入；已选品牌资产保持原有状态 |
| 源前端历史截图与验收记录 | 104 | 不迁入，不冒充 Tempo 验收 |
| 源历史/设计文档 | 8 | 不覆盖目标历史文件；需要的功能事实写入本轮说明 |
| 根 README | 1 | 以补充冻结版本为参考，重写 Tempo 当前入口 |

验收期间源项目又产生文档和注释更新，单独在 `2026-10-14T06:14:17.159905Z` 冻结 24 项。这是一次明确的补充，不能与原 308 项相加当成独立文件总数：两组有重叠。20 项文档/metadata 选择性适配；4 个受保护源码注释更新未迁入，分别是 `CreditManager.sol`、`TaskEscrow.sol`、SDK `index.ts` 和 Underwriter `rules.ts`。补充源的 Monad 证据矩阵未复制为 Tempo 结果。

补充内容包含双语 README、架构/验证/来源索引、贡献指南、MIT LICENSE、八个模块 README 和前端指南。`package.json` 仅增加 `license` 与 `docs:check`，lock 只增加根包 license，没有依赖更新。SDK 主示例从部署 manifest 读取 chain ID；Relay 不再把 Monad `.env.example` 当作 Tempo 启动配置；Arena 指南按当前实现写明 Tempo 20M、其他链 2M 的结算 gas 上限。MissionChat 的 Beautiful UI 适配与 MIT 来源见 [第三方声明](../frontend/THIRD_PARTY_NOTICES.md)。

[机器清单](evidence/upstream-sync-20261014/migration-evidence.json)含全部 308 项分类、72 项功能决策、24 项补充采纳/排除理由、冻结 source 与最终 target 的文件 SHA-256，以及验证日志摘要。主快照原记录的冻结标识为 `fbf09df02d8f924e6bec3ffed2e120c5e6097a90f40e26d663d3265165a3f0a9`，补充为 `227449503767ecaf86751bedac64b004a17a9d9d592a3516f258a52a912f014b`；机器清单另列实际快照文件字节 SHA-256，区分冻结标识与文件摘要。目标摘要覆盖迁入代码、维护文档及本执行器的公开证据；root 验收文档和 `root-*` 证据由 root 单独维护。此处目标 Git SHA 是合并前基线，最终提交由 root 完成，不提前编造提交号。

## 实现和保留的约束

| 改动 | 行为与证据入口 |
| --- | --- |
| 公共活动 | [scene-types](../services/hosted-agents/src/scene-types.ts)拒绝未知字段；服务为每个 run 持久化递增 seq/time，最多 256 条。前端代理再次校验，不发布私钥、签名字节、原始 prompt 或内部 journal。 |
| 执行阶段 | 任务、Pi、自主规划、目标、游戏和结算在已发生的边界记录活动。现金、信用、奖励、token 用量与流程进度分开；无借款结算不声称发生还款。 |
| 猫咪与专家 | [场景投影](../frontend/lib/tabby-scenes.ts)和画布只消费公共事实。历史、Unknown、暂停、断线和 reduced motion 保持静态；无奖励对局不生成奖励成功。 |
| MissionChat 与输入栏 | [MissionChat](../frontend/components/hosted/mission-chat.tsx)保留完整回复、独立复核和按需展开的公共凭证。目标的完整输入、预算、模型与原 UUID 在不确定响应/刷新后保留；恢复和停止指向原请求。 |
| 工作区和首页 | 统一结果、资金及游戏展示，保留 Tempo PathUSD 和 explorer。双语架构在 1440/393/320px 可读；源 Monad 历史说明仍明确标注来源。 |
| 开发预览 | Dashboard 和场景 gallery 只生成合成数据/本地静态产物，不连接 Hosted 执行器；查链 subject 与展示单位适配 Tempo。 |

生产 Origin/可信代理校验、严格 owner/session 边界、费用与业务 Transfer 识别、同一区块核验、原支付 handle 和付款恢复保持原行为。没有更改合约或 SDK 源码、Tempo 部署配置、历史现金/奖励证据、过期 sponsorship 或私密运行快照。`contracts/README.md` 和 `packages/sdk/README.md` 是本轮有意更新的文档，不与源码保全混算。

### 规范付款后活动回调故障

故障注入首次命中了付款前的余额阶段；修正为确认事件同时具有 paymentId 与 txHash 后，复现了真正的问题：已付款 `10000` raw，活动回调抛错后暂停结果却显示确认费用 `0`。

[修复](../services/hosted-agents/src/goals/payment.ts)在 `confirmPaidDelivery` 成功之后、发布活动之前保存确认费用。费用来自规范交付核验，不能取未经核验的供应商回执。受控 Anvil 复验确认暂停记录为 `10000`，恢复沿用原 handle 和缓存响应；完整目标累计 `30000` raw，三次受控模型调用；终态重放不增加 nonce 或调用。[回归用例](../services/hosted-agents/test/goals-paid.test.ts)覆盖故障和正常付款两条路径。这是本地受控付款证据，不是新的 Tempo 付费目标验收。

## 验证结果与失败记录

| 分组 | 最终结果 | 模型/网络范围 |
| --- | --- | --- |
| 场景类型、投影、聊天、代理及活动服务 | 57/57 | 单元/受控输入，0 skipped |
| 任务、自主、游戏、目标及 Pi 执行器回归 | 60/60 | 受控执行器；不调用真实供应商，0 skipped |
| 规范付款活动故障及正常目标 | 2/2 | 新隔离 Anvil、合成角色、受控 Provider，0 skipped |
| `typecheck:all` | 通过 | Node 22.23.2；覆盖服务及前端 |
| Next 生产构建 | 通过 | 构建 ID `duF5DWw9IpOgI5QSwXere`；fixture 模式 |
| Dashboard/场景 gallery 静态构建 | 通过 | `--build-only`；无后端/模型/链连接 |
| 场景/对话/首页定向浏览器 | 20/20 | 桌面/手机，0 skipped、0 flaky；所有 API 合成拦截 |
| 首页配置端口复验 | 2/2 | 从 Playwright baseURL 派生 origin；包含在上面用例范围内，不重复计数 |
| `docs:check` 与本轮说明链接 | 通过 | 维护 guide 的本地文件/anchor；不抓取外部 URL |
| `git diff --check` | 通过 | 本轮工作树格式检查 |

分组可能重叠，不相加为独立用例总数。浏览器覆盖专家联动、Unknown/暂停/历史静止、复制与 Tempo 付款链接、reduced motion、完整原文 Enter 提交、原 UUID 恢复/停止和双语窄屏。`3038` 使用独立 fixture 前端，Hosted 上游是不可用的 `http://127.0.0.1:1`；不会接触生产钱包或状态。[公开浏览器摘要](../frontend/acceptance/tempo-upstream-sync-20261014/controlled-browser-summary.json)记录最终 20 项及两项配置端口复验；[320px 英文架构截图](../frontend/acceptance/tempo-upstream-sync-20261014/landing-en-320.png)来自后一组合成测试。

未删除失败过程：首次类型检查和生产构建发现游戏列表 `activeMatches` 变量遗漏，修正后通过；加入浏览器 fixture 后又发现 `output='markdown'` 不符合 `text|json` 契约，改为 `text` 后完整类型检查通过。浏览器首轮 15 通过/3 失败，修正凭证链接选择器、页面滚动和历史来源排除范围后，定向复验 5 通过/1 失败；最终修正后全组 20 通过。原失败属于测试选择器/范围，未因此隐藏历史来源。发现测试硬编码临时端口后改为读取 baseURL，仅复跑受影响两项。场景 gallery 首次监听 `3032` 遇端口占用，随后只构建静态产物，不抢占服务。上述日志及最终日志的 SHA-256 均保存在机器清单；原日志留在 ignored 私密工作目录，公开证据只包含必要摘要和合成截图。

## 独立验收与既有 Tempo 证据

root 的[独立验收](tempo-upstream-sync-root-acceptance-20261014.md)检查旧本机公共历史投影、Task7/Task8 桌面/手机显示、私密快照与受保护文件保全，并审查本轮冲突处理和付款故障修复。本轮截图只能证明合成显示，原 Task7/Task8 的真实奖励消费结论仍由[既有独立验收](tempo-gamefi-extra-root-acceptance-20261013.md)和历史链上证据支持。

[核心 Tempo 验收](tempo-root-acceptance-20261012.md)、[奖励路径](tempo-gamefi-extra-root-acceptance-20261013.md)、[VPS 部署事实](tempo-vps-deployment-20261013.md)和[上轮查链/恢复迁移](tempo-upstream-sync-round2-20261013.md)各保留自己的日期、网络、模型、资金和失败范围。新场景、聊天和付款回调路径不套用这些旧实跑结论；一般入口见 [验证索引](VERIFICATION.md)。
