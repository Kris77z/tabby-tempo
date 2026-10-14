# Tabby protocol contracts

This guide is adapted for **Tabby Tempo**. The running deployment is Tempo Moderato `42431`, with **PathUSD** (`0x20c0000000000000000000000000000000000000`, 6 decimals) for settlement and fees. The [VPS runbook](../deploy/tempo-vps/README.md) describes the sole production writer at `https://tempo.tabbyai.xyz`; this documentation/code update has not been deployed.

Local launch examples below are for a **new isolated Anvil fixture only**, with synthetic roles, fresh private directories and controlled inference. Never load or restart the archived local Tempo runtime, reuse its journals, or start another writer beside the VPS. Monad/MON/USDC examples and dated results are explicitly source-project history or offline fixture semantics, not current Tempo configuration or new acceptance. See [Tempo verification](../docs/VERIFICATION.md).


Four Solidity contracts turn a funded task into a bounded compute budget: an agent spends its own cash first, can borrow the shortfall against the task's escrowed reward, and repays when the independent task verifier accepts its output. Borrowed funds go directly to an admitted provider through `AgentAccount`; they are not credited to the agent's withdrawable cash balance.

The contracts implement the financial state machine. The [Arena](../services/arena/README.md) runs task checks, the [underwriter](../services/underwriter/README.md) signs credit terms, and the [SDK](../packages/sdk/README.md) coordinates provider payment and recovery. The verifier and underwriter remain trusted services; a contract does not evaluate code or verify a model's reasoning.

The deployed protocol keeps the original `InferCredit` EIP-712 domain and `infercredit` reputation tag. Those identifiers are part of the signing and feedback format and are not renamed with the product.

## Contract map

| Contract | Responsibility | Important boundary |
| --- | --- | --- |
| [`ERC8004Adapter`](src/ERC8004Adapter.sol) | Live registry owner/wallet lookup, versioned identity snapshots, filtered reputation reporting | Registry ownership and wallet binding authorize actions. A snapshot version binds credit to the identity that was reviewed. |
| [`AgentAccount`](src/AgentAccount.sol) | Per-agent cash, owner spend policy, protocol freeze, provider admission, payment/refund records | A singleton ledger, not an account factory. Only the current registry wallet pays providers; only the current owner changes its policy. |
| [`CreditManager`](src/CreditManager.sol) | Treasury vault, task-bound draw, repayment, liquidation, refund recovery, global limits | Only `AgentAccount` can draw. A task can open one loan in its lifetime, including after repayment or refund closure. |
| [`TaskEscrow`](src/TaskEscrow.sol) | Fund/assign/cancel/expire tasks and settle the reward waterfall | The configured verifier supplies the outcome. Funds settle atomically; external reputation reporting is retried separately. |

Interfaces define structs, enums, events and custom errors in [`src/interfaces`](src/interfaces). The implementation specification is [ENGINEERING v5.3 §4](../AGENT_CREDIT_ENGINEERING.md); economic assumptions and scoped risks are in [RISK_AND_MVP](../AGENT_CREDIT_RISK_AND_MVP.md). Later hosted execution and prepaid compute packages use this same one-draw protocol; see [core runtime](../docs/core-runtime.md).

## Task and payment lifecycle

1. **Fund and accept.** A poster escrows a nonzero reward with a future deadline. Creation snapshots the protocol fee rate. Only the agent's current registry wallet may accept an `Open` task before that deadline. The poster may cancel an unassigned task for a full refund.
2. **Buy compute.** `payProvider` checks the current wallet, admitted provider, owner policy, freeze flags and unused `paymentId`. It spends cash first. A shortfall requires a task-bound underwriter authorization and a successful `CreditManager.draw`. The cash debit, loan, nonce consumption, payment record and transfer to the provider occur in the same transaction; a failed transfer reverts them all.
3. **Verify and settle.** The configured verifier calls `settle(taskId, passed)`. On success, the task's snapshotted protocol fee is paid first, then active principal plus fee, then the residual reward is credited to agent cash. A cash-only or `ClosedByRefund` task skips repayment and cannot create a repayment count.
4. **Record history.** Successful full repayment increments the Manager's own repayment counter. The Adapter attempts `task-success` and, when appropriate, `repayment` feedback. Registry failure leaves pending feedback for an idempotent retry and does not undo the financial result.

