"use client";
import { useEffect, useRef, useState } from "react";
import { Interface, keccak256, parseUnits, toUtf8Bytes } from "ethers";
import type { InferCredit as InferCreditClient, InferenceReceipt, PaymentHandle } from "@agentfuel/sdk";
import { ACCOUNT_ABI, ESCROW_ABI } from "../lib/abi";
import { arenaRequest, type ArenaCatalog, type ArenaRun } from "../lib/arena";
import { explainError } from "../lib/errors";
import { amount, short, taskCreditCap } from "../lib/format";
import { paymentStorageKey, validateStoredPayment } from "../lib/payment-storage";
import { acceptTask, assertWallet, createTask, depositCash, probeSpendRejection, type WalletSession } from "../lib/wallet";
import { TASK_STATUS, type Profile, type PublicConfig, type TaskRow } from "../lib/types";
import { ExplorerLink, Evidence } from "./evidence";
import { Icon } from "./icons";
import { Routing } from "./routing";
import { RejectionEvidence } from "./rejection-evidence";

const SUBMISSION_TYPES = { Submission: [{ name: "taskId", type: "uint256" }, { name: "agentId", type: "uint256" }, { name: "codeHash", type: "bytes32" }, { name: "deadline", type: "uint256" }] };
type Notice = { kind: "info" | "success" | "error"; code?: string; message: string; detail?: string };

