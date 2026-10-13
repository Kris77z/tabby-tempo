import { amount, datetime, fee, ratio, short, taskCreditCap } from "../lib/format";
import { LOAN_STATUS, TASK_STATUS, type Profile, type PublicConfig, type TaskRow } from "../lib/types";
import { Evidence } from "./evidence";
import { Icon } from "./icons";

function TaskTable({ tasks, config, onTask }: { tasks: TaskRow[]; config: PublicConfig; onTask: (id: string) => void }) {
  return tasks.length ? <div className="task-table"><div className="task-table-head"><span>任务 / 状态</span><span>Reward / 净 escrow</span><span>债务 / 反馈</span><span /></div>
    {tasks.map(task => <div className="task-table-row" key={task.id}><div><strong className="mono">Task #{task.id}</strong><span className={`status-label status-${task.status}`}>{TASK_STATUS[task.status] || "Unknown"}</span><small>到期 {datetime(task.deadline)}</small></div>
      <div><strong>{amount(task.reward, config.asset.decimals)} <span className="unit">{config.asset.symbol}</span></strong><small>净 {amount(task.netEscrow, config.asset.decimals)} · 协议费 {fee(task.protocolFeeBps)}</small></div>
      <div><strong>{amount(BigInt(task.loan.principal) + BigInt(task.loan.fee), config.asset.decimals)} <span className="unit">{LOAN_STATUS[task.loan.status]}</span></strong>
        <small>{task.feedback.successPending || task.feedback.repaymentPending || task.feedback.defaultPending ? "反馈 pending · 待 retry" : task.feedback.repaymentSent ? "repayment 已写回" : task.feedback.successSent ? "task-success 已写回" : "尚无声誉写回"}</small></div>
      <button className="text-button" onClick={() => onTask(task.id)} aria-label={`打开 Task ${task.id} 演示面板`}><Icon name="arrow" /></button></div>)}
  </div> : <p className="empty-inline">当前 Agent 尚未接受任务。</p>;
}
export function ProfileView({ profile, config, onTask }: { profile: Profile; config: PublicConfig; onTask: (id: string) => void }) {
  const c = profile.credit;
  const active = profile.tasks.find(t => t.status === 2) || profile.tasks[0];
  const taskCap = active ? taskCreditCap(active.netEscrow, c.configuration.ltvBps, c.terms.feeBps, c.tierCap) : 0n;
  const frozen = c.identity.changed || c.managerFrozen || c.accountFrozen || profile.policy.ownerFrozen;
  const asAsset = (raw: string | bigint) => amount(raw, config.asset.decimals);
  return <>
    <div className="profile-hero"><div><span className="eyebrow">AGENT FINANCIAL IDENTITY</span><h1>{profile.agent.name.split(" · ")[0]}<span className="agent-id">#{profile.agent.id}</span></h1><p>ERC-8004 的信誉，成为 Agent 可使用的资本。</p>
      <div className="hero-tags"><span className={`tag ${frozen ? "warning" : "positive"}`}><span className="dot" />{frozen ? "Frozen" : c.eligible ? "Credit eligible" : "Credit unavailable"}</span><span className="tag neutral">ERC-8004 · v{c.identity.version}</span><span className="tag neutral">{config.asset.symbol} · {config.asset.decimals} decimals</span></div></div>
      <div className={`score-block tier-${c.terms.tier.toLowerCase()}`}><span className="eyebrow">INFERSCORE</span><div className="score-number">{c.terms.score}<span className="tier-badge">Tier {c.terms.tier}</span></div><span className="score-caption">链上记录支撑的授信评分</span></div></div>
    {!c.eligible || frozen ? <div className="state-notice"><Icon name="shield" /><div><strong>{c.identity.changed ? "identityChanged · 身份变更" : c.rejection || "OWNER_FROZEN"}</strong><p>{c.identity.changed ? "当前 registry owner / wallet 与入网快照不同，旧授信不能继续使用。" : "授信暂停；已有债务仍按任务状态结算。"} Manager frozen: {String(c.managerFrozen)} · Account frozen: {String(c.accountFrozen)} · drawPaused: {String(c.drawPaused)}</p></div></div> : null}
    <section className="balance-sheet" aria-label="Agent 资金概览"><div className="balance-sheet-top"><span className="eyebrow">CAPITAL POSITION</span><span className="muted">{config.network} · {config.asset.symbol} settlement</span></div>
      <div className="balance-grid"><div><span className="metric-label"><span className="legend-dot cash" />Cash balance</span><strong>{asAsset(profile.cash)}<span>{config.asset.symbol}</span></strong><p>AgentAccount 可用现金</p></div>
        <div><span className="metric-label"><span className="legend-dot credit" />Tier 单任务本金上限</span><strong>{asAsset(c.tierCap)}<span>{config.asset.symbol}</span></strong><p>实际授信受净 escrow 与限额约束</p></div>
        <div><span className="metric-label"><span className="legend-dot debt" />Outstanding debt</span><strong>{asAsset(profile.debt)}<span>{config.asset.symbol}</span></strong><p>所有 Active loan 的本金 + factor fee</p></div></div>
      <div className="credit-usage"><div className="usage-label"><span>{active ? `Task #${active.id} · 单任务额度` : "尚无任务授信"}</span><strong>{active ? `${asAsset(active.loan.principal)} / ${asAsset(taskCap)} ${config.asset.symbol}` : "—"}</strong></div>
        <div className="usage-track" role="progressbar" aria-label="当前任务本金使用比例" aria-valuenow={ratio(active?.loan.principal || "0", taskCap)} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${ratio(active?.loan.principal || "0", taskCap)}%` }} /></div>
        <p>{active ? `min(Tier cap, 净 escrow × ${fee(c.configuration.ltvBps)} ÷ (1 + ${fee(c.terms.feeBps)}))。${active.loan.status !== 0 ? "本任务已有 loan，不能重复 draw。" : c.eligible ? "签发后仍需通过链上限额与资金池检查。" : "当前 Agent 无新增授信资格。"}` : "授信绑定 Agent × Task；接受任务后计算本金上限。"}</p></div>
    </section>
    <div className="trust-grid"><section className="trust-section"><div className="section-heading compact"><div><span className="eyebrow">REPUTATION → CREDIT</span><h2>每一次还款，都留下记录</h2></div><span className="tag neutral">Factor fee {fee(c.terms.feeBps)}</span></div>
      <div className="count-grid"><div><strong>{c.truth.repayment}</strong><span>真实还款 · Manager</span></div><div><strong>{c.mirror.success}</strong><span>任务成功 · Mirror</span></div><div className={BigInt(c.truth.default) ? "danger-text" : ""}><strong>{c.truth.default}</strong><span>真实违约 · Manager</span></div></div>
      <details className="score-explanation"><summary>查看评分与 Tier 依据 <Icon name="chevron" size={13} /></summary><div><p>InferScore = 500 + 40 × min(repayment, 10) + 30 × min(task-success, 10) − 400 × default</p><p>Mirror：repayment {c.mirror.repayment} · task-success {c.mirror.success} · default {c.mirror.default}。仅消费 Adapter / infercredit 的反馈 count。</p><p>Tier A 需评分 ≥700 且 Mirror / Manager 还款都 ≥3；Tier B 需评分 ≥580 且两者还款都 ≥1。任一来源 default &gt;0 会拒绝授信。</p></div></details>
    </section><section className="identity-section"><div className="section-heading compact"><div><span className="eyebrow">IDENTITY & POLICY</span><h2>身份与资金边界</h2></div><Icon name="shield" size={20} /></div>
      <dl className="identity-list"><div><dt>Registry owner</dt><dd className="mono" title={c.identity.owner}>{short(c.identity.owner)}</dd></div><div><dt>Registry wallet</dt><dd className="mono" title={c.identity.wallet}>{short(c.identity.wallet)}</dd></div><div><dt>每笔 cash / debt</dt><dd>{asAsset(profile.policy.maxCashPerTx)} / {asAsset(profile.policy.maxDebtPerTx)} {config.asset.symbol}</dd></div><div><dt>每日 debt 上限</dt><dd>{asAsset(profile.policy.maxDebtPerDay)} {config.asset.symbol}</dd></div><div><dt>ownerFrozen</dt><dd>{String(profile.policy.ownerFrozen)}</dd></div></dl>
    </section></div>
    <section className="tasks-section"><div className="section-heading"><div><span className="eyebrow">TASK-BACKED CREDIT</span><h2>任务与结算</h2></div><span className="muted">本金与 fee 使用 {config.asset.decimals} 位资产单位</span></div><TaskTable tasks={profile.tasks} config={config} onTask={onTask} /></section>
    <Evidence rows={profile.evidence} config={config} />
  </>;
}
