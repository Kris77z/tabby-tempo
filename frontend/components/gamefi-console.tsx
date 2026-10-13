"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import type { GameFiCommand, GameFiRun, GameFiSnapshot, GameFiRewardKind } from "../lib/gamefi-types";
import type { RewardBalance, RewardRedemption, RewardIdentity } from "../../services/arena/src/inference-rewards/index";

type Credits = { enabled: boolean; identity?: RewardIdentity; balance?: RewardBalance; redemption?: RewardRedemption | null; error?: string };
const active = (run?: GameFiRun) => run?.status === "Running" || run?.status === "Queued";
const status: Record<string, string> = { Queued: "排队中", Running: "执行中", Paused: "已暂停", Stopped: "已停止", Complete: "已完成" };
const stages: Record<string, string> = { game: "模型对局", award: "USDC 奖励入账", purchase: "奖励购买推理", credits: "推理额度发放" };
const storage = { run: "agentfuel:gamefi:run", pending: "agentfuel:gamefi:pending", redemption: "agentfuel:gamefi:redemption" };
function saved(key: string) { try { return localStorage.getItem(key); } catch { return null; } }
function save(key: string, value?: string) { if (value === undefined) localStorage.removeItem(key); else localStorage.setItem(key, value); }
async function request<T>(url: string, body?: unknown, timeout = 15000): Promise<T> {
  const response = await fetch(url, { cache: "no-store", signal: AbortSignal.timeout(timeout), ...(body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || `HTTP_${response.status}`);
  return data;
}
export default function GameFiConsole() {
  const [snapshot, setSnapshot] = useState<GameFiSnapshot>(); const [credits, setCredits] = useState<Credits>();
  const [kind, setKind] = useState<GameFiRewardKind>("usdc"); const [pending, setPending] = useState<GameFiCommand>();
  const [runId, setRunId] = useState(""); const [redemptionId, setRedemptionId] = useState("");
  const [prompt, setPrompt] = useState("请用一句话解释如何控制 Agent 的推理预算。");
  const [busy, setBusy] = useState(false); const [error, setError] = useState("");
  const mutation = useRef(false), reading = useRef(false); const run = snapshot?.run;
  const refresh = useCallback(async (id = runId, redeemId = redemptionId) => {
    if (reading.current) return; reading.current = true;
    const results = await Promise.allSettled([
      request<GameFiSnapshot>(`/api/arena/gamefi${id ? `?requestId=${encodeURIComponent(id)}` : ""}`),
      request<Credits>(`/api/arena/credits${redeemId ? `?redemptionId=${encodeURIComponent(redeemId)}` : ""}`),
    ]);
    if (results[0].status === "fulfilled") {
      const next = results[0].value, live = !id ? next.runs?.find(item => active(item)) : undefined;
      setSnapshot(live ? { ...next, run: live } : next);
      if (live) { setRunId(live.requestId); try { save(storage.run, live.requestId); } catch { /* Read-only discovery still works. */ } }
    }
    if (results[1].status === "fulfilled") {
      setCredits(results[1].value);
      if (redeemId && results[1].value.enabled && results[1].value.redemption === null) {
        setRedemptionId(""); try { save(storage.redemption); } catch { /* Server confirms no dispatch record. */ }
      }
    }
    const failure = results.find(result => result.status === "rejected");
    if (failure?.status === "rejected") setError(failure.reason instanceof Error ? failure.reason.message : "读取失败，请重试。");
    reading.current = false;
  }, [runId, redemptionId]);
  useEffect(() => {
    const id = saved(storage.run) || "", redemption = saved(storage.redemption) || "";
    setRunId(id); setRedemptionId(redemption);
    try { const raw = saved(storage.pending); if (raw) setPending(JSON.parse(raw)); } catch { /* Invalid local recovery metadata is ignored. */ }
    void refresh(id, redemption);
  // Read recovery metadata exactly once, before a new operation can be sent.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (!active(run)) return;
    const timer = setInterval(() => { if (document.visibilityState === "visible") void refresh(); }, 3000);
    return () => clearInterval(timer);
  }, [run?.status, refresh]);
  async function command(value: GameFiCommand) {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError("");
    try {
      save(storage.pending, JSON.stringify(value)); save(storage.run, value.requestId); setPending(value); setRunId(value.requestId);
      const next = await request<GameFiSnapshot>("/api/arena/gamefi", value);
      setSnapshot(next); save(storage.pending); setPending(undefined);
      void refresh(value.requestId);
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : "请求结果未知"}。保留原比赛 ID，可查询或重试原请求。`); }
    finally { mutation.current = false; setBusy(false); }
  }
  async function redeem() {
    if (mutation.current) return; mutation.current = true; setBusy(true); setError("");
    const id = crypto.randomUUID();
    try {
      save(storage.redemption, id); setRedemptionId(id);
      const next = await request<Credits>("/api/arena/credits", { action: "redeem", redemptionId: id, prompt, maxCompletionTokens: 128 }, 70000);
      setCredits(next);
    } catch (reason) { setError(`${reason instanceof Error ? reason.message : "推理结果未知"}。请查询原兑换记录，不要重复提交。`); }
    finally { mutation.current = false; setBusy(false); }
  }
  const uncertainRedemption = Boolean(redemptionId && (!credits?.redemption || credits.redemption.redemptionId !== redemptionId || ["DispatchIntent", "ResponseRecorded", "OutcomeUnknown"].includes(credits.redemption.status)));
  return <section className="af-gamefi-console af-panel" aria-label="真实比赛与推理额度">
    <div className="af-gamefi-command"><div className="af-live-heading"><h2>固定运营 Agent · 比赛演示</h2><button className="af-button" disabled={busy} onClick={() => { setError(""); void refresh(); }}>刷新比赛与额度</button></div>
    <p>此入口使用项目配置的两位固定运营 Agent，服务启用后调用真实 Kimi 策略。赞助方承担模型费用；游戏不借贷。自己的托管 Agent 请在工作台参赛。</p>
    {error ? <p className="af-alert error" role="alert">{error}</p> : null}
    <div className="af-config-fields"><label>本场奖励<select value={kind} onChange={e => setKind(e.target.value as GameFiRewardKind)} disabled={busy || active(run) || Boolean(pending)}><option value="usdc">赞助测试 USDC</option><option value="llm-credits">Kimi 推理额度</option></select></label><button className="af-button primary" disabled={!snapshot?.enabled || busy || active(run) || Boolean(pending) || !snapshot.rewardKinds.includes(kind)} onClick={() => void command({ action: "start", requestId: crypto.randomUUID(), rewardKind: kind })}>发起真实德州比赛</button></div>
    {!snapshot?.enabled ? <p>比赛服务尚未启用，请配置服务端运行环境。</p> : null}
    {pending ? <div className="af-alert" role="status">原请求已保存。<button className="af-button" disabled={busy || !snapshot?.enabled} onClick={() => void command(pending)}>重试原比赛请求</button></div> : null}
    {run ? <div className="af-run-detail"><h3>{status[run.status]} · {stages[run.stage]}</h3><code>{run.matchId || run.requestId}</code>{run.reason ? <p>{run.reason}</p> : null}<p>{run.rewardKind === "usdc" ? "测试 USDC 奖励" : "Kimi 推理额度奖励"} · 更新于 {new Date(run.updatedAt).toLocaleString("zh-CN")}</p>{run.game ? <p>已记录 {run.game.steps.length} 个合法动作 · {run.game.result ? `座位 ${run.game.result.winners.map(seat => seat + 1).join("、")} 获胜` : "尚无可派奖终局"}</p> : null}{run.award ? <p>已记录奖励：{Number(run.award.rewardRaw) / 1e6} 测试 USDC · {run.award.transactions.length} 条链上操作</p> : null}{run.purchase ? <p>奖励购买推理：{run.purchase.phase === "Complete" ? "已完成" : "已停止"}</p> : null}{run.credits ? <p>已发放 Kimi token 额度 · 座位 1 / 2：{run.credits.allocations.join(" / ")}</p> : null}{run.recoverable ? <button className="af-button" disabled={busy} onClick={() => void command({ action: "recover", requestId: run.requestId })}>按原记录继续核查</button> : null}</div> : null}
    {snapshot?.runs?.length ? <details><summary>已保存的真实比赛</summary><div className="af-match-list">{snapshot.runs.map(item => <button key={item.requestId} disabled={busy} onClick={() => { save(storage.run, item.requestId); setRunId(item.requestId); void refresh(item.requestId); }}>{status[item.status]} · {item.rewardKind === "usdc" ? "USDC" : "LLM 额度"} · {new Date(item.createdAt).toLocaleString("zh-CN")}</button>)}</div></details> : null}
    </div><div className="af-credit-console"><h2>使用获奖推理额度</h2><p>额度绑定 Kimi 模型，按实际输入与输出 token 扣减；USDC 余额与额度分别记账。</p>{credits?.balance ? <><p>当前 Agent #{credits.balance.identity.agentId} · {credits.balance.model}</p><div className="af-arena-stats"><div><span>可用 token</span><strong>{credits.balance.availableTokens}</strong></div><div><span>已消耗 token</span><strong>{credits.balance.consumedTokens}</strong></div><div><span>预留 token</span><strong>{credits.balance.reservedTokens}</strong></div></div></> : <p>当前账户额度尚未加载或未配置。</p>}<label>推理问题<textarea aria-label="获奖额度推理问题" value={prompt} onChange={e => setPrompt(e.target.value)} maxLength={2000} rows={3} disabled={busy} /></label><p>本次最多输出 128 token，调用前会预留输入与输出预算，完成后按实际 usage 结算。</p><button className="af-button primary" disabled={busy || !credits?.enabled || !credits.balance || credits.balance.blocked || credits.balance.availableTokens < new TextEncoder().encode(prompt).length + 384 || uncertainRedemption || !prompt.trim()} onClick={() => void redeem()}>使用额度调用 Kimi</button>{redemptionId ? <button className="af-button" disabled={busy} onClick={() => void refresh(runId, redemptionId)}>查询原兑换记录</button> : null}{credits?.redemption?.redemptionId === redemptionId && credits.redemption ? <div role="status"><p>兑换状态：{credits.redemption.status}{credits.redemption.chargedTokens !== undefined ? ` · 已扣 ${credits.redemption.chargedTokens} token` : ""}</p>{credits.redemption.content ? <pre>{credits.redemption.content}</pre> : null}{credits.redemption.error ? <p>{credits.redemption.error}</p> : null}</div> : null}</div>
  </section>;
}
