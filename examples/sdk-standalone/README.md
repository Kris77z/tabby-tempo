# Standalone payment SDK example

This directory is a consumer of the compiled `@agentfuel/sdk` package. Copy this directory and one local SDK tarball into any independent project directory; it does not import repository source, use workspace resolution, require Foundry/Docker, or need the rest of Tabby at runtime. Node.js 22+ and npm are required. The package is an unpublished private development build at version `0.0.0`.

The default command exercises real SDK code with controlled loopback HTTP/JSON-RPC responses. It obtains and validates a bound 402 quote, durably saves its handle, blocks every new payment in `beforePayment`, reconstructs the client from that journal, and resumes the original identity. A final cache read uses an explicitly preset `Delivered` fixture. **No transaction is signed or broadcast, no model is called, and the fixture receipt is not evidence of a chain payment.** This is a client-integration smoke check, not a full economic acceptance run.

## Reproduce outside the repository

From the repository root, install build dependencies with `npm ci`. Then the automated check creates a consumer under the OS temporary directory, builds/installs the tarball, checks TypeScript declarations, runs the consumer tests and demo, and removes temporary files:

```sh
node scripts/check-sdk-standalone.mjs
```

Its dependency installation is **offline** and never falls back to the network. The committed [`package-lock.json`](package-lock.json) pins registry dependencies and their archive integrity, including `ethers@6.17.0`, `typescript@5.9.3`, and `@types/node@22.20.4`. Installation reuses this lock when adding the local SDK tarball; it does not need cached registry metadata. These archives are also present in the root lock, so the root `npm ci` prepares the offline check, including in a fresh CI cache. Keep the example lock when copying this directory. If the required package archives are absent from npm's cache, explicitly populate it with:

```sh
node scripts/check-sdk-standalone.mjs --online-install
node scripts/check-sdk-standalone.mjs
```

`--online-install` permits npm registry access only to install dependencies. The runtime demo still uses the same loopback fixture and does not perform business operations. For a manual, inspectable consumer setup, start at the repository root:

```sh
SDK_EXAMPLE_TMP="$(mktemp -d "${TMPDIR:-/tmp}/agentfuel-sdk-example.XXXXXX")"
npm run pack:standalone --workspace @agentfuel/sdk -- --out-dir "$SDK_EXAMPLE_TMP"
cp -R examples/sdk-standalone "$SDK_EXAMPLE_TMP/client"
cd "$SDK_EXAMPLE_TMP/client"
npm install --offline --ignore-scripts --no-audit --no-fund --save-exact "$SDK_EXAMPLE_TMP/agentfuel-sdk-0.0.0.tgz"
npm run typecheck
npm test
npm start
```

The manual installation reuses the copied example lock; it records the generated SDK tarball path only in that external consumer's lock. The committed example lock contains no generated SDK path or integrity. If required archive contents are missing, the explicit preparation command above populates them. You can move the tarball and example elsewhere before installation; the tarball needs only its declared npm dependency, and contains ESM JavaScript, declarations, a README, and the MIT license. It contains no service workspace, contract artifacts, keys, journals, or SDK TypeScript source. Keep the manual directory for inspection, or remove it with `rm -rf "$SDK_EXAMPLE_TMP"` after leaving that directory.

The smoke check fails on a broken package export or assertion; it does not just print an expected success string. `typecheck.ts` imports both public subpaths from the installed package and checks their declarations. The test suite checks request/task binding, rejected provider/chain/digest/price quotes, RPC chain mismatch, persistence failure before payment, and original-handle recovery without a second quote or transaction submission.

## Client and authority

[`client.mjs`](client.mjs) is the reusable minimal client. Its `fetchOrResume` helper uses the actual public API:

```js
import { InferCredit } from "@agentfuel/sdk";

const client = new InferCredit({ ...trustedOptions, onHandle: saveDurably });
try {
  const paid = savedHandle
    ? await client.resume(savedHandle)
    : await client.forTask(taskId).fetch(relayUrl, { body: request });
  // For cash-only requests without a task, use client.fetch(relayUrl, { body: request }).
} finally {
  client.close();
}
```

