"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useHostedAgents } from "../../lib/hosted-agents-provider";
import { actionLabel, inputUsdc, reasonLabel, statusLabel, strategyLabel, usdcRaw, type HostedAgent, type HostedRun, type HostedCatalogModel, type HostedSponsorship } from "../../lib/hosted-client";
import { networkName, settlementSymbol } from "../../lib/networks";
import { amount, ratio, short } from "../../lib/format";
import { Icon } from "../icons";
import { Card, CardContent, Badge, StatusOrb, AgentIdentityCard, AgentServiceCard, CollapsibleSection, runTitle } from "./agora-primitives";
import { AgentSettingsForm } from "./agent-settings-form";
import { FinancialPanel } from "./financial-panel";
import { TaskSettlementSummary, TransactionEvidence } from "./task-evidence";
import styles from "./hosted.module.css";
import { TerminalHeader } from "../terminal/terminal-header";

const tabs = [{ id: "agents", label: "我的 Agent" }, { id: "tasks", label: "任务" }, { id: "arena", label: "竞技场" }, { id: "funds", label: "资金与额度" }, { id: "settings", label: "设置" }] as const;
type Tab = typeof tabs[number]["id"];
type MobilePane = "agent" | "requests" | "resources";
const panes: { id: MobilePane; label: string }[] = [{ id: "agent", label: "Agent" }, { id: "requests", label: "请求" }, { id: "resources", label: "资源" }];
const time = (value: string) => new Date(value).toLocaleString("zh-CN", { hour12: false });

/** Port of Agora dashboard/page.tsx: terminal title → session strip → 3/6/3 panels
 * → pinned operation input → connection footer. The hosted API remains the source of facts. */
