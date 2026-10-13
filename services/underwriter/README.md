# Underwriter

最小只读链服务：返回信用资料，签发任务绑定的 EIP-712 授权，并保存证据 JSON。服务不连接交易签名者与 RPC，不广播交易。默认只监听 `127.0.0.1`。

需要 Node 22、npm 和已有 Foundry。仓库根目录安装、检查、测试：

```sh
export PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:/Users/jungle/.foundry/bin:$PATH
npm ci
npm run typecheck
npm test --workspace @agentfuel/underwriter
```

该 workspace 测试先构建 Foundry artifacts，再启动测试自己创建的本地 Anvil；使用合成私钥、真实四合约与 mocks，通过 HTTP 获取授权并实际调用 `AgentAccount.payProvider → CreditManager.draw`。测试覆盖 USDC 6 位和原生币 18 位，结束清理自己的进程与临时证据，不访问测试网。`ANVIL_BIN` 可显式指定 Anvil 路径。根 `npm test` 还包含其他 workspace 的本地测试；canonical 公网 fork 单独显式运行。

复制本目录 `.env.example` 到本目录 `.env`，填入真实部署后的 `MANAGER_ADDRESS` 和独立 underwriter key，再从仓库根目录运行：

```sh
cd services/underwriter
node --env-file=.env --import tsx src/main.ts
```

示例锁定 Monad testnet `10143`、测试 USDC `0x534b2f3A21130d7a60830c2Df862319e593943A3`、6 位小数；当前 Manager 未部署，示例留空，直接运行会拒绝。启动时和每次签名前均验证 RPC chainId、Manager underwriter、结算资产和小数位；Adapter、Account、Escrow、registries 从 Manager 推导，Reputation 的 identity 引用也须一致。原生币模式显式使用零地址和 18 位。`TOKEN_USD_PRICE` 是固定演示 USD/token（最多 18 位小数），默认 `1`，没有价格 oracle。

请求示例（整数都用十进制字符串，不能用 JSON 数值）：

```sh
curl http://127.0.0.1:8787/agents/1/credit
curl http://127.0.0.1:8787/authorize \
  -H 'content-type: application/json' \
  -d '{"agentId":"1","taskId":"1","nonce":"1"}'
```

信用响应包含镜像 `mirror`、Manager 真值 `truth`、评分/Tier/费率、Tier 原始单位限额、身份、协议冻结/暂停和读取区块。评分只消费 `[Adapter]`、`infercredit` 三项反馈的 count。A/B 同时要求 Manager 真实还款达到 3/1 次；任一来源有违约就拒绝，镜像延迟只推迟升级。

反馈写入使用 try/catch；自动 gas 估算可能只保证交易成功，选中反馈失败的低 gas 分支。调用方须查看 `pendingFeedback`/反馈计数，给 retry 足够 gas，不能把 receipt status=1 当成镜像已写入。集成测试保留真实 settle 失败后 pending/retry，并为直接造镜像的 fixture 显式给足 gas。

授权响应包含 `authorization`、`signature`、`domain`、区块和 `evidenceHash`。服务用同一区块快照验证身份/归属/任务期限/loan/nonce，并按任务快照净 escrow 和 fee 对本金 cap 做两次整数向下取整；所有金额和计数使用 BigInt。授权有效期 30 分钟，due 为任务 deadline 与 24 小时后的较早值。服务不保留 nonce 数据库：多个尚未消费的签名可能使用同一 nonce，链上集合决定唯一消费；每个 task 仍只能 draw 一次。

证据按固定字段顺序序列化，BigInt 转十进制字符串，精确 UTF-8 字节的 keccak256 进入签名。写入 `${EVIDENCE_DIR}/${evidenceHash}.json`（临时文件后原子 rename）成功才返回；证据不包含私钥或 RPC URL。`EVIDENCE_DIR` 默认为启动工作目录下 `evidence/`，已忽略提交。客户端仍须实际付款：签发不是资金预留，之后身份/任务/预算/余额变化可使链上执行拒绝。

HTTP body 上限 4096 bytes，参数超出 uint256、非标准十进制或多余字段返回 400；业务拒绝返回 409 和具体 code；RPC/证据存储失败返回 503，不返回 ethers 原始错误。浏览器调用时显式配置 FRONTEND_ORIGIN 精确来源；默认不开放跨域。服务没有身份登录、nonce 队列、relay 或标准 x402 facilitator 支付实现；当前支付 scheme 是项目自建 402/receipt，标准 facilitator 兼容性尚未验证。
