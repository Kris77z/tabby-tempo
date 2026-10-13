# 平台托管 Agent 后端交付（2026-10-07）

产品路径是用户在平台创建 Agent，由平台保管其独立钱包并运行模型。无需用户部署外部 Agent，也没有新增公共 LP 或游戏借贷协议。现有预设 Agent 的运营入口继续保留，不能当作用户身份入口。

## 已交付路径

- 钱包个人消息签名登录，challenge 绑定前端 origin、地址、链、nonce 和五分钟期限；会话 24 小时，服务端只存 token hash，浏览器使用 HttpOnly/Strict cookie。每次请求由认证会话解析 owner，不信任请求指定的 owner。
- 每个 Agent 新生成独立钱包，保存私有 `0600` 文件；用户可以设名称、模型预设、三档策略、单次/累计推理预算和是否允许任务授信。活动请求期间不改设置；暂停阻止新操作，原请求仍可恢复。
- 真实注册 ERC-8004 身份、绑定 wallet、enroll 和设置现有 Account policy。运营方可显式启用限额 gas 赞助，每个 Agent 一笔，先持久化原签名和额度再广播。缺资金时保持原请求，不生成替代钱包。
- 用户将 USDC 转到托管钱包后，用 `deposit` 操作把指定金额存入该 Agent 的 cash 账本；服务器固定接收账户，原 ID 原金额恢复。预算设置本身不等于入金，也不等于获批授信。
- 任务继续走固定价 B → Pi → 独立 Docker Arena → 还款。Arena 的运营题目目录可不预设 agentId，身份由链上 Assigned 任务和当前 registry wallet 校验；题目及隐藏测试仍由运营方确定。
- 免费德州由用户托管 Agent 对战平台 bot，所选模型和策略真正进入各席位请求；可信重放决定赢家。赞助 USDC 进入该 Agent 的 cash；Kimi 使用额度按 Agent 独立记账和消费，不是可转让代币。

复用 [任务 executor](../services/hosted-agents/TASK_EXECUTOR.md)、[游戏 executor](../services/hosted-agents/GAME_EXECUTOR.md) 和现有四合约，无新增金融合约。启动、配置和完整 HTTP 契约见 [hosted-agents](hosted-agents.md)。新增服务与 Next 路由可运行；本轮未把用户创建/登录组件接入现有 UI，也未发布公开用户入口。

## root 独立整体验收

[测试源码](../services/hosted-agents/test/hosted-flow.test.ts)使用实际 Next 服务端桥接函数、真实 HTTP 服务、两名合成签名用户、核心调度服务、随机托管钱包、两个生产 executor、新 Anvil 合约、独立 Arena/settler 和受控模型响应。模型调用不是付费 Kimi，不把合成响应称为供应商实测。

| 顺序 | 实际断言 |
| --- | --- |
| 用户创建 | 自动生成新钱包、受限 gas 赞助、注册并 enroll 为链上 Agent 2；另一用户列表不可见、操作返回 404 |
| 入金 | 钱包收到本地测试铸造的 40000 后，原托管签名 approve/depositCash；cash=40000 |
| 第一单信用任务 | 推理价 120000，cash 40000 + credit 80000，成功结算后 cash=58000、债务清零 |
| 赢 USDC | 合法德州终局、可信重放，赞助 100000 入本人 cash，cash=158000 |
| 奖励继续执行任务 | 第二单仍支付 120000，链上 fromCredit=0；成功收入到账后 cash=188000 |
| 赢额度并消费 | 本人获 4096 Kimi 使用额度，受控模型实际 usage 扣 18；不扣另一用户额度 |
| 重试和最终状态 | 原请求重放零新增模型/nonce；累计推理成本 240000、reserved=0、协议 totalOutstanding=0 |

首次独立闭环日志：[flow.tap](../demo-output/hosted-closeout-20261007-root/flow.tap)。本机证据在被 Git 忽略的 `demo-output/` 中，不上传密钥、请求原文或临时链钱包。

