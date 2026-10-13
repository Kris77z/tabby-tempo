# Tempo 测试网运行

本独立项目从 AgentFuel 快照迁移；原项目仅作只读参考。目标是 Tempo Moderato `42431`，结算资产和默认手续费资产均为 6 位小数 `PathUSD`。主网 `4217` 不属于当前运行授权与验收。

## 网络与注册表

- RPC：`https://rpc.moderato.tempo.xyz`。
- Explorer：`https://explore.testnet.tempo.xyz`。
- PathUSD：`0x20c0000000000000000000000000000000000000`，6 decimals。
- 现有 Identity：`0x8004A818BFB912233c491871b3d84c89A494BD9e`。
- 现有 Reputation：`0x8004B663056A597Dffe9eCcC1965A193B7388713`。

`tempoPreflight` 实际验证 chain ID、bytecode、Identity 的 EIP-712 domain/ERC-721 接口、Reputation 的 Identity 引用及资产 symbol/decimals。当前措辞为“现有 ERC-8004 注册表，接口已验证”；未将地址相同推断为官方 ERC-8004 仓库已列名的 canonical Tempo 部署。

普通 ethers EIP-1559 交易已实际部署四合约。Tempo `eth_getBalance` 返回占位值，不能用于判断手续费够用；本项目不显示它为可消费资金。钱包的 PathUSD 同时支付手续费，因此只充值所需 cash，并保留手续费余额。TIP-20 内部转账与手续费转账必须按合约事件地址与接收方区分。

Tempo 新 storage slot 的 gas 成本较高。新 Adapter 的反馈预算在部署时固定为 4M；独立 settler 的结算上限 20M 为两次反馈和账本更新保留空间，避免仅凭估算走反馈失败分支。托管写入和退款按估算加 20% 余量；部署 journal 最高 30M。恢复已签交易不会重新估算、修改 nonce 或签名原文。

Tempo 公共 RPC 的所有相同 endpoint 读取在服务进程内共用 4 并发、100ms 发起间隔与 64 项有限队列；排队计入原始请求截止时间。交易广播和水龙头调用不等待此读取队列，也不新增自动重试。原 Monad 的显式读取重试和节流方式保留。

`/advanced` 的首次只读验收在日志扫描阶段遇到 HTTP `429`，失败报告与脱敏 source 诊断保存在 `frontend/acceptance/tempo-hosted-20261012/`。Tempo 前端现在复用上述共享队列，`getLogs` 改为逐页串行，保留完整 2000-block 最近窗口和每页最多 100 blocks。仅 Tempo 前端只读 RPC 显式允许 HTTP `429` 最多三次重试，退避为 1/2/4 秒，`Retry-After` 最多取 5 秒；所有等待仍受原单个请求 30 秒截止与取消约束，写请求、批量请求和推理不进入该重试。

金融读取使用分层预算，避免外层先截断仍在进行的完整核验：

| 读取阶段 | Tempo 预算 | 其他链 |
| --- | --- | --- |
| Hosted finance → Underwriter HTTP | 60 秒 | local 10 秒；Monad 30 秒 |
| Hosted finance 完整快照 | 120 秒 | local/Monad 总预算仍为 45 秒 |
| Next 同源 finance 代理 | 130 秒 | 共用前端宽限，后端预算不变 |
| 浏览器 finance 请求 | 140 秒 | 共用前端宽限，后端预算不变 |
| 真实浏览器 finance 验收等待 | 160 秒 | Tempo 专属验收脚本 |
| 真实浏览器完整 `/advanced` SSR 等待 | 300 秒 | Tempo 专属验收脚本 |

代理与浏览器在收到响应前不知道链域，因此前端 finance 宽限共用。其他代理/浏览器操作仍为 10/15 秒。上述预算保留同区块绑定、完整任务债务扫描与最终 canonical block 校验；读取失败仍是未知状态，不能替代为零余额或零债务。它们不延长已保存的任务/自主窗口截止，不新增业务 POST 或模型重试。`/advanced` 首屏显示读取状态；已配置清单的实时读取失败显示 `READ UNAVAILABLE`，继续显示清单网络及合约地址。