`trustedOptions` must come from your own trusted deployment configuration: `chainId` (bigint), `agentId`, Account address, settlement asset address, provider address, per-payment `maxPrice` (bigint), and exactly one of an ethers `signer` or Node `sessionKey` plus `rpcUrl`. Set `underwriterUrl` only for the intended deployment's credit path. Do not populate these bindings from a received quote or generated model output. The signer must be the agent's current registry wallet; deployed contracts and the underwriter remain authoritative for spending policy, assigned tasks, credit eligibility, and identity changes.

`fetch` binds `taskId="0"` and requires cash. `forTask` binds the original assigned task and can obtain credit for a cash shortfall; it does not create, assign, verify, or settle a task. IDs use canonical decimal strings. Amounts use raw integer asset units: for an asset with six decimals, `10000n` is `0.01`, and `120000n` is `0.12`. Confirm the actual deployment's asset decimals. `maxPrice` limits **each provider payment**; it is not a cumulative budget. Hosts own cumulative reservations, deadlines, concurrent admissions, and wallet nonce coordination. An idempotent `beforePayment` callback can enforce that host policy.

## Optional real connection

[`real-client.mjs`](real-client.mjs) calls the same persistence/recovery helper against caller-specified services. It requires an explicit `--execute`, your own current wallet key in `AGENTFUEL_SESSION_KEY`, a trusted JSON configuration, and a private journal path. This command can spend funds. The default `npm start` never invokes it.

Copy [`trusted-config.example.json`](trusted-config.example.json) to a private path and replace all placeholder addresses, URLs, chain/agent IDs, price ceiling, and request with your own deployment values. The placeholder addresses do not deploy contracts or make this a local Anvil integration. The deployment must already provide an Account with the intended settlement asset, a registered current agent wallet, funds and gas, and an operational relay. Add `"taskId": "…"` and `"underwriterUrl": "…"` only when using an existing eligible assigned task and the matching underwriter. Omit both for cash-only use.

Load your key into the environment using your preferred local secret mechanism, then explicitly run:

```sh
node real-client.mjs --execute /absolute/private/trusted-config.json /absolute/private/state/payment.json
```

Run the **same command with the same configuration and journal** after a timeout or restart. An existing journal always invokes `resume`; it never buys a fresh quote. The helper rejects changed request/relay configuration for an existing journal. It writes results and relay receipts privately to `payment.json.delivery.json`, and prints only the state/payment ID or a bounded error code. This repository check does not execute the real-client command, contact a public chain, or claim a successful real deployment connection.

## Recovery and limits

[`journal.mjs`](journal.mjs) writes JSON through a temporary file, flushes it, atomically renames it, and flushes the parent directory. New journal directories use mode `0700`, files use `0600`. One journal belongs to one immutable request. The helper acquires an exclusive sidecar directory (`payment.json.lock`) before reading the journal, and returns `JOURNAL_LOCKED` if it already exists. It removes only the lock it acquired. A crash can leave a lock behind; after confirming its owner is no longer running, explicitly remove that empty lock directory and rerun with the same journal. It never automatically removes an unknown lock or deletes payment state. This local-filesystem guard does not coordinate different journals sharing a wallet, distributed filesystems, cumulative budgets, or separate signers.

The SDK awaits `onHandle` before the next payment action. Keep its original request, quote, relay route, payment ID, credit nonce, and submission together. Handles omit the private key but can contain private request data and publicly broadcastable signed raw transactions. Keep journals and delivery files outside Git and protect access. A payment timeout is not proof of failure: preserve the original handle, and use `PaymentError.handle` or the journal to reconcile it. Do not edit the handle, reset its nonce, or replace an uncertain paid call with `fetch`.

The SDK validates deployment/request/price bindings before payment. It trusts the configured relay's delivered metadata; the controlled cache fixture intentionally demonstrates this boundary and does not independently authenticate its fabricated receipt. Genuine payment evidence requires canonical on-chain receipts/events and the real relay's proof checks. The SDK uses Tabby's own 402/receipt scheme; standard x402 facilitator compatibility has not been validated. It does not independently prove model provenance, Arena correctness, task income, repayment, a full economic loop, or external-team adoption. See the [SDK guide](../../packages/sdk/README.md) for its complete API and recovery states and the [verification guide](../../docs/VERIFICATION.md) for separate contract/relay integration checks.
