# 2026-10-13 源项目同步到 Tempo

本轮同步代码和本地界面；没有新增 Tempo 业务交易、领取测试资产或付费模型请求。原核心任务、补偿、GameFi 奖励消费及其证据保持历史状态。个人目标与五类专家的付款验收使用受控 Anvil，不将其记为新的 Tempo 实网验收。

## 冻结与选择

源 Git HEAD 为 `922f65dc9c20ab404946ce37e49e95484b515f75`，目标开始于 `4846960a9f1dcfe389a459d86913cc8c7f7b8c73`。将 source HEAD、source 工作树和 target 工作树逐文件比较，冻结 146 个变动文件，其中 22 个双方变动、124 个源变动；快照捕获期间这些文件内容稳定。冻结清单 SHA-256 为 `69c075a158bf40f77fae668cbe7e5fe7cb22b4bbfc4c6509b63de9620ccb39d7`。私有快照及三方基线保存在 `.data/upstream-sync-20261013/implementation/`，公开文件决策与哈希见 [迁移证据](evidence/upstream-sync-20261013/migration-evidence.json)。

源目录随后继续开发，本轮仍以冻结版本为准。仅额外冻结 token-scan normalizer 与独立复核 output contract 两处无查链依赖的小修补，允许资料缺失时 `riskScore:null`、`riskLevel:unknown`、三个 tokenomics flags 为 `unknown`，避免缺失资料被迫写成 `false`。原 monad-rebel 提示词及 provenance SHA 不改；有效运行提示词覆盖旧 Monad 网络、gas 及收益默认假设，Tempo 当前网络与费用只能依据提供的资料。专家能力是输入资料的模型分析，没有 RPC、Web、shell 或交易工具。

| 处理 | 范围与理由 |
| --- | --- |
| 迁入 | 新 Dashboard 三栏工作空间、内联游戏和资金、身份/交易凭证、目标历史、草稿与通知、Tabby 现有资产和导航。 |
| 迁入 | 只填名称创建 Agent，默认零预算、关闭授信；首次执行前另行配置模型、预算和权限。保持旧完整参数创建 API 兼容。 |
| 迁入并适配 | 个人 goal 的持久计划、阶段产出、单独模型复核、一次修订和再次复核；八个执行类型含五个 specialist，实际由同一所属 Agent 付款。 |
| 保留目标 | Tempo 42431、PathUSD 六位小数及手续费、RPC 队列与有界只读重试、finance 120s / proxy 130s、普通 POST 10s、事件匹配、gameDeadline、原赞助准入与 UUID/Unknown 恢复。 |
| 保留目标 | 原 README Tempo 验收入口、历史业务数据、keys/journals、Task7/8 完成结果、所有独立验收；没有复制源运行目录或截图。 |
| 不迁 | 快照之后仍在开发的 chain-lookup / chain-evidence 自动地址与交易查链：源代码只支持 10143/31337，本轮没有 Tempo 适配或实网验收。 |
| 暂缓 | 冻结后 goal `voided` 付款恢复：源 payment/reconciliation 与 executor 新增已过报价期、原 nonce 在同一规范区块被消耗且付款账本为零时释放预留的分支；当前仅源 mock 回归，未验证完整原 UUID 生命周期、真实替换交易与 Tempo 签名/nonce，当前目标保持不确定付款预留的保守行为。 |
| 不迁 | `scripts/test/goal-live-acceptance.ts` 源环境专用付费驱动：硬编码源网关 3427，可能错误读取另一个项目计数；本轮用受控测试。 |
| 历史保留 | Monad/local CLI 与其测试仅属于历史或受控开发入口；新的 Tempo runtime 不导入或恢复它们的运行 journal。 |

## Runtime 与恢复

Tempo supervisor 新增 `goalCheap` / `goalStrong` 命名端口与独立 `goal-<logical-id>` relay 目录，保留原 `arena/underwriter/fixed/allowance/planner` 五个端口和 catalog 摘要。托管模型仍为 Kimi K2.6 / K3；goal 服务 `tabby/mission` 报价分别为 `10000` / `20000` raw PathUSD 每调用，供应商请求别名与真实响应模型分别校验。配置升级不改变旧任务价格、deadline、钱包、预算或付款 UUID。

个人 goal 每次调用绑定 `taskId=0`，仅从 cash 付款，不能借任务额度、不会产生任务报酬或成功/还款信誉。最多三阶段，加规划、复核、一次修订及再次复核最多七次调用；仍同时受 Agent 原预算与固定 deadline 约束，预算不足就暂停。停止请求先对账已经开始的付款；Unknown 保留原预留、handle 与 UUID，不能创建替代收费调用。未配置 goals 的 runtime 不显示可发送状态。

