# Tempo 上游可靠性迁移：PR8 增量范围

本轮在 PR8 原付款与 Goal 恢复修复上追加 A/B/C 可靠性迁移。源固定 `13fc9747c877f075b424220716d81d24f431d53a`，选取 `ce1409d..8d70a68` 的相关代码，逐 hunk 适配；不是覆盖源项目全部更新。PR 继续保持 Draft，须人工审查，不自动合并或部署。

## 已迁入与 Tempo 适配

- Arena 在结算前持久保存独立 evaluation；重启可检查原 settlement intent、canonical receipt 和任务绑定，继续原 run、原签名及原交易，不重新运行已保存的独立测试，也不能编造缺失证据。并发保存按最新状态串行取快照。
- Pi 默认只查询已接受的 run，`recoverLock` 不授予新增 POST。可信宿主可通过 fixed/reward/workflow 的 `submissionRecovery` 明确许可一次原 payload 恢复；累计次数与 run/task/agent/chain/escrow/payload 摘要先持久化，保存失败、旧记录损坏、许可撤销或终态均不派发。原 deadline 和签名保持不变。Hosted 默认未启用这个 opt-in，本轮不新增实际付费恢复入口。
- 服务在零 Agent 时也返回已认证 owner；前端按 owner 恢复选中 Agent，cookie 失效、账户切换与迟到响应不能恢复旧身份。登录失败可显式切换已配置的 Tempo Moderato `42431`，之后仍需重新签名登录。未配置网络时提示手工添加，不虚构原生手续费币或自动添加链。
- 自动任务在首次规划前核实 canonical 可用目录。确认为空时停止，零规划费、零参赛，不记任务成功；读取失败则暂停。有任务但 cash 不足时，仍可使用已配置、受限的游戏补充资源。

保留 Tempo 链、Origin、PathUSD、gas/fee 处理，以及 PR8 的 typed control、已签名/Unknown 不重派、Delivered 缓存、原 prompt digest、Goal canonical 外部证据复验、退款游标与封存上限。没有修改合约、部署配置、业务 RPC、代理或模型默认出口。

## 离线验证与限制

本地验证仅使用 owned Anvil、Docker、loopback 合成响应和浏览器 API/wallet fixture，没有真实模型或公共 RPC。定向覆盖原 settlement 恢复及并发保存、默认零恢复 POST、持久单次许可、fixed/reward 实际 workflow 接线、无任务零付费、账户隔离、显式 Tempo 切换和 PR8 关键付款/Goal/奖励回归；类型检查和 fixture 前端构建通过。浏览器测试另以桌面与移动 viewport 验证相关行为，测试中的合成账户与交易不是线上验收证据。

新增 Node 产品测试由现有 workspace glob 收集；完整 GitHub Offline checks 仍须在更新 PR8 后通过。现有默认 Playwright 配置排除了 hosted 大套件，本轮针对性浏览器验证不冒称默认 CI 已运行这些用例。

本轮不迁入经济准入/核算报表、独立 Worker、SDK 发布打包或营销历史，不引入历史 live 授权脚本、钱包、私密凭据或运行 journal。真实付费完整闭环、自然获奖和奖励恢复仍未全部验收，TLS 具体远端原因仍未知；本次不运行或恢复任何旧窗口，也不访问 VPS。