export default function HostedApp() {
  const state = useHostedAgents();
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("agents"), [mobilePane, setMobilePane] = useState<MobilePane>("requests");
  const [modal, setModal] = useState<"edit" | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const agent = state.selected, symbol = settlementSymbol(agent?.binding?.chainId);
  const runs = state.snapshot?.runs.filter(run => run.agentId === agent?.id) ?? [];
  const lastCash = runs.find(run => run.result?.cashRaw !== undefined);
  const active = runs.find(run => run.requestId === agent?.activeRequestId);
  const blocked = state.busy || !!state.pending || !agent || agent.status !== "Ready" || !!agent.activeRequestId;
  const canRefuel = !state.busy && !state.pending && agent?.status === "Ready" && active?.action === "reward-task" && active.status === "Paused" && active.reason === "INFERENCE_FUNDING_REQUIRED";
  const canCashRefuel = !state.busy && !state.pending && agent?.status === "Ready" && (active?.action === "metered-task" || active?.action === "autonomous") && active.status === "Paused" && active.reason === "INFERENCE_FUNDING_REQUIRED";
  const modelLabel = (id: string) => state.snapshot?.models.find(model => model.id === id)?.label ?? id;
  useEffect(() => {
    const section = new URLSearchParams(window.location.search).get("section");
    if (tabs.some(item => item.id === section)) setTab(section as Tab);
  }, []);
  useEffect(() => {
    if (modal && dialog.current && !dialog.current.open) dialog.current.showModal();
    else if (!modal && dialog.current?.open) dialog.current.close();
  }, [modal]);
  useEffect(() => { if (state.access !== "authenticated") { setModal(null); setMobilePane("requests"); } }, [state.access]);
  function select(value: string) { setModal(null); state.select(value); }
  function navigate(value: Tab) { setTab(value); setMobilePane(value === "agents" ? "agent" : "requests"); }
  const transportStatus = state.access === "loading" ? "CONNECTING" : state.access === "unavailable" ? "UNAVAILABLE" : state.access === "signed-out" ? "SIGNED OUT" : active ? active.status.toUpperCase() : agent?.activeRequestId ? "PENDING" : "IDLE";

  return <div className={styles.shell} data-testid="hosted-terminal-shell">
    <a href="#hosted-content" className={styles.skipLink}>跳到工作台</a>
    {/* Original terminal title bar: window controls, shell prompt, wallet/history/status. */}
    <TerminalHeader section="hosted" workspace="hosted" title="AgentFuel 托管 Agent 工作台" testId="hosted-terminal-header" dotTestId="hosted-terminal-dot" status={transportStatus} actions={<>
        <button className={styles.iconButton} aria-label="刷新托管数据" disabled={state.refreshing || state.busy} onClick={() => { void state.refresh(); void state.finance.refresh(); }}><Icon name="refresh" size={13} /></button>
        <button className={styles.secondaryButton} disabled={state.access !== "authenticated" || !state.owner || state.busy || !!state.pending || !state.snapshot?.models.length} onClick={() => router.push("/onboarding")}>创建 Agent</button>
        {state.access === "authenticated" && state.owner ? <button className={styles.secondaryButton} disabled={state.busy} onClick={() => void state.logout()}>退出登录</button> : <button className={styles.secondaryButton} disabled={state.busy || state.access === "loading"} onClick={() => void state.login()}>{state.busy ? "等待钱包…" : "签名登录"}</button>}
      </>} />

    {/* Source dashboard mobile Agent / mission / mesh panel switcher. */}
    <div className={styles.mobileTabs} role="tablist" aria-label="工作台面板">
      {panes.map(pane => <button key={pane.id} id={"tab-" + pane.id} role="tab" aria-selected={mobilePane === pane.id} aria-controls={"panel-" + pane.id} onClick={() => setMobilePane(pane.id)}>{pane.label}</button>)}
    </div>
    <div className={styles.sessionBar}>
      {state.snapshot?.agents.length ? <label className={styles.agentSelect}>当前 Agent<select aria-label="当前 Agent" value={state.selectedId} disabled={state.busy} onChange={event => select(event.target.value)}>{state.snapshot.agents.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label> : <span>{state.access === "authenticated" ? "暂无托管 Agent" : "登录钱包尚未确认"}</span>}
      {state.owner && <span title={state.owner}>owner {short(state.owner, 6)}</span>}
      <span className={styles.sessionCaption}>{agent ? modelLabel(agent.modelId) + " · " + strategyLabel[agent.strategy] + "策略" : "个人消息签名登录 · 独立托管钱包"}</span>
      {agent && <Badge status={agent.status}>{statusLabel[agent.status]}</Badge>}
    </div>
    <div className={styles.banners}>
      {state.error && <div className={styles.errorBanner} role="alert"><Icon name="shield" size={13} /><span>{state.error}{state.snapshot && " 页面保留上次成功读取的记录。"}</span><button className={styles.textButton} disabled={state.refreshing || state.busy} onClick={() => void state.refresh()}>重新读取</button></div>}
      {state.notice && <div className={styles.notice} role="status"><Icon name="check" size={13} />{state.notice}</div>}
      {state.pending && <div className={styles.pendingBanner} role="status"><div><strong>原请求等待确认</strong><span>{state.pending.kind === "create" ? "创建 Agent" : actionLabel[state.pending.input.action]} · 已保存原参数</span><code>{state.pending.input.requestId}</code></div><button className={styles.secondaryButton} disabled={state.busy} onClick={() => void state.retryPending()}>继续确认原请求</button></div>}
    </div>

    {/* Same 12-column structure and viewport containment as Agora Dashboard.
        One mounted copy of each panel preserves forms and request focus on mobile. */}
    <main id="hosted-content" className={styles.main}>
      <div className={styles.workspace} data-testid="hosted-terminal-grid">
        <aside id="panel-agent" aria-labelledby="tab-agent" className={styles.agentPanel + (mobilePane !== "agent" ? " " + styles.mobileHidden : "")} data-testid="hosted-panel-agent">
          <div className={styles.widgetLabel}><Icon name="identity" size={12} />agentfuel.agent {agent && <StatusOrb status={agent.status} />}</div>
          <Card className={styles.identityPanel}><CardContent>
            {agent ? <>
              <AgentIdentityCard agent={agent} />
              <div className={styles.panelDivider} />
              <CollapsibleSection label={"我的 Agent · " + (state.snapshot?.agents.length ?? 0)} defaultOpen>
                <div className={styles.agentList}>{state.snapshot?.agents.map(item => <AgentServiceCard key={item.id} agent={item} model={modelLabel(item.modelId)} selected={item.id === state.selectedId} onSelect={() => select(item.id)} />)}</div>
              </CollapsibleSection>
              <div className={styles.panelDivider} />
              <CollapsibleSection label="运行配置" defaultOpen><dl className={styles.factList}><div><dt>MODEL</dt><dd>{modelLabel(agent.modelId)}</dd></div><div><dt>STRATEGY</dt><dd>{strategyLabel[agent.strategy]}</dd></div><div><dt>PER RUN</dt><dd>{inputUsdc(agent.perRunBudgetRaw)} {symbol}</dd></div><div><dt>TOTAL</dt><dd>{inputUsdc(agent.totalBudgetRaw)} {symbol}</dd></div><div><dt>CREDIT</dt><dd>{agent.allowCredit ? "允许任务授信" : "现金执行任务"}</dd></div></dl></CollapsibleSection>
              <div className={styles.panelDivider} />
              <p className={styles.sectionLabel}>LIVE RUN</p><dl className={styles.factList}><div><dt>STATUS</dt><dd><Badge status={agent.status}>{active ? statusLabel[active.status] : statusLabel[agent.status]}</Badge></dd></div><div><dt>SPENT</dt><dd>{amount(agent.spentRaw, 6)} {symbol}</dd></div><div><dt>RESERVED</dt><dd>{amount(agent.reservedRaw, 6)} {symbol}</dd></div></dl>
              {agent.activeRequestId && <p className={styles.activeRequest}>当前请求 <code>{agent.activeRequestId}</code></p>}
              <div className={styles.agentControls}><button className={styles.secondaryButton} disabled={state.busy || !!state.pending || !!agent.activeRequestId} onClick={() => setModal("edit")}>编辑设置</button><button className={styles.secondaryButton} disabled={state.busy || !!state.pending} onClick={() => void state.pause(agent)}>{agent.status === "Paused" ? "继续 Agent" : "暂停 Agent"}</button></div>
              <p className={styles.help}>暂停阻止新操作；已接收请求仍可恢复。</p>
              <div className={styles.panelDivider} />
              <CollapsibleSection label="链上身份详情"><dl className={styles.factList}><div><dt>AGENT ID</dt><dd>{agent.binding?.agentId ?? "等待初始化"}</dd></div><div><dt>NETWORK</dt><dd>{agent.binding ? networkName(agent.binding.chainId) : "等待绑定"}</dd></div><div><dt>OWNER</dt><dd><code>{agent.owner}</code></dd></div><div><dt>CREATED</dt><dd>{time(agent.createdAt)}</dd></div><div><dt>PLATFORM ID</dt><dd><code>{agent.id}</code></dd></div></dl></CollapsibleSection>
            </> : <div className={styles.panelPlaceholder}><Icon name="identity" size={18} /><p>{state.access === "loading" ? "正在读取 Agent 身份…" : "等待自己的托管 Agent"}</p><p className={styles.help}>签名登录后创建，平台生成独立钱包。</p></div>}
          </CardContent></Card>
        </aside>

        <section id="panel-requests" aria-labelledby="tab-requests" className={styles.missionPanel + (mobilePane !== "requests" ? " " + styles.mobileHidden : "")} data-testid="hosted-panel-requests">
          <div className={styles.widgetLabel}>─ mission.log<span>{agent ? agent.name : "等待登录"}</span></div>
          {state.access === "signed-out" ? <div className={styles.timelineEmpty}><div><h2>你的钱包，你的 Agent。</h2><p>个人消息签名用于登录。Agent 使用平台生成的独立钱包执行任务。</p><button className={styles.textButton} disabled={state.busy} onClick={() => void state.login()}>连接并签名 →</button></div></div>
            : state.access === "unavailable" ? <div className={styles.timelineEmpty}><div><h2>托管服务不可用</h2><p>服务恢复前无法登录、创建或执行操作。</p></div></div>
            : !state.snapshot ? <div className={styles.timelineEmpty}>正在读取服务端记录<span className={styles.cursor}>_</span></div>
            : !state.snapshot.agents.length ? <div className={styles.timelineEmpty}><div><h2>等待第一个 Agent<span className={styles.cursor}>_</span></h2><p>{state.owner ? "在标题栏创建 Agent，配置模型、策略和推理预算。" : "当前会话已登录。创建首个 Agent 前，请再次签名确认钱包身份。"}</p></div></div>
            : <RunHistory runs={runs} activeRequestId={agent?.activeRequestId} chainId={agent?.binding?.chainId} busy={state.busy || !!state.pending} recover={run => state.recover(run)} />}
        </section>

        {/* Source inline GoalInput placement. The hosted contract has fixed actions,
            so command controls replace free-form chat without inventing an endpoint. */}
        <section className={styles.actionDock} data-testid="hosted-action-dock" aria-label="Agent 操作">
          <nav className={styles.nav} aria-label="主导航">{tabs.map(item => <button key={item.id} aria-current={tab === item.id ? "page" : undefined} onClick={() => navigate(item.id)}>{item.label}</button>)}</nav>
          {agent ? <div className={styles.commandContent}>
            {agent.activeRequestId && <p className={styles.activeNotice}>▸ 原请求尚未结束；新操作保持锁定。可在请求记录中明确恢复。</p>}
            {tab === "agents" || tab === "tasks" ? <div className={styles.taskAction}><div className={styles.commandLine}><span>›</span><strong>run task</strong><span>--agent {agent.name}</span></div><div className={styles.actionFooter}><p className={styles.help}>固定价任务 → 模型执行 → 独立验证 → 收入结算<br />推理上限 {amount(agent.perRunBudgetRaw, 6)} {symbol} · {agent.allowCredit ? "任务授信须经核验" : "使用 Agent cash"}</p><button className={styles.primaryButton} disabled={blocked} onClick={() => void state.run(agent, { action: "task" })}>运行任务 <Icon name="arrow" size={12} /></button>{state.snapshot?.capabilities?.inference && <button className={styles.secondaryButton} disabled={blocked} onClick={() => void state.run(agent, { action: "metered-task" })}>按量推理 / 信用补额</button>}{state.snapshot?.capabilities?.autonomy && <button className={styles.secondaryButton} disabled={blocked} onClick={() => void state.run(agent, { action: "autonomous" })}>Pi 连续运行</button>}{agent.modelId === "kimi-k2.6" && <button className={styles.secondaryButton} disabled={blocked} onClick={() => void state.run(agent, { action: "reward-task" })}>用奖励额度运行</button>}</div><p className={styles.help}>奖励额度用于同一套 Pi 执行与独立验收，按实际 tokens 消费，不足时保留任务。</p>{state.snapshot?.capabilities?.inference && <p className={styles.help}>按量额度包 {amount(state.snapshot.capabilities.inference.priceRaw, 6)} {symbol}，含 {state.snapshot.capabilities.inference.creditsRaw} 微额度；现金优先，{agent.allowCredit ? "不足时按任务授信补额" : "未授权借贷"}。包内实际扣费：{state.snapshot.capabilities.inference.models.map(m => `${m.id} 输入 ${m.inputMicroCreditsPerToken} / 输出 ${m.outputMicroCreditsPerToken} 微额度每 token`).join("；")}。未用额度留在原任务，不等同现金余额。</p>}{state.snapshot?.capabilities?.autonomy && <p className={styles.help}>连续运行最多 {state.snapshot.capabilities.autonomy.maxTasks} 单、{Math.floor(state.snapshot.capabilities.autonomy.durationMs / 60000)} 分钟，预留剩余累计预算；每次规划另需 {amount(state.snapshot.capabilities.autonomy.plannerPriceRaw, 6)} {symbol} cash。任务失败、状态不确定或预算不足时停止。</p>}</div> : null}
            {tab === "arena" && <ArenaAction key={agent.id} sponsorship={state.snapshot?.sponsorship} agent={agent} disabled={blocked && !canRefuel} refuelOnly={canRefuel} run={rewardKind => state.run(agent, { action: "game", rewardKind })} />}
            {tab === "funds" && <FundsActions key={agent.id} agent={agent} runs={runs} disabled={blocked} canDeposit={canCashRefuel} deposit={amountRaw => state.run(agent, { action: "deposit", amountRaw })} credits={() => state.run(agent, { action: "reward-task" })} />}
            {tab === "settings" && <div><div className={styles.commandLine}><span>›</span><strong>configure {agent.name}</strong></div><div className={styles.actionFooter}><p className={styles.help}>{modelLabel(agent.modelId)} · {strategyLabel[agent.strategy]} · {inputUsdc(agent.perRunBudgetRaw)} / {inputUsdc(agent.totalBudgetRaw)} {symbol}<br />推理成本预算与 cash、gas、借款手续费分别记录。</p><button className={styles.secondaryButton} disabled={state.busy || !!state.pending || !!agent.activeRequestId} onClick={() => setModal("edit")}>修改当前配置</button></div></div>}
          </div> : <p className={styles.dockIdle}>› {state.access === "authenticated" ? "创建并选择 Agent 后执行操作" : "等待钱包签名登录"}<span className={styles.cursor}>_</span></p>}
        </section>

        <aside id="panel-resources" aria-labelledby="tab-resources" className={styles.meshPanel + (mobilePane !== "resources" ? " " + styles.mobileHidden : "")} data-testid="hosted-panel-resources">
          <div className={styles.widgetLabel}>─ resources.net</div>
          <div className={styles.resourceScroll}>
            {agent ? <><FinancialPanel agent={agent} finance={state.finance} /><ResourcePanel sponsorship={state.snapshot?.sponsorship} agent={agent} lastCash={lastCash} models={state.snapshot?.models ?? []} onArena={() => navigate("arena")} /></> : <Card><CardContent><p className={styles.sectionLabel}>HOSTED RESOURCES</p><p className={styles.help}>模型目录、推理预算与奖励记录在登录后读取。</p>{state.snapshot?.models.map(model => <p key={model.id} className={styles.modelName}>{model.label}</p>)}</CardContent></Card>}
          </div>
        </aside>
      </div>
    </main>

    {/* ChainStatusBar's compact bottom strip, with only actual hosted API facts. */}
    <footer className={styles.footer}><div><span>API {transportStatus}</span>{agent?.binding && <span>chain {agent.binding.chainId} · #{agent.binding.agentId}</span>}<span>{state.refreshing ? "读取中…" : "服务端记录"}</span></div><details><summary>高级与演示入口 ▴</summary><div><Link href="/advanced">协议档案与固定 Agent 演示</Link><Link href="/arena">游戏练习与运营演示</Link><Link href="/arena/holdem">德州历史回放与奖励凭证</Link><p>历史演示身份；托管操作以上方当前 Agent 为准。</p></div></details></footer>
    <dialog ref={dialog} className={styles.dialog} onClose={() => setModal(null)} onCancel={() => setModal(null)} aria-labelledby="settings-title"><div className={styles.dialogHeader}><h2 id="settings-title">编辑设置</h2><button type="button" className={styles.iconButton} aria-label="关闭设置" disabled={state.busy} onClick={() => setModal(null)}>×</button></div>{modal && agent && <AgentSettingsForm key={agent.id} initial={agent} chainId={agent.binding?.chainId} models={state.snapshot?.models ?? []} busy={state.busy} serverError={state.error} onClose={() => setModal(null)} onSubmit={settings => state.update(agent, settings)} />}</dialog>
  </div>;
}

// AgentMeshPanel node-card layout: title/status, kind/id, compact fact rows.
// The hosted model catalog and budget replace Agora service/reputation fields.
function sponsorshipText(value?: HostedSponsorship) {
  if (!value) return "免费参赛，游戏不借贷。每个登录钱包累计最多 3 局，平台最多 100 局。";
  const extra = value.testAuthorization;
  return extra ? `本地测试追加授权${extra.active ? "有效" : "已过期"}，累计 ${value.used}/${extra.maxTotalGames} 局，剩余 ${value.remaining} 局；授权截止 ${time(extra.expiresAt)}。其他钱包默认 3 局，平台最多 100 局，游戏不借贷。`
    : `免费参赛，累计 ${value.used}/${value.limit} 局，剩余 ${value.remaining} 局；平台最多 100 局，游戏不借贷。`;
}

function ResourcePanel({ agent, lastCash, models, onArena, sponsorship }: { sponsorship?: HostedSponsorship; agent: HostedAgent; lastCash?: HostedRun; models: HostedCatalogModel[]; onArena: () => void }) {
  const symbol = settlementSymbol(agent.binding?.chainId);
  return <>
    <Card><CardContent><div className={styles.rowBetween}><h2>推理预算</h2><span className={styles.micro}>[ {symbol} ]</span></div><p className={styles.resourceKind}>BUDGET · {agent.name}</p><div className={styles.budgetTrack} role="meter" aria-label="推理预算使用比例" aria-valuemin={0} aria-valuemax={100} aria-valuenow={ratio(BigInt(agent.spentRaw) + BigInt(agent.reservedRaw), agent.totalBudgetRaw)}><span style={{ width: ratio(BigInt(agent.spentRaw) + BigInt(agent.reservedRaw), agent.totalBudgetRaw) + "%" }} /></div><dl className={styles.factList}><div><dt>已结账推理费</dt><dd>{amount(agent.spentRaw, 6)} {symbol}</dd></div><div><dt>请求预留</dt><dd>{amount(agent.reservedRaw, 6)} {symbol}</dd></div><div><dt>累计上限</dt><dd>{amount(agent.totalBudgetRaw, 6)} {symbol}</dd></div><div><dt>最近确认 cash</dt><dd>{lastCash ? amount(lastCash.result!.cashRaw!, 6) + " " + symbol : "尚无确认记录"}</dd></div></dl><p className={styles.help}>{lastCash ? "cash 确认于 " + time(lastCash.updatedAt) : "cash 由执行结果确认，预算设置不自动入金。"}</p></CardContent></Card>
    {models.map(model => <Card key={model.id}><CardContent><div className={styles.rowBetween}><h2>{model.label}</h2><span className={styles.micro}>{model.id === agent.modelId ? "[ SELECTED ]" : "[ CATALOG ]"}</span></div><p className={styles.resourceKind}>MODEL · {model.id}</p><dl className={styles.factList}><div><dt>来源</dt><dd>平台允许的预设</dd></div><div><dt>调用</dt><dd>按实际 usage 记账</dd></div></dl></CardContent></Card>)}
    <Card><CardContent><div className={styles.rowBetween}><h2>赞助德州</h2><span className={styles.micro}>[ FREE ]</span></div><p className={styles.resourceKind}>GAME · {symbol} / LLM credits</p><p className={styles.help}>{sponsorshipText(sponsorship)}</p><button className={styles.textButton} onClick={onArena}>前往竞技场 →</button></CardContent></Card>
  </>;
}

function ArenaAction({ agent, disabled, run, refuelOnly = false, sponsorship }: { sponsorship?: HostedSponsorship; agent: HostedAgent; disabled: boolean; refuelOnly?: boolean; run: (kind: "usdc" | "llm-credits") => Promise<boolean> }) {
  const symbol = settlementSymbol(agent.binding?.chainId);
  const [rewardKind, setRewardKind] = useState<"usdc" | "llm-credits">("usdc");
  const authorization = sponsorship?.testAuthorization;
  const boundReward = authorization?.actorRewards.find(row => row.hostedAgentId === agent.id)?.rewardKind;
  const limited = !!authorization?.active && (sponsorship?.used ?? 0) >= 3;
  const gameDisabled = disabled || sponsorship?.remaining === 0 || limited && !boundReward;
  const chosenReward = refuelOnly ? "llm-credits" : limited && boundReward ? boundReward : rewardKind;
  return <div><p className={styles.help}>{sponsorshipText(sponsorship)}</p><div className={styles.commandLine}><span>›</span><strong>play holdem</strong><span>--agent {agent.name}</span></div><div className={styles.inlineForm}><label>比赛奖励<select aria-label="比赛奖励" value={chosenReward} disabled={gameDisabled || refuelOnly || limited} onChange={event => setRewardKind(event.target.value as typeof rewardKind)}><option value="usdc">赞助 {symbol}</option><option value="llm-credits">LLM credits</option></select></label><button className={styles.primaryButton} disabled={gameDisabled || refuelOnly && limited && boundReward !== "llm-credits"} onClick={() => void run(chosenReward)}>免费参赛 <Icon name="arrow" size={12} /></button></div><p className={styles.help}>当前模型与策略对战平台 bot，可信重放决定奖励。{symbol} 进入本 Agent cash；比赛不借贷，创建新 Agent 不重置名额。</p></div>;
}

function FundsActions({ agent, runs, disabled, deposit, credits, canDeposit = false }: { agent: HostedAgent; runs: HostedRun[]; disabled: boolean; canDeposit?: boolean; deposit: (raw: string) => Promise<boolean>; credits: () => Promise<boolean> }) {
  const [value, setValue] = useState(""), [error, setError] = useState("");
  const symbol = settlementSymbol(agent.binding?.chainId);
  const latestCredits = runs.find(run => run.result?.creditsGranted !== undefined || run.result?.creditsUsed !== undefined);
  async function submit(event: React.FormEvent) {
    event.preventDefault(); setError("");
    try { if (await deposit(usdcRaw(value))) setValue(""); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "金额无效。"); }
  }
  return <div className={styles.fundsCommands}><form onSubmit={event => void submit(event)}><div className={styles.commandLine}><span>›</span><strong>deposit {symbol}</strong></div><div className={styles.inlineForm}><label>入账金额（{symbol}）<input inputMode="decimal" value={value} required disabled={disabled && !canDeposit} placeholder="0.00" onChange={event => setValue(event.target.value)} /></label><button className={styles.primaryButton} type="submit" disabled={disabled && !canDeposit || !value.trim()}>确认入账 <Icon name="arrow" size={12} /></button></div><p className={styles.help}>先向 Agent 钱包转入 {symbol}，再确认指定金额。预算设置不会转账。{agent.binding?.chainId === "42431" && "PathUSD 同时用于结算与手续费；确认入账时请保留手续费余额。"}{canDeposit ? "入账后恢复原任务，请勿重新接单。" : ""}</p>{error && <p className={styles.errorText} role="alert">{error}</p>}</form><div><div className={styles.commandLine}><span>›</span><strong>consume LLM credits</strong></div><div className={styles.actionFooter}><p className={styles.help}>{latestCredits ? (latestCredits.result?.creditsGranted !== undefined ? "最近获赠 " + latestCredits.result.creditsGranted : "最近消费 " + latestCredits.result?.creditsUsed) + " tokens · 历史记录" : "尚无奖励额度记录"}<br />用于 Pi 执行真实任务，独立验收后结算收入；目前支持 Kimi K2.6。</p><button className={styles.secondaryButton} disabled={disabled || agent.modelId !== "kimi-k2.6"} onClick={() => void credits()}>用奖励额度运行任务</button></div></div></div>;
}

function RunHistory({ runs, busy, recover, chainId, activeRequestId }: { runs: HostedRun[]; activeRequestId?: string; chainId?: string; busy: boolean; recover: (run: HostedRun) => Promise<boolean> }) {
  const symbol = settlementSymbol(chainId);
  return <section className={styles.runHistory} aria-label="请求记录"><div className={styles.sectionHeading}><div><span className={styles.eyebrow}>EXECUTION EVIDENCE</span><h2>请求记录</h2></div><span className={styles.micro}>最近 100 条 · 未结束请求保留</span></div>{!runs.length ? <div className={styles.emptyCompact}>等待第一个请求。执行状态、确认金额和交易凭证会显示在这里。</div> : runs.map(run => <article className={styles.runCard} key={run.requestId} data-testid={`hosted-run-${run.requestId}`}><div className={styles.rowBetween}><h3>{runTitle(run, chainId)}</h3><Badge status={run.status}>{statusLabel[run.status]}</Badge></div><p className={styles.micro}>{time(run.updatedAt)}</p><code className={styles.requestId}>{run.requestId}</code>{run.reason && <p className={styles.runReason}>{reasonLabel(run.reason)}</p>}{run.result && <div className={styles.resultStrip}><span>阶段 <strong>{run.result.phase}</strong></span><span>已确认推理费 <strong>{amount(run.result.chargedRaw, 6)} {symbol}</strong></span>{run.result.rewardRaw !== undefined && <span>奖励 <strong>{amount(run.result.rewardRaw, 6)} {symbol}</strong></span>}{run.result.creditsGranted !== undefined && <span>赠送 <strong>{run.result.creditsGranted} tokens</strong></span>}{run.result.autonomousTasks !== undefined && <span>连续完成 <strong>{run.result.autonomousTasks} 单</strong></span>}{run.result.creditsUsed !== undefined && <span>消费 <strong>{run.result.creditsUsed} tokens</strong></span>}</div>}<TaskSettlementSummary run={run} chainId={chainId} />{run.recoverable && <div className={styles.recoverRow}><p>使用原 ID 和原参数恢复；原金额与奖品选择保持一致。</p><button className={styles.secondaryButton} disabled={busy || !!activeRequestId && activeRequestId !== run.requestId} onClick={() => void recover(run)}>恢复原请求 <Icon name="refresh" size={14} /></button></div>}<CollapsibleSection label="查看请求与凭证"><dl className={styles.factList}><div><dt>预留推理预算</dt><dd>{amount(run.reservedRaw, 6)} {symbol}</dd></div>{run.amountRaw !== undefined && <div><dt>入账金额</dt><dd>{amount(run.amountRaw, 6)} {symbol}</dd></div>}{run.result?.cashRaw !== undefined && <div><dt>当次确认 cash</dt><dd>{amount(run.result.cashRaw, 6)} {symbol}</dd></div>}{run.result?.principalRaw !== undefined && <div><dt>剩余借款本金</dt><dd>{amount(run.result.principalRaw, 6)} {symbol}</dd></div>}{run.result?.feeRaw !== undefined && <div><dt>剩余借款 fee</dt><dd>{amount(run.result.feeRaw, 6)} {symbol}</dd></div>}{run.result?.taskId && <div><dt>任务 ID</dt><dd>{run.result.taskId}</dd></div>}{run.result?.matchId && <div><dt>比赛 ID</dt><dd>{run.result.matchId}</dd></div>}{run.result?.paymentId && <div><dt>付款 ID</dt><dd><code>{run.result.paymentId}</code></dd></div>}{run.result?.acceptTxHash && <div><dt>接单交易</dt><dd><TransactionEvidence hash={run.result.acceptTxHash} chainId={run.result.chainId ?? chainId} label="查看接单交易" /></dd></div>}{run.result?.paymentTxHash && <div><dt>付款交易</dt><dd><TransactionEvidence hash={run.result.paymentTxHash} chainId={run.result.chainId ?? chainId} label="查看付款交易" /></dd></div>}{run.result?.refundedRaw !== undefined && BigInt(run.result.refundedRaw) > 0n && <div><dt>已确认退款</dt><dd>{amount(run.result.refundedRaw, 6)} {symbol}</dd></div>}{run.result?.txHash && !run.result.settlement && <div><dt>{run.action === "task" ? "历史交易（未标注用途）" : "确认交易"}</dt><dd><TransactionEvidence hash={run.result.txHash} chainId={run.result.chainId ?? chainId} label="查看交易" /></dd></div>}</dl></CollapsibleSection></article>)}</section>;
}