`TaskEscrow` moves from `Open` to `Assigned`, then to `Settled` or `Failed`; cancellation is possible only while `Open`. The state machine rejects repeated settlement. Loan states are `None → Active → Repaid / Defaulted / ClosedByRefund`, with no reopening or second draw. Additional cash payments can still be made subject to policy; a new nonce does not permit another loan for the same task.

## Credit invariants

`CreditManager.draw` enforces I1–I7 in [source](src/CreditManager.sol) and [tests](TEST_PLAN.md):

| Check | Enforced rule |
| --- | --- |
| Protocol controls | Draws are not paused; the agent is not protocol-frozen. |
| Authorization | A strict EIP-712 signature belongs to the configured underwriter, the nonce is unused, and `now <= authDeadline`. Nonces form a consumed set, not a monotonic sequence. |
| Identity | Live owner/wallet still match the approved snapshot, and `identityVersion` matches. Reapproval increments the version and invalidates old authorizations. |
| Task | The task is `Assigned` to this agent, and `now < task.deadline`. |
| Single draw | The task's loan status is `None`. A closed or defaulted loan record still blocks a second draw. |
| Escrow coverage | Actual principal does not exceed the signed cap. The **cap including its fee**, rather than only the actual draw, must fit the configured LTV of reward net of the task's snapshotted protocol fee. |
| Liquidity and limits | The vault has enough lendable funds; total principal plus fee fits the global outstanding limit, and newly drawn principal fits the daily epoch limit. |

The Account adds the owner's per-transaction cash limit, per-transaction credit limit and daily credit limit. Refunds do not restore the epoch draw budget. Backstop funds are accounted separately and never counted as lendable vault funds.

## Failure, refunds and recovery

An unsuccessful verifier result with an active loan triggers liquidation. Failed or expired tasks with no loan, or a `ClosedByRefund` loan, return their full remaining escrow to the poster without liquidation. Anyone may expire an `Open` or `Assigned` task after its deadline; an active loan can also be liquidated when the task is expired **or** `loanDueAt + GRACE` is passed. The grace period applies to the loan-due branch, not as a new task deadline. There is no separate verifier window after expiry: settlement and expiry are resolved by transaction order.

The two liquidation entry paths avoid a circular callback: Escrow terminates the task before pushing funds to Manager; the Manager-initiated pull uses `releaseForLiquidation`, which never calls back into Manager. The project-owned `ReentrancyGuard` and explicit transfer flow are exercised by active reentrancy and rollback tests, not only by successful EOA transfers.

Liquidation uses **agent cash → task escrow → agent backstop → recorded treasury loss**, refunding unused task escrow to the poster. It marks the loan `Defaulted`, increments the default counter and protocol-freezes the agent even if the monetary loss is zero. With LTV at most 100%, an intact escrow, stable snapshotted fees and a normally behaving settlement asset, the first two layers cover the debt. The task poster nevertheless bears escrow slashing exposure. Tests that reach deeper loss layers use explicitly isolated overleveraged harnesses, not production deployment parameters.

Only the configured `relayRefunder` can return provider funds through `processRefund`. A unique `refundId` and the original payment record cap cumulative refunds at the amount actually paid. Cumulative proportional arithmetic preserves the cash/credit split across installments:

| Loan state | Refund result |
| --- | --- |
| `Active` | Reduces the credit principal and proportional fee; uncollected fee is forgiven, and eligible previously collected fee can return to cash. Zero remaining debt closes the loan as `ClosedByRefund`, including integer-rounding boundaries. |
| `Repaid` | Refund funds go to agent cash; already settled principal is not repaid again. |
| `Defaulted` | Restores **treasury loss → backstop → poster escrow → agent cash**, capped by each original burden less prior recovery. Original liquidation records remain available. |
| `ClosedByRefund` | Further refunds go to cash with any additional eligible collected-fee return. The task cannot draw again. |
| `None` / pure cash | Credits the agent recorded on the payment, with no credit or reputation side effect. |