## 预算、赞助与恢复口径

`perRunBudgetRaw/totalBudgetRaw` 是推理购买成本上限，不是钱包余额；计入 cash+credit 的实际 Provider 付款，已确认退款扣减相应成本。借款 fee、gas 单列链上事实，不包含在该模型成本预算。请求未知时完整预留单次上限；获奖、入金与设置新预算不会擅自解除原请求锁。

免费比赛消耗平台赞助名额：每个 owner 累计最多 3 局、平台累计最多 100 局；创建新 Agent 不重置 owner 名额，未知结果不退名额。此首版无周期重置或自动扩容。gas 赞助是独立运营配置，总额按已签名 grant 本金累计（不含链 gas fee），默认关闭。平台 guardian/gas sponsor/游戏 sponsor 共用按 signer 的 operator nonce 锁；对战 bot 不得复用这些运营角色的 key。

`requestId` 是持久幂等键；失败未知按同 action、原 ID 和原参数续行，不能用新 ID 重新扣款。并发跨用户 UUID 冲突在钱包生成前拒绝；关闭服务先排空 admission 和活动执行，再释放数据库锁。没有自动绕过失败、重新调用付费模型或自动发起第二笔付款。

## 最终回归

| 检查 | root 结果 |
| --- | --- |
| Underwriter / Relay / Pi | 5/5、45/45、69/69 |
| Arena | 100 通过、0 失败，1 项需独立前端服务的 HTTP 测试按默认配置跳过 |
| ERC-8004 / 前端 Node | 4/4、29/29 |
| 托管服务（含整条 HTTP/链上闭环） | 25/25 |
| 新 CLI 离线配置与真实进程启动 | 4/4 |
| 类型检查 / Next 生产构建 | 通过，含 `/api/hosted/[...path]` |

首轮 `test:all` 在旧固定价退款场景出现 ethers 等待回执超时。已将 Refunder 改为有界查询原 hash，保留原确认数、canonical 校验及 15 秒上限；新增延迟回执/重组与恢复负例，随后完整 Relay/Pi workspace 回归通过。上表采用各套件最新日志，不声称重新跑过第二次单命令 `test:all`；原失败记录保留。独立复审补齐跨用户并发创建同 UUID 拒绝、关闭时排空入队与执行的回归。没有改金融合约，也未放宽资金断言。

[root 验收记录与日志摘要](../demo-output/hosted-closeout-20261007-root/root-acceptance.json)保存在本机。源码、测试和文档入 Git；日志中的本地证据不作为公开部署证明。

## UI / 部署验收范围

2026-10-07 交付时，UI 尚需连接签名登录、创建/修改/暂停、钱包地址与入金、任务/免费参赛控件、资金/额度结果、原 ID 恢复和错误状态，并验证桌面/手机。当前用户模型和策略是运营允许的预设；额度消费沿用有限的 Kimi 奖励推理入口。它不是任意用户代码托管、外部 Agent API、任意 provider、自由提示词平台或多手锦标赛。

新的多用户托管流程本轮未广播 Monad 或消费真实模型；此前预设 Agent 的 Monad/Kimi 证据不自动覆盖新开户、用户登录和并发场景。面向公开用户的部署、真实供应商与测试网联合验收需独立记录，不因后端本地回归通过而标记为已上线。

2026-10-10 前端续批：已复用 Agora Mesh 终端 Dashboard 原版浅灰紫色体系、等宽字体、紧凑三栏与对应面板/时间线结构，首页连接上述用户登录、创建/配置/暂停、任务、免费德州、入账、固定短确认额度消费与原 ID 恢复。旧协议档案移至 `/advanced`，旧 Arena/holdem 入口保留。来源、验证方式和未验收范围见 [前端迁移记录](frontend-agora-migration.md)。此更新不改变 2026-10-07 后端和链上验收的证据范围，也不表示公开部署已完成。
