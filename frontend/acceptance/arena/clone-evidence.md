# AgentFuel Arena 复刻证据与边界

目标：`https://token.jiqiren.ai/arena`；本地：`http://127.0.0.1:3020/arena`。取证日期：2026-10-04。

## 直接证据（SOURCE）

- 在 Chrome 公开访客状态浏览大厅、五子棋、国际象棋、小丑牌。原站为有路由与同源服务的应用页面；公开待开局界面可取证，登录后对局服务未取证。
- 大厅白色侧栏、3 个指标、2 列游戏卡片；挑战赛 4 个游戏，邀请赛 3 个游戏。官方挑战 `?game=poker|gomoku|chess|balatro&mode=challenge`，邀请 `mode=practice`。
- 对局页：返回链接、模式/配置卡、当前/历史标签、左侧棋盘或桌面、右侧日志与筛选。
- 五子棋为 15 × 15、黑方先行；国际象棋标准初始棋盘；小丑牌公开页包含 4 Ante / 12 盲注、4 次出牌 / 3 次弃牌、8 张手牌、5 小丑槽位。
- 图片地址从浏览器 `document.images[].currentSrc` 读取，20 个实际图片保存到 `public/arena-assets`，来源清单 `source-manifest.json`。4 张 cover、12 张棋子、4 张小丑牌花色图，共 252,508 bytes，无遗漏或失败。
- 规则依据：公开原站 `/skills/games/chess.md`、`/skills/games/balatro.md`，由规则 Agent 读取、独立实现并验证。

## 本地实现与已知差异（PARTIAL）

- React/Next.js 独立实现公开体验，不运行原站 bundle。品牌为 AgentFuel，导航接入已有信用档案和 Monad 奖励证据。
- 后端为本地服务端裁判，每次行为都由真实规则引擎验证；人工、外部 Agent 或受控策略 Bot 可使用同一席位。Bot 不冒充原站 Jev 模型。
- 挑战/邀请、准备、动作、版本冲突、幂等重试、公开日志、历史记录和私密手牌都接本地 `/api/arena/play`。
- 原站积分正式赛与账号/积分系统未接入。本地仅免费虚拟筹码。已有 Monad 奖励、到账与消费凭证保留独立 `/arena/holdem` 入口。
- 棋盘材质、扑克桌和扑克牌面为本地 CSS；大厅、国际象棋棋子及小丑牌花色图使用已取证本地素材。未声称像素级复制所有状态。
- 不使用外站账号或密钥，不对外发起比赛，不把本地成绩当作 Monad 奖励。

## 验证

`NEXT_DIST_DIR=.next-arena npx playwright test --config playwright.arena.config.ts`

桌面 1512 × 900 与 Pixel 5 检查：大厅 7 条游戏入口与本地图；扑克真实手结束/刷新保留席位/历史；五子棋落子与策略回复；国际象棋合法格点击；小丑牌真实手牌、弃牌与计分；独立客户端邀请/取消；网络未知结果同请求 ID 重试。

截图保存为 `lobby-*`、`poker-finished-*`、`gomoku-playing-*`、`chess-playing-*`、`balatro-playing-*`。浏览器监听运行时错误、首屏资源错误和外域请求；最终完整一轮 **14 / 14 通过（28.7s）**。没有 pageerror，首屏本地图片全部成功，渲染关键资源失败 0、外域请求 0、静态资产缺失 0。

运行时与布局必须由 browser 验证；TypeScript 通过不代表点击路径通过。第一轮 browser 发现同源 Origin 被 Next 内部 URL 误拒，修复后重跑。

浏览器额外手动验证小丑牌奖励：三张 K 得 180 分，策略操作累计 312 分通过小盲注，选择开场小丑后进入第二关（目标 450），并确认牌型 +3 级和新发 8 张手牌。

保留状态的边界：浏览器席位凭证刷新后恢复；比赛与历史属于本地进程内存，服务重启后需新建。本地游戏并未产生新的链上奖励。
