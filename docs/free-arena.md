# 免费游戏与 Agent API

`/arena` 提供德州扑克、五子棋、国际象棋和小丑牌的本地玩法。所有状态、合法动作和胜负由服务端裁判产生。德州使用虚拟筹码，与 USDC、模型消费、贷款及已验收的 Monad 奖励报告分开；新增游戏没有宣称实网派奖。

AgentFuel Bot 是免费、受控的本地策略 Bot，按合法动作行动，不调用 LLM。小丑牌为单人关卡挑战，另一席是关卡主持，挑战失败不会形成 Bot 的对战战绩。德州、五子棋和国际象棋支持免费邀请双人对局。每次行动、开局准备各有 10 分钟限时；未开局的取消/准备超时标为 `cancelled`，不判胜负。

练习会话保存到本地 JSON 快照。浏览器保存的 seat token 在刷新和服务重启后仍可使用；令牌、邀请代码、版本、行动期限和原始幂等响应一并保存。德州保存每手实际牌堆，小丑牌保存实际牌堆与已产生的随机奖励；四个游戏按成功动作可信重放，国际象棋保留重复局面历史。恢复不会重新洗当前牌堆，停机时间仍计入原来的 10 分钟期限。

前端默认使用进程工作目录下的 `.data/arena-freeplay.json`；持续运行可用 `ARENA_PLAY_STATE_PATH` 固定绝对路径，示例：

```sh
ARENA_PLAY_STATE_PATH="$HOME/.config/agentfuel/practice.json" npm run start --workspace @agentfuel/frontend -- --port 3020
```

快照文件权限为 `0600`，新建存储目录为 `0700`。每次命令先完成临时文件写入、文件刷盘、原子替换与目录刷盘，再返回成功；提交失败恢复已提交状态并返回 `503 ARENA_STORAGE_UNAVAILABLE`。使用同一 requestId 重试可取回已经提交的原始响应。相同进程的命令同步执行；同机多个进程使用相同文件时以短事务锁协调，锁忙返回 `503 ARENA_STORAGE_BUSY`，退出进程留下的锁可恢复。这一方案适用于本机文件系统。

最多保留 500 个对局，达到上限时清理最早的已结束或已取消对局及对应创建去重记录；500 个对局均未结束时返回 `429 ARENA_BUSY`。保留对局的令牌和请求去重记录在重启后继续有效。列表分别返回最近 50 个进行中对局与终局/取消历史。读取检查快照是否变化，并复用按座位与版本隔离的视图缓存；未变化的轮询不重放游戏、不写盘，到期裁决单独持久化。单元测试直接使用的 `new PlayStore()` 仍是内存模式，传入 `statePath` 才启用文件存储。

## HTTP 契约

服务入口为 `/api/arena/play`，请求/响应类型见 `frontend/lib/play-types.ts`。`GET` 返回当前牌桌、最近 50 条终局/取消历史、Bot 与存储说明。`GET ?matchId=<id>` 返回公开牌桌、日志和裁判视图；添加 `Authorization: Bearer <seatToken>` 才能返回该席手牌及合法动作。

`POST` 发送 `Content-Type: application/json`。创建与加入返回 `{match,seatToken}`，其他操作返回 `{match}`。客户端自己产生随机 UUID `requestId`，创建/加入请求重试应复用原 UUID。动作必须携带最新 `match.version` 和自己的 Bearer token。同一席同一 `requestId`、同样参数的重试只返回第一次结果；换参数会返回 `409 REQUEST_ID_REUSED`，旧版本返回 `409 VERSION_CONFLICT`，响应带服务端最新版本。

| op | 必要参数 | 行为 |
| --- | --- | --- |
| create | game, mode, requestId | game=holdem/gomoku/chess/balatro；mode=challenge/invite；可选 name/chips/hands |
| join | inviteCode, requestId | 受邀方用邀请链接中的代码取得自己的新 seat token；可选 name/matchId |
| ready | matchId, version, requestId | 当前席准备；双方准备后自动开始 |
| action | matchId, version, requestId, action | 服务端验证并执行动作，接着执行需要行动的官方 Bot |
| auto | matchId, version, requestId | 用本地策略为当前席走一步；供试玩、演示和自动客户端验证 |
| resign | matchId, version, requestId | 进行中的对局认输 |
| cancel | matchId, version, requestId | 取消尚未开始的对局 |

德州 `chips` 允许 500、1000、5000，固定盲注 5/10。每手轮换庄位，上一手筹码真实延续。`hands` 允许 1–100，0 表示直到一方出局；挑战默认 10 手，邀请默认 3 手。一方筹码归零或手数结束后根据筹码判胜负。小丑牌只允许 challenge，按 12 关规则运行。

| game | action |
| --- | --- |
| holdem | `{type:"fold"|"check"|"call"|"all-in"}` 或 `{type:"raise",to:<本轮下注总额>}` |
| gomoku | `{type:"place",row:0..14,col:0..14}` |
| chess | `{type:"move",from:"e2",to:"e4",promotion?:"q"|"r"|"b"|"n"}` |
| balatro | `{type:"play"|"discard",cards:["AS",...]}`，每次 1–5 张；奖励阶段 `choose_joker`/`skip_reward` |

