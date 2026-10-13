# 本地飞轮复现

`npm run demo` 默认运行本地完整飞轮：真实 Anvil 交易、USDC 6 位、四个业务合约、Underwriter 授权、SDK 支付、Relay receipt、Docker Arena 与独立结算进程。Identity/Reputation 使用明确标记的本地 mocks，推理上游使用明确标记的 FAKE Python 返回；该本地流程没有测试网广播或付费模型调用。目标链11笔部署/配置、七轮真实业务及反向链上路径已完成，标准CLI已输出DEMO_RESULT并通过最终审计；hero第三单Explorer和真实before四图已验收，真实after页面已验收，60秒备用录像已验收。

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
npm ci
docker info
docker pull python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111
npm run demo
```

需要 Node 22、Foundry Anvil、可用的本机 Docker daemon。Docker 不可用时命令在业务交易前失败，没有自动降级到宿主机执行。`ANVIL_BIN` 可指定路径，例见 `scripts/demo.local.env.example`。默认输出新目录 `demo-output/local-时间戳-随机值/`，`--output /absolute/new/path` 指定新目录；已有目录拒绝覆盖。所有 RPC/HTTP 只监听本机，使用独立临时端口。

## 现场演示与前端

```sh
npm run demo -- --mode local --serve --pause-before-third
```

脚本先注册三名 Agent，并通过真实交易完成初始化。每名 Agent 初始 cash `40000`、backstop `10000`；treasury 存入 `10000000`，poster 获得并授权 `1200000` 的总任务 reward。每单 reward `150000`，推理 price `120000`，协议费 `0`。角色钱包都只使用脚本生成的公开合成私钥；不得将它们用于任何真实网络。

高分 Agent 完成三单，得到 `710 / A`。违约 Agent 收到 FAKE 上游返回的 `print('PASS')`，原样提交给 Arena 后失败，产生真实 default 记录和冻结。主角预置两次真实还款，暂停点输出 `LIVE starting point`，状态为 `640 / B`、cash `78700`。主角第三个 task 此时尚未创建或 accept。Arena 仅预配本次独占 Anvil 的真实 `nextTaskId`；现场建单后必须从真实 `TaskCreated` receipt 验证相同 ID，仍须链上 Assigned 才能提交。

在另一终端用输出的绝对路径启动前端：

```sh
FRONTEND_MODE=chain FRONTEND_MANIFEST_PATH=/absolute/path/demo-output/local-.../manifest.json npm run dev --workspace @agentfuel/frontend
```

打开 `http://127.0.0.1:3000`，选择主角。暂停终端按 Enter 后才执行第三单的 `createTask → acceptTask → SDK 借款买推理 → Docker PASS → settle`，输出 `LIVE tx1=... tx2=...` 及第三单 tx4。金额均为 USDC 原始整数：

| 单次 | 本金 | 费用 | 清算后 cash | 分数/Tier |
| --- | ---: | ---: | ---: | --- |
| 预置第一单 | 80000 | 12000 (15%) | 58000 | 570 / C |
| 预置第二单 | 62000 | 9300 (15%) | 78700 | 640 / B |
| 现场第三单 | 41300 | 3304 (8%) | 105396 | 710 / A |

成功后 `--serve` 保持本次 Anvil 与三个服务存活，方便档案页刷新。Ctrl-C 关闭本次进程并删除本次 IPC 临时目录；不删除其他 Anvil/Docker 实例。普通无 `--serve` 命令成功后关闭服务，保存文件用于复查。`--pause-before-third` 需要交互 TTY，在启动前验证。

反向证据在现场前生成：主角支付非白名单地址得到实际 mined `status=0`，另一次高分 Agent 转移身份后 wallet 被清空、重新绑定，再使用旧授权借款得到 `IdentityChanged`。之后 guardian 显式冻结高分 Agent。当前本地 mock 的绑定签名为 mock 自己的 digest，仅证明本地协议拒绝行为；canonical EIP-712 签名兼容性由 ERC8004 固定区块 fork 测试证明。真实模式将调用该工具层，不使用 mock 的 `transferIdentity` 或 `walletBindingDigest`。

