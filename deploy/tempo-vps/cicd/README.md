# Tempo CI/CD 运维说明

本目录实现 GitHub CI 与 VPS 的受限应用发布入口。GitHub `production` 环境和 main 保护已配置；VPS 的 root 固定入口、本站 nginx 维护 include、专用账户和受限 SSH 认证已安装并验收。安装回执确认三个应用服务未停止、没有发布新应用、没有恢复私密数据；生产应用仍沿用成功基线与既有合约，尚待首次 PR 合并后的发布验收。实施进度见[本轮记录](../../../docs/tempo-cicd-20261014.md)，原服务器配置见[Tempo VPS 部署](../README.md)。

## 固定边界

仓库为 `Kris77z/tabby-tempo`，公网入口为 `https://tempo.tabbyai.xyz`，VPS 为 `154.12.34.51`，链为 Tempo Moderato `42431`。物理应用目录固定为 `/Users/jungle/Desktop/dev/agentfuel-tempo`；`/srv/tabby-tempo` 仅是指向该目录的链接。VPS 是唯一运行 writer，本机旧 runtime 不得与它并行启动。

| 用途 | 固定位置或身份 |
| --- | --- |
| 受限 SSH 用户 | `tabby-tempo-deploy` |
| root 持有的部署代码 | `/usr/local/libexec/tabby-tempo/` |
| 请求回执、成功版本、构建包、日志、冷备 | `/var/lib/tabby-tempo-cicd/`，仅 root 可读 |
| 无生产凭据的构建用户与目录 | `tabby-tempo-build`、`/var/lib/tabby-tempo-build/` |
| 应用运行用户 | `tabby-tempo` |
| 私密业务数据 | 应用目录的 `.data/tempo-20261012/` |
| systemd 私密环境 | `/etc/tabby-tempo/{frontend,runtime,gateway}.env` |
| 本站维护标记 | `/run/tabby-tempo-cicd/maintenance` |

SSH 公钥由 root 管理，带 `restrict,command="/usr/local/libexec/tabby-tempo/ssh-entry"`。入口只接受 `release <40位小写SHA>` 或 `rollback <40位小写SHA>`；不提供 shell、上传、任意路径或环境转发。GitHub 使用独立部署私钥，不能使用日常 root SSH key。

服务器原全局配置禁用公钥认证。安装器只在 `sshd_config` 末尾追加 `Match User tabby-tempo-deploy`：启用 publickey、禁用 password/keyboard-interactive、要求 `AuthenticationMethods publickey`，关闭 forwarding/TTY/user rc，并固定 `ForceCommand`。`sshd -t` 和 root、应用用户、nobody 的完整 effective 配置前后相等后才 reload SSH；失败恢复原配置。真实密钥探针已确认 shell、SCP、任意 SHA 均被拒绝。

## GitHub 配置与 CI

[Tempo CI 工作流](../../../.github/workflows/tempo-ci.yml)在 PR 和 main push 上使用同一个 `Offline checks` job；候选校验在这个 required check 内执行，校验失败会使检查失败。CI token 仅有 `contents: read`，不注入生产 secret，不使用 `pull_request_target` 或跨事件发布，也不上传构建 artifact。

检查使用 Node `22.23.2`、Foundry/Anvil `v1.8.1` 和固定 digest 的 Python Docker 镜像，运行锁定依赖安装、Solidity 本地测试、fixture 前端构建、类型检查、完整 workspace 测试、六组离线 Tempo/RPC/journal 测试、部署 Python 测试及文档检查。`test:all` 不包含 ERC-8004 fork 命令或所有 `scripts/test/*.test.ts`；真实 Magpie 模式和外部 Arena HTTP 测试均为 opt-in，CI 显式设置 `SPECIALIST_LIVE=0`、`ARENA_PLAY_TEST_URL=''`。

main 已要求最新分支上的 `Offline checks`（GitHub Actions app `15368`），规则适用于管理员，禁止 force push 和删除，并要求解决讨论。PR 审核数量为 `0`，不要求 CODEOWNERS。`production` 环境的部署分支仅允许 main，以下配置已由主线程写入：

| 类型 | 名称 | 内容 |
| --- | --- | --- |
| Environment secret | `TEMPO_DEPLOY_SSH_KEY` | 专用、无口令的 Ed25519 部署私钥；不进入仓库或日志 |
| Environment variable | `TEMPO_DEPLOY_KNOWN_HOSTS` | 既有已核验 VPS host key 的单行 known_hosts 记录 |

