# Attribution and provenance

Tabby's original code is distributed under [MIT](../LICENSE). This does not replace the notices or licenses of dependencies, fonts, source adaptations, or third-party material.

| Component | Source and role | Repository record |
| --- | --- | --- |
| Magpie | [yetone/magpie](https://github.com/yetone/magpie), pinned `v0.1.814`; a small patch disables implicit retry of uncertain paid calls. | [Lock/hashes](../scripts/magpie.lock.json), [patch](../scripts/magpie-no-retry.patch), [MIT notice](../scripts/magpie-UPSTREAM-LICENSE), [integration](magpie-gateway.md) |
| Pi | `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`, pinned npm dependencies `1.0.1`, used for bounded model/tool execution. | [Package manifest](../packages/pi-loop/package.json), [solver integration](../packages/pi-loop/README.md) |
| Specialist prompts/configuration | Adapted monad-rebel ABI, gas, token, transaction and yield definitions; these are built-in roles, not separately registered external agents. | [Provenance](../services/hosted-agents/src/specialists/monad-rebel/provenance.json), [catalog](../services/hosted-agents/src/specialists/catalog.ts) |
| Workspace patterns | Agora Mesh / monad-rebel inspired the terminal layout and Commander/Timeline workflow. Tabby supplies hosted execution, payment, budgets, recovery and public projections. | [Migration record](frontend-agora-migration.md), [Tempo goal integration](tempo-upstream-sync-20261013.md) |
| Mission chat | [Beautiful UI](https://www.beautifului.dev/) Thinking State layout and collapse transition; Tabby substitutes persisted public run events for the timed demonstration. | [Adaptation and MIT notice](../frontend/THIRD_PARTY_NOTICES.md), [MissionChat](../frontend/components/hosted/mission-chat.tsx) |
| Landing reference | Oberon was a visual reference for the adapted landing layout. | [Reference/adaptation](frontend-oberon-landing.md) |
| Fonts and brand | Inter/Geist Mono notices are retained. The selected Tabby mark and export process are recorded separately. | [Brand assets](../frontend/public/brand/tabby/README.md), [Inter notice](../frontend/public/brand/tabby/Inter-LICENSE.txt), [workspace font notice](../frontend/components/hosted/fonts/LICENSE.txt) |
| Contract test utilities | Bundled forge-std supplies Foundry test helpers. | [Upstream project documentation](../contracts/lib/forge-std/README.md) and bundled notices |

These references credit reuse. They do not assert blanket rights to redistribute an upstream design or asset under Tabby's MIT license. Retain each component's own notice and verify its terms when extracting it for another project.

## Names and historical records

The repository and product are **Tabby**. **InferCredit** names the financial protocol. Internal `@agentfuel/*` names and saved-request identifiers preserve compatibility with the original AgentFuel implementation.

Dated reports distinguish testnet execution, real vendor calls, controlled models, local chains, and synthetic UI fixtures. Private archives are excluded from Git; the [verification guide](VERIFICATION.md) links published receipt summaries and source code.

## Tempo adaptation

The source AgentFuel project is read-only upstream. Tempo changes are maintained in [Kris77z/tabby-tempo](https://github.com/Kris77z/tabby-tempo). Frozen snapshots and per-file decisions are recorded in [this migration](tempo-upstream-sync-20261014.md). Original specialist prompts retain their provenance; runtime instructions prevent historical Monad fee/yield assumptions from being presented as Tempo facts. Source-only logo explorations, private journals and historical acceptance screenshots were not imported.
