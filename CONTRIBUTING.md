# Contributing to Tabby

Start with the [architecture](docs/ARCHITECTURE.md) and [verification guide](docs/VERIFICATION.md). Each public implementation claim should have a source-code entry point and dated evidence that another developer can inspect.

## Set up and choose checks

Use Node.js 22.23.2+, npm, and Foundry. A complete coding-task run also needs Docker and the pinned Python image. Follow the [root setup](README.md#isolated-development); the zero-key demo uses an isolated Anvil chain and explicitly mocked inference/registries.

| Change | Appropriate validation |
| --- | --- |
| README, architecture, module guides | `npm run docs:check` and review the linked source/evidence |
| TypeScript services or shared types | `npm run typecheck:all` and the affected workspace tests |
| Solidity financial behavior | `forge test --root contracts --offline`; review invariants and affected integrations |
| Full local payment/verification/settlement path | `npm run test:demo` with local Anvil and Docker |
| UI behavior and wallet interactions | Frontend unit/browser checks described in [frontend README](frontend/README.md) |
| Tempo recovery or real-model integration | Explicit opt-in configuration and dated evidence; use the relevant runbook |

`npm run test:all` covers workspace tests, including tests that need local Anvil/Docker. It does not establish that Foundry, script integrations, browsers, public forks, or real vendors were exercised. State which group ran and whether the model/chain was real or controlled.

## Preserve the economic invariants

- Bind chain, identity, assigned task, asset, provider, and request digest through quotation, authorization, payment, and settlement.
- Preserve raw integer asset units. Tempo PathUSD has six decimals; mock-USDC is an offline fixture; allowance microcredits, model tokens, quote prices, and loan fees are separate quantities.
- Recover the original UUID, route, payment handle, and signed transaction. Do not replace an uncertain paid request with a new purchase.
- Keep solver tools separate from hidden-test verification and settlement authority. Personal-goal model review is not proof of task income or repayment.
- Financial settlement and best-effort reputation feedback have different failure handling. Preserve pending feedback and settled financial history.
- Keep owner-scoped sessions, agent locks, budget reservations, and public projections intact. Browser input and model output cannot choose private RPC endpoints or operator keys.

## Document a change

Update the affected module guide with its API, authority, units, and recovery behavior. Explain why a non-obvious invariant exists in a short source comment; avoid comments that repeat the code.

Record acceptance date, chain ID, tested revision, real/controlled model mode, expected invariant, confirmed receipts or exact local assertion, and unresolved boundary. Keep failed attempts and extra funding visible. Do not add overlapping test batches into one headline number.

Publish only needed, redacted evidence. `demo-output/`, keys, authenticated RPC URLs, sessions, provider secrets, private IPC, and raw signed transaction journals stay outside Git. Public JSON receipt summaries and transaction hashes are appropriate when their schema excludes those fields.

The [documentation checker](scripts/check-doc-links.mjs) validates the public guide set and accepts additional Markdown paths as arguments. Use repository-relative links so documents work on GitHub and in a clone.

## Propose work

Use a focused branch and a pull request describing the concrete change and validation. Report failures with enough context to reproduce them. Use [GitHub Issues](https://github.com/Kris77z/tabby-tempo/issues) for bugs; exclude credentials and live signing journals.

The project's original code is [MIT-licensed](LICENSE). Preserve upstream notices and the provenance recorded in [attribution](docs/ATTRIBUTION.md).

## Production writer

The VPS at `https://tempo.tabbyai.xyz` is the sole Tempo writer. Local development uses a new isolated Anvil or synthetic browser state with fresh directories and controlled inference. Do not restart archived local Tempo services or reuse their keys, signed transactions, grants or journals. Code review, tests and a Git update do not deploy production; follow the [VPS runbook](deploy/tempo-vps/README.md) for a separately authorized deployment.
