# 2026-10-13 源项目同步独立验收

本轮选择性同步验收通过。GPT-6.1 Sol ultra 执行迁移，root 独立检查实现、受控回归结果、实际本地账户界面和升级前后保全证据。新版已运行于 `http://127.0.0.1:3028/dashboard`，build ID 为 `u0Auuv8spKQbm3C5YTRin`。

## 迁入范围与边界

迁入新 Dashboard、只填名称创建 Agent 后再配置模型和预算、内联资金/游戏、身份及交易凭证、持久个人目标与五类专家。Tempo 42431、PathUSD、原任务价格、UUID/Unknown 恢复、固定游戏授权及原历史证据保留。逐文件选择与源快照 SHA 见[迁移记录](tempo-upstream-sync-20261013.md)和[文件清单](evidence/upstream-sync-20261013/migration-evidence.json)。

个人目标限定 taskId=0、cash-only，不生成任务报酬或信誉；专家分析输入资料，没有自动查链能力。新目标和专家付款流程通过受控 Anvil 验证，本轮没有执行真实 Tempo 付费目标，因此不将它们计为实网通过。源目录仍在继续开发，冻结后的未迁变更按迁移记录单独列明。

## 独立验证

- root 运行服务、赞助与目标对账回归：20 项通过，涵盖名称创建后的重启、目标 owner/text/UUID 绑定、取消/补充预算、授权到期/原子准入、规范回执与 Unknown 保留。
- 核查执行器最终构建及日志：类型检查、生产构建通过，同一最新 build 桌面/手机 98 项全部通过，无 skipped 或 flaky。其他受控支付、退款、HTTP 和恢复分组见迁移记录；分组存在交集，不合计为不重复用例数。
- root 在实际 3028 使用原测试 owner 登录，桌面检查 cash Actor73 的 Task7，手机检查 credits Actor74 的 Task8：原成功记录、PathUSD 和 Tempo 交易链接可见；目标草稿按 Agent 保存并在刷新后恢复；固定授权到期提示可见且新游戏按钮禁用。登录后拦截所有非 GET API 请求，实际没有业务写请求，浏览器没有脚本异常或水平溢出。四张截图已人工查看。[真实账户浏览器证据](evidence/tempo-upstream-sync-20261013/root-browser.json)。
- 升级后及真实浏览器检查后分别核对：128 个受保护文件、28 个历史证据文件、6 个 DB 业务分区不变；6 个 Agent 空闲，27 个 run 全部终态；旧五个端口和链绑定不变；原 grant 文件及 admission 镜像不变，追加使用仍为四局，固定截止不延长；新 goal 支付记录为零，网关模型计数前后均 13。[保全证据](evidence/tempo-upstream-sync-20261013/root-preservation.json)。
- 核对公开清单中的最终文件 SHA 和测试日志 SHA，全部匹配；`git diff --check` 通过。

首次 root 浏览器检查因同名“信息与凭证”按钮产生选择器歧义，限定到 Agent 面板后重跑通过，未因此修改产品。执行器早期失败及修复记录保留在本轮私有测试日志中。

本验收确认代码同步、受控执行和本地预览兼容性。原 Tempo 核心及 GameFi 实网结果仍由原验收记录支持；本轮未新增实网业务交易、付费模型调用、公开部署或比赛提交。
