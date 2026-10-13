# Tempo GameFi 追加验收实跑 · 2026-10-13

已用批准的追加额度中的 **4/6 局**完成两条参赛托管 Agent 奖励消费路径，剩余两局不再执行。现金 Actor 73 独胜获得 `100000` raw PathUSD，结合原自有预存 `20000` raw，以原 `120000` raw 固定报价完成 Task 7；额度 Actor 74 真正获得 4096 tokens，消费 295 tokens 完成 reward-task / Task 8。两任务经 Pi、公共样例工具和独立 Docker Arena 验收后实际在 Tempo 结算，无贷款。

网络为 Tempo Moderato `42431`，PathUSD（6 decimals）。当前仅本机 `http://127.0.0.1:3028/dashboard?section=arena` 连接真实测试网，没有公开部署、主网资产或比赛提交。四种本地练习范围仍见[第一轮 GameFi 运行说明](tempo-gamefi-runtime-20261013.md)，其三局失败/输局与证据原样保留；原核心五单及两份 Unknown 补偿也保留。

## 授权与实际使用

单次授权 UUID `3b6116e1-ceb9-40f1-ad80-47b3df650a30`，原 owner `0x0934292261CcAF2a76862E9F8C1B3301adac71c8`，固定有效期 UTC `2026-10-13 01:28:04.166` 至 `07:28:04.166`。原累计计数 3 未重置，追加 4 后为 7；其他 owner 默认累计最多 3 局，平台最多 100 局。绑定原 hosted Actor 73/74、原 model/strategy、per-run `120000` / total `300000` / `allowCredit=false`，不新增 owner、Actor、cash 资助或修改报价。

| 追加顺序 | 真实请求 UUID | 参赛 Actor 结果 |
| --- | --- | --- |
| 1，cash | `4aa3302f-d15c-460d-af27-7ff583eabfd2` | 73 独胜，奖 `100000` raw PathUSD 入其 cash，之后停止该支路游戏。 |
| 2，credits | `031de2d5-91dc-4515-bacb-67ed8361ee92` | 74 未获奖，平台对手获 4096 tokens。 |
| 3，credits | `c72aaad1-6492-4504-874f-7eac7fa4674b` | 74 未获奖，平台对手获 4096 tokens。 |
| 4，credits | `fcf33e86-a6dd-4e6c-97ed-d2589e5c706b` | 74 独胜，获 4096 tokens，之后停止游戏并消费原奖励。 |

六次游戏模型响应全部合法应用，实际 usage 合计 2607 tokens，其中 completion 56；追加现金奖池实际支出 `100000` raw，即 0.1 测试 PathUSD。获奖在真实随机牌局及模型动作之后确定，策略、牌堆和动作校验器未改变。前次无效模型响应和输局不改写。

授权上限为 6 局 / 120 游戏调用 / 61440 游戏输出 tokens / `600000` raw 现金奖池。输入用量另计。游戏和 reward-task 经官方 Moonshot / system HTTPS proxy：新增 6 次游戏调用及 1 次奖励任务调用；现金任务经原 Magpie 新增 1 次物理调用。两路共新增 8 次真实响应，无新 Unknown。人民币供应商账单未核对，测试 PathUSD 奖池及任务固定价不能当作模型实际账单。

## 任务与最终财务

现金任务原 UUID `519303e1-cb08-4631-8aec-2ea7ec340c83` / Task 7，`fromCash=120000`、`fromCredit=0`；结算交易 `0xba0f80b900a447684dad2fe20c1442ee9fa2b5e912d95ecda584049723fbd187`。这次消费含原自有预存，不能称为纯游戏奖金独立支付。

额度任务原 UUID `3ec27411-3b6c-4212-884c-af2d84939b01` / Task 8，只消费身份绑定的真实奖励 tokens；供应商实际 `prompt=228`、`completion=67`、`total=295`，剩余 3801、预留 0。结算交易 `0x62eea74315e1abd27b7991d521b944742046b8641987158c7507ec5d53b774d7`。没有 cash 推理付款或信用补额。平台对手的累计 12288 tokens 保留在原 74/43 ledger，未转移给 74，也未消费。

两任务各一轮真实模型求解及公共工具检查；独立 Docker Arena 对 Task 7 检查 6 个隐藏用例、Task 8 检查 4 个，均通过。最终两位 Actor 各 cash `150000` raw、debt 0、InferScore `530/C`、成功 1、还款 0、违约 0。游戏没有贷款或还款信誉；提升来自任务成功反馈。

