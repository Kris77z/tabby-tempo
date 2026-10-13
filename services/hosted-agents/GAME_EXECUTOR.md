# 托管 Agent 单手与奖励额度

`createHostedGameExecutor(config, dependencies?)` 返回实现 `HostedExecutor` 的实例，只处理 `game` 与 `credits`。由 HostedService 先认证 owner、核对 Agent 归属和赞助次数，再调用该实例；实例不提供独立用户认证接口。`loadHostedGameExecutorConfig(file)` 只读验证私有配置，适用于 CLI `--check`，不创建目录、不连接网络。`close()` 关闭实例自有的 RPC 和模型代理连接。

每局是一位已开户托管 Agent 对固定平台 bot 的免费德州单手。用户选择的模型 ID 是实际 HTTP `model`，三种策略使用固定系统指令；模型只收到当前 seat 的合法动作、自己的牌与公共状态。默认每手最多 20 次请求，每次最多 512 completion tokens，10 分钟截止，模型零重试。旧 `runLiveHand` 未设置 `profiles` 时保持原默认请求和 journal 格式。

可信配置字段如下，全部由平台运营提供，HTTP command 不接收这些字段：

```json
{
  "version": 1,
  "chainId": "31337",
  "identity": "0x...",
  "account": "0x...",
  "token": "0x...",
  "publicRpcUrl": "http://127.0.0.1:8545/",
  "rpcTransport": "direct",
  "upstreamTransport": "direct",
  "sponsorKeyFile": "/absolute/private/sponsor.key",
  "opponent": {
    "binding": { "chainId": "31337", "agentId": "2", "wallet": "0x..." },
    "keyFile": "/absolute/private/bot.key",
    "modelId": "kimi-k2.6",
    "strategy": "balanced"
  },
  "models": [{ "id": "kimi-k2.6", "baseUrl": "https://api.moonshot.cn/v1", "keyFile": "/absolute/private/model.key" }],
  "creditsDirectory": "/absolute/private/hosted-credits",
  "walletDirectory": "/absolute/private/pi-task-wallets"
}
```

配置、wallet key、模型 key 与 RPC 文件须为当前用户所有、`0600` 的普通文件，路径须真实绝对路径，不接受软链。模型上游只允许原官方 Moonshot `/v1`；`upstreamTransport` 可选现有 `system-https-proxy`，默认 `direct`，不会给模型增加重试。Monad `10143` 使用 `rpcUrlFile` 替代 `publicRpcUrl`，沿用 `monadProvider` 和原只读网络设置；31337 仅允许环回 HTTP RPC。`walletDirectory` 必须与托管 task executor 的钱包锁目录相同。

原请求首次冻结 owner、托管 ID、链 ID、链 Agent ID、wallet、两 seat 的模型/策略、平台 bot、赞助 wallet 和合约域，写盘后才调用模型。链 ID、合约代码、六位小数 token、账户 token/identity registry、两 seat 的 `ownerOf` 与 `getAgentWallet` 都须匹配。奖励由私有 deck 和合法 action 重放计算，不读取模型声称的赢家。

`usdc` 奖励总额为 `100000` raw，由平台赞助。赢家或平局份额经过原 `DemoJournal` 的 sponsor transfer、对应 seat approve、`depositCash(该链AgentId,份额)`；每步核对原签名的 from/to/data/chain/value、fresh canonical receipt 与 Transfer/Approval/CashCredited 事件。恢复只使用原 raw/hash，不替换 nonce。此分支不调用借款、任务接单或模型购买。玩家预算 `chargedRaw=0`，奖励现金可留作该 Agent 后续任务预算。

`llm-credits` 沿用 `InferenceRewardLedger` 的 4096 token 总奖，每位托管 Agent 使用独立目录 `<creditsDirectory>/<hostedId>`，该目录固定 actor 和 bot 的真实身份。`credits` action 使用该 Agent 原 request ID 兑换一次固定短确认请求，实际模型固定 `kimi-k2.6`，最多 128 completion tokens，按真实 usage 扣 tokens；不返回模型正文。`creditsGranted`/`creditsUsed` 与 USDC budget 分开记录。模型配置必须包含 `kimi-k2.6` 才能兑换这类奖。

恢复同一 Agent 的原 request ID。Queued 后、adapter 尚未建 journal 就崩溃时，恢复可以先创建并冻结 journal。已保存 HTTP dispatch intent、但结果未知时不会重新调用模型，也不折叠成默认动作或发奖；额度消费未知则保留 token 预留。已完整手牌而奖励回执不确定时，可继续核验并恢复原交易。原钱包 slot 仍阻止新 task/game ID 绕过未完成请求。奖阶段的 sponsor 与开户 gas/guardian 共用 `<walletDirectory>/operator/<address>` nonce 锁和原请求 guard，平台 bot 使用普通钱包 slot；未确认奖不会让其他开户/奖绕过该签名。只有已证实终局才释放 slot。GET 的状态由 HostedService 闭集投影，私钥、URL、原签名、牌面、请求/模型正文不进入 HostedResult。

本地验证入口：

```sh
node --import tsx --test --test-concurrency=1 services/hosted-agents/test/game-executor.test.ts
```

测试使用各自新建 Anvil、真实合约与环回受控模型 HTTP；包括两个 owner/托管账户、模型/策略实际请求、USDC 3 笔 canonical 入账、独立 token 余额、原 ID 不增加请求/nonce、未知模型暂停、已广播存款回执断线后的原签名恢复。受控模型会按合法动作脚本响应，不代表已完成真实模型或 Monad 验收。
