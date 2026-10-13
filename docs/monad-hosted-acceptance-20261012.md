# 本地服务连接 Monad 测试网验收（2026-10-12）

本轮使用本机前后端、真实 Kimi K2.6/K3、Magpie 和 Monad testnet 10143，**核心闭环、独立链上审计和桌面/手机验收全部通过**。无需先托管网站。所有资金均为 6 位小数测试 USDC，产品没有 gas 赞助，验收脚本单独为测试钱包准备 gas。

## 实际业务结果

| 路径 | 结果 |
| --- | --- |
| 创建、链上开户、入金 | 新托管 Agent 2200、2201、2202 完成 canonical ERC-8004 开户与现金入账。 |
| K2.6 / K3 差异计价 | 两模型经同一个 Magpie 分别完成 Task 12、13；cash 40000 + 信用 80000 购买额度包 120000，独立 Arena 验收、还款 92000，各剩 cash 58000、债务 0、信誉 570/C。额度包报价、模型输入/输出微额度费率、供应商实际账单分别记录。 |
| 已交付额度包的 Unknown | Task 14 的推理 503 保留为 Unknown。运营方明确承担未知成本，永久封存原额度账本，全额补偿 120000；借款以 ClosedByRefund 关闭，独立终止器将 150000 托管报酬退给发布方。未计成功任务、还款或违约。 |
| 原请求缓存恢复 | 父请求 f9e2498c… 的已付规划响应含 JSON 代码块，修复后复用原响应、原付款与原截止，完成 Task 15。第二个规划选择停止，旧解析器因原因过长报错；原失败与 140000 支出完整保留，没有延长该窗口或重写成功数。 |
| 自主连续下一单 | 新父请求 f4a39eb2… 自主选择信用接单，依次完成 Task 16、17，独立验收和结算后达到两单上限停止。新父请求净支出 260000，包含两次规划及两份额度包。 |
| 最终自主 Agent | Agent 2202 累计成功/还款 3 次，违约 0，cash 72240（0.07224 测试 USDC），债务 0，信誉 710/A。失败 Task 14 仍出现在任务历史中。 |
| 原请求重放 | cheap、strong 和最终自主请求按原 UUID 重放；全部相关钱包 nonce 与网关调用数均未变化。 |
| 免费游戏 | 本轮 Agent 2200 完成一局真实德州并输掉，奖励 0。没有为证明收益预设赢家；本轮不新增“赢额度后完成任务”的正向实网结论，历史奖励验收仍保留原范围。 |

原始自主现金为 50000。排查过程中额外入账 10000、2000，分别对应真实转账与前端 deposit 请求；没有将补资当成任务收入。测试账户累计预算经真实前端 API 从 300000 调至 450000；调整时已用 150000，新父请求预留 300000，最终累计支出 410000。旧父请求预算和截止时间未修改。

## 未知调用如何收口

本次实现的是**运营方承担未知成本后的全额补偿与终止**，不是证明供应商未收费。原 Unknown、请求摘要、额度交付收据、运营决议、退款与终止凭证全部保留。

1. 核验原任务、钱包、付款和账本摘要；要求当前账本只有原付款的一笔 grant、存在 Unknown 且没有已完成结果或在途调用。
2. 永久封存额度，禁止再领取、调用、消费或返回推理结果。原 Unknown 记录不改为“未调用”。
3. Relay 验证固定托管目录中的真实封存记录及原链上付款，只接受原付款全额退款；同一决议/退款 ID 幂等，不能重新交付。
4. 独立终止进程核验 canonical 退款、ClosedByRefund 和任务绑定后调用终止结算，退还发布方报酬。它不伪造隐藏测试结果。
5. 原自主请求核对这些已确认事实，终止并释放活动锁，允许之后的新任务。

混合已完成推理、多个 grant 或仍在途的账本不会套用本次全额补偿规则。没有供应商对账证据时不自动重发、不自动退款。运维入口：

```sh
node --import tsx scripts/monad-allowance-resolution.ts RUNTIME PAYMENT_ID inspect
node --import tsx scripts/monad-allowance-resolution.ts RUNTIME PAYMENT_ID apply
node --import tsx scripts/monad-allowance-resolution.ts RUNTIME PAYMENT_ID recover
```

