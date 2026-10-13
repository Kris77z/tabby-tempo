# 本地真实模型联调

无需先部署到云端。前端、托管后端、Magpie、Pi、独立 Docker Arena 和结算器均可在本机运行；链上操作使用独立 Anvil。身份注册表和 USDC 是本地测试版本，模型请求通过 Magpie 调用真实 Kimi K2.6 / Kimi K3。

## 启动

需要 Node 22.19+、Foundry、可用 Docker，以及项目锁定的 Magpie 二进制。供应商配置沿用 `verify-live-tiers.ts` 的私有 JSON：`upstream.name=kimi`、`baseUrl=https://api.moonshot.cn/v1`、`apiKeyFile` 为绝对路径。配置和 key 文件权限为 0600。

在仓库根目录分别运行，路径替换为本机实际值：

```bash
npx tsx scripts/local-model-gateway.ts --config /absolute/private/demo.monad.json --binary /absolute/locked/magpie --directory /absolute/new/gateway
npx tsx scripts/local-hosted.ts start /absolute/new/runtime /absolute/new/gateway/ready.json /absolute/private/kimi.key
```

网关默认监听 3426，薄桥健康检查为 3427；后端为 8791，前端预期为 `http://127.0.0.1:3024`。启动不发送推理请求。运行目录拒绝覆盖已有链和任务记录。该启动器是开发工具，会创建 16 个报酬已托管的编程任务；关闭它会关闭这一临时链。

在 `frontend` 目录先构建，再启动：

```bash
NEXT_DIST_DIR=.next-local npm run build
NEXT_DIST_DIR=.next-local FRONTEND_MODE=chain FRONTEND_RPC_TRANSPORT=direct \
FRONTEND_MANIFEST_PATH=/absolute/new/runtime/deployment.json \
HOSTED_AGENTS_URL=http://127.0.0.1:8791 HOSTED_FRONTEND_ORIGIN=http://127.0.0.1:3024 \
../node_modules/.bin/next start --hostname 127.0.0.1 --port 3024
```

## 创建与资金准备

使用本地钱包签名登录，在网页创建 Agent。新钱包没有 gas 时会暂停开户；从页面复制托管钱包地址，明确调用本地 faucet：

```bash
npx tsx scripts/local-hosted.ts fund /absolute/new/runtime 0xAgentWallet 40000
```

命令只允许本机 Anvil（31337），提供测试 gas 和指定最小单位的测试 USDC；它不是产品 gas 赞助服务。然后恢复原开户请求，将 0.04 USDC 存入 Account。当前包价 0.12 USDC，允许信用时可用 0.04 现金加 0.08 任务借款购买额度。界面展示的是 Demo 费率，不是供应商账单。

## 可重复验收

以下脚本会调用真实模型，使用启动器生成的独立本地验收钱包。先准备三个 Agent，再分别执行两个模型和最多两单的自主循环：

```bash
npx tsx scripts/local-hosted-acceptance.ts /absolute/new/runtime prepare
npx tsx scripts/local-hosted-acceptance.ts /absolute/new/runtime cheap
npx tsx scripts/local-hosted-acceptance.ts /absolute/new/runtime strong
npx tsx scripts/local-hosted-acceptance.ts /absolute/new/runtime autonomy
npx tsx scripts/local-hosted-acceptance.ts /absolute/new/runtime evidence
npx tsx scripts/local-hosted-browser.ts /absolute/new/runtime final
```

本次验收还保留了一个旧自主现金方案的暂停/过期退款分支。独立验证修复后的信用方案可用 `prepare-credit`、`autonomy-credit` 两个 mode，它们创建第四个测试 Agent，不重写旧决策。`refill-autonomy` 与 `refund-expired-autonomy` 仅用于本次已记录的异常分支；不是正常演示的必经步骤。最终成功和异常记录见[本地验收报告](local-real-acceptance-20261012.md)。

所有业务请求经过真实 Next 前端 API；浏览器脚本只注入本地签名钱包，不拦截 API，不点击付费按钮。请求 UUID 先写入 `acceptance.json`，再次执行不会另建付费请求。失败或未知结果需先检查原请求；不要删除记录再重跑。faucet 中断也必须先核对余额，不能盲目重复 mint。

网关 `attempts.jsonl` 保存真实调用次数、物理模型和 usage；托管私有目录保存付款、代码执行和结算记录。`evidence` 验证同一 UUID 重放不新增模型请求或钱包交易。浏览器截图及去敏报告保存在 `frontend/acceptance/local-real-20261012`。

开发时可在确认没有新业务请求后，向 `runtime/ready.json` 中的启动器 PID 发 `SIGUSR2`：仅重启托管子进程并恢复原 journal，保留 Anvil、网关和任务。不要把这个开发重载机制当成生产进程管理器。

本地通过后，仍需单独验收 Monad 测试网部署、真实注册表及公网运行配置；本地模型真实调用与这些部署条件分别记录。