生产 job 仅在同仓库 main 的 CI 成功后运行；不 checkout、不安装依赖、不恢复缓存或下载 artifact。SSH 固定 host/user，使用 `StrictHostKeyChecking=yes`，不学习新 host key。生产并发组 `tempo-production` 的 `cancel-in-progress=false`；服务器另外使用独占部署锁。

## 一次性安装

固定入口已按基线 `a59d0230c3d6a33058998da40566f04fe3261cb4` 安装，BUILD_ID 为 `o0pAbXOA3yOoMP7KaivVM`。回执记录 `appServicesStopped=false`、`applicationDeployed=false`、`privateDataRestored=false`，并保留本站 nginx 与 SSH 配置修改前后摘要。本站维护开关已验证 503 后恢复 200，保护状态没有变化；首次生产应用发布尚未执行。

安装只由运维人员通过既有管理通道执行。服务器要求 Linux、root、`/usr/bin/python3 >=3.12`，既有三个服务健康，私密状态静止，源文件与已成功的基线一致。安装器不会停应用、部署应用或恢复私密数据；它登记基线、安装固定入口和专用账户，给本站 nginx 配置加入维护 include，并为 deploy 用户配置公钥认证。已有入口、账户、维护标记或冲突配置会使安装失败，不会被覆盖。

首次安装时，把已经审核的本目录文件放在 root 私有审核目录，并把部署**公钥文件**单独放在 root 私有目录。公钥内容不写入文档；应用目录内的可变副本不能作为后续自动执行入口。以下为一次性安装命令模板，当前已安装后不再执行：

```sh
sudo /usr/bin/python3 -I /root/tempo-cicd-reviewed/install.py --apply \
  --baseline a59d0230c3d6a33058998da40566f04fe3261cb4 \
  --public-key-file /root/tempo-deploy-ed25519.pub
```

完成后核对 `/var/lib/tabby-tempo-cicd/installation.json` 的基线、trusted 文件摘要、nginx/SSH 摘要及 `applicationDeployed=false`、`privateDataRestored=false`；核对两个专用账户仅属于自身组，以及三个应用服务和原 BUILD_ID。安装失败会撤销本次新增设施并恢复原 nginx/SSH 配置，应用代码和业务数据保持原样。

## 发布与回滚

main push 的 CI 成功后自动提交该 push 的确切 SHA。VPS 重新 fetch 固定仓库并要求 release SHA 等于当时的 main tip；排队期间已过时的提交会返回 `RELEASE_NOT_CURRENT_MAIN`，不会换成新的 SHA 悄悄部署。

手动重试在 GitHub Actions 选择 `Tempo CI`、branch `main`、operation `release`，填写当前 main tip 的完整小写 40 位 SHA。本轮会重新对该 SHA 执行 CI。也可使用：

```sh
TEMPO_RELEASE_SHA='<完整40位小写SHA>'
gh workflow run tempo-ci.yml --repo Kris77z/tabby-tempo --ref main \
  -f operation=release -f sha="$TEMPO_RELEASE_SHA"
```

回滚选择同一工作流的 operation `rollback`。目标必须是当前 main 的祖先，并在 VPS 的 `successful/<SHA>.json` 中有已成功发布记录及可校验的保存构建包。首次安装登记的基线在下一次发布的冷备完成后获得可回滚包。任意祖先、PR SHA 或本地构建包都不能据此成为回滚目标。

```sh
TEMPO_ROLLBACK_SHA='<已成功发布的完整40位小写SHA>'
gh workflow run tempo-ci.yml --repo Kris77z/tabby-tempo --ref main \
  -f operation=rollback -f sha="$TEMPO_ROLLBACK_SHA"
```

回滚 CI 先在工作流的 main 版本运行当前 Python 部署 guards 和文档检查，再 checkout 历史目标执行应用检查，因此历史目标不需要包含新的 CI 脚本。`a59d023` 已核对六组 Tempo 测试均存在；其 `docs:check` 尚未出现，目标版本使用 `--if-present`，当前版本文档检查仍必须通过。VPS 回滚使用成功记录中的构建包，只恢复代码、依赖和前端产物。

## 服务切换与冷备

[部署事务](transaction.py)先验证源文件、合约源码不变、私密绑定和业务静止状态，然后在无生产凭据的独立账户中安装依赖、构建和检查类型。生产依赖安装固定 `--ignore-scripts`；构建阶段隔离网络、隐藏 `.data`、`/etc/tabby-tempo` 和部署存储，构建账户没有应用或 Docker 组权限。构建完成后才进入本站维护窗口。

