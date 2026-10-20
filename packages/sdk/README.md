# Tabby payment SDK

This guide is adapted for **Tabby Tempo**. The running deployment is Tempo Moderato `42431`, with **PathUSD** (`0x20c0000000000000000000000000000000000000`, 6 decimals) for settlement and fees. The [VPS runbook](../../deploy/tempo-vps/README.md) describes the sole production writer at `https://tempo.tabbyai.xyz`; this documentation/code update has not been deployed.

Local launch examples below are for a **new isolated Anvil fixture only**, with synthetic roles, fresh private directories and controlled inference. Never load or restart the archived local Tempo runtime, reuse its journals, or start another writer beside the VPS. Monad/MON/USDC examples and dated results are explicitly source-project history or offline fixture semantics, not current Tempo configuration or new acceptance. See [Tempo verification](../../docs/VERIFICATION.md).


`@agentfuel/sdk` is the agent-side payment client for Tabby's provider relay. It binds a 402 quote to the intended request and deployment, spends agent cash first, obtains task credit only for a shortfall, and preserves one recoverable payment handle across timeouts or restarts.

The exported `InferCredit` name and `@agentfuel/sdk` package name remain for code compatibility. The protocol is the project's own **402/receipt scheme**; standard x402 facilitator compatibility has not been validated. This SDK buys provider services. It does not independently evaluate a generated answer, settle a task, verify a model's identity behind a gateway, or authenticate every field returned in a relay receipt; task correctness belongs to the [independent Arena](../../services/arena/README.md).

## Use a browser signer

Requirements: Node 22 or newer for Node usage; an ethers `Signer` for a browser wallet. Next.js consumers must configure `transpilePackages: ["@agentfuel/sdk"]` because the workspace exports TypeScript source.

```ts
import { InferCredit, type PaymentHandle } from "@agentfuel/sdk";
import { BrowserProvider, parseUnits } from "ethers";

const signer = await new BrowserProvider(window.ethereum).getSigner();
const infer = new InferCredit({
  agentId: "1",
  signer,
  chainId: BigInt(manifest.chainId),
  account: manifest.contracts.account,
  asset: manifest.asset.address,
  provider: manifest.providers[0].address,
  maxPrice: parseUnits("0.12", manifest.asset.decimals),
  underwriterUrl: manifest.underwriterUrl,
  onHandle: handle => {
    localStorage.setItem(
      `infer-payment:${handle.quote.paymentId}`,
      JSON.stringify(handle),
    );
  },
});

const paid = await infer.forTask("1").fetch(
  `${manifest.providers[0].relayUrl}/v1/chat`,
  {
    body: {
      service: "infercredit/coder",
      model: "coder",
      messages: [{
        role: "user",
        content: "Return a Python stdin/stdout solution, code only.",
      }],
    },
  },
);
// result: provider output; receipt: relay delivery/payment metadata.
// A subsequent cache read reuses the persisted payment identity:
const savedHandle = JSON.parse(localStorage.getItem(
  `infer-payment:${paid.handle.quote.paymentId}`,
)!) as PaymentHandle;
const resumed = await infer.resume(savedHandle);
infer.close();
```

`manifest` is the configured deployment manifest, not a constant exported by the SDK. Select exactly one signer entry: a supplied `signer`, or Node `sessionKey` plus `rpcUrl`. `close()` destroys only an RPC provider created by this SDK, leaving a caller's `BrowserProvider` usable. Underwriter and Relay must allow the browser's exact `FRONTEND_ORIGIN`.

After a timeout, use `PaymentError.handle` or the handle already saved by `onHandle`; `paid` exists only after a successful fetch. On restart, load that saved handle and call `resume` instead of calling `fetch` again.

## Payment and credit boundaries

