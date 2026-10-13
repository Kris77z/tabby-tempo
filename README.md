# Tabby — AgentFuel Tempo

Tabby gives hosted AI agents task-backed credit to buy inference, complete verifiable work, repay financing and build financial reputation on Tempo.

This is the Crypto World's Fair Tempo submission. Four Solidity contracts are deployed on **Tempo Moderato (42431)**, using test **PathUSD** for settlement and transaction fees. Independent acceptance verified **five credit-funded tasks and two reward-funded tasks** with real Kimi inference, Pi execution and Docker hidden tests. All six participating agents ended debt-free. The application is currently operated locally against the testnet; public hosting is being prepared.

For judges: start with [core Tempo acceptance](docs/tempo-root-acceptance-20261012.md), [reward-path acceptance](docs/tempo-gamefi-extra-root-acceptance-20261013.md), and [runtime instructions](docs/tempo-runtime.md). The accepted two-task autonomous run spent 0.26 PathUSD within its unchanged 0.30 budget and reached InferScore 640 / Tier B. Unknown provider outcomes and compensated failures remain disclosed in the evidence.

Prior work: this project extends the AgentFuel EVM prototype at source commit `922f65dc9c20ab404946ce37e49e95484b515f75`. Tempo-specific work includes network and asset verification, PathUSD fees, deployment and feedback gas budgets, chain-bound recovery, hosted execution and the independent testnet acceptance records. Historical Monad / Anvil sections below are background, not Tempo evidence.

> 本目录是 2026-10-12 创建的独立 Tempo 迁移项目。当前目标网络为 **Tempo Moderato 42431**，结算及手续费资产为 **PathUSD（6 decimals）**；运行、恢复与证据边界见 [Tempo 运行说明](docs/tempo-runtime.md)。下方 Monad / Anvil 记录来自源项目快照，只作历史背景，不能作为 Tempo 通过的证据。

Tempo 核心迁移验收已有 **5 个成功任务、1 个补偿中止任务、4 个独立 Agent**；新的自主 Agent 在同一固定预算和截止时间窗口内完成两单，四个 Agent 债务均为 0。两次供应商 Unknown 原样保留并分别补偿，未知供应商成本由运营方承担。验收入口为 [Tempo 核心独立验收](docs/tempo-root-acceptance-20261012.md)，原始公开记录见 [财务与重放证据](docs/evidence/tempo-20261012/financial-evidence.json)。

2026-10-13 的 [Tempo GameFi 追加实跑](docs/tempo-gamefi-extra-runtime-20261013.md) 已完成参赛托管 Agent 的两条真实奖励消费路径：PathUSD 奖金结合原预存支付 Task 7，4096 奖励 tokens 消费 295 完成 Task 8；两者经 Pi / Docker Arena 验收及 Tempo 结算，各 cash 0.15 PathUSD、债务 0。批准追加额度仅用 4/6 局；[原三局失败/输局及四种本地练习](docs/tempo-gamefi-runtime-20261013.md)完整保留。当前仅本地连接测试网，没有公开上线。

InferCredit 用已托管的任务报酬支持 Agent 购买推理：现金不足时，按任务获取授信，把借款直接支付给白名单 Provider；任务通过独立验收后，在一笔交易中还清本金与费用，剩余收入进入 Agent 现金账本。真实还款与违约写回 ERC-8004 声誉，供后续授信使用。

仓库采用 npm workspaces、TypeScript、ethers v6、Foundry 和 Next.js。当前是 Hackathon P0 与已落地扩展的实现，不是长期架构文档中所有功能的集合。[implementation-status](docs/implementation-status.md) 及下方 USDC / GameFi、Monad / Anvil 表格记录源项目历史范围；本轮 Tempo 的完成状态以顶部独立验收入口为准。

## 产品主线与六项能力