官方依据：[连接信息](https://tempo.xyz/developers/docs/quickstart/connection-details.md)、[EVM 兼容性](https://tempo.xyz/developers/docs/quickstart/evm-compatibility.md)、[手续费规范](https://tempo.xyz/developers/docs/protocol/fees/spec-fee.md)。部署成功与最终信誉反馈成功分别验收。

## 独立配置与启动

需要 Node 22、Foundry 和 Docker。私钥、供应商 key、签名原文与内部 journal 仅保存在被忽略的 `.data/` 下；本次运行在 `.data/tempo-20261012/`。托管端口 `8794`、前端 `3028`、网关 `3436`/`3437` 均与原 Monad 服务隔离。

```sh
npm ci
forge build --root contracts --offline --skip-lint
node --import tsx scripts/magpie-build.ts --output /absolute/new-private/magpie-build
```

Magpie 使用项目锁定源码与禁用隐式推理重试的补丁。首次准备（只生成全新的角色钱包/私密配置，不产生链交易或模型调用）：

```sh
node --import tsx scripts/tempo-bootstrap.ts init \
  /absolute/new-private/operator /absolute/private/vendor.key /absolute/new-private/gateway/ready.json
```

`init` 拒绝覆盖已有目录。随后启动本项目独立网关；配置结构由 `init` 写入，两个物理模型为 Kimi K2.6/K3：

```sh
node --import tsx scripts/local-model-gateway.ts \
  --config /absolute/new-private/operator/model-upstream.json \
  --binary /absolute/new-private/magpie-build/magpie \
  --directory /absolute/new-private/gateway --port 3436 --bridge-port 3437 --transport direct
```

测试网准备命令领取测试资金、部署四合约、接好协议、配置 Provider、向池子存款、新注册运营身份并托管八个任务报酬。部署过程持有独占 writer 锁；水龙头先保存意图和返回哈希，再只读等待余额，未知结果不会自动重复领取。

```sh
node --import tsx scripts/tempo-bootstrap.ts deploy /absolute/new-private/operator
node --import tsx scripts/tempo-hosted-runtime.ts --check /absolute/new-private/operator/bootstrap.json
AGENTFUEL_RPC_RETRY_READ_503=1 AGENTFUEL_RPC_CALL_GAS_LIMIT=1000000 node --import tsx scripts/tempo-hosted-runtime.ts \
  start /absolute/new-private/runtime /absolute/new-private/operator/bootstrap.json
```

断点恢复使用原目录、原配置与 `deploy ... --recover` / `start ... --recover`；禁止导入或重放 Monad journal。`DemoJournal.send` 与 `receipt` 都在任何查询/广播前验证保存交易的 hash、sender 与实际链域。

前端通过同源接口连接本项目服务：

```sh
npm run build --workspace @agentfuel/frontend
FRONTEND_MODE=chain HOSTED_AGENTS_URL=http://127.0.0.1:8794 \
  HOSTED_FRONTEND_ORIGIN=http://127.0.0.1:3028 \
  FRONTEND_MANIFEST_PATH=/absolute/new-private/runtime/deployment.json \
  AGENTFUEL_RPC_RETRY_READ_503=1 AGENTFUEL_RPC_CALL_GAS_LIMIT=1000000 \
  AGENTFUEL_RPC_INTERVAL_MS=100 \
  npm run start --workspace @agentfuel/frontend -- --port 3028
```

本次私密运行配置的相对位置是 `.data/tempo-20261012/operator/bootstrap.json`，启动时替换成当前项目绝对路径。服务保持数据绑定：更改 chain ID、资金域或原模型目录不会把历史请求转换成新请求。网页运营 GameFi 与历史 Holdem 报告仍保留其 Monad 证据范围；新 Tempo 游戏路径尚需单独实网验收。

保留正在服务的生产产物时，可用 `NEXT_DIST_DIR=.next-tempo-advanced npm run build --workspace @agentfuel/frontend` 生成隔离构建，再以相同 `NEXT_DIST_DIR` 启动新进程。本轮 `/advanced` 修复后的 `3028` 实例使用该产物；`next-env.d.ts` 指向其 `types/`，由 Next build 自动维护。切换前核对产物与类型文件存在，避免用测试 dev 目录的类型导入充当生产构建结果。

## 有界验收

```sh
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime prepare
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime cheap
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime strong
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime autonomy
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime evidence
```

该入口由运营方执行，真实登录/创建/充值/任务动作均经过 Next 与 Hosted HTTP；每个 UUID 先保存再派发。`cheap`/`strong` 各一单，自主父请求最多两单/三次规划。合法提前停止会保留原结果，不冒充完成两单。真实模型调用、固定报价/微额度、链上信用费用分别记录；模型未知不自动重试。重复原请求时核对钱包 nonce 与网关物理调用数均无新增。

### Unknown 与原请求恢复

任务额度的 Unknown 使用 `scripts/tempo-allowance-resolution.ts RUNTIME PAYMENT_ID inspect|apply|recover`。`inspect` 仅查文件；`apply` 永久封存原额度、以独立 journal 全额运营补偿，并由独立 verifier 终止未交付任务、退还发布者托管款；`recover` 将原 UUID 核对为真实终态。补偿关闭的贷款为 `ClosedByRefund`，不记还款、违约或成功信誉。原推理 ID 不重发。

现金规划的 Unknown 使用 `scripts/tempo-planner-resolution.ts RUNTIME PAYMENT_ID inspect|apply`，核对原 canonical 支付、唯一关联的 gateway `OutcomeUnknown` 和原 attempts 摘要，再调用现有 `resolve-undelivered` / `refund`。原 Unknown 保持不变、原支付永久禁用，运营方承担未知供应商成本。随后恢复原自主 UUID，只读核对退款；有余量且未超过原截止时间时，新的规划使用新的 decision ID，受原 `maxDecisions`、预算和窗口限制。原窗口到期后不能延长或把跨窗口任务合计为两单验收。

本轮第二自主窗口保留一单成功后以 `NO_FEASIBLE_CANDIDATE` 终止。唯一一次新增独立验收使用下列入口，保留原 Agent 的历史和预算：

```sh
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime prepare-validation --recover
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime autonomy-validation --recover
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime finance --recover
node --import tsx scripts/tempo-hosted-acceptance.ts /absolute/new-private/runtime evidence --recover
```

新 Agent 原水龙头请求无返回 hash，结果仍为 Unknown，未重新领取。运营测试钱包通过 `scripts/tempo-agent-funding.ts RUNTIME autonomy-validation` 转入一次 `1000000` raw PathUSD，独立 `operator-funding/autonomy-validation/` journal 保存原签名字节和 canonical Transfer；只有 `50000` raw 存入 Account cash，总预算仍为 `300000`。后续注册、入金与手续费会减少钱包余额，恢复依据原转账回执，当前余额仅作观察，不要求维持初始余额，也不追加补资。

### 2026-10-12 UTC 本轮结果

本轮实际完成 Task `1/2/4/5/6` 共五单；Task `3` 的 Unknown 全额补偿后独立中止。旧自主 Agent `48` 第二窗口只完成 Task `4`，保留失败终态；独立自主 Agent `49` 在父 UUID `434cb42a-4284-456d-aea1-9c27f16234e2` 的同一窗口连续完成 Task `5/6`，`maxSpendRaw=300000`、`maxTasks=2`、`maxDecisions=3`，截止 `2026-10-12T17:15:18.721Z` 未改变，实际净支出 `260000` raw。没有把旧窗口的一单计入新窗口。

| 参与者 | Registry ID | 最终 cash raw | 债务 raw | 本轮成功 / 还款 | InferScore / Tier |
| --- | --- | --- | --- | --- | --- |
| cheap | 46 | 58000 | 0 | 1 / 1 | 570 / C |
| strong | 47 | 58000 | 0 | 1 / 1 | 570 / C |
| 原自主 Agent | 48 | 48000 | 0 | 1 / 1 | 570 / C |
| 独立两单自主验收 | 49 | 67200 | 0 | 2 / 2 | 640 / B |

Task `3` 补偿 `120000` raw，发布者托管款退回 `150000` raw；第二次规划 Unknown 补偿 `10000` raw。两次供应商成本均未知，由运营方承担，不能写成零成本。网关总计 12 次物理调用，10 次真实成功响应及原 attempt `4/7` 两次 Unknown；五份真实交付通过独立 Docker Arena。

主 Agent 的 canonical 审计在区块 `39297657` 核对五单成功及两份补偿：累计信用费用 `58800` raw、池余额 `10058800` raw、Account token `231200` raw、剩余发布者托管款 `300000` raw、未偿本金和费用均为 0。原 UUID 重放检查覆盖四个 Agent 与全部六个签名角色（含 verifier/refunder）的 `latest/pending` nonce，前后无新增交易，网关计数及 attempts 也无新增。公开记录见 [financial-evidence](evidence/tempo-20261012/financial-evidence.json)、[root canonical audit](evidence/tempo-20261012/root-acceptance.json)；完整独立验收与浏览器结果由 [Tempo 独立验收](tempo-root-acceptance-20261012.md) 汇总。

真实前端只读检查使用 `scripts/tempo-hosted-browser.ts`：`--check` 只读取本地 ready/bootstrap 配置，不登录、不查询 RPC、不启动模型调用。正式 `final` 检查前必须已有真实成功与确认财务证据；脚本只允许登录 challenge/login POST 与 GET，签名由 Node 中的本次 owner 钱包提供，前后模型计数须一致。Unknown 后的运营补偿与独立终止不会被当成成功任务、还款或违约；后续成功任务必须提供自己的交付、结算与信誉证据。

合约本地测试、受控模型回归、真实供应商响应、独立 Docker 隐藏测试与 Tempo canonical 链上回执分开报告。公开网站、真实扩展钱包、比赛正式提交与主网资金使用仍需另行授权及验收。

2026-10-13 GameFi 第一轮在同一 owner 原 3 局限制内运行真实 K2.6 德州：第一局格式无效，后两局平台赢家，测试 Actor 未获奖，余额 guard 正确阻止任务。该轮 `.data/tempo-gamefi-20261013/` journal 与[原记录](tempo-gamefi-runtime-20261013.md)保留。用户批准追加最多 6 局后，使用 `.data/tempo-gamefi-extra-20261013/` 独立授权与 journal，实际 4 局完成参赛 Actor73 的 PathUSD 奖金+原自有预存支付 Task7，以及 Actor74 的真实奖励 tokens 消费完成 Task8；两者独立 Pi/Docker Arena 验收及 Tempo 结算成功、debt0、cash各150000、信誉530/C，未借款或产生还款信誉，剩余两局不执行。见[追加运行与幂等命令](tempo-gamefi-extra-runtime-20261013.md)及[已批准预算方案](tempo-gamefi-additional-test-plan-20261013.md)。核心五单与补偿历史不变；追加验收时3028使用`.next-tempo-gamefi-extra-2`，后台8794加载原私有授权，固定UTC07:28:04.166截止后禁止新增名额。


## 2026-10-13 源代码同步升级

[本轮同步范围](tempo-upstream-sync-20261013.md)迁入新工作台、只填名称创建、单独配置模型预算、内联资金/练习、身份凭证和持久个人目标；五类专家仅分析输入资料，未接入 RPC/Web 工具。源目录快照之后的自动查链仍未迁入。原 Tempo 核心、补偿与 GameFi journal/证据保留，本轮不新增实网业务或付费模型调用。

`tempo-hosted-runtime.ts start DIRECTORY BOOTSTRAP --recover` 会启动两条独立 goal relay，逻辑别名、实体模型及响应模型按原 catalog 绑定。goal 使用 task0、cash-only，每次 10000 / 20000 raw，最多七次调用，并服从原预算和固定 deadline；没有报酬或信誉结算。新目录和 goal 端口独立于旧 fixed/allowance/planner。原五个命名端口重启保留，同 refunder 角色的各 relay 退款共用串行队列。

升级 supervisor 前需确认所有 Agent 没有 activeRequestId 且没有 Queued/Running run。完整重启会原样保存并恢复 `testSponsorshipFile` 的原 file/digest/grantId，与 DB 原授权校验一致；固定 07:28:04.166Z 到期不变、四次 admission 不重置、剩余两局不执行。已有未配置 goals 的旧配置仍可加载，但不允许发送个人目标。配置和暂停/取消/Unknown 恢复不修改已保存的原 UUID 或付款 handle。

新版前端构建为 `.next-upstream-sync-20261013-2`，实际运行地址仍为本地3028，hosted8794。此版本上线本地后可查看新 Dashboard/finance/arena，受控截图与实网历史证据分开；详见[迁移机器证据](evidence/upstream-sync-20261013/migration-evidence.json)。


## 2026-10-13 第二轮源代码同步

[第二轮同步说明](tempo-upstream-sync-round2-20261013.md)迁入当前链地址/交易只读预取与持久凭证、过期 goal 付款作废恢复及 Magpie 状态动画。Tempo runtime 的 goals 默认 `chainLookup:true`；旧 goal session 的 `lookupEnabled`/research/付款 handle 按原字节恢复，不把升级后的能力加进已开始的旧任务。模型没有任意网络或交易工具，有限主机查链只使用配置的42431 RPC/Sourcify，未配置能力时 UI 如实显示。

费用从真实 PathUSD feeToken/feePayer→feeManager 唯一 Transfer 读取，native余额占位不作可用余额。原Task7只读探针与受控付款恢复详见第二轮机器证据；本轮没有广播Tempo替换或业务交易，没有付费模型调用，也没有新增或续期游戏授权。8794新daemon沿原hosted.json和过期grant重载，原七个relay端口保持；3028最终独立构建目录见第二轮证据。
