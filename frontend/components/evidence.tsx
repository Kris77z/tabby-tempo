import { amount, short } from "../lib/format";
import type { EvidenceRow, PublicConfig } from "../lib/types";
import { Icon } from "./icons";
export function ExplorerLink({ config, hash, label }: { config: PublicConfig; hash: string; label?: string }) {
  return config.explorerUrl ? <a className="mono tx-link" href={`${config.explorerUrl}/tx/${hash}`} target="_blank" rel="noopener noreferrer">{label || short(hash)} <Icon name="external" size={12} /></a> : <span className="mono">{label || short(hash)}</span>;
}
export function Evidence({ rows, config }: { rows: EvidenceRow[]; config: PublicConfig }) {
  return <section className="evidence-section" aria-labelledby="evidence-heading">
    <div className="section-heading"><div><span className="eyebrow">ONCHAIN PROOF</span><h2 id="evidence-heading">资金流与链上证据</h2></div><span className="muted">最近 {rows.length} 笔交易 · 可展开回执</span></div>
    {rows.length === 0 ? <p className="empty-inline">当前读取范围内暂无支付或结算交易。</p> : <div className="ledger">
      {rows.map(row => <details className="ledger-row" key={row.hash}>
        <summary>
          <span className={`event-icon ${row.kind}`}><Icon name={row.kind === "payment" ? "routing" : row.kind === "settlement" ? "check" : "shield"} /></span>
          <span className="ledger-main"><strong>{row.kind === "payment" ? "Provider payment" : row.kind === "settlement" ? `任务验收 ${row.passed ? "PASS" : "FAIL"}` : row.kind === "default" ? "Loan default" : "任务已接受"}</strong>
            <span>{row.kind === "payment" ? `cash ${amount(row.fromCash || "0", config.asset.decimals)} + credit ${amount(row.fromCredit || "0", config.asset.decimals)} ${config.asset.symbol}` : `Task #${row.taskId || "—"} · ${row.events.map(e => e.name).slice(0, 3).join(" + ")}`}</span></span>
          <span className="ledger-meta"><span className="mono">{short(row.hash, 4)}</span><span>Block {row.block.toLocaleString("en-US")}</span></span><Icon name="chevron" size={15} />
        </summary>
        <div className="receipt-detail"><div className="receipt-top"><strong>Transaction receipt</strong><ExplorerLink config={config} hash={row.hash} label="打开链上交易" /></div>
          <dl className="detail-list"><div><dt>txHash</dt><dd className="mono wrap">{row.hash}</dd></div><div><dt>status</dt><dd>{row.receiptStatus === 1 ? "1 · confirmed" : "0 · reverted"}</dd></div>
            {row.paymentId ? <div><dt>paymentId</dt><dd className="mono wrap">{row.paymentId}</dd></div> : null}
            {row.evidenceHash ? <div><dt>evidenceHash</dt><dd className="mono wrap">{row.evidenceHash}<small>从 payProvider calldata 解析；对应 Underwriter 证据承诺。</small></dd></div> : null}</dl>
          <div className="event-list">{row.events.map((event, i) => <div key={i}><span className="event-dot" /><strong>{event.contract}.{event.name}</strong><code>{Object.entries(event.values).map(([key, value]) => `${key}: ${value}`).join(" · ")}</code></div>)}</div>
          {row.kind === "settlement" ? <p className="muted receipt-note">receipt status=1 仅说明交易成功；FeedbackSent / pendingFeedback 才能证明声誉写回状态。</p> : null}
        </div>
      </details>)}
    </div>}
  </section>;
}