维护 include 只影响 `tempo.tabbyai.xyz` 的 HTTPS vhost，不停止 nginx 或其他站点。入口确认本站 503、连接已排空、状态仍静止后，一起停止 `tabby-tempo-frontend.service`、`tabby-tempo-runtime.service`、`tabby-tempo-gateway.service`，并核对 cgroup 内没有遗留 writer。停机后保存旧代码/构建包及 `.data/tempo-20261012/` 冷备，记录摘要，再切换应用代码。按 gateway → runtime → frontend 启动并检查子进程、端口、BUILD_ID 和只读 HTTP 边界。

正常发布、手动回滚和失败恢复都**绝不自动恢复私密数据**。冷备中的密钥、数据库、交易与模型 journal 是人工核对依据。若发现数据漂移、业务未静止或新运行状态不确定，保留维护与停机状态，返回 `MANUAL_RECONCILIATION_REQUIRED`；不要解包私密冷备、删 journal 或重放交易来消除差异。回滚失败会保持三个服务停止并返回 `ROLLBACK_FAILED_SERVICES_STOPPED`。

发布探针仅检查健康、匿名访问、Origin 拒绝、运行进程和既有状态。不创建/注册 Agent，不充值，不跑 paid 任务或推理，不执行 bootstrap `init`/`deploy`、授权/额度 `renew` 或证书 `renew`。不要用登录 challenge、`/api/arena/play` 或浏览器 hydration 当作发布健康探针。

## SSH 断连与超时

root 入口通过 PID 1 的 transient systemd unit 持有 worker；SSH 断连或 Actions 取消不会直接杀死半途切换的 worker。worker 的 `RuntimeMaxSec=4500` 为 75 分钟，收到 TERM 后有 `TimeoutStopSec=1800` 的 30 分钟恢复预算。三个旧应用 unit 的最长启动预算合计 1260 秒，额外余量用于停止、解包和健康检查。Actions 生产 job 为 110 分钟，CI 为 45 分钟。

SSH 首先返回 `accepted`、32 位 `requestId` 和 unit 名。断连后，由有管理权限的运维人员先读取 `/var/lib/tabby-tempo-cicd/requests/<requestId>.json`：`Pending` 表示不能重试；`Succeeded` 结合 `current.json` 确认已完成；`Failed` 先核对错误、维护标记与三服务。transient unit 完成后可能已被 collect，持久回执比 unit 是否存在更可靠。详细日志保存在 root 私密目录，Actions 仅输出受限状态和错误 code。

```sh
TEMPO_REQUEST_ID='<此前返回的32位requestId>'
sudo cat "/var/lib/tabby-tempo-cicd/requests/$TEMPO_REQUEST_ID.json"
sudo systemctl status "tabby-tempo-deploy-$TEMPO_REQUEST_ID.service" --no-pager
sudo journalctl -u "tabby-tempo-deploy-$TEMPO_REQUEST_ID.service" --no-pager
sudo systemctl status tabby-tempo-frontend tabby-tempo-runtime tabby-tempo-gateway --no-pager
```

只有确认前一请求结束、状态可继续、三服务与维护标记一致后，才重新对明确 SHA 发起工作流。不要因为 SSH 或 Actions 的客户端超时就另起 writer；也不要手工删除归属不明的维护标记。服务器 `DEPLOYMENT_BUSY` 是已有事务占锁的结果。

## 固定入口人工升级

应用 release 可以更新仓库内本目录文件，但不会替换 `/usr/local/libexec/tabby-tempo/` 的 root 持有副本；应用 release 也不修改既有 systemd unit、环境文件、合约产物或 nginx 配置。固定入口升级必须独立审核，并在没有 worker、没有 Pending 请求时由运维人员执行。

先冻结和审核 [engine.py](engine.py)、[transaction.py](transaction.py)、[state_guard.py](state_guard.py)、[ssh-entry](ssh-entry)，运行本目录 Python 测试与工作流门禁测试。暂停新发布请求，保存旧固定入口及摘要，把审核后的四个文件放到 root 私有目录，再逐项以 root 所有、不可被组或其他用户写入的权限替换固定副本。`ssh-entry` 使用 `0755`，三个 Python 模块使用 `0644`。在重新接收部署前核对 Python 版本、四个摘要、sudoers 的固定命令边界与实际已安装配置，并记录升级证据。

`install.py` 只用于一次性登记；已有设施时会拒绝重跑。更改 sudoers、nginx include、部署账户、公钥、服务配置、合约源码或路径绑定均需独立人工迁移，不由普通应用发布隐式完成。
