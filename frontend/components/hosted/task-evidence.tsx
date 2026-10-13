import type { HostedRun } from "../../lib/hosted-client";
import { amount, short } from "../../lib/format";
import { hostedTransactionUrl, settlementSymbol } from "../../lib/networks";
import styles from "./hosted.module.css";

export function transactionUrl(chainId: string | undefined, hash: string): string | null {
  return hostedTransactionUrl(chainId, hash);
}
export function TransactionEvidence({ hash, chainId, label }: { hash: string; chainId?: string; label: string }) {
  const href = transactionUrl(chainId, hash);
  return href ? <a className={styles.transactionLink} href={href} target="_blank" rel="noopener noreferrer" title={hash}>{label} · {short(hash, 6)} ↗</a>
    : <span className={styles.transactionLink} title={hash}>{label} · <code>{short(hash, 6)}</code>{chainId === "31337" ? "（本地链）" : ""}</span>;
}
export function TaskSettlementSummary({ run, chainId }: { run: HostedRun; chainId?: string }) {
  if (!["task", "reward-task", "metered-task"].includes(run.action)) return null;
  const result = run.result, settlement = result?.settlement;
  const symbol = settlementSymbol(result?.chainId ?? chainId);
  return <section className={styles.settlementSummary} aria-label="任务结算摘要">
    <h4>任务结算</h4>
    {result?.fromCashRaw !== undefined && result.fromCreditRaw !== undefined ? <p>cash 支付 {amount(result.fromCashRaw, 6)} · 信用支付 {amount(result.fromCreditRaw, 6)} {symbol}</p> : null}
    {settlement ? <>
      <p>{settlement.passed ? "链上任务通过" : "链上任务失败"} · 实际还款 {amount(settlement.repaidRaw, 6)} {symbol} · 结算入账 {amount(settlement.residualRaw, 6)} {symbol}</p>
      {BigInt(settlement.slashedRaw) > 0n ? <p>escrow 清偿 {amount(settlement.slashedRaw, 6)} {symbol}</p> : null}
      <p>借款状态：{({ "0": run.action === "reward-task" ? "奖励额度，无借款" : "纯 cash，无借款", "2": "已足额还款", "3": "违约已清算", "4": "退款已关闭" } as Record<string, string>)[settlement.loanStatus]}</p>
      <TransactionEvidence hash={settlement.txHash} chainId={result?.chainId ?? chainId} label="查看结算交易" />
      <p className={styles.help}>TaskSettled 已核验 · 区块 #{settlement.block.number} · {new Date(settlement.block.timestamp * 1000).toLocaleString("zh-CN", { hour12: false })}</p>
    </> : <p className={styles.help}>尚无已核验的 TaskSettled 结算凭证。接单与付款记录不能确认结算。</p>}
  </section>;
}
