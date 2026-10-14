# Tabby Tempo frontend

The running application is [tempo.tabbyai.xyz](https://tempo.tabbyai.xyz), backed by the sole VPS writer. [Deployment facts](../docs/tempo-vps-deployment-20261013.md) and [operations](../deploy/tempo-vps/README.md) govern production. This 2026-10-14 scene/chat/landing code update is **not deployed**; its local preview uses synthetic state only.

## Pages and current behavior

`/` is the bilingual product landing; `/onboarding` signs in and creates an Agent with a name; `/dashboard` configures model/strategy/spend before execution. Budgets are distinct from deposits. `/finance` redirects to `/dashboard?panel=finance`; `/arena` points Tempo users to the hosted entry and separates four local practice games from real sponsored Holdem. Historical Monad reports are labeled explicitly. `/advanced` reads the configured protocol snapshot and does not substitute a fixture on failure.

The same-origin `/api/hosted/*` proxy owns HttpOnly session handling, strict origin checks and owner-scoped snapshots. A browser cannot choose arbitrary RPC/provider endpoints or see hosted private keys. Production forwarded-origin trust remains explicitly configured. Tempo UI uses **PathUSD**, chain `42431` and `https://explore.testnet.tempo.xyz`; absent/unavailable capabilities are not presented as executable.

The Dashboard displays recorded cat scenes and mission chat. Events are whitelisted, persisted, sequential and bounded at 256. Progress and model cost remain distinct. Historical results are static, Unknown/paused/disconnected state overrides stale completion events, and reduced-motion users receive no cat frame progression. Chat reveals only received content, preserves full copy, and expands public payment/source evidence on demand.

Goal submission retains original UUID/text/model/budget across uncertain response and reload; pause recovery and explicit stop target that same request. Built-in specialist scores are source-reference snapshots, not current Tempo onchain reputation. Cash-only goals and bounded chain lookup do not imply tools for arbitrary browsing, deployment or fund movement.

## Local visual and test checks

Use Node 22.23.2. Any local preview must have its own port and **synthetic** state, never the archived local Tempo manifest/configuration or VPS keys:

```sh
npm run typecheck --workspace @agentfuel/frontend
npm run build --workspace @agentfuel/frontend
FRONTEND_MODE=fixture HOSTED_AGENTS_URL=http://127.0.0.1:1 \
  npm run dev --workspace @agentfuel/frontend -- --hostname 127.0.0.1 --port 3038
```

The separate preview is `FIXTURE`, not a replacement for production. Browser tests use [the synthetic harness](test/browser/hosted-harness.ts), intercept hosted/RPC endpoints and generate no real transaction/model requests. Default Playwright configuration uses its own `3010` server; selected test configurations may use another explicit `baseURL`, and the landing test derives its allowed origin from it.

```sh
node --import tsx --test frontend/test/tabby-scenes.test.ts frontend/test/mission-chat.test.ts
npm run test:browser --workspace @agentfuel/frontend -- \
  --grep 'public specialist|Unknown overrides|historical conversation|reduced motion blocks|bilingual landing architecture'
```

The default browser configuration may include separate controlled Anvil/Docker integration tests. Those tests require cached Docker images and synthetic roles; none should load the former Tempo runtime. Chrome can be selected with `CHROME_BIN`. The [migration record](../docs/tempo-upstream-sync-20261014.md) preserves failures, final test scope and build ID rather than calling every historical suite current.

## Developer galleries

```sh
node scripts/preview-dashboard.mjs --build-only
node scripts/preview-tabby-scenes.mjs --build-only
```

Both generate isolated synthetic developer outputs under ignored `demo-output/`, with no chain/model connection. Omitting `--build-only` starts their own development gallery; check the port first and do not reuse production configuration. Scene gallery labels and mock fee units use Tempo/PathUSD, but remain synthetic.

## Read and transaction semantics

Tempo finance reads retain the original `120000ms` reader and `130000ms` proxy bounds. HTTP finance failures remain unavailable; stale/unconfirmed figures cannot become confirmed cash/debt. Read-only RPC pacing, bounded 429 handling and complete log windows remain intact. Forwarded credentials, private transport paths and raw model prompts are omitted from public snapshots.

Canonical financial evidence matches chain, contract, Agent, task, original payment and block. A PathUSD receipt may contain both fee and business transfers; UI display does not itself verify a settlement. The wallet/identity links and payment/settlement links remain available in the actual Tempo explorer. Sponsorship is projected only to its owner, with the original expiry/admission count; expired grants cannot enable new games.

## Evidence and source notices

[Tempo core](../docs/tempo-root-acceptance-20261012.md), [GameFi](../docs/tempo-gamefi-extra-root-acceptance-20261013.md), [latest code sync](../docs/tempo-upstream-sync-20261014.md), [verification guide](../docs/VERIFICATION.md) and [third-party notices](THIRD_PARTY_NOTICES.md) distinguish real historical flows from controlled UI tests. Source logo explorations and source acceptance screenshots were not migrated.
