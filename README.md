# Tabby — AgentFuel Tempo

[中文](README.zh-CN.md) · [Architecture](docs/ARCHITECTURE.md) · [Verification](docs/VERIFICATION.md) · [Attribution](docs/ATTRIBUTION.md)

**[Pitch · 49 seconds](https://youtu.be/pOUE6yWpGg4)**

https://github.com/user-attachments/assets/da18320d-eea4-45c6-9d01-be43866f0041

[Platform demo · Monad recording · 1m 51s](https://youtu.be/Hgs1R7LrMZU)

Tabby gives hosted AI agents task-backed credit to buy inference, complete verifiable work, repay financing and build financial reputation. Agents can also pursue cash-funded personal goals through bounded specialist work and separate review.

The application runs at **[tempo.tabbyai.xyz](https://tempo.tabbyai.xyz)** on **Tempo Moderato (42431)**. Settlement and transaction fees use **PathUSD** (`0x20c0000000000000000000000000000000000000`, 6 decimals). The VPS is the sole running writer; the former local Tempo runtime remains stopped. On 2026-10-14, [PR #1](https://github.com/Kris77z/tabby-tempo/pull/1), main `40647f0dc9f966bbbe98bf3e474cfbe612c0ffa8`, completed [CI and the first automatic production release](https://github.com/Kris77z/tabby-tempo/actions/runs/38544850009): request `392d85033d864284b69e5df1561dc26d` succeeded with BUILD_ID `4Uxx0OqThhQlKBo4D8gK0`. Subsequent deployment results follow current main GitHub Actions and the release records described in the [CI/CD runbook](deploy/tempo-vps/cicd/README.md); [initial deployment history](docs/tempo-vps-deployment-20261013.md) retains its date.

The [2026-10-15 controlled migration](docs/tempo-upstream-sync-20261015.md) adds bounded model downgrades, external-specialist bindings and optional autonomous games, plus Docker permission and SDK redirect safeguards. Validation uses owned fixtures, controlled models and isolated Anvil; it is not new paid Tempo acceptance. Production has no approved external provider/registry binding, so external hiring remains unconfigured and disabled. The earlier [scene/chat migration](docs/tempo-upstream-sync-20261014.md), [Dashboard/goals](docs/tempo-upstream-sync-20261013.md) and [Tempo lookup/payment recovery](docs/tempo-upstream-sync-round2-20261013.md) retain their dated evidence.

## Verified Tempo paths

Independent acceptance recorded **five credit-funded tasks and two reward-funded tasks**, using real Kimi inference, Pi execution and Docker hidden tests. All six participating agents ended debt-free at the recorded acceptance blocks. These are dated historical results, not a promise about current balances or every new code path.

- [Core acceptance](docs/tempo-root-acceptance-20261012.md): two model tiers and a new autonomous Agent completing two tasks in one unchanged 0.30 PathUSD budget/window, spending 0.26 and reaching score 640 / Tier B.
- [GameFi reward paths](docs/tempo-gamefi-extra-root-acceptance-20261013.md): Task 7 used a real 0.10 PathUSD prize plus the separately recorded 0.02 predeposit; Task 8 consumed 295 of 4096 reward tokens. Each settled 0.15 PathUSD with no loan. Four of six authorized extra games were used; that grant expired and is not reusable.
- [Failures and compensation](docs/evidence/tempo-20261012/financial-evidence.json): two provider Unknowns retain their original history. Operator-funded compensation is not repayment, default or a claim of zero supplier cost.

The [verification guide](docs/VERIFICATION.md) connects these claims to public evidence. Source Monad/Anvil reports, legacy USDC fixtures and logo explorations are not Tempo acceptance.

## Product and boundaries

Users sign in with a wallet, create an Agent using only a name, then configure its supported model, strategy and bounded spend before execution. The platform holds the separate hosted wallet; the current custody model is not a self-custodial session-key protocol. Budgets authorize spending and are separate from deposits.

| Path | Actual behavior |
| --- | --- |
| Escrow-backed tasks | Buy fixed-price or task-bound metered inference; explicitly allowed shortfalls can borrow against escrow. Pi has bounded public-sample tools; separate Docker Arena and settler determine settlement. |
| Autonomous tasks | A paid cash-only planner chooses supported tasks or stops, within task/decision/spend/time limits. Games require explicit configuration and admission and are disabled by default; the planner cannot add providers, tools, budgets or permissions. |
| Personal goals | Planner, sequential specialists and separate reviewer calls spend cash with `taskId=0`; no loan, task income or repayment reputation. Built-in specialists analyze supplied data and optional bounded chain evidence. External hiring requires operator-approved bindings and is disabled by default. |
| Games | Hosted sponsored Holdem may award PathUSD or Agent-bound inference credits to the actual winner. Four practice games are local exercises without onchain rewards. |
| Scenes and chat | Recorded public events drive motion and traces. History, disconnection, pause and Unknown remain visibly distinct from confirmed delivery. |

Before a new goal purchase, a call may select a cheaper approved model while reserving cash for remaining work and review. Existing paid handles, routes and Unknown outcomes retain their original recovery binding. External assignments bind the approved service, provider, model, price and provenance; registry ratings and verified onchain reputation are identified separately. Neither feature grants open provider recruitment.

Task income, cash, credit principal/fees, inference microcredits and supplier usage are different quantities. `120000` raw PathUSD means `0.12` PathUSD; a provider quote is not the supplier's bill. Model review is not Docker execution or a factual oracle. General web tools, arbitrary shell/file access for goals, public LP lending and standard x402 facilitator compatibility are not claimed. The expired game grant is not renewed by this code, and the root-owned deployment engine is outside this application migration.

## Isolated development

Use Node **22.23.2**, npm and Foundry; controlled Arena tests also require Docker and the pinned cached Python image. Install dependencies in this checkout, then choose checks appropriate to the change:

```sh
npm ci
npm run typecheck:all
npm run docs:check
# Unit/integration suites create fresh Anvil fixtures with synthetic keys.
npm test --workspace @agentfuel/hosted-agents
forge test --root contracts --offline
```

For a UI preview, use a dedicated port and synthetic state. **Do not load the old private Tempo manifest, keys or journals, start the old runtime, or create a second production writer.**

```sh
# New isolated synthetic preview only; no hosted backend or real chain.
FRONTEND_MODE=fixture HOSTED_AGENTS_URL=http://127.0.0.1:1 \
  npm run dev --workspace @agentfuel/frontend -- --hostname 127.0.0.1 --port 3038
```

The browser harness mocks authenticated APIs and never connects a real owner or provider. See [frontend checks](frontend/README.md#local-visual-and-test-checks) and [contribution rules](CONTRIBUTING.md). A `FIXTURE` preview does not prove chain settlement. Live execution, nonce replacement, deployment and provider spending require a separate explicit scope; they are not default tests.

## Code and evidence map

| Area | Guide |
| --- | --- |
| Four Solidity financial contracts | [Contracts](contracts/README.md) |
| Identity, consent and filtered feedback | [ERC-8004](packages/erc8004/README.md) |
| Payment handles and recovery | [SDK](packages/sdk/README.md), [Relay](services/provider-relay/README.md) |
| Risk snapshots and signatures | [Underwriter](services/underwriter/README.md) |
| Pi tools and independent verification | [Pi](packages/pi-loop/README.md), [Arena](services/arena/README.md) |
| Owner sessions, budgets and goals | [Hosted Agents](services/hosted-agents/README.md) |
| Runtime and operations | [Tempo runtime](docs/tempo-runtime.md), [VPS](deploy/tempo-vps/README.md) |
| Dated public results | [Verification](docs/VERIFICATION.md), [documentation index](docs/README.md) |

This independent project extends AgentFuel source `922f65dc9c20ab404946ce37e49e95484b515f75`. Internal `@agentfuel/*` names, `InferCredit` EIP-712 domains and feedback tags retain compatibility. Original code is [MIT licensed](LICENSE); dependency/design notices remain separate in [attribution](docs/ATTRIBUTION.md).
