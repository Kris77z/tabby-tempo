# 固定价受限求解服务 B

此固定价服务复用原四合约、SDK `forTask`、Relay quote/pay/refund和独立Arena，不改融资协议。服务 `infercredit/solve-fixed` / `pi-fixed-v1`只接受一个已经Assigned、属于现有四题白名单的任务；默认仍是sum-integers。固定价购买最多N轮求解，提前成功不返未用轮差；没有逐轮储值余额或按tokens返差价。旧 `runProgrammingLoop` 保持纯cash路径。

请求包含按白名单题目选择的固定公开prompt和版本1 `solve`：`problemId`只接受sum-integers、unique-sorted、balanced-brackets、word-frequency，另有显式tiers数组、`maxRounds`（1..3）、`maxToolCalls`（1..4）、`maxCompletionTokens`（1..2048）、绝对`deadlineMs`（新报价最多未来5分钟）。tiers长度必须等于maxRounds；无外部tier报价，内部模型按指定轮档执行。任何额外字段、任意输入/prompt或不支持的工具均拒绝。每轮物理model和token cap由宿主设置，模型不能覆盖。预算仅一次quote.price，不包括gas或上游模型账单。

`FixedPriceSolvingRelay`是单独实例/配置的新子类，`FixedPriceRefunder`限制原全价退款；原 `npm run relay` 仍启动普通chat Relay，不自动启用求解服务。固定服务配置不设service.tiers，`service.upstreams`恰好为name cheap/strong两条物理模型路线，price是整个服务价格。专用payTo必须等于Manager已配置refunder；密钥仅在Relay运营侧，不能传给provider Pi、agent LoopConfig或模型。SDK和agent钱包也不在provider求解模块中。

未付quote不写task claim。确认原ProviderPaid后原子绑定task→paymentId/requestDigest；新digest拒绝，同原请求只恢复原quote/handle。client在付款前await原子保存PaymentHandle和全价预留，用deadline `beforePayment`阻止新签/广播；不把已付未知结果视为免费。provider在原paymentId目录保存Pi transcript、每轮Dispatching/Responded、原物理请求响应及公开工具结果；每次新模型请求前验证Assigned、链上deadline与当前身份。Dispatching缺响应永远不自动重发，provider承担不确定成本并可运营全退。Responded或已完成样例的恢复只重放持久结果，不新增模型调用。

交付是公开样例通过的完整code/codeHash及有界run，不保证hidden tests。receipt.model/upstream/usage仅是**最后一轮摘要**；完整各轮物理请求model、上游自报response.model和usage保存在run，不能把不同模型总tokens当作最后模型的成本。agent复核实际Account payment、原成功ProviderPaid receipt/calldata/签名人/nonce与报价，然后独立重跑同公开样例；恢复时仍绑定candidate、codeHash、已通过样例和原提交payload。

公开工具使用DockerExecutor，每题只有一个固定公开样例：sum为`[4,8,-3] → 9`，unique为`[4,8,4,-3] → [-3,4,8]`，brackets为`"(()){[]}" → true`，frequency为`["pear","apple","pear"] → {"pear":2,"apple":1}`。样例与Arena隐藏输入分离；模型工具只有code参数，不能选择stdin、文件、网络或结算。新题提示复用problemCatalog公开描述，默认sum原提示字节不变。最终提交与cash共用 `submission.ts`，由独立Arena/settler完成hidden tests和真实TaskSettled，才记录任务Succeeded或Failed。provider已Delivered而hidden失败是服务已交付、任务失败/贷款Defaulted，不能改成未交付退款。未知Arena POST只允许deadline前重发原签名payload；已知runId可deadline后GET。已接受但丢回包、无runId且已过deadline时保留SubmissionPending，须可信侧人工核对settler journal，不自动另签或重新提交。

未交付时只有loopback+运营token可以启动原全价refund。退款准备先禁止交付，签名raw和refundId落盘；恢复只处理原操作。client没有退款密钥，只查询确认Account全额refund及合法零债务贷款终态（Repaid、Defaulted或ClosedByRefund），保存原task/loan状态；已违约退款不会抹除default或记任务成功。所有本地会话复用单writer/显式崩溃锁恢复，关闭旧进程后才recover，不能自动抢活锁。

入口由可信agent宿主调用：

```ts
import { runFixedPriceTask } from "@agentfuel/pi-loop/fixed-task";
const session = await runFixedPriceTask(sessionDirectory, {
  taskId, agentId: "1", rpcUrl, chainId: "31337", account, asset, provider,
  relayUrl: relayBase + "/v1/chat", underwriterUrl,
  maxServicePrice: "120000", deadlineMs, arenaUrl, escrowAddress,
  solve: { version: 1, problemId: "sum-integers", tiers: ["cheap", "strong"],
    maxRounds: 2, maxToolCalls: 4, maxCompletionTokens: 256, deadlineMs },
}, { signer });
// 重启使用原目录/同config/同handle，recoverLock仅用于确认旧writer已结束后。
```

