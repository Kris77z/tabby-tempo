# Agora Dashboard → AgentFuel 终端界面迁移

2026-10-11 更新：本文记录原终端迁移过程。补充独立 `/onboarding`，复用源 `src/components/onboarding/terminal-onboarding.tsx` 的启动文本、逐行输入和确认流程；六项设置接当前托管接口。德州历史证据入口已收至 `/advanced` 的“历史演示与证据”，下方导航描述保留当时状态。工作台现已从 `/` 移到 `/dashboard`，`/` 使用 [Oberon 产品落地页](frontend-oberon-landing.md)。请求记录现保留最近 100 条及所有未结束请求；个人信用、Tier、完整债务与真实任务结算通过独立金融快照补齐，详见 [托管接口](hosted-agents.md)。下方 2026-10-10 的截图和测试数字是当时的验收记录。

源项目为同机只读 `/Users/jungle/Desktop/dev/bnb-hackathon/frontend`。用户指定复用 Agora Mesh 的终端 Dashboard；实现前已读取 `src/app/dashboard/page.tsx`、`layout.tsx`、`terminal.css` 与面板/时间线，并实际查看 `/Users/jungle/Desktop/dev/bnb-hackathon/assets/dashboard.jpg`。

原版是浅灰背景、白色方角面板、深紫强调、全等宽字体。默认入口复用其紧凑标题栏、会话细栏、固定视口的 3/6/3 工作区、独立面板滚动、中央时间线和底部操作区、手机三面板切换、底部状态条。布局、样式和组件来自源 Dashboard；没有大标题 hero 或 Marketplace 目录页结构。

AgentFuel 继续使用现有 `/api/hosted/*` 和四合约后端。Agora 的 Passkey、代理授权、自由文本任务、服务注册表与链指标不属于此托管契约；只迁移显示结构，所有事实绑定 AgentFuel 当前登录用户的 API。

## 来源与复用位置

| Agora 源文件（相对 frontend） | AgentFuel 复用位置 | 直接迁移与契约适配 |
| --- | --- | --- |
| `src/app/dashboard/page.tsx` | `components/hosted/hosted-app.tsx` 的 HostedApp | `terminal-header.tsx` 共用三色窗口点 / shell prompt / 钱包操作 / 状态标题栏；会话栏；桌面 12 栏中 3/6/3；中央请求区与固定操作区；手机 Agent / 请求 / 资源 tabs |
| `src/app/dashboard/layout.tsx` | `components/terminal/terminal-theme.tsx` + `hosted.module.css` 的 shell | 首页保留固定视口 flex 外壳；四个路由共享终端字体与局部主题，其他页按游戏/协议内容滚动 |
| `src/app/dashboard/terminal.css` | `components/terminal/terminal.module.css` + `hosted.module.css` | 原始 HSL：背景 `240 5% 96%`、前景 `240 6% 10%`、卡片白色、主色 `263 70% 50%`、边框 `240 6% 85%`、`radius:0`；11px widget-label、轻量紫光、光标闪烁、细直角滚动条 |
| `src/app/layout.tsx` 与 `node_modules/geist/dist/mono.js` | `components/terminal/terminal-theme.tsx` + `components/hosted/fonts/` | 复制同一 `GeistMono-Variable.woff2` 和 SIL OFL 许可；Next localFont 按源声明加载 `--font-geist-mono`，无外部字体请求 |
| `src/components/panels/my-agent-panel.tsx` | HostedApp 左栏 | widget 标记 / 身份 / 分隔 / 默认展开配置 / LIVE RUN / 分隔 / 折叠链上身份的原组织；本用户多 Agent 选择加入紧凑列表 |
| `src/components/panels/agent-identity-card.tsx` | `agora-primitives.tsx` AgentIdentityCard | 原终端名称、描述、地址与复制行；独立托管钱包绑定，复制失败提示及计时器清理保留 |
| `src/components/panels/live-run-stats.tsx` | HostedApp LIVE RUN 区 | STATUS / SPENT / RESERVED 的紧凑对齐行；只显示 API 的状态、支出和预留，不编造 duration 或交易计数 |
| `src/components/panels/agent-mesh-panel.tsx` | ResourcePanel + AgentServiceCard | 原 node 卡片的名称 / 方括号状态 / kind-id / 多行事实结构；服务排名与 reputation 改为真实模型目录、推理预算和赞助游戏能力 |
| `src/components/timeline/mission-timeline.tsx` | HostedApp mission.log / RunHistory | 等待输入的大块白色空态、可滚动矩形状态记录、标记与展开详情；API 不提供原细粒度 AgentEvent，故每条 HostedRun 显示真实状态、phase、费用和凭证 |
| `src/components/agent/goal-input.tsx` + Dashboard 内 Inline Chat Input 容器 | HostedApp actionDock | 原中央底部边框操作盒和 `//` command chips；当前后端只支持固定 action，明确按钮替代自由聊天，不声称任意 prompt 或通用 credits 聊天 |
| `src/components/layout/chain-status-bar.tsx` | HostedApp footer | 紧凑页底连接状态结构；仅显示真实 API 状态和所选 Agent 的 binding chainId，未接入 block/gas/RPC 指标 |
| `src/components/panels/status-orb.tsx`、`collapsible-section.tsx` | `agora-primitives.tsx` | 状态圆点与呼吸、▸/▾ 折叠层级；用原生 details 支持键盘，减少动画偏好生效 |
| `src/components/onboarding/create-agent-form.tsx`、`src/components/ui/card.tsx` | AgentSettingsForm 与 Card primitives | 配置 → review → submit 的真实表单流程及 forwardRef 组合结构；字段改为后端六项设置，方角样式按 Dashboard |

