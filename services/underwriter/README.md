# Tabby underwriter

This guide is adapted for **Tabby Tempo**. The running deployment is Tempo Moderato `42431`, with **PathUSD** (`0x20c0000000000000000000000000000000000000`, 6 decimals) for settlement and fees. The [VPS runbook](../../deploy/tempo-vps/README.md) describes the sole production writer at `https://tempo.tabbyai.xyz`; this documentation/code update has not been deployed.

Local launch examples below are for a **new isolated Anvil fixture only**, with synthetic roles, fresh private directories and controlled inference. Never load or restart the archived local Tempo runtime, reuse its journals, or start another writer beside the VPS. Monad/MON/USDC examples and dated results are explicitly source-project history or offline fixture semantics, not current Tempo configuration or new acceptance. See [Tempo verification](../../docs/VERIFICATION.md).


The underwriter converts verified on-chain task and payment history into a bounded, task-specific EIP-712 credit authorization. It reads the chain, signs typed data with a dedicated unconnected wallet, and saves the evidence whose hash is included in that signature. It does **not** broadcast transactions or reserve funds. [`AgentAccount → CreditManager.draw`](../../contracts/README.md) rechecks the authorization and current state when the agent actually pays a provider.

Credit here is a rule-based underwriting decision, not an LLM opinion or a general intelligence score. The financial truth comes from the Manager's counters; ERC-8004 feedback is a filtered mirror that can lag without creating an early upgrade.

## Review the implementation

| Source | What it establishes |
| --- | --- |
| [`src/rules.ts`](src/rules.ts) | Score, tier gates, raw-unit conversion and conservative escrow cap arithmetic |
| [`src/underwriter.ts`](src/underwriter.ts) | Same-block protocol reads, eligibility checks, EIP-712 fields, reorg check and evidence persistence |
| [`src/config.ts`](src/config.ts) | Explicit network/asset configuration, uint256 decimal parsing and signer configuration |
| [`src/http.ts`](src/http.ts) | Two HTTP endpoints, bounded input, exact browser origin and stable rejection codes |
| [`test/underwriter.test.ts`](test/underwriter.test.ts) | HTTP signatures consumed by real local contracts in USDC-6/native-18 modes; rejection, evidence and mirror-lag checks |

The existing wire identifiers remain `InferCredit` / version `1` / `CreditAuthorization`, matching the deployed Manager.

## Credit rules and units

Feedback queries filter by `clientAddresses=[Adapter]`, `tag1="infercredit"`, and one of `repayment`, `task-success`, `default`. The service uses only the returned **count**, not the unspecified ERC-8004 summary-value aggregation.

```text
score = 500 + 40 × min(mirrored repayments, 10)
            + 30 × min(mirrored task successes, 10)
            − 400 × mirrored defaults
```

| Tier | Gates | Fee | Demo maximum principal at USD/token = 1 |
| --- | --- | --- | --- |
| A | Score ≥ 700, mirrored repayments ≥ 3, Manager repayments ≥ 3 | 300 BPS / 3% | 2.00 tokens |
| B | Score ≥ 580, mirrored repayments ≥ 1, Manager repayments ≥ 1 | 800 BPS / 8% | 0.50 tokens |
| C | Remaining eligible agents | 1500 BPS / 15% | 0.20 tokens |

Any default in either the Manager truth or filtered mirror rejects credit. Other rejection gates are missing enrollment, changed/unbound identity, either protocol freeze or paused draws. A guardian unfreeze alone does not remove the default-count rejection.

The configured `TOKEN_USD_PRICE` is a **fixed demo USD/token input**, scaled internally by `10^18`; there is no price oracle. It defaults to `1`. Token amounts and counts are `BigInt`, serialized to decimal strings. Configuration accepts 6 or 18 asset decimals; native mode requires the zero address and 18 decimals.

The final principal cap is the smaller of the tier cap and the task's fee-adjusted LTV cap:

```text
tierCap   = floor(capUsdCents × 10^decimals × 10^18 / (100 × tokenUsdPrice))
escrowCap = floor(floor(payableEscrow × ltvBps / 10000) × 10000 / (10000 + feeBps))
cap       = min(tierCap, escrowCap)
```

`payableEscrow` already deducts the task's snapshotted protocol fee. Both integer floors are deliberate. The Manager checks coverage for the **authorized cap including fee**, then charges fee only on the actual drawn principal. For the USDC fixture with reward `150000`, LTV `8000` and C-tier fee `1500`, the cap is `104347` raw units; a payment of `120000` with cash `40000` draws `80000` and owes fee `12000`.

## Snapshot, signature and evidence