以下受控回归使用新Anvil/mock-USDC、受控模型、隔离Docker和独立settler，无公网模型/RPC：

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
forge build --root contracts --offline --skip-lint
node --import tsx scripts/verify-fixed-price-credit.ts /absolute/fresh-output
node --import tsx --test packages/pi-loop/test/fixed-task.test.ts packages/pi-loop/test/provider.test.ts
npm run typecheck:all
```

输出目录必须全新；关闭链前保存pay/refund/TaskSettled raw receipts、client/provider会话、原模型请求响应、独立settler签名journal和task/loan状态。验证包含一次cash40000+draw80000购买120000固定价的首错修复与真实还款，早成功仍同价/已付缓存不二付，未知dispatch不重发，轮数/deadline全退及refund commit故障恢复，候选/回执/畸形结果负例。hidden-fail任务独立托管reward300000，零cash一次draw120000符合原LTV/fee，公开样例过而hidden失败真实Defaulted且不可服务退款；另有已付未交付任务超时清算后合法全退、原违约保留。provider初始mock-USDC为0，所有退款使用实际收款；只为gas注入本地ETH，不mint退款代币。

2026-10-04，root已独立验收真实Kimi经实际锁定Magpie→SDK/Relay固定价B→Pi公开工具→独立Arena的本地信用流程，见[真实B验收](../../demo-output/live-local-credit-20261004-root/root-acceptance.json)、[完整报告](../../demo-output/live-local-credit-20261004-root/report.json)与[网关来源](../../demo-output/live-credit-magpie-20261004-root/gateway-provenance.json)。一次K2.6首轮即通过，网关请求model为`cheap/kimi-k2.6`，物理请求/返回model为`kimi-k2.6`，usage输入190/输出45/总235（reasoning1），零付费重试。固定报价120000原始单位（0.12 mock-USDC），cash40000+draw80000、fee12000、真实还款92000；公开样例及独立hidden判题通过，原ProviderPaid/LoanOpened/TaskSettled和签名交易已保存并核验。现金报价与信用费用都不是上游模型账单；本次没有预置错误，不能据此声称真实多轮修复、strong调用或K3工具兼容。

随后Monad Task11真实业务已完成，root独立核对[离线与物理模型证据](../../demo-output/live-monad-pi-20261004-alchemy-root/root-acceptance.json)和[canonical固定区块审计](../../demo-output/live-monad-pi-20261004-alchemy-root/root-canonical-audit.json)。Alchemy直连、root验收进程请求间隔500ms，253个宿主RPC全部成功；独立settler请求不在此计数中。实际cash105396+draw14604支付120000测试USDC原始单位，fee438、还款15042；最终cash134958、repaymentCount4、defaultCount0、totalOutstanding0。实际Magpie经薄桥调用K2.6一次，usage输入190/输出40/总230（reasoning1），独立Arena判题5/5及目标链TaskSettled均通过。此轮也是首轮成功，不能据此声称真实多轮修复或strong调用；固定服务报价及信用费用不等于vendor账单。

[真实验证入口](../../scripts/verify-live-fixed-price.ts)支持本地和既有Monad部署、原output/PaymentHandle恢复、原签名交易journal复用、失败证据保全及[离线审计](../../scripts/live-fixed-price-evidence.ts)。新服务有意复用既有refunder作为payTo，故本次provider=poster=refunder；原provider和旧demo配置保留，资产余额基线在reward托管后取得，资金另以ProviderPaid和token Transfer核验。

[实际Magpie网关](../../docs/magpie-gateway.md)和[双Agent五子棋现金Arena](../../docs/gomoku-arena.md)已有独立实现，不再作为P1排除；五子棋当前采用双方独立cash预算，不包含共享奖金或授信。A逐轮耗用/未用额度退款、by-intent候选路由、完整自主选任务及共享奖金授信仍为后续范围，本B没有引入这些协议。

### 真实执行入口

```sh
node --import tsx scripts/verify-live-fixed-price.ts \
  --mode monad --config /absolute/private/demo.json \
  --deployment /absolute/deployment/manifest.json \
  --routes /absolute/private/routes.json --output /absolute/run-output \
  --agent-id 1977 --max-fee-per-gas 404000000000 \
  --rpc-url-file /Users/jungle/.config/agentfuel/alchemy-b59e30385b32/rpc-url \
  --rpc-transport direct

node --import tsx scripts/verify-live-fixed-price.ts \
  --audit-output demo-output/live-monad-pi-20261004-alchemy-root