export function DemoPanel({ profile, config, openTasks, taskId, onTask, wallet, fixture, refresh, onBusyChange, arenaTimeoutMs = 15_000 }: {
  profile: Profile; config: PublicConfig; openTasks: TaskRow[]; taskId: string; onTask: (id: string) => void;
  wallet: WalletSession | null; fixture: boolean; refresh: () => Promise<void>; onBusyChange: (busy: boolean) => void; arenaTimeoutMs?: number;
}) {
  const mounted = useRef(true);
  const [busy, setBusy] = useState(""); const [notice, setNotice] = useState<Notice | null>(null);
  const [reward, setReward] = useState("0.15"), [hours, setHours] = useState("24"), [cashDeposit, setCashDeposit] = useState("0.04");
  const [providerAddress, setProviderAddress] = useState(config.providers[0]?.address || "");
  const [prompt, setPrompt] = useState("请编写满足任务要求的 Python 3 stdin/stdout 程序，只返回代码。"), [suggestedCode, setSuggestedCode] = useState("");
  const [maxPrice, setMaxPrice] = useState("0.12"), [payment, setPayment] = useState<PaymentHandle | null>(null), [storageError, setStorageError] = useState("");
  const [receipt, setReceipt] = useState<InferenceReceipt | null>(null), [output, setOutput] = useState("");
  const [target, setTarget] = useState("0x000000000000000000000000000000000000dEaD");
  const [catalog, setCatalog] = useState<ArenaCatalog | null>(null), [arenaError, setArenaError] = useState("");
  const [code, setCode] = useState(""), [run, setRun] = useState<ArenaRun | null>(null);
  const c = profile.credit;
  const task = profile.tasks.find(t => t.id === taskId) || openTasks.find(t => t.id === taskId);
  const provider = config.providers.find(p => p.address === providerAddress);
  const signerMatches = wallet?.address.toLowerCase() === c.identity.wallet.toLowerCase();
  const canWrite = !fixture && Boolean(wallet) && !busy;
  const arenaTask = taskId ? catalog?.tasks[taskId] : undefined;
  const problem = catalog?.problems.find(p => p.id === arenaTask?.problemId);
  const storeKey = paymentStorageKey(config, profile.agent.id);

  useEffect(() => { mounted.current = true; return () => { mounted.current = false; onBusyChange(false); }; }, [onBusyChange]);
  useEffect(() => { onBusyChange(Boolean(busy) || run?.status === "running"); }, [busy, run?.status, onBusyChange]);
  useEffect(() => { if (problem) setPrompt(`${problem.prompt}\n请只返回 Python 3 代码。`); }, [problem?.id, taskId]);

  useEffect(() => {
    setPayment(null); setStorageError(""); setReceipt(null); setOutput(""); setNotice(null); setRun(null);
    if (fixture) return;
    try { const stored = localStorage.getItem(storeKey); if (stored) setPayment(validateStoredPayment(JSON.parse(stored), config, profile.agent.id)); }
    catch (error) { setStorageError(explainError(error).message); }
  // The key encodes chain/account/agent. Refreshing the same deployment does not reset in-flight UI.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [storeKey, fixture]);
  useEffect(() => {
    if (fixture || !config.arenaUrl) { setCatalog(null); return; }
    let active = true;
    void arenaRequest<ArenaCatalog>(config.arenaUrl, "/problems", undefined, arenaTimeoutMs).then(value => { if (active) { setCatalog(value); setArenaError(""); } }).catch(error => { if (active) setArenaError(explainError(error).message); });
    return () => { active = false; };
  }, [config.arenaUrl, fixture, arenaTimeoutMs]);
  useEffect(() => {
    if (!run || run.status !== "running" || !config.arenaUrl) return;
    let stopped = false;
    const timer = setInterval(() => {
      void arenaRequest<ArenaRun>(config.arenaUrl!, `/runs/${encodeURIComponent(run.runId)}`, undefined, arenaTimeoutMs).then(async next => {
        if (stopped) return;
        if (next.taskId !== run.taskId) throw new Error("Arena 返回的 taskId 不一致。");
        if (next.status === "settled" && next.result) {
          const verdict = next.result.verdict;
          if (verdict.chainId !== config.chainId || verdict.escrowAddress.toLowerCase() !== config.contracts.escrow.toLowerCase() || verdict.agentId !== profile.agent.id) throw new Error("Arena 裁决不属于当前网络 / Agent。");
          if (!wallet) throw new Error("请连接钱包，以核验 Arena 结算交易。");
          const txReceipt = await wallet.provider.getTransactionReceipt(next.result.settlement.txHash);
          const settled = txReceipt?.logs.filter(l => l.address.toLowerCase() === config.contracts.escrow.toLowerCase()).map(l => {
            try { return new Interface(ESCROW_ABI).parseLog(l); } catch { return null; }
          }).find(e => e?.name === "TaskSettled" && String(e.args.taskId) === next.taskId);
          if (!txReceipt || txReceipt.status !== 1 || !settled || settled.args.passed !== verdict.passed) throw new Error("Arena 的结算回执尚未核验，请保留 runId 并刷新。");
          setNotice({ kind: "success", code: verdict.passed ? "PASS" : "FAIL", message: "可信 controller 已验收，链上结算回执已核验。" });
          await refresh();
        }
        if (!stopped) setRun(next);
      }).catch(error => { if (!stopped) setArenaError(explainError(error).message); });
    }, 1_500);
    return () => { stopped = true; clearInterval(timer); };
  }, [run?.runId, run?.status, config.arenaUrl, config.chainId, config.contracts.escrow, profile.agent.id, wallet, refresh, arenaTimeoutMs]);

  const report = (message: string) => setNotice({ kind: "info", message });
  async function transaction(name: string, work: () => Promise<{ hash: string; taskId?: string }>) {
    if (!canWrite) return;
    setBusy(name); setNotice(null);
    try { const result = await work(); if (mounted.current && result.taskId) onTask(result.taskId); setNotice({ kind: "success", message: `${name} 已确认。`, detail: result.hash }); await refresh(); }
    catch (error) { setNotice({ kind: "error", ...explainError(error) }); }
    finally { setBusy(""); }
  }
  async function pay(resume = false) {
    if (!canWrite || !wallet || storageError) return;
    const chosen = resume && payment ? config.providers.find(p => p.address.toLowerCase() === payment.quote.payTo.toLowerCase()) : provider;
    if (!chosen?.relayUrl) return;
    setBusy("payProvider"); setNotice({ kind: "info", message: resume ? "恢复原 paymentId，先检查链上支付与 Relay 状态。" : "请求 402 报价；cash 优先，不足部分获取任务授信。" });
    let sdk: InferCreditClient | undefined;
    try {
      const { InferCredit } = await import("@agentfuel/sdk");
      sdk = new InferCredit({ agentId: profile.agent.id, signer: wallet.signer, chainId: BigInt(config.chainId), account: config.contracts.account,
        asset: config.asset.address, provider: chosen.address, maxPrice: resume && payment ? BigInt(payment.quote.price) : parseUnits(maxPrice, config.asset.decimals), underwriterUrl: config.underwriterUrl,
        onHandle: handle => { localStorage.setItem(storeKey, JSON.stringify(handle)); setPayment(handle); report(handle.submission?.txHash ? `支付已提交：${handle.submission.txHash}` : "付款记录已保存，请在钱包检查交易金额。" ); } });
      await assertWallet(wallet, config, c.identity.wallet);
      const inference = resume && payment ? await sdk.resume(payment) : await sdk.forTask(taskId || "0").fetch(`${chosen.relayUrl.replace(/\/$/, "")}/v1/chat`,
        { body: { service: chosen.service!, model: chosen.model!, messages: [{ role: "user", content: prompt }] } });
      setReceipt(inference.receipt); setOutput(typeof inference.result === "string" ? inference.result : JSON.stringify(inference.result, null, 2));
      const response = inference.result as { choices?: { message?: { content?: string } }[] };
      const rawCode = typeof inference.result === "string" ? inference.result : response?.choices?.[0]?.message?.content;
      setSuggestedCode(typeof rawCode === "string" ? rawCode.replace(/^```(?:python|py)?\s*\n?/, "").replace(/\n?```\s*$/, "").trim() : "");
      localStorage.removeItem(storeKey); setPayment(null);
      setNotice({ kind: "success", message: "推理已交付，receipt 与链上付款相对应。", detail: inference.receipt.txHash }); await refresh();
    } catch (error) {
      const e = error as { handle?: unknown };
      if (e.handle) { const handle = e.handle as PaymentHandle; setPayment(handle); localStorage.setItem(storeKey, JSON.stringify(handle)); }
      setNotice({ kind: "error", ...explainError(error) });
    } finally { sdk?.close(); setBusy(""); }
  }
  async function submit() {
    if (!canWrite || !wallet || !config.arenaUrl || !arenaTask || arenaTask.agentId !== profile.agent.id) return;
    setBusy("Arena submission"); setArenaError("");
    try {
      await assertWallet(wallet, config, c.identity.wallet);
      const block = await wallet.provider.getBlock("latest"); if (!block) throw new Error("无法读取当前区块。");
      const deadline = String(block.timestamp + 300);
      report("等待钱包签名：授权此 taskId + codeHash 的验收，结论由可信 controller 决定。");
      const signature = await wallet.signer.signTypedData({ name: "InferCreditArena", version: "1", chainId: BigInt(config.chainId), verifyingContract: config.contracts.escrow }, SUBMISSION_TYPES,
        { taskId, agentId: profile.agent.id, codeHash: keccak256(toUtf8Bytes(code)), deadline });
      const next = await arenaRequest<ArenaRun>(config.arenaUrl, "/submissions", { taskId, code, deadline, signature }, arenaTimeoutMs);
      setRun(next); setNotice({ kind: "info", message: "代码已提交。等待 Docker hidden tests 与独立 settler。", detail: `runId ${next.runId}` });
    } catch (error) { setArenaError(explainError(error).message); }
    finally { setBusy(""); }
  }
  async function rejectProbe() {
    if (fixture) {
      try { const data = new Interface(ACCOUNT_ABI).encodeErrorResult("SpendRejected", [profile.agent.id, target, 1]);
        setNotice({ kind: "error", ...explainError({ data }), detail: "本地 fixture 错误样例；未请求 RPC。" }); }
      catch { setNotice({ kind: "error", message: "请输入有效 EVM 地址。" }); }
      return;
    }
    if (!canWrite || !wallet) return;
    setBusy("SpendPolicy probe");
    try { await probeSpendRejection(wallet, config, profile.agent.id, c.identity.wallet, target); }
    catch (error) { const detail = explainError(error); setNotice({ kind: "error", ...detail, detail: `${detail.detail || ""} · eth_call 链上模拟，未广播交易` }); }
    finally { setBusy(""); }
  }
  return <>
    <div className="demo-hero"><div><span className="eyebrow">LIVE CAPITAL LOOP</span><h1>先完成任务，再赚取信用。</h1><p>Task → compute → verification → repayment → reputation</p></div><span className="tag neutral">Agent #{profile.agent.id} · Tier {c.terms.tier}</span></div>
    <Routing profile={profile} config={config} paying={busy === "payProvider"} />
    <div className="wallet-context"><Icon name="wallet" /><span>{fixture ? "本地演示模式：交易操作已关闭。" : !wallet ? "连接钱包后可创建任务；接受与付款需使用此 Agent 的 registry wallet。" : signerMatches ? `Agent wallet 已连接 · ${short(wallet.address)}` : `当前 ${short(wallet.address)} 可创建任务与入金；接受 / 付款需切换至 ${short(c.identity.wallet)}。`}</span></div>
    {notice ? <div className={`operation-notice ${notice.kind}`} role="status"><strong>{notice.code || (notice.kind === "success" ? "Confirmed" : notice.kind === "info" ? "Processing" : "Request failed")}</strong><p>{notice.message}</p>{notice.detail ? <code className="wrap">{notice.detail}</code> : null}</div> : null}
    <div className="demo-controls"><section className="demo-step"><div className="step-heading"><span className="step-number">01</span><div><h2>任务托管</h2><p>由 poster 钱包出资，将 reward 锁进 TaskEscrow。</p></div></div><div className="field-row"><label>Reward · {config.asset.symbol}<input value={reward} onChange={e => setReward(e.target.value)} inputMode="decimal" /></label><label>Deadline · 小时<input value={hours} onChange={e => setHours(e.target.value)} inputMode="numeric" /></label></div>
      <button className="button secondary" disabled={!canWrite} onClick={() => void transaction("createTask", () => createTask(wallet!, config, reward, Math.floor(Date.now() / 1000 + Number(hours) * 3600), report))}>创建并托管任务 <Icon name="arrow" size={15} /></button><p className="control-note">{config.asset.symbol} reward 使用 {config.asset.decimals} 位小数；ERC-20 会先请求本次金额 approve。Arena 只验收服务端已绑定的任务。</p>
      <div className="cash-topup"><label>Cash 入金 · {config.asset.symbol}<input value={cashDeposit} onChange={e => setCashDeposit(e.target.value)} inputMode="decimal" /></label><button className="button small secondary" disabled={!canWrite} onClick={() => void transaction("depositCash", () => depositCash(wallet!, config, profile.agent.id, cashDeposit, report))}>入金</button></div></section>
      <section className="demo-step"><div className="step-heading"><span className="step-number">02</span><div><h2>接受与授信</h2><p>授信属于 Agent × Task，直接读取当前任务状态。</p></div></div><label>Task ID<select value={taskId} onChange={e => onTask(e.target.value)}><option value="">选择任务（空为纯 cash 付款）</option>{[...profile.tasks, ...openTasks].map(t => <option key={t.id} value={t.id}>Task #{t.id} · {TASK_STATUS[t.status]}</option>)}</select></label>
        {task ? <dl className="task-facts"><div><dt>Reward / 净 escrow</dt><dd>{amount(task.reward, config.asset.decimals)} / {amount(task.netEscrow, config.asset.decimals)} {config.asset.symbol}</dd></div><div><dt>任务本金上限</dt><dd>{amount(taskCreditCap(task.netEscrow, c.configuration.ltvBps, c.terms.feeBps, c.tierCap), config.asset.decimals)} {config.asset.symbol}</dd></div><div><dt>Loan</dt><dd>{task.loan.status ? "已有 loan · 不可再次借款" : "未借款"}</dd></div></dl> : <p className="control-note">无任务上下文只允许使用 cash，不获取授信。</p>}
        <button className="button secondary" disabled={!canWrite || !signerMatches || !task || task.status !== 1} onClick={() => void transaction("acceptTask", () => acceptTask(wallet!, config, taskId, profile.agent.id, c.identity.wallet, report))}>接受任务 <Icon name="arrow" size={15} /></button></section></div>
    <section className="inference-section"><div className="section-heading"><div><span className="eyebrow">03 · COMPUTE PAYMENT</span><h2>用信誉购买一次推理</h2></div><span className="muted">402 quote → payProvider → replay</span></div>
      {!config.providers.some(p => p.relayUrl) ? <p className="empty-inline">尚未配置 Provider relayUrl。配置已部署的 Relay 后启用真实推理与付款。</p> : <><div className="inference-fields"><label>Provider<select value={providerAddress} onChange={e => setProviderAddress(e.target.value)} disabled={Boolean(payment)}>{config.providers.map(p => <option key={p.address} value={p.address}>{p.name}{p.allowed ? " · whitelisted" : " · unavailable"}</option>)}</select></label><label>Logical model<input value={provider?.model || "未配置"} readOnly /></label><label>最高价格 · {config.asset.symbol}<input value={maxPrice} onChange={e => setMaxPrice(e.target.value)} inputMode="decimal" /></label></div><label>任务提示<textarea className="prompt-input" value={prompt} onChange={e => setPrompt(e.target.value)} rows={3} /></label>
        {storageError ? <p className="danger-text" role="alert">{storageError}</p> : null}
        {payment ? <div className="pending-payment"><div><strong>待恢复付款 · 同一个 paymentId</strong><code>{short(payment.quote.paymentId)}</code><span>Task #{payment.input.taskId} · {amount(payment.quote.price, config.asset.decimals)} {config.asset.symbol}{payment.submission?.txHash ? ` · tx ${short(payment.submission.txHash)}` : ""}</span></div><button className="button primary" disabled={!canWrite || !signerMatches || Boolean(storageError)} onClick={() => void pay(true)}>恢复付款</button></div> : <button className="button primary" disabled={!canWrite || !signerMatches || !provider?.allowed || !provider.relayUrl || Boolean(storageError) || Boolean(task && (task.status !== 2 || task.agentId !== profile.agent.id))} onClick={() => void pay()}>获取报价并付款 <Icon name="arrow" size={16} /></button>}
        <p className="control-note">协议 service: {provider?.service || "未配置"} · logical model: {provider?.model || "未配置"}。钱包确认实际金额；SDK 校验 chain / account / asset / payTo / requestDigest 与价格上限。超时保留 paymentId，恢复时先查原交易。</p></>}
      {receipt ? <div className="inference-receipt"><div><strong>Inference receipt</strong><ExplorerLink config={config} hash={receipt.txHash} /></div><p>cash {amount(receipt.fromCash, config.asset.decimals)} + credit {amount(receipt.fromCredit, config.asset.decimals)} {config.asset.symbol} · {receipt.model} · Block {receipt.blockNumber}</p><details><summary>查看完整 receipt</summary><pre>{JSON.stringify(receipt, null, 2)}</pre></details><details open><summary>Provider 返回</summary><pre>{output}</pre></details>{suggestedCode ? <button className="button secondary" onClick={() => setCode(suggestedCode)}>使用推理返回代码</button> : null}</div> : null}
    </section>
    <section className="arena-section"><div className="section-heading"><div><span className="eyebrow">04 · TRUSTED VERIFICATION</span><h2>提交代码，等待可信验收</h2></div><span className="tag neutral">Docker controller → independent settler</span></div>
      {arenaError ? <p className="danger-text" role="alert">{arenaError}</p> : null}
      {!config.arenaUrl || fixture ? <p className="empty-inline">{fixture ? "本地视觉演示不执行 Docker、不发送验收或结算交易。" : "尚未配置 Arena。需独立 controller / settler 服务与可信 task → problem 映射。"}</p> : !arenaTask ? <p className="empty-inline">当前任务未在 Arena catalog 绑定题目，不能提交验收。请选择已绑定任务。</p> : problem?.language !== "python3" ? <p className="empty-inline">Arena catalog 尚未声明受支持的 Python 3 语言，提交暂未启用。</p> : <><div className="problem-brief"><span className="mono">{arenaTask.problemId}</span><p>{problem?.prompt || "正在读取公开题目…"}</p></div><label>提交代码 · Python 3 stdin / stdout<textarea className="code-editor" placeholder={"# Python 3：每次从 stdin 读取一条 JSON，向 stdout 输出题目要求的一个 JSON 值。\n# 请先填写完整实现。"} value={code} onChange={e => setCode(e.target.value)} rows={8} spellCheck={false} /></label><button className="button primary" disabled={!canWrite || !signerMatches || arenaTask.agentId !== profile.agent.id || task?.status !== 2 || run?.status === "running" || !code.trim()} onClick={() => void submit()}>签名并提交验收 <Icon name="arrow" size={16} /></button><p className="control-note">签名绑定 chainId、escrow、taskId、Agent、codeHash 与 5 分钟期限。PASS / FAIL 均会触发真实结算；浏览器只授权本任务提交。</p></>}
      {run ? <div className="arena-run"><strong>{run.status === "running" ? "Running hidden tests…" : run.status === "settled" ? `Controller ${run.result?.verdict.passed ? "PASS" : "FAIL"}` : "验收错误"}</strong><code>runId {run.runId}</code>{run.error ? <p>{run.error}</p> : null}{run.result ? <><p>{run.result.tests.filter(t => t.passed).length} / {run.result.tests.length} tests passed · {run.result.verdict.mode}</p><ExplorerLink config={config} hash={run.result.settlement.txHash} label="查看原子结算交易" /><small className="mono wrap">evidenceHash {run.result.verdict.evidenceHash}</small>{run.result.settlement.feedback ? <p>声誉反馈：{run.result.settlement.feedback.map(f => `${f.type}: ${f.pending ? "pending" : f.sent ? "sent" : "none"}`).join(" · ")}</p> : null}</> : null}</div> : null}
    </section>
    <section className="reverse-section"><div><span className="eyebrow">SPENDPOLICY · REVERSE DEMO</span><h2>借来的钱，有明确去向。</h2><p>向未白名单地址调用 payProvider，解码真实 EVM revert。<br />{fixture ? "本模式仅展示显式 fixture 错误样例。" : "使用 eth_call 链上模拟，不广播交易、不产生事件。"}</p></div><div className="reverse-controls"><label>非白名单目标<input className="mono" value={target} onChange={e => setTarget(e.target.value)} /></label><button className="button secondary" disabled={fixture ? Boolean(busy) : !canWrite || !signerMatches} onClick={() => void rejectProbe()}><Icon name="shield" size={16} />{fixture ? "查看 fixture 拒绝样例" : "验证白名单拒绝"}</button></div></section>
    {!fixture ? <RejectionEvidence config={config} agentId={profile.agent.id} timeoutMs={arenaTimeoutMs} /> : null}
    <Evidence rows={profile.evidence} config={config} />
  </>;
}
