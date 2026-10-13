# 前端上线测试前验收 · 2026-10-11

首轮结论：当时确认的恢复入口、个人金融信息和静态产品落地页已完成。后续用户复查指出首次进入动效和独立终端创建页遗漏；首轮静态截图与导航用例不足以支持完整体验验收，修正记录见本文末尾。执行由三名 GPT-6.1-sol / ultra Agent 分别负责，主 Agent 审查实现、回传问题并独立复跑验证。此结论覆盖本地前端与本地链整合，不表示公开部署或真实钱包扩展、Monad、供应商联合验收已完成。

## 本轮范围

- **恢复入口**：请求按更新时间保留最近 100 条，并额外保留所有未结束或被 Agent 引用的记录。task、deposit、game 在超过 100 条后及服务重启后仍可用原 ID、金额、奖励选择恢复；恢复成功的结果留在最新记录。
- **个人金融信息**：工作台显示本人链上身份的 cash、完整未偿债务、InferScore、Tier、费率、还款和声誉计数。评分采用 Underwriter，账本与其快照使用同一区块，普通列表轮询不扫描金融账本。未知值不伪装为零，读取失败保留并标记旧快照。
- **结算证据**：接单、付款、真实结算交易分别展示。只有 canonical receipt、目标任务的 TaskSettled 与终态 task/loan 一致才显示结算证明。结算入账不称为利润；已付款但暂停的请求显示已核验付款金额，预算累计单独标记为已结账支出。
- **Oberon 落地页**：`/` 保留原六列网格、大标题、灰橙配色、芯片和像素波形；文案适配任务信用、托管 Agent 与免费德州。主按钮进入 `/dashboard`，终端、游戏与高级协议页可返回首页。来源 commit 和字体许可见 [来源记录](frontend-oberon-landing.md)。

按用户要求，本轮没有实施第 2 项 gas / 新用户入金引导，不增加 gas 赞助入口或相关产品宣传。已有历史后端能力不在本次变更范围。

## 独立验收结果

| 范围 | 结果 | 证据内容 |
| --- | --- | --- |
| 托管浏览器 | 48/48 | 桌面/手机登录、创建、设置、任务、免费游戏、入账、额度、恢复、金融变化、三类交易链接和会话隔离 |
| Oberon 浏览器 | 9/9 | 1440×900、393×851、320×740；字体、资源、布局、菜单、Escape、FAQ、锚点与工作台往返 |
| 终端跨页 | 14 个用例均通过 | 大厅导航、四种免费练习的实际动作、只读报告与高级档案；首次 13/14，修正导航等待后相关桌面/手机 2/2 |
| GameFi 控制台 | 16/16 | 在本次生产构建上核对原 UUID 恢复、奖励、额度与禁用边界 |
| 德州证据 | 6/6 | 在本次生产构建上核对回放、分阶段证据、停止态和失败刷新 |
| 前端 Node | 30/30 | 实际 Anvil / Underwriter 读取与钱包操作、桥接、字段投影及链精度 |
| 托管 Node | 31 个用例均通过 | 原 30 项中首次 29 pass、1 项 Relay 超时；该端到端用例单独复跑通过；新增缺计数拒绝 1/1 |
| 配置 / HTTP 定向复验 | 12/12 | CLI 4 项，以及已计入上述范围的金融 HTTP、投影、Next 桥接 8 项 |
| 静态与构建 | 通过 | Node 22.23.2，`npm run typecheck:all`、Next 16.3.8 production build、`git diff --check` |

浏览器共覆盖 **93 个不同用例**。托管浏览器用合成 API 与本地个人签名；免费练习在本地测试进程运行规则引擎。后端整合使用真实本地 Anvil 合约、独立 Arena / settler 和受控模型响应，没有新公网交易或真实模型消费。

真实本地托管整合最终完成创建 → 入账 → 信用任务 → 获得 USDC 奖励 → 现金完成下一单 → 获得并消费额度。结果：taskCalls=2，游戏/额度调用=5，cashRaw=188000，spentRaw=240000，creditsGranted=4096，creditsUsed=18，outstanding=0；重放原请求没有新调用或新交易。首轮并行验收出现 RELAY_UNAVAILABLE 后保持 Paused；单独复跑上述闭环通过，未放宽生产重试规则。

