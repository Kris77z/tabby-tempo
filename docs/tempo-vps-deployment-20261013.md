# Tempo VPS 部署验收 · 2026-10-13

Tempo 已部署到 `https://tempo.tabbyai.xyz`。公网 HTTPS 页面、托管登录与匿名访问边界已通过 Mac 和 VPS 两侧实际 HTTP 检查，三个应用服务已确认 `active` 且开机启用。部署沿用 Tempo Moderato `42431` 的既有合约、账户与业务状态；本记录不扩大之前真实模型、链上任务或奖励验收的范围。

## 服务器、域名与运行版本

| 项目 | 已核对状态 |
| --- | --- |
| VPS | CSTserver 产品 `14096`，IPv4 `154.12.34.51` |
| 系统与资源 | Ubuntu `24.04.1`，4 CPU、8 GB 内存、88 GB 磁盘 |
| DNS | Spaceship 管理 `tabbyai.xyz`；`tempo` 的 A 记录为 `154.12.34.51`，TTL `1800` |
| HTTPS | Let's Encrypt 证书，当前有效期至 `2027-01-11`；`certbot.timer` 已启用自动续期 |
| Node | `22.23.2`，`/opt/tabby-tempo/node/bin/node` |
| Go | `1.26.3`，`/opt/tabby-tempo/go/bin/go` |
| Docker | `29.9.0` |
| Magpie | VPS 原生 Linux 构建，SHA-256 `d424ad8ef6de87552a3a663e5ecfaa202bbd17ad7b675db2baef13cc7e9eeae6` |

物理项目目录保留为 `/Users/jungle/Desktop/dev/agentfuel-tempo`；`/srv/tabby-tempo` 仅是指向该目录的符号链接。旧配置、付款 handle 与交易 journal 中的绝对路径因此保持一致，私密文件读取也满足 `taskPrivateFile` 的物理路径与所有者检查。运行用户为 `tabby-tempo`，只有 runtime unit 获取 `docker` supplementary group。

nginx 对外提供 `80/443`，HTTPS 反向代理到 Next `127.0.0.1:3028`。`ss` 已确认公网监听仅有 nginx `80/443` 和 SSH `22`；Hosted `8794`、Magpie `3436`、供应商桥接 `3437` 及既有 runtime 内部服务均保持 loopback 监听。生产前端固定 `HOSTED_FRONTEND_ORIGIN=https://tempo.tabbyai.xyz` 与 `HOSTED_FRONTEND_TRUST_PROXY=1`；nginx 固定覆写 `Host`、`X-Forwarded-Host` 和 `X-Forwarded-Proto`，浏览器通过 Next 同源 API 访问 Hosted。

## 隔离与构建检查

VPS 已加载官方 AppArmor `bwrap-userns-restrict` profile，允许 `/usr/bin/bwrap` 建立所需 namespace，并限制沙盒子程序的 capabilities。`kernel.apparmor_restrict_unprivileged_userns` 仍为 `1`，没有关闭全局 AppArmor 或 user namespace 限制，也没有退回未隔离的 Magpie。Linux 实测覆盖宿主文件不可见、未配置 loopback peer 不可达及已配置 peer 的 Unix socket 路由，相关检查共 `9/9` 通过。

`npm ci`、Next production build 与 typecheck 已通过。Magpie 由项目锁定源码、补丁和 Go 版本在 Linux 重新构建；没有使用 Mac 二进制。Docker 使用已有锁定的 Python 镜像供独立 Arena 执行器使用。

## 单 writer 切换与原状态迁移

迁移前正常关闭了 Mac 上的 runtime `27181`、gateway `55851` 和 frontend `64341`。VPS 私密快照包含 `212` 个文件，传输后逐文件核对 SHA-256。旧 Mac writer 不继续运行，VPS 使用原目录和 `--recover`，没有重新执行 bootstrap `init`、部署合约或导入 Monad journal。

离线生产 Origin 迁移的审计 ID 为 `c6820c69b7e433d402e12f861184e35be6a4b35016c9dfa435ec42753686a309`。迁移将本地 Origin 改为 `https://tempo.tabbyai.xyz`，保留原始 runtime binding、originalBootstrap、历史目录和业务记录；旧登录 challenges/sessions 已清空。过期的本地测试 grant 仅解除启用引用，原授权文件、grant 与 admissions 历史保留，没有续期或增加预算授权。

迁移后的 Hosted 历史仍为 `27` 个终态 run：`23` 个成功、`4` 个失败。金融 journal 与角色、供应商和 gateway 密钥文件均未变动。迁移与启动后，相对快照仅有以下 `8` 个配置或运行元数据文件变化：

