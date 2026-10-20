# Independent publisher and Worker, local integration example

This consumer publishes a funded `sum-integers` task through the existing TaskEscrow contract, buys a fixed-price solve with the **installed, compiled** `@agentfuel/sdk`, and submits its Python artifact to the existing Docker Arena. Publisher, Worker and verifier use separate processes and keys. The sample runs only on chain `31337` with loopback HTTP endpoints. It has no production mode.

The trusted operator imports a publisher-signed manifest into a generated Arena configuration. No source file or built-in task catalog needs editing. This is a narrow operator admission example, not a permissionless publication API or a generic marketplace.

## Reproduce

From the checkout, with Node 22+, cached npm dependencies, Foundry, Docker and the Arena's pinned Python image available:

```sh
npm ci
node scripts/check-publisher-worker.mjs
```

An empty npm archive cache must be prepared explicitly:

```sh
node scripts/check-publisher-worker.mjs --online-install
```

Optional report output is exclusive: an existing file is rejected before running the lifecycle, and the final write also uses `wx`:

```sh
node scripts/check-publisher-worker.mjs --report /tmp/publisher-worker-new-run.json
```

The checker builds contracts, packs the private development SDK (`0.0.0`), copies this consumer to an independent temporary directory, installs the archive and tests it there. Consumer runtime imports only its own `.mjs` files, `ethers`, and the installed SDK. Repository infrastructure bootstraps its own Anvil and existing Underwriter, fixed-price Relay and Arena; only those infrastructure processes read repository sources and contract artifacts. The checker removes its chain, consumer, synthetic private keys and journals on exit. The optional report contains public receipt/accounting evidence, without keys, signed transaction bytes or model responses.

The model response is controlled. Payments, escrow funding, loan repayment, feedback and settlement are real transactions on the isolated local chain. The identity/reputation registry and six-decimal token are test doubles. This check establishes neither a fresh Tempo execution, a real-model run nor external adoption.

## Consumer interfaces

After copying this directory outside the checkout and installing the compiled SDK archive, use one immutable trusted deployment configuration for all stages. It supplies `version:1`, chain/RPC and escrow/account/asset addresses, the trusted `poster` and `verifier`, Worker `agentId`, provider/Relay/Underwriter/Arena endpoints, `maxPrice`, `maxBorrowFeeBps`, `minimumProfit`, and an absolute `solveDeadlineMs`. The checker creates a complete configuration automatically. The Worker wallet must already be registered and enrolled for task credit, with its owner policy set and the provider admitted. Those deployment prerequisites remain operator responsibilities.

1. Publisher: `node publisher.mjs deployment.json request.json .state/publication.private.json publication.json`. Only this process receives `PUBLISHER_PRIVATE_KEY`. The request contains `version:1`, a 32-byte `requestId`, `problemId:"sum-integers"`, and raw decimal-string `reward`/`deadline`.
2. Trusted operator: `node admit.mjs deployment.json publication.json /tmp/short-private-ipc arena.json`. This keyless importer verifies the publisher signature, exact fixed specification, deployment, canonical creation receipt and live task fields before writing an Arena config. Start the existing Arena settler with its verifier key and this config, and its keyless HTTP controller in separate processes as documented in the [Arena runbook](../../services/arena/README.md).
3. Worker: `node worker.mjs deployment.json publication.json .state/worker.private.json`. Only this process receives `WORKER_PRIVATE_KEY`. It checks economics, accepts using its registry wallet, obtains and persists one SDK payment handle, buys a solve, and sends its signed code to Arena HTTP. `--stop-after-delivery` stops at the durable artifact boundary so a later process can demonstrate recovery.

The Worker never loads a verifier key or runs generated Python on the host. The existing provider's public-sample Docker runner executes the paid solve; the existing Arena separately executes all five fixed tests. Only the existing Arena settler authorizes the financial outcome. The consumer verifies the canonical verifier transaction and TaskSettled event before reporting completion.

## Funding and trust boundary

The publication signs the task ID, canonical creation transaction hash, publisher, asset/account/verifier, reward, deadline, protocol-fee snapshot and the fixed specification hash, in an EIP-712 domain bound to chain and Escrow. The importer also checks these against the chain. **TaskEscrow does not store a specification hash.** The signed manifest is an off-chain promise; the admitted problem and the globally authorized verifier are trusted. A signature alone does not make arbitrary work objectively enforceable on chain.

Before acceptance, the Worker requires:

```text
reward - snapshotted protocol fee - maxPrice
       - ceil(maxPrice × maxBorrowFeeBps / 10000) >= minimumProfit
```

This conservatively charges the borrowing fee on the entire provider price even when cash reduces the loan. Before each new payment broadcast it rechecks assignment and task/solve deadlines and refuses a signed authorization above the borrowing-fee ceiling. Already paid handles may retrieve their original delivery after the deadline. Chain fees are excluded and remain unknown in this settlement-asset-only contribution gate (including PathUSD fees on Tempo); this is not a general task-pricing policy.

The controlled acceptance funds `150000`, spends `40000` Worker cash plus `80000` task credit for a `120000` provider payment, repays `80000 + 12000`, and credits `58000` to `AgentAccount.cash`. The Worker's operating cash rises from `40000` to `58000`: net task income is `18000`, excluding gas. Settlement credits the operating account; this contract has no cash-withdrawal API, so the example does not claim a wallet payout. Task success and repayment feedback are checked separately from cash movement.

## Recovery limits

Keep **one original private journal for each logical publication request**. Approval and creation transactions are signed and saved before broadcast. Reusing that journal reconciles the original canonical transaction and derives the same manifest, including a lost acknowledgement after mining. `requestId` is an off-chain correlation key, not an on-chain idempotency key: using a new journal can create a second funded task.

The Worker journal binds the complete deployment configuration, original manifest and paid request. Changed configuration is rejected before rewriting its journal or making another payment. The SDK's original payment handle, code, submission signature and run ID survive separate process invocations. An explicit rerun after an Arena error reposts the same admitted submission to resume the same run; it does not purchase new work. A paid or uncertain transaction is reconciled using its original identity. Do not replace journals, change nonces, or manufacture a new request to resolve uncertainty.

Journals contain publicly broadcastable signed transaction bytes and are private `0600` files in private directories. Exclusive `.lock` directories block concurrent owners. Normal exit removes its lock; a hard kill can leave one behind. After confirming the original process has exited and no other process is using that journal, the operator may remove **only the stale lock directory**, preserving the original journal. The sample does not guess that a lock is stale or promise automatic hard-kill recovery.

The checker verifies replay without a second task, payment, model dispatch or verifier transaction; tampered publication rejection; unprofitable admission rejection; changed-config rejection; and the Worker's inability to self-settle. Unit checks also cover expired saved quotes and canonical transaction recovery. Existing provider, SDK and Arena suites cover deeper protocol failure cases.

New dispatch requires a durable one-attempt `beforeDispatch` reservation and live task/solve deadline. Delivered SDK caches remain readable after expiry; pending/Unknown dispatch cannot be repeated. Missing original transaction receipts never authorize an automatic rebroadcast. An Arena error is read-only by default: `--allow-submission-recovery` explicitly permits at most one saved original run/task/payload replay, rechecked after persistence; this is no new payment or model authorization.