验收中额外修复了旧金融请求迟到 401 清除新登录 cookie 的竞态：新登录等待旧金融传输完成；浏览器回归使用真实 HttpOnly cookie 与 Set-Cookie 验证。金融投影还会拒绝缺失任一还款/声誉计数字段的响应。

终端跨页用例原先仅等待两个页面共用的 FIXTURE 文字，现核对目标 URL 与独有标题；首次访问 `/dashboard` 允许 Next dev 冷编译的等待时间。生产版导航往返另行通过，不依赖开发模式时限。

## 生产页面检查与本地预览

生产版 `/`、`/dashboard`、`/arena`、`/arena/holdem`、`/advanced` 在桌面及手机共 10 次读取均 HTTP 200、同源字体加载成功、无页面异常、失效静态资源或横向溢出；另检查 320px 首页。首页 CTA 与工作台品牌往返通过。生产页面检查保存在 [production-pages.json](../frontend/acceptance/release-20261011/production-pages.json)，对应截图在同目录；金融手机截图使用明确的合成接口。

预览为 `http://127.0.0.1:3024`。本次使用独立 `.next-release-acceptance` 构建与启动，不覆盖既有 3000 / 默认 `.next` 或 3020 / `.next-local-preview`。托管上游在此预览中明确留空，工作台显示服务未配置，高级页显示空态；未配置德州报告明确显示 FIXTURE。

```sh
NEXT_DIST_DIR=.next-release-acceptance npm run build --workspace @agentfuel/frontend
NEXT_DIST_DIR=.next-release-acceptance FRONTEND_MODE=chain \
  HOSTED_AGENTS_URL= HOSTED_FRONTEND_ORIGIN= \
  npm run start --workspace @agentfuel/frontend -- --port 3024
```

金融账本仍沿用 P0 最多 200 项任务的完整读取上限，超过或在 45 秒内无法完成会显示不可用；历史未分类交易不会被补写成结算证据。真实部署后的钱包扩展、服务配置和公网链联合测试属于下一阶段。

## 用户复查后的体验补验

本次补齐两个首轮遗漏，并调整德州历史证据的入口。实现仍由 GPT-6.1-sol / ultra 执行，主 Agent 对照原站真实帧、审查源码、独立复跑浏览器并更新本地生产预览。

- **首次进入动效**：按源站逐字符标题、逐词说明、Logo / 文件列进入、芯片收缩后分层展开和外围节点依次推出实现。首绘样式随服务端内容输出；刷新重播，滚动不重播；减少动画偏好和禁用 JavaScript 时直接完整显示。主验收发现的外围节点终态隐藏问题已修复，并增加末态断言。波形速度测试采用 rAF 时间戳，避免 CPU 忙时用回调执行时间误判。
- **独立终端创建**：新增 `/onboarding`，采用源 Agora 的暖白棕色、Geist Mono、启动文本、光标、逐项输入与最终确认。六项参数来自当前托管契约；真实钱包签名与平台模型目录、原 UUID 恢复、创建成功后选中新 Agent 均接既有接口。根层共享会话控制器保留跨页认证与请求锁；离开托管页面停止读取；换钱包清除旧终端记录与配置；迟到成功不将用户强行带回。
- **德州历史证据**：固定运营比赛的只读回放、奖励与推理证明，用于演示追溯；不是创建 Agent、运行任务或个人参赛的必经页。已从主导航移除，保留在高级协议“历史演示与证据”及工作台折叠的高级入口，相关文案统一为历史回放与奖励凭证。

| 补验范围 | 主 Agent 结果 |
| --- | --- |
| 托管浏览器（含新终端及跨页 Cookie 竞态） | 60/60，桌面及手机 |
| 终端跨页与高级历史入口 | 14/14 |
| 生产版落地页与两类 CTA | 9/9，1440 / 393 / 320px |
| 生产版真实进场帧、刷新、减少动画、禁用脚本 | 9/9，同上三个宽度 |
| 生产构建（含 TypeScript）与差异格式检查 | 通过 |

本轮共 92 项相关浏览器用例通过，与首轮测试存在重叠，不能相加为不同用例数。生产版另检查三个宽度的 `/onboarding` 未配置空态及 `/advanced → /arena/holdem`：无横向溢出或页面异常，见 `frontend/acceptance/release-20261011/experience-pages.json`。终端确认截图为合成 API，保存于 `frontend/acceptance/onboarding/`；源站与当前刷新时间帧保存于 `frontend/acceptance/landing-motion/`。

