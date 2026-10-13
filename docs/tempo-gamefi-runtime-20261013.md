# Tempo GameFi 本地实跑 · 2026-10-13

本轮真实德州和 Tempo 奖励结算已运行，**测试 Actor 获奖后消费的两条闭环尚未通过**。原每 owner 3 局额度已用完：1 局响应格式无效终止，2 局合法终局均由平台对手获胜。不得把合法输局当成 Actor 获奖，或把未执行的任务消费称为已验收。

网络为 Tempo Moderato `42431`，结算和手续费 token 均为 PathUSD `0x20c0000000000000000000000000000000000000`、6 decimals。入口为本机 `http://127.0.0.1:3028/arena` 的 Tempo 卡片 → `/dashboard?section=arena` → 钱包签名登录 → 选择托管 Actor 与赞助德州奖励种类。这里只登录平台账户，不授权链交易。当前禁止公开部署、主网资金和比赛提交。

## 已执行的路径

| 路径 | 实际结果 |
| --- | --- |
| cash Actor 73，第一局 | 3 次真实 K2.6 响应，前两次合法，第三次多带 `chips/allIn` 字段被严格拒绝；没有奖励。 |
| credits Actor 74，第二局 | 1 次合法弃牌，平台 seat 1 赢；该身份唯一获 4096 tokens，Actor 获 0。未兑换或启动 reward-task。 |
| cash Actor 73，第三局 | 格式提示澄清后 5 个动作全合法，平台 seat 1 赢；平台 registry43 收到 `100000` raw PathUSD，经 approve/deposit 进入其 Account cash。Actor 获 0。 |
| cash-task 余额 guard | Actor cash `20000 < 120000`，在创建任务 UUID、接单和付款前正确停止；没有补差。 |
| 四种练习 | holdem/gomoku/chess/balatro 通过真实本地 HTTP 创建、准备、至少一次合法行动、显式认输及每个原请求重放；均为虚拟筹码、本地策略 Bot，零模型调用/链交易/奖励。 |

两位新 Actor 独立钱包各收到一次 `1000000` raw 测试钱包资金准备；仅现金 Actor 明确自有入 cash `20000` raw。这些钱包准备资金不提高 Account cash 或 Actor 消费预算。两个 Actor 的 per-run `120000`、total `300000`、`allowCredit=false` 以及零债务额度保持。最终 finance 确认 cash 分别 `20000` / `0`、debt 均 0、信誉均 `500/C`，成功、还款和违约计数均为 0。游戏不产生贷款或任务成功信誉。

直接游戏供应商响应共 9 次，usage 合计 3443 tokens，completion 102；8 个动作应用、1 个格式无效、无 Unknown。游戏及奖励额度模型通过官方 Moonshot / system HTTPS proxy，现金任务通过既有 Magpie，两个计数域分别记录。此轮 Magpie 仍为原 12 次物理调用 / 24 条 intent-outcome journal 记录，没有新增现金任务模型请求。供应商人民币账单金额未核对，不能称模型成本为零。

原六个新 UUID（两注册、一次自有 deposit、三游戏）从真实托管 API 重放结果一致。六个 hosted Actor、平台对手与全部运营签名角色去重共 12 个地址的 `latest/pending` nonce 前后相同；直接模型/奖励额度 journal 摘要、Magpie 接受计数和物理调用记录也相同。原核心五单、两 Unknown 和四个核心 Actor 历史未重跑。

## 改动与验证

奖励事件核验先匹配 emitter 与业务双方，再要求唯一正确金额；Tempo 同 token 的费用 Transfer 不会被计为奖金，重复或冲突业务 Transfer 仍拒绝。Tempo GameFi 配置及链 preflight 显式验证固定 PathUSD 地址、symbol 和 6 decimals。`live.ts` 只澄清响应格式，保留完整玩家视图、原合法动作及 raise 范围，不修改策略、解析器、输赢或牌堆。

Tempo `/arena` 改为真实托管入口；旧硬编码 Monad 的 GameFi/credits 运营 API 在 Tempo 下禁用，历史档案明确标记 Monad/本地。`section=arena` 实际选中工作台竞技场。四种练习和测试网奖励区域分别说明真实范围。

Game executor 与奖励事件回归 11/11、Tempo chain 3/3、live hand 5/5 通过；最终根目录及前端 `typecheck:all` 通过，Tempo `.next-tempo-gamefi` 生产构建及 3028 实例匹配前端改动。主 Agent 的大厅桌面/手机检查已通过；链上、游戏回放及登录页面的最终独立结果见下方主 Agent 报告。

## 文件与复现

- [脱敏财务、模型和幂等证据](evidence/tempo-gamefi-20261013/financial-evidence.json)
- [四游戏真实本地 API 证据](evidence/tempo-gamefi-20261013/practice-evidence.json)
- [主 Agent 独立验收](tempo-gamefi-root-acceptance-20261013.md)
- [追加测试方案，尚未启用](tempo-gamefi-additional-test-plan-20261013.md)

私有 journal 为 `.data/tempo-gamefi-20261013/acceptance/acceptance.json`、`budget.json` 和 `funding/`，真实 hand/session 与收据保留在现有独立 Tempo runtime 的两个新 Actor 目录；原请求、牌堆、模型正文、auth 和密钥不复制到公开证据。练习状态单独使用 `.data/tempo-gamefi-20261013/practice.json`，私有 HTTP journal 在 `practice-acceptance/session.json`。

只读 finance 刷新和真实终态幂等重放命令：

```sh
PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:$PATH \
AGENTFUEL_RPC_RETRY_READ_503=1 AGENTFUEL_RPC_CALL_GAS_LIMIT=1000000 \
node --import tsx scripts/tempo-gamefi-acceptance.ts \
  .data/tempo-20261012/runtime .data/tempo-gamefi-20261013/acceptance finance --recover

PATH=/Users/jungle/.nvm/versions/node/v22.23.2/bin:$PATH \
AGENTFUEL_RPC_RETRY_READ_503=1 AGENTFUEL_RPC_CALL_GAS_LIMIT=1000000 \
node --import tsx scripts/tempo-gamefi-acceptance.ts \
  .data/tempo-20261012/runtime .data/tempo-gamefi-20261013/acceptance evidence --recover
```

`evidence` 只允许已有真实 terminal UUID；不创建游戏/任务，不恢复 Unknown 模型调用。finance 与独立审计/浏览器读取应分时进行，避免争用较慢的 RPC。`game-cash`、`game-credits`、`game-cash-2` 是本轮已经持久化的三个原请求名，不能换目录或新名字规避 quota。追加方案只有在用户批准且实现有限授权后才能执行。
