"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type { PlayAction, PlayCommand, PlayGame, PlayList, PlayMatchSummary, PlayMatchView, PlayMode, PlayPlayer, PlaySession } from "../lib/play-types";
import type { HoldemSnapshot } from "../lib/holdem-types";
import { Icon } from "./icons";
import { WorkspaceHeader } from "./terminal/workspace-header";
import { TerminalSelect } from "./hosted/terminal-select";
import { ArenaBoard } from "./arena-play-boards";
import { MagpiePanel } from './hosted/magpie-panel';
import { practiceGameScene } from '../lib/tabby-scenes';


const GAMES: { id: PlayGame; query: string; name: string; description: string; cover: string; detail: string }[] = [
  { id: "holdem", query: "poker", name: "扑克", description: "双人无限注德州扑克。在信息与概率之间做出决策。", cover: "poker-v1-1440.webp", detail: "双人无限注德州 · 隐藏手牌 · 虚拟筹码" },
  { id: "gomoku", query: "gomoku", name: "五子棋", description: "黑白交替，五子成线。让策略在方寸棋盘上交锋。", cover: "gomoku-v2-1440.webp", detail: "15 × 15 棋盘 · 黑方先行 · 五子连线获胜" },
  { id: "chess", query: "chess", name: "国际象棋", description: "从开局到残局。在六十四格中寻找下一步。", cover: "chess-v2-1440.webp", detail: "标准国际象棋 · 白方先行 · 将死获胜" },
  { id: "balatro", query: "balatro", name: "小丑牌", description: "打出牌型，构筑小丑组合。闯过 4 个 Ante · 12 道盲注。", cover: "balatro-v2-1440.webp", detail: "单人挑战 · 4 个 Ante · 12 道盲注" },
];
const key = (id: string) => `agentfuel:arena:seat:${id}`;
const playerName = (player: PlayPlayer | undefined, game: PlayGame) => !player ? "挑战者" : player.kind === "bot" ? game === "balatro" ? "Tabby 关卡主持" : "Tabby 策略 Bot" : player.name;
const statusText = (match: PlayMatchSummary) => match.status === "cancelled" ? "已取消" : match.status === "waiting" ? "等待准备" : match.status === "playing" ? "正在对局" : match.game === "balatro" ? match.outcome?.winner === 0 ? "挑战通关" : "挑战失败" : match.outcome?.kind === "draw" ? "平局" : `${playerName(match.players.find(p => p.seat === match.outcome?.winner), match.game)} 获胜`;
const apiMessage = (message: string) => ({ VERSION_CONFLICT: "对局状态已更新，正在读取最新棋盘。请根据最新状态重新操作。", UNAUTHORIZED: "当前席位凭证已失效，请重新创建对局。", MATCH_NOT_FOUND: "未找到这场对局，请检查比赛 ID。", NOT_YOUR_TURN: "尚未轮到你行动，请等待对方。", GAME_FINISHED: "对局已经结束。", MATCH_FINISHED: "对局已经结束。", INVALID_INVITE_CODE: "邀请码无效，请检查好友分享的链接。", INVITE_CODE_REQUIRED: "加入邀请练习需要邀请码。", OCCUPIED: "这个位置已有棋子，请选择空位。", MATCH_FULL: "对局席位已满。", ALREADY_READY: "你已经准备好了。" } as Record<string, string>)[message] || message;
const reasonText = (reason?: string) => ({ BANKRUPT: "一方筹码耗尽。", HAND_LIMIT: "已完成设定手数，按最终筹码判定胜负。", CHIP_TOTAL_TIED: "双方最终筹码相同。", FIVE_IN_A_ROW: "五子连线获胜。", BOARD_FULL: "棋盘已满，双方平局。", RESIGNED: "一方主动认输。", ACTION_TIMEOUT: "行动超时。", all_blinds_cleared: "通过全部 12 道盲注。", hands_exhausted: "出牌次数用尽，未达到本关目标。", checkmate: "将死获胜。", stalemate: "逼和。" } as Record<string, string>)[reason || ""] || reason;
const dateText = (value: string) => new Date(value).toLocaleString("zh-CN", { month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });
function readToken(id: string) { try { return localStorage.getItem(key(id)) || ""; } catch { return ""; } }

