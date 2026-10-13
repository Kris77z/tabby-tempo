# Tempo 迁移验收（2026-10-12）

本页记录本独立项目新运行，使用本机 Next/Hosted 服务、Tempo Moderato `42431`、6 decimals 测试 PathUSD、现有 ERC-8004 注册表、真实 Magpie → Kimi K2.6/K3 与独立 Docker Arena。Monad 和本地 Anvil 的历史结果不替代本页证据。当前仍在完成自主连续运行与真实财务/浏览器收尾，不将部署成功概括为全部验收通过。

## 已完成的新链事实

四合约已实际部署、互相连接并配置独立角色与白名单 Provider。普通 EIP-1559 type 2 交易在 Tempo 使用 PathUSD 手续费；CreditManager 部署实际 gas `18275445`，TaskEscrow `12849622`，因此原 Monad 写入 gas 上限不能沿用。池子初始入账 `10000000` raw，八个 Open 任务各托管 `150000` raw。

| 合约 | 地址 |
| --- | --- |
| CreditManager | `0xc1fBC944b6921C01195Ab5d1c9B73309A4c7554C` |
| AgentAccount | `0x1B3E3f54347C5E84C7cA2E2759636e31950D9b9B` |
| TaskEscrow | `0x665aea43F238F646d6FD712b465e38026ae59e06` |
| ERC8004Adapter | `0xeE5e8fe877AA2E4255dF5fcd346B7E3979dB3C2e` |

本次角色钱包全新生成，托管 Agent 的链上身份是 `46`、`47`、`48`。开户及现金 `40000` / `40000` / `50000` 都经过真实 Next/Hosted API。测试网水龙头为钱包另行提供手续费测试资金；产品没有自动 gas 赞助。网关 binary/provenance 已复制校验到本项目私有目录，供应商 key 单独复制到新配置；没有恢复任何旧链钱包、交易或运行 journal。

## 真实任务结果

| 路径 | 当前结果 |
| --- | --- |
| K2.6，Agent46 / Task1 | HTTP200，234 tokens；现金40000+信用80000购买120000额度包；Arena通过；偿还92000（本金80000+fee12000），cash58000。首次只读预检SERVER_ERROR保留，原UUID恢复没有额外模型调用。 |
| K3，Agent47 / Task2 | HTTP200，426 tokens；相同额度包、信用与还款；Arena通过，cash58000。真实财务已核验：债务0、score570/C、还款和信誉成功各1。 |
| Agent48 自主父请求 | 原20分钟窗口财务观察不可用，0 steps/0收费，按原截止自然终止。新窗口真实K2.6规划849 tokens后购买Task3额度包；首个求解请求只发一次，5秒后502/UPSTREAM_DISPATCH_UNKNOWN，无供应商响应文件或可恢复缓存。规划10000+包120000保持记录，正在执行已有封存、运营补偿、独立任务终止流程；未知供应商成本不能视为零或成功。 |

Task1 结算：[交易](https://explore.testnet.tempo.xyz/tx/0xba74d0e4fe14748485a036d3dc8f3ed35463087b9225c3ad1326ddb00d12f313)。Task2 结算：[交易](https://explore.testnet.tempo.xyz/tx/0xfa76a0e26f7e60be9bdb2450ccaa98cd3e24bfbe6d5e48460a7e42c0afc06bfc)。最终主 Agent 将从 canonical 回执、`NewFeedback` / `getSummary`、现金、池子和完整债务账本独立复核，不能只用 settlement status1 推断信誉已写入。

额度包价是运营方设定的固定报价，不是供应商实际账单。包内按模型输入/输出微额度费率扣额，原始供应商 usage 单独记录；不将 raw tokens、微额度和 PathUSD 混为同一单位。

## 已发现并处理的读取问题

公共 RPC 出现 HTTP429；原 `/advanced` 嵌套并行读取及可见页面每20秒轮询会加重负载。新增同 endpoint 进程内 4 并发/100ms发起间隔/64项有限队列，写 RPC不受读取队列阻塞；前端全局8并发、可控起速和同 dashboard在途合并。页面现在流式显示读取状态，失败保留真实网络/合约清单，不再把“暂时读不到”显示为未配置或零余额/零债务。

强模型开户曾因TIMEOUT暂停，原请求恢复成功；修前金融2.87秒止于 Underwriter HTTP503，后续完整账本读取尚未启动。修后独立 Underwriter probe10.27秒成功。Task2结算后的完整finance实际34秒成功；Task1一次完整finance仍在45秒截止，原失败保留，最终需得到真实confirmed快照和桌面/手机验收。

Stage probe只读，区分 Underwriter HTTP、快照、账户/绑定、完整任务债务扫描及最终canonical核对。不会为通过验收删同区块绑定、减少债务扫描或放松未知结果保护。

## 本地验证与证据

全量离线 Foundry执行项通过，原设计skip保留；新增Tempo高gas信誉回调及耗尽回调不回滚还款测试通过。部署配置定向回归通过。RPC回归12项、Hosted服务/规划回归29项、本地task-runner/backend/allowance16项、跨链数据库和签名journal负测、全项目类型检查均通过；部分批次有重叠，不相加宣称总测试数。

前端相关unit5项、Tempo合成浏览器6项、landing15项及后续真实Anvil账本/transport定向14项通过，独立生产构建成功。这些合成/受控前端测试不等于真实Tempo浏览器结果；最终实际桌面/手机验收另记录。

当前公开的本地脱敏证据：[部署与资金准备](evidence/tempo-20261012/deployment-evidence.json)、[修前财务失败](evidence/tempo-20261012/strong-finance-before-fix.json)、[修后 Underwriter probe](evidence/tempo-20261012/strong-underwriter-after-pacing.json)。完整运行、原UUID恢复、独立Magpie构建和边界见 [运行说明](tempo-runtime.md)。

本机预览 `http://127.0.0.1:3028`，Hosted `8794`，Magpie `3436` / bridge `3437`。公开托管、扩展钱包、比赛正式提交、主网资金和Tempo游戏正向实网验证不属于当前结论。
