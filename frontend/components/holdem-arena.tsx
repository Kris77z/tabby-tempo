"use client";
import { useEffect, useRef, useState } from "react";
import { amount, short } from "../lib/format";
import type { HoldemPhase, HoldemReport, HoldemSnapshot, HoldemStep } from "../lib/holdem-types";
import { Icon } from "./icons";
import { TerminalHeader } from "./terminal/terminal-header";
import { HoldemMonadEvidence } from "./holdem-monad-evidence";

const streets = { preflop: "翻牌前", flop: "翻牌", turn: "转牌", river: "河牌" };
const phases: Record<HoldemPhase, string> = { Starting: "准备中", Running: "牌局进行中", Complete: "牌局已结束", Stopped: "已停止 · 未结算", PreflightFailed: "预检失败 · 未开始", SettlementUncertain: "结算未确定 · 已暂停" };
const strategies = { scripted: "本地受控策略", "controlled-model": "受控模型上游", "real-model": "真实 Kimi 上游 · 报告声明" };
const networks = { "local-anvil": "本地 Anvil / mock-USDC", "monad-testnet": "Monad Testnet", "monad-mainnet": "Monad Mainnet", unknown: "链未标明" };
const outcomes = { IntentPersisted: "已记录调用意图", Applied: "合法动作已执行", HTTPRejected: "上游拒绝", ResponseInvalid: "响应无效", OutcomeUnknown: "结果未知 · 已暂停", DeadlineExpired: "超时 · 已暂停" };
const actions = { fold: "弃牌", check: "过牌", call: "跟注", "all-in": "全下", raise: "加注" };
function actionLabel(step: HoldemStep) { return step.action.type === "raise" ? `加注至 ${step.action.to}` : actions[step.action.type]; }
function winnerLabel(report: HoldemReport) { const winners = report.game.result?.winners; return winners?.length === 2 ? "平局 · 双方分配" : winners?.length ? `座位 ${winners[0] + 1} 获胜` : "尚无终局"; }
function Card({ value }: { value?: string }) {
  const suits: Record<string, string> = { c: "♣", d: "♦", h: "♥", s: "♠" };
  return <span className={`holdem-card${value && /[hd]$/.test(value) ? " red" : ""}${value ? "" : " empty"}`} aria-label={value ? `${value[0]}${suits[value[1]]}` : "尚未发出的公共牌"}>{value ? <><b>{value[0] === "T" ? "10" : value[0]}</b><span>{suits[value[1]]}</span></> : "·"}</span>;
}
function Tx({ hash, label, fixture }: { hash: string; label: string; fixture: boolean }) {
  return <details className="holdem-tx"><summary>{fixture ? "示例" : "已记录"}{label} <code>{short(hash, 5)}</code></summary><code className="wrap">{hash}</code></details>;
}
function Evidence({ report, fixture }: { report: HoldemReport; fixture: boolean }) {
  const items: [string, boolean | undefined][] = [["报告内验证", report.verified], ["可信重放验证记录", report.evidence.publicReplayVerified], ["链回执文件已记录", report.evidence.chainEvidenceRecorded], ["奖励资金守恒", report.verification.rewardConserved], ["推理未使用信用", report.verification.fromCredit === undefined ? undefined : report.verification.fromCredit === "0"]];
  return <section className="holdem-panel holdem-evidence"><div className="section-heading compact"><div><span className="eyebrow">EVIDENCE BOUNDARY</span><h2>证据状态</h2></div><Icon name="shield" /></div><dl>{items.map(([label, passed]) => <div key={label}><dt>{label}</dt><dd className={`tag ${fixture || passed === undefined ? "neutral" : passed ? "positive" : "warning"}`}>{fixture ? "示例" : passed === undefined ? "未提供" : passed ? "报告通过" : "未确认"}</dd></div>)}</dl><p>页面只读取公开报告文件，不连接链核验。哈希与余额是该次运行的记录；本地 Anvil 关闭后不能恢复原链。</p><p>公开回放不含底牌、完整牌堆、模型提示或交易签名。随机发牌仍依赖可信裁判。</p></section>;
}