export default function ArenaPlay({ initialGame, initialMode, initialMatchId = "", initialInviteCode = "", ranked = false, embedded = false, onReward, hostedTempo = false }: { initialGame: PlayGame | null; initialMode: PlayMode; initialMatchId?: string; initialInviteCode?: string; ranked?: boolean; holdem?: HoldemSnapshot; embedded?: boolean; hostedTempo?: boolean; onReward?:()=>void }) {
  const [catalog, setCatalog] = useState<PlayList | null>(null);
  const [match, setMatch] = useState<PlayMatchView | null>(null);
  const [matchId, setMatchId] = useState(initialMatchId);
  const [token, setToken] = useState("");
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [matchStale, setMatchStale] = useState(false);
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<{ command: PlayCommand; seatToken: string } | null>(null);
  const [view, setView] = useState<"current" | "history">("current");
  const [logFilter, setLogFilter] = useState<"all" | "you" | "other">("all");
  const [name, setName] = useState("你的 Agent");
  const [chips, setChips] = useState<500 | 1000 | 5000>(1000);
  const [hands, setHands] = useState(initialMode === "invite" ? 3 : 10);
  const [inviteCode, setInviteCode] = useState(initialInviteCode);
  const mutationInFlight = useRef(false);
  const refreshInFlight = useRef(false);
  const recordsDialog = useRef<HTMLDialogElement>(null);
  const activeId = useRef(matchId);
  const configuredMatch = useRef("");
  activeId.current = matchId;
  const [chosenGame,setChosenGame]=useState(initialGame);
  const [chosenMode,setChosenMode]=useState(initialMode);
  const game = match?.game || chosenGame;
  const mode = match?.mode || chosenMode;
  const info = GAMES.find(g => g.id === game);

  const refreshList = useCallback(async () => {
    try {
      const response = await fetch("/api/arena/play", { cache: "no-store" });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "无法读取对局列表。");
      setCatalog(data as PlayList);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "读取失败。"); }
  }, []);
  const refreshMatch = useCallback(async (id: string, seatToken: string) => {
    if (refreshInFlight.current || mutationInFlight.current) return;
    refreshInFlight.current = true;
    try {
      const response = await fetch(`/api/arena/play?matchId=${encodeURIComponent(id)}`, { cache: "no-store", headers: seatToken ? { Authorization: `Bearer ${seatToken}` } : undefined });
      const data = await response.json();
      if (!response.ok) throw new Error(data.message || "无法读取这场对局。");
      if (activeId.current === id) {setMatchStale(false);setMatch(previous => previous && previous.id === data.id && previous.version > data.version ? previous : data as PlayMatchView);}
    } catch (cause) { if (activeId.current === id) {setMatchStale(true);setError(cause instanceof Error ? cause.message : "读取失败。");} }
    finally { refreshInFlight.current = false; }
  }, []);
  useEffect(() => {
    void refreshList();
    try { const saved = localStorage.getItem("agentfuel:arena:pending:v1"); if (saved) setPending(JSON.parse(saved)); } catch { /* Reversible local operation recovery is optional when browser storage is unavailable. */ }
  }, [refreshList]);
  useEffect(() => {
    if (!matchId) return;
    const seatToken = readToken(matchId); setToken(seatToken);
    void refreshMatch(matchId, seatToken);
    const interval = setInterval(() => { if (document.visibilityState === "visible") void refreshMatch(matchId, readToken(matchId)); }, 3000);
    return () => clearInterval(interval);
  }, [matchId, refreshMatch]);

  useEffect(() => {
    if (!match || configuredMatch.current === match.id) return;
    configuredMatch.current = match.id;
    setHands(match.config.hands);
    setChips(match.config.chips as 500 | 1000 | 5000);
  }, [match]);

  function openMatch(next: PlayMatchView, seatToken?: string) {
    if (seatToken) {
      try { localStorage.setItem(key(next.id), seatToken); }
      catch { setNotice("此浏览器无法保存席位。关闭页面后需要重新加入新的对局。"); }
    }
    const savedToken = seatToken || readToken(next.id);
    activeId.current = next.id; setMatchStale(false); setToken(savedToken); setMatchId(next.id); setMatch(next); setView("current"); setLogFilter("all");
    const query = new URLSearchParams({ game: GAMES.find(g => g.id === next.game)!.query, mode: next.mode === "invite" ? "practice" : "challenge", matchId: next.id });
    if(!embedded)window.history.replaceState(null, "", `/arena?${query}`);
  }
  function keepPending(value: { command: PlayCommand; seatToken: string } | null) {
    setPending(value);
    try { if (value) localStorage.setItem("agentfuel:arena:pending:v1", JSON.stringify(value)); else localStorage.removeItem("agentfuel:arena:pending:v1"); } catch { /* The current tab still retains the same request for safe retry. */ }
  }
  async function send(command: PlayCommand, retryToken?: string) {
    if (mutationInFlight.current) return;
    if (pending && retryToken === undefined) { setError("上一操作尚未确认，请先重试同一请求。"); return; }
    const seatToken = retryToken ?? token;
    mutationInFlight.current = true; setBusy(true); setError(""); setNotice("");
    let received = false;
    let reload = false;
    try {
      const response = await fetch("/api/arena/play", { method: "POST", headers: { "Content-Type": "application/json", ...(seatToken ? { Authorization: `Bearer ${seatToken}` } : {}) }, body: JSON.stringify(command) });
      const data = await response.json();
      received = true;
      keepPending(null);
      if (!response.ok) { reload = response.status === 409; throw new Error(apiMessage(data.message || `操作失败 (${response.status})。`)); }
      openMatch((data as PlaySession).match, (data as PlaySession).seatToken);
      void refreshList();
    } catch (cause) {
      if (!received) keepPending({ command, seatToken });
      setError(received ? cause instanceof Error ? cause.message : "操作失败。" : "连接中断，尚未确认操作结果。请重试下方同一请求；服务端会避免重复执行。");
    }
    finally { mutationInFlight.current = false; setBusy(false); if (reload && matchId) void refreshMatch(matchId, token); }
  }
  function act(action: PlayAction) { if (match) void send({ op: "action", matchId: match.id, version: match.version, requestId: crypto.randomUUID(), action }); }
  function command(op: "ready" | "auto" | "resign" | "cancel") { if (match) void send({ op, matchId: match.id, version: match.version, requestId: crypto.randomUUID() }); }
  function create() { if (game) void send({ op: "create", game, mode, name: name.trim() || "你的 Agent", chips, hands, requestId: crypto.randomUUID() }); }
  async function copy(text: string, message: string) {
    try { await navigator.clipboard.writeText(text); setNotice(message); }
    catch { setError("剪贴板不可用，请使用下方文本框复制。"); }
  }
  const canAct = Boolean(match && token && match.yourSeat !== null && match.status === "playing" && match.actor === match.yourSeat && !busy && !pending);
  const yourPlayer = match?.players.find(p => p.seat === match.yourSeat);
  const logs = match?.logs.filter(log => logFilter === "all" || (logFilter === "you" ? log.seat === match.yourSeat : log.seat !== undefined && log.seat !== match.yourSeat)) || [];
  const history = catalog?.history.filter(m => !game || m.game === game) || [];
  const activeMatches = catalog?.matches.filter(m => !game || m.game === game) || [];
  const actionContract = game === "holdem" ? '{"type":"fold"|"check"|"call"|"all-in"} / {"type":"raise","to":整数}' : game === "gomoku" ? '{"type":"place","row":0..14,"col":0..14}' : game === "chess" ? '{"type":"move","from":"e2","to":"e4","promotion":"q"}' : '{"type":"play"|"discard","cards":["AS","AH"]} / {"type":"choose_joker","jokerId":"ID","upgradeHand":"pair"} / {"type":"skip_reward","upgradeHand":"pair"}';
  const agentPrompt = match && token ? `你正在参加 Tabby 练习模式。虚拟筹码没有货币价值。服务端负责规则、轮次与结算。\nAPI: ${typeof window === "undefined" ? "" : window.location.origin}/api/arena/play\nmatchId: ${match.id}\n只在请求头使用 Authorization: Bearer ${token}；不要转发、记录或放入 URL。\nGET ?matchId=${match.id} 读取当前 gameView。仅在 actor 等于 yourSeat 时行动。\nPOST {"op":"ready","matchId":"${match.id}","version":当前version,"requestId":"每次新操作唯一UUID"} 准备。\nPOST {"op":"action","matchId":"${match.id}","version":当前version,"requestId":"每次新操作唯一UUID","action":合法动作} 行动。\n动作格式: ${actionContract}\n合法动作以当前 gameView 为准。收到409时重新GET；重试同一请求复用requestId。\n游戏: ${match.game}。完成后停止行动。` : "先开始游戏，取得自己的席位后即可复制 Agent 接入提示词。";

  function choose(next:PlayGame|null,nextMode:PlayMode='challenge'){if(busy||pending)return;activeId.current='';setMatchId('');setMatch(null);setToken('');setChosenGame(next);setChosenMode(nextMode);setHands(nextMode==='invite'?3:10);setError('');setNotice('');setView('current');}
  function selectMatch(id: string) {
    if (busy || pending) return;
    const summary = [...(catalog?.matches ?? []), ...(catalog?.history ?? [])].find(item => item.id === id);
    const seatToken = readToken(id);
    recordsDialog.current?.close();
    activeId.current = id;
    setMatchId(id); setMatch(null); setToken(seatToken); setView("current"); setLogFilter("all"); setError("");
    if (summary) { setChosenGame(summary.game); setChosenMode(summary.mode); }
    void refreshMatch(id, seatToken);
  }
  return <div className={embedded?"af-arena af-arena-embedded":"af-arena"}>
    {!embedded&&<WorkspaceHeader section="arena" title="游戏大厅" actions={<button className="af-header-refresh" disabled={busy} aria-label="刷新对局" onClick={()=>{void refreshList();if(matchId)void refreshMatch(matchId,token);}}><Icon name="refresh" size={13}/></button>}/>}
    <div className="af-arena-main">
      {embedded&&game&&<MagpiePanel ready sceneView={practiceGameScene(match,{pending:!!pending,disconnected:matchStale})}/>}
      {pending ? <div className="af-alert error" role="status"><span>有一项操作等待确认：{pending.command.op}。原请求已保留。</span><button disabled={busy} onClick={() => void send(pending.command, pending.seatToken)}>重试同一请求</button></div> : null}
      {error ? <div className="af-alert error" role="alert">{error}<button onClick={() => { setError(""); void refreshList(); if (matchId) void refreshMatch(matchId, token); }}>重新读取</button></div> : null}
      {notice ? <div className="af-alert" role="status">{notice}</div> : null}
      {!game ? <>
        <div className="af-gamefi-heading af-lobby-heading"><h1 className="af-lobby-title">游戏大厅</h1><div className="af-lobby-actions"><span className="af-lobby-note">练习免费 · 虚拟筹码</span><button className="af-records-trigger" aria-haspopup="dialog" aria-controls="game-match-records" onClick={()=>{recordsDialog.current?.showModal();void refreshList();}}><Icon name="history" size={12}/>历史与回放</button></div></div>
        <section className="af-game-cards af-game-library" aria-label="选择游戏">{GAMES.map(item=><article className="af-game-card" key={item.id}><img src={`/arena-assets/covers/${item.cover}`} alt="" width={1440} height={480}/><div><h2>{item.name}</h2><p>{item.description}</p><div className="af-game-modes"><a onClick={embedded?e=>{e.preventDefault();choose(item.id);}:undefined} aria-label={`进入策略练习${item.name}对局`} href={`/arena?game=${item.query}&mode=challenge`}>{item.id==='balatro'?'单人挑战':'策略练习'} <Icon name="arrow" size={12}/></a>{item.id!=='balatro'&&<a onClick={embedded?e=>{e.preventDefault();choose(item.id,"invite");}:undefined} aria-label={`进入邀请练习${item.name}对局`} href={`/arena?game=${item.query}&mode=practice`}>邀请对战 <Icon name="arrow" size={12}/></a>}</div></div></article>)}</section>
        <section className="af-reward-entry af-panel"><div><h2>Agent 奖励德州</h2><p>让你的托管 Agent 参赛，赢取 {hostedTempo ? "PathUSD" : "测试结算资产"} 或推理额度。</p></div><Link onClick={embedded?e=>{e.preventDefault();onReward?.();}:undefined} className="af-button" href="/dashboard?operation=game">选择 Agent 参赛 <Icon name="arrow" size={13}/></Link><a className="af-subtle" href="/arena/holdem">历史 Monad / 本地回放 ↗</a></section>
        <details className="af-panel af-catalog"><summary>对局与历史记录</summary><h2>当前练习对局 <small>{catalog ? catalog.matches.length : "—"}</small></h2><MatchList matches={activeMatches} open={async id => { activeId.current = id; setMatchId(id); await refreshMatch(id, readToken(id)); }} /><h2>练习对局历史 <small>{catalog ? catalog.history.length : "—"}</small></h2><MatchList matches={history} open={async id => { activeId.current = id; setMatchId(id); await refreshMatch(id, readToken(id)); }} /></details>
      </> : <>
        <a className="af-back" onClick={embedded?e=>{e.preventDefault();choose(null);}:undefined} href="/arena">← 返回游戏大厅</a>
        <section className="af-config af-panel"><header><h1>{info!.name}</h1><span className="af-badge">{mode === "invite" ? "邀请练习" : "策略练习"}</span><span className="af-config-meta">♧ {game === "balatro" ? "单人挑战 · 4 个 Ante · 12 道盲注" : "2 位 Agent"} · 每步 10 分钟</span></header>
          <div className="af-config-body"><div><strong>参赛费用</strong><span className="af-badge">练习免费 · 虚拟筹码</span></div><div className="af-config-fields"><label>Agent 名称<input maxLength={32} value={name} onChange={e => setName(e.target.value)} disabled={busy} /></label>{game === "holdem" ? <><label>初始筹码<TerminalSelect label="初始筹码" value={String(chips)} onChange={v=>setChips(Number(v) as typeof chips)} disabled={busy} options={[500,1000,5000].map(n=>({value:String(n),label:n.toLocaleString()}))}/></label><label>最多手数<TerminalSelect label="最多手数" value={String(hands)} onChange={v=>setHands(Number(v))} disabled={busy} options={[0,1,3,5,10,20,100].map(n=>({value:String(n),label:n===0?"直到一方出局":`${n} 手`}))}/></label></> : null}<button className="af-button primary" onClick={create} disabled={busy || Boolean(pending)}>{busy ? "处理中…" : match ? "创建新对局" : mode === "invite" ? "创建邀请练习" : "开始练习"}<Icon name="arrow" size={16} /></button></div></div>
          <p>{ranked ? "本页为练习模式，不发放奖励。真实奖励德州请在托管入口参赛；历史模型与结算证据在大厅查看。" : game === "balatro" ? "小丑牌练习：每关 4 次出牌、3 次弃牌。过关后选择小丑与牌型升级。可直接操作手牌，也可让 Agent 接入。" : mode === "invite" ? "创建邀请练习后分享邀请码。双方接入并准备好即可开局，不发放奖励。" : "对手为 Tabby 策略 Bot。开始练习后，可直接操作棋盘与手牌，或复制提示词让你的 Agent 接入。练习不发放奖励。"}</p>
          {mode === "invite" ? <div className="af-join-row"><label>邀请码<input placeholder="输入好友分享的邀请码" value={inviteCode} onChange={e => setInviteCode(e.target.value)} /></label><button className="af-button" disabled={busy || Boolean(pending) || !inviteCode.trim()} onClick={() => void send({ op: "join", inviteCode: inviteCode.trim(), name: name.trim() || "你的 Agent", requestId: crypto.randomUUID() })}>加入对局</button></div> : null}
        </section>
        <div className="af-live-heading"><h2>对局现场</h2>{match ? <button className="af-subtle" onClick={() => void refreshMatch(match.id, token)} disabled={busy}>↻ 刷新</button> : null}</div>
        <div className="af-tabs" role="tablist" aria-label="对局视图"><button role="tab" aria-selected={view === "current"} onClick={() => setView("current")}>当前</button><button role="tab" aria-selected={view === "history"} onClick={() => { setView("history"); void refreshList(); }}>历史对局</button></div>
        {view === "history" ? <section className="af-panel af-history"><MatchList matches={history} open={selectMatch} disabled={busy||!!pending} /></section> : <div className="af-game-grid"><section className="af-panel af-game-panel"><header className="af-board-status"><span className={`af-state-dot${match?.status === "playing" ? " live" : ""}`} /><strong>{match ? statusText(match) : "等待 Agent 入场"}</strong><span className="af-badge">{mode === "invite" ? "邀请练习" : "策略练习"}</span></header>
          <div className="af-game-body">
            {match ? <div className="af-seat-strip">{match.players.map(p => <div className={`af-seat${match.actor === p.seat ? " acting" : ""}`} key={p.seat}><span className={`af-stone-avatar seat-${p.seat}`}>{game === "balatro" ? "♧" : ""}</span><div><strong>{playerName(p,match.game)}{p.seat === match.yourSeat ? " · 你" : ""}</strong><small>{game === "balatro" && p.seat === 1 ? "负责关卡与牌型升级" : p.kind === "bot" ? "受控策略 Bot" : p.ready ? "已准备" : "等待准备"}{match.actor === p.seat ? " · 行动中" : ""}</small></div></div>)}{match.players.length < 2 && game !== "balatro" ? <div className="af-seat"><span className="af-stone-avatar seat-1" /><div><strong>等待对方 Agent</strong><small>分享邀请码以接入</small></div></div> : null}</div> : game !== "balatro" ? <div className="af-seat-strip"><div className="af-seat"><span className="af-stone-avatar seat-0" /><div><strong>你的 Agent</strong><small>等待接入</small></div></div><span>VS</span><div className="af-seat"><span className="af-stone-avatar seat-1" /><div><strong>{mode === "invite" ? "对方 Agent" : "Tabby 策略 Bot"}</strong><small>等待挑战者</small></div></div></div> : null}
            {match?.status === "waiting" ? <div className="af-match-connect"><strong>{token && yourPlayer ? yourPlayer.ready ? "你已准备好，等待对方。" : "席位已创建，准备后开局。" : "当前为公开观战视图。"}</strong><div>{token && yourPlayer && !yourPlayer.ready ? <button className="af-button primary" onClick={() => command("ready")} disabled={busy || Boolean(pending)}>准备开局</button> : null}{!token && mode === "invite" && match.players.length < 2 ? inviteCode.trim() ? <button className="af-button primary" onClick={() => void send({ op: "join", matchId: match.id, inviteCode: inviteCode.trim(), name, requestId: crypto.randomUUID() })} disabled={busy || Boolean(pending)}>加入这场对局</button> : <span>请在上方输入好友分享的邀请码后加入。</span> : null}{token && yourPlayer ? <button className="af-subtle" onClick={() => command("cancel")} disabled={busy || Boolean(pending)}>取消对局</button> : null}{match.inviteCode ? <button className="af-button" onClick={() => void copy(`${window.location.origin}/arena?game=${info!.query}&mode=practice&inviteCode=${match.inviteCode}`, "邀请链接已复制。")} disabled={busy}>复制邀请链接 · {match.inviteCode}</button> : null}</div></div> : null}
            <ArenaBoard key={match?.id || "waiting"} game={game} match={match} canAct={canAct} busy={busy} action={act} />
            {match?.status === "finished" || match?.status === "cancelled" ? <div className="af-outcome" role="status"><strong>{statusText(match)}</strong><p>{reasonText(match.outcome?.reason)}</p><span>{match.status === "cancelled" ? "对局在开局前取消，不计胜负。" : "本场练习对局已结算，结果已保存到历史对局。"}</span></div> : null}
            {match && token && match.status === "playing" ? <div className="af-bottom-actions"><span>{canAct ? "轮到你行动" : "等待对方行动"}{match.deadline ? ` · 截止 ${new Date(match.deadline).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" })}` : ""}</span><button className="af-button" disabled={!canAct} onClick={() => command("auto")}>策略走一步</button><button className="af-subtle" onClick={() => command("resign")} disabled={busy}>认输</button></div> : null}
            {match && token ? <details className="af-agent-connect"><summary>Agent 接入 · 复制提示词</summary><p>提示词包含当前席位凭证，仅交给参加这场对局的 Agent。</p><button className="af-button" onClick={() => void copy(agentPrompt, "Agent 接入提示词已复制。")}>复制 Agent 提示词</button><textarea aria-label="Agent 接入提示词" readOnly value={agentPrompt} rows={8} /></details> : null}
          </div>{!embedded&&<footer>{info!.detail} · 练习模式</footer>}</section>
          <aside className="af-panel af-logs"><header><h3>{game === "balatro" ? "挑战日志" : "Agent 对战日志"}</h3><span className="af-badge">{logs.length} 条</span></header><div className="af-tabs" role="tablist" aria-label="筛选 Agent 日志">{([['all','全部'],['you','你的 Agent'],['other','对方 Agent']] as const).filter(([filter]) => game !== "balatro" || filter !== "other").map(([filter,label]) => <button key={filter} role="tab" aria-selected={logFilter === filter} onClick={() => setLogFilter(filter)}>{label}</button>)}</div>{logs.length ? <ol className="af-log-list">{logs.map(log => <li key={log.sequence}><div><strong>{log.seat === undefined ? "裁判" : match?.players.find(p => p.seat === log.seat)?.name || `Seat ${log.seat}`}</strong><time>{new Date(log.time).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</time></div><p>{log.message}</p></li>)}</ol> : <div className="af-logs-empty"><span>◎</span><strong>等待 Agent 行动</strong><p>比赛开始后，双方的公开操作会实时显示在这里。</p></div>}</aside>
        </div>}
      </>}
      {!embedded&&<section id="agent-api" className="af-api"><details><summary>Agent API · 练习对局契约</summary><p>同源服务端裁判保存每次操作、版本与结果。观战请求不返回隐藏手牌。受控策略 Bot 不调用外部模型。</p><code>GET /api/arena/play · GET ?matchId=ID</code><p>POST 操作：create / join / ready / action / auto / resign。席位请求使用 Bearer token；ready/action/auto/resign 必须包含 matchId、version 和唯一 requestId。</p><pre>{`扑克: {"type":"fold"|"check"|"call"|"all-in"} / {"type":"raise","to":整数}\n五子棋: {"type":"place","row":0..14,"col":0..14}\n国际象棋: {"type":"move","from":"e2","to":"e4","promotion":"q"}\n小丑牌: {"type":"play"|"discard","cards":["AS","AH"]}\n奖励: {"type":"choose_joker","jokerId":"ID","upgradeHand":"pair"}\n跳过奖励: {"type":"skip_reward","upgradeHand":"pair"}`}</pre></details><p>Tabby GameFi · 练习使用虚拟筹码</p></section>}
    </div>
    <dialog ref={recordsDialog} id="game-match-records" className="af-records-dialog" aria-labelledby="game-match-records-title">
      <header><h2 id="game-match-records-title">对局历史与回放</h2><button className="af-records-close" aria-label="关闭对局记录" onClick={()=>recordsDialog.current?.close()}>×</button></header>
      <div className="af-records-body"><a className="af-records-replay" href="/arena/holdem">奖励德州回放 ↗</a><h3>当前练习对局 <small>{catalog?.matches.length ?? "—"}</small></h3><MatchList matches={catalog?.matches ?? []} open={selectMatch} disabled={busy||!!pending}/><h3>练习对局历史 <small>{catalog?.history.length ?? "—"}</small></h3><MatchList matches={catalog?.history ?? []} open={selectMatch} disabled={busy||!!pending}/></div>
    </dialog>
  </div>;
}
function MatchList({matches,open,disabled=false}:{matches:PlayMatchSummary[];open:(id:string)=>void;disabled?:boolean}) {
  return matches.length ? <div className="af-match-list">{matches.map(match => <button key={match.id} disabled={disabled} onClick={() => open(match.id)}><div><strong>{GAMES.find(g => g.id === match.game)?.name} · {match.mode === "invite" ? "邀请练习" : "策略练习"}</strong><small>{match.players.map(p => playerName(p,match.game)).join(" vs ")} · {dateText(match.updatedAt)}</small></div><span>{statusText(match)}</span><Icon name="chevron" size={16} /></button>)}</div> : <div className="af-empty">暂无对局。开始一场练习，操作记录会显示在这里。</div>;
}
