# 2026-10-13 第二轮源项目同步独立验收

GPT-6.1 Sol ultra 执行迁移，root 独立审查实现、真实 Tempo 只读结果、实际账户页面和历史数据保全。此次连同前一轮已验收的同步一并提交 GitHub。源项目保持只读。

最终本地预览为 `http://127.0.0.1:3028/dashboard`，构建 ID `_i2pQhQ0K8qZ_hC-2MhB2`。root 已在这一构建上重跑真实账户验收；[文件摘要](evidence/tempo-upstream-sync-round2-20261013/root-artifact-hashes.json)记录截图、浏览器报告、保全报告及已清理的一次性验收脚本 SHA。

## 迁入结果

本轮新增有上限的链上资料读取、证据展示与下载、过期付款的 nonce 作废及恢复、Magpie 动画和相关提示改进。链上读取启用 Tempo 42431：最多两个目标，固定区块，保留证据摘要，重启沿用原证据。Tempo 手续费按收据中的费用资产及唯一 FeeManager 转账识别；缺少信息或存在歧义时保留未知状态。原生余额占位值不当作可花费余额。

过期报价本身不能证明付款取消。已签名付款只有在 nonce 和规范链上记录确认后才释放；作废交易先持久化再广播，恢复时只重播同一签名字节。独立审查补齐了每次重播前检查 Tempo 费用资产偏好的保护。此功能有 Anvil 和受控 Tempo 响应测试，本轮没有广播真实 Tempo 作废交易。

## 独立验证

- root 核对真实只读采集结果的摘要、PathUSD symbol/6 位精度、供应量与余额读取，以及原 Task7 交易和规范区块。实际费用为 210 个最小单位，即 0.00021 PathUSD，与 0.12 PathUSD 业务付款分开。另验证重复费用转账、缺少费用元数据时保持未知。[读取核查](evidence/tempo-upstream-sync-round2-20261013/root-lookup-audit.json)、[费用核查](evidence/tempo-upstream-sync-round2-20261013/root-fee-audit.json)。
- 首次实网只读采集的 token calls 不可用。root 在同一固定区块复核，发现 Tempo 的 100,000 gas 不足；改为有上限的 1,000,000 后真实读取通过。首次结果及中途网络失败日志保留，没有把不可用元数据当作成功证据。Sourcify 未验证的合约仍标记未验证，不虚构 ABI 解码。
- 实际本地 owner 的桌面 CashActor73 / Task7、手机 CreditsActor74 / Task8 历史均显示成功，PathUSD 与 Tempo 链接正确；Magpie 暂停控制正常，过期游戏授权仍禁止执行。浏览器业务写请求被拦截，本次没有尝试业务写入，没有脚本异常或水平溢出；截图已人工查看。[浏览器记录](../frontend/acceptance/tempo-upstream-sync-round2-20261013/root-browser.json)。
- 升级及浏览器验收后比对 128 个受保护文件、28 个历史证据和 6 个数据库业务分区：均未改变。6 个 Agent 空闲，27 个 run 全部终态，7 个服务端口及绑定不变，原固定授权未续期；网关接受模型请求仍为 13，新目标付款记录为零。[保全记录](evidence/tempo-upstream-sync-round2-20261013/root-preservation.json)。

执行器的类型检查、生产构建和相关回归日志由 root 核对。受控桌面/手机浏览器最终 14 项通过；旧 RPC 时间断言曾在并发负载下失败，隔离复验 4 项通过，未放宽断言，新增 storage 读取后相关队列测试也为 4 项通过。目标/专家组的首次 44 项中 2 项旧提示断言失败，更新过时预期后的专项 10 项通过；不将首次失败组记作全绿，不合计不同分组中的重复用例。完整清单见[第二轮迁移记录](tempo-upstream-sync-round2-20261013.md)及机器证据。

## 验收边界

确认本轮代码同步、本地运行兼容性及 Tempo 实网只读采集。新增目标的付费模型执行、Tempo 作废交易仍未做实网付费验收。原核心闭环与 GameFi 成功记录继续以原验收证据为准；本轮没有新增付费调用、业务链上交易、公开部署或比赛提交。
