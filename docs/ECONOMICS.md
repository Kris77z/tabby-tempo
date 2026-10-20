# 任务经济准入

新任务使用冻结版本1政策：最低结算贡献1 raw、借款费上限1500 bps，计入完整执行报价和已分摊规划成本。任务收入和托管余额须有固定区块及canonical重验；不够覆盖已知成本时，在新付款前停止。无任务或首轮经济不可行且零完成不标成功；有任务低余额时仍可按原已配置游戏规则补充资金。

旧snapshot没有经济政策时沿原配置和签名恢复，不把新政策回写旧请求。模型建议不构成付款授权。已签付款保留原handle；Unknown不重签、不新增派发。

本层是 `settlement-asset-only`。42431金额显示PathUSD，链费仍未归集；`chainFeesRaw` 和 `actualProfitRaw` 为null。因此结算贡献不是完整净利润。type2付款沿现有签名解析和手续费保护；Tempo type0x76当前明确不支持并在广播前拒绝，不凭本地Anvil结果声称该格式已适配。

只读 accounting、strategy-advice、operating-report 由owner会话保护，受限读取保留journal，包含不完整/Unknown状态，不获得恢复、签名或模型调用权限。外部声明的成本不是已认证账单。
