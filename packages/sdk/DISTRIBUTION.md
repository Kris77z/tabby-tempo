# @agentfuel/sdk standalone distribution

This local tarball contains compiled ESM JavaScript and TypeScript declarations for `@agentfuel/sdk` and `@agentfuel/sdk/protocol`. It runs on Node.js 22+ without a workspace, TypeScript loader, or repository source. `ethers` is an npm dependency. Version `0.0.0` identifies this development distribution, not a published release; the package remains private.

```js
import { InferCredit, PaymentError } from "@agentfuel/sdk";
import { requestDigest, paymentId } from "@agentfuel/sdk/protocol";
```

`InferCredit` buys services through Tabby's own bound 402/receipt protocol. Standard x402 facilitator compatibility has not been validated. The SDK does not publish tasks, evaluate task correctness, independently verify model identity, settle Arena results, or prove a complete earning/repayment cycle.

Supply exactly one ethers `signer` or `sessionKey` plus `rpcUrl`, and caller-trusted `chainId`, `account`, `asset`, `provider`, `agentId`, and `maxPrice`. Never infer trusted deployment bindings from a received quote. A configured signer can spend funds; keep session keys, authenticated RPC URLs, request/result data, and recovery journals private.

`fetch(url, { body })` uses cash with task ID `"0"`. `forTask(taskId).fetch(...)` binds an assigned task and can request underwriter credit for a cash shortfall. Contract policy remains authoritative. IDs and quote amounts are canonical decimal strings; option `chainId` and `maxPrice` are bigint. For a six-decimal asset, `10000n` means `0.01` units. `maxPrice` limits each payment; hosts must enforce their own cumulative budgets, concurrency and deadlines, using an idempotent `beforePayment` guard when appropriate.

Persist every `onHandle` callback durably before returning. It may contain original request content and publicly broadcastable raw signed transaction bytes. On timeout or restart, load that original handle and call `resume(handle)`, rather than purchasing a new quote with `fetch`. `PaymentError.handle` is available after many recovery failures. Keep the original input, quote, relay route, payment ID, nonce, and submission together. Do not edit an uncertain handle or replace a payment. `close()` destroys only an RPC provider created by the SDK.

The [source SDK guide](https://github.com/Kris77z/tabby/blob/main/packages/sdk/README.md) documents API, authorization, units, and recovery boundaries. The [standalone example](https://github.com/Kris77z/tabby/tree/main/examples/sdk-standalone) includes a runnable loopback-only smoke check and an explicitly invoked real-client template. The default example uses controlled responses and blocks every new payment; it does not establish a chain payment, real inference, Arena acceptance, or outside-team adoption.
