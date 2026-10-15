# Tabby Tempo architecture

Tabby has two economic paths: earning from escrow-backed programming tasks and spending cash on personal goals. The current deployment is Tempo Moderato `42431`; PathUSD (`0x20c0000000000000000000000000000000000000`) is the 6-decimal settlement and fee token. The VPS is the sole writer. On 2026-10-14, main `40647f0dc9f966bbbe98bf3e474cfbe612c0ffa8` shipped after [PR #1](https://github.com/Kris77z/tabby-tempo/pull/1) through [the first automatic release](https://github.com/Kris77z/tabby-tempo/actions/runs/38544850009). The [2026-10-15 migration](tempo-upstream-sync-20261015.md) records additional capabilities and controlled checks; deployment results follow current main Actions and release records.

## Two economic paths

| | Escrow-backed tasks | Cash-funded goals |
| --- | --- | --- |
| Actions | `task`, `reward-task`, `metered-task`; `autonomous` starts bounded child tasks | `goal` |
| Funding | Cash, explicitly permitted task credit, or supported reward credits | Every planner/specialist/reviewer/revision call uses `taskId=0`, cash only |
| Execution | Catalog task, bounded Pi Python/public-sample tools | 1–3 sequential specialist phases; optional fixed-block chain evidence; external path requires approved service bindings and is disabled by default |
| Acceptance | Separate hidden Docker Arena and separately authorized settler; host verifies canonical receipts and task/loan state | Separate model review and deterministic supported hard checks; at most one revision/re-review |
| Result | Protocol fee, active principal/fee repayment, residual cash and applicable reputation | Artifact, review and confirmed cash spending/refunds; no task reward, loan or repayment reputation |

The [autonomous controller](../packages/pi-loop/src/autonomy.ts) permits bounded task selection and stopping. `run-game` and resource recovery require explicit game configuration and host admission; games are disabled by default. The controller reuses the existing identity-bound game executor and persists the original child. No new default grants a saved session more games, decisions, spending or time. Owned fixtures validate this behavior; they do not authorize production games or revive expired sponsorship.

The [goal commander](../services/hosted-agents/src/goals/commander.ts) selects configured analysis roles; it cannot add tools, providers, permissions or budgets. A mission freezes its approved model directory and persists each call's actual route. A new unpaid call may downgrade within that directory while reserving cash for remaining phases and review. Existing paid handles and signed intents retain the original route and resume identity; old journals retain their single route. Planning, specialist work and review remain separate calls. Review does not imply a different organization, factual oracle or code execution.

## Payment and units

| Service | Mechanism | Implementation |
| --- | --- | --- |
| Ordinary fixed-price Relay | Cash-only per-call goal/planner payments with recorded model usage | [SDK](../packages/sdk/README.md), [Relay](../services/provider-relay/README.md) |
| Fixed-price solver B | One task-bound purchase supports a bounded internal Pi loop | [Fixed-price specification](../packages/pi-loop/FIXED_PRICE.md) |
| Allowance + metered gateway | One task-bound purchase grants microcredits; calls reserve and settle token-rate usage | [Allowance](../services/provider-relay/src/allowance.ts), [gateway](../services/hosted-agents/src/inference-gateway.ts) |
| Reward credits | Trusted game replay grants credits to the actual winner, consumed without an automatic cash purchase | [Reward ledger](../services/arena/src/inference-rewards/README.md) |

Contract amounts are raw PathUSD units (`120000 = 0.12`); principal/fee, package microcredits, token usage and supplier billing are distinct. Borrowed funds go directly to an admitted provider, never to withdrawable Agent cash. Each task permits one loan in its lifetime, including after refund closure. Tempo `eth_getBalance` is a native placeholder and is not a usable native asset balance; fee evidence matches fee-token/payer/manager events separately from business transfers and reports ambiguity honestly.

## Durable execution and recovery

[HostedService](../services/hosted-agents/src/service.ts) authenticates the owner, binds original UUID/parameters and reserves the configured budget with one active run per Agent. Name-only creation does not permit execution before settings/provisioning. The platform holds the hosted signer; current wallet policy and live registry identity constrain it.

The SDK persists handles and signed transaction intents before payment. Executors persist model dispatch intent and response state; `Unknown` pauses with the original handle, UUID and reservations, rather than buying another call. Cached delivery is reused. Cancellation does not erase an unresolved signed payment. [Reconciliation](../services/hosted-agents/src/goals/reconciliation.ts) and [nonce voiding](../services/hosted-agents/src/goals/void-payment.ts) verify original binding, canonical payment state and fee preference before eligible recovery. Expiry alone does not prove a signed transaction cannot execute.

Only verified canonical delivery charges enter confirmed accounting. If a public activity callback fails after payment confirmation, the charge is durably retained even before response projection; recovery consumes the original cached result and does not repay or redispatch. The [2026-10-14 tests](tempo-upstream-sync-root-acceptance-20261014.md) established this boundary on isolated Anvil, not through a new paid Tempo goal. The SDK HTTP client uses `redirect: "error"` so payment and recovery requests cannot silently follow another endpoint.

[AgentAccount](../contracts/src/AgentAccount.sol), [CreditManager](../contracts/src/CreditManager.sol) and [TaskEscrow](../contracts/src/TaskEscrow.sol) enforce payment, single-draw and settlement invariants. Refund state depends on loan status; `ClosedByRefund` is not repayment/default. Financial settlement and best-effort [ERC-8004 feedback](../contracts/src/ERC8004Adapter.sol) are separate: pending feedback remains retryable and does not undo settlement.

## Authority and evidence

The browser uses a same-origin, owner-scoped [proxy](../frontend/lib/hosted-agents-proxy.ts). Origin/session/trustProxy validation and public field projection exclude private paths, keys, signed bytes, raw prompts and secret RPC configuration. The supervisor keeps dedicated task/planner/goal routes and a common signer guard; storage is single-writer, not a distributed database.

Pi task tools can run public samples; hidden Docker inputs and verifier keys stay with separate Arena/settler roles. The [Docker permission fix](../services/arena/src/docker.ts) explicitly makes the sole read-only submission file readable by the sandbox UID under service `umask 0077`; keys, journals and hidden tests are never added to that mount.

Built-in specialists are input-analysis roles, not independently registered Agents with current onchain scores. The [external registry](../services/hosted-agents/src/external/registry.ts) admits only operator-configured endpoint, service, provider, model and price bindings. Advertisements and service identity must match; configured chain identity/reputation uses pinned, rechecked blocks and filtered clients/tags. Registry ratings retain their source label. [Hiring](../services/hosted-agents/src/external/hiring.ts) binds task context, prompt, service provenance and the canonical paid result. Bounded metadata reads reject redirects, and the HTTP wrapper rejects malformed URLs with 400. There are no approved production external provider/registry bindings, so external hiring remains unconfigured and disabled by default; source Monad identities are not imported.

[Bounded chain lookup](../services/hosted-agents/src/goals/chain-lookup.ts) pins reads, limits response/source data, binds Sourcify chain/address and bytecode, and rechecks blocks; missing evidence remains unknown. It is not arbitrary Web browsing, tracing, simulation or live yield discovery.

[Public activity events](../services/hosted-agents/src/scene-types.ts) are whitelisted, persisted with sequence/time and capped at 256 per run. [Scene projection](../frontend/lib/tabby-scenes.ts) and [mission chat](../frontend/components/hosted/mission-chat.tsx) display facts, separate cost from progress, freeze history/Unknown/disconnection and respect reduced motion. Animation cannot manufacture payment, reward, success or reputation. Old terminal runs need no invented events to render their original public results.

## Operating scope

Production facts and recovery are in the [VPS runbook](../deploy/tempo-vps/README.md) and [CI/CD runbook](../deploy/tempo-vps/cicd/README.md). PR and main push use the same `Offline checks`; only successful main CI can enter the main-only production environment. This application migration does not modify the root-owned deployment engine or change Tempo Origin, fee/nonce recovery policy or the existing contracts. Local development must use fresh isolated Anvil/synthetic directories and controlled inference, never the archived local Tempo runtime or a second writer beside the VPS. The expired game sponsorship retains its original digest/admissions/expiry; it is not renewed by a code upgrade.

The product does not provide open expert recruitment, arbitrary subtask publishing, arbitrary goal shell/file/wallet tools, public LP lending or universal fact verification. External hiring and autonomous-game additions have owned-fixture evidence only. [Verification](VERIFICATION.md) distinguishes actual Tempo history, read-only probes, controlled payments and synthetic UI; code availability alone does not prove production activation or paid Tempo acceptance.
