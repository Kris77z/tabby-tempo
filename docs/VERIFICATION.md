# Tabby Tempo verification guide

Only dated Tempo evidence below supports real-network claims. Controlled models, local Anvil, synthetic screenshots and source Monad history are separate scopes. Historical balances apply to recorded blocks, not the current head. A payment proves funds movement; it does not prove model quality or the supplier's final bill.

## Claim-to-evidence map

| Claim and scope | Published evidence | Mechanism |
| --- | --- | --- |
| Core: five successful tasks, four Agents, debt zero; Agent 49 completes two tasks in the same fixed 0.30 window, spending 0.26 | [Core independent acceptance](tempo-root-acceptance-20261012.md), [canonical audit](evidence/tempo-20261012/root-acceptance.json), [financial evidence](evidence/tempo-20261012/financial-evidence.json) | [Metered executor](../services/hosted-agents/src/metered-task.ts), [Pi autonomy](../packages/pi-loop/src/autonomy.ts), [Escrow](../contracts/src/TaskEscrow.sol) |
| Two Unknown calls remain recorded; operator compensates allowance/task and planner separately, with no fake repayment/default or zero-cost assertion | [Same full historical evidence](evidence/tempo-20261012/financial-evidence.json), [core report](tempo-root-acceptance-20261012.md) | [Inference closure](../services/hosted-agents/src/inference-closure.ts), [refund logic](../services/provider-relay/src/allowance.ts) |
| GameFi Task 7 cash reward + 0.02 original predeposit; Task 8 reward tokens; both Pi/Docker accepted, cash 0.15 and no loan | [Extra-run independent acceptance](tempo-gamefi-extra-root-acceptance-20261013.md), [financial evidence](evidence/tempo-gamefi-extra-20261013/financial-evidence.json), [original losing/invalid games](tempo-gamefi-runtime-20261013.md) | [Game executor](../services/hosted-agents/src/game-executor.ts), [reward ledger](../services/arena/src/inference-rewards/README.md), [Arena](../services/arena/README.md) |
| Read-only Tempo lookup obtains PathUSD metadata/balance and Task 7 fee evidence; goal/void recovery is controlled, not a new paid Tempo goal | [Round-two migration](tempo-upstream-sync-round2-20261013.md), [final lookup](evidence/upstream-sync-20261013-round2/tempo-read-only-lookup.json), [preserved first metadata failure](evidence/upstream-sync-20261013-round2/tempo-read-only-lookup-first.json) | [Lookup](../services/hosted-agents/src/goals/chain-lookup.ts), [evidence validator](../services/hosted-agents/src/chain-evidence.ts), [voiding](../services/hosted-agents/src/goals/void-payment.ts) |
| HTTPS application and single VPS writer | [Deployment facts](tempo-vps-deployment-20261013.md), [runbook](../deploy/tempo-vps/README.md) | [Deployment configuration](../deploy/tempo-vps) |
| New event/scene/chat behavior and canonical-payment callback recovery | [Current migration](tempo-upstream-sync-20261014.md), [independent acceptance](tempo-upstream-sync-root-acceptance-20261014.md) | [Scene types](../services/hosted-agents/src/scene-types.ts), [payment](../services/hosted-agents/src/goals/payment.ts), [fault test](../services/hosted-agents/test/goals-paid.test.ts), [controlled browser tests](../frontend/test/browser/upstream-scenes-20261014.spec.ts) |

Real task history used Kimi K2.6/K3, Pi and independent Docker checks. The current code sync used controlled responses and new local fixtures only, without a new provider bill, Tempo transaction, authorization or VPS update. Do not combine overlapping test runs into a headline total or count retry attempts as new successful tasks.

## Reproduce without production writes

Read the published summaries first. For code changes, use fresh synthetic state with Node 22.23.2 and cached Foundry/Docker prerequisites:

Launch commands in linked source reports and the initial Tempo runtime record are historical material. Current production startup and recovery use only the [VPS runbook](../deploy/tempo-vps/README.md).

```sh
npm run docs:check
npm run typecheck:all
node --import tsx --test services/hosted-agents/test/scenes.test.ts
# This test creates an isolated Anvil and a controlled provider.
node --import tsx --test services/hosted-agents/test/goals-paid.test.ts
```

Frontend tests are described in [its guide](../frontend/README.md#local-visual-and-test-checks). Never load archived local Tempo keys/configuration or run another writer beside the VPS. Real model, fork/RPC, signed replacement, game and deployment scripts are explicit operations, not part of the default offline proof.

## Preserved limitations

Unknown supplier usage/cost remains unknown. Operator compensation is distinct from delivery and earns no repayment reputation. Initial game entrants lost or returned invalid actions; actual platform winners and their rewards are recorded, not overwritten. Additional authorization used four of six hands and expired; unused hands cannot be replayed now.

Cash-only goals use task ID zero and model review; they do not inherit Task 7/8 income, hidden-test acceptance or credit reputation. No new live Tempo goal or nonce-replacement transaction is claimed. Synthetic public transaction hashes in UI tests are test data. No new source screenshot or Monad receipt is presented as Tempo evidence.