| 文件 | 变化 |
| --- | --- |
| `gateway/magpie/config/magpie/providers.json` | 重建本地供应商桥接路由凭据 |
| `gateway/ready.json` | Linux 网关启动元数据 |
| `operator/bootstrap.json` | 生产 frontend Origin |
| `runtime/game.json` | Linux upstream transport 为 `direct` |
| `runtime/hosted.json` | 生产 Origin 与过期授权启用引用 |
| `runtime/hosted/database/session.json` | Origin 绑定与旧登录认证清理 |
| `runtime/ready.json` | VPS runtime 就绪元数据 |
| `runtime/runtime-journal/session.json` | 显式 Origin 迁移审计与有效绑定 |

上述相对路径均位于 `.data/tempo-20261012/`。生产 Origin 的变更通过 `scripts/tempo-vps-migrate.ts` 完成，没有手改 journal 绕过绑定校验。

## 公网 HTTP 与登录检查

Mac 与 VPS 均通过实际公网 HTTPS 请求检查：

| 请求或边界 | 结果 |
| --- | --- |
| `/`、`/dashboard`、`/onboarding` | `200` |
| `/finance` | `307`，转向 `/dashboard?panel=finance` |
| 匿名 `/api/hosted/agents` | `401`，`HOSTED_AUTH_REQUIRED` |
| 签名 challenge、login、catalog、logout | `200` |
| 外部 Origin | `403` |
| 登录 Cookie | `Secure; HttpOnly; SameSite=Strict` |
| 登录挑战链域 | 生产 HTTPS Origin 与 `Chain: 42431` |

登录检查使用一次性随机、无余额钱包，仅签名登录、读取 catalog 并登出。没有创建 Agent、充值、运行任务、调用模型或发起链上写入；gateway attempts journal 在本轮检查前后未变化。此结果是签名及 HTTP 认证验收，不等同浏览器扩展钱包业务流程验收。

## 服务维护与排障

服务为 `tabby-tempo-gateway.service`、`tabby-tempo-runtime.service` 和 `tabby-tempo-frontend.service`。三者已确认运行并开机启用。runtime 保留 `NoNewPrivileges=true` 与 `PrivateTmp=false`；后者确保 Docker daemon 能访问提交文件的宿主 `/tmp` bind mount。gateway 保留所需 namespace 权限与独立 Magpie 隔离。

gateway 配置 `Upholds=tabby-tempo-runtime.service`，runtime 配置 `Upholds=tabby-tempo-frontend.service`，下游保留对应 `Requires/After`。受控执行 gateway restart 后，没有手动启动下游，`Upholds` 自动恢复了 runtime 与 frontend。随后独立 `systemctl show` 确认三个服务均为 `active/running`；本轮恢复后的 PID 分别为 gateway `25360`、runtime `25416`、frontend `25691`。再次完整公网认证检查通过。

维护停机需统一停止三个应用服务，避免仍在运行的上游重新拉起下游：

```sh
sudo systemctl stop tabby-tempo-frontend tabby-tempo-runtime tabby-tempo-gateway
```

恢复按网关、runtime、前端顺序启动。保持原生产 Origin、私密目录、密钥与 journal；不要用新目录、删除业务记录、重置额度或重放原模型请求处理启动故障。

```sh
sudo systemctl start tabby-tempo-gateway
sudo systemctl start tabby-tempo-runtime
sudo systemctl start tabby-tempo-frontend
sudo systemctl status tabby-tempo-gateway tabby-tempo-runtime tabby-tempo-frontend --no-pager
curl --fail --silent http://127.0.0.1:3437/health
curl --silent --show-error https://tempo.tabbyai.xyz/api/hosted/agents
```

匿名 Hosted 请求应得到上述 `401`。排障需要同时核对 HTTP 响应与服务日志，不能只看 `systemctl active`：当前 runtime 父进程尚未持续监督 Hosted/settler 子进程退出，若父进程仍 active 但 Hosted 不响应，应先核对进程与原 journal，再恢复对应 runtime 服务。

首次两次 systemd 启动仅返回通用 `TEMPO_HOSTED_RUNTIME_FAILED`。随后同用户、组、路径和环境的 bootstrap 检查、直接 runtime 启动及关闭均成功；相同环境的 `systemd-run` 诊断也成功，后续正式服务启动和受控重启恢复均通过。初始失败未复现，原因保持未知，不作为当前部署阻断。保留 `NoNewPrivileges`；新增诊断只输出受限的 `code/reason/source`，不输出原始 RPC 错误、密钥或私密配置。

公开源代码不包含私密状态或密钥。部署快照、哈希校验、迁移审计和验证 proof 保存在被 Git 忽略的 `/Users/jungle/Desktop/dev/agentfuel-tempo/.data/vps-deploy-20261013/`。通用部署命令与配置见 `deploy/tempo-vps/README.md`；本记录以已经实际验证的 VPS 状态为准。
