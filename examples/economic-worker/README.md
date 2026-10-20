# Independent bounded economic Worker

This example runs a publisher and a bounded Worker/controller as separate Node.js processes, installed in a temporary directory outside this repository. The runtime imports only Node.js, `ethers`, and the packed public `@agentfuel/sdk` API. The harness supplies an owned Anvil chain (`31337`), a loopback fixed-price provider, controlled model responses, and the existing pinned Docker Arena with an independent settler.

From the repository, use Node.js 22+, Foundry 1.8.1, a local Unix Docker daemon, and the pinned image:

```sh
docker pull python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111
node scripts/check-independent-economy.mjs
node scripts/check-independent-economy.mjs --execute-local --report /absolute/new-report.json
```

The default is shadow: setup deploys and funds local contracts, then the measured observation and decision leave cash, nonce, payment events, settlement events and model calls unchanged. `--execute-local` authorizes the isolated business run. `--online-install` permits downloading missing dependency archives; the default installation is offline. Reports use exclusive creation and never overwrite a file.

To install the standalone runtime, copy the `.mjs` files and `package*.json` from this directory to a directory outside the workspace, then install the packed SDK (or a published compatible SDK) and exact dependency versions:

```sh
npm install --ignore-scripts --no-audit --no-fund --save-exact /absolute/agentfuel-sdk-0.0.0.tgz
PUBLISHER_PRIVATE_KEY=... node publisher.mjs config.json publication-request.json publisher-journal.json manifest.json
node controller.mjs config.json catalog.json worker-journal.json
WORKER_PRIVATE_KEY=... node controller.mjs config.json catalog.json worker-journal.json --execute-local
WORKER_PRIVATE_KEY=... node controller.mjs config.json catalog.json worker-journal.json --resolve-refund
```

Use only synthetic keys and loopback endpoints. The publisher request contains `version`, a bytes32 `requestId`, a public `spec` (`version`, `problemId`, `language`, `prompt`), raw `reward`, and chain `deadline`. The catalog is an array of publisher-signed manifests. The local harness shows complete configuration construction. The Worker verifies each publication signature, canonical creation receipt and funded escrow before quoting. It persists the exact genuine HTTP 402 quote, request, policy and selected intent, then calls public `InferCredit.resume(handle)`. It never requests a replacement execution quote or changes the relay's quote implementation.

The policy allows six attempts, `720000` cumulative **gross** service charges, one payment up to `120000`, and a `120000` cash reserve. A refund never restores the gross spending budget or attempt count. Each decision ranks every still-open signed funded task by net reward minus quoted cost and required profit. Comparable success removes a fixed cold-start cushion; observed paid failure adds the greatest comparable realized loss to the next required profit. These are deterministic cushions, not calibrated risk probabilities. Credit, chain-fee accounting, public vendors and commercial demand are outside this example.

One wallet authorization is stored under `$HOME/.local/state/agentfuel/economic-worker/<domain-hash>/authority.json`, bound to chain/account/wallet, the canonical original journal path and original configuration/catalog hash. Keep this HOME and journal stable across restarts. Its lock covers the full controller lifetime, including the first quote before any chain transaction. A second live writer is rejected. Lock ownership includes PID, process birth identity and hostname; a confirmed dead owner can be reclaimed under an exclusive claim. Malformed, foreign-host and orphaned claim files fail closed and require operator reconciliation. Do not delete a live lock or replace the authority to restart an authorization. Full on-chain acceptance/payment history also rejects a missing original journal.

Atomic private journals are fsynced before acceptance/payment broadcast and before history transitions. The executable harness kills actual Worker processes at: signed payment before broadcast; payment already mined with delivery acknowledgement absent locally; settlement already mined before accounting; and unresolved dispatch. A replacement process must recover original request/payment IDs, signed-byte hashes, budget, reserved cash and policy before it may continue. The first lost acknowledgement may finish in the original provider process while the Worker is down; the restarted Worker reads that delivery without another charge or model dispatch.

Unknown blocks further business and cannot be bypassed with a new journal or configuration. `--resolve-refund` requires both the original full chain refund and a terminal failed original task with zero escrow, bound to the original agent, quote and payment. The harness explicitly requests the provider refund and independently authorizes a failed task settlement; it does not label that administrative closure a Docker success or infer nondelivery from silence. Pure cash payments intentionally record chain `PaymentRecord.taskId == 0`; the original task is bound by the quote's task/request/payment digest, original acceptance and settlement proofs. The original service charge, refund, failure and remaining policy are retained before later tasks resume.

Only public IDs, amounts, canonical event receipts, source fingerprints, signed-byte hashes and process interruption facts are exported. Private keys, raw signed transactions, endpoints, model output and private journal paths remain in the owned temporary directory and are removed by the launcher. This example uses one wallet writer and a trusted catalog; it is not a production permissionless market or a general daemon.

Focused independent checks live in `scripts/test/independent-economy-audit.test.mjs` and `scripts/test/independent-evidence-audit.test.mjs` and run through the root review commands. There is no standalone `npm test` script in the copied consumer.

The Tempo port adds `beforeDispatch` to the installed SDK consumer. Deadline/stop/Unknown and malformed or spent reservations block a new dispatch, including an already-paid pending handle. Delivered cache reconciliation is still permitted. Transaction acknowledgement loss only rechecks the original hash and canonical receipts; no automatic re-sign/rebroadcast occurs. Cold accounting revalidates original settlement receipt, block, sender, event, task and refund closure before appending history.