export default function HoldemArena({ initial, embedded = false }: { initial: HoldemSnapshot; embedded?: boolean }) {
  const [snapshot, setSnapshot] = useState(initial), [index, setIndex] = useState(0), [playing, setPlaying] = useState(false), [refreshing, setRefreshing] = useState(false), [readError, setReadError] = useState(initial.error?.message || "");
  const request = useRef<AbortController | null>(null);
  const fixture = snapshot.source === "fixture", report = embedded && fixture ? null : snapshot.report, last = report ? report.game.steps.length - (report.game.result ? 0 : 1) : 0;
  const position = Math.max(0, Math.min(index, last));
  useEffect(() => () => request.current?.abort(), []);
  useEffect(() => {
    if (!playing || !report || position >= last) return;
    const timer = setInterval(() => setIndex(previous => Math.min(previous + 1, last)), 1100);
    return () => clearInterval(timer);
  }, [playing, report, position, last]);
  async function refresh() {
    if (request.current) return;
    const controller = new AbortController(); request.current = controller;
    setRefreshing(true); setPlaying(false);
    try {
      const response = await fetch("/api/holdem", { cache: "no-store", signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]) });
      const value: HoldemSnapshot = await response.json();
      if (!response.ok || value.error || !value.report) throw new Error(value.error?.message || "公开德州报告读取失败。");
      if (!controller.signal.aborted) { setSnapshot(value); setIndex(0); setReadError(""); }
    } catch (error) { if (!controller.signal.aborted) setReadError(error instanceof Error ? error.message : "公开德州报告读取失败。"); }
    finally { request.current = null; if (!controller.signal.aborted) setRefreshing(false); }
  }
  const current = report?.game.steps[position], final = Boolean(report?.game.result && position === report.game.steps.length);
  const board = final ? report!.game.finalBoard : current?.board || report?.game.finalBoard || [];
  const stacks = final ? report!.game.result!.finalStacks : current?.stacks || (report ? [report.game.chips.initialPerSeat, report.game.chips.initialPerSeat] : [0, 0]);
  const decimals = report?.reward?.decimals ?? 6, asset = report?.network === "local-anvil" ? "mock-USDC" : "报告资产";
  const display = (raw: string) => `${amount(raw, decimals)} ${asset}`;
  const ended = position >= last;
  const move = (next: number) => { setPlaying(false); setIndex(next); };
  const content = <>
    {fixture && !embedded ? <div className="fixture-banner"><span className="tag warning">本地演示 · FIXTURE</span><span>未配置公开报告；当前牌局、奖励与哈希均为示例。</span></div> : <div className="holdem-snapshot-banner"><span className="tag neutral">{fixture && embedded ? "暂无真实报告" : "公开报告 · 文件快照"}</span><span>{report ? `${networks[report.network]} · ${strategies[report.strategy]}` : fixture ? "未配置真实报告 · 示例不作为 GameFi 数据" : "服务端报告不可用"} · 页面未联机核验</span></div>}
    {readError ? <div className="read-error" role="alert">{readError}{report ? " 下方保留上次成功快照。" : ""}</div> : null}
    <div className="demo-hero holdem-hero"><div><span className="eyebrow">SPONSORED HEADS-UP HOLD’EM</span>{embedded ? <h2>{report ? report.strategy === "real-model" ? "真实模型德州 · 最新对局" : "德州 · 最新运行报告" : "德州 GameFi"}</h2> : <h1>德州 Arena</h1>}<p>免费参赛 · 非兑换虚拟筹码 · 固定赞助奖 · 奖励到账后购买推理</p></div>{report ? <span className={`tag ${report.phase === "Complete" ? "positive" : "warning"}`}>{phases[report.phase]}</span> : null}</div>
    {report ? <>{embedded ? <GameFiFacts snapshot={snapshot} report={report} /> : <div className="holdem-facts"><div><span>报名费</span><strong>{display(report.game.entryFee)}</strong></div><div><span>赞助奖 · 与筹码奖池独立</span><strong>{report.reward ? display(report.reward.rawAmount) : "尚未结算"}</strong></div><div><span>决策来源</span><strong>{strategies[report.strategy]}</strong><small>调用意图 {report.strategyInference?.calls ?? report.game.strategyInferenceCalls}{report.strategyInference ? ` / ${report.strategyInference.maxCalls}` : ""}</small></div><div><span>比赛</span><strong className="mono holdem-match">{report.matchId}</strong><small>{winnerLabel(report)}</small></div></div>}
      {report.phase !== "Complete" ? <div className="state-notice" role="status"><Icon name="shield" /><div><strong>{phases[report.phase]}</strong><p>{report.phase === "SettlementUncertain" ? "终局已确认，结算仍未确定。只展示报告里已经记录的证据，请通过原 CLI 继续核查。" : "牌局没有可结算终局；不会显示赢家或奖励到账。"}{report.reason ? ` 原因代码：${report.reason}` : ""}</p></div></div> : null}
      <div className="holdem-replay-grid"><section className="holdem-panel holdem-replay"><div className="section-heading compact"><div><span className="eyebrow">PUBLIC REPLAY</span><h2>公开牌局回放</h2></div><span className="tag neutral">{final ? "终局" : current ? streets[current.street] : "等待第一步"}</span></div><div className="holdem-table"><div className="holdem-table-info"><span>{final ? "争夺奖池 · 已分配" : "行动前奖池"}</span><strong data-testid="holdem-pot">{final ? report.game.result!.contestedPot : current?.pot ?? 0}<small> 虚拟筹码</small></strong></div><div className="holdem-board" aria-label="公共牌">{Array.from({ length: 5 }, (_, i) => <Card key={i} value={board[i]} />)}</div><div className="holdem-seats">{([0, 1] as const).map(seat => <div key={seat} className={`holdem-seat${!final && current?.seat === seat ? " actor" : ""}`}><span className="holdem-seat-name">座位 {seat + 1}{final && report.game.result!.winners.includes(seat) ? " · 获胜" : !final && current?.seat === seat ? " · 行动方" : ""}</span><strong data-testid={`holdem-stack-${seat}`}>{stacks[seat].toLocaleString("en-US")}</strong><div className="holdem-hidden" aria-label={`座位 ${seat + 1} 底牌不公开`}><span>?</span><span>?</span><small>底牌不公开</small></div></div>)}</div></div><div className="holdem-current" aria-live="polite">{final ? `${winnerLabel(report)} · ${report.game.result!.reason === "showdown" ? "摊牌判定" : "弃牌结束"}` : current ? `第 ${position + 1} 步 · 座位 ${current.seat + 1} 将${actionLabel(current)}` : "报告暂无公开动作。"}</div><div className="holdem-replay-controls"><button className="button secondary small" onClick={() => move(0)} disabled={position === 0}>回到开始</button><button className="button secondary small" onClick={() => move(position - 1)} disabled={position === 0}>上一步</button><button className="button primary small" onClick={() => { if (ended) setIndex(0); setPlaying(value => !value || ended); }} disabled={last <= 0}>{playing && !ended ? "暂停" : "播放"}</button><button className="button secondary small" onClick={() => move(position + 1)} disabled={ended}>下一步</button><button className="button secondary small" onClick={() => move(last)} disabled={ended}>{report.game.result ? "查看终局" : "最后一步"}</button></div><label className="holdem-range">回放进度 · {final ? `${report.game.steps.length} 步后终局` : report.game.steps.length ? `${position + 1} / ${report.game.steps.length} 步` : "0 步"}<input aria-label="回放进度" type="range" min={0} max={Math.max(0, last)} value={position} onChange={event => move(Number(event.target.value))} disabled={last <= 0} /></label><p className="control-note">每一步展示行动前的公共牌、筹码和奖池；点击下一步查看行动后的下一局面。终局筹码已包含派池与退款。</p><details className="holdem-actions"><summary>全部公开动作 · {report.game.steps.length} 步</summary><ol>{report.game.steps.map((step, i) => <li key={i}><button className={position === i ? "selected" : ""} onClick={() => move(i)}>{i + 1}. {streets[step.street]} · 座位 {step.seat + 1} · {actionLabel(step)} <span>pot {step.pot}</span></button></li>)}</ol></details></section><Evidence report={report} fixture={fixture} /></div>
      {report.strategyInference ? <section className="holdem-panel holdem-model"><div className="section-heading compact"><div><span className="eyebrow">BOUNDED STRATEGY INFERENCE</span><h2>模型决策记录</h2></div><span className="tag neutral">{report.strategyInference.vendorInvoiceVerified ? "上游账单已核验" : "上游账单未核验"}</span></div><p>决策推理由赞助方的上游账号支付；这些调用意图与局末获奖消费分开记录。预算上限 {report.strategyInference.maxCalls} 次，已记录 {report.strategyInference.calls} 次。</p><div className="holdem-attempts">{report.strategyInference.attempts.length ? report.strategyInference.attempts.map((attempt, i) => <div key={i}><strong>动作 {attempt.turn} · 座位 {attempt.seat + 1}</strong><code>{attempt.requestedModel}</code><span>{outcomes[attempt.outcome]}{attempt.status !== undefined ? ` · HTTP ${attempt.status}` : ""}</span><small>{attempt.durationMs !== undefined ? `${attempt.durationMs} ms` : ""}{attempt.usage?.total_tokens !== undefined ? ` · ${attempt.usage.total_tokens} tokens` : ""}</small></div>) : <p>尚无模型调用意图。</p>}</div></section> : null}
      <HoldemMonadEvidence delivery={snapshot.delivery} purchase={snapshot.purchase} deliveryError={snapshot.deliveryError} purchaseError={snapshot.purchaseError} />
      {!embedded ? <section className="holdem-panel holdem-funding"><div className="section-heading compact"><div><span className="eyebrow">LOCAL REWARD → CASH → INFERENCE</span><h2>奖励到账，再购买推理</h2></div><span className="tag neutral">本地奖后推理 · 受控上游</span></div><p>赞助奖是固定资金分配，与牌局筹码奖池无兑换关系。奖励进入 Agent 钱包后存入 AgentAccount cash，再用 taskId=0 购买推理。</p>{report.inference?.purchases.length ? report.inference.purchases.map(purchase => { const transfer = report.reward?.transfers.find(item => item.seat === purchase.seat); return <article className="holdem-purchase" key={purchase.seat}><h3>座位 {purchase.seat + 1} · Agent #{purchase.agentId}</h3><div className="holdem-flow"><div><span className="step-number">01</span><strong>赞助奖励到账</strong><b>{display(purchase.award)}</b>{transfer ? <Tx hash={transfer.txHash} label="奖励交易" fixture={fixture} /> : <small>报告未提供奖励交易</small>}</div><div><span className="step-number">02</span><strong>存入 Account cash</strong><b>{display(purchase.deposited)}</b><Tx hash={purchase.depositTxHash} label="入金交易" fixture={fixture} /></div><div><span className="step-number">03</span><strong>现金购买推理</strong><b>{display(purchase.receipt.fromCash)}</b><Tx hash={purchase.receipt.txHash} label="付款交易" fixture={fixture} /><small>fromCredit {purchase.receipt.fromCredit} · taskId {purchase.receipt.taskId} · Block {purchase.receipt.blockNumber}</small></div></div><p className="control-note">{purchase.receipt.model || "未提供模型名"}{purchase.receipt.usage?.total_tokens !== undefined ? ` · usage ${purchase.receipt.usage.total_tokens} tokens` : ""} · 本次奖后推理由受控 HTTP 上游返回，不证明真实模型完成消费。</p></article>; }) : <div className="empty-inline">{report.reward ? "奖励已记录，报告尚无完成的推理购买。" : "尚无奖励或推理购买；需由 CLI 完成合法终局与结算。"}</div>}{report.balances?.before && report.balances?.afterPurchase ? <div className="holdem-balance"><div><span>原有 cash · 座位 1 / 2</span><strong>{display(report.balances.before.cash[0])} / {display(report.balances.before.cash[1])}</strong></div><div><span>奖后消费 cash · 座位 1 / 2</span><strong>{display(report.balances.afterPurchase.cash[0])} / {display(report.balances.afterPurchase.cash[1])}</strong></div><div><span>未偿本金 · 前 → 后</span><strong>{display(report.balances.before.totalOutstanding)} → {display(report.balances.afterPurchase.totalOutstanding)}</strong></div></div> : null}{report.reward?.repeatedSettlementPaidAgain !== undefined ? <p className="control-note">重复结算记录：{report.reward.repeatedSettlementPaidAgain ? "发生额外付款，需核查" : "未新增奖励付款"}。原有 cash 单列，不能计入比赛奖励。</p> : null}</section> : null}
      <footer className="data-footer"><span><span className="dot" />{fixture ? "Fixture snapshot" : "Public report snapshot"}{report.chainId ? ` · Chain ${report.chainId}` : ""}</span><span>读取时间 {snapshot.loadedAt.replace("T", " ").slice(0, 19)} UTC · 手动刷新 · 只读页面</span></footer></> : <div className="holdem-panel holdem-empty"><Icon name="shield" size={32} /><h2>公开报告暂不可用</h2><p>服务端尚未提供可用的真实对局报告。配置公开 report.json 后刷新；当前没有可展示的奖励或现金余额。</p></div>}
  </>;
  if (embedded) return <section className="af-gamefi-report" id="gamefi-match"><div className="af-gamefi-report-heading"><span className="af-badge">GAMEFI · 公开结果</span><button className="af-button" onClick={() => void refresh()} disabled={refreshing} aria-label="刷新德州报告"><Icon name="refresh" size={14} />{refreshing ? "读取中" : "刷新报告"}</button></div>{content}<p className="af-gamefi-cli">真实模型开赛、USDC 派奖与奖励现金购买推理由项目 CLI 执行。此页只读公开报告，不会发起模型付费或链上交易。</p></section>;
  return <div className="holdem-shell"><TerminalHeader workspace="holdem" section="holdem" status={fixture ? "FIXTURE" : report ? "REPORT FILE" : "UNAVAILABLE"} actions={<button className="button secondary small" onClick={() => void refresh()} disabled={refreshing} aria-label="刷新德州报告"><Icon name="refresh" size={13} />{refreshing ? "读取中" : "刷新报告"}</button>} boundary={<>公开报告与证据档案 · 固定运行记录独立于你的托管 Agent · 文件快照，页面未连接链核验</>} /><main id="main-content" className="holdem-main">{content}</main></div>;
}


function GameFiFacts({ snapshot, report }: { snapshot: HoldemSnapshot; report: HoldemReport }) {
  const { delivery, purchase } = snapshot;
  const paid = purchase?.purchases.filter(item => item.receipt);
  const paidRaw = paid?.length ? paid.reduce((total, item) => total + BigInt(item.receipt!.fromCash), 0n).toString() : undefined;
  const balances = purchase?.after?.cash ?? delivery?.balances.afterDeposit.cash;
  const display = (raw: string) => `${amount(raw, delivery?.decimals ?? 6)} TEST USDC`;
  const model = report.strategyInference?.attempts[0]?.requestedModel;
  return <><div className="holdem-facts af-gamefi-facts">
    <div><span>对局决策来源</span><strong>{strategies[report.strategy]}</strong><small>{model || "模型名未提供"} · 已记录 {report.strategyInference?.calls ?? report.game.strategyInferenceCalls} 次调用意图</small></div>
    <div><span>USDC 赞助奖励到账</span><strong>{delivery ? display(delivery.rewardRaw) : "未提供到账证据"}</strong><small>{delivery ? "Monad Testnet · 已存入 Account cash" : "不以本地奖励记录替代 Monad 到账"}</small></div>
    <div><span>奖励现金购买推理</span><strong>{paidRaw ? display(paidRaw) : "未提供付款证据"}</strong><small>{purchase ? `${purchase.model} · ${purchase.phase === "Complete" ? "推理已完成" : purchase.phase === "Stopped" ? "已暂停" : "仅有计划"}` : "尚无本次奖后购买报告"}</small></div>
    <div><span>{purchase?.after ? "奖后消费 cash · 报告时" : "奖励入金 cash · 报告时"}</span><strong>{balances ? `${display(balances[0])} / ${display(balances[1])}` : "未提供余额快照"}</strong><small>座位 1 / 2 · 文件快照</small></div>
  </div><p className="af-gamefi-match-id">比赛 <code>{report.matchId}</code> · {winnerLabel(report)}</p></>;
}
