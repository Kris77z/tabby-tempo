# 有界经济反馈

`npm run economics:bounded` 默认shadow，`--execute-local`只运行owned Anvil和固定Docker。冻结任务数、总支出、单次价格、现金保留、最低结算贡献和绝对截止；建议不能直接扩额或改变原授权。

实际成功、已付失败、退款、资本和游戏补贴分开保留。Unknown先阻止后续任务，原请求解决后只能继续原未耗尽政策；冷实例不会重置计数。这里只核对结算资产贡献，链费和供应商成本不完整时实际净利润未知。

参见 [经济准入](ECONOMICS.md) 和 [独立 Worker](INDEPENDENT-ECONOMY.md)。
