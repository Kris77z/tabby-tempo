# AgentFuel GameFi 主入口验收

日期：2026-10-04。本轮把白色 Arena 壳接回项目现有 GameFi；复刻资源来源仍见 `../arena/clone-evidence.md`。

- `/arena` 在服务端使用 `loadHoldemSnapshot` 加载已校验的公开报告。通过 `HoldemArena embedded` 共用回放、模型记录和 `HoldemMonadEvidence`，同页显示真实模型德州、Monad Testnet USDC 赞助奖励、奖励现金推理付款及报告时 cash。数字来自配置报告，不来自练习数据或 UI 固定值。
- 现有四游戏保留为策略练习与邀请练习。Bot 显示 AgentFuel 策略 Bot，小丑牌席位为关卡主持；不发放 USDC 或 LLM 额度。
- LLM 额度奖励明确待接入。真实新局、派奖和消费由项目 CLI 执行；页面不会调用真实模型或提交交易。
- `/arena/holdem` 默认报告组件结构和原有本地证据区保持兼容；大厅嵌入区隐藏本地 mock-USDC 消费区。
- 缺少真实报告时不展示示例奖励或现金；刷新失败保留最后成功快照；Unknown 购买显示暂停，奖励入金 cash 与完成消费 cash 分开标记。

浏览器验收使用 `http://127.0.0.1:3021`，独立 `.next-gamefi` dev，未更改 3020 production。配置源为 `demo-output/holdem-live-20261004-root/report.json` 及同目录 `monad-delivery-report.json`、`monad-purchase-report.json`。

验证：frontend typecheck 通过。`browser-report.json` 为完整 18 项（9 场景 × 桌面/手机）最终结果；包含四游戏实际行动、两浏览器邀请码准备/取消、未知 create 复用同一请求、GameFi 实际同局奖励付款余额、终局回放和旧路径兼容，以及报告缺失/读取失败/未知推理边界。边界测试仅截获只读 GET 返回，不进行模型付费、链操作或改变报告。

截图：`lobby-desktop.png`、`lobby-mobile.png`、`gamefi-terminal-desktop.png`、`gamefi-terminal-mobile.png`，以及四种练习桌面/手机状态。截图未打开练习席位提示词，不含席位凭证。大厅测试同时验证本地封面加载、无外部网络请求和无横向溢出。
