# Tempo CI/CD 实施记录 · 2026-10-14

本轮已实现 GitHub CI 与受限 VPS 应用发布器，完成本地部署测试，并将 root 持有固定入口、本站 nginx 维护 include 和专用账户安装到 VPS；受限 SSH 认证配置正在核验。GitHub `production` 环境、生产配置与 main 分支保护已经由主线程设置。安装回执确认三个应用服务未停止、没有发布新应用、没有恢复私密数据；生产应用仍沿用原成功基线、Tempo 42431 合约和业务状态，尚待首次 PR 合并后的发布验收。

## 已实现与验证

[Tempo CI](../.github/workflows/tempo-ci.yml)在 PR 与 main push 上共用 `Offline checks`。候选仓库、事件与 SHA 校验在 required job 内，失败不会因下游 skipped 被当作检查通过。CI 只读 token、无生产 secret，Node 固定 `22.23.2`、Foundry/Anvil 固定 `v1.8.1`、Docker Python 镜像固定 digest；运行 fixture build、类型检查、完整 workspace 与确定的离线 Tempo 测试、Python guards 和文档检查。

生产 job `needs: ci`，仅 main 的成功检查可触发，environment 为 `production`，并发不取消已运行发布。它不执行仓库代码或下载 artifact，只用专用 key、固定 known_hosts 和严格 host key 校验向 `tabby-tempo-deploy@154.12.34.51` 发送 `release|rollback <40hex>`。手动请求也必须从 main 发起并重新完成目标 SHA 的 CI。

[VPS 固定入口](../deploy/tempo-vps/cicd/engine.py)独立 fetch 固定仓库：release 仅允许当前 main tip，rollback 仅允许 main 祖先中的已成功版本及匹配构建包。部署检查既有源文件、合约源码、运行目录和私密状态；使用无生产凭据的构建账户，停三个关联服务后冷备、切换代码与构建、只读验收。失败恢复仅恢复代码，绝不自动恢复数据。完整步骤和错误处理见[运维说明](../deploy/tempo-vps/cicd/README.md)。

本地验证结果：工作流门禁与 SSH mock 测试 16 项通过，部署 Python 测试 46 项通过，`actionlint` 通过。安装器的真实临时配置测试覆盖安装成功与失败清理；这些用例不构成 VPS 已安装或应用已发布的证据。三个 action pins 和 Foundry 版本已通过当前官方仓库 `git ls-remote` 重新核实，原始 stdout 保留在 ignored `.github/evidence/action-pins.log`。

初始成功基线 `a59d0230c3d6a33058998da40566f04fe3261cb4` 包含六组显式 Tempo 测试，但没有后来增加的 `docs:check`。回滚先运行当前版本的 Python/文档安全检查，再切历史代码；历史目标文档命令使用 `--if-present`，不依赖历史版本包含新 CI 文件。

## GitHub 已配置

`production` 环境仅允许 main，已写入专用 `TEMPO_DEPLOY_SSH_KEY` secret 与旧 verified 单行 host key 的 `TEMPO_DEPLOY_KNOWN_HOSTS` variable，未打印私钥。main 的保护要求最新分支上的 `Offline checks`，绑定 GitHub Actions app `15368`，对管理员生效，禁止 force push 和删除，要求解决讨论。审核数量为 `0`；该设置不代表已经有首次 CI 或部署成功运行。

## VPS 安装结果与后续验收

主线程的只读现场核查确认：三个 `tabby-tempo-{frontend,runtime,gateway}` 服务均 active/running，应用目录无源文件漂移，链为 `42431`、Origin 为 `https://tempo.tabbyai.xyz`，BUILD_ID 为 `o0pAbXOA3yOoMP7KaivVM`，匿名 Hosted 为 `401 / HOSTED_AUTH_REQUIRED`。私密状态 capture/quiescence 的 issues 为空；13 个 dispatch、11 个 Response 和 2 个 Unknown 的原 journal SHA 未变，Unknown 的确切原始关联已核验，没有重放模型调用或交易。

主线程已核对安装回执：baseline 为 `a59d0230c3d6a33058998da40566f04fe3261cb4`，BUILD_ID 为 `o0pAbXOA3yOoMP7KaivVM`，`appServicesStopped=false`、`applicationDeployed=false`、`privateDataRestored=false`。本站 nginx 配置修改前后 SHA-256 已写入回执。安装仅登记健康的既有版本并增加固定入口，生产应用没有切换到本轮代码。

已安装固定 `engine.py` 的 SHA-256 为 `61ea676b5a980654928f39226d943505a9948e393017d743c3eb15579a272a93`，`state_guard.py` 为 `8ec48fa991a97d67359b23336844a02007b52fc058339249578b3eae89ac7efe`。受限 SSH 认证配置正在由主线程核验。首次 main 应用发布、SSH 断连后的持久回执处理和生产回滚仍需后续实际验收。

worker 由 PID 1 持有，75 分钟运行预算加 30 分钟停止/失败恢复预算；Actions 生产 job 为 110 分钟，CI 为 45 分钟。此设置覆盖旧三服务最长共 1260 秒的启动预算，并预留停止、解包和健康检查时间。SSH 断连后先查看 request receipt，再决定是否重试，不能据客户端失败判定服务器事务已终止。

私密现场快照、GitHub 设置回读和后续安装回执保留在 ignored `.data/tempo-cicd-20261014/`；部署私钥及业务快照不进入公开文档。原 VPS 迁移、生产 Origin 和既有服务证据仍以[2026-10-13 部署记录](tempo-vps-deployment-20261013.md)为准，本轮不扩大真实模型或 Tempo 链上任务的验收范围。
