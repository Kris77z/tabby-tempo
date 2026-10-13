# 受限 Pi 编程循环

`@earendil-works/pi-agent-core`、`pi-ai` 锁定 **1.0.1**，使用 Node **22.19.0+**；只引入 Agent 核心、它的必需依赖和工具 schema，不引 coding CLI、LangChain 或多 Agent 框架。自定义 `streamFn` 把非流式 SDK/Relay 响应转换为 Pi 消息及工具事件，Pi 默认 provider 不参与模型请求。

此入口只处理宿主已经指定、已经 Assigned 的一个 `sum-integers` 任务。模型唯一工具是 `test_public_sample(code)`：沿用 Arena 的隔离 DockerExecutor，固定公开样例 `[4,8,-3] -> 9`，执行目录只有提交代码。自测不调用 `hiddenTests`、不导入 ArenaController、不提交、不结算；工具不是任意 shell。私钥、API key、hidden tests、钱包和结算接口不进入模型上下文。

宿主在每轮显式指定 `cheap` 或 `strong`，使用 **`infer.fetch` 的 taskId=0 纯 cash 路径**；没有 underwriter、借款或自动选单。`tiers` 数组长度等于 `maxRounds`，每项是该轮已指定的档位。每轮 `maxPrice=min(maxPricePerCall, 剩余预算)`，SDK 验证报价后，await `onHandle` 原子保存报价和预算预留，再允许付款。预算只计推理 quote.price，**不含链上 gas**；未知付款、超时和未交付请求保留预留，不视作免费，也不自动重新报价或退款释放预算。

入口由可信 Node 宿主调用；signer 只存在于宿主内存，config 不含任何密钥：

```ts
import { runProgrammingLoop, type LoopConfig } from "@agentfuel/pi-loop";
const config: LoopConfig = {
  taskId: assignedTaskId, agentId: "1", rpcUrl, chainId: "31337",
  account, asset, provider, relayUrl: relayBase + "/v1/chat",
  service: "infercredit/coder", model: "coder", tiers: ["cheap", "strong"],
  maxRounds: 2, maxToolCalls: 4,
  maxTotalPrice: "40000", maxPricePerCall: "30000", // 6位mock-USDC原始单位
  deadlineMs: Date.now() + 90_000, maxCompletionTokens: 256,
  arenaUrl, escrowAddress,
};
const session = await runProgrammingLoop(sessionDirectory, config, { signer });
// 重启使用同一目录、同一config（包括原deadline），不要另造目录、quote或签名。
```

目录 0700、会话文件 0600，原子写入并 fsync。保存 Pi transcript、每轮完整 input/PaymentHandle/result、按轮次与 toolCallId 匹配的自测结果，以及最终提交的原签名 payload/runId。PaymentHandle 包含公开 signed raw transaction，不包含私钥。`reservedPrice` 是保守累计报价预留，不是上游成本或最终账单。Pi消息usage.cost=0仅是框架占位，实际报价取PaymentHandle/receipt，usage取上游原响应；零占位不表示免费。

正常重启先核对完全相同的 config。已付未领取轮次 resume 同 handle；已保存 inference 而尚未追加 assistant 时直接重放本地结果，已 Delivered 缓存不重新跑模型。旧 assistant 缺工具结果时，通过 Pi 的 `runToolCall` 补齐原 ID；已记录自测结果复用，执行意图无结果可重跑同一公开样例。`length` 截断工具在正常和恢复路径都拒绝执行，多 tool batch 仍受总 `maxToolCalls` 限制。普通非工具回答结束为 `NO_PUBLIC_TEST`，不能当任务通过。

每个会话只允许一个本机 writer。`.writer/owner.json` 保存 pid/token；活 pid 返回 `SESSION_BUSY`。进程崩溃留下死 pid 时返回 `SESSION_RECOVERY_REQUIRED`：确认旧进程已停止后，用同入口加 `{ signer, recoverLock: true }`，恢复会在 `.recover` 协调目录下再次确认原 pid 不活跃，才重新取得锁。PID 被复用时保守拒绝。缺失/损坏 owner 或遗留 `.recover` 不自动抢锁；操作者确认没有 writer/recovery 进程后，检查并手动清理对应锁目录，再重新运行。此锁仅用于单机本地会话。

到达 deadline 后，不新签/广播付款、不新开轮次、不启动或继续自测、不签或 POST 新最终提交；自测在 Docker ready 后复查时间，并用 deadline AbortSignal 取消运行中的容器。已发送付款不能回滚，仍保留预留；超过 deadline 可以领取已付结果或 GET 已知 Arena runId，但不能由此授权新执行。SDK `beforePayment` 对 Wallet sign、相同 raw 重播和 Browser send 都检查时间；已确认付款领取绕过此 guard。

