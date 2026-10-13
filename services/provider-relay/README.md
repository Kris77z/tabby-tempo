# Provider relay

自建 402 quote/receipt 服务，使用 Node 22 native HTTP、ethers 和原子 JSON 文件。它不是标准 x402 facilitator 实现，标准 scheme 兼容性尚未验证。2026-10-06 的普通 Relay fallback 安全修复只运行新本地 Anvil 与受控上游，没有新增公网模型调用或测试网交易；先前真实验收见下方证据。

从仓库根目录验证：

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
npm ci
npm run typecheck:all
npm test --workspace @agentfuel/provider-relay
```

复制本目录 `.env.example` 到 `.env` 并填写部署后的 Account、已白名单 provider、上游 API keys，再启动：

```sh
cd services/provider-relay
node --env-file=.env --import tsx src/main.ts
```

示例锁定 Monad testnet `10143`、USDC 6 位；Account/provider 未部署时留空，不能直接启动。`PRICE=120000` 是代币原始单位。原生币模式显式设零地址、18 位与对应原始单位价格。只有一个 P0 逻辑 group：`SERVICE_ID=infercredit/coder`、`LOGICAL_MODEL=coder`；物理 Kimi/Qwen 配置按顺序 fallback，不改变已报价的 service/model/price。部署清单 `providers[]` 须显式包含 `service`、`model`，展示 `name` 不参与路由。Arena 题目是 Python stdout 程序，后续 demo 的推理 prompt 必须要求 Python 代码。

ENGINEERING §6.6 第一步提供显式 `cheap` / `strong` 两档。保留上述 `PRICE` + `UPSTREAMS_JSON` 单档配置和现有 coder demo；启用两档时用 `TIERS_JSON` 替代这两个变量，不能混用：

```json
{"cheap":{"price":"10000","upstreams":[{"name":"cheap-primary","baseUrl":"https://cheap.example/v1","model":"cheap-model","keyEnv":"CHEAP_API_KEY"}]},"strong":{"price":"30000","upstreams":[{"name":"strong-primary","baseUrl":"https://strong.example/v1","model":"strong-model","keyEnv":"STRONG_API_KEY"}]}}
```

两个档位必须成对配置，`0 < cheap.price < strong.price`，每档 1..4 个有序候选、档内 name 唯一。上游 URL 不得带 credentials/query/fragment；密钥只通过 keyEnv 加载。两档仍共享逻辑 service/model；调用方在 JSON body 显式加 `tier: "cheap"` 或 `"strong"`，缺失/未知档位拒绝报价，单档模式不接受 tier。Relay 不分类任务，也不自动降档；预算由 SDK 的既有 `maxPrice` 在付款前校验。这里的能力档位由运营配置声明，未测量模型能力。

上游示例依据 [Kimi Chat Completions](https://platform.kimi.com/docs/api/chat) 与 [Qwen OpenAI-compatible API](https://www.alibabacloud.com/help/en/model-studio/compatibility-of-openai-with-dashscope)。Qwen keys 与 region 绑定；官方建议按实际 workspace 换成对应域名，旧 `dashscope.aliyuncs.com` 仍有兼容入口。填配置后是否有模型权限、余额和真实输出仍需实际验证。

`POST /v1/chat` JSON body 是 OpenAI 风格推理字段加 `agentId`、`taskId`、`service`；agentId/taskId 用十进制字符串。`model` 是逻辑型号 `coder`，messages/tools/temperature 等实际内容全部进入摘要；P0 不支持 stream。首次响应 402：

```json
{"quote":{"paymentId":"…","agentId":"1","taskId":"1","requestDigest":"…","serverNonce":"…","service":"infercredit/coder","model":"coder","price":"120000","payTo":"…","asset":"…","chainId":"10143","account":"…","quoteExpiry":"…","createdBlock":123}}
```

摘要为递归排序 object keys 的 JSON UTF-8 keccak256，数组顺序保留。`paymentId=keccak256(abi.encode(uint256 taskId,bytes32 requestDigest,bytes32 serverNonce))`，SDK 共用同一实现。纯 cash 无任务请求传 `taskId="0"`。有逻辑任务但实际纯 cash 时，报价仍绑定逻辑 task，合约 `PaymentRecord.taskId` 为 0；有 credit 才要求 calldata auth.taskId 对应逻辑任务。

两档报价另含与请求一致的 `tier`，并且请求 tier 进入摘要。付款后不能修改档位；fallback 只按该档报价时保存的候选顺序尝试，差价由 Relay 承担，不要求第二次付款。只有完整的 HTTP `400/401/403/404/413/415/422/429` 请求、权限、路由、大小或配额拒绝响应允许继续候选。这是对配置中受信上游的拒绝响应契约，不是通用 HTTP 对 vendor 零成本的证明；不能用任意响应 header 绕过它。`408/409`、其他非成功状态（包括 `5xx`）、timeout、断连、截断响应、2xx JSON 解析失败或无有效 choices 都按未知处理，不 fallback。

tier 不转发给 OpenAI-compatible 上游。receipt 的 tier/price 是原约定档位和实付价，upstream/model 是实际调用的配置端点名与请求物理模型；result 原文保留上游自报 model，不能由它证明网关背后的实际模型。

付款后重发完全相同 body，携 `x-payment-id` 和可选 `x-payment-tx`。服务核验配置链、成功且目标为 Account 的 receipt、Account 发出的唯一 ProviderPaid 完整 agent/provider/paymentId/fromCash+fromCredit、payProvider calldata、canonical block、确认数与区块时间。错误 hash/日志/金额/归属不能交付。结果响应 `{result,receipt}`；receipt 记录原锁价、真实付款区块/hash、实际上游/model/usage。

`GET /payments/:paymentId?agentId=…&requestDigest=…` 返回状态、refundPending/expiredPayment 和已交付结果。Quoted 未携 txHash 时先核对链并读取 Account.getPayment；五字段全零即保留 Quoted 和原扫描水位，不查日志，读取失败报错。非零记录（包括已退款付款）仍按真实 ProviderPaid 发现支付：从存储的 createdBlock/scanBlock 扫描到已确认 head，`LOG_SCAN_CHUNK_BLOCKS` 可设 1..1000，默认每页 1000 块，Monad demo 显式使用 100；扫描失败不推进该页水位，未确认事件不跨过水位。确认后不再扫描。客户端丢 hash、只查询 status 也能继续，同 ID 不重新收费。

未付款阶段为 Quoted。付款后 Paid→Processing→Delivered；原请求在任何上游调用前已保存，按 paymentId 锁串行。每个候选发送前另保存 `upstreamAttempts` 的 `Dispatching`、端点名、请求物理模型和毫秒时间，拒绝后保存 `Rejected` 与 HTTP 状态，再尝试下一候选。结果和该候选的 `Delivered` 必须一起原子落盘才返回；已交付重复/并发请求返回缓存。

未知结果保留 `Processing` 与 `UPSTREAM_UNCERTAIN`，不把已付款记为未消费。status 返回无密钥的候选记录、HTTP 状态和固定原因码；不保存上游错误正文或异常消息。原 ID 的 chat 返回 409，SDK 抛出携原 handle 的 `PaymentError("UPSTREAM_UNCERTAIN")`；status 仍可查询，原付款 proof、请求和 journal 保留在受保护的记录文件中。重复请求、`recover()`、重启、换路由、报价到期均不能再次派发该未知调用。崩溃发生在 `Dispatching` 写入后，即使实际尚未发送，也保守地要求人工核对；成功响应保存失败同样不能重调模型。客户端自己的等待超时不会撤销已发出的调用，稍后已原子保存的 Delivered 仍可凭原 handle 领取。

启动只恢复没有发出候选的新 `Processing`（空 journal）或已经持久保存拒绝、尚有下一候选的记录；恢复跳过已拒绝候选。所有可用候选明确拒绝后回到 Paid+`UPSTREAM_FAILED`，允许原付款退款，不自动重试同一已拒绝候选。旧 Processing、或旧 Paid+`UPSTREAM_FAILED` 没有候选 journal 时，无法证明当时没有发生模型调用，也按未知阻止派发和直接退款；旧 Delivered 缓存保持可领取。没有自动清除未知并重试/退款的 HTTP 入口。运营应先停服务，凭 paymentId/requestDigest、原请求、候选模型和时间与上游核对交付事实，再进行受控维护；不能用改配置、删记录或新 paymentId 代替核对。

仅付款区块时间受 quoteExpiry 约束，及时付款之后永久可领取；完整真实的晚付款保存为 Paid+expiredPayment，禁止推理，允许运营退款。

所有新报价（含单档）持久化无密钥的路由快照，绑定原逻辑 model、tier 及候选 name/baseUrl/model。恢复只使用原档内仍与快照一致且尚未派发的候选，保持原顺序；新增候选和移到另档的候选不能服务旧报价。改价不改变原 quote.price，尚未派发候选可换 key 继续；原候选被删除/改模型/改 URL 且无剩余合规候选时返回 `ROUTE_UNAVAILABLE`，保留已付款状态和退款入口。未知派发先于路由检查，不能被上述错误降为可退款 Paid。未付报价的 status 仍返回 200/Quoted，并用 deliveryError 提示无法履约，SDK 据此拒绝付款。已付状态、符合条件的退款、已交付缓存不依赖当前 service/model/tier 是否仍开放。

旧磁盘记录没有 route 快照时，未交付记录返回 `ROUTE_SNAPSHOT_REQUIRED`，不猜测原模型或自动迁移；已付仍可查询及退款，已 Delivered 仍可领取缓存。这是明确的兼容边界，旧 demo 请求格式和新单档报价不受影响。

运营退款只在 loopback、无浏览器 Origin 且 bearer `OPERATOR_TOKEN` 匹配时开放。专用 `REFUNDER_PRIVATE_KEY` 必须等于 Manager.relayRefunder，操作者自行提供退款资产；provider 收款地址与 refunder 可以不同。CLI 仅连接本机，`.env` 由 Node 显式加载：

```sh
node --env-file=.env --import tsx src/refund-cli.ts PAYMENT_ID REFUND_ID RAW_AMOUNT
```

运营入口 `/ops/refund` body `{paymentId,refundId,amount}`。仅已收款且交付未发生可确认、或晚付款可退款；模型 dispatch 未知时不准备或广播退款，旧 Prepared 退款在 `Refunder.recover()` 中也暂停，等待人工核对，不因 refundPending 绕过。每次 amount 为原始单位，refundId 是全局单次 bytes32。先保存意图及已签 approve/processRefund rawTx/hash/nonce，再广播相同字节，确认成功的 RefundProcessed、refundConsumed 和累计金额才确认这一笔。链上未成功不增加退款累计；部分退款设置 refundPending 禁止推理，全额才 Refunded。重复同 refundId/amount 不重复退款，不同 amount 拒绝。显式重试已确认 revert 的操作可以重新签交易，退款交易未知结果不换交易；只有交付可退款事实明确时，重启才继续已有 journal。若退款成功后文件写入失败，恢复核验同 receipt，不发第二次。

`DATA_DIR` 默认启动工作目录下 `relay-data/`，已忽略提交；持久目录只供一个 relay 进程使用，锁仅进程内，不支持多实例共享。文件保存推理输入/结果及公开交易字节，不保存私钥/API key。`FRONTEND_ORIGIN` 精确 CORS 默认关闭；运营入口从不接受浏览器跨域。请求上限 128KiB。RPC/存储未知错误只返通用 503，不返 secrets 或 ethers 原始 error。

两档本地验收见 `test/tiers.test.ts`：Anvil 真正支付/退款、注入受控上游，覆盖预算不足不付款、价差、档内 fallback/归因、Processing 重启后原价与原顺序、key 轮换、换模型/URL与删档、旧记录退款/缓存和密钥不落盘。

普通 Relay 的未知派发回归见 `test/upstream-uncertain.test.ts`：新 Anvil/mock-USDC 真付款，受控 fetch 计数，覆盖完整拒绝后同档 fallback、408/409/5xx、timeout/断连、无效/截断响应、派发/结果保存故障、原 ID 重复和重启、删路由/旧 Prepared 退款/旧记录不能绕过、SDK 等待超时后领取已保存结果。没有使用真实模型或新增 Monad 交易。

2026-10-04 真实两档短探针使用新 Anvil/mock-USDC 与实际 Kimi API，各一次 `max_completion_tokens=128`、零付费重试。cheap 请求/返回 `kimi-k2.6`（thinking disabled），strong 请求/返回 `kimi-k3`（reasoning_effort low）；两次均 HTTP200、最终 `OK`、finish_reason stop。usage 分别为输入11/输出4/总15（reasoning1）与输入90/输出45/总135（reasoning29）。本地运营报价0.01/0.03 mock-USDC，收款总40000原始单位、agent nonce +2；缓存恢复没有新增付款或模型请求。见[原报告](../../demo-output/live-tiers-20261004-k26-k3-128/report.json)与[离线审计](../../demo-output/live-tiers-20261004-k26-k3-128/offline-audit.json)。原Anvil已关闭，首版脚本未保存raw transaction receipt；离线审计只能验证签名交易、Relay付款proof与保存结果的一致性，无法再独立复读原ProviderPaid事件。后续脚本已补保存/校验原始本地receipt，本次没有追加付费请求。

官方中国区[定价](https://platform.kimi.com/docs/pricing/chat.md)于2026-10-04查阅：人民币每百万tokens，K2.6输入未命中6.50/缓存命中1.10/输出27；K3未缓存输入20/缓存命中2/输出100，缓存写入5min20、1h40。K3命中、写入、未缓存输入计数互斥；reasoning与最终content共同占用输出上限。公开单价不是本次实际账单或运营报价换算。此探针未评估能力、真实链资金或标准x402兼容性，未接入Magpie/分类器/Pi。

从仓库根目录运行opt-in脚本，需显式 `--execute` 才发网络与两次付费推理，output必须是全新的绝对目录：

```sh
node --import tsx scripts/verify-live-tiers.ts --config /absolute/private/demo.monad.json --output /absolute/new-output --execute
node --import tsx scripts/verify-live-tiers.ts --audit-output /absolute/existing-output
node --import tsx --test scripts/test/live-tiers.test.ts
```

第一条仅从受限配置读取Kimi endpoint/key，原Monad RPC、地址和角色不参与运行，资金用新本地fixture。不带 `--execute` 仅输出去敏方案，不发网络请求；`--audit-output` 仅验证已有文件。空最终content、仅reasoning或finish_reason length不计任务完成，脚本非成功退出。私有配置/API key不进入报告；查看已有结果用audit，不重复执行付费路径。

ENGINEERING §6.6另有[受限Pi cash循环](../../packages/pi-loop/README.md)：自定义streamFn只走本SDK/Relay，显式选档与持久报价预留，每次infer.fetch的taskId为0，不借款；固定公开样例自测不结算，最终由现有Arena/独立settler验收。前一批为本地Anvil和受控上游；随后真实K2.6已通过SDK→Relay→Pi实际工具调用、公开样例及独立Arena本地结算。只用1轮/0.01 mock-USDC，未使用strong、未验证真实两轮修复或K3工具兼容；raw付款/结算receipts与完整请求响应均保存，见[报告](../../demo-output/live-pi-20261004-kimi-once/report.json)和[root独立验收](../../demo-output/live-pi-20261004-kimi-once/root-acceptance.json)。该 cash 验收范围未包含Monad Pi或多轮信用；后续 B 的独立验收见下节，旧demo/网页配置未切换。


另有独立opt-in [固定价求解服务B](../../packages/pi-loop/FIXED_PRICE.md)：`FixedPriceSolvingRelay`/`FixedPriceRefunder`沿用原402与资金证据，一次task-bound付款支持provider内部有界Pi公开样例循环。固定价早成功不退差额，未交付仅原全价运营退款；其独立 solve journal 对模型结果未知不重发，但由 provider 承担未知模型成本，未交付合格终稿仍允许全额退款。这是 B 的明确交付规则，不适用普通 Relay 的未知退款禁令。receipt为最后一轮模型/usage摘要，各轮实际请求和响应在run中。它不改变普通Relay/旧demo启动配置。实际 Magpie→Kimi 的本地信用和 Monad Task11 已由 root 独立验收，分别见[本地证据](../../demo-output/live-local-credit-20261004-root/root-acceptance.json)和[Monad证据](../../demo-output/live-monad-pi-20261004-alchemy-root/root-acceptance.json)；两次均首轮成功，不证明真实多轮修复或 strong 工具兼容。


### 2026-10-07 备用路由真实调用验收

`verify-live-fallback.ts` 在新 Anvil 上注入首个候选的完整 429 拒绝（不向供应商发请求），随后同 cheap 档调用真实 Kimi K2.6 一次。该次返回 OK，usage 为输入11/输出4/总15；0.01 mock-USDC 只付一次，重复读取及 Relay 重启后的原 handle 恢复均未新增付款或模型调用。已独立核对保存的原始请求/响应、签名交易、ProviderPaid raw receipt 和派发记录，见[验收](../../demo-output/live-fallback-20261007-root/root-acceptance.json)。这是“注入拒绝 + 真实备用模型”演练，不是自然供应商故障，也不证明跨档自动降级、Magpie 或 Monad fallback。

```sh
# 不带 --execute 只输出方案；固定最多1次真实请求、128 completion tokens，不自动重试。
node --import tsx scripts/verify-live-fallback.ts --config /absolute/private/demo.monad.json --output /absolute/new-output --execute
# 已有目录只能审计，不再执行付费调用。
node --import tsx scripts/verify-live-fallback.ts --audit-output /absolute/existing-output
node --import tsx --test scripts/test/live-fallback.test.ts
```

2项受控测试覆盖成功、原付款缓存/重启、防重复执行、证据篡改拒绝与备用派发结果未知时停止。执行日志及签名 handle 保留在私有忽略目录；命令不使用配置内的 Monad 钱包或广播测试网交易。
