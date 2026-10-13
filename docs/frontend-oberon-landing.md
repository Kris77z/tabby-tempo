# Oberon → AgentFuel 落地页

2026-10-11，按用户指定，读取私有仓库 [Kris77z/web-experience-four-sites](https://github.com/Kris77z/web-experience-four-sites) 的 `main`，固定来源 commit 为 `ba589426a46e67688fc69cdc65e1addd13e574ed`。本次仅在当前 AgentFuel checkout 添加落地页，没有注册新站点或部署。

## 来源与视觉对照

源实现为 `oberon-clone/public/index.html`；`oberon-re/recon/index.html` 保存相同原始 HTML。实现前读取源 HTML/CSS、字号与字体声明，并实际查看 `oberon-re/recon/recon-oberon-first-fold-1440x900.png`、`recon-oberon-full-page-1440.png`，以及 `oberon-clone/verify/local-final-1440x900.png`。源 README 说明此仓库是用于本地研究的 Framer 运行时镜像。

AgentFuel 保留原版首屏的六列纵向网格、左侧三分之一留白、第三列起的大标题、编号标签、灰白底 / 黑色正文 / 橙色强调、右侧橙色芯片与连接节点、像素波形底纹、横向双 CTA。下半页沿用左侧标题与右侧内容的分栏、两列能力卡、四步流程、深色机制段、灰绿奖励段、中心连接图、FAQ 与大标题页尾。手机改为单列，保留网格、编号、芯片与按钮结构；320px 单独约束标题三行和顶部操作宽度。

没有迁移 Framer bundle、遥测、原站链接、Oberon 商标、客户头像或客户数字。像素波形与连接图用独立 SVG / CSS 实现；主图标直接沿用 AgentFuel 已有 `components/icons.tsx` 的 Mark 路径。原客户证言、定价与客户案例段换为任务信用机制、托管配置和免费德州奖励。

| 源视觉结构 | 当前实现 |
| --- | --- |
| 首屏六列网格、Inter 75px / 500 / -0.05em、Geist Mono 辅助字 | `frontend/components/landing/landing-page.tsx`、`landing.module.css` |
| 编号导航、菜单、章节跳转、FAQ | `landing-menu.tsx` 的轻量客户端菜单；原生锚点与 `details` |
| 首屏芯片、连接图、文件节点 | `landing-page.tsx` 的自有 SVG 与 CSS；使用现有 AgentFuel Mark |
| 灰色像素波形 | `frontend/public/landing/pixel-wave.svg`；独立生成的确定性像素形状，CSS 缓慢横移 |
| 首屏进场动画 | 服务端输出的逐字符 / 词 CSS 动画、Logo 横向进入、文件列重排、芯片收缩后分层展开；刷新重播，减少动画或禁用脚本时直接显示完整内容 |
| 下半页滚动显示 | `IntersectionObserver` 渐进增强，与首屏进场分别实现 |

主字体来自官方 [rsms/inter](https://github.com/rsms/inter)，固定 commit `353b61b9f4430d5f420d56605a6e7993e0941470` 的 `docs/font-files/InterVariable.woff2`；同 commit 的 `LICENSE.txt` 保存在 `frontend/components/landing/fonts/Inter-LICENSE.txt`。辅助字体复用当前项目带 SIL OFL 的 `frontend/components/hosted/fonts/GeistMono-Variable.woff2`，对应许可仍在同目录 `LICENSE.txt`。两种字体通过 `next/font/local` 同源加载。

## 路由与产品事实

`/` 现在是落地页。原托管工作台完整迁至 `/dashboard`，仍使用 `HostedApp` 与 `TerminalTheme`。“创建你的 AGENT”进入独立 `/onboarding`，完成 Agora 风格终端配置后进入工作台；“进入工作台”直接进入 `/dashboard`；免费游戏大厅保留 `/arena`；协议与结算证据保留 `/advanced`；德州历史只读证据保留 `/arena/holdem`，主导航移除该项，入口收在高级协议的“历史演示与证据”及工作台折叠的高级入口。终端品牌链接返回产品首页，页面导航的“我的 Agent”与游戏 / 高级页的托管入口指向 `/dashboard`。

2026-10-10 的 [Agora 迁移记录](frontend-agora-migration.md) 中“首页 / 默认入口 / 四个路由”的描述是当时状态；其中托管首页现对应 `/dashboard`，原工作台设计和业务入口继续保留。本记录只说明本次落地页与路由变更，不重写原后端或历史链上验收范围。

产品文案依据当前 `README.md`、`AGENT_CREDIT_ENGINEERING.md`、`docs/hosted-agents.md` 和 `docs/hosted-acceptance.md`：平台创建托管 Agent，配置服务端支持的模型、三档策略与消费预算；运行平台支持的任务；以已托管任务报酬支持推理信用；独立验收后偿还本金及费用、积累 ERC-8004 声誉；免费德州争取赞助测试 USDC 或 Agent 专属模型额度。链上演示明确标为 Monad Testnet，游戏不借贷，额度不是可转让代币。机制图明确标为示意，没有虚构实时余额、用户量、收入或标准 x402 兼容声明，也没有 gas 赞助宣传。

## 首轮本地验证（静态布局）

`frontend/playwright.landing.config.ts` 使用独立端口 3024 / `.next-landing-test`，Node 22.23.2 与本机 Chrome。托管上游配置留空；浏览器拦截全部 `/api/*`，禁止外部请求与任何金融写操作。桌面 1440×900、手机 393×851、窄屏 320×740 共 9/9 通过：本地字体与资源成功加载、无页面异常 / 失效资源 / 横向溢出、标题保持三行且不与芯片重叠、顶部 CTA 不出屏、菜单 / Escape / 锚点 / FAQ 可操作、主 CTA 进入 `/dashboard`、终端品牌返回落地页。

首轮 FAQ 用精确文本定位时，原生 `summary` 包含装饰字符导致测试定位失败；改为按 `summary` 内容定位后完整通过。随后人工全页对照补充 `.content { padding: 0 }`，隔离旧全局 `main` padding，使下半页网格与首屏一致；最终生产构建及统一回归由主 Agent 串行验收。

浏览器截图在 `frontend/acceptance/landing/`：`local-oberon-{desktop,mobile,narrow}.png`，`local-oberon-full-{desktop,mobile}.png`。截图是本地静态落地页与被阻断的托管入口，未进行真实钱包签名、付费模型消费或链上交易，不能作为公开发布或主网奖励证明。既有托管、终端跨页测试只同步工作台路由与导航断言；本次未为静态文案编写重复实现的单元测试。

## 首次进入动效修正

首轮主要验收静态截图和导航，未覆盖源站首次进入时序；因此不能以首轮通过推断动效完整。补验重新运行固定 commit 的源站并采样实际时间帧，证据为 `frontend/acceptance/landing-motion/source-*.png` 与 `source-timeline.json`。原版标题按字符 20ms 错开、描述按词 80ms 错开；Logo 从左侧进入；文件列滑入；芯片先收缩停顿，再分层扩大并依次推出上、右、下三个节点。像素波形持续按 30px/s 横移。

当前实现用原生 CSS 关键帧与服务端文本 span 保留上述顺序，中文说明按词分段；不迁入 Framer 运行时。时间从本页样式首绘开始，不能直接等同于源镜像加载较慢的导航时间。减少动画和禁用脚本时完整静态显示；下半页滚动显示保持独立。


## 产品主线同步（2026-10-11）

按 [当前产品主线](../AGENT_CREDIT_ARCHITECTURE.md#当前产品主线2026-10-11-确认) 将能力区从四项扩为六项：信誉与评分、任务借贷、游戏赚资源、统一模型网关、执行与验收、Pi 自主执行。首屏、四步流程、系统图和页面 metadata 同步；FAQ 说明任务角色可切换、两个底层 LLM 的 Demo 范围、模型/服务报价与 usage 的区别、Pi 的授权边界，以及尚未开放的专家委托和按量额度借贷。保留 Oberon 排版与进场动效机制。

此轮只同步产品说明，没有新增金融、网关或自主调度能力。两模型网关联合部署未验收，不能从落地页能力介绍推断该链路已上线。验证结果见 [前端验收记录](frontend-release-acceptance-20261011.md)。


## Oberon 模块与动效复核（2026-10-11 用户复查）

用户反馈上一版缺少原站质感。重新运行同一固定 commit 的严格离线镜像，逐段检查能力区、流程、成果、案例和集成图后，确认此前只补首屏进场不足以代表原站完整动效。原站的章节分字显示、机械图标、四步连线和案例布局曾被简化成静态说明，本轮恢复其视觉结构与交互方式，并保留产品内容。

| 原版模块/特征 | 当前结合方式 |
| --- | --- |
| 首屏/页尾像素波纹 | 直接采用源 `iEh0WlD2mo4i3VmbpP52rJl0.png`，沿用 30px/s 横移与滚动缩放；不再用之前自行绘制的波形替代当前视觉。 |
| 章节标题分字出现 | 独立于首屏，在章节进入视口时逐字符显示，只播放一次；SSR/无脚本和减少动画偏好保持完整文字。 |
| 小型几何机械图标 | 使用原版橙色活动块、灰色构造线、文档/分流/上升图形语言承载六项能力；用原生 SVG/CSS 重建，未宣称与原 Framer 每个关键帧完全相同。 |
| 四步流程 | 恢复放大的编号、机械图标、虚线与传递中的节点，对应配置、执行、验收结算、信誉。 |
| Results 成果模块 | 展示已有测试网历史演示的 `640 → 710`、`B → A` 和 ERC-8004 身份关系；明确不是用户当前账户数据。 |
| Case studies 案例模块 | 恢复左侧叙事、右侧抖色大图、箭头切换及底部 NEED/ACTION/RESULT/CTA。三场景分别解释任务信用、游戏补给和信誉；沿用源案例图作装饰，不冒充客户、用户或执行截图。 |
| Integrations 集成图 | 恢复放射连接、活动节点与中心标记；外围替换为托管钱包、Magpie、Pi、独立验收、游戏奖励和 ERC-8004。它是系统关系示意，不表示所有资金/额度通路均已接通。 |
| 网格与排版 | 恢复贯穿章节的列线、橙色基准线和接近原版的字号/留白，手机独立适配。 |

两张源图片来自用户指定仓库同一 commit；本地副本为 `frontend/public/landing/oberon-wave.png` 与 `oberon-execution.png`（后者采用原仓库 1024px 变体）。图片只作页面素材，未迁入源站客户证言、收益数字、遥测或第三方远程资源。抖色由同源图片在浏览器一次绘制完成。循环动效离开视口/标签页后暂停；减少动画时完全静态；箭头可键盘操作并标明前后边界。

生产构建通过，生产版落地页 12/12、动效 12/12，覆盖 1440/393/320px。新增检查验证案例内容和 CTA 同步切换，以及章节文字终态、视口外暂停和减少动画行为。来源截图、当前截图、图片 SHA-256 和复核结果保存在 `frontend/acceptance/oberon-restoration/`；入口仍为 3024，构建目录 `.next-oberon-restored`。核心能力完整度另见 [实现状态](implementation-status.md#六项核心能力完整度复核2026-10-11)。


## 按钮与原创场景图复核（2026-10-12）

再次对照 https://oberon.framer.website/ 当前页面实际 DOM / CSS：主按钮高度 57px、桌面 Geist Mono 15px / 500 / 20.25px，白色/深色底，橙色填充从左扫入，12px 右向箭头从文字左侧出现。以共享 `landing-action.tsx` 统一首屏、章节和案例 CTA；键盘焦点提供同等反馈，减少动画时去掉过渡。手机保留 57px 高度，中文按钮使用 14px 避免窄屏拥挤。原有首屏及章节动效不变。

IN ACTION 已移除源案例图 `oberon-execution.png`，替换为内置 image_gen 为 AgentFuel 生成的三张独立概念图：`agent-execution.png`（推理执行核心）、`agent-rewards.png`（竞技奖励）、`agent-reputation.png`（信誉阶梯）。文件位于 `frontend/public/landing/`，完整生成提示词保存在同目录 `agent-imagery.json`。图片随场景文字与 CTA 同步切换；保留黑白有序抖色和轻微放大，画布限制 1024px 宽以控制手机像素处理量；切换时重建画布，避免显示上一场景的点阵。图片是装饰概念，不是运行证据。

生产构建（含 TypeScript）通过。浏览器复核 1440px / 393px / 320px 无横向溢出，三场景图片加载、点阵、前后边界及章节跳转正常，浏览器 error/warn 记录为空；最终按钮键盘焦点检查确认橙色填充和左侧箭头。截图在 `frontend/acceptance/landing-polish-20261012/`。本地 3024 使用 `.next-landing-polish-final` 生产构建，沿用 Monad 测试网配置；此轮未进行链上或模型付费操作。


## 默认英文与中英切换（2026-10-12）

落地页 `/` 默认英文，`/?lang=zh` 提供简体中文，`/?lang=en` 显式选择英文；其他值回退英文。页头提供 EN / 中文链接，切换保留当前章节 hash，刷新与分享链接保留语言。语言通过 URL 确定，不依赖浏览器自动识别或本地存储。工作台、创建流程和业务 API 的语言不在本次落地页本地化范围内。

`landing-locale.ts` 集中维护对应文案，覆盖首屏、六项能力、流程、信誉、三个场景、奖励、系统图、FAQ、菜单、按钮与无障碍标签；页面标题与 description 同步本地化。`app/page.tsx` 使用本版本 Next.js 的异步 searchParams，在服务端直接输出完整语言内容。落地页根节点声明 lang，客户端进入/离开时同步并恢复 document.lang。主要文案保留服务端组件，语言入口和菜单/场景交互只使用小型客户端组件。

保留 Oberon 原有进场、章节文字和机械图形动效。手机语言入口放在页头下方，平板入口避让工作台按钮；英文说明收窄，避免与芯片图形重叠。前一轮原创新图和按钮样式随本次提交一并保存。

验证：生产构建（含类型检查）通过；前端单元测试 32/32。浏览器实际检查默认英文只保留语言入口“中文”，中英切换保留 #credit / #faq，中文刷新保持，未知语言回退英文，场景图片/CTA、FAQ 与章节菜单正常。1440 / 1024 / 393 / 320px 检查无横向溢出，手机文字与芯片不重叠、平板操作同一行。截图位于 `frontend/acceptance/landing-i18n-20261012/`。已更新现有浏览器回归用例的语言预期，并新增语言切换回归用例；本轮浏览器验证通过内置浏览器实际执行，未将自动化浏览器用例计入 32 项单元测试。

本地 `3024` 当前运行 `.next-landing-i18n-final` 生产构建，沿用 Monad 测试网配置。


## 创建终端问答交互（2026-10-12）

`/onboarding` 六项配置改为连续 CLI 问答：提示符、问题和输入位于同一行，无输入底色、边框和独立的“下一项”按钮。原生文字编辑使用绿色光标；支持 `caret-shape` 的浏览器显示块状光标，其他浏览器使用原生光标。回车确认后，答案立即留在终端输出中，下一题紧接着出现，不再逐题等待打字动画。输入法组合期间和长按 Enter 不推进配置。

模型、策略和授信使用终端选项列表，↑/↓、Home/End 移动，Enter/Space 确认，也可直接点击选项。列表保留可访问名称、选中状态和键盘焦点；手机保留同一行的小型 ↵ 入口，便于没有回车的数字键盘确认。空名称和预算错误显示为终端错误行。最终配置核对与“确认创建”、原请求恢复仍保留，API、钱包签名及链上逻辑未修改。

生产构建（含 TypeScript）通过。通过内置浏览器，在真实组件的隔离登录数据预览中完成六项配置至 review，检查了方向键/Home 选择、回车、点击、中文文本输入、空名称、累计预算校验及返回编辑；393px 手机无横向溢出。输入法组合防误提交由代码防护，未进行真实 IME 手工验证。预览不连接钱包或业务 API，未提交创建。浏览器 error/warn 为空。更新现有浏览器回归用例的配置助手以适配列表和回车操作；本轮未运行完整浏览器回归套件。

截图保存于 `frontend/acceptance/onboarding-cli-20261012/`，文件名明确标记 synthetic。隔离预览结束后清理。本地 3024 使用 `.next-terminal-cli-final` 生产构建，沿用 Monad 测试网配置。


## CRT 荧光终端视觉（2026-10-12）

用户提供 Skills Curator 仓库作参考。指定的 `apps/desktop/src/renderer/routes/home.tsx` 是桌面技能管理页；实际第二屏 CRT 位于该仓库的 `apps/web/src/components/crt-terminal.tsx`、`apps/web/src/globals.css`（`.crt-*`）及 `hero-zoom.tsx`。

创建页借鉴其默认琥珀色荧光配色：深色 `#160a02` 屏幕、`#ff8f3f` 正文、浅琥珀高亮、轻微文字发光、4px 扫描纹理、暗角和 12 秒扫过的亮带。桌面正文从 13px 调整为 16px，手机 13px、最窄屏 12px。沿用本地 Geist Mono，避免引入远程字体。效果限定在 onboarding；没有迁入参考页的模拟日志和滚动缩放。保持上一节的真实 CLI 问答与业务状态。

装饰覆盖层不接收指针事件；移动亮带只做 transform/opacity 动画，标签页隐藏时暂停，减少动画模式关闭亮带。没有采用参考页的高频闪烁。输入光标、焦点、错误行、待确认原请求和最终创建确认保持可用。

验证：生产构建（含 TypeScript）通过；实际组件隔离登录预览走完六项配置至 review，检查方向键、点击、回车、累计预算报错及手机行内确认。393px、320px 无横向溢出；实际 3024 页面已核实深色背景、16px 正文和扫描纹理生效。未连接钱包或提交创建。现有浏览器用例的背景色预期已同步，未运行完整回归套件。截图在 `frontend/acceptance/onboarding-crt-20261012/`，模拟登录截图含 synthetic 标记。当前 3024 运行 `.next-terminal-crt`，沿用 Monad 测试网配置。
