# Hosted Agents

This guide is adapted for **Tabby Tempo**. The running deployment is Tempo Moderato `42431`, with **PathUSD** (`0x20c0000000000000000000000000000000000000`, 6 decimals) for settlement and fees. The sole production writer is `https://tempo.tabbyai.xyz`. Its first automatic release on 2026-10-14 deployed main `40647f0dc9f966bbbe98bf3e474cfbe612c0ffa8` after [PR #1](https://github.com/Kris77z/tabby-tempo/pull/1), through [Actions 38544850009](https://github.com/Kris77z/tabby-tempo/actions/runs/38544850009). The [2026-10-15 migration](../../docs/tempo-upstream-sync-20261015.md) records the following additions and controlled checks; deployment results follow current main Actions and the release records in the [CI/CD runbook](../../deploy/tempo-vps/cicd/README.md).

Local launch examples below are for a **new isolated Anvil fixture only**, with synthetic roles, fresh private directories and controlled inference. Never load or restart the archived local Tempo runtime, reuse its journals, or start another writer beside the VPS. Monad/MON/USDC examples and dated results are explicitly source-project history or offline fixture semantics, not current Tempo configuration or new acceptance. See [Tempo verification](../../docs/VERIFICATION.md).


`@agentfuel/hosted-agents` owns authenticated Agent configuration, local wallet custody, budget reservations, durable runs and safe public status. Its executors support two different economic paths: escrow-backed programming tasks that can earn and repay, and cash-funded personal goals that produce artifacts. The [architecture guide](../../docs/ARCHITECTURE.md) explains payment, verification and trust boundaries; [verification](../../docs/VERIFICATION.md) indexes reproducible checks.

## Follow a request

The browser uses the same-origin `/api/hosted/*` proxy. [HTTP routes](src/http.ts) authenticate the bearer session before passing the owner to [HostedService](src/service.ts); callers cannot supply another owner, a private key or arbitrary provider/RPC endpoints. Login signs a nonce/origin/chain/expiry challenge. The service generates a separate hosted wallet, stores its key locally with restricted permissions and binds Agent operations to the authenticated owner.

Creation may start with only a name; execution waits for provisioning and confirmed settings. Requests bind their UUID and original parameters, reserve the configured budget and retain one active run per Agent. Replaying the same UUID recovers that run. Interrupted runs become `Paused`, retaining unresolved reservations. The platform owns the hosted signer; user configuration and contract policy bound its execution, but this is not self-custodial session-key access.

| Path | Main implementation | Acceptance and accounting |
| --- | --- | --- |
| `task`, `reward-task`, `metered-task` | [Task executor](src/task-executor.ts), [Pi workflow](../../packages/pi-loop/src/workflow.ts) | Catalog selection/acceptance, bounded Pi tools, separate hidden Docker tests and a separate settler. Canonical `TaskSettled` and task/loan state support success, repayment and income. |
| `autonomous` | [Autonomy executor](src/autonomy-executor.ts), [bounded controller](../../packages/pi-loop/src/autonomy.ts) | Paid cash-only planning validates model/funding/time/task/spend limits. `run-game` requires explicit game configuration and admission, using the existing game executor and original child identity; games are disabled by default. |
| `goal` | [Goal executor](src/goals/executor.ts), [commander](src/goals/commander.ts), [paid calls](src/goals/payment.ts) | 1–3 specialist phases, a separate reviewer call, at most one revision and re-review. All calls use cash with `taskId=0`; no escrow income, loan or reputation increment. |
| `game`, `credits` | [Game executor](src/game-executor.ts) | Explicit user-requested supported rewards/consumption. Practice games and unsuccessful reward outcomes do not become real reward credits. |

Goal planning, specialists and reviewer are separate calls. The mission freezes its approved model directory and persists each call's actual route. Before a new purchase, a cheaper approved route may be selected while reserving cash for remaining phases and review. A saved payment handle or signed intent keeps its original route, request and recovery identity; an Unknown cannot trigger a replacement purchase. Old single-route journals retain their original route. The reviewer is a model check, not Docker execution or a general fact oracle. [Hard acceptance checks](src/goals/acceptance.ts) enforce supported measurable constraints. The [specialist catalog](src/specialists/catalog.ts) defines built-in roles and output contracts; [bounded chain lookup](src/goals/chain-lookup.ts) optionally supplies pinned Tempo/Anvil and explicitly labeled legacy source evidence. Goal models have no arbitrary web, filesystem, shell, deployments or fund-transfer tools.

The [external registry](src/external/registry.ts), [hiring](src/external/hiring.ts) and [service wrapper](src/external/service.ts) add operator-approved services, not open recruitment. Registry and identity advertisements must match configured endpoint, service, model, provider and price. Configured chain identity and filtered reputation are read at a pinned block and rechecked; registry ratings remain labeled as registry data. The paid result binds the assigned work, prompt, service provenance and canonical payment. Metadata reads are bounded and reject redirects; malformed wrapper URLs return HTTP 400. Production has no approved external provider/registry binding: this path is unconfigured and disabled by default, with no imported Monad identity.

## Prices and recovery

Goals and task-planning calls use a fixed operator price per invocation. `metered-task` instead buys a task-bound allowance package, then [the gateway](src/inference-gateway.ts) reserves and settles microcredits at each model's input/output token rates through Magpie. [The metered adapter](src/metered-task.ts) verifies the paid grant, catalog binding and original task before consumption. Cash, loan principal/fees and inference credits are separate units.

The host saves payment handles and dispatch intents before crossing payment/model boundaries. Unknown outcomes retain their original UUID, payment and reservations; they pause rather than creating replacements. A cached response can be reused without paying again. [Goal reconciliation](src/goals/reconciliation.ts) requires canonical payment/refund evidence and the original call route; cancelling a goal does not erase an unresolved payment. The [SDK redirect safeguard](../../packages/sdk/src/index.ts) rejects HTTP redirects so a paid request cannot silently move to another endpoint. [SessionStore](../../packages/pi-loop/src/session.ts) uses atomic snapshots and a single local writer with explicit stale-lock recovery.

[Finance reads](src/finance-reader.ts) and [public activity types](src/scene-types.ts) expose checked snapshots and whitelisted evidence. Activities are executor-generated, persisted with increasing sequence numbers and capped at 256 per run. Frontend motion is a view of those facts, not a mechanism for deciding that an operation succeeded.

## Run and inspect

See the [Chinese configuration/API runbook](../../docs/hosted-agents.md), [Tempo runtime](../../docs/tempo-runtime.md) and [VPS startup guide](../../deploy/tempo-vps/README.md). Runtime configuration, journals, keys and raw model evidence belong in private ignored directories.

From the repository root, with Node 22.23.2+, cached Foundry/solc and the documented Docker dependencies available:

```sh
npm test --workspace @agentfuel/hosted-agents
npm run typecheck:all
```

Source-level checks include [owner/API isolation](test/http.test.ts), [paid goal execution](test/goals-paid.test.ts), [goal reconciliation](test/goals-reconciliation.test.ts), [metered recovery](test/metered-recovery.test.ts), [credit reservation/unknown freeze](test/inference-gateway.test.ts), [autonomy](test/autonomy-executor.test.ts) and [public scenes](test/scenes.test.ts). The 2026-10-15 migration adds [paid fallback recovery](test/goals-model-fallback-paid.test.ts), [model selection](test/model-fallback.test.ts), [external hiring](test/external-hiring.test.ts), [pure HTTP wrapper checks](test/external-service-http.test.ts), [SDK redirects](test/sdk-redirect.test.ts) and [owned autonomous-game fixtures](test/autonomy-game-live.test.ts). These controlled checks do not establish production provider availability, approve new games or renew the expired grant. [Earlier goal validation and read-only Tempo probes](../../docs/tempo-upstream-sync-round2-20261013.md) retain their own scope; no new paid Tempo goal acceptance is claimed. This application migration does not modify the root-owned deployment engine.

### Read-only economic projections

Owner-authenticated `accounting`, `strategy-advice` and `operating-report` routes project bounded retained journals. Preview POSTs are hypothetical reads; they do not dispatch, sign, recover or alter policies. All three report PathUSD for42431, including unbound Agents. Missing chain fees and supplier costs do not become zero; settlement contribution is not full net profit. See [review](../../docs/REVIEW.md) and [operating scope](../../docs/OPERATING-REPORT.md).
