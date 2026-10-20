# 只读经营记录

Agent结算贡献、平台归属费用、供应商已知收款和补贴/资本分别呈现，不能简单相加为整体利润。缺失成本、链费、待确认付款会明确标注。链费排除提示在结算贡献旁可见。

Hosted42431输出PathUSD。`operating:demo`与`operating:report --input /absolute/file`是独立合成/操作者声明工具，固定USDC六位单位，不接收Tempo资产凭据，也不验证声明账单。其digest只是引用，实际利润保持null；不能把PathUSD输入当已验证USDC账目。

假设现金/补贴runway与真实结果分开；无burn记录不填0、不推无限期。见 [Review](REVIEW.md)。