```

首条命令默认只读预检，建议使用本次通过的Alchemy私有RPC文件和显式direct。首次实际执行追加 `--execute`，恢复已有运行追加 `--execute --resume`，始终使用原配置、输出目录、模型路由和原签名交易。`--enable-refunder-provider` 仅用于明确允许为本服务新增必要白名单的运行。上例 gas ceiling 和 agentId 是本次演示参数，其他部署需核对自己的配置；新信用验证需先准备现金缺口，本次结束后hero现金134958已高于固定价120000，入口不会把纯cash付款算作信用证明。

Monad RPC 默认 `system-https-proxy`，可显式选择 `direct`；宿主与独立 settler 使用相同选择，没有自动切换端点。该参数仅控制链 RPC，真实模型仍使用其独立网关配置。非法值或缺值会在配置/网络访问之前拒绝。本次500ms间隔由root验收进程加入，不是入口默认节流或自动重试参数。只读预检通过不等于业务结算通过；第二条命令离线核验已保存的Task11证据，canonical链状态则以root另存审计为据。

### 本地 strong 工具验收入口

`--scenario strong-only` 仅允许 `--mode local`，使用新的 Anvil/mock-USDC、现有隔离 Docker 和独立 Arena。计划固定为 `tiers=[strong,strong]`、最多2轮、每轮 `max_completion_tokens=2048`、5分钟、零自动模型重试；K3请求使用 `reasoning_effort=low`，首个公开样例通过即停止。默认 `sum-integers` 题和原公开样例；另传problemId只能选择现有四题白名单，没有starter、任意prompt或强制第二轮。两轮上限不表示一定发生修复；真实首轮成功只证明该次strong工具调用和交付，受控错误后的修复不能声称为真实自然修复。

```sh
node --import tsx scripts/verify-live-fixed-price.ts \
  --mode local --scenario strong-only \
  --config /Users/jungle/.config/agentfuel/monad-demo-20261002T011344Z-4df31740/demo.monad-ankr.json \
  --output /absolute/fresh-strong-output

node --import tsx scripts/verify-live-fixed-price.ts \
  --audit-output /absolute/existing-strong-output
```

首条默认只读，不调用模型或创建链；明确获准后追加 `--execute` 才实际运行。直营Kimi走原显式系统HTTPS代理；复用现有受信网关可另传 `--routes /absolute/private/new-routes.json`，仍按固定映射核对网关请求model与物理响应model。不要使用历史失效端口。固定运营报价120000、托管150000、cash40000+draw80000、fee12000原始mock-USDC单位；这些不是vendor token成本或账单，gas另计。

scenario进入计划和runner的配置摘要；solve请求及会话配置绑定 `strong,strong` 和全部上限。恢复必须保留原 `--scenario strong-only`、配置、routes、output、handle和deadline，再追加 `--execute --resume`；换场景拒绝且不重写原证据。原派发缺响应不会自动再发，未交付仍沿用B原收款全额退款规则。未知、超限和失败也保存请求/会话/付款或退款原始证据后再关闭Anvil。

未传scenario的默认计划仍为 `cheap,strong,strong`、最多3轮，旧plan/runner binding和历史审计兼容。auditor明确核对场景、tiers、上限、客户端/runner/付款绑定、工具代码与独立最终判题。`scripts/test/live-fixed-price.test.ts` 的strong场景只使用受控模型：覆盖早停、两轮受控修复、两轮上限退款、未知不二调/恢复不二付，以及非法/缺值/非本地scenario和审计篡改负例。这些受控回归和既有K3短探针都不能代替真实工具证据。

2026-10-06执行一次有界真实strong-only，见[原报告](../../demo-output/live-strong-only-20261006-root/report.json)和[离线一致性审计](../../demo-output/live-strong-only-20261006-root/offline-fixed-audit.json)。直营Kimi经原系统HTTPS代理，仅一次 `kimi-k3` 请求，返回model和receipt请求模型同为 `kimi-k3`；`reasoning_effort=low`、2048 completion上限，finish_reason为tool_calls。实际 `test_public_sample` 工具一次输出9并通过，独立Arena5/5及新本地链TaskSettled通过。usage输入307/输出86/总393，reasoning15、输入cache_write_tokens256均按原响应保存，不据此推算账单。

固定报价120000=cash40000+draw80000，fee12000、还款92000，provider余额0→120000、agent nonce4→5、最终cash58000、贷款Repaid且未偿0。首轮成功后即停，没有第二次模型请求，`repairObserved=false`，不能声称真实多轮或自然修复，也没有新增Monad交易。原请求响应、source hashes、付款/结算raw receipts、会话和独立settler journal已保存；root已独立复核原始模型/资金证据并重新Docker判题5/5，受控脚本12/12及全项目typecheck通过，见[root验收](../../demo-output/live-strong-only-20261006-root/root-acceptance.json)。

### 四题有界本地入口

`--catalog`仅允许local，按sum-integers、unique-sorted、balanced-brackets、word-frequency顺序创建四个独立本地任务。每题`catalog-once`固定cheap一轮、2048 completion上限、最多4次公开工具、5分钟；整个批次最多4次实际模型调用、零自动模型重试。每题仍只付款一次固定价120000，用原本地cash40000+draw80000，独立Arena分别验证5/4/6/4个隐藏用例并结算。金额为mock-USDC原始单位，未引入新的金融规则或Monad交易。

```sh
node --import tsx scripts/verify-live-fixed-price.ts \
  --mode local --catalog --config /absolute/private/demo.json \
  --routes /absolute/private/routes.json --output /absolute/fresh-catalog-output

