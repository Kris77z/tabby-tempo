# 本地真实浏览器验收

真实 Chrome 桌面与 Pixel 5 两种视口，各完成一次 owner 签名登录，覆盖四个 Agent。全部业务读取走真实 HTTP，无接口 mock、无业务 POST、无链交易。共 28 张有效截图（桌面 8、移动 20），无 pageerror、横向溢出或 hosted HTTP 异常；预取页面 /arena 和 /advanced 的 ERR_ABORTED 属于切换/关闭浏览器时取消的页面预取。

| Agent | 真实结果 | cash | debt | InferScore / Tier |
|---|---|---|---|---|
| cheap | 成功 1 单 | 0.058 USDC | 0 | 570 / C |
| strong | 成功 1 单 | 0.058 USDC | 0 | 570 / C |
| autonomy-credit | 自主信用完成 2 单，已确认支出 0.26 USDC | 0.0672 USDC | 0 | 640 / B |
| autonomy | 失败 REFUNDED，完成 0 单，实付规划费 0.01 USDC | 0.12 USDC | 0 | 500 / C |

移动资源面板对真实内部滚动容器分段截取，resources 与 resources-scrolled-1 / -2 共同覆盖金融卡片。旧 autonomy 是实际退款异常路径，不计入成功任务。

## 可见界面问题

- 移动端操作区与顶部导航占据大部分高度，资源可滚动内容仅约 140 CSS px；金融卡片需分三屏阅读，任务记录也需要内部滚动。
- 退款失败目前直接显示英文机器码 REFUNDED，缺少中文的退款说明及退款金额，用户需要打开凭证理解。
- 预算卡的“最近确认 cash”仍展示上次充值快照（自主信用 Agent 为 0.05 USDC），同屏最新链上金融快照已经是 0.0672 USDC；虽然有时间戳，两个余额仍容易混淆。

以上是展示层优化点；本轮未修改产品界面，验收 JSON 与截图保留实际结果。