Refund closure and recovery never count as successful repayment. An active-loan refund does not itself finish the task or return its reward escrow; task settlement or expiry remains a separate transition. P0 has no automatic backstop refill. Owner policy updates cannot clear protocol freezes, and guardian unfreezing does not erase defaults or refresh identity snapshots.

## Assets, units and trust assumptions

All amounts are integer **raw settlement-asset units**, not display decimals. A deployment uses one immutable settlement asset across Account, Manager and Escrow:

- Tempo selects the explicit PathUSD token address above, with 6 decimals and `msg.value == 0`. Native-mode fixtures use `address(0)` and 18 decimals; Tempo deployments reject the zero asset.
- Token-mode incoming calls require exact allowance and `transferFrom`. Tempo `120000` means `0.12` PathUSD; mock-USDC fixtures are distinct historical/local deployments.
- Fees and LTV use basis points with denominator `10000`. Fees are charged on actual drawn principal; collateral coverage is checked against the signed principal cap.

`SafeTransferLib` supports standard ERC-20 returns and tokens with no return value. The accounting assumes transfer amounts arrive intact; it does not implement fee-on-transfer or rebasing-token accounting.

P0 uses a protocol treasury, an owner-controlled provider whitelist, one underwriter signer, guardian controls and a configurable verifier. It is not a permissionless lending pool or a trustless compute oracle. Provider admission is the purpose-of-credit boundary: on-chain payment proves an admitted address received funds, while the relay is responsible for delivery and operational refunds. The deployment has no proxy upgrade system or public LP interface.

## Reproduce the contract checks

Requirements: Foundry on `PATH`. [`foundry.toml`](foundry.toml) pins Solidity `0.8.24`, EVM `cancun`, optimizer with 200 runs and 256 fuzz runs.

```bash
cd contracts
forge build --sizes
forge test
forge test --match-path test/AbiConformance.t.sol -vv
forge test --match-path test/Atomicity.t.sol -vv
forge test --match-path test/RefundSafety.t.sol -vv
forge test --match-contract Erc20
```

The default suite is offline and uses native/ERC-20 fixtures with mock registries. [`TEST_PLAN.md`](TEST_PLAN.md) indexes identity rotation, exact error gates, real-balance conservation, payment rollback/reentrancy, liquidation, installment refunds, deployment limits and reputation failures. Its 2026-10-01 baseline recorded 408 tests: 404 passed and 4 asset-specific skips; run the commands above for the current checkout.

[`AbiConformance.t.sol`](test/AbiConformance.t.sol) compares literal ERC-8004 signature selectors rather than allowing an interface and mock to drift together. [`spike/Day0Canonical.t.sol`](spike/Day0Canonical.t.sol) separately exercises the canonical Monad testnet registries at a fixed block; the exact explicit fork command and the scope of that result are in [Day-0 findings](../docs/day0-findings.md). The protocol consumes filtered feedback **counts**, not the registry's unspecified aggregate `summaryValue`.

There are also local HTTP integration checks using the real four contracts in the [underwriter](../services/underwriter/README.md) and [provider relay](../services/provider-relay/README.md). Later Monad and real-model acceptance is documented in [the 2026-10-12 record](../docs/monad-hosted-acceptance-20261012.md); offline mocks alone do not establish that result.

## Tempo deployment and recovery

The recorded four-contract deployment and its roles are in [Tempo runtime](../docs/tempo-runtime.md) and [VPS deployment](../docs/tempo-vps-deployment-20261013.md). This update deploys nothing. [`Deploy.s.sol`](script/Deploy.s.sol) validates the asset/network pair and role/registry wiring; do not use the historical Monad environment template for Tempo. A new deployment needs a separate explicit configuration, roles and journals.

Tempo transaction fees use PathUSD separately from business transfers. A receipt can contain both fee and reward/payment `Transfer` events; canonical checks identify the emitter, direction and exact amount rather than treating every token event as the business payment.