每次操作沿用持久化决议、退款和签名交易，不创建替代原请求的交易意图。

## 本轮其他修复

- 规划器接受完整且唯一的 JSON 代码块，接单字段仍按白名单严格校验。停止说明输入有长度上限，持久化截短为 240 字符，不再把较长说明误判为无效决策。
- 仅对无子任务、原截止未过且原付款与缓存绑定全部成立的格式失败，允许恢复同一 UUID。恢复只读缓存，不调用模型；预算回拨仅发生一次，并保存原失败结果。已有子任务或过期父请求不会借此重开。
- 额度购买移除写死的 10 秒超时，使用配置的 120 秒上限，并受原任务剩余时间限制；没有新增自动推理重试。
- 明确规划上下文中现金、借款本金上限、报酬内偿还费用和模型微额度的单位与关系，允许模型自主停止。
- 手机财务读取遇到明确传输中断或后端 `HOSTED_FINANCE_TIMEOUT` 时，共用一次有限重试；重新可见或联网后可恢复读取。交易动作不自动重发。
- 网关显式使用已验证的 direct 供应商连接，无自动线路切换；重启保留调用计数，新调用保存响应摘要及可用的供应商标识。

主 Agent 定向检查包括补偿/封存/独立终止 17 项、缓存恢复 54 项、最终规划器 45 项和购买超时 3 项，均通过；这些批次存在重叠，不相加宣称测试总量。前端实现方最新 20 项桌面/手机财务回归、全项目类型检查和生产构建通过。真实实网业务另按上表记录。

## 证据与运行边界

- [真实模型、资金与幂等重放](../frontend/acceptance/monad-hosted-20261012/financial-evidence.json)
- [最终 canonical 独立审计](../frontend/acceptance/monad-hosted-20261012/final-canonical-audit.json)
- [最终桌面/手机报告](../frontend/acceptance/monad-hosted-20261012/final-report.json)
- [保留的首次未通过观察审计](../frontend/acceptance/monad-hosted-20261012/observed-audit.json)
- [保留的第一次最终浏览器复测失败](../frontend/acceptance/monad-hosted-20261012/browser-final-attempt-1/final-report.json)

最终浏览器复测桌面/手机各核对三个 Agent，六次财务响应均为 confirmed，页面错误与验收问题为 0，共保存 21 张截图。没有业务 POST 或新增模型调用。超时后一次恢复的行为由 20 项受控财务回归覆盖；最终真实复测六次财务读取均首次确认。

最终审计在区块 70307385 通过，从原付款、ProviderPaid、LoanOpened、LoanRepaid、RefundProcessed、TaskSettled 和 ERC-8004 反馈重新核对；现金包含所有失败规划支出及额外补资，全局未偿贷款为 0。原失败报告和 journal 不覆盖为成功。浏览器使用真实 owner 签名与真实 HTTP，不模拟业务 API，但签名由 Node 中的验收钱包提供，尚不代表 MetaMask 扩展钱包或公网联合部署验收。

关键凭证：Task 14 补偿退款 `0x63407e364d560cd60ef5c833237b2ad139549ea200b5196c96174a679dba367f`；独立终止 `0xde78da05a19819c316f7143db9dcc7bfa84a44f660a2083b481d16d8f4d4f311`；原补偿父请求 `910f477d-8bed-4e80-b4cd-69fffcbb8e78`；缓存恢复父请求 `f9e2498c-da47-4911-a8f3-60cb68d2e13a`；最终连续两单父请求 `f4a39eb2-8161-4cb6-86fc-62f15f0530b9`。

本机前端 `http://127.0.0.1:3024`，托管服务 `http://127.0.0.1:8792`。运行目录与旧 Anvil 目录隔离，服务恢复沿用原目录与 bootstrap：

```sh
AGENTFUEL_RPC_RETRY_READ_503=1 node --import tsx scripts/monad-hosted-runtime.ts start \
  demo-output/monad-hosted-20261012/runtime \
  demo-output/monad-hosted-20261012/bootstrap.json --recover
```

私钥、签名原文、供应商私密响应和内部 runtime 文件不复制进公开证据。服务启动不等于重新派发业务。
