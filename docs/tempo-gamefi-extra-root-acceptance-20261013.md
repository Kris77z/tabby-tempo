# Tempo GameFi 追加测试独立验收 · 2026-10-13

状态：**PASS — 本地前后端连接 Tempo Moderato 测试网的 GameFi 奖励消费闭环通过独立验收。** 两种真实奖励均完成 Pi → 独立 Arena → Tempo 结算；桌面及手机读取通过。未进行公开部署或主网验收。

用户已明确批准最多追加 6 局，仍由 GPT-6.1 Sol ultra 执行、主 Agent 验收。范围为本地前后端连接 Tempo Moderato 测试网 42431，不含公开部署或主网。

## 授权与基线

- 沿用 owner `0x0934292261CcAF2a76862E9F8C1B3301adac71c8` 和参赛 Agent 73/74，累计计数从 3 增至最多 9；不重置、不换身份。
- 新增游戏最多 120 次模型调用、61440 输出 tokens、600000 raw（0.6）测试 PathUSD 奖池。输入用量据供应商响应记录；不把测试币奖池当作模型账单。
- 原 3 局、9 次响应和全部失败保留。上一轮 bot 43 获得 100000 raw cash 与 4096 推理额度，参赛 Agent 73/74 获奖为 0。
- 原现金预存为 20000 raw；任务原价 120000 raw，allowCredit=false，不补差、不降低报价。
- 旧核心与上一轮 GameFi 共 13 份证据摘要：`docs/evidence/tempo-gamefi-extra-20261013/root-before-extra.json`。

## 完成判据

1. 授权仅在既定测试链、本地 origin、原 owner/Actor 和固定时限内有效；同一串行持久 admission 控制累计次数，重启与重复 UUID 不增加可用额度。
2. 真实模型合法决定与随机可信回放决定赢家。Unknown 保留派发意图且禁止重派，不能预定赢家或转用平台 bot 奖励代替参赛 Agent 奖励。
3. 现金支路：参赛 Agent 实际获奖并入 cash，按原价运行任务，Pi 与独立 Arena 验收，Tempo 结算及适用信誉更新。
4. 额度支路：真实身份绑定 grant，按供应商实际 usage 消费，完成原 reward-task 的 Pi / Arena / Tempo 结算；额度不足时仅按原 UUID 补额恢复。
5. 核对实际业务事件与手续费，现金和额度两类资金不混用，不出现贷款或虚假还款记录；旧核心结果与余额无意外变化。
6. 最终原 UUID 重放无额外模型或交易，桌面/手机真实登录读取与链上状态一致，公开证据不含私密值。

额度耗尽而未达成时如实保留结果，不自动扩大本次授权。

## 已完成代码与本地验证

- 已审查 `test-sponsorship.ts`、服务 admission、daemon 接线、GameExecutor 固定 deadline 和当前 owner 的前端额度投影。
- 数据库将 run、累计计数和授权 admission 原子写入；独立审计镜像落盘后才允许启动执行。重启只从数据库补齐镜像，不重新授予额度；授权摘要变化或审计冲突拒绝启动。
- 主 Agent 独立运行 `test-sponsorship.test.ts` 4/4 通过：配置边界、并发第九局上限、原 UUID/重启不续额度、数据库先写而镜像失败的恢复、Unknown 占额、到期禁止新增。
- 主 Agent 独立运行 GameExecutor 的两个到期边界测试，2/2 通过：首个模型调用前过期则零模型调用；已完成手局过期后可恢复派奖且不改原手局记录、不增加模型调用。
- 执行器报告相关服务/授权/游戏回归 24/24、`typecheck:all` 和生产构建通过。本地测试与下面的真实网络证据分别记录。
- 独立检查已激活授权 `3b6116e1-ceb9-40f1-ad80-47b3df650a30`：原文件 SHA-256、数据库主记录与独立 admission 镜像完全匹配；首次观察仍为原 3 局、追加 admission 为 0。固定截止为 2026-10-13 15:28:04（Asia/Shanghai），重新启动不延长。
- 驱动恢复快审已修复三点：第六局保存后中断仍收取原 UUID；获奖后中断先消费已有奖励；额度不足恢复与最多两次网络恢复分别计数，不因重复运行自动补额。
- 实际启用时发现 Next 代理漏投影 `sponsorship`，导致后端已激活而浏览器无法看到额度。已补显式字段白名单，执行器代理测试 10/10，主 Agent 独立运行新增投影回归 1/1；真实前端代理随后取得原授权，未重新发放名额。当前服务使用 `.next-tempo-gamefi-extra-2`。

## 本轮真实结果

| 追加顺序 | 支路 / 请求 UUID | 真实结果 |
| --- | --- | --- |
| 1 | cash / `4aa3302f-d15c-460d-af27-7ff583eabfd2` | 73 独胜，现金奖励 100000 raw；2 个合法模型动作。 |
| 2 | credits / `031de2d5-91dc-4515-bacb-67ed8361ee92` | bot 43 获胜，73/74 未获本局额度。 |
| 3 | credits / `c72aaad1-6492-4504-874f-7eac7fa4674b` | bot 43 获胜，74 未获本局额度。 |
| 4 | credits / `fcf33e86-a6dd-4e6c-97ed-d2589e5c706b` | 74 独胜，身份绑定额度 4096 tokens。 |

四局全部终态，6 次直接 Moonshot Kimi K2.6 游戏调用全为 Applied，合计 2551 prompt + 56 completion = 2607 tokens；没有 Unknown 或缺失 usage。新增现金奖池实际仅 100000 raw（0.1 PathUSD）。原 owner 累计 7 局，追加使用 4/6，剩余 2 局停止消费。主 Agent 从私有请求哈希、逐步可见牌局和动作重建完整可信回放，赢家与派奖记录一致。

