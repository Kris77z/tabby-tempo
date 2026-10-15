# Tempo 发布故障与恢复记录（2026-10-15）

本记录说明 10 月 15 日发布中断的现场证据、旧版恢复和部署器修复边界。后续应用是否发布成功，以 [main 的 GitHub Actions](https://github.com/Kris77z/tabby-tempo/actions/workflows/tempo-ci.yml?query=branch%3Amain) 与 VPS 持久回执为准。

## 故障与恢复

[PR #2](https://github.com/Kris77z/tabby-tempo/pull/2) 合并为 `7a359620997a268953b6dc9e026a89059f5e44f0` 后，[Actions 38747346688](https://github.com/Kris77z/tabby-tempo/actions/runs/38747346688) 的完整 CI 通过；生产发布请求 `f8c15e2e883746249b48cef608faf4f1` 于 `14:16:27 UTC` 被接收，最终返回 `ROLLBACK_FAILED_SERVICES_STOPPED`。本站保留维护状态，公网返回 503。

现场确认了两个连续问题：

1. root 部署 worker 的 `UMask=0077` 作用于新源码父目录；原部署器只设置文件权限，没有设置新目录的所有者与遍历权限。新增的 `services/hosted-agents/src/external` 为 `root:root 0700`，应用用户无法遍历，runtime 报 `ERR_MODULE_NOT_FOUND`。构建包中的 `registry.ts` 实际存在，权限为 `0644`，内容摘要与候选源码一致。
2. 自动恢复已经完整还原先前成功版本的源码、依赖和构建，但 runtime 的启动频率限制仍生效；日志显示 `Start request repeated too quickly`。原回滚步骤没有在这次受控恢复前清除失败计数，最终保留三服务停止状态。旧异常记录只保留汇总错误，缺少发布与回滚各自的错误码。

磁盘与当前可用内存充足。VNC 屏幕的一条历史 cgroup 内存不足消息没有被用来推断本次故障原因。

运维恢复首先核对本次冷备元数据、旧版所有源码摘要、实际 BUILD_ID、业务静止状态及冷备后的允许变化；没有重新解包代码，没有恢复私密数据。在持有部署锁和本站维护标记期间，一起确认三服务停止，仅清除三服务的失败计数，再按原 gateway → runtime → frontend 顺序启动。旧版健康检查和状态比较全部通过后才登记旧版并解除维护。

`14:43:04 UTC` 已恢复 `40647f0dc9f966bbbe98bf3e474cfbe612c0ffa8`，BUILD_ID 为 `4Uxx0OqThhQlKBo4D8gK0`。独立验收确认三个服务 active/running，首页、Dashboard、Onboarding 为 200，匿名 Hosted 为 401，外部 Origin 为 403。保留 6 个 Agent、27 个历史 run 和 13 次模型 dispatch；原模型 journal 摘要仍为 `4e525d4c4fcff0f660bc23ba7b54cf43770ca7fd20d933fdbc77158f5fb4a501`。变化仅为守卫允许的重启 metadata 与 IPC 生命周期文件。

## 修复与独立迁移边界

修复限于公开源码目录安装权限、一次受控回滚前的启动失败计数和安全错误码记录。私密目录、既有环境、合约产物、链上状态、原 journal、SSH/nginx 和服务配置均不由这项修复更改。

仓库中的部署器文件不会自动替换 `/usr/local/libexec/tabby-tempo/` 的可信副本。可信入口必须在无活动 worker、无 Pending 请求时另行审核、备份和人工安装，再核对安装摘要及业务状态；不会重跑一次性安装器，也不会扩大 deploy SSH 权限。应用随后仍通过受保护 PR、完整 CI 和 main 发布确切 SHA。

本次恢复没有创建 Agent、登录会话、付费推理、链上业务、合约部署或 grant 续期；没有导入或恢复 Mac 上的陈旧状态。本机旧 writer 保持停止。

## 证据

私密诊断、权限检查和恢复结果保存在 `.data/upstream-sync-20261015/recovery/`，独立复核保存在同轮 `review/`。VPS 保留失败请求、构建包、冷备和 `/var/lib/tabby-tempo-cicd/incidents/f8c15e2e883746249b48cef608faf4f1-recovery.json`。这些原始材料不公开，公开清单只列摘要和脱敏结论。

日常发布、手动重试、回滚和可信入口升级流程见 [CI/CD 运维说明](../deploy/tempo-vps/cicd/README.md)。
