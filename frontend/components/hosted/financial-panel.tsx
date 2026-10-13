import type { HostedAgent, HostedFinance } from "../../lib/hosted-client";
import type { useHostedFinance } from "../../lib/use-hosted-finance";
import { settlementSymbol } from "../../lib/networks";
import { amount, fee } from "../../lib/format";
import { Card, CardContent } from "./agora-primitives";
import styles from "./hosted.module.css";

const time = (value: string | number) => new Date(value).toLocaleString("zh-CN", { hour12: false });
const reasons: Record<string, string> = {
  HOSTED_FINANCE_NOT_BOUND: "Agent 链上身份尚未就绪。", HOSTED_FINANCE_NOT_CONFIGURED: "金融读取服务尚未配置。",
  HOSTED_FINANCE_LEDGER_LIMIT: "任务账本超过读取上限，未确认完整债务。", HOSTED_FINANCE_TIMEOUT: "链上读取超时。",
  HOSTED_FINANCE_UNDERWRITER_UNAVAILABLE: "Underwriter 暂时不可用。", HOSTED_FINANCE_UNCONFIRMED: "链上金融状态暂未确认。",
  HOSTED_FINANCE_SNAPSHOT_REORG: "快照区块已变化，需要重新读取。", HOSTED_FINANCE_BINDING_MISMATCH: "链上身份或协议配置尚未核验。",
};
const rejection: Record<string, string> = { PROTOCOL_DEFAULT: "存在真实违约", MIRRORED_DEFAULT: "存在声誉违约记录", NOT_ENROLLED: "尚未 enroll", IDENTITY_CHANGED: "链上身份已变更", IDENTITY_UNBOUND: "钱包未绑定", PROTOCOL_FROZEN: "协议已冻结", DRAW_PAUSED: "协议暂停授信" };
export function creditChanges(current: Extract<HostedFinance, { status: "confirmed" }>, previous?: Extract<HostedFinance, { status: "confirmed" }>): string[] {
  if (!previous || previous.agentId !== current.agentId || previous.wallet !== current.wallet || previous.chainId !== current.chainId) return [];
  const changes: string[] = [], symbol = settlementSymbol(current.chainId);
  if (previous.credit.score !== current.credit.score) changes.push(`InferScore ${previous.credit.score} → ${current.credit.score}`);
  if (previous.credit.tier !== current.credit.tier) changes.push(`Tier ${previous.credit.tier} → ${current.credit.tier}`);
  if (previous.credit.tierCapRaw !== current.credit.tierCapRaw) changes.push(`本金上限 ${amount(previous.credit.tierCapRaw, 6)} → ${amount(current.credit.tierCapRaw, 6)} ${symbol}`);
  if (previous.counts.repayments !== current.counts.repayments) changes.push(`真实还款 ${previous.counts.repayments} → ${current.counts.repayments}`);
  if (previous.cashRaw !== current.cashRaw) changes.push(`cash ${amount(previous.cashRaw, 6)} → ${amount(current.cashRaw, 6)} ${symbol}`);
  if (previous.debtRaw !== current.debtRaw) changes.push(`未偿债务 ${amount(previous.debtRaw, 6)} → ${amount(current.debtRaw, 6)} ${symbol}`);
  return changes;
}
export function FinancialPanel({ agent, finance }: { agent: HostedAgent; finance: ReturnType<typeof useHostedFinance> }) {
  const symbol = settlementSymbol(agent.binding?.chainId);
  const snapshot = finance.value?.status === "confirmed" ? finance.value : null;
  const changes = snapshot && !finance.stale ? creditChanges(snapshot, finance.previous) : [];
  const creditEnabled = snapshot?.credit.eligible && !snapshot.policy.ownerFrozen && agent.allowCredit && BigInt(snapshot.policy.maxDebtPerTxRaw) > 0n && BigInt(snapshot.policy.maxDebtPerDayRaw) > 0n;
  return <Card><CardContent><section aria-label="信用与结算快照" data-testid="hosted-financial-snapshot">
    <div className={styles.rowBetween}><h2>信用飞轮</h2><button className={styles.textButton} disabled={finance.loading} onClick={() => void finance.refresh()} aria-label="刷新金融快照">{finance.loading ? "读取中…" : "刷新"}</button></div>
    <p className={styles.resourceKind}>CHAIN IDENTITY · #{agent.binding?.agentId ?? "待绑定"}</p>
    {finance.error ? <p className={styles.financeWarning} role="status">{reasons[finance.error] ?? "金融状态暂未确认。"}{snapshot ? " 以下保留上次已核验快照。" : " cash、债务和评分尚不可用。"}</p> : null}
    {snapshot ? <>
      <div className={styles.creditScore}><span>InferScore <strong>{snapshot.credit.score}</strong></span><span>Tier <strong>{snapshot.credit.tier}</strong></span></div>
      <dl className={styles.factList}>
        <div><dt>cash</dt><dd>{amount(snapshot.cashRaw, 6)} {symbol}</dd></div>
        <div><dt>未偿债务（含 fee）</dt><dd>{amount(snapshot.debtRaw, 6)} {symbol}</dd></div>
        <div><dt>Tier 本金上限</dt><dd>{amount(snapshot.credit.tierCapRaw, 6)} {symbol}</dd></div>
        <div><dt>借款 fee</dt><dd>{fee(snapshot.credit.feeBps)}</dd></div>
        <div><dt>任务授信</dt><dd>{creditEnabled ? "可申请" : !snapshot.credit.eligible ? rejection[snapshot.credit.rejection ?? ""] ?? "暂不可申请" : !agent.allowCredit ? "本人已关闭" : "策略已限制"}</dd></div>
        <div><dt>真实还款 / 违约</dt><dd>{snapshot.counts.repayments} / {snapshot.counts.defaults}</dd></div>
        <div><dt>声誉还款 / 成功 / 违约</dt><dd>{snapshot.counts.mirrorRepayments} / {snapshot.counts.successes} / {snapshot.counts.mirrorDefaults}</dd></div>
      </dl>
      {snapshot.counts.repayments !== snapshot.counts.mirrorRepayments ? <p className={styles.financeWarning}>真实还款与声誉镜像计数不同；评分和 Tier 采用 Underwriter 当前已确认结果。</p> : null}
      {changes.length ? <p className={styles.financeChanges} role="status">本次刷新：{changes.join("；")}</p> : null}
      <p className={styles.help}>{finance.stale ? "上次快照" : "已核验快照"} · chain {snapshot.chainId} · 区块 #{snapshot.block.number}<br />区块时间 {time(snapshot.block.timestamp * 1000)}<br />读取时间 {time(snapshot.observedAt)}</p>
      <p className={styles.help}>完整读取 {snapshot.scannedTaskCount} 项任务，本人 {snapshot.ownedTaskCount} 项。成功信用还款写入声誉后，Underwriter 更新评分与 Tier。每笔授信仍需核验任务和协议额度。</p>
    </> : <p className={styles.help}>{finance.loading ? "正在读取本 Agent 的链上账本与 Underwriter。" : "等待已核验的金融快照。"}</p>}
  </section></CardContent></Card>;
}