当前 `http://127.0.0.1:3024` 已切换为 `.next-experience-acceptance` 的最新生产构建，既有 3000 / 3020 未改动。托管上游仍明确留空，因此此预览可以验收页面与动效，签名与创建按钮在服务未配置时保持不可用；真实创建闭环由上述受控 API 浏览器回归验证。未部署、未发生公网链交易或真实模型消费。

```sh
NEXT_DIST_DIR=.next-experience-acceptance npm run build --workspace @agentfuel/frontend
NEXT_DIST_DIR=.next-experience-acceptance FRONTEND_MODE=chain \
  HOSTED_AGENTS_URL= HOSTED_FRONTEND_ORIGIN= \
  npm run start --workspace @agentfuel/frontend -- --port 3024
```


## 六项核心能力与产品主线同步

本次按用户确认的六项能力同步 README、架构、工程计划、Pitch、实现状态和落地页说明。主线固定为托管 Agent 接单、采购推理、必要时申请任务信用、Pi 执行、独立验收、收入还款与信誉积累；任务发布者/接单者是可随任务改变的角色。当前用户界面的自主专家委托、按量额度借贷与自动补额仍明确为未开放，两个底层模型通过托管入口与 Magpie 的联合部署未被列为已验收。

落地页扩为六张能力卡，同步首屏、流程、模型网关示意、FAQ 与 metadata；保留进场动效机制。生产构建（含 TypeScript）通过；最新生产预览下，落地页 9/9、动效 9/9 通过，覆盖桌面、手机、320px 窄屏、首次进入/刷新、减少动画与禁用脚本。共 18 项为相关回归，不与前文用例累加。六项能力区人工复核截图在 `frontend/acceptance/landing/product-capabilities-{desktop,mobile}.png`，完整页面与刷新帧同步更新。

当前 3024 预览使用 `.next-positioning-acceptance`；旧体验构建已清理，既有 3000 / 3020 未改动。托管上游仍未配置，本次只验收文案、布局、导航与动效，没有新增后端能力或执行公网链/真实模型消费。

```sh
NEXT_DIST_DIR=.next-positioning-acceptance npm run build --workspace @agentfuel/frontend
NEXT_DIST_DIR=.next-positioning-acceptance FRONTEND_MODE=chain \
  HOSTED_AGENTS_URL= HOSTED_FRONTEND_ORIGIN= \
  npm run start --workspace @agentfuel/frontend -- --port 3024
```


## 核心能力完整度与 Oberon 模块补验

源码复核确认，当前不能概括为只剩前端验收。任务可消费的奖励/借入 token 额度、两模型统一托管网关闭环、有预算/停止条件的 Pi 连续决策尚需补齐；已实现的信誉、资金信用、任务独立验收和游戏发奖保持原证据范围。详见 [六项核心能力复核](implementation-status.md#六项核心能力完整度复核2026-10-11)。本轮没有实现这些后端缺口。

页面按源站逐段对照，恢复原像素波纹素材、章节分字进场、机械几何图标与流程节点、成果模块、抖色案例切换和放射集成图。原版模块结合当前产品内容的映射、资产来源与边界见 [Oberon 复核](frontend-oberon-landing.md#oberon-模块与动效复核2026-10-11-用户复查)。

生产构建（含 TypeScript）通过；桌面/手机/320px 窄屏共 24 项浏览器回归通过：落地页 12 项、动效 12 项。新增覆盖键盘切换三种场景与正确 CTA、图像加载、章节文字终态、模块视口外暂停和减少动画偏好；既有首次进入/刷新、无脚本及导航回归通过。截图和来源证据在 `frontend/acceptance/oberon-restoration/`，不与此前测试数量累加。

当前 3024 使用 `.next-oberon-restored` 生产构建。旧 3000/3020 未改动；3026 开发对照与 4172 源站回放结束后关闭。托管上游仍留空，此轮未部署、未执行金融写入或真实供应商消费。

```sh
NEXT_DIST_DIR=.next-oberon-restored npm run build --workspace @agentfuel/frontend
NEXT_DIST_DIR=.next-oberon-restored FRONTEND_MODE=chain \
  HOSTED_AGENTS_URL= HOSTED_FRONTEND_ORIGIN= \
  npm run start --workspace @agentfuel/frontend -- --port 3024
```