公开样例通过后，宿主保存最终签名 payload，再 POST **现有 Arena HTTP**。最终 hidden tests 和 `settle` 留给可信 Arena/独立 settler；只有其 Docker verdict 与指定 task/agent/domain 一致，并核验真实成功 receipt 中的 `TaskSettled`，才记 `Succeeded` 或 `Failed`。样例通过、模型口头成功、HTTP 接受均不算任务成功。

丢失 POST 响应、429/5xx、409冲突保留 `SubmissionPending` 和原 payload；截止前允许重发完全相同 payload，靠现有服务端幂等取得原 runId，不重新签。已知 runId 只查状态；查询错误/settler运行错误不推断链上最终失败。截止后没有 runId 的未知提交明确暂停；Arena HTTP 重启会丢失内存 runId，需可信侧核对其结算 journal，循环不会通过新提交绕过。明确其他4xx记 `SubmissionPending/ARENA_SUBMISSION_REJECTED`，保留已付结果与原签名；HTTP拒绝不是任务或贷款终局，恢复Arena配置后仅重试原提交。

前一批本地受控验证使用新 Anvil/mock-USDC、真实 Docker 与独立 settler，覆盖错误后的修复与恢复。2026-10-04另执行一次有界真实 Kimi 验证：K2.6通过SDK→Relay→Pi返回实际 `test_public_sample` 工具调用，公开样例及独立Arena的5项判题通过，并完成本地链TaskSettled。请求/返回模型均为 `kimi-k2.6`，usage输入190/输出45/总235（reasoning1），1次请求、零付费重试，报价10000原始单位（0.01 mock-USDC）。运营报价不等于模型成本或实际账单。

见[报告](../../demo-output/live-pi-20261004-kimi-once/report.json)、[最终离线审计](../../demo-output/live-pi-20261004-kimi-once/offline-pi-audit.json)和[root独立验收](../../demo-output/live-pi-20261004-kimi-once/root-acceptance.json)。付款与结算raw receipts、签名交易journal、原请求响应和会话在关闭Anvil前保存；root独立核对证据并重新Docker判题5/5，Pi 11/11、脚本与审计33/33、typecheck:all含前端通过。运行时源码hash保留原样；当次运行结束后强化离线auditor的签名settle核验，差异记录在[post-run-audit](../../demo-output/live-pi-20261004-kimi-once/post-run-audit.json)。

复现脚本默认只显示去敏计划；显式 `--execute` 才使用私有配置与系统HTTPS代理，创建新Anvil/Docker隔离环境。最多3轮、每轮2048 completion tokens、总报价预算70000原始单位、5分钟deadline，首个样例通过就停止模型循环。`tierParameters`只允许指定 `thinking: {type: "disabled"}` 和 `reasoning_effort: "low"`；不能覆盖消息、模型或token上限。输出目录必须全新；离线审计不读取私有配置、不访问网络：

```sh
node --import tsx scripts/verify-live-pi.ts --config /absolute/private-config.json --output /absolute/fresh-output
node --import tsx scripts/verify-live-pi.ts --config /absolute/private-config.json --output /absolute/fresh-output --execute
node --import tsx scripts/verify-live-pi.ts --audit-output /absolute/existing-output
```