| Entry or option | Meaning |
| --- | --- |
| `fetch(url, { body })` | No task: quotes use `taskId="0"` and require cash. A shortfall yields `CASH_REQUIRED`. |
| `forTask(taskId).fetch(...)` | Binds the provider request to a task. Cash is still used first; credit requires an underwriter and an eligible assigned task. |
| `maxPrice` | Maximum raw settlement-asset amount for **each provider payment**, not a cumulative session budget. |
| `onHandle(handle)` | Awaited persistence callback. A failure prevents the next payment action. |
| `beforePayment(handle)` | Awaited host budget/deadline guard before signing or submitting/rebroadcasting payment; may run multiple times. |
| `resume(handle)` | Reconciles the original payment and retrieves its original delivery. It keeps the request, quote and payment identity. |

Amounts use `BigInt` or decimal strings in raw asset units. On Tempo, PathUSD has 6 decimals: `120000` is `0.12` PathUSD. Native 18-decimal and mock-USDC modes are separate Anvil/legacy fixtures; Tempo does not expose a usable native balance through `eth_getBalance`. IDs use canonical decimal strings. Browser handles are JSON-serializable and do not contain the session private key.

The SDK checks both RPC and signer chain, Account settlement asset, current registry wallet, and a quote's chain/account/asset/provider/agent/task/service/model/tier/request digest/payment ID/price ceiling. A received 402 is therefore insufficient to select an arbitrary payment destination. Canonical request encoding and payment ID derivation live in [`src/protocol.ts`](src/protocol.ts).

The [contracts](../../contracts/README.md) are the final authority for policy, signature validity, identity version, LTV, vault liquidity and global limits. When cash is insufficient, the SDK refuses a task with **any existing loan record** using `TASK_ALREADY_BORROWED`; changing `creditNonce` cannot permit a second draw. Cash-only requests do not call the credit path, even when their provider quote is associated with a task.

One credit-backed request can purchase a [fixed-price multi-round solve](../pi-loop/FIXED_PRICE.md) or [prepaid inference package](../../docs/core-runtime.md). Internal rounds do not imply further per-round draws. The metered package implementation and consumption ledger are outside this SDK; the SDK pays for the bound package request.

## Durable recovery

[`PaymentHandle`](src/index.ts) records `version`, `relayUrl`, the original `input` and `quote`, `creditNonce`, and any submitted wallet `from`/`nonce`/transaction hash. Wallet mode also saves the publicly broadcastable signed raw transaction; browser mode records submission intent before `sendTransaction`. `onHandle` is awaited before broadcast, so the host can make that state durable. Without configured durable storage, application restart recovery is the caller's responsibility.

`resume` first queries relay status; before a payment attempt it checks the Account's original `paymentId`. A recorded chain payment is never paid a second time. Already delivered results return from cache, and `Refunded` is terminal. `UPSTREAM_FAILED`, `RELAY_UNAVAILABLE` or delivery-pending errors retain the same handle for reconciliation.

| Uncertain state | Recovery behavior |
| --- | --- |
| Saved Wallet transaction needs retransmission | Broadcasts only the **same signed bytes**, after expiry and nonce checks; it does not sign another payment. |
| Transaction is known and pending | Reports `PAYMENT_PENDING`; preserves the original handle. |
| Wallet nonce was consumed without a confirmed payment | Reports `PAYMENT_UNCERTAIN`; no replacement send. |
| Browser send may have happened but hash was lost | Keeps durable from/nonce intent; no second send. Relay chain-event discovery can reconcile the original payment. |
| Wallet explicitly rejects with `4001` / `ACTION_REJECTED` | Removes the unbroadcast submission intent and returns `WALLET_REJECTED`, permitting an explicit retry with the same handle. |
| Original payment has a canonical status-0 receipt | Persists the reverted receipt and returns `PAYMENT_REVERTED`; that handle will not sign or pay again. |
| Quote has expired | Does not sign or broadcast a new payment; the original handle can still reconcile confirmed payment or delivery. The contract separately enforces the credit authorization deadline. |

Canonical status-0 classification checks the receipt's block hash. Quote liveness checks both latest chain time and wall-clock time so a stalled local chain cannot authorize a late send. Within one client instance, concurrent resume calls for the same payment share work and wallet payment submissions are serialized. Separate clients sharing a wallet must coordinate their own nonce use.

