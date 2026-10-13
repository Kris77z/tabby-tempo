# 德州 Arena：免费参赛与赞助推理预算

更新至 2026-10-05：免费双人德州已支持本机运营网页开局、赞助测试 USDC 与 Kimi 推理额度奖励。游戏不是借贷入口：虚拟筹码不从钱包扣款、不可兑换，也不作为任务 reward 或信用抵押。奖金实际到账后，Agent 才能将其用于推理消费。

## 已实现的规则范围

真实比赛采用服务端固定两个 Agent 的单手无上限德州扑克，双方等额初始虚拟筹码；不引入多人桌、赛事编排、报名费、抽水或游戏授信。支持翻牌前、翻牌、转牌、河牌，弃牌、过牌、跟注、加注和全下，由独立规则引擎判定结果。下注金额是当前街的累计金额，筹码使用安全整数。

规则参考 [Poker TDA 官方规则](https://www.pokertda.com/view-poker-tda-rules/) 的双人行动次序和下注规则；线上动作使用明确的结构化金额，不模拟线下口头声明、筹码动作歧义或完整赛事裁决流程。root已独立验收规则23项和奖励集成4项，具体证据见下文。

## 隐藏信息与随机性

裁判持完整牌堆；模型/策略只能取得自己的底牌和公开局面。生产创建入口使用系统密码学随机洗牌，固定牌堆只用于受控测试。完整重放数据保存在可信私有文件，不发送给对手或公开页面。局末审计与牌局中公开信息分开。

系统随机洗牌依赖裁判诚实，不等于去中心化可验证随机或防裁判作弊。对外真实奖池如需要消除这一信任假设，另设计可验证发牌；本地测试不会宣称已具备它。

## 第一阶段：本地奖励验证口径

第一阶段使用独立 Anvil/mock-USDC 和受控 Agent 策略。免费指无报名费，演示策略不调用付费模型；不能据此宣称真实 LLM 已会打德州。

赞助方预置固定测试奖励，独胜全额、平局分配；只有可信重放确认的终局才能领奖。同局重复结算复用原签名交易和记录，不新增付款。不确定转账保留原交易，不以新 nonce 重发。奖励、虚拟筹码和模型费用三本记录分开。

获奖 Agent 将奖励存入现有 AgentAccount，再以 `taskId=0` 通过 SDK/Relay 购买受控推理；验收应证明奖励到账、实际现金扣款、`fromCredit=0`、债务不变与资金守恒。关闭本地链后的文件只能离线复核，不声称可恢复原链。

LLM token 奖励指可消费的推理额度，不是加密代币，也不是 API key。网关 usage 统计本身不构成额度余额；2026-10-05 首版已由运营方发行 Kimi 专用额度，固定模型、实际 usage 扣减及防重复消费，见下节。

## Magpie 的可复用部分

已核对项目锁定的官方 commit `d6096e2fb1710ba123c0d4f59ed8e7e22165de07`，不是根据当前浮动版本推断：

- [access/limit.go](https://github.com/yetone/magpie/blob/d6096e2fb1710ba123c0d4f59ed8e7e22165de07/internal/access/limit.go)：每个 gateway key 的日/周/月 token 或估算成本上限。
- [budget/budget.go](https://github.com/yetone/magpie/blob/d6096e2fb1710ba123c0d4f59ed8e7e22165de07/internal/budget/budget.go)：请求预留、usage 结算和剩余额度查询，可作为消费侧控制；限额按周期重置，预留为进程内状态，预估允许约一次调用超额，未知价格不计成本。本机没有有效 gateway key 的请求不受该限制。

因此可复用调用方 key、路由与用量控制，但不能把周期上限直接当作比赛赢来的累计余额。奖励发行、唯一比赛/兑换 ID、持久余额和原子消费/恢复由本项目的 InferenceRewardLedger 承担，已实现 Kimi 专用额度。USDC 继续走原现金支付；两者分别记账，不构成通用兑换平台。


## 本机网页开局、额度与恢复（2026-10-05）

`/arena` 使用同源 `/api/arena/gamefi` 发起真实 Kimi 德州；服务端固定两位运营 Agent 与原 CLI 参数。请求只含 start/recover、UUID 和奖励类型，不接受浏览器提供路径、模型、RPC、钱包或赢家。网页显示阶段、原 ID 恢复与近期比赛；`/arena/holdem` 仍提供历史只读回放。入口限定本机 loopback 和匹配 Origin，尚无远程公开报名或任意钱包登录。

额度分支由可信裁判重放自己的私有终局并重新计算赢家，按唯一 grantId/matchId/replayDigest 发放每局总计 4096 Kimi token；独胜全额，平局各 2048。`/api/arena/credits` 由 `GAMEFI_CREDIT_ACCOUNT_AGENT_ID` 固定消费身份，不接受客户端选择账户。调用前保存兑换意图并预留 UTF-8 输入字节 + 256 framing token + 输出上限，完成后用供应商实际 input/output usage 扣减；网页最多输出 128 token。缺 usage、模型不匹配或结果未知保持预留，同 ID 返回原记录/缓存，不再调用；超额 usage 保留实际扣减与欠额，并冻结继续消费。

runner 的全局 writer 锁覆盖模型、奖励和消费阶段，额度 ledger 也持久保存余额及兑换。恢复沿用原 UUID、evidence、签名交易与调用记录；未保存可信终局的未知模型局不重开，未知奖励推理不重发。四游戏练习另外保存规则 replay、日志、席位和幂等回复，默认 `.data/arena-freeplay.json` 或 `ARENA_PLAY_STATE_PATH`；重启可恢复，练习不发奖励。

运营配置和执行边界见[网页 runner](gamefi-runner.md)、[额度规则](../services/arena/src/inference-rewards/README.md)与[练习 API](free-arena.md)。网页和 CLI 均复用原奖励政策，不增加游戏贷款、通用兑换平台或可验证随机。

本轮真实额度局 `b3f24ce8-4270-4a05-baf6-c80675237fc3` 已向 Agent1999 发放 4096 token，实际 Kimi 消费 24（16 输入/8 输出），余额 4072；原兑换 ID 返回缓存。2026-10-06 新 USDC 局已完成独立验收：Agent1998获0.1测试USDC，原存款签名确认入cash，消费0.01完成1次真实Kimi推理（21输入+8输出=29 tokens），cash剩0.09、借款0。root fresh核对存款/付款canonical回执、付款块cash及本地原始模型响应；原对局报告未变，没有重复派奖。RPC仍可能间歇失败，本次成功不代表网络问题已消失。汇总由 root 更新[本轮验收](../demo-output/gamefi-complete-20261005-root/root-acceptance.json)。控制台桌面/手机 16 项浏览器测试为受控接口拦截，不调用真实模型或提交交易，见[验证说明](../frontend/acceptance/gamefi-console/verification.md)。

## 本地运行与历史验收（2026-10-04）

需要 Node 22.19+、已安装项目依赖、PATH 中的 Foundry forge/anvil 和已构建的合约。此演示不执行代码判题，因此不需要启动 Docker；不访问公网模型或 Monad。

```sh
forge build --root contracts --offline --skip-lint
node --import tsx --test services/arena/test/holdem-evaluator.test.ts services/arena/test/holdem-rules.test.ts
node --import tsx --test scripts/test/holdem.test.ts
node --import tsx scripts/holdem-demo.ts --output /absolute/new-holdem-output
```

入口拒绝覆盖已有输出，结束关闭本次服务和 Anvil。规则测试已包含在 Arena workspace 的测试通配符内；`scripts/test/holdem.test.ts` 仍需单独执行，不能以 `test:all` 代替。

root独立运行与离线复核见 [report](../demo-output/holdem-20261004-root/report.json)、[原始回执](../demo-output/holdem-20261004-root/chain-evidence.json)、[独立验收](../demo-output/holdem-20261004-root/root-acceptance.json)。随机牌局0号Agent获胜，赞助100000原始单位（0.1 mock-USDC），全部存入cash后支付10000购买受控推理，cash净增90000（0.09），未偿0。fixture预置该Agent cash40000，所以最终cash130000；不将原有余额算作奖励。平局时两方各获50000，各可购买一次推理，已通过独立测试。

root核对可信重放、原签名、奖励/入金/ProviderPaid及ERC-20 Transfer回执、余额增量和私有文件权限。规则23/23、脚本集成4/4、根typecheck通过；测试覆盖重复领奖、已广播回复丢失复用原签名、Delivered缓存恢复不再调用模型、未知推理暂停，以及未终局/非法重放拒绝。

`report.json` 与 `chain-evidence.json` 不含隐藏底牌、完整牌堆或原签名bytes。`.private/` 为0700，可信终局replay和交易journal为0600。可信重放只能证明给定牌堆/动作的规则一致性，不证明裁判未作弊或远程提交者身份。此本地脚本不是对外领奖API；不能直接将任意玩家提交的replay作为派奖依据。

本地阶段是等额起始筹码、单手双人、无ante/rake的范围；matched pot必为偶数，奇数分配仅有独立helper测试，不宣传为已发生场景。该阶段未包含真实模型、Monad奖励及页面；后续实现入口见下文。该本地阶段没有多人 side pot、赛事管理或 LLM 额度兑换；当前额度实现见上节。未知调用保持暂停，不用额外付费请求绕过。

## 真实模型、Monad 与浏览器入口

`holdem-live.ts` 使用相同裁判与隐藏信息视图，让 Kimi 返回结构化动作。每局最多20次调用、每次最多512输出token、总时限10分钟；非法动作、未知请求或超时停止，不伪造动作或派奖。模型决策由赞助方账号支付，免费参赛不意味着上游免费。该入口的本地奖励仍为mock-USDC；同局Monad奖励由下述独立步骤执行。

```sh
# 新局：先检查配置，明确执行时才调用真实模型。
node --import tsx scripts/holdem-live.ts --config /absolute/private/demo.json --output /absolute/new-live-output --execute
# 同一终局：默认只读预检；加 --execute 才发赞助测试USDC并存入cash。
node --import tsx scripts/holdem-monad.ts --config /absolute/private/holdem.json --rpc-url-file /absolute/private/rpc-url --rpc-transport direct
node --import tsx scripts/holdem-monad.ts --config /absolute/private/holdem.json --rpc-url-file /absolute/private/rpc-url --rpc-transport direct --execute
# 已确认入账：默认只读；execute用奖金cash购买一次真实Kimi推理。
node --import tsx scripts/holdem-monad-purchase.ts --config /absolute/private/holdem.json --rpc-url-file /absolute/private/rpc-url --rpc-transport direct --execute
```

Monad配置复用现有部署，新增明确的赞助者及两个专用玩家（`wallet`、`keyFile`、`agentId`），详见脚本的`HoldemMonadConfig`。配置、key和私有RPC文件放项目外并限制权限，不把原演示中的冻结身份重新启用。链ID固定10143、USDC固定6位小数。RPC直连与模型系统HTTPS代理分别选择。

固定赞助奖100000原始单位（0.1测试USDC），独胜全部发给胜者，平局每人50000；获奖方将奖金入AgentAccount。每名获奖方最多购买一次10000原始单位（0.01测试USDC）的K2.6短推理，128输出token、无工具、无付费重试，`taskId=0/fromCredit=0`。这是运营固定报价，不等于供应商账单。公开报告和私有回放摘要绑定；奖项、入金和支付分别保存原交易、canonical回执及余额变化。恢复始终使用同一source目录，不另建输出重发。已Delivered缓存可恢复；结果未知保持暂停，不再签名或调用模型。

浏览器入口`/arena/holdem`提供公开逐步回放、终局、模型用量与资金记录。服务端只读以下指定公开文件并校验同局摘要，不接受浏览器指定文件路径；不会把底牌、提示词、完整牌堆、私钥、RPC密钥或原签名发给浏览器。

```sh
FRONTEND_MODE=fixture \
HOLDEM_REPORT_PATH=/absolute/live-output/report.json \
HOLDEM_DELIVERY_REPORT_PATH=/absolute/live-output/monad-delivery-report.json \
HOLDEM_PURCHASE_REPORT_PATH=/absolute/live-output/monad-purchase-report.json \
npm run start --workspace @agentfuel/frontend -- --port 3015
```

需先构建frontend；未配置报告时只展示明确标注的fixture。`/arena/holdem` 是公开证据的只读回放；新 `/arena` 则由本机运营用户从网页调用固定 CLI 流程。两者都不是远程公开报名、任意钱包连入或“粘贴任意提示词参赛”产品。缺少某阶段文件只显示等待，不把牌局结束当作Monad消费完成。页面不实时查询链，root验收脚本另执行canonical核验。

定向验证：`node --import tsx --test scripts/test/holdem-live.test.ts scripts/test/holdem-monad.test.ts scripts/test/holdem-monad-purchase.test.ts`；前端运行方式和browser测试见[frontend README](../frontend/README.md)。

## 历史验收：真实对局与 Monad 奖金消费（2026-10-04）

root实际执行并独立验收同一比赛`live-78db347f-d8de-42e2-a211-bde1b1a8b187`：

- 真实Kimi K2.6只调用1次，HTTP200、280 tokens。座位1自行弃牌，座位2获胜；没有强制改动作或为展示而追加调用。争夺奖池10虚拟筹码，退款5，最终995/1005。此证据证明有界模型决策及合法终局，不证明双方多轮对抗水平。
- 同局映射到专用Monad身份1998/1999，原有演示身份与冻结状态不改。赞助者向胜者1999发100000原始单位USDC，approve后全部deposit进入cash。root重新查询三笔canonical回执，核对原签名、Transfer/CashCredited与固定区块余额。
- 胜者以`taskId=0`支付10000 cash给Provider，真实K2.6返回约定短句，HTTP200、21输入/8输出/29总tokens。`fromCredit=0`，cash100000→90000、provider增加10000、未偿0。root独立比对物理请求/响应、SDK签名、实际付款与Transfer事件；原主角1977 cash仍134958。
- `/arena/holdem`已展示公开回放、模型调用、同局Monad奖励/入金/消费及交易链接。页面只读文件，缺阶段、未知状态、fixture与真实结果分别标明；不暴露隐藏信息和签名。

证据：[真实牌局独立验收](../demo-output/holdem-live-20261004-root/root-live-acceptance.json)、[Monad奖励独立验收](../demo-output/holdem-live-20261004-root/root-monad-acceptance.json)、[真实奖后推理独立验收](../demo-output/holdem-live-20261004-root/root-purchase-acceptance.json)。公开运行报告为同目录的`report.json`、`monad-delivery-report.json`、`monad-purchase-report.json`。模型决策费用由赞助方上游账号支付；中奖消费的0.01USDC为运营报价。两次真实调用共309 tokens，未核供应商账单。

本次Alchemy RPC最终走direct，root执行入口将请求间隔设为500ms；模型调用单独走系统HTTPS代理。此前发奖前曾中断一次、独立读链曾出现TLS ECONNRESET；后续完成并重新核验canonical回执，不把这次成功当作长期稳定性保证。Node必须使用22.19+。

此节记录 2026-10-04 的 CLI 与只读页面验收范围，不代表当前入口只能只读；2026-10-05 网页开局与 Kimi 额度已实现，见上节。公开远程报名、任意提示词参赛、多手真实赛事和可验证随机仍未开放，没有新增游戏贷款或通用奖励钱包。

[本轮总验收报告](../demo-output/holdem-live-20261004-root/root-acceptance.json)汇总三个独立验收、49项root定向测试及类型检查。前端实现方完成桌面/手机6项和原档案4项浏览器验证，root实际刷新/终局回放并查看[桌面资金面板](../frontend/acceptance/holdem/monad-complete-panel-desktop.png)与[手机资金面板](../frontend/acceptance/holdem/monad-complete-panel-mobile.png)。该历史预览当时使用本机 `http://127.0.0.1:3015/arena/holdem`，并非公网托管；当前 runner 配置与启动见上文运行文档。
