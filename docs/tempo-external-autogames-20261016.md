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

Before the autonomous parent can start, the acceptance driver must verify the external Goal succeeded with an actual external assignment and independent review, cash is below `130000`, credit is disabled, the initial reward balance is zero and no payment is unknown. The actor is not depleted artificially. Public write ingress is held in maintenance during the bounded run. Direct requests to the existing Hosted loopback endpoint use its loopback HTTP Origin and Bearer authentication; the signed login challenge still binds the production Origin.

The root-owned deployment guard must be separately reviewed and manually migrated before feature activation. It validates the exact additional ports and service journals, bounded admissions and transaction-budget ledger. Unconfigured directories, hidden external writers, pending refunds, unknown deliveries and unfinished child games remain deployment blockers. Automatic application deployment does not install trusted code.

## Evidence status

The feature implementation was released as main `0fe2732bfc89d3f79948fde6e2393c5c402cb6f4` by [Actions 38844885506](https://github.com/Kris77z/tabby-tempo/actions/runs/38844885506). Independent review verified 960 tracked source files, with only the generated Next declaration excepted, and preserved the original six Agents, 27 runs, 13 gateway dispatches and historical gateway journal. The independently installed deployment guard was reviewed separately.

The first bounded window configured the existing identity-43 provider and created task `9` with `150000` raw PathUSD escrow. An operator command initially omitted the already-approved `TEMPO_PUBLIC_ORIGIN`; explicit environment validation identified that configuration error before a Goal was created. The original task and transactions were retained for continuation.

The original Goal subsequently produced a plan and an external Writing Specialist delivery, both with verified original payments. The external service used identity `43`, its separate payment target and a single actual upstream dispatch. The first independent review returned `passed:false`; the one built-in revision ran. The final re-review payment was confirmed but remained `Paid` with an explicit empty upstream-attempt list. Execution stopped at the next pause, without another recovery or replacement Goal; no autonomous parent, game or reward task was created. The failed review is retained as returned; the external delivery alone is **not** a successful Goal or a game-to-task acceptance.

At this recovery snapshot there were four new physical gateway dispatches, all with HTTP 200 responses, reporting a combined 1057 completion tokens. Five Goal journal calls existed, but the last had no response or dispatch intent. A missing call response is recorded separately from an unknown physical model dispatch; reported usage must not turn missing data into zero. Eight new chain transactions were canonical and successful. Their actual PathUSD gas transfers summed to `2910` raw (`0.002910` PathUSD), against `14026` raw reserved. Goal payments totaled `50000` raw: four delivered calls (`40000`) and the final undelivered `10000`, pending controlled full refund. Task `9` remains in escrow. These numbers precede any recovery refund and are not final acceptance totals.

The recovery change recognizes a normal full refund only when the relay explicitly reports `upstreamAttempts:[]`, no delivered result or receipt, no operator resolution, and the original payment plus one complete refund are verified in canonical chain evidence. Missing attempts, rejected or unknown attempts, partial refunds and mismatched domains remain unresolved. The existing Unknown-dispatch resolution rules are unchanged. Relay status preserves a stored empty array instead of omitting it. A first allowlisted payment error code is retained without exception text or signed bytes; this does not establish the cause of the earlier SDK interruption.

An explicit `outcome:"aborted-before-parent"` closure handles a genuinely failed, nonrecoverable original Goal without fabricating a parent. Initial sealing requires zero bounded admissions, unchanged sponsor counters, no parent or child trace and no actor reward directory. The immutable closure freezes the original budget and empty admission mirror, closes the unused grant and removes the temporary broadcast-budget environment. Later ordinary settings and rewards may proceed without reopening this grant; original parent references, changed admission history and old or foreign reward evidence remain rejected. The normal two-request closure remains supported. Trusted guard installation and recovery execution require separate reviewed procedures; an application release does not install the trusted guard.

Targeted offline checks passed: payment/refund/diagnostic regressions 64/64, feature migration and abort closure 14/14, and deployment Python checks 88/88 (including 51 guard checks). Type checking passed. At this snapshot the production services remain stopped under maintenance for reviewed recovery; no refund, cancellation or abort closure has yet been executed. Full CI, the actual cleanup receipts and independent production review must establish the later outcome. Private evidence is kept under `.data/tempo-external-autogames-20261016/`; credentials and signed transaction bytes are not published.