源截图只读查看，没有修改源项目。Tailwind 声明逐项转换为 scoped CSS Module，保留源颜色、间距、尺寸和布局约束；图标使用本仓库现有 SVG。没有新增 UI 框架或钱包依赖。

## 游戏与协议页的统一范围

`TerminalTheme` 集中源 Dashboard 的原始 HSL tokens 与本地 Geist Mono；`TerminalHeader` 直接复用原三色窗口点、shell prompt、紧凑操作栏与状态字。首页继续使用原 3/6/3 面板和手机 tabs。其他页面的导航栏连接我的 Agent、游戏大厅、德州证据、高级协议；各页状态来自其实际读取阶段或明确的 fixture / 文件快照模式，没有编造 RPC、gas 或实时链高度。

| 路由 | 结构与样式复用 | 保留的业务与游戏辨识 |
| --- | --- | --- |
| `/arena` | 共用终端页头、局部 tokens、白色方角面板、紫色标签和紧凑控件；去除旧侧栏/大 hero/静态“已实现”指标；练习目录为紧凑游戏卡片 | 固定运营比赛与个人托管参赛明确分开；原 requestId、席位恢复、邀请、准备、日志和 API 契约；原四种游戏图像 |
| `/arena?game=…` | 同一页头与配置面板，棋盘/日志并排，手机纵向显示；控制按钮与 tabs 使用终端风格 | 原五子棋木纹/黑白棋子、象棋格与棋子图、扑克绿台/红黑花色、小丑牌绿台/手牌/选中提示；只改页面容器，规则与动作函数未改 |
| `/arena/holdem` | 去除旧固定侧栏，改为文件状态栏、紧凑事实格、公开回放/证据双栏和后续付款面板 | 原公共牌、隐藏底牌、行动前快照、终局筹码、播放/逐步回放、报告错误保留上次快照；牌桌与红黑花色保留辨识 |
| `/advanced` | 固定运营 Agent 目录 + 协议内容的方角工作区，紧凑信用档案/演示 tabs、资金格、证据列表；手机目录压成三列，协议内容单列 | 原档案、配置、钱包操作、SDK/Relay/Arena 流程和拒绝证据不变；fixture 广播关闭，未知部署空态仍明确 |

`arena-play.css` 只替换竞技场页的结构与控件样式，棋盘/卡牌定义和对应手机规则直接保留；`holdem.css` 按报告面板逐项统一；`terminal/protocol.css` 全部限制在 `.advanced-terminal` 内。没有全局 `*` 强制改圆角或覆盖游戏颜色，也没有新增设计框架。

## 用户路径与边界

- 工作台底部操作区为我的 Agent、任务、竞技场、资金与额度、设置。桌面保留原版三栏，手机在 Agent / 请求 / 资源间切换，操作区始终可见。身份选择贯穿导航、请求路径、记录、钱包、预算和奖励；切换身份后未提交的入账/比赛表单重置。
- 签名 challenge 逐项核对 origin、wallet、chain、nonce 和 expiry，浏览器签署服务端原始个人消息。账号或网络变化后立即隐藏原身份，要求重新登录；不使用浏览器 bearer 或私钥。异步创建、运行、配置和暂停响应只能更新其原会话，失效响应不显示成功，也不删除原 owner 的恢复提示。旧 HTTP 请求及钱包变化登出响应结束后才提交新登录，防止晚到的 cookie 清除响应影响新会话。
- 创建请求先保存 UUID 和公开设置，网络断连或 503 保留原参数。恢复原请求不生成新 UUID；已有可恢复 Run 保留 action、rewardKind 与 amountRaw。不会自动执行恢复或付费重试。
- 模型来自服务端目录；配置预算是推理支出上限，不当作入金。入账前先向 Agent 钱包转 USDC，页面只提交平台 deposit 操作。
- 游戏免费、不借贷。USDC 奖励显示该 Agent 的 cash 确认结果；LLM credits 入口仅运行现有固定短确认消费，按实际 usage 记录。
- snapshot 最多提供最近 100 条用户请求，不含实时钱包余额/完整额度账本。界面明确显示“最近确认 cash”和历史额度记录，不聚合出虚构的可用额度余额。
- `/advanced` 保留原信用档案、固定 Agent 演示与拒绝证据；`/arena`、`/arena/holdem` 保留原游戏练习与公开报告。所有路由使用同一灰紫等宽终端主题，页面导航互通；高级入口和游戏大厅说明其运营/历史身份，不将固定 demo Agent 当作用户 Agent。

