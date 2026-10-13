# Tempo VPS 部署

目标：Ubuntu 24.04、`https://tempo.tabbyai.xyz`、`154.12.34.51`。Next、Hosted/Arena 和隔离网关在同一台服务器运行，浏览器只通过 nginx → Next 同源 API。

物理项目目录必须是 `/Users/jungle/Desktop/dev/agentfuel-tempo`；`/srv/tabby-tempo` 只是指向它的符号链接。原配置、付款 handle、交易 journal 中的绝对路径必须保持一致。迁移旧运行前先停止 Mac 上对应的所有 writer，完整复制已核对的私密快照；不要重新执行 bootstrap `init`/`deploy`，不要在两台机器同时恢复。

固定目录：`.data/tempo-20261012/operator/bootstrap.json`、`operator/model-upstream.json`、`runtime/`、`gateway/`。Linux Magpie 重新构建到 `.data/magpie-linux-build/`，不使用 Mac 二进制。迁移后的 RPC/upstream transport 使用 `direct`，网关端口保留 `3436`/`3437`，Hosted `8794`，Next `3028`；内部 relay/Arena/Underwriter 端口由原 runtime journal 恢复。

## 依赖与构建

以下命令在 VPS 按顺序执行。本目录文件本身不会在本机或远程自动执行。

```sh
export TEMPO_PROJECT_ROOT=/Users/jungle/Desktop/dev/agentfuel-tempo
cd "$TEMPO_PROJECT_ROOT"
sudo bash deploy/tempo-vps/install-dependencies.sh --apply
```