Startup and every request validate the RPC chain ID, Manager underwriter, settlement asset and decimals. The service derives Adapter, Account, Escrow and registries from the Manager, checks that addresses have code, checks the three settlement assets agree and verifies Reputation's Identity reference. This prevents a local configuration from silently mixing deployments.

Authorization reads use one numbered block. The service then verifies that block's hash and chain ID again before signing. It requires a task assigned to the agent before its deadline, an unused `(agentId, nonce)` and **no existing loan record**. It sets `authDeadline` to snapshot time plus 30 minutes and `loanDueAt` to the earlier of the task deadline or snapshot time plus 24 hours. Draws still require the task to remain live when mined.

The signed fields are `agentId`, `taskId`, `principalCap`, `feeBps`, `riskTier`, `identityVersion`, `authDeadline`, `loanDueAt`, `nonce`, `evidenceHash`. The domain binds the signature to the configured chain and Manager address. Evidence contains the block, protocol configuration/addresses, agent truth/mirror, task snapshot, cap calculation and deadlines. Its fixed-order JSON encodes `BigInt` as decimal strings; `keccak256` of the **exact UTF-8 file bytes** becomes `evidenceHash`.

The service returns only after `${EVIDENCE_DIR}/${evidenceHash}.json` is committed through a temporary file and atomic rename. Evidence does not include the private key or RPC URL. `EVIDENCE_DIR` defaults to `evidence/` relative to the launch directory and is ignored by Git; archive evidence deliberately when publishing an audit record.

There is no nonce reservation database: multiple unconsumed signatures can share a nonce, and the chain decides which is consumed. The authorization is also not a liquidity, budget or escrow reservation. Changed identity, task state, policy, balances or global headroom can make execution fail after a signature was issued. A task remains limited to one draw regardless of new nonces.

## Run and test

Requirements: Node 22 or newer, npm and Foundry on `PATH`. From the repository root:

```sh
npm ci
npm run typecheck
npm test --workspace @agentfuel/underwriter
```

The test command builds Foundry artifacts and starts its own local Anvil, using synthetic keys, real protocol contracts and mock registries/assets. It obtains HTTP signatures, calls `AgentAccount.payProvider`, and verifies provider balances, loans, cash, nonce use and outstanding debt. Tests also cover identity/configuration errors, default gates, mirror lag, replay/expiry, exact evidence hashes, storage failure and ownership of injected RPC clients. They clean up their own process and temporary evidence; they do not broadcast to Monad. `ANVIL_BIN` can specify the Anvil executable.

Production configuration is managed by the [Tempo VPS supervisor](../../deploy/tempo-vps/README.md). The historical `.env.example` contains Monad fixture defaults and is not a Tempo launch configuration. For a local integration, the test harness generates fresh synthetic roles, an isolated Anvil and temporary evidence; it never loads the archived local Tempo runtime.

## HTTP API

All uint256 input IDs/nonces must be canonical decimal **strings**, not JSON numbers, hexadecimal, scientific notation or leading-zero forms.

```sh
curl http://127.0.0.1:8787/agents/1/credit
curl http://127.0.0.1:8787/authorize \
  -H 'content-type: application/json' \
  -d '{"agentId":"1","taskId":"1","nonce":"1"}'
```

`GET /agents/:agentId/credit` returns the identity, `truth`, `mirror`, score/terms, raw tier cap, freeze/pause flags, eligibility/rejection, protocol configuration and read block. A credit profile can be returned for an ineligible agent; it is not an authorization.

`POST /authorize` accepts exactly `agentId`, `taskId`, `nonce`; success returns `authorization`, `signature`, `domain`, `block` and `evidenceHash`. HTTP input is limited to 4096 bytes. Invalid decimal values or extra fields return 400; business rejections return 409 with a code; oversized bodies return 413, wrong content type returns 415, and RPC/evidence failures return 503 without raw ethers error details.

For browser calls, set `FRONTEND_ORIGIN` to the exact allowed origin. Unconfigured or different origins are rejected. The service has no login system, nonce queue or relay. The provider's project-specific 402/receipt protocol is documented in the [SDK](../../packages/sdk/README.md); standard x402 facilitator interoperability has not been validated.

## Reputation recovery

Financial settlement and registry feedback are separate guarantees. Adapter feedback calls can fail and leave `pendingFeedback`; gas estimation can select the caught failure path while still producing a successful transaction. A caller must inspect pending flags and filtered counts, then retry with enough gas. `receipt.status=1` alone does not prove a mirror was updated. Tests exercise an actual settlement with failed feedback and subsequent retry. Delayed feedback can defer a tier upgrade, while Manager truth prevents fabricated mirror counts from creating repayment eligibility.
