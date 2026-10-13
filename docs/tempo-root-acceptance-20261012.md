# Tempo 迁移独立验收 · 2026-10-12

执行由 GPT-6.1 Sol（ultra）负责，主 Agent 独立复查代码、重跑关键测试，并重新读取公共 RPC、真实模型响应及 Docker Arena 证据。

**最终结论：Tempo 测试网核心闭环、财务、桌面/手机 Agent 页面及协议总览 SSR 均通过独立验收。** 本记录针对 Tempo 测试网及本机端到端运行，不代表生产或主网验收。

## 实际业务结果

Tempo Moderato `42431`，结算和实际手续费资产均为 PathUSD（6 decimals）。Identity / Reputation 注册表接口及配对已验证，不据此宣称其官方 canonical 身份。

| Agent | 实际成功任务 | 最终现金（PathUSD） | 债务 | 评分 / Tier |
| --- | --- | --- | --- | --- |
| 46 · Kimi K2.6 | Task 1 | 0.058 | 0 | 570 / C |
| 47 · Kimi K3 | Task 2 | 0.058 | 0 | 570 / C |
| 48 · 原自主运行 | Task 4 | 0.048 | 0 | 570 / C |
| 49 · 新自主验证 | Task 5、6 | 0.0672 | 0 | 640 / B |

5 个成功任务均完成托管报酬、信用购买真实模型推理、Pi 执行、独立 Docker Arena 验收、偿还本金费用和信誉更新。代码 SHA256、Arena evidence hash、结算事件及实际信誉反馈相互绑定。

Agent 49 的父请求 `434cb42a-4284-456d-aea1-9c27f16234e2` 在同一原定窗口完成两单，终态 `Succeeded/Completed/AUTONOMY_TASK_LIMIT`。主 Agent 在首单完成前保存初始配置，并核对最终配置未变：预算 `300000` raw，最多两单、三次决策，截止 `2026-10-12T17:15:18.721Z`。两单结算区块时间均早于原截止时间；净支出 `260000` raw，预留与债务均为 0。

## 独立链上与财务核验

主 Agent 在固定区块 `39297657` 重新读取全部 8 项任务、四个 Agent、余额、贷款与信誉，并校验回执和 canonical block hash。成功任务为 1、2、4、5、6；Task 3 补偿终止，Tasks 7、8 保持开放。

- 实际偿还本金 `392000` raw，实际支付贷款费用 `58800` raw。
- 信用池 `10058800` raw = 初始 `10000000` + 费用 `58800`。
- 账户代币余额与四 Agent 现金之和均为 `231200` raw；未偿本金和费用为 0，无违约。
- 现金核对：存入 `190000` + 任务收入 `750000` − 净推理采购 `650000` − 贷款费用 `58800` = `231200` raw。
- 剩余任务托管 `300000` raw，对应两项未执行任务。
- 原请求重放前后，四个 Agent 钱包和六个操作角色的 latest / pending nonce 均不变，模型请求数保持 12；主 Agent另行读取链上 nonce 并核对重放实现。

[最终链上审计](evidence/tempo-20261012/root-acceptance.json) · [真实模型与 Arena 审计](evidence/tempo-20261012/root-model-audit.json) · [执行器财务证据](evidence/tempo-20261012/financial-evidence.json)

四合约成功部署回执、链域、EIP-1559 交易和实际 PathUSD feeToken 已独立验证；初始资金与合约接线另见 [部署审计](evidence/tempo-20261012/root-deployment-audit.json)、[初始资金审计](evidence/tempo-20261012/root-bootstrap-audit.json)。

## 失败、补偿与资金来源

12 次实际模型调用中，10 次取得成功响应，2 次为 Unknown。主 Agent重算已保存响应的哈希并核对模型名称、usage 与调度记录；两次 Unknown 无可恢复响应，永久禁止原调用重新派发。未知供应商成本由 operator 承担，不能表述为零成本或计为成功。

Task 3 的 Unknown 已退款 `120000` raw，贷款 `ClosedByRefund`、本金费用归零；任务发布者取回 `150000` raw。该终止未增加还款、违约或成功信誉。独立核验见 [任务补偿审计](evidence/tempo-20261012/root-compensation-audit.json)。

原 Agent 48 的第二次规划 Unknown 已退回现金 `10000` raw，不减少债务、不生成信誉；见 [规划补偿审计](evidence/tempo-20261012/root-planner-compensation-audit.json)。随后新决策的第二子任务在建立 workflow 前超时，交易表为空、收费为 0。原父窗口保留 `Failed/Stopped/NO_FEASIBLE_CANDIDATE`，只完成 1 单；原 Agent 累计净支出 `150000` raw、预算仍为 `300000` raw。另一次零收费过期窗口也保留。新 Agent 49 的成功不改写这些失败历史。