上述cash验收轮次未预置错误且首轮成功，未使用strong；该轮没有验证真实两轮修复、K3工具兼容、Monad Pi、信用融资、Magpie或标准x402。后续真实B与Magpie证据见下文，不能回写成这份cash历史报告的验证范围。旧demo、secrets和测试网页配置未切换。

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
npm run typecheck:all
npm test --workspace @agentfuel/pi-loop
npm test --workspace @agentfuel/provider-relay
```

Docker daemon 和 Arena 已固定镜像须预先可用；测试不静默改用宿主执行，也不自动拉镜像。适配测试覆盖消息/tool IDs/错误/abort及默认provider零请求；集成覆盖首错修复、预算/轮数/工具数/deadline、样例与最终失败区分、真实结算及恢复零二付；会话测试覆盖跨进程排他、崩溃显式恢复和写失败清理。


固定价信用服务 B 是独立 opt-in 入口，见[规格与复现](FIXED_PRICE.md)。它将最多三轮求解打包成一次SDK `forTask`购买；provider内部Pi不接钱包或Arena。早成功仍按固定价，未交付终稿由provider原收款全退，最终hidden tests失败走原贷款清算。上述cash入口继续使用taskId0。

root已独立验收[真实Kimi信用B与实际Magpie本地流程](../../demo-output/live-local-credit-20261004-root/root-acceptance.json)：一次K2.6实际工具调用后独立Arena结算，固定价120000、cash40000+draw80000、fee12000、还款92000原始单位；原请求响应、物理模型归因和链上证据均核验。本次首轮成功，没有人为凑修复或strong轮次。运营报价不等于模型成本。受控回归另覆盖修复、未交付退款和恢复，不能替代这份真实证据。

[Monad Task11真实流程](../../demo-output/live-monad-pi-20261004-alchemy-root/root-acceptance.json)也已由root独立验收，另有[canonical固定区块审计](../../demo-output/live-monad-pi-20261004-alchemy-root/root-canonical-audit.json)。Alchemy直连和root进程500ms请求间隔下，253个宿主RPC全部成功，独立settler不计在内。一次真实K2.6经实际Magpie返回工具调用，usage输入190/输出40/总230；独立Arena5/5和目标链TaskSettled通过。实际cash105396+draw14604=120000，fee438、还款15042原始单位；最终cash134958、还款次数4、违约0、未偿0。provider=poster=refunder的有意角色复用及原provider保留已在报告中说明。首轮成功不等于多轮修复，运营报价也不是vendor账单；Task9/10失败及退款仍保留为历史证据。

[真实验证脚本](../../scripts/verify-live-fixed-price.ts)支持既有Monad部署、原handle/交易journal恢复和离线证据审计；Alchemy私有RPC文件配合`--rpc-transport direct`的具体预检与审计命令见[固定价入口](FIXED_PRICE.md#真实执行入口)。[Magpie](../../docs/magpie-gateway.md)与[双Agent五子棋现金Arena](../../docs/gomoku-arena.md)已有独立实现，不再列为P1排除。棋牌当前只使用双方独立cash预算；共享奖金授信、逐轮储值退款、by-intent和完整自主选任务仍未实现，标准x402亦未验证。

## 预设候选任务的统一工作流

`@agentfuel/pi-loop/workflow` 已将四题候选的规则选择、必要时 Open 接单、一次固定价 B 求解、公开工具与独立 Arena/原贷款终态接成持久入口；已 Assigned 且属于本 agent 的任务也可直接进入。选择只复用纯规则，不先购买一次普通推理，因此没有额外付款。受信固定价、求解档位计划、原 accept raw/hash、子会话和 PaymentHandle 均落盘；单钱包非终局只恢复原工作流，未知不重派，到期不新广播或提交。对外只返回安全状态投影，运营 refunder 不进入模型或 client 配置。规格、宿主 API、受控证据边界与复现命令见[统一工作流](WORKFLOW.md)，HTTP/CLI 配置与命令见[运营入口](TASK_RUNNER.md)。本批 core 的 Anvil/Docker/独立 Arena 回归通过，真实模型验收仍需同一运营入口的独立证据。

## 预设候选任务的付款前选择

`@agentfuel/pi-loop/selector` 是独立 opt-in 宿主入口，原显式 cash loop 和固定价 B 配置保持不变。`runSelectedInference` 从宿主预设、链上已经 Assigned 的候选任务和受信 provider 中选择**一次 SDK 推理购买**。它不自动接任务，不运行代码或 Pi 工具，也不提交 Arena；返回 `Delivered` 只表示这次推理已交付，不能作为任务成功。四题型仅限 Arena 现有的 `sum-integers`、`unique-sorted`、`balanced-brackets`、`word-frequency`，消息只取公开 catalog，不读 hidden tests。后续工具求解和最终判题仍走各自入口。

宿主为每条 route 明确声明 `python3-json-stdio` 和可处理题型的能力标签、`cheap`/`strong`、精确报价、固定收款地址和 Relay URL。标签是受信配置的声明，不是模型能力测评。任务配置只接受预设题型绑定、taskId、原 deadline 和明确 `creditLimit`；任务正文或模型输出不进入配置，不参与改价、改地址或选档。每个 provider 的两档同时配置时必须 cheap < strong。金额全部用十进制字符串和 BigInt。

入口读取当前 cash 和每个任务的 Assigned/agentId/deadline，再按能力、`maxPrice`、cash 加该任务明确授信上限、剩余时间筛选。可行候选按报价、最近 deadline、数值 taskId、providerId、tier 排序；没有可行项则持久保存 `Stopped/NO_FEASIBLE_CANDIDATE`，不请求报价、不付款。预算只计运营报价，不含 gas 或 vendor 账单。现金足够的候选固定走 `infer.fetch` 的 taskId0；只有 `allowCredit=true`、显式 underwriter 和现金不足时才走该 task 的 `forTask`，原协议仍检查身份、贷款和授信条件，不能为原任务通过新 nonce 再提款。

```ts
import { runSelectedInference, type SelectionConfig } from "@agentfuel/pi-loop/selector";
const selection: SelectionConfig = {
  agentId: "1", chainId: "31337", account, asset, escrowAddress,
  // taskId/problemId/deadline 来自宿主核对的绑定，不从任意任务文本解析。
  tasks: [{ taskId: assignedTaskId, problemId: "balanced-brackets",
    deadlineMs: assignedDeadlineSeconds * 1000, creditLimit: "20000" }],
  providers: [{ id: "trusted", payTo: provider, relayUrl: relayBase + "/v1/chat",
    service: "infercredit/coder", model: "coder", routes: [
      { tier: "cheap", price: "10000", capabilities: ["python3-json-stdio", "sum-integers"] },
      { tier: "strong", price: "30000", capabilities: ["python3-json-stdio", "balanced-brackets"] },
    ] }],
  allowCredit: false, maxPrice: "30000", deadlineMs: hostDeadlineMs,
  minRemainingMs: 5000, maxCompletionTokens: 128,
};
// signer 使用宿主已配置的 JSON-RPC provider；这里不复制 RPC 密钥或创建新钱包。
const purchase = await runSelectedInference(selectionDirectory, selection, { signer });
// 明确允许任务信用时才同时设置 allowCredit:true 与 { signer, underwriterUrl }。
```

决策先用现有 SessionStore 原子落盘，记录受信 configHash、资金/任务 snapshotHash、所有候选的排除原因和选中项。SDK await `onHandle` 核对精确原价、档位、请求 digest 和原 paymentId，再保存 PaymentHandle/报价预留，保存失败停止付款。SDK 的链、钱包、provider/domain 校验继续生效。每次签名、广播或相同 raw 重播前重读 cash 和任务状态/期限；资金变少不能把原 cash 选择升级成信用，不重新排序、不换 provider、不另开付款。回执还核对金额、资金拆分、档位和 domain；异常保留证据而非宣称交付成功。`creditLimit` 是宿主准入及付款前检查上限，**没有修改原合约 policy 或 underwriter 的签名额度，也不是新增链上资金隔离**；同一账户的外部并发消费仍受原协议约束，宿主应顺序执行该钱包付款。

同目录恢复要求原配置和完整决策快照一致。已保存 `Delivered` 结果直接返回；未知付款/上游响应保留 `Paused`、原 handle 和预留，只 resume 原 ID，不重新报价或派发下一候选。到达 deadline 后不调用 SDK、新签或重播；已经保存的结果仍可读，尚未领取的已付款 handle 留给原支付状态查询/人工核对。锁及显式崩溃恢复沿用 SessionStore 的单机 writer 规则。配置不含 key；Relay URL 拒绝 userinfo/query/fragment，不把 credential-bearing URL 写入会话。

受控回归通过隔离 Anvil/mock-USDC 和真实 SDK→Relay 付款，验证四题规则、BigInt 排序、无可行候选零报价/零付款、变价/过期/持久化失败停止、现金变化不升级信用、原 ID 未知恢复不重付或重发，以及一次显式 task-credit 强档购买。未运行真实模型或公网链交易，未验证自动任务发现、接单或完整自主调度：

```sh
node --import tsx --test packages/pi-loop/test/selector.test.ts
npm run typecheck:all
```

[选择验收脚本](../../scripts/verify-live-selection.ts)固定两个预设 Assigned 候选（sum/brackets）和一个受信 provider 的两档配置，实际通过选择器选择 brackets 的 cheap 档。默认仅打印计划；`--execute` 必须使用全新绝对输出目录，最多一次K2.6、2048 completion tokens、5分钟、cash-only，未知停止，不重复执行已有 output。受控脚本回归另验证缺少原链回执不能报成功。原始请求/响应、选择会话/handle/receipt、签名付款交易、ProviderPaid raw receipt、余额和同会话恢复观察均在关链前保存；离线审计复算决策并核对模型/usage/token cap、原价、付款事件和恢复零新增付款/请求。它不执行返回代码，也不证明 Pi 工具或 Arena 任务成功；真实一次选择验收见下方独立报告：

```sh
node --import tsx scripts/verify-live-selection.ts --config /absolute/private/demo.monad.json
node --import tsx scripts/verify-live-selection.ts --config /absolute/private/demo.monad.json --output /absolute/fresh-output --execute
node --import tsx scripts/verify-live-selection.ts --audit-output /absolute/existing-output
node --import tsx --test scripts/test/live-selection.test.ts
```


2026-10-07 root真实选择验收通过：宿主预设求和/括号候选及能力标签，选择器选出括号cheap→真实Kimi K2.6一次（输入76/输出1454/总1530 tokens，含1301 reasoning）。本地cash40000→30000、credit0；重复读取同session没有新增模型、付款或nonce。保存签名和ProviderPaid原始回执已离线复核，见[独立验收](../../demo-output/live-selection-20261007-root/root-acceptance.json)。root独立12+4项测试和typecheck:all通过；这次不执行返回代码、不调用Arena、不证明题目已完成，不参与Monad或Magpie。能力标签来自宿主策略，不是模型能力测试结果。