脚本从 [Node 官方 SHA256 清单](https://nodejs.org/dist/v22.23.2/SHASUMS256.txt) 和 [Go 官方下载清单](https://go.dev/dl/?mode=json&include=all) 固定 Node `22.23.2`、Go `1.26.3` 的 amd64/arm64 SHA256；先验证下载再解包。Docker 使用 [官方签名 APT 源](https://docs.docker.com/engine/install/ubuntu/)。已有冲突的容器软件不会自动删除。APT 包安装可能按 Ubuntu 默认规则启动 Docker/nginx，脚本不会启动应用 unit。

同步代码和私密快照后，让专用用户读取项目及所有原绝对路径引用的私密文件；密钥、数据库、journal 保持私密权限，不加入 nginx/public 目录。服务用户为 `tabby-tempo`。只有 runtime unit 获取 `docker` supplementary group；该组具有 Docker daemon 管理权限。

```sh
sudo chown -R --no-dereference tabby-tempo:tabby-tempo "$TEMPO_PROJECT_ROOT"
sudo -u tabby-tempo env PATH=/opt/tabby-tempo/node/bin:/opt/tabby-tempo/go/bin:/usr/bin:/bin npm ci
sudo -u tabby-tempo env PATH=/opt/tabby-tempo/node/bin:/opt/tabby-tempo/go/bin:/usr/bin:/bin \
  MAGPIE_GO_BIN=/opt/tabby-tempo/go/bin/go GOTOOLCHAIN=local \
  node --import tsx scripts/magpie-build.ts --output "$TEMPO_PROJECT_ROOT/.data/magpie-linux-build"
sudo -u tabby-tempo env PATH=/opt/tabby-tempo/node/bin:/usr/bin:/bin npm run build --workspace @agentfuel/frontend
sudo systemctl start docker
sudo docker pull python:3.12-alpine@sha256:4c47124a8391cb7a9f571164147d154777cf012a4ece5f86097130d7a4478111
sudo bash deploy/tempo-vps/preflight.sh
```

`preflight.sh` 检查文件可读、固定端口未占用、Docker daemon 和锁定镜像，以及以 `tabby-tempo` 运行 `bwrap --unshare-all`；不会启动应用、调用模型或访问链。

若 Ubuntu 24.04 的审计日志显示 `unprivileged_userns` 拒绝 bwrap 的 `setpcap/net_admin`，且系统未提供 bwrap profile，启用 `apparmor-profiles` 包中的 [官方 bwrap profile](https://gitlab.com/apparmor/apparmor/-/raw/apparmor-4.0/profiles/apparmor/profiles/extras/bwrap-userns-restrict) 后再跑 preflight。它只匹配 `/usr/bin/bwrap`，允许 namespace 初始化，并为子程序叠加禁止 capabilities 的策略；不修改全局 sysctl 或其他应用的策略。

```sh
sudo apparmor_parser -Q /usr/share/apparmor/extra-profiles/bwrap-userns-restrict
sudo install -m 0644 /usr/share/apparmor/extra-profiles/bwrap-userns-restrict /etc/apparmor.d/bwrap-userns-restrict
sudo apparmor_parser -r /etc/apparmor.d/bwrap-userns-restrict
```

## 运行状态与服务

在停机快照上完成显式离线 Origin 迁移，将 `frontendOrigin` 迁移为 `https://tempo.tabbyai.xyz`，保留迁移审计。runtime 恢复同时设置 `TEMPO_PUBLIC_ORIGIN`；不要手改 bootstrap/journal 绕过绑定校验。迁移保留历史 run/金融 journal，清空旧登录 session/challenge，并解除本地测试 grant 的启用引用。

```sh
sudo -u tabby-tempo env PATH=/opt/tabby-tempo/node/bin:/usr/bin:/bin TEMPO_PUBLIC_ORIGIN=https://tempo.tabbyai.xyz \
  node --import tsx scripts/tempo-vps-migrate.ts --check \
  "$TEMPO_PROJECT_ROOT/.data/tempo-20261012/runtime" "$TEMPO_PROJECT_ROOT/.data/tempo-20261012/operator/bootstrap.json" https://tempo.tabbyai.xyz
sudo -u tabby-tempo env PATH=/opt/tabby-tempo/node/bin:/usr/bin:/bin TEMPO_PUBLIC_ORIGIN=https://tempo.tabbyai.xyz \
  node --import tsx scripts/tempo-vps-migrate.ts --execute \
  "$TEMPO_PROJECT_ROOT/.data/tempo-20261012/runtime" "$TEMPO_PROJECT_ROOT/.data/tempo-20261012/operator/bootstrap.json" https://tempo.tabbyai.xyz
```

`--execute` 仅在 Linux 且原 runtime/Hosted 等端口均无监听时执行，不能用它同时保留旧 writer。

```sh
for service in gateway runtime frontend; do
  sudo install -m 0640 -o root -g tabby-tempo "deploy/tempo-vps/$service.env.example" "/etc/tabby-tempo/$service.env"
  sudo install -m 0644 "deploy/tempo-vps/tabby-tempo-$service.service" /etc/systemd/system/
done
sudo systemd-analyze verify /etc/systemd/system/tabby-tempo-{gateway,runtime,frontend}.service
sudo systemctl daemon-reload
sudo systemctl start tabby-tempo-gateway
sudo systemctl start tabby-tempo-runtime
sudo systemctl start tabby-tempo-frontend
sudo systemctl enable tabby-tempo-gateway tabby-tempo-runtime tabby-tempo-frontend
```

三个 `ExecStartPost` 只轮询健康接口/匿名登录状态，等待上限 300 秒。runtime 使用已有目录和 `--recover`；这是正常服务恢复，不是金融或模型验收脚本。先确认离线迁移审计与单 writer 状态后再启动。

Ubuntu 24.04 的 systemd 支持 `Upholds`：网关恢复后重新拉起 runtime，runtime 恢复后重新拉起 frontend。维护停机需一起停止三个服务，避免上游重新启动下游：`sudo systemctl stop tabby-tempo-frontend tabby-tempo-runtime tabby-tempo-gateway`。

## 域名与 HTTPS

先确认 A 记录指向 `154.12.34.51`，不存在错误的 AAAA；VPS 的 80/443 可从公网访问。只开放 nginx 对外入口，应用端口保持 `127.0.0.1`。

```sh
sudo install -m 0644 deploy/tempo-vps/nginx-http-bootstrap.conf /etc/nginx/sites-available/tempo.tabbyai.xyz
sudo ln -s /etc/nginx/sites-available/tempo.tabbyai.xyz /etc/nginx/sites-enabled/tempo.tabbyai.xyz
sudo nginx -t
sudo systemctl reload nginx
: "${TEMPO_ACME_EMAIL:?Set an ACME account email}"
sudo certbot certonly --webroot -w /var/lib/letsencrypt -d tempo.tabbyai.xyz \
  --email "$TEMPO_ACME_EMAIL" --agree-tos --non-interactive
sudo install -m 0644 deploy/tempo-vps/nginx-tempo.conf /etc/nginx/sites-available/tempo.tabbyai.xyz
sudo nginx -t
sudo systemctl reload nginx
sudo install -m 0755 deploy/tempo-vps/renew-nginx.sh /etc/letsencrypt/renewal-hooks/deploy/tabby-tempo-nginx
sudo systemctl enable --now certbot.timer
```

HTTPS 配置固定覆写 `Host`、`X-Forwarded-Host`、`X-Forwarded-Proto`，对应 `HOSTED_FRONTEND_TRUST_PROXY=1`；代理预算 300 秒，不缓存 API。HTTP 保留 ACME 路径，其余访问重定向到固定 HTTPS 域名。若 nginx 尚未运行，用 `start nginx` 代替首次 `reload`；不要覆盖服务器现有其他站点。

## 健康检查

```sh
sudo systemctl status tabby-tempo-gateway tabby-tempo-runtime tabby-tempo-frontend --no-pager
curl --fail --silent http://127.0.0.1:3437/health | jq '{ready,models,acceptedRequests}'
curl --fail --silent http://127.0.0.1:3436/v1/models | jq '[.data[].id]'
curl -sS -o /dev/null -w '%{http_code}\n' https://tempo.tabbyai.xyz/
curl -sS -o /dev/null -w '%{http_code}\n' https://tempo.tabbyai.xyz/dashboard
curl -sS -D - https://tempo.tabbyai.xyz/api/hosted/agents
sudo journalctl -u tabby-tempo-runtime -u tabby-tempo-frontend -n 60 --no-pager
```

首页、Dashboard、Onboarding 为 200；匿名 Hosted API 为 `401` 和 `HOSTED_AUTH_REQUIRED`。`/finance` 的 307 到 `/dashboard?panel=finance` 为预期行为。钱包登录挑战必须含生产 Origin 与 `Chain: 42431`，登录 Cookie 应为 `HttpOnly; SameSite=Strict; Secure`。不要把创建 Agent、充值、跑任务或模型请求作为部署健康检查。

Ubuntu/VPS 若拒绝 user/network/mount namespace，先查内核审计和发行版 `/usr/bin/bwrap` AppArmor profile。不要禁用全局 AppArmor、修改全局 userns 限制或退回未隔离 Magpie。网关 unit 不加 `RestrictNamespaces`、`PrivateNetwork` 或未经验证的 `NoNewPrivileges`；runtime 必须保持 `PrivateTmp=false`，否则 Docker 看不到提交文件的 host `/tmp` bind mount。基础设施故障必须保留原 journal。