现金任务 UUID `519303e1-cb08-4631-8aec-2ea7ec340c83` 使用原自有预存 20000 + 实得奖金 100000，支付原价 120000 raw；`fromCredit=0`。Task 7 / `balanced-brackets` 经 Pi 一次真实模型调用、公共样例工具及 Arena Docker 的 6 个隐藏用例通过，结算收入 150000 raw。最终 cash 为 150000 raw。

额度任务 UUID `3ec27411-3b6c-4212-884c-af2d84939b01` 只消费 74 实际获奖额度。账本先预留 1829 tokens，按供应商实际 228 prompt + 67 completion = 295 tokens 结账，剩余 3801，预留归零；没有转用 bot 奖励。Task 8 / `word-frequency` 经 Pi 一次模型调用、公共样例工具和 Arena Docker 的 4 个隐藏用例通过，结算收入 150000 raw。最终 cash 为 150000 raw。

现金任务经 Magpie，请求别名 `cheap/kimi-k2.6` 对应实际响应 `kimi-k2.6`，usage 为 336 tokens；额度任务及游戏直接访问 Moonshot。不能把两种调用通道统称为 Magpie。本轮新增总计 8 次模型调用、3238 tokens（含上述 6 次游戏及 2 次任务），供应商货币账单没有在此估算。

## 独立证据与不重复执行

- `docs/evidence/tempo-gamefi-extra-20261013/root-game-replay.json`：逐动作、请求/响应摘要及真实赢家复核。
- `root-credit-audit.json`：grant 与私有可信回放绑定、每个身份的分配和真实 usage。bot 累计额度 12288，消费为 0；74 余额 3801。
- `root-task-audit.json`：Pi 候选代码摘要、公共工具、真实模型响应，以及 Arena 当前只读结果与原签名提交结果一致。
- `root-authorization-audit.json`：原 grant、数据库和独立 admission 镜像一致，序号 1–4，各原 UUID 与授权摘要匹配；无追加授予。
- `financial-evidence.json`：重复提交原 4 个游戏与 2 个任务 UUID，12 个签名地址 latest/pending nonce 及直接调用/Magpie 两个调用域前后完全相同，没有额外交易或模型请求。
- `root-chain-snapshot.json`：固定 block `39348703` / `0x8b05da2700703127d6398e11f653ca8240b688e994ded2e992df3ad1e295eaac`。Task 7/8 分别归属 73/74，状态 3，托管余额 0，全部贷款字段为 0；两 Actor cash 各 150000、task-success 各 1、真实及镜像 repayment/default 为 0。旧 Actor 46/47/48/49 余额与核心池余额 10058800 raw、未偿债务 0 均未变。
- `root-receipt-audit.json`：重新读取 3 笔派奖转账/approve/deposit 及 Task 7 的 accept/payment/settlement、Task 8 的 accept/settlement；每笔 receipt 成功、链 ID 正确且 blockHash 与 canonical 区块相同。精确筛选 PathUSD 业务对手方，避免混入同币手续费 Transfer。`ProviderPaid` 为 cash 120000 / credit 0；两笔 `TaskSettled` 的 repaid/slashed 为 0，residual 为 150000。

Task 7 结算：`0xba0f80b900a447684dad2fe20c1442ee9fa2b5e912d95ecda584049723fbd187`。

Task 8 结算：`0x62eea74315e1abd27b7991d521b944742046b8641987158c7507ec5d53b774d7`。

两个新 Actor 的读取信誉为 530/C。这里发生的是任务成功反馈，不是偿还贷款，不能宣称产生了还款本金或费用。此前核心借贷验收及上一轮游戏失败/对手获奖记录均独立保留。

## 页面与证据收口

`frontend/acceptance/tempo-gamefi-extra-20261013/root-browser.json` 汇总真实浏览器验收。桌面 1440×1000 与 Pixel 5 手机视图均通过：使用原 owner 对本地登录 challenge 的真实签名、真实 HTTP、精确 identity 校验，所有游戏/任务/交易写入被浏览器检查脚本禁止。每个视图核对 73/74 的请求终态、cash/debt/成功/还款数量与独立链上快照相同；额度显示累计 7/9、剩余 2，奖励类型与对应 Actor 绑定；无页面异常或横向溢出。截图已人工检查。

首轮手机 74 的财务读取一次返回 `HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE`，页面如实显示未确认，未冒充已核验。保留 `root-browser-first-attempt.json`；仅重试该手机/Actor 的只读检查后成功，记录于 `root-browser-mobile-retry.json`。这说明测试网读取仍可能暂时不可用，不能把一次成功验收当作公网服务可用性承诺。此次读取问题没有重发任何模型或交易。

`root-artifact-check.json` 核对原 13 份核心与上一轮 GameFi 证据 SHA-256 均未变；扫描新公开 JSON 与相关文档，对私密值没有命中。幂等前后快照相等，独立重建的游戏 session 摘要与执行器证据一致。私密牌堆、完整玩家视图、模型正文、密钥和签名交易原文仍只在私有运行目录。

当前本地入口为 `http://127.0.0.1:3028/dashboard?section=arena`。本轮目标已经完成，不再执行剩余两局；固定授权到期仍为 2026-10-13 15:28:04（Asia/Shanghai）。启动与原授权恢复规则见 [追加实跑记录](tempo-gamefi-extra-runtime-20261013.md)。