**创建托管 Agent，让它在预算内采购推理、执行任务赚取收入，并用履约信誉支持后续信用。** Agent 的发布者/接单者角色随任务变化；同一个 Agent 可以接单，也可以为自己的任务采购能力。当前 Demo 展示托管 Agent 接取平台任务，自主发布子任务与专家 Agent 委托尚未开放。

| 核心能力 | 当前范围 |
| --- | --- |
| 信誉 | ERC-8004 履约记录与 InferScore/Tier，参与授信额度和费用计算。 |
| 借贷 | 用已托管的任务报酬支持 USDC 推理信用，直接支付 Provider，验收结算时还款。 |
| 游戏赚 token / 资金 | 免费德州奖励测试 USDC 或绑定 Agent 的推理额度；游戏不借贷。 |
| 统一模型网关 | Magpie 统一接入两个底层 LLM，各按输入/输出费率消费推理额度；保留原固定价服务。 |
| 执行与验收 | 接单、求解、提交、独立 Arena 验收与结算。 |
| Pi 自主执行 | 模型在预算、任务数和时间限制内决定运行档位、融资方式与下一单；Pi 调用工具、测试与修正，宿主校验决策边界。 |

主闭环：**创建与开户 → 准备资源 → 接单 → 购买推理（不足则任务授信）→ Pi 执行 → 独立验收 → 还款、收入与信誉入账 → 下一单。** 游戏是资源补充支路。新增任务绑定额度包、双模型按量扣额与有界连续运行；按量模式可在奖励不足后按任务信用补额，保留原任务轮次。独立奖励模式仍只用奖励，不自动付款。当前产品不提供 gas 赞助。

**新增核心运行能力（2026-10-12）**：额度包信用购买、两模型统一计量、原任务补额续跑，以及有界 LLM 决策与 Pi 连续执行已接入。真实 K2.6/K3 经 Magpie 和托管前端 API 完成本地信用结算；自主 Agent 连续完成两单、债务归零、信誉升至640/B。见 [核心运行说明](docs/core-runtime.md)、[真实本地验收](docs/local-real-acceptance-20261012.md) 和 [本地启动步骤](docs/local-hosted-testing.md)。该批使用 Anvil/测试 USDC。后续[本地连接 Monad 测试网验收](docs/monad-hosted-acceptance-20261012.md)已完成核心业务、独立链上审计及桌面/手机核验：两模型分别结算，自主 Agent 新窗口连续完成 Task 16/17，累计三次还款、信誉710/A、债务0；Task 14 原 Unknown 经永久封存、运营全额补偿和独立终止完成收口。原失败、补资和规划支出均保留，公网部署与扩展钱包另验收。

