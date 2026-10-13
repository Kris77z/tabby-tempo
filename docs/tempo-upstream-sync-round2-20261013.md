# 2026-10-13 第二轮源代码同步

自动地址/交易查链、目标付款作废恢复和 Magpie 状态动画已迁入并适配 Tempo。本轮没有 Tempo 业务交易、替换交易广播或付费模型调用；付款生命周期使用受控 Anvil，Tempo 只查询 PathUSD 和原 Task7 回执。上一轮冻结版本、历史验收、六位 Agent、27 个请求和已到期游戏授权保留。

## 冻结与范围

源 HEAD 仍为 `922f65dc9c20ab404946ce37e49e95484b515f75`。相对上一轮冻结源版本审查 34 个新增/变动文件，捕获期间内容稳定。源快照摘要为 `1b8b8c25b897e3c76b61f9c4474c78f8b6500fbef6fb255d92a55ab5fd38fea8`，快照清单文件 SHA-256 为 `4f58ac551842e9f5b4f8fd43f78dc4d2de0246633af19deb49281054a2d73fec`。私有三方快照位于 `.data/upstream-sync-20261013-round2/implementation/`；逐文件决策与最终哈希见[迁移证据](evidence/upstream-sync-20261013-round2/migration-evidence.json)。

| 处理 | 本轮范围与理由 |
| --- | --- |
| 迁入并适配 | 主机固定 RPC/Sourcify 只读预取、持久链快照、公开来源凭证、独立复核上下文。支持 Tempo 42431，保留受控 31337 和历史 10143 分支。 |
| 迁入并适配 | 报价过期后的原付款 canonical 对账、原 nonce 作废、原 UUID 的取消/停止终态；保留已经支付的费用，不将 Unknown 当成未付款。 |
| 迁入 | Magpie canvas 以持久阶段产出显示进度；暂停、失败、隐藏页面及减少动态效果时停止动画；不按经过时间虚构成功。现有品牌资源按冻结差异补齐，不重新设计。 |
| 保留 | Tempo/PathUSD、cash-only task0、10000/20000 原报价、预算和固定截止、物理模型/请求别名校验、120s/130s 财务超时、原端口和独立 relay、grant 摘要/到期/admissions。 |
| 不迁 | `chain-lookup-live.ts`、`chain-mission-monad.ts`、`chain-verify-void.ts` 三个源环境实跑驱动及源 Monad 运行证据。它们固定源网络/网关或含真实费用；本轮使用本项目受控验证和独立只读探针。 |
| 明确限制 | Tempo 0x76 批量交易保留最多 16 个 calls、每段 calldata 最多 4096 字符，并标记不支持批量 ABI 解码；不把它伪装成单笔交易，也不进行 trace 或内部调用分析。 |

## 查链证据边界

只从当前托管网络提取最多两个完整地址或交易哈希，不接受用户 URL 或模型选择 RPC 方法。合约资料钉在最新块减二，交易资料钉在原回执区块，发布前重查 block hash；恢复使用已持久化的原快照，不重新取资料或改变付款请求。

Sourcify URL 的 chain/address 必须同时绑定 envelope 和地址 record；返回字节码必须匹配同网络、地址及钉住区块的 RPC code。未验证源码不用于 ABI 解码。下载上限 2 MB、源码总量 16000 字符、ABI 6000 字符、模型上下文 65000 bytes、整体 RPC 读取上限 120 秒；超时在付款前停止。源码和注释仅是资料，不是执行指令；五类 specialist 的原 provenance 文件不改，有效提示词明确当前网络及有限主机预取边界。模型仍没有任意 RPC、Web、shell 或资金操作工具。

Tempo `eth_getBalance` 占位值不作为可用 native 余额。PathUSD 余额与 metadata 通过固定资产的同区块 `eth_call` 读取，使用有界 1m gas。首次源 100k gas 导致 `intrinsic gas too low` 的失败记录保留为[首轮探针](evidence/upstream-sync-20261013-round2/tempo-read-only-lookup-first.json)；修复后[真实只读探针](evidence/upstream-sync-20261013-round2/tempo-read-only-lookup.json)确认 PathUSD symbol、decimals=6、totalSupply 和余额，并读取原 Task7 付款。

费用只认可 receipt 的 PathUSD `feeToken`、`feePayer` 与唯一 `feePayer → feeManager` Transfer。原 Task7 的业务 Transfer 为 120000 raw，费用 Transfer 为 210 raw；相同方向多个匹配或缺失 metadata 标为 unknown，不求和，也不把 `gasUsed × gasPrice` 改名成六位 PathUSD。Tempo 的实际费用事件机制见[官方 TIP-20 实现](https://github.com/tempoxyz/tempo/blob/main/crates/precompiles/src/tip20/mod.rs)。

## 作废付款与恢复

先核对完整原 quote/input/raw/hash、链、sender、nonce、account、provider、金额及 paymentId。报价过期本身不释放预留；必须确认 canonical 区块里该 payment 零额且原 nonce 已消耗。已支付但供应商结果不明的调用继续保留原收费和预留，只有现有运营补偿与规范退款证据才能关闭。

仍未消耗的过期签名只能使用同 nonce 的零额自转账，先持久 replacement raw/hash，恢复不签另一笔，也不重新购买模型。Tempo type2 不采用源 21000 gas 假设：估算具体自转账，加 20% 余量，限制在原签名 gas 额度且不超过 10m，fee bump 不超过原 maxFeePerGas 两倍。签名及每次重播前核对 PathUSD 地址/symbol/6 decimals、余额和 fee preference；不能证明这些边界就保留 Unknown。未适配的交易类型不广播。

受控 Anvil 已验证原付款赢 nonce race 时保留实际收费、广播响应丢失后复用原 replacement、终态重放零广播；Tempo fixture 覆盖真实 gas 估算语义、已保存签名后 fee preference 改变时零重播。原 UUID 的停止/取消保留之前各次调用费用，不新增模型。该功能没有在 Tempo 广播真实替换交易，不宣称已完成该项实网付费验收。

## 验证与本地运行

lookup/void/reconciliation 共 17 项通过；goal/specialist/runtime 首轮 44 项中两项旧提示词文字断言按实际有限预取边界更新，最终 specialist 10 项复验通过；前端单元 18 项，Tempo lookup/RPC 只读组最终通过。原 pacing 并行运行曾有 HTTP 调度 jitter 失败，保留记录，空闲独立复验通过，100ms 约束未放宽。桌面/手机受控 UI 14 项通过，涵盖链凭证、来源链接、下载、capability 未配置、减少动态效果、原 UUID 恢复/取消及不确定响应。`typecheck:all`、Next 生产构建与 `git diff --check` 通过。分组存在交集，不合计为不重复测试总数。

本地仍为 `http://127.0.0.1:3028/dashboard`，hosted 8794。当前构建目录与 build ID 见机器证据。升级前检查所有 Agent 无 activeRequestId、无 Queued/Running；仅在原 hosted 配置启用 `goals.chainLookup=true` 并重载新 daemon，原七个 relay 端口与游戏授权未变。完整 supervisor 重启也使用新 Tempo goal 默认配置，并继续校验/保留原 grant file/digest/id；绝不重新 prepare、延长到期或执行剩余两局。

独立实际 owner 浏览器和保全结果由 root 另行记录；本文件与受控测试不替代该独立验收。GitHub 更新由主执行线程在审查后提交，本轮不执行公开部署、主网资金或比赛提交。