Balatro 奖励动作使用 `{type:"choose_joker",jokerId,replaceJokerId?,upgradeHand?}` 或 `{type:"skip_reward",upgradeHand?}`。牌、奖励、升级类型都需来自当前裁判视图，客户端不能提交牌堆、分数、资金或胜负。公开视图不含当前手牌、未发牌牌堆或任何 seat token；德州仅摊牌后公开摊牌牌面。

## 最小 Agent 循环

创建或加入一次，保存仅属于本席的 `seatToken`。调用 ready 后循环 GET 私有视图；不是本席回合时等待，是本席回合时从合法动作选择一项并 POST action。遇到 VERSION_CONFLICT 重新 GET；网络失败重试同一个请求与 requestId；finished/cancelled 时停止。需要免费自动演示时 POST auto，每次仅代本席合法行动一步。

服务不执行 Agent 上传的任意代码，不替 Agent 购买推理或支付链上费用。原真实 Kimi/Monad 验收入口仍独立保留在 `/arena/holdem` 与 `/api/holdem`。

## 验证

```sh
node --import tsx --test --test-concurrency=1 services/arena/test/freeplay.test.ts services/arena/test/freeplay-persistence.test.ts
ARENA_PLAY_TEST_URL=http://127.0.0.1:3020 node --import tsx --test services/arena/test/freeplay-http.test.ts
```

HTTP 测试需要本地前端服务，使用两个独立客户端检查邀请、版本冲突、请求重放、私有视图隔离与入口参数边界；未设置 URL 时不会发起网络请求。

2026-10-05 持久化验收：上述 18 项练习测试和根目录 typecheck 通过。新增测试覆盖四游戏私有局面恢复、原请求重试、写失败回滚、到期裁决只提交一次、读取不重写文件、其他进程提交后缓存失效、真实 Node 进程收到成功响应后被 SIGKILL 的恢复，以及双进程相同版本只有一个提交。坏 JSON、坏快照版本或无法重放的游戏状态持续返回存储错误，不继续公开旧内存结果。测试临时目录在结束后清理。

本机 20 个已开局国际象棋会话的快照为 84,058 字节，恢复约 3.28 毫秒；1000 次详情热读约 25.52 毫秒、1000 次列表热读约 55.56 毫秒，读取期间快照未变化。

实际 Next.js 免费练习 API 的独立进程验收使用德州邀请局（已进入 flop）和小丑牌挑战（已弃牌）。第一次进程以 SIGKILL 停止，使用同一快照启动新进程，8 秒后两局仍在进行；三席完整私有视图、两个公开视图和九个原请求响应全部一致，错误令牌返回 401。脱敏证据见 `demo-output/gamefi-complete-20261005-root/practice-isolated-restart.json`；令牌、快照与完整核对信息保存在权限为 `0600` 的服务配置目录。此次未停止 3022 主服务，隔离测试服务及其临时构建目录已清理。

3022 主服务较早创建的两局已按原期限裁决行动超时，版本分别只增加一次，原私有游戏视图完整保留。其初始证据与供后续主服务重启核对的终态证据分别为 `practice-restart-before.json`、`practice-terminal-before-restart.json`，位于上述验收目录。

手机邀请用例曾在好友准备后等待后台页面更新。练习页面只对可见页轮询，因此测试需切回当前观察的客户端；补充前台切换后仅复跑该手机用例，1 项通过，总耗时 8.6 秒。独立 HTTP 检查确认好友 ready 后，发起方私有 GET 与公开 GET 都立即返回最新版本。证据为同目录的 `practice-invite-mobile-targeted.json` 和 `practice-invite-http-cache.json`。

本轮验收：root独立定向测试61项通过（规则、会话、HTTP、同源及旧德州回归），另检查1200随机牌局的筹码守恒/重放；typecheck:all及隔离生产构建通过。实现Agent的桌面/手机浏览器14项全绿，root另实际操作德州终局和生产版象棋走子。没有重跑本轮未改动的全部合约或新增链上交易。

## 2026-10-04 GameFi 接入原则修正（历史阶段）

用户确认复刻对象主要是 UI/UX，游戏业务以本项目已有实现为准。新 `/arena` 将既有真实模型德州、Monad 赞助测试 USDC、奖励入 cash 和购买推理置于主流程，直接读取原 `loadHoldemSnapshot`，复用原回放与资金证据组件；`/arena/holdem` 保留兼容。该阶段页面只读原 CLI 结果；2026-10-05 已通过本机运营 runner 接通网页开赛，保留原 CLI 与 journal，见 [GameFi runner](gamefi-runner.md)。

四游戏交互作为练习区。德州和五子棋直接复用原规则引擎，国际象棋和小丑牌补齐缺少的玩法；练习 Bot 使用本项目名称与受控策略。练习成绩不触发赞助派奖。USDC 奖励路径已经实现；LLM token 是可消费的推理额度；2026-10-05 已实现每局4096 Kimi额度、持久发放/预留/实际usage扣减与原ID恢复，独立于练习成绩。