完整角色定义、六项能力边界和黑客松演示主张见 [当前产品主线](AGENT_CREDIT_ARCHITECTURE.md#当前产品主线2026-10-11-确认)。

## 核心资金路径

1. 发布者调用 `TaskEscrow.createTask` 托管报酬；当前 ERC-8004 agent wallet 调用 `acceptTask` 接单。
2. SDK 获取 Relay 的自建 `402` 报价，优先使用现金。现金不足时，Underwriter 为该任务签发 EIP-712 授权；`AgentAccount.payProvider` 原子完成现金扣款、`CreditManager.draw` 和 Provider 付款。每个任务只能提款一次，借款不能提到任意钱包。
3. Relay 确认付款后执行推理。固定价求解服务 B 可经实际 Magpie 调用模型，由 Pi 使用有界的 `test_public_sample` 工具；最终结果另交 Arena 的隐藏测试，独立 settler 持 verifier key 结算。
4. 成功结算按任务创建时的费率快照扣协议费，再偿还本金与 factor fee，余额进入 cash；失败或到期按合约规则清算。退款按贷款状态处理，反馈失败保留待重试记录，不回滚已完成的资金清算。

本独立项目目标演示链是 **Tempo Moderato，chainId `42431`**，结算资产是 **6 位小数的测试 PathUSD**。原 Monad/USDC 记录保留在各历史验收文档。金额与 ID 在协议中使用原始整数/十进制字符串；例如 `120000` 表示 `0.12` PathUSD。合约也有原生币路径及本地测试。Provider 固定报价、信用费用与上游模型实际账单是不同数据。P0 vault 是 treasury 管理的协议自有资金池；当前 `sessionKey` 就是 agent wallet 私钥，没有独立 session key 协议。

## 源项目已验证的范围（历史）

| 路径 | 已有结果与边界 | 证据入口 |
| --- | --- | --- |
| P0 四合约与原演示 | Foundry 离线 408 tests：404 pass、0 fail、4 skip。Monad 原演示完成六次还款、一次违约；主角第三次还款从 `640/B` 升至 `710/A`。 | [合约测试索引](contracts/TEST_PLAN.md)、[原演示最终证据](demo-output/monad-20261002-deployment-89b14f6d/evidence/demo.json) |
| 固定价 Pi 信用 B | 一次 `forTask` 购买最多 N 轮求解；受控上游覆盖修复、恢复、未交付退款和隐藏测试失败清算。真实 K2.6 经 Magpie 的本地信用运行首轮成功，`cash40000 + draw80000` 支付 `120000`，偿还 `92000`。 | [服务规格与复现](packages/pi-loop/FIXED_PRICE.md)、[本地真实模型验收](demo-output/live-local-credit-20261004-root/root-acceptance.json) |
| Monad Pi Task 11 | 实际 Magpie → 真实 K2.6 一次工具调用 → Pi → 独立 Arena `5/5` → `TaskSettled/Repaid`。`cash105396 + draw14604` 支付 `120000`，fee `438`、偿还 `15042`；最终 cash `134958`、还款 4、违约 0、未偿 0。Task 9/10 的失败及托管款全退仍作为历史保留。 | [Task 11 独立验收](demo-output/live-monad-pi-20261004-alchemy-root/root-acceptance.json)、[canonical 链状态核对](demo-output/live-monad-pi-20261004-alchemy-root/root-canonical-audit.json) |
| Magpie 网关 | 实际进程已按最新未知响应规则通过 22 项检查，锁定 `v0.1.814` 与禁用隐式重发的小补丁。`cheap/strong` 由调用方显式选档，报价、付款和退款仍属于 Relay/SDK。 | [接入说明](docs/magpie-gateway.md)、[本轮验收](docs/backend-acceptance.md) |
| Pi 早期现金路径 | 真实 K2.6 首轮返回 `test_public_sample`，独立 Arena `5/5` 并在本地 Anvil 结算；报价 `10000`，SDK 推理付款 `taskId=0`，没有借款。这份历史证据不包含 Magpie 或 Monad。 | [Pi 入口](packages/pi-loop/README.md)、[现金路径验收](demo-output/live-pi-20261004-kimi-once/root-acceptance.json) |
| 德州免费赞助奖励（2026-10-04 历史） | 真实Kimi合法终局，Monad Agent1999获0.1测试USDC并入cash，以0.01购买真实K2.6，剩0.09、借款0；CLI执行与只读桌面/手机回放。 | [运行说明](docs/holdem-arena.md)、[本轮总验收](demo-output/holdem-live-20261004-root/root-acceptance.json) |
| 网页 GameFi 与 Kimi 额度 | 本机运营网页调用固定两位 Agent；可信终局共发放 4096 token，真实 Agent1999 消费 24 后余额 4072，同 ID 返回缓存。新 USDC 局已完成：Agent1998获0.1测试USDC入cash，消费0.01完成真实Kimi推理（29 tokens），余额0.09、借款0；练习跨重启保存已实现。 | [runner 配置](docs/gamefi-runner.md)、[额度规则](services/arena/src/inference-rewards/README.md)、[本轮验收](demo-output/gamefi-complete-20261005-root/root-acceptance.json) |
| 双 Agent 五子棋 | 真实 K2.6 完成 12 个合法落子、13 次调用与付款。黑方第 13 次回答截断且格式无效，白方按规则 `forfeit` 胜。费用使用本地 Anvil/mock-USDC、双方独立现金预算，非五连胜。 | [规则与运行](docs/gomoku-arena.md)、[真实终局验收](demo-output/gomoku-live-20261004-retry-root/root-acceptance.json) |

真实 Pi 运行均首轮成功，尚未证明自然多轮修复。K3 工具、本机预设任务的规则选单与自动接单已验收；新统一接口将选择、一次固定价购买、Pi 工具、独立 Arena 与还款接成同一持久流程。德州免费赞助测试USDC→真实推理首版已落地（见下文）；公开远程报名/任意提示词参赛、自动分类路由、逐轮储值与按用量退款、公共 LP 尚未实现；标准 x402 scheme/facilitator 兼容性尚未验证。RPC 稳定性与前端读取性能仍有边界，详见状态表。

## 用户托管 Agent

2026-10-11 前端复核与本轮交付结果见 [上线测试前验收](docs/frontend-release-acceptance-20261011.md)：恢复入口、个人金融信息与 Oberon 落地页已完成，首轮本地浏览器覆盖 93 个用例；后续补齐首次进入动效与独立终端创建，相关 92 项补验通过。

用户在平台创建 Agent，平台托管运行与独立钱包；首版选择运营方支持的模型、三档策略和消费预算。`/api/hosted/*` 提供钱包签名登录、创建/修改/暂停、入金、任务、免费德州与模型额度消费；不是外部 Agent 接入 API。原预设入口保留作运营兼容。

root 已用两名用户、随机生成的托管钱包、实际本地链和两个生产 executor 验证：开户 → 入金 → 信用任务 → 赢赞助 USDC → 用奖励余额完成下一单 → 赢额度并消费。未新增真实供应商消费或 Monad 交易，真实扩展钱包与公开部署尚未验收。见 [托管交付](docs/hosted-acceptance.md)、[配置/API](docs/hosted-agents.md)。

`/` 是基于 Oberon 调整的产品落地页；“创建你的 AGENT”进入 `/onboarding`，以 Agora 的暖白棕色终端逐项完成钱包登录、六项配置和确认，再进入 `/dashboard` 托管工作台；“进入工作台”直接打开 `/dashboard`。工作台沿用 Agora Mesh Dashboard 的浅灰/白色方角面板、紫色强调、Geist Mono、紧凑三栏与请求时间线；个人金融卡显示核验后的 cash、完整债务、InferScore、Tier 与还款记录，任务展示真实结算凭证。`/arena`、四种练习和 `/advanced` 共用终端页头与导航。`/arena/holdem` 是固定运营比赛的历史只读证据，入口收在高级协议的“历史演示与证据”，不属于创建或参赛必经路径。个人托管 Agent、固定运营演示与免费练习明确分开；服务未配置时显示真实空态。页面来源与适配见 [Oberon 落地页](docs/frontend-oberon-landing.md) 和 [Agora 迁移记录](docs/frontend-agora-migration.md)。

## 后端运行与页面接入

现有 P0、四题固定价任务与本机运营 GameFi 的后端收尾见 [后端交付](docs/backend-acceptance.md)。`npm run backend -- --manifest /absolute/private/backend.json --check` 离线检查私有配置，`--start` 启动 Underwriter、固定价 Relay、独立 settler、Arena 和 TaskRunner；详见 [运行说明](docs/backend-runtime.md)。GameFi 沿用独立 [runner 配置](docs/gamefi-runner.md)。

页面通过 `GET/POST /api/tasks/runs` 获取预设任务、发起和恢复原 UUID。服务端设置 `TASK_RUNNER_URL`，浏览器不能传入钱包、模型地址、价格或任意提示词。接口及状态说明见 [TASK_RUNNER](packages/pi-loop/TASK_RUNNER.md)。此预设入口保留在 `/advanced`；`/dashboard` 通过同源 `/api/hosted/*` 接入签名登录、创建、设置、暂停和账户操作。托管奖励额度可用于 Pi 目录任务，并经独立 Arena 验收结算；不作为任意聊天入口。

## 最小本地运行

从仓库根目录执行。需要 **Node.js `22.19.0+`**、npm、PATH 中的 `forge`/`anvil`，以及已启动的本机 Docker daemon。Foundry 使用 solc `0.8.24`；首次安装依赖、编译器和镜像需要相应下载源可访问。

```sh
npm ci
forge build --root contracts --skip-lint
docker info
docker pull python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111
npm run demo
```

默认 demo 自建独立 Anvil、四合约、Underwriter、Relay、Docker Arena 和独立 settler，使用真实本地交易、mock registries 与明确标记的 FAKE 上游；不需要真实私钥或模型 API key。它保存新的 `demo-output/local-…/`，完成后关闭本次服务。Docker 不可用会在业务交易前失败；已有输出目录不能覆盖。

若要在前端观察 `B → A`，在交互终端运行：

```sh
npm run demo -- --mode local --serve --pause-before-third
```

第二个终端将 `FRONTEND_MANIFEST_PATH` 替换为上一步输出的 **绝对路径**：

```sh
FRONTEND_MODE=chain FRONTEND_MANIFEST_PATH=/absolute/path/to/manifest.json npm run dev --workspace @agentfuel/frontend
```

打开 `http://127.0.0.1:3000/advanced` 查看固定运营 Agent 协议演示；原终端按 Enter 执行主角第三单，结束后 Ctrl-C 关闭本次服务。只查看合成 UI 可运行 `npm run dev:fixture --workspace @agentfuel/frontend`，页面标记 `FIXTURE` 且关闭钱包广播。金额、输出文件和恢复边界见 [本地 demo runbook](docs/demo-runbook.md#本地飞轮复现) 与 [前端说明](frontend/README.md)。

## 检查与验收

静态检查：

```sh
npm run typecheck:all
```

本地 workspace 测试和完整合约套件分别运行：

```sh
npm run test:all
forge test --root contracts --offline
```

`test:all` 包含 Underwriter、Relay（含 SDK）、Arena、Pi、ERC-8004 和前端 Node 测试；不包含 Foundry 全套、`scripts/test`、浏览器测试、canonical 公网 fork 或真实模型/网关验收。部分测试会启动本地 Anvil 与 Docker，固定 Python 镜像须提前缓存；`--offline` 合约测试需要已缓存的 solc。

完整本地飞轮及 Monad 配置/恢复回归另有入口，后者使用本地 Anvil，不访问公网或真实模型：

```sh
npm run test:demo
npm run test:demo:monad
```

按改动选择其余验证，不用把真实执行当作默认测试：

| 改动范围 | 入口 |
| --- | --- |
| 固定价服务的修复、退款、恢复 | [FIXED_PRICE.md 的受控回归](packages/pi-loop/FIXED_PRICE.md)，包含 `scripts/verify-fixed-price-credit.ts` 新链验收 |
| 五子棋裁判、付款和恢复 | `node --import tsx --test scripts/test/gomoku.test.ts`；[规则与受控 demo](docs/gomoku-arena.md) |
| Magpie 进程、补丁和失败调用次数 | [Magpie 复现](docs/magpie-gateway.md#复现)，需独立构建的网关和 Go；未配置 binary 会失败 |
| 前端构建与钱包/Docker 浏览器流程 | [frontend README](frontend/README.md#本地视觉与测试)，浏览器测试另需 Chrome |
| canonical registry 签名与反馈 | [ERC-8004 测试](packages/erc8004/README.md#测试与实际结果)；公网 fork 是显式 opt-in，不属于离线套件 |

已有真实结果可以离线复查，例如：

```sh
node --import tsx scripts/verify-live-fixed-price.ts --audit-output demo-output/live-monad-pi-20261004-alchemy-root
```

该命令核验保存的证据，不重新访问原链、调用模型或广播。真实网络预检、执行与恢复只按 [demo runbook](docs/demo-runbook.md) 和 [固定价服务 runbook](packages/pi-loop/FIXED_PRICE.md#真实执行入口) 操作；已有已付请求恢复原 PaymentHandle、原输出目录与原签名交易，不通过新 paymentId 重买。

## 目录与阅读顺序

| 目录/文档 | 用途 |
| --- | --- |
| [contracts/](contracts/README.md) | 四个资金合约；`src/interfaces/` 定义类型、事件与错误，`TEST_PLAN.md` 索引行为测试 |
| [services/underwriter/](services/underwriter/README.md) | 固定区块信用读取、任务授信与 EIP-712 evidence |
| [services/provider-relay/](services/provider-relay/README.md) | 报价、收款确认、模型路由、receipt 与运营退款 |
| [services/arena/](services/arena/README.md) | Docker 判题、可信 controller、独立 settler 和恢复 |
| [packages/sdk/](packages/sdk/README.md) | Node/浏览器签名者入口、现金优先付款及 PaymentHandle 恢复 |
| [packages/pi-loop/](packages/pi-loop/README.md) | 受限现金循环与独立固定价求解服务 B |
| [packages/erc8004/](packages/erc8004/README.md) | canonical 身份、钱包绑定和指定 reporter 声誉读取 |
| [frontend/](frontend/README.md) | Agora 终端工作台、托管 Agent、游戏练习与协议证据 |
| `scripts/`、`demo-output/` | 本地/真实验证入口、脚本回归与既有运行证据 |

先读 [implementation-status](docs/implementation-status.md) 与相关模块 runbook，再查 [工程规格 §4](AGENT_CREDIT_ENGINEERING.md) 和 [风险与 MVP](AGENT_CREDIT_RISK_AND_MVP.md)。[架构](AGENT_CREDIT_ARCHITECTURE.md) 保留长期方案，[赛道叙事](AGENT_CREDIT_TRACK_NARRATIVE.md) 与 [demo pitch](docs/demo-pitch.md) 用于解释项目；历史排期和早期模块状态不代表新增功能已完成。

Pi 使用锁定的 `pi-agent-core` / `pi-ai` npm 依赖 `1.0.1`；Magpie 使用锁定官方源码与本仓库补丁，保留 [上游 MIT LICENSE](scripts/magpie-UPSTREAM-LICENSE)、[锁文件](scripts/magpie.lock.json) 和 [补丁](scripts/magpie-no-retry.patch)。外部来源及当前运行边界以对应模块说明为准。

## GameFi 与四种练习（2026-10-05）

`/arena` 已支持本机运营用户从网页发起真实德州，选择测试 USDC 或 Kimi 推理额度；服务端固定两位 Agent，复用原真实 Kimi、可信裁判及奖励 CLI。每局额度共 4096 token，独胜全额、平局各 2048，绑定 `kimi-k2.6` 和服务端固定身份；按实际输入/输出 usage 扣减。调用前持久预留，未知结果保留原 ID 与预留，同 ID 查询/缓存不触发第二次模型调用。游戏不借贷，额度不是加密代币，也不与 USDC 混账。

本轮真实额度局 `b3f24ce8-4270-4a05-baf6-c80675237fc3` 已向 Agent1999 发放 4096 token，真实消费 24，剩余 4072；重复兑换返回原缓存。USDC 路径在 2026-10-04 已完成 Agent1999 获 0.1 测试 USDC、以 0.01 购买真实 K2.6、cash 剩 0.09 的历史验收。2026-10-06 新 USDC 局已完成独立验收：Agent1998获0.1测试USDC，原存款签名确认入cash，消费0.01完成1次真实Kimi推理（21输入+8输出=29 tokens），cash剩0.09、借款0。root fresh核对存款/付款canonical回执、付款块cash及本地原始模型响应；原对局报告未变，没有重复派奖。RPC仍可能间歇失败，本次成功不代表网络问题已消失。见[本轮汇总](demo-output/gamefi-complete-20261005-root/root-acceptance.json)与[历史奖励证据](docs/holdem-arena.md)。

真实 runner 和额度账本持久保存意图、阶段、余额和恢复记录；全局 writer 锁防止重叠开局/重复消费。`/arena/holdem` 保留为历史只读回放，主大厅提供新局、恢复和额度消费。当前只面向本机运营用户，没有远程账号报名、任意钱包接入、多手真实赛事或可验证随机。配置与恢复见[网页 runner](docs/gamefi-runner.md)和[额度规则](services/arena/src/inference-rewards/README.md)。

四游戏为免费练习：德州、五子棋、国际象棋、12关小丑牌，支持双人邀请、日志、历史与 Agent API。策略 Bot 不调用真实模型，虚拟筹码不接借贷或派奖。练习默认保存到服务进程 cwd 下 `.data/arena-freeplay.json`，可用 `ARENA_PLAY_STATE_PATH` 指定；规则重放、席位与幂等请求可跨服务重启恢复。详见[练习运行和 API](docs/free-arena.md)、[参考 UI 来源](frontend/acceptance/arena/clone-evidence.md)。

控制台桌面/手机 16 项浏览器测试使用受控接口拦截，不调用真实模型或提交奖励交易，见[测试边界](frontend/acceptance/gamefi-console/verification.md)。本地受控德州演示仍可用 `node --import tsx scripts/holdem-demo.ts --output /absolute/new-holdem-output`，需要 Anvil 和已构建合约。


## 仓库与本地运行资料

仓库包含源码、合约、测试、工程文档、配置示例和前端验收截图。`demo-output/` 为本地运行证据，可能包含密钥、原始请求和签名交易，因此不提交；文档指向该目录的历史证据链接仅在原开发工作区可用。`node_modules/`、构建产物、运行状态及真实环境配置也不提交。新环境请按本文安装依赖并从 `.env.example` 等模板配置，勿将真实凭据加入版本控制。新 GameFi USDC 局已于2026-10-06完成存款及奖后真实推理独立验收；历史失败记录保留。


普通Relay现已区分明确拒绝与结果未知：未知响应保留原付款与派发记录，不自动fallback、重发或退款。2026-10-06 root独立Relay/SDK44项、固定价B兼容28项及typecheck全部通过；真实strong工具随后已完成下述验收，自然修复/自然供应商故障仍未验收；注入拒绝后的真实备用调用已于2026-10-07完成，见[进度入口](docs/implementation-status.md)。


真实strong工具已于2026-10-06验收：K3一次调用393 tokens，实际工具及独立Arena5/5，新本地链信用还款完成；root复核原始证据并重新Docker判题5/5。只证明首轮成功，不计自然修复或真实fallback，见[固定价服务](packages/pi-loop/FIXED_PRICE.md)。


## 2026-10-07 新增交付

规则选择器、四题固定价求解和注入拒绝后的真实备用路由均已完成验收。四题真实Kimi各一次，独立判题19/19并完成本地信用还款；选择器另一次真实现金购买，原session恢复不重复消费；备用调用一次，原付款回放及Relay重启不重复扣款。62项定向受控测试、最终受影响2项复跑和全项目typecheck通过。

本轮使用隔离Anvil/mock-USDC，无新增Monad交易；选择器只负责预设Assigned任务中的一次购买，四题使用各自独立fixture，不冒充网页全自主调度、自然多轮修复或自然供应商故障。详细结果与剩余边界见[工程状态](docs/implementation-status.md#2026-10-07-本轮验收与剩余边界)，入口见[选择器](packages/pi-loop/README.md)、[四题求解](packages/pi-loop/FIXED_PRICE.md)、[备用路由](services/provider-relay/README.md)。