所有 Tempo relay 的同一个 refunder 钱包共用串行退款队列，原签名交易 journal、refundId 与规范回执校验保持不变。已有完整/Unknown 手局恢复不再次派发模型；取消、缓存结果与原 UUID 恢复语义按源成熟实现及 Tempo 原保护合并。

完整 supervisor 重启会重建 `hosted.json`。升级会在私有 runtime journal 保存已有 `testSponsorshipFile` 的原绝对路径、原字节 digest 与 grantId，并与 DB 原授权一致性核对，之后原样挂回配置。固定授权截止 `2026-10-13T07:28:04.166Z` 不延长、不重新 prepare，不重置四次 admission，也不执行剩余两局。UI 显示授权已到期、当前 owner 剩余零局；其他 owner 保持默认三局。

## 验证与可看入口

类型检查、受控支付、兼容恢复、退款、HTTP/task/autonomy、前端逻辑与桌面/手机浏览器结果见迁移证据。浏览器模型/链请求被受控 API 隔离，截图明确为 synthetic。实际 3028 升级仅检查已有身份和配置，不创建新 Agent 或 goal；原模型网关 `acceptedRequests=13` 应保持不变。

本地新版入口为 `http://127.0.0.1:3028/dashboard`、`/finance` 与 `/arena`。四种本地练习仍只使用虚拟筹码；真实托管奖励德州通过既有 API，过期本轮授权不可再用。源专家历史评分明确标注为历史样本，不能读作 Tempo 当前角色信誉。公网部署、主网、比赛正式提交不在本轮范围。

复现受控浏览器：先以独立构建设置 `NEXT_DIST_DIR=.next-upstream-sync-20261013-2 FRONTEND_MODE=fixture` 在 3038 启动 Next，再从仓库根目录运行 `node_modules/.bin/playwright test --config frontend/playwright.upstream.config.ts`。五组用例均拦截 API；没有 RPC 或供应商调用。初轮 harness 旧端口、菜单、名称创建期望，以及手机通知遮住连续操作按钮的失败日志保留；最终修复把手机通知移到输入区域上方，没有放宽金额、UUID、Unknown 或网络断言。

最终生产构建 `.next-upstream-sync-20261013-2` 的桌面/手机 98 项全部通过；frontend 逻辑 55 项，HTTP/task/autonomy 13 项，goal/specialist 受控支付 35 项，最终 specialist/schema 17 项，Tempo catalog/授权恢复 7 项，以及退款/补偿相关 13 项通过。分组有覆盖交集，不合计为不重复测试总数。`npm run typecheck:all` 和 Next 生产构建通过。原 six actors / 27 runs / four admissions 逐对象不变，五个旧端口保留；新端口 goalCheap63750 / goalStrong63908。最新3028 build ID `u0Auuv8spKQbm3C5YTRin`，实际 chain 模式，页面200、未登录 `/api/hosted/agents`401；真实网关计数升级前后均13。


### 冻结后付款恢复复查

源在本轮快照后还变更了付款恢复、验收测量、goal/research 类型、提示词、客户端投影与测试，并非所有漂移都属于自动查链。完整冻结文件的后续变动列表见机器证据 `finalPostSnapshotDrift`；这些变动没有整组跟随迁入，只有前述两处独立 token-schema 修补。

新 `voided` 逻辑的方向合理：仅报价过期不足以解除未知付款，必须验证原签名 raw/hash、sender、nonce、chain、account、provider、amount、paymentId，并在同一规范区块确认 nonce 已消耗且付款账本为零。源 mock 两项回归通过，覆盖 nonce 未消耗继续保留、已消耗可关闭、已付款不得关闭、区块变化和 sender 错配拒绝。但它还需要 executor 的错误分类和终态接线，不能仅复制 payment/reconciliation 两个文件；也尚未提供本目标的受控 Anvil 替换交易、原 UUID 终止/重启/停止与 Tempo 签名边界验证。当前目标没有实际个人 goal 未决付款，不构成本轮必搬的已发生故障修复，因此暂缓、保留现有不确定状态和预留，不改运行服务。后续若单独迁入应冻结该小补丁并补完整生命周期回归，不能顺带引入仍进行中的查链。

本文件记录第一轮冻结与暂缓决策。之后用户授权的第二轮已单独冻结、适配并受控验证自动查链和完整付款恢复，见[第二轮同步](tempo-upstream-sync-round2-20261013.md)；第一轮证据与独立验收保持原样。
