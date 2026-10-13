# GameFi 控制台浏览器验收

日期：2026-10-05。开发验收地址 `http://127.0.0.1:3022`，未操作 3020 production。

测试只验证界面控制和数据展示。每个用例在导航前拦截 `/api/arena/gamefi*` 与 `/api/arena/credits*` 的全部请求，使用 `route.fulfill` 或 `route.abort`；这些路由不使用 `route.fetch`/`route.continue`。因此 start、recover、redeem 不会到达配置的真实 runner，不会触发付费模型或奖励交易。截图中的比赛和 token 数字均为明确的受控测试响应，不能当作真实奖励证据。

8 个场景 × 桌面/手机，共 16 项；最终结果见 `browser-report.json`。覆盖：

- 服务未配置时禁用 start/redeem，包括之前保留的比赛重试。
- start 响应丢失后保留原 UUID，刷新后重试完全相同的命令，不生成第二个比赛 ID，轮询到完成。
- 按已保存 requestId 读取暂停阶段，recover 只使用原 ID，不发送新 start。
- 固定服务端身份的可用、已消耗、预留 token；完成后按 usage 展示扣减和回答，POST 不包含客户端身份字段。
- 第一次兑换完成后，第二次丢响应时不会沿用旧 Completed 状态放开按钮，查询使用第二次原 ID，未知结果禁止新兑换。
- 页面刷新后恢复原兑换 ID、未知状态和预留额度。
- 额度不足、blocked、空问题与未开放奖励种类均不能提交。
- 发现服务返回的 active 比赛，自动读取原 ID 并轮询到额度发放完成；轮询回包保留近期比赛列表，可按历史原 ID 选择查看。

所有用例监听 pageerror。布局验收断言无横向溢出，并保存桌面/手机控制台截图：`completed`、`recovered`、`credits-completed`、`credits-unknown`、`credits-awarded`、`unconfigured`。

复现：Node 22 下运行 `GAMEFI_CONSOLE_TEST_URL=http://127.0.0.1:3022 npm exec --workspace @agentfuel/frontend -- playwright test --config playwright.gamefi-console.config.ts`。frontend typecheck 通过。

2026-10-10 终端统一回归：同一 16 项在独立 3016 的 Next 生产构建上全部通过，全部付费 API 继续拦截，未操作 3020 用户预览。上述 12 张桌面/手机控制台截图已更新为 Agora 灰白/紫色等宽终端界面；图中的比赛、金额与 token 仍为受控响应。