The optional `beforePayment` guard is a host admission check, not a rollback of an already paid request. It may run repeatedly and should be idempotent. Confirmed payments and `Delivered` cache reads bypass new-payment admission, allowing result retrieval after a host deadline. See the [bounded Pi loop](../pi-loop/README.md) for durable budget reservation before pure-cash payment.

## Routing and attribution

To select one of a two-tier relay's configured routes, set `tier: "cheap"` or `"strong"` in the body. The SDK binds quote tier to the original request and applies the same `maxPrice`. An over-budget strong quote returns `UNTRUSTED_QUOTE` before saving a payment handle, obtaining credit or signing/submitting payment; the SDK does not silently change tier. Single-route coder requests may omit it.

The original quote and request remain in the handle. Delivery fallback and recovery keep the same payment ID and do not purchase a new quote. When an unpaid route is unavailable, a relay `deliveryError` stops payment. A paid route without a usable original snapshot can yield `ROUTE_UNAVAILABLE` or `ROUTE_SNAPSHOT_REQUIRED`; an already delivered cache remains retrievable. Refund availability is an operational Relay/Refunder decision, not an SDK-created transfer.

`receipt.model` identifies the Relay's configured physical route; `result.model` is the upstream's self-reported value. Neither establishes model provenance behind a gateway. The SDK trusts the configured relay's returned delivery metadata, while the [relay](../../services/provider-relay/README.md) verifies its payment proof against on-chain events. Independent review should inspect canonical receipts/events and Arena evidence for financial and task-result claims.

## Errors and reproducible checks

`PaymentError` contains a `code`, the recoverable `handle` when available and an optional `reason`. Contract custom errors such as `IdentityChanged`, `AuthExpired`, `NonceAlreadyUsed` and `SpendRejected` are decoded. `SpendRejected` reasons `1..5` identify provider admission, limits, freezing, authorization shape and authorization-agent mismatch. They are diagnostics, not proof that every concurrent invalid condition has a specified precedence.

From the repository root, with Node 22+, npm and Foundry on `PATH`:

```sh
npm ci
npm run typecheck
npm test --workspace @agentfuel/provider-relay
```

The SDK is exercised through the real local Relay and contracts, rather than a separate SDK mock-only suite:

- [`flow.test.ts`](../../services/provider-relay/test/flow.test.ts): SDK → 402 → Underwriter → four Anvil contracts → controlled upstream → receipt, including cash/credit, browser rejection/hash loss, restart, fallback, payment proof, refunds and persistence failures.
- [`tiers.test.ts`](../../services/provider-relay/test/tiers.test.ts): original cheap/strong quotes and routes survive recovery without changing payment identity.
- [`payment-guard.test.ts`](../../services/provider-relay/test/payment-guard.test.ts) and [`payment-reverted.test.ts`](../../services/provider-relay/test/payment-reverted.test.ts): host payment admission and canonical failed-transaction recovery.
- [`allowance.test.ts`](../../services/provider-relay/test/allowance.test.ts): one paid package, unchanged one-task draw limit and original-payment refund behavior.

These tests use local assets and controlled model responses. Later real-model and Monad acceptance has a separate [tracked record](../../docs/monad-hosted-acceptance-20261012.md); it does not turn each local test into proof of live deployment or standard x402 interoperability.

## 独立 Node.js 发行包

运行 `npm run pack:standalone --workspace @agentfuel/sdk -- --out-dir DIRECTORY` 生成只含编译 JS、类型和公开文档的本地 tarball；workspace 的 TypeScript exports 保持不变。`npm run test:sdk:standalone` 将包安装到独立临时 consumer，以离线缓存依赖运行类型、恢复、失败和单派发测试。不会发布 npm，也不执行真实付款。

Tempo 使用可信部署配置和当前已验证 signer/provider；不要从报价、模型输出或示例地址推定真实部署。现金、授信和链费上限必须由调用方分别设置；独立打包保留当前 typed control、beforeDispatch、Unknown handle 和不二派发行为。
