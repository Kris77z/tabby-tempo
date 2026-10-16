# Tempo external specialists and autonomous games — 2026-10-16

This record covers explicit configuration and bounded acceptance of two existing execution paths. An external Goal hires an independently registered specialist service with a separate payment target. Autonomous games belong to the fixed-task controller; they do not fund cash-only external Goals. The specialist and platform have the same operator; this is not a claim of an independent third-party company.

The starting production version is `aca571c3c4a5ea4aa409c6e5cf7e45edcd7e9f07`, released by [Actions 38759169931](https://github.com/Kris77z/tabby-tempo/actions/runs/38759169931). The service uses Tempo Moderato `42431`, PathUSD with six decimals, its existing contracts, Origin and journal. The VPS remains the only writer. No local production runtime is started.

## Read-only baseline

The October 16 inventory found six Agents, 27 terminal runs, seven owner game admissions and 13 historical gateway dispatches. Both feature switches were absent. All three production services were active, maintenance was off and the installed guard accepted quiescence. The original additional-game authorization and task-template deadline were expired; neither is renewed implicitly.

Canonical reads verified identity `43` has matching owner, wallet and existing independent provider key. Its wallet differs from the internal payment/refund target; its provider whitelist entry was false. Existing Agent `73` is the original cash GameFi Agent, uses `kimi-k2.6`, has `allowCredit=false`, cash `150000` raw and no historical reward ledger. That identity is retained for this acceptance. Agent `74` has historical rewards and is not used to present old awards as a new game outcome.

## Authorized acceptance limits

The user approved the following single budget with “同意，按上述上限执行”. The private approval audit records when this authorization was relayed to the executor; no earlier six-game allowance is reused.

| Operation | Maximum physical model calls | Maximum completion tokens | Protocol amount |
| --- | ---: | ---: | ---: |
| One external Goal: plan, up to three phases, independent review, at most one built-in revision and re-review | 7 | 12288 | `120000` raw PathUSD |
| One autonomous parent, at most two actual credits-only games | 40 | 20480 | No cash game prize |
| At most one task using an award actually earned by the same identity in this acceptance | 2 | 1024 | No cash inference purchase |
| Total | **49** | **33792** | Goal plus one new task escrow: **0.27 PathUSD** |

Input tokens are separately billed by the supplier. Completion and call limits do not imply a fixed supplier currency price. There is no promised winner, extra attempt or replacement identity. If neither game awards the actor, the record must distinguish a completed automatic game from an incomplete reward-to-task loop.

The new task escrow is `150000` raw PathUSD. The only new provider whitelist entry is the exact existing identity-43 wallet; there is no new registry identity, contract deployment, faucet or Agent funding. All new transactions, including refunds or recovery, share a limit of 40 and a gas budget of `3000000` raw PathUSD. Each transaction is capped at 20 million gas and `3600000003` attodollars per gas. Each maximum reservation rounds upward to `72001` raw; 40 such reservations total `2880040` raw, below 3 PathUSD. The combined authorized protocol and gas ceiling is **3.27 test PathUSD**.

The conversion follows [Tempo TIP-1010](https://github.com/tempoxyz/tempo/blob/main/tips/tip-1010.md): gas price units have 18 decimals and the fee asset has six, so the conservative raw bound is `ceil(gasLimit * maxFeePerGas / 10^12)`. The mainnet gas parameters in that TIP are not applied to chain 42431. The broadcast guard reads the sender's canonical fee preference; only zero/default PathUSD or explicit PathUSD is accepted. Targets are limited to the immutable snapshot of the existing Account, Escrow, Manager and PathUSD. FeeManager changes, DEX calls and other TIP-20 targets are outside this authorization. See the official [resolution implementation](https://github.com/tempoxyz/tempo/blob/main/crates/revm/src/fee_manager.rs) and [default fee-token constants](https://github.com/tempoxyz/tempo/blob/main/crates/contracts/src/precompiles/mod.rs).

## Configuration and recovery boundary

`hosted.json` is generated on every runtime recovery. Features therefore require an explicit stopped-runtime migration that freezes a private feature file and digest in the runtime journal. Ordinary application releases cannot silently enable them. The new task template selects only the explicitly appended task and its new deadline; existing workflow and autonomy snapshots remain unchanged.

The external stack runs inside the existing runtime lifecycle. Each service has its own quote/payment journal; all refunds share the original refunder serialization queue and Tempo gas ceilings. Logical model, physical model, response model, price, endpoint, service, registry identity and payment target must agree. Unrated services remain unrated.

The separate bounded-game grant binds the original owner, Agent, one parent request ID, original counters and an expiration. It grants at most two credits-only children and does not expand manual-game limits. Its immutable authorization, primary admissions and independent mirror preserve replay and crash recovery without renewing the historical grant.

The broadcast allowance is persisted before forwarding signed bytes. All participating processes share a cross-process lock and ledger. A lost RPC response keeps the reservation consumed; only the same original signed transaction is idempotent. Invalid domains, targets, fee tokens, stale authorizations and exhausted limits stop execution. No private business data is restored to undo a failed test.

Before the autonomous parent can start, the acceptance driver must verify the external Goal succeeded with an actual external assignment and independent review, cash is below `130000`, credit is disabled, the initial reward balance is zero and no payment is unknown. The actor is not depleted artificially. Public write ingress is held in maintenance during the bounded run; the driver uses the existing internal Hosted endpoint with the production Origin.

The root-owned deployment guard must be separately reviewed and manually migrated before feature activation. It validates the exact additional ports and service journals, bounded admissions and transaction-budget ledger. Unconfigured directories, hidden external writers, pending refunds, unknown deliveries and unfinished child games remain deployment blockers. Automatic application deployment does not install trusted code.

## Evidence status

Implementation and offline validation are in progress. Production configuration, provider whitelist, new task and real paid acceptance have not yet been executed by this change. Final receipts and observed outcomes will be added after independent review and actual execution. Private evidence is kept under `.data/tempo-external-autogames-20261016/`; credentials are not published.