node --import tsx scripts/verify-live-fixed-price.ts \
  --mode local --problem-id unique-sorted \
  --config /absolute/private/demo.json --output /absolute/fresh-single-output
```

默认只校验配置与计划，不调用模型或创建链；实际执行追加`--execute`。routes可省略，省略时沿用直营Kimi系统HTTPS代理；传routes则保持既有网关路由与响应模型绑定。单题新problemId缺省使用catalog-once；显式strong-only仍最多2轮，local-only。不传problemId/scenario的旧sum计划仍为cheap,strong,strong，旧paid binding和审计保持兼容。

批次输出含catalog/session.json、catalog-report.json及四个按题目命名的子目录。每题保存原付款handle、原签名、模型派发/响应、工具反馈、独立结算签名与回执；每个子目录可用`--audit-output`离线审计。任一题未确认Succeeded立即停止，后续题不会开始。续跑保留原config、routes、output，追加`--execute --resume`；崩溃锁确认旧writer结束后再追加`--recover`。已完成题只审计已有证据，未知模型请求不重新派发，不换新任务或增加调用额度。离线审计不能代替供应商来源或当前链canonical查询。

受控回归已覆盖四题付款→Pi工具→独立Arena结算、同批次恢复零新增调用、题目绑定篡改拒绝、公开样例特判代码隐藏判题失败，以及未知首题停止后续任务。测试不调用真实模型，四题真实运行应另外保存原始响应和验收证据。

### Monad 现场发现的修复

Task 9 的原付款上限600000不足：原交易status0，历史区块上同一calldata在600000 gas回滚、1000000 gas执行成功。现入口付款上限1000000、包含accept的agent预算1300000。原付款未转出USDC或开启贷款，任务到期后150000 escrow已全退，见[原失败审计](../../demo-output/live-monad-pi-20261004-root/root-final-failure-audit.json)。不覆盖原报告或修改已签交易。

SDK现在核对原交易hash和canonical block后，才保存`handle.submission.revertedReceipt`并返回`PAYMENT_REVERTED`，runner以`Stopped`终止，保留handle且不另签一笔。无receipt或非canonical仍属于不确定状态。真实Anvil低gas回滚、恢复零再签、空receipt等root定向回归7/7通过，SDK/Relay全套17/17由执行Agent验证，root另完成typecheck:all。

修复后Task 10曾创建并接单，但授信阶段RPC 503导致`SERVICE_UNAVAILABLE`，没有签付款或调用模型，五分钟期限也不延长。该任务已到期关闭并全额退回150000 escrow；当时Agent现金105396、还款3、违约0、未偿0，见[历史最终核对](../../demo-output/live-monad-pi-20261004-gasfix-root/root-final-audit.json)。该失败记录不是成功证据，原到期任务不能重开或改期限；后续Task11成功由上文独立证据另行记录，Task9/10报告保留原样。


2026-10-07 四题真实批次由root执行并验收：`sum-integers`、`unique-sorted`、`balanced-brackets`、`word-frequency`各一次Kimi K2.6，总usage分别235/264/338/279（合计1116）。每题独立新Anvil fixture，固定价120000=cash40000+credit80000，fee12000、repay92000，最终cash58000/未偿0；不能合并宣称同一Agent累计还款。独立Arena5+4+6+4=19项通过，root新Docker重验19项通过。root独立44项脚本/provider/sample测试通过，最终受影响恢复测试另2项通过；全项目typecheck含前端通过。见[批次报告](../../demo-output/live-catalog-20261007-root/catalog-report.json)与[独立验收](../../demo-output/live-catalog-20261007-root/root-acceptance.json)。本轮直连配置的Kimi经系统代理，未经过Magpie或新增Monad交易；首轮成功即停，没有自然修复证据。