原四个追加游戏与两个任务 UUID 经真实 API 终态重放一致。六个 hosted Actor、平台对手及运营签名角色共 12 个地址的 `latest/pending` nonce 前后相同，直接 Moonshot 的 game/credit journal 摘要、Magpie accepted/physical 计数和 journal 摘要也一致。此时 driver 已退出，额外模型与 RPC 操作停止，链上回执与网页最终检查由主 Agent 独立完成。

## 实现与恢复

`test-sponsorship.ts` 验证私有 0600 单次授权文件，限制 loopback + `42431` + PathUSD、原 owner/Actor、固定截止与已批上限。`HostedService` 在既有单写者数据库原子提交 run、累计计数与授权 admission，再把独立 mirror 刷盘，完成后才启动 executor。数据库为 admission 真相来源；写 mirror 前中断可在同 UUID 恢复，冲突 mirror 或换授权摘要被拒绝，不能重复领取六局。旧终态请求在到期后仍可取缓存；已验证 Complete 手牌仍可只完成派奖，新模型派发受固定游戏 deadline 限制。

前端 snapshot 只投影当前 owner 的累计/剩余额度和授权截止，并固定两个授权 Actor 的奖励分支。第一次 enable 暴露了 Next proxy 白名单未传 sponsorship 的漏接；服务已正确启用但前端看不到授权。修复显式嵌套公开投影后，使用 `.next-tempo-gamefi-extra-2` 新生产构建重启 3028，实际 API 激活检查通过；没有重建授权或更改 expiry。当前前端 PID 在启动后观察为 `7307`，日志 `.data/tempo-gamefi-extra-20261013/frontend-2.log`。

service / grant / GameExecutor 定向回归 24/24、前端 proxy 10/10、根目录与前端 `typecheck:all`、新生产构建通过。到期回归实际验证首次模型派发前到期零调用，以及 Complete 手局过期后只恢复派奖。

私有追加 journal 为 `.data/tempo-gamefi-extra-20261013/acceptance/`；`authorization/session.json` 的 SHA-256 为 `7e90a550b4caef40b7008af1a12ea25fd2606dd6c77a601cbbcc75ddf96c2783`，其独立 admission mirror 在 `authorization/admissions/session.json`。再次 `prepare` 不换 UUID/expiry；首次 acceptance 保存后授权文件尚未写入的中断，会重建同一个已保存 grant。第六局 UUID 已保存后的中断也先收取原局，额度仅限制新建 UUID；奖励终态与任务启动之间中断时先消费实际奖励，避免多打一局。合法 `INFERENCE_FUNDING_REQUIRED` 仅在 Actor 新获正额度后恢复原任务，与最多两次网络恢复分别计数，本次未需要该补额路径。

完整 `tempo-hosted-runtime` supervisor 重启会重写 `hosted.json`，可能移除可选 `testSponsorshipFile`。若需重新挂载，仅用上述原追加目录执行 `enable --recover`，挂回保存的同一 grant、摘要、原 admission 和固定 expiry；不能另建目录/授权、重置计数或以 `prepare` 续领。本轮四局和两任务已经完成，重新挂载后也不执行剩余两局。日常仅重载托管子服务的 SIGUSR2 沿用当前配置。

仅刷新财务/核对终态重放，不创建游戏的命令：

```sh
PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:$PATH \
AGENTFUEL_RPC_RETRY_READ_503=1 AGENTFUEL_RPC_CALL_GAS_LIMIT=1000000 \
node --import tsx scripts/tempo-gamefi-additional-acceptance.ts \
  .data/tempo-20261012/runtime .data/tempo-gamefi-extra-20261013/acceptance finance --recover

PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:$PATH \
AGENTFUEL_RPC_RETRY_READ_503=1 AGENTFUEL_RPC_CALL_GAS_LIMIT=1000000 \
node --import tsx scripts/tempo-gamefi-additional-acceptance.ts \
  .data/tempo-20261012/runtime .data/tempo-gamefi-extra-20261013/acceptance evidence --recover
```

finance、独立链审计与登录网页读取应分时执行，避免争用 RPC。未收口 Unknown 的 UUID 不进行模型重派，`evidence` 会保留状态并只 POST 真正终态 UUID。

- [追加授权与只读 preflight](evidence/tempo-gamefi-extra-20261013/authorization-evidence.json)
- [实际游戏、财务、奖励 ledger 与幂等证据](evidence/tempo-gamefi-extra-20261013/financial-evidence.json)
- [主 Agent 独立追加验收](tempo-gamefi-extra-root-acceptance-20261013.md)
- [原预算方案及批准记录](tempo-gamefi-additional-test-plan-20261013.md)

公开文件仅含身份、金额、合法回放及摘要，不含私钥、认证 token、原始牌堆/玩家完整视图、模型正文或原签名交易字节。四种练习、平台赢家奖金、参赛 Agent 奖金、推理消费与任务成功反馈仍分别计数。
