# Tempo 离线审查入口

本轮迁入经济准入、经营记录、独立消费者和恢复机制，保留既有 paid-control、canonical 证据与失败即停规则。未合并、未部署，也没有以这些本地结果证明完整 Tempo 真实业务通过。

- `npm run review:check`：检查本仓库登记的 Tempo-owned 本地记录、类型、负例和独立 SDK。
- `npm run review:artifacts -- --output /absolute/new-directory`：生成只读审查包。
- `npm run review:artifacts -- --execute-local --output /absolute/new-directory`：明确启动本机 Anvil/Docker，使用合成模型响应生成新的五组记录。仅支持31337和loopback，不连接公共链或模型厂商。
- `node scripts/review-artifacts.mjs --verify /absolute/directory`：复核包的完整性。

记录来自 `docs/acceptance/tempo-local-20261020/` 的七个固定登记项；检查器验证金额守恒、原请求绑定、canonical记录、Unknown和重放计数。没有登记 Monad 历史或旧真实窗口，也不允许空登记通过。

哈希只能证明所检查的字节，不能独立认证供应商账单或外部证明。参见 [经济语义](ECONOMICS.md)、[独立 Worker](INDEPENDENT-ECONOMY.md)、[只读回放](REVIEW-REPLAY.md)。
