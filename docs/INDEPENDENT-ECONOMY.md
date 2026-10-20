# 独立 Publisher / Worker

`npm run test:publisher-worker` 从本仓库构建独立SDK包，在仓库外安装消费者，运行分开的Publisher、Worker、验收者和本地合约。`npm run economics:independent` 默认为shadow；`--execute-local` 明确运行本地有界工作。

入口固定31337和loopback。模型是受控响应，验收运行固定Docker镜像；没有公共Tempo、真实模型或线上Hosted启用。生产Alchemy/本地faucet代理规则不变。

Worker持久化原任务、报价、handle、预算和请求身份，累计花费、任务数、时间和保留现金不会在冷启动时重置。beforePayment管新付款，beforeDispatch管未交付的新模型派发；已付款但过期/停止/Unknown不新增派发，Delivered缓存仍可读。派发准入先落盘，再复查停止/截止；损坏或已有reservation均拒绝。未确认交易只核对原hash，不自动重签或重播。

Arena error-run默认只读，明确`--allow-submission-recovery`才允许原payload的一次持久恢复；恢复不是新的付款/模型许可。Unknown阻止新任务。仅本地fixture可显式授权原供应商退款和验收者任务关闭，退款不恢复累计支出额度。

证据和验证入口见 [Review](REVIEW.md)。