## 输出与验收

`manifest.json` 是公开前端清单，包含 chain/network、asset、四合约、3 agents、Underwriter/Relay/Arena URL 和逻辑 service/model；没有 verifier key、IPC token 或任何私钥。清单 network 与 provider 名称明确显示 `Local Anvil / MOCK / FAKE`。

- `evidence/demo.json`：每单 tx1–4、本金/费用/cash、分数、Tier、真实反馈状态、反向失败交易、物理资产账本与完成边界。
- `evidence/settlement-ID.json`：真实 tx4 receipt、解码 `LoanRepaid` 或 `LoanDefaulted`、`NewFeedback` 及 Arena verdict；成功一单必须有两条反馈，失败一单一条 default，不能只看 receipt 成功。
- `evidence/inference-ID.json`：实际上游结果、Relay receipt、实际提交的代码。仅可去除完整外层 Python Markdown fence，模型错误不会替换为答案。
- `evidence/chain-receipts.json`：本次所有部署/初始化/业务/反向交易的完整 receipt，可核对现场 tx1/tx2 在主角第二单 tx4 之后。
- `private/`：权限 `0600` 的合成角色、服务配置、SDK PaymentHandle、结算 journal 和 Anvil chain dump。该目录不交给浏览器。

```sh
npm run test:demo
npm run typecheck
```

定向测试实际执行 Docker/Anvil/HTTP/SDK 完整命令，没有静默 skip。它核对三单整数金额、6 次还款及 1 次 default、反馈 sent/count、上游调用与 provider 入账均为 7 次、现场交易顺序、真实失败交易没有日志、公开清单与私有文件权限，以及本次 RPC/Arena 退出。最终物理 USDC 余额必须满足 Manager=vault+backstopTotal、Account=各 Agent cash 总和、Escrow=仍 Assigned 的身份拒绝任务 reward `150000`。

SDK 在付款广播前持久化 PaymentHandle，单次支付不确定时仅 `resume` 相同 handle。结算进程在广播前保存原始签名交易。当前 local runner 创建新链/新目录，整体中断后不支持把整条链的 tx0 再跑一遍；输出目录覆盖会被拒绝，也没有宣称全流程 crash resume。服务级恢复规则以各服务 README 为准。不要因失败重新创建同一个 paid 请求。

本地验收：2026-10-02 执行 Agent `test:demo` 2/2、0 skip；root 独立 2/2、0 skip，37.2 秒。该结果只覆盖本地真实交易与明确模拟的 registry/upstream。

## Monad 只读准备与后续执行

正式配置模板为 `scripts/demo.monad.example.json`，占位地址故意无效，必须填写真实公开角色地址及本机绝对文件路径。业务四合约地址不写死：省略 `contracts` 时显式 execute 会部署四合约并接线；已有部署可添加 `{manager,adapter,account,escrow}`，预检验证 owner、asset、registry、角色和接线，不允许连接其他部署。只支持 Monad testnet `10143` 与已验证测试 USDC 6 位，canonical registry pair 明确指定并验证 EIP-712 domain。

```sh
# 默认只读：不读取key字节，不部署/签名/广播，不验证Kimi key可用性。
npm run demo -- --mode monad --config /absolute/private/demo.monad.json --rpc-transport system-https-proxy
# 可选运行时端点；原配置文件和配置hash保持不变。
npm run demo -- --mode monad --config /absolute/private/demo.monad.json --rpc-transport system-https-proxy --rpc-url https://testnet-rpc.monad.xyz

# 可独立复查的公共RPC fixture；地址全是合成公开测试值，禁止充值。
node --import tsx scripts/demo-preflight-fixture.ts --rpc-url https://testnet-rpc.monad.xyz

# 离线配置/恢复故障测试：只本地Anvil，无公网或模型调用。
npm run test:demo:monad
```

