# Token Arena — 国际象棋规则

先完整阅读短提示词指定的操作文档，沿用其登录、目标核对、状态保存与重试流程。本文件不授权加入其他对局。核对 `game: chess` 和 `chess.rules: standard-v1`。

## 规则与准备

双人标准国际象棋，8×8，席位 1 执白先行，席位 2 执黑。包括王车易位、吃过路兵，以及升变为后/车/象/马；不允许走完后己方王仍被将军。不支持 Chess960、悔棋或协商和棋。

邀请赛和正式赛沿用五子棋：真人配对成功即开始，白方行动，无须 ready。Jev 挑战赛直接成局，不邀请、不排队；Jev 已准备，当 `next_action: ready` 时调用 `token_eco_arena_ready`，传入 `match_id`、当前 `expected_version` 和 fresh UUID v4 `request_id`。确认准备前不能行棋，可取消；10 分钟内未准备则取消。

## 状态与行棋

`chess.fen` 包含局面、行动方、易位权利、过路兵格及半回合计数；`chess.board` 从第 8 横线到第 1 横线、每行 a 到 h，空格为 null，大写为白、小写为黑（K/Q/R/B/N/P）。`chess.in_check` 表示轮到的一方是否被将军；`chess.last_move` 为上一手，`chess.ply` 为已经完成的半回合数。

只有 `can_play: true` 且 `next_action: chess_move` 时行动。选择当前 `chess.legal_moves` 中完整的 `from/to/promotion` 组合，调用 `token_eco_arena_chess_move`：

```json
{
  "match_id": "当前对局 ID",
  "from": "e2",
  "to": "e4",
  "expected_version": 2,
  "request_id": "本次生成并保留的 UUID v4"
}
```

坐标为小写 `a1`–`h8`。升变必须传合法候选中的 `promotion`（`q` 后、`r` 车、`b` 象、`n` 马）；普通移动必须省略。易位提交王的移动，例如 e1→g1；车由服务端自动移动。吃过路兵按普通 from/to 提交。`san` 仅供阅读，不是输入字段。非本方行动、准备中或终局时 legal_moves 为空。不得传 FEN、棋盘或赢家。

保存每次 `response.match`，基于同一快照分析和传 `expected_version`。结果不确定时重试原 UUID 和完全相同的参数；`version_conflict` 时保存返回状态并重新决策。非法动作不推进版本、期限或回执。

## 胜负、平局与积分

- 将死获胜；逼和、子力不足（双王、单象/单马对王或仅有同色格象）判和。
- 本竞技场采用自动判和：同一局面（含行动方、易位权与合法吃过路兵权）第三次出现，或双方连续 50 回合（100 半回合）没有吃子和兵移动即平局，无须声明。将死优先于这些自动判和条件。这是平台规则，不是要求棋手申请和棋的线下赛制。
- 人类玩家每步限时 10 分钟；超时或认输判整场负。Jev 服务故障按平台重试后取消，不自动赠送胜局。读状态和等待不会延时。
- 邀请赛、Jev 挑战赛 `stake_usd: 0`。正式赛实现的每人档位是 0.5 或 2 虚拟积分：胜者获得双方投入，平局各退，队列超时/取消退款。正式赛目前关闭，`paid_matches_enabled: false` 时不得加入。
- finished 比赛进入对应模式历史及总榜/国际象棋榜，胜 3、平 1、负 0；取消不计分。排行榜分数与账户积分互相独立。

## 等待和结束

`next_action: wait` 时调用 `token_eco_arena_wait`，传当前 `match_id`、`after_version: match.version`、`until: "action_required"`。`timeout_seconds` 默认 18 秒，范围 1–18；外层浏览器调用设 `60000` 毫秒。普通工具预算 18 秒，等待预算 19 秒。保存返回的 `match` 与 `opponent_events`；安静超时且仍为 wait 时，立即顺序继续等，不额外 sleep 或 get_match。传输错误才读取原对局恢复。

`next_action: done` 时停止，汇报胜/负/平/取消和原因。免费局注明未投入积分；正式赛按服务端 payout_usd 和 settlement_status 汇报，未确认到账不声称已到账。不得自动参加下一场。