Agent 49 的水龙头调用仅记录意图、未返回哈希，仍为 Unknown，不自动重发。两次独立余额读取均为 0 后，执行器从独立 Tempo 测试钱包一次性转入 `1000000` raw；原转账回执、canonical block、发送方、接收方、资产和金额已由主 Agent 核验。仅 `50000` raw 存入账户现金，消费预算未增加；补资不计业务收入。恢复以原回执及 Transfer 事件证明到账，当前余额只作观察，避免正常支出后重复补资。

## 页面与测试

桌面 `1440×1000` 和 Pixel 5 的四 Agent 页面均通过真实 HTTP 验收：现金、债务、评分、任务历史、Tempo 浏览器链接一致，无页面异常或横向溢出；手机资源面板可滚动。主 Agent另行查看桌面与手机截图，确认旧自主失败和新自主两单成功分别展示。浏览器阶段没有发起业务操作或新增模型调用。

`/advanced` SSR 首次失败于日志扫描 HTTP 429，原报告保留。修复仅涉及服务端读取：Tempo 日志逐页读取，保留完整 2000-block 最近窗口与 100-block 分页；复用共享四并发/100ms 队列；仅显式启用的单笔只读 RPC 可对 429 最多重试三次，Retry-After 等待最多 5 秒，仍受原请求 30 秒截止约束。写请求、批量请求及模型调用不进入该重试。

主 Agent在新构建 `.next-tempo-advanced` 的 3028 实例上独立定向复验通过：HTTP 200，完整 SSR 用时 68.661 秒，显示 CHAIN SNAPSHOT 与 PathUSD，无 READ UNAVAILABLE 或 FIXTURE；模型计数前后保持 12。该页面读取仍较慢，应保留加载状态。桌面/手机证据来自此前 `.next-tempo-budget` 构建；服务端传输修复后只对受影响的 SSR 做定向复验，没有重跑付费业务。

[浏览器验收汇总](../frontend/acceptance/tempo-hosted-20261012/root-browser-acceptance.json) · [桌面/手机原始报告（保留首次 SSR 失败）](../frontend/acceptance/tempo-hosted-20261012/final-report.json) · [主 Agent SSR 复验](../frontend/acceptance/tempo-hosted-20261012/root-advanced-recheck.json)

浏览器采用 Node 中真实 owner `personal_sign` 和真实登录接口，浏览器注入钱包接口；无 API mock，也未把私钥注入页面。这不是浏览器扩展钱包兼容性验收。

主 Agent 已独立执行相称的验证：全量 Solidity 回归无失败（保留原有跳过项）；Tempo 部署资产检查通过；高 storage gas 信誉反馈与耗尽 gas 回调 2 项通过；RPC / 托管链域 4 项、前端网络 2 项、跨链 journal 与原签名字节恢复 2 项通过；共享读取队列最终 4 项及修改后的读重试/写单次测试通过；补偿与任务终止集成 6 项通过。根项目与前端 `typecheck:all` 通过，最后补资恢复边界修改后再次独立执行根项目 typecheck 通过。最后 SSR 修复后，主 Agent再次独立执行 429 边界测试 2 项、共享队列 4 项及 typecheck:all，均通过。执行器完成相关传输回归共 14 项和隔离前端构建，并在此前完成前端单测及补偿/自主运行定向回归。

公共 RPC 实际出现 429、503、TLS 断开和超时。业务使用有界共享读取队列与有限只读重试，写请求不自动重试；主 Agent最终审计通过机器既有 HTTPS 代理并限定只读重试次数，保留固定区块和 canonical hash 校验。这些措施不构成公共 RPC 永久可靠的保证。

## 范围与复现

本次使用测试网资金、本机 Next / Hosted / 模型网关与独立 Docker Arena。原 Monad 项目保持只读参考；配置、钱包、数据库和交易 journal 独立保存。历史 Monad / 本地文档不作为 Tempo 验收证据。

公开部署、主网资金、浏览器扩展钱包真实交互、Tempo GameFi 实网路径及比赛正式提交不在本次验收范围。启动与恢复步骤见 [Tempo 运行说明](tempo-runtime.md)。公开证据经私密值扫描，无私钥或认证密钥命中；签名原文不导出。