只读 preflight 输出 canonical domain/pair/USDC 核验、读取区块、每角色余额、按复用地址合并后的资金需求、密钥文件是否存在及权限，以及 `canStartFresh`。它仅 stat 密钥文件，`keyAddressesNotChecked`、`apiKeyValidityNotTested` 始终明确标记。完整官方 Kimi model/baseURL/requestOptions 由配置指定；国际/中国区 endpoint 与账户需相符，`max_tokens` 限制每次输出，逻辑 service/model 仍为 `infercredit/coder` / `coder`。示例参数来源见 [MoonshotAI Kimi-K2.5 官方说明](https://huggingface.co/moonshotai/Kimi-K2.5)。执行时模型输出原样进入 Arena，错误不会替换答案，也没有 FAKE fallback。

最小配置使用 7 个签名钱包：management、underwriter、verifier、hero、veteran、defaulted、rotatedWallet。management 可同时担当 deployer/guardian/treasury/poster/rotatedOwner，指向同一 `.key` 文件；3 个 Agent、underwriter 与 verifier 必须独立。provider 仅需收款公开地址，示例复用 rotatedWallet；refunder 可复用 management，但本 demo 不启用退款服务。provider 不可等于 poster，避免把 escrow 扣款/违约退回混入付款收款证据。没有为 provider/refunder 要求新 key 文件或入金。

每个 key 文件为一个 `0x` 私钥的 UTF-8 文本，Kimi 文件为 API key 文本；权限必须为 `0600` 或更严格。verifier 文件禁止与其它角色共用，controller/执行脚本不读它，只有独立结算子进程读。显式 execute 在任何 setup 交易前，先用该子进程检查地址与 `roles.verifier` 匹配。专用随机钱包及所需资金分发已完成；11笔部署/配置已验收，当前业务批及证据路径见下文。

| 角色 | 精确 USDC 原始整数需求 | 原生币 gas 预算单位 |
| --- | ---: | ---: |
| treasury | 10000000（$10 流动性） | 300000 |
| poster | 1200000（8 × $0.15 reward） | 2000000 |
| hero / veteran / defaulted | 每人 50000（cash40000 + backstop10000） | 3000000 / 3000000 / 2000000 |
| deployer | 0 | 20000000（部署/接线/限额/白名单） |
| guardian | 0 | 1000000 |
| verifier | 0 | 14000000（7 × 显式2M gas settle） |
| rotatedOwner / rotatedWallet | 0 | 300000 / 1000000 |
| underwriter / provider / refunder | 0 | 0（本次没有链上发送） |

总初始 USDC 为 `11350000`（$11.35），流动性和任务 reward 是演示资金。复用地址时需求相加：最小 management 需要 `11200000` USDC 与 `23600000 × 当前maxFeePerGas` 的 MON 原始整数预算；rotatedWallet/provider 需要 `1000000 × 当前maxFeePerGas`。gas 单位是保守预留，不是声称确切实际手续费；preflight 读取当前 fee cap 后给出具体 wei 数。真实 Kimi 消费属于另一个 API 账户，最多 7 个业务请求，另须有 API 余额；preflight 不发付费请求测余额，也不承诺中断后的上游调用严格仅一次。

2026-10-02 钱包准备完成：7个钱包由密码学随机熵生成，未使用本地demo的合成key。[私有配置](/Users/jungle/.config/agentfuel/monad-demo-20261002T011344Z-4df31740/demo.monad.json)引用项目外绝对key文件路径，并固定Monad测试网10143、USDC6位、`kimi-k2.6` / `https://api.moonshot.cn/v1`、temperature1/max_tokens2048；省略`contracts`等待新部署。私有目录0700，配置、7个私钥和经授权提取的Kimi key均0600。原始地址与逐钱包预算见[公开清单](../demo-output/wallet-setup-20261002T011344Z-4df31740/funding.md)和[JSON](../demo-output/wallet-setup-20261002T011344Z-4df31740/funding.json)，所需资金现已完成分发；underwriter只做离线签名，无需MON/USDC，blockedProvider没有保存私钥，也无需充值。

钱包生成阶段，首个eth_gasPrice读取失败后，执行Agent一次10秒有界getFeeData读到maxFeePerGas202000000000 wei，采用正式预检的`maxFeePerGas ?? gasPrice`口径，合计MON预算估计9.4132。该数值不是最终手续费；当时未查询钱包余额或充值。主Agent独立本地验证exit0：parser成功、11签名角色对应7独立钱包、地址派生/权限/公开文件无secret、USDC与gas聚合及feeCap乘法均正确；这次验收没有网络或签名。生成阶段未广播、部署、领币或调用付费API。历史直连preflight与代码生成ECONNRESET记录保留；后续官方RPC系统代理完整preflight及真实Kimi链外代码判题已通过，范围见下文。

随后经用户授权完成专用钱包资金分发，主Agent最终独立验收PASS：[审定计划](../demo-output/distribution-plan-20261002T025832Z-2b303bac/plan.json)共10笔真实Monad testnet10143交易，补差9.4132 MON与11.35 USDC，underwriter保持0。每笔receipt为status1，4笔USDC精确Transfer日志、固定块目标余额、source守恒与nonce10均已核对。实际费用0.064627812 MON；分发账户`0x48aEd9c702B97A18A520edA3BB04d959453f0B80`剩4.222172188 MON与8.65 USDC，见[最终核对](../demo-output/distribution-plan-20261002T025832Z-2b303bac/post-check-20261002T032305Z-fa7a8af4/summary.json)、[完整receipts](../demo-output/distribution-plan-20261002T025832Z-2b303bac/post-check-20261002T032305Z-fa7a8af4/full-chain-receipts.json)和[最终余额](../demo-output/distribution-plan-20261002T025832Z-2b303bac/post-check-20261002T032305Z-fa7a8af4/final-balances.json)。这些是钱包资产分发，不是四业务合约部署或业务飞轮交易。

`scripts/distribute-demo.ts`是已完成的本次固定计划专用脚本，不要换输出目录重复发送。原目录`private-distribution/journal.json`保存原始已签交易，receipt摘要与post-check证据保留；恢复仅使用原plan/目录/原raw。资金分发本身没有部署合约或调用LLM。部署和七轮业务结算现已完成；真实after页面已验收，60秒备用录像已验收。

官方端点两次execute尝试均在预检失败，未创建output、签名或广播；一次`eth_call`观测为`SERVER_ERROR`，不能据此断言HTTP原因。官方/Ankr两端点窄对照4/4 HTTP200、chain与registry pair一致，见[报告](../demo-output/rpc-pair-comparison-20261002T041123Z-e23e3f1f/report.json)，不等于完整preflight或部署通过。

Ankr四合约部署与剩余配置共11笔已全部成功，见[deployment.json](../demo-output/monad-20261002-deployment-89b14f6d/evidence/deployment.json)与[post-check summary](../demo-output/monad-20261002-deployment-89b14f6d/evidence/deployment-post-check/summary.json)：固定block67453689、62 checks全pass。root独立解码全部raw/data、11份receipt/fee及4份创建artifact+constructorargs，另联网同块hash/nonce11/MON3.793224236/outstanding0 PASS。原[4创建receipt](../demo-output/monad-20261002-deployment-89b14f6d/evidence/partial-deployment-receipts.json)与wire-manager原raw保留；此前HTTP503与只读resume停止为历史记录，不再代表当前部署未完成。

当前目标链已完成七轮：veteran三单、defaulted一单、hero三单，包含六次真实Kimi/Docker PASS/还款及一次违约清算。[最终demo证据](../demo-output/monad-20261002-deployment-89b14f6d/evidence/demo.json)记录completed=true、七轮tx1–4及反向路径；[原640/B checkpoint](../demo-output/monad-20261002-deployment-89b14f6d/evidence/preset-640b-paused.json)保留第三单前的两次还款。当前数字如下：

| Agent | 分数/Tier | cash（USDC原始整数） | 结算次数 | 主要证据 |
| --- | --- | ---: | --- | --- |
| hero1977 | 710 / A | 105396 | repaymentCount3 | [第三单](../demo-output/monad-20261002-deployment-89b14f6d/evidence/settlement-8.json) |
| veteran1979 | 710 / A | 105396 | repaymentCount3 | [第三单](../demo-output/monad-20261002-deployment-89b14f6d/evidence/settlement-3.json) |
| defaulted1980 | 100 / C | 0 | defaultCount1 | [违约清算](../demo-output/monad-20261002-deployment-89b14f6d/evidence/settlement-4.json) |

分数/Tier由执行器断言；root另在block67768315独立核验hero第三单tx4 status1、LoanRepaid41300/3304、TaskSettled repaid44604/toAgent105396、双反馈，以及hero cash105396/repaymentCount3/outstanding0，见[receipt审计](../demo-output/monad-20261002-deployment-89b14f6d/evidence/root-final-receipt-audit.json)。[资产审计](../demo-output/monad-20261002-deployment-89b14f6d/evidence/root-final-asset-audit.json)在block67774475独立核对manager10091208=vault10061208+backstop30000、account210792、escrow150000，匹配执行器；provider实际余额增量840000由CLI最终审计断言。真实SpendRejected、IdentityChanged拒绝、canonical身份重绑定及guardian冻结已完成。第三单初次结算后发生[PROFILE_READ_FAILED](../demo-output/monad-20261002-deployment-89b14f6d/evidence/hero-3-post-settlement-profile-failure.json)；同配置/output恢复复用了Delivered PaymentHandle8、context.fee3304和原settlement8，无重复支付或模型调用，最终输出DEMO_RESULT并进入serve。该历史错误未记录实际HTTPstatus，不能追溯推断。2026-10-04已补齐后续诊断：profile非2xx时，CLI在`PROFILE_READ_FAILED`后另输出如`{"diagnostic":{"httpStatus":503}}`的白名单JSON；无HTTP响应不推测状态，不输出URL、响应正文或密钥，也不新增重试。root独立定向4/4与根typecheck通过，未重跑交易或模型调用。真实before四图、after页面及第三单Explorer均已验收；最终60秒备用录像已验收。

此前未付旧quote的[nonce12取消交易](https://testnet.monadexplorer.com/tx/0x364f6363479dde18c72159126aee71830bfcdd4d09de4679eacaa962d4602660)与[旧handle归档](../demo-output/monad-20261002-deployment-89b14f6d/evidence/expired-payment-2-archive.json)保留。唯一0600配置仍为`demo.monad-ankr.json`，output仍为`/Users/jungle/Desktop/dev/agentfuel/demo-output/monad-20261002-deployment-89b14f6d`。以下是原运行正常关闭后使用的恢复/serve命令，继续复用同目录、配置和交易记录；已存在的hero第三单会跳过pause，不新增付款或模型调用：

```sh
npm run demo -- --mode monad \
  --config /Users/jungle/.config/agentfuel/monad-demo-20261002T011344Z-4df31740/demo.monad-ankr.json \
  --rpc-transport system-https-proxy --rpc-url https://testnet-rpc.monad.xyz --execute --resume \
  --output /Users/jungle/Desktop/dev/agentfuel/demo-output/monad-20261002-deployment-89b14f6d \
  --pause-before-third --serve
```

`--stop-after-deploy`完成后输出`DEPLOYMENT_PAUSED`，不能与`--serve`或`--pause-before-third`并用。官方RPC经system-https-proxy已由root独立只读核验可用，getLogs上限100块，后端与前端均按100块分页；旧未付quote恢复全零检查不扫描日志、不移动watermark。完整服务scripts代理已接线，root独立typecheck、Arena11/11、Monad13/13、localdemo2/2通过；这些本地结果不代替真实全链验收。请求级传输支持取消与连接清理，只有显式代理的单个只读RPC HTTP503最多重试3次（共4尝试，退避250/500/1000ms，共用原30s截止时间）；写交易、其他状态、Kimi均不重试，Kimi不redirect。默认服务30s；Monad启动等待90s、结算180s、判题240s。

业务 transaction journal 在广播前保存原始签名 bytes；canonical `register` 仍通过 ERC8004 工具层并从真实 receipt 提取 ID。输出状态绑定原配置 hash，换 chain/asset/roles/deployment/config 会拒绝 resume；`--rpc-url <HTTPS端点>`仅覆盖本次运行RPC，不改原配置、hash或journal。带 path API key 时使用互斥的 `--rpc-url-file /absolute/private/rpc-url.txt`，文件必须属于当前用户且为 `0600`，内容为完整 HTTPS URL；不要把带 key 的 URL 放命令行或原公开配置。私有覆盖贯通 provider、服务、SDK 和独立 settler，公开 manifest 保留原配置的公开 RPC；普通 `--rpc-url` 覆盖的 manifest 仍使用该公开端点。preflight 和 deployment 证据只记录 `rpcOrigin`，不记录有效 URL 的路径。Next server 使用同一项目外文件的 `FRONTEND_RPC_URL_FILE` 覆盖，仅服务器读取，不进入页面或 publicConfig；这两项私有URL文件支持已由root独立验收。传输显式选择`--rpc-transport direct`或`--rpc-transport system-https-proxy`（默认direct）；失败不自动切换端点或fallback到另一传输。恢复仍使用上面的Ankr配置和原output；切端点时在同一resume命令追加对应flag，已签交易仍只重播原bytes，不改配置文件或创建新目录。SDK handle 保持原 relay URL/端口和支付，Relay 恢复会重用同 payment；结算重放原可信 controller verdict 与原签名交易。第三任务仅在实际 receipt 得到 ID 后绑定到 Arena，窄重启同端口服务；未完成 create 的 `id:""` 不会成为可提交任务。已开始第三单的恢复不强求链上仍处于640/B。

结算 IPC 在恢复中复用原记录目录，现有 `recoverStaleSettler` 只处理确认为死进程的 socket/owner/token。活着的 orphan signer 会明确阻止启动，需要先处置该已识别的旧进程；不能盲目删 socket。正常退出先原子备份结算 journal，再删本次临时目录，备份失败保留唯一源并返回错误，同时关闭其它本次服务。故障测试覆盖备份失败、恢复中断、live signer 拒绝、第三单已开始/空ID恢复、独立 verifier 地址检查，以及真实 Anvil 原交易重放只有一次付款。

恢复有签名与任务时限：钱包 consent 300 秒、underwriter 授权约30分钟、任务约48小时。Monad测试网演示的新报价有效期为900秒（15分钟），仅影响未来新报价；已落盘旧报价仍按原deadline执行，SDK与过期拒绝语义不变。已广播交易只重播原 bytes，不能靠刷新过期签名制造新付款。身份例子转移前可重新获取未消费旧身份授权；转移后若旧授权已过期，明确报 `IDENTITY_EXAMPLE_AUTHORIZATION_EXPIRED_EVIDENCE_RETAINED`，不会把 `AuthExpired` 当 `IdentityChanged`。原钱包同意签名若跨期，记录实际 `WALLET_DEADLINE_INVALID` 拒绝原因；正常及时执行为 `IDENTITY_OWNER_CHANGED`。模型返回失败、声誉 pending 或 API 配置错误都会停下并保留证据。

四业务合约均通过官方Sourcify源码验证，状态match，见[验证报告](../demo-output/monad-20261002-deployment-89b14f6d/evidence/source-verification/report.json)。root已在[hero第三单tx4](https://testnet.monadvision.com/tx/0x97e3efaeb95de59771739d08249d36c82d0314c8f8f3c203463c97f9b3f2eb8c)实际Explorer Logs页确认LoanRepaid本金41300/fee3304、TaskSettled repaid44604/toAgent105396、两条FeedbackSent及canonical NewFeedback index5/6均解码，可以指认还款与反馈。before/after/Explorer分段备用录像已由root验收，ENGINEERING §9完整DoD在本轮既定范围内完成；不表示性能已适合生产使用。

## 2026-10-03 独立验收与剩余边界

主Agent最新独立typecheck、Relay8/8、Arena11/11、`test:demo:monad` 13/13与local `test:demo` 2/2通过，覆盖代理/超时清理、11笔部署暂停/恢复、运行时RPC覆盖与诊断journal修复，以及既有角色/IPC/付款/fresh guard检查。本地测试不访问公网或真实模型；专用钱包、10笔测试网资金分发、七轮真实业务及root最终固定块审计另有链上证据。标准CLI和真实after页面已验收，最终60秒备用录像已验收。

前端本地已由root独立验收：`typecheck:all`、frontend Node12/12、Next build、dashboard桌面/手机4/4；只读失败证据另独立Anvil2/2与真实Next API browser1/1通过。server代理、proxy模式credit120s/Arena90s、刷新单请求guard与历史SpendRejected核验已审，生产static未包含proxy/Node入口。100块分页、最近2000块资金流窗口及完整账本读取已有真实Anvil3/3与Next build验收。最新任务头/详情优化另经root独立真实Anvil3/3通过：三个不同快照、七个归属任务、零Open场景，业务Task读取168→70；各profile原区块、窗口外历史债务、清单外Open与8并发上限均保持，见[断言](../frontend/test/chain.test.ts)。该计数不包含credit和日志读取。此次真实导航返回385.229秒、hero可读385.456秒，原为461.732秒，单次快76.276秒（约16.5%）；不是基准或持续性能保证，读取仍明显慢。

真实Monad before四图已由root实际页面验收：[hero640/B](../demo-output/monad-20261002-deployment-89b14f6d/video/hero-before-2026-10-03T07-01-56-758Z.json)、[veteran710/A及身份冻结](../demo-output/monad-20261002-deployment-89b14f6d/video/tier-a-and-identity-freeze-2026-10-03T07-01-56-758Z.json)、[defaulted100/C](../demo-output/monad-20261002-deployment-89b14f6d/video/actual-default-2026-10-03T07-01-56-758Z.json)、[已mined SpendRejected解码](../demo-output/monad-20261002-deployment-89b14f6d/video/actual-mined-spendrejected-2026-10-03T07-01-56-758Z.json)。早期[部署数据读取失败](../demo-output/monad-20261002-deployment-89b14f6d/video/incomplete-2026-10-03T06-22-17-634Z.json)保留为历史，已不代表当前before状态；root已实际验收[after页面](../demo-output/monad-20261002-deployment-89b14f6d/video/real-hero-after-2026-10-03T08-07-25-127Z.json)：710/A、cash0.105396USDC、debt0、还款3/成功3/default0；Task8 Settled/0 Repaid/repayment已写回，无read errors。真实页面DoD通过。

真实before/after页面均已验收；[after录制失败记录](../demo-output/monad-20261002-deployment-89b14f6d/video/after-incomplete-2026-10-03T08-07-25-127Z.json)来自脚本错误要求已清零loan显示历史还款0.044604的断言，页面正确，历史还款仍以receipt为据。脚本已修；[60秒备用录像](../demo-output/monad-20261002-deployment-89b14f6d/video/real-demo-short.mp4)已由root独立ffprobe和实际抽帧验收，H264、1440×1000、25fps，另经独立Agent核全部after/Explorer场景。影片如实分段，明确说明跨录制、已删去网络/服务恢复等待、Task8真实末帧停留4秒，以及“区块浏览器实拍截图”；不是全程连续录像。保留[cutlist](../demo-output/monad-20261002-deployment-89b14f6d/video/real-demo-short-cutlist.json)、[before原片归档](../demo-output/monad-20261002-deployment-89b14f6d/video/before-incomplete-archive-2026-10-03T07-01-56-758Z.json)、[after原片](../demo-output/monad-20261002-deployment-89b14f6d/video/after-incomplete-2026-10-03T08-07-25-127Z.webm)、[Explorer实际截图与captureUTC](../demo-output/monad-20261002-deployment-89b14f6d/video/explorer-root-captures.json)和[Explorer录制HTTP403失败证据](../demo-output/monad-20261002-deployment-89b14f6d/video/explorer-chapters-2026-10-03T08-23-19-957Z.json)，原completed=false保持不改。production前端仍使用真实manifest和server-only `FRONTEND_DEMO_STATE_PATH`，复用现有before/after原片。

脚本用Playwright官方`recordVideo`记录真实UI，不连接钱包或点击付款/提交；所有非GET/HEAD请求均阻止，本地app写请求使录像验收失败，外站analytics被阻只记诊断，不放行未知POST。第三单已由原CLI现场执行，after录像只读最终档案与原Explorer交易，不再发送Enter执行业务。保留原始before/after视频、章节及失败记录；剪辑须说明分段与等待缩短，不能把独立片段写成连续现场录像。最近资金流仍只有2000块窗口，已结算任务与债务按完整账本读取；不能为画面构造替代历史事件。

已有合约地址只适用于专用空业务部署，不支持共享部署。`freshDeploymentReady`要求Manager outstanding/vault/backstop为0、三个业务合约资产余额为0、Escrow totalEscrowed为0且nextTaskId为1，并纳入`canStartFresh`。非resume execute在写交易前拒绝非空部署；resume按原配置/output恢复，不因本次已发生业务再次被空业务guard拒绝。

### 官方RPC系统HTTPS代理完整preflight

执行Agent使用配置中的官方RPC，经系统HTTPS代理完成一次完整只读preflight：25 requests / 103.306秒，block67440335、feeCap202 gwei，7个地址资金与secret metadata检查完成，`canStartFresh=true`，见[报告](../demo-output/monad-preflight-proxy-20261002T034925Z-7d497ee4/report.json)。未读取key字节、签名、广播或请求模型；主Agent审代码与报告，未独立重跑联网。代理在单个请求层接入，不改全局传输、不切换RPC端点；完整只读报告不证明后续部署或业务已成功。

历史直连失败保留：公共完整fixture双方均报`PUBLIC_RPC_PREFLIGHT_UNAVAILABLE_NO_TRANSACTIONS_SENT`；执行Agent网络发现诊断仅2个`eth_chainId`后`ECONNRESET`，主Agent独立最小对照仅证明当次链ID/单请求成功。随后[真实钱包完整直连preflight](../demo-output/monad-preflight-20261002T012646Z-67d8f30d/report.json)15.734秒后在角色余额阶段失败，没有完成metadata或`canStartFresh`，主Agent只审报告。这些历史记录不再表示当前完整preflight未通过，也不能确定连接重置来源。

### Kimi真实代码与链外Docker判题

经用户授权，从指定源配置在进程内使用Kimi key；新一次真实请求通过系统HTTPS代理返回HTTP200、455 tokens、0重试。保留[report.json](../demo-output/kimi-arena-proxy-20261002-bb06d69c/report.json)、[response.json](../demo-output/kimi-arena-proxy-20261002-bb06d69c/response.json)和[submission.py](../demo-output/kimi-arena-proxy-20261002-bb06d69c/submission.py)。代码仅经现有`inferenceCode`提取，原响应/提交code hash已核验；Docker hiddenTests 5/5，主Agent独立离线复跑原代码5/5，没有为验收重复调用付费API。

范围仅实际模型代码→DockerExecutor→host逐条JSON判题，不包含`ArenaController.submit`的Assigned身份、IPC、settler、推理付款或链上清算。历史[最小chat probe](../demo-output/provider-probe-20261002-a39de297/report.json)HTTP200/OK/42 tokens及[直连代码生成失败](../demo-output/kimi-arena-20261002-837ba0ce/report.json)ECONNRESET/无代码均保留；失败已被后续生成成功补充，不能再写当前没有可判题代码。链外5/5和已通过preflight不能代替完整Monad联调。
