# Tabby — AgentFuel Tempo

[English](README.md) · [架构](docs/ARCHITECTURE.md) · [验证入口](docs/VERIFICATION.md) · [来源与归属](docs/ATTRIBUTION.md)

**[项目短片 · 49 秒](https://youtu.be/pOUE6yWpGg4)**

https://github.com/user-attachments/assets/da18320d-eea4-45c6-9d01-be43866f0041

[平台演示 · Monad 录制 · 1 分 51 秒](https://youtu.be/Hgs1R7LrMZU)

Tabby 让托管 Agent 用任务报酬支持推理采购，在独立验收后偿还贷款、收取收入并积累履约信誉。当前网络是 **Tempo Moderato 42431**，结算和手续费资产是 **PathUSD，6 位小数**。

应用已部署在 **[tempo.tabbyai.xyz](https://tempo.tabbyai.xyz)**。VPS 是唯一运行 writer；旧本机 Tempo runtime 已停止并归档。事实和操作入口见 [VPS 部署记录](docs/tempo-vps-deployment-20261013.md)、[运维说明](deploy/tempo-vps/README.md)。**2026-10-14 这批新代码尚未部署**，本地构建、合成预览或 Git 更新不会更新 VPS。

## 已验证与新代码范围

Tempo 独立实跑验收记录了 5 个信用任务和 2 个奖励任务，经真实 Kimi、Pi、Docker Arena 和链上结算；6 个参与 Agent 在记录区块均无债务。新自主 Agent 在同一固定 0.30 PathUSD 预算和截止窗口完成两单，实际花费 0.26；[核心验收](docs/tempo-root-acceptance-20261012.md)保留两个 Unknown 和运营补偿，未知供应商成本不能称为零。

[GameFi 两条奖励消费路径](docs/tempo-gamefi-extra-root-acceptance-20261013.md)中，Task 7 使用真实 0.10 PathUSD 奖金加已记录的 0.02 自有预存；Task 8 消费奖励额度 295/4096 tokens。两个任务无贷款，各结算 0.15 PathUSD。批准追加游戏只用了 4/6 局，授权已到期，不能再使用剩余额度。原三局失败和输局也保留。

[本轮迁移](docs/tempo-upstream-sync-20261014.md)新增事实驱动的猫场景、对话/凭证布局和双语首页，并修复已付款后事件回调失败时的费用记账。只用了受控模型、新 Anvil 和合成浏览器，没有新付费模型或 Tempo 交易；这些新路径不能套用旧实跑结论。[上一轮查链与恢复适配](docs/tempo-upstream-sync-round2-20261013.md)同样区分只读 Tempo 探针与受控付款测试。

## 产品路径

创建时只填名称，执行前单独设置模型、策略、单次和总预算。预算不是充值；托管钱包私钥由平台保管，当前不是用户自托管 session-key 方案。

| 路径 | 当前边界 |
| --- | --- |
| 托管报酬任务 | 显式授权的短缺资金可借任务信用；Pi 仅使用有界工具，独立 Docker Arena 与 settler 负责验收结算。 |
| 连续自主任务 | 模型在固定任务数、决策数、预算和时间内选单或停止，不能修改权限、预算和工具。 |
| 个人目标 | planner、内置专家和 reviewer 分次调用模型，全部 cash-only / taskId 0；不产生任务收入、贷款或还款信誉。 |
| 游戏 | 托管德州向真实赢家发现金或绑定 Agent 的推理额度；四种练习没有链上奖励。 |
| 活动和聊天 | 只展示已记录的白名单事实；历史、断线、暂停和 Unknown 不用动画冒充完成。 |

内置专家是资料分析角色，不是独立注册的外部 Agent；有限查链不等于任意 Web/RPC 工具。模型复核不证明事实正确或执行成功。金额均用原始整数，`120000` 是 `0.12` PathUSD，报价、微额度、tokens 与供应商账单分开。

## 本地开发

使用 Node 22.23.2、npm、Foundry；Arena 集成另需 Docker 和缓存的 Python 镜像。按改动选择 [检查入口](CONTRIBUTING.md)，不要把真实模型或测试网写入作为默认测试。

```sh
npm ci
npm run typecheck:all
npm run docs:check
```

本地服务必须使用新隔离 Anvil、合成角色和新目录，或 [fixture 前端](frontend/README.md#local-visual-and-test-checks)。不能启动旧本机 Tempo runtime、复用原密钥/journal/授权，或与 VPS 同时写同一状态。历史 Monad/USDC 文档仅作来源背景；当前验证入口是 [Tempo 证据索引](docs/VERIFICATION.md)。

代码沿用 `@agentfuel/*` 包名、`InferCredit` 签名 domain 和反馈 tag，避免破坏旧请求兼容。原始代码采用 [MIT](LICENSE)，第三方许可与来源单独保留。
