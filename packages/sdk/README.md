# InferCredit SDK

Node 22 与浏览器 ethers Signer 入口，共用 relay 报价编码，完成自建 402/receipt 支付。未声称标准 x402 兼容。Next 项目须配置 `transpilePackages: ["@agentfuel/sdk"]`。

```ts
import { InferCredit, PaymentError, type PaymentHandle } from "@agentfuel/sdk";
import { BrowserProvider, parseUnits } from "ethers";

const signer = await new BrowserProvider(window.ethereum).getSigner();
const infer = new InferCredit({
  agentId: "1", signer, // Node 可用 sessionKey + rpcUrl；两入口只选一个。
  chainId: 10143n, account: manifest.contracts.account,
  asset: manifest.asset.address, provider: manifest.providers[0].address,
  maxPrice: parseUnits("0.12", manifest.asset.decimals),
  underwriterUrl: manifest.underwriterUrl,
  onHandle: handle => localStorage.setItem(`infer-payment:${handle.quote.paymentId}`, JSON.stringify(handle)),
});
const paid = await infer.forTask("1").fetch(`${manifest.providers[0].relayUrl}/v1/chat`, {
  body: { service: "infercredit/coder", model: "coder", messages: [
    { role: "user", content: "Return a Python stdin/stdout solution, code only." },
  ] },
});
// paid.result 是模型 JSON；paid.receipt 含付款和实际上游证据；paid.handle 可 JSON 保存。
const resumed = await infer.resume(savedHandle as PaymentHandle);
infer.close(); // 只销毁 SDK 自己创建的 RPC，不销毁调用方 BrowserProvider。
```

`infer.fetch(url,{body})` 无任务，报价 taskId=0，只允许纯 cash；不足报 CASH_REQUIRED。forTask 仍先用 cash，不足才请求 underwriter。同 task 已有 loan 就报 TASK_ALREADY_BORROWED，换 nonce 不能绕过。金额用 BigInt，ID 用十进制字符串。SDK 校验原始请求摘要、paymentId、期望 chain/asset/account/provider、逻辑 service/model 和 maxPrice，不能被任意 402 诱导付款。

两档 Relay 请求在 body 显式加 `tier: "cheap"` 或 `"strong"`；SDK 验证 quote.tier 与请求一致，并继续使用既有 `maxPrice` 作为每次推理的付款上限。strong 超预算会在保存付款 handle、请求授权、签名或广播前报 `UNTRUSTED_QUOTE`；SDK 不自动改请求档位。调用方可先选择符合能力和预算的档位。单档 coder demo 继续省略 tier，格式不变。

原 quote 的 tier、price 和请求摘要随 handle 保存；fallback/恢复使用同 paymentId，不重新报价或二次付费。未付 quote 若 status.deliveryError 表明原路由不可履约，SDK 返回该错误且不提交付款。已付路由失效时仍能查询状态/运营退款，恢复返回 `ROUTE_UNAVAILABLE`；旧未交付记录缺快照返回 `ROUTE_SNAPSHOT_REQUIRED`，已交付缓存仍可领取。receipt.model 归因于实际请求的配置物理模型，result.model 保留上游自报值，尚未验证网关后的模型归因。

`PaymentHandle` 包含 version/relayUrl/input/quote/creditNonce，以及已提交的钱包 from/nonce/hash；私钥 Wallet 模式还保存公开 rawTransaction。onHandle 在广播前 await，调用方应持久化它。Signer 模式直接使用 BrowserProvider 的 provider，无须暴露 server RPC key；sessionKey 模式要求 rpcUrl。服务 browser origin 必须列入 Underwriter/Relay 的 FRONTEND_ORIGIN。

可选 `beforePayment(handle)` 为宿主的时间/预算检查：Wallet签名前、原raw广播/重播前、Browser send前均await；拒绝时不付款。它可能多次调用，应无副作用或幂等。已确认链上付款和Delivered缓存领取不调用该guard，允许截止后只领取原结果。未配置时保留旧调用行为。`onHandle`保存失败同样停止付款；[受限Pi循环](../pi-loop/README.md)据此先持久预留报价，再允许纯cash付款。

超时或重启用同 handle 调 resume，先查询服务状态与链上 payment/receipt，禁止另造 paymentId 或盲目再付。Wallet 若确实需要重播只播已保存的相同 raw bytes；已知 pending、nonce 已消费但无证明或签名已过期都明确等待/拒绝，不重新签付款。浏览器 signer 无 raw bytes时，先保存 from/nonce 意图；丢 hash 的未知 send 结果绝不二次 send，relay 可从链上事件发现已付款。钱包明确 4001/ACTION_REJECTED 时清除未广播意图，允许同 handle 显式恢复。

PaymentError 提供 code、handle、可选 reason；SpendRejected reason=1..5 和 Manager IdentityChanged/AuthExpired/NonceAlreadyUsed 等 custom errors可用于反向 demo。UPSTREAM_FAILED/RELAY_UNAVAILABLE 仍保留同付款 handle；Refunded 终态返回 REFUNDED。同实例同 ID 并发共享一次恢复，钱包付款签名按实例串行；不同客户端共用一个钱包应由调用方协调，SDK 不是后台 nonce 服务。

真实本地验收在 `services/provider-relay/test/flow.test.ts`：SDK→402→Underwriter→四合约→受控上游→receipt，USDC6d/native18d；覆盖现金路径、并发/缓存、错误请求/receipt、晚付款退款、Processing 重启、顺序 fallback、分次退款与文件提交故障、BrowserProvider 拒绝/丢 hash恢复、日志分块与确认水位、过期签名禁止重新广播。运行 `npm test --workspace @agentfuel/provider-relay`。

显式 cheap/strong 的本地受控验收另见 `services/provider-relay/test/tiers.test.ts`，使用 Anvil 付款与退款。2026-10-04另通过SDK→本地Anvil付款→Relay→真实K2.6/K3，各一次128输出上限的短探针，两次均最终OK/stop；运营价0.01/0.03 mock-USDC，缓存恢复零新付款/模型请求。见[报告](../../demo-output/live-tiers-20261004-k26-k3-128/report.json)与[离线审计](../../demo-output/live-tiers-20261004-k26-k3-128/offline-audit.json)。原Anvil已关闭且本次未保存raw transaction receipt，离线审计只能核验签名交易、Relay proof与保存结果一致性，不能独立复验原ProviderPaid事件；复用脚本已补raw receipt保存/校验。探针未评估能力、真实链资金或标准x402，该短探针未使用Pi/Magpie。前一批[受限Pi cash循环](../pi-loop/README.md)使用受控上游；随后真实K2.6经SDK→Relay→Pi实际工具调用，公开样例与独立Arena本地结算已通过。该次只用1轮/0.01 mock-USDC，未使用strong或验证真实多轮修复；raw付款/结算receipts、请求响应与签名journal均保存，见[报告](../../demo-output/live-pi-20261004-kimi-once/report.json)和[root独立验收](../../demo-output/live-pi-20261004-kimi-once/root-acceptance.json)。它不是Monad Pi或信用loop验证。


[固定价求解服务B](../pi-loop/FIXED_PRICE.md)通过一次 `forTask` 请求购买最多N轮求解，cash不足时复用原单task一次draw。服务内部轮次不改PaymentHandle body、不另造nonce或逐轮提款；agent只恢复原handle，交付后的最终Arena与未交付运营退款分开。本地受控spike不是本次真实Kimi cash验证的扩展证据。
