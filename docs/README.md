# Tabby Tempo documentation

Start with the current guides; dated source-project documents remain historical references, not the current deployment contract.

On 2026-10-14, main `40647f0dc9f966bbbe98bf3e474cfbe612c0ffa8` from [PR #1](https://github.com/Kris77z/tabby-tempo/pull/1) completed [CI and the first automatic release](https://github.com/Kris77z/tabby-tempo/actions/runs/38544850009). Subsequent deployment results follow current main GitHub Actions and release records. The 2026-10-15 migration describes additional code and controlled fixtures; these do not extend the dated Tempo acceptance claims.

| Guide | Purpose |
| --- | --- |
| [English overview](../README.md), [中文](../README.zh-CN.md) | Product, deployment status and isolated development |
| [Architecture](ARCHITECTURE.md) | Financial paths, units, authority and recovery |
| [Verification](VERIFICATION.md) | Existing Tempo claims and dated evidence |
| [Attribution](ATTRIBUTION.md), [contributing](../CONTRIBUTING.md) | Sources, licenses and checks |
| [VPS deployment](tempo-vps-deployment-20261013.md), [operations](../deploy/tempo-vps/README.md) | Sole production writer and actual service configuration |
| [CI/CD runbook](../deploy/tempo-vps/cicd/README.md), [2026-10-14 design/install record](tempo-cicd-20261014.md) | `Offline checks`, main-only release, successful-release rollback and protected root-owned entry; the install record preserves its historical date semantics |
| [Initial Tempo runtime record](tempo-runtime.md) | Network, PathUSD and fees; its local launch commands describe the historical initial deployment. Current startup/recovery follows the VPS runbook. |
| [Latest upstream migration](tempo-upstream-sync-20261015.md) | Model fallback, external service bindings, autonomous-game fixtures and HTTP/Docker safeguards; external hiring and autonomous games require explicit configuration and are disabled by default |

## Module guides

[Contracts](../contracts/README.md) · [SDK](../packages/sdk/README.md) · [ERC-8004](../packages/erc8004/README.md) · [Pi](../packages/pi-loop/README.md) · [Relay](../services/provider-relay/README.md) · [Underwriter](../services/underwriter/README.md) · [Arena](../services/arena/README.md) · [Hosted Agents](../services/hosted-agents/README.md) · [Frontend](../frontend/README.md)

## Dated Tempo records

- [Core independent acceptance](tempo-root-acceptance-20261012.md) and [public finance](evidence/tempo-20261012/financial-evidence.json).
- [Initial GameFi games](tempo-gamefi-runtime-20261013.md), [approved extra run](tempo-gamefi-extra-runtime-20261013.md) and [independent reward-path acceptance](tempo-gamefi-extra-root-acceptance-20261013.md).
- [Dashboard/goal sync](tempo-upstream-sync-20261013.md), [chain lookup/recovery sync](tempo-upstream-sync-round2-20261013.md).
- [Scene/chat migration](tempo-upstream-sync-20261014.md) and [its independent code acceptance](tempo-upstream-sync-root-acceptance-20261014.md); the code subsequently shipped in PR #1.
- [2026-10-15 controlled migration](tempo-upstream-sync-20261015.md), including retained Tempo configuration, fixture evidence and production exclusions.

Historical documents such as [implementation status](implementation-status.md), [Day-0 findings](day0-findings.md), [core source runtime](core-runtime.md) and [Monad acceptance](monad-hosted-acceptance-20261012.md) describe their dated source environments. Their private archive paths are not downloadable public evidence. They do not authorize another local writer or reuse of an old grant.

## 2026-10-20 代码层经济与恢复能力

新增冻结经济准入、owner只读经营/策略/operating投影、独立SDK和本地Publisher/Worker；见 [Review](REVIEW.md)。仅owned31337、合成模型与固定Docker离线验证，不更新此文档原有历史Tempo验收事实，不宣称公共链完整流程、TLS可靠性、真实模型或部署已通过。PathUSD结算贡献排除尚未归集链费，完整净利润未知。