## 验证与证据范围

浏览器套件 `frontend/playwright.hosted.config.ts` 使用独立 `.next-hosted-test` 和端口 3014、本地 EIP-1193 mock + ethers Wallet 个人签名，全部 API 截断，托管服务环境明确留空。截图标记为 synthetic，不作为真实链上奖励或供应商证明。

前次 API 集成基线已通过 Node 22.23.2 的 typecheck / Next build、前端 Node 29/29、桌面/手机托管 UI 38/38、原 advanced 4/4；主 Agent 独立复跑 38/38。此基线包括真实签名原文校验、六项设置、所有 hosted action、跨 Agent 身份隔离、401/503、原 UUID 持久化和 16 项登录/钱包变化竞态回归。终端布局修正后完整桌面/手机套件 40/40 通过；新增 2 项原版结构验收核对三色窗口点、真实加载的同源字体、原灰紫 tokens、方角、3/6/3 面板、左右 16px 网格边界、固定操作区与手机单面板切换。手机身份栏换行微调后，结构与完整 action 流程定向 4/4 再次通过。首轮测试发现并补回入账空值按钮的禁用条件，最终完整套件通过。

2026-10-10 扩展统一后，完整浏览器回归共 76 项通过：托管首页 40/40、终端跨页 14/14、运营 GameFi 恢复/额度 16/16、德州报告与分阶段证据 6/6。随后恢复源 prompt 灰色链接优先级，首页结构定向 2/2 再次通过。最终竞技场标题状态同时区分发送、待确认、错误与练习；生产只读检查临时拦截一次列表失败，确认 ERROR 与重读后的 PRACTICE 正确切换。

本轮 Node 22.23.2 下 `npm run typecheck:all` 与最终 Next 生产构建通过。所有构建按顺序使用默认 `.next`；用户正在查看的 3020 / `.next-local-preview` 没有停止或被构建覆盖。托管和跨页开发验收分别用 3014 / `.next-hosted-test` 与 3015 / `.next-terminal-test`，结束后清理这两个临时目录。运营 GameFi 16 项在独立 3016 生产服务上拦截全部付费 API，德州 6 项使用独立 3014 生产服务，只读取公开文件或合成 HTTP 响应。

最终生产 Chrome 分别以 1512×900、393×851 读取 `/`、`/arena`、`/arena/holdem`、`/advanced`，8 个页面全部 HTTP 200、同源字体已加载、原灰紫 tokens 生效、无页面异常和横向溢出。明确留空的 hosted 配置返回 503 `HOSTED_NOT_CONFIGURED`；首页显示服务不可用，运营付费控件禁用，高级协议页无虚构部署数字。8 张 `production-local-{home,arena,holdem,advanced}-{desktop,mobile}.png` 保存在 `frontend/acceptance/terminal-pages/`，其中德州是明确标记的 fixture；本地生产渲染不等于真实链或供应商验收。

终端合成截图保留在 `frontend/acceptance/hosted-agents/`：`synthetic-terminal-agents-desktop.png`、`synthetic-terminal-agents-mobile.png`、`synthetic-terminal-funds-desktop.png`、`synthetic-terminal-funds-mobile.png`、`synthetic-terminal-signed-out-desktop.png`、`synthetic-terminal-signed-out-mobile.png`。已人工对照源 `assets/dashboard.jpg` 检查桌面三栏、方角/等宽/紫色/密度，以及手机请求滚动和固定入账/credits 操作区；不是真实后端或链上奖励截图。

跨页合成截图同样保存在 `frontend/acceptance/terminal-pages/`：`synthetic-{arena-lobby,arena-poker,arena-gomoku,arena-chess,arena-balatro,holdem-replay,advanced-profile}-{desktop,mobile}.png` 共 14 张，已逐页检查；四游戏实际动作仅在测试内免费引擎执行。旧运营控制台的 12 张截图也已更新为终端版，受控响应边界见 `frontend/acceptance/gamefi-console/verification.md`。

本次未广播 Monad 交易、调用付费模型、部署公开服务。真实钱包扩展、Monad 与供应商联合验收仍未验证。真实托管后端的既有闭环范围见 [hosted-acceptance](hosted-acceptance.md)。
