"use client";
import { useState } from "react";
import type { PlayAction, PlayGame, PlayMatchView } from "../lib/play-types";
import type { PlayerView, HandResult } from "../../services/arena/src/holdem/engine";
import type { Board } from "../../services/arena/src/gomoku/rules";
import type { ChessView } from "../../services/arena/src/chess/rules";
import type { BalatroView, HandType } from "../../services/arena/src/balatro/rules";

interface BoardProps { game: PlayGame; match: PlayMatchView | null; canAct: boolean; busy: boolean; action: (action: PlayAction) => void }
interface PokerView extends PlayerView { handNumber: number; handsTotal: number; initialChips: number; handHistory: (HandResult & { handNumber: number; board: string[] })[] }
const SUITS: Record<string, string> = { s: "♠", h: "♥", d: "♦", c: "♣" };
const SUIT_ASSET: Record<string, string> = { s: "spades", h: "hearts", d: "diamonds", c: "clubs" };
const PIECES: Record<string, string> = { k: "king", q: "queen", r: "rook", b: "bishop", n: "knight", p: "pawn" };
const PIECE_NAMES: Record<string, string> = { k: "王", q: "后", r: "车", b: "象", n: "马", p: "兵" };
const HAND_NAMES: Record<HandType, string> = { high_card: "高牌", pair: "对子", two_pair: "两对", three_of_a_kind: "三条", straight: "顺子", flush: "同花", full_house: "葫芦", four_of_a_kind: "四条", straight_flush: "同花顺" };
const INITIAL_CHESS = ["rnbqkbnr", "pppppppp", "........", "........", "........", "........", "PPPPPPPP", "RNBQKBNR"].map(row => [...row].map(p => p === "." ? null : p));
const TARGETS = [300, 450, 600, 2000, 3000, 4000, 11000, 16500, 22000, 50000, 75000, 100000];
const number = (n: number) => n.toLocaleString("en-US");
export function ArenaBoard(props: BoardProps) {
  if (props.game === "holdem") return <PokerBoard {...props} />;
  if (props.game === "gomoku") return <GomokuBoard {...props} />;
  if (props.game === "chess") return <ChessBoard {...props} />;
  return <BalatroBoard {...props} />;
}
function Card({card,balatro=false}:{card?:string;balatro?:boolean}) {
  if (!card) return <span className="af-playing-card back" aria-label="隐藏手牌"><span>✦</span></span>;
  const suit=card[1]?.toLowerCase() || "s";
  const rank=card[0] === "T" ? "10" : card[0];
  return <span className={`af-playing-card${"hd".includes(suit) ? " red" : ""}${balatro ? " illustrated" : ""}`} aria-label={`${rank}${SUITS[suit]}`}><b>{rank}<small>{SUITS[suit]}</small></b>{balatro ? <img src={`/arena-assets/balatro/${SUIT_ASSET[suit]}-v1.webp`} alt="" width={280} height={280} /> : <span className="af-card-suit">{SUITS[suit]}</span>}<b className="af-card-bottom">{rank}<small>{SUITS[suit]}</small></b></span>;
}
function PokerBoard({match,canAct,action}:BoardProps) {
  const v=match?.gameView as unknown as PokerView | null;
  const [raiseTo,setRaiseTo]=useState(0);
  const raise=v?.legalActions.find(a=>a.type === "raise");
  const amount=raise ? Math.max(raise.minTo,Math.min(raise.maxTo,raiseTo || raise.minTo)) : 0;
  const you=match?.yourSeat;
  const yourSeat=you === 1 ? 1 : 0;
  const otherSeat=yourSeat === 0 ? 1 : 0;
  const showdown=v?.result?.showdown;
  const opponentCards=showdown?.find(p=>p.seat === otherSeat)?.holeCards || [];
  return <>
    <div className="af-poker-table"><div className="af-poker-top"><span>{match?.players.find(p=>p.seat === otherSeat)?.name || "对方 Agent"}</span><div className="af-hole-cards">{[0,1].map(i=><Card key={i} card={opponentCards[i]} />)}</div><strong>{v ? number(v.stacks[otherSeat]) : "—"} <small>虚拟筹码</small></strong></div>
      <div className="af-poker-center"><span>{v ? `第 ${v.handNumber} 手${v.handsTotal === 0 ? " · 直到一方出局" : ` / 共 ${v.handsTotal} 手`} · ${({preflop:"翻牌前",flop:"翻牌",turn:"转牌",river:"河牌"})[v.street]}` : "等待开局"}</span><div className="af-community-cards">{Array.from({length:5},(_,i)=><div className="af-community-slot" key={i}>{v?.board[i] ? <Card card={v.board[i]} /> : <span>♧</span>}</div>)}</div><strong>底池 {v ? number(v.pot) : "—"}<small>虚拟筹码</small></strong></div>
      <div className="af-poker-bottom"><div className="af-hole-cards">{[0,1].map(i=><Card key={i} card={you === null || you === undefined ? undefined : v?.holeCards[i]} />)}</div><span>{match?.players.find(p=>p.seat === yourSeat)?.name || "你的 Agent"}</span><strong>{v ? number(v.stacks[yourSeat]) : "—"} <small>虚拟筹码</small></strong></div>
    </div>
    {v && match?.yourSeat === null ? <p className="af-board-note">公开观战 · 双方隐藏手牌在摊牌前不可见。</p> : null}
    {v?.legalActions.length ? <div className="af-poker-controls">{v.legalActions.filter(a=>a.type !== "raise").map(a=><button className={`af-button${a.type === "check" || a.type === "call" ? " primary" : ""}`} key={a.type} disabled={!canAct} onClick={()=>action({type:a.type as "fold"|"check"|"call"|"all-in"})}>{a.type === "fold" ? "弃牌" : a.type === "check" ? "过牌" : a.type === "call" ? `跟注 ${"chips" in a ? a.chips : ""}` : "全下"}</button>)}{raise ? <div className="af-raise"><label>本街加注总额<input type="number" min={raise.minTo} max={raise.maxTo} step={1} value={amount} onChange={e=>setRaiseTo(Number(e.target.value))} disabled={!canAct} /></label><button className="af-button" disabled={!canAct} onClick={()=>action({type:"raise",to:amount})}>加注至 {amount}</button><small>{raise.minTo}–{raise.maxTo}</small></div> : null}</div> : null}
    {v?.handHistory.length ? <div className="af-hand-history"><h3>每手结果</h3><div className="af-table-scroll"><table><thead><tr><th>手数</th><th>公共牌</th><th>结果</th><th>双方筹码</th></tr></thead><tbody>{v.handHistory.map(hand=><tr key={hand.handNumber}><td>{hand.handNumber}</td><td className="mono">{hand.board.map(c=>`${c[0] === "T" ? "10" : c[0]}${SUITS[c[1]]}`).join(" ") || "—"}</td><td>{hand.reason === "fold" ? "弃牌" : "摊牌"} · {hand.winners.length === 2 ? "平分" : match?.players.find(p=>p.seat === hand.winners[0])?.name}</td><td>{hand.finalStacks.join(" / ")}</td></tr>)}</tbody></table></div></div> : null}
  </>;
}
function GomokuBoard({match,canAct,action}:BoardProps) {
  const v=match?.gameView as unknown as Board | null;
  const rows=v?.rows || Array.from({length:15},()=>".".repeat(15));
  const last=v?.moves.at(-1);
  return <div className="af-gomoku-wrap"><div className="af-gomoku-columns">{[..."ABCDEFGHIJKLMNO"].map(c=><span key={c}>{c}</span>)}</div><div className="af-gomoku-with-rows"><div className="af-gomoku-rows">{Array.from({length:15},(_,i)=><span key={i}>{i+1}</span>)}</div><div className="af-gomoku-board" aria-label="五子棋棋盘，A 至 O 列，1 至 15 行。选择空交点落子。">{rows.flatMap((row,r)=>[...row].map((marker,c)=><button key={`${r}:${c}`} aria-label={`${String.fromCharCode(65+c)}${r+1}, ${marker === "." ? "空位" : marker === "X" ? "黑子" : "白子"}`} disabled={!canAct || marker !== "."} onClick={()=>action({type:"place",row:r,col:c})} className={`${marker !== "." ? "occupied " : ""}${[3,7,11].includes(r) && [3,7,11].includes(c) ? "star" : ""}`}><span className={`af-gomoku-stone${marker === "O" ? " white" : ""}${last?.row === r && last.col === c ? " last" : ""}`} hidden={marker === "."} /></button>))}</div></div><p className="af-board-note">{v ? v.result ? `对局结束 · 共 ${v.moves.length} 步` : `第 ${v.moves.length+1} 步 · ${v.next === "black" ? "黑方" : "白方"}行棋` : "棋盘就绪，等待开局。"}</p></div>;
}
function ChessBoard({match,canAct,action}:BoardProps) {
  const v=match?.gameView as unknown as ChessView | null;
  const [from,setFrom]=useState("");
  const [promotion,setPromotion]=useState<"q"|"r"|"b"|"n">("q");
  const board=v?.board || INITIAL_CHESS;
  const legal=v?.legalMoves || [];
  const destinations=legal.filter(m=>m.from === from);
  function select(square:string) {
    const move=destinations.find(m=>m.to === square && (!m.promotion || m.promotion === promotion));
    if (move) { action({type:"move",from:move.from,to:move.to,...(move.promotion ? {promotion:move.promotion} : {})}); setFrom(""); }
    else setFrom(legal.some(m=>m.from === square) ? square : "");
  }
  return <><div className="af-chess-caption"><strong>{v ? `${v.turn === 0 ? "白方" : "黑方"}行棋${v.inCheck ? " · 将军" : ""}` : "标准国际象棋 · 白方先行"}</strong><span>选择棋子，再选择目标格</span></div><div className="af-chess-board" aria-label="国际象棋棋盘">{board.flatMap((row,r)=>row.map((piece,c)=>{
    const square=`${String.fromCharCode(97+c)}${8-r}`;
    const destination=destinations.some(m=>m.to === square);
    const recent=v?.lastMove?.from === square || v?.lastMove?.to === square;
    return <button key={square} className={`${(r+c)%2 ? "dark" : "light"}${from === square ? " selected" : ""}${destination ? " destination" : ""}${recent ? " recent" : ""}`} aria-label={`${square}${piece ? ` ${piece === piece.toUpperCase() ? "白" : "黑"}${PIECE_NAMES[piece.toLowerCase()]}` : " 空位"}${destination ? " 可移动" : ""}`} disabled={!canAct} onClick={()=>select(square)}>{c === 0 ? <small className="af-rank-label">{8-r}</small> : null}{r === 7 ? <small className="af-file-label">{String.fromCharCode(97+c)}</small> : null}{piece ? <img src={`/arena-assets/chess/${piece === piece.toUpperCase() ? "white" : "black"}-${PIECES[piece.toLowerCase()]}.webp`} alt="" width={160} height={160} /> : destination ? <span className="af-legal-dot" /> : null}</button>;
  }))}</div>{destinations.some(m=>m.promotion) ? <label className="af-promotion">升变棋子<select value={promotion} onChange={e=>setPromotion(e.target.value as typeof promotion)}><option value="q">后</option><option value="r">车</option><option value="b">象</option><option value="n">马</option></select></label> : null}<p className="af-board-note">{v ? `已行 ${v.ply} 步${v.lastMove ? ` · 上一步 ${v.lastMove.san}` : ""}` : "棋盘就绪，等待开局。"}</p>{v?.history.length ? <details className="af-chess-history"><summary>查看棋谱</summary><p>{v.history.map((san,i)=>`${i%2 === 0 ? `${Math.floor(i/2)+1}. ` : ""}${san}`).join(" ")}</p></details> : null}</>;
}
function BalatroBoard({match,canAct,action}:BoardProps) {
  const v=match?.gameView as unknown as BalatroView | null;
  const [selection,setSelection]=useState<string[]>([]);
  const [upgrade,setUpgrade]=useState<HandType>("pair");
  const [replace,setReplace]=useState("");
  const selected=selection.filter(c=>v?.hand.includes(c as never));
  const replacement=v?.jokers.some(j=>j.id === replace) ? replace : v?.jokers[0]?.id || "";
  const targets=v?.targets || TARGETS;
  function choose(card:string) { setSelection(previous=>previous.includes(card) ? previous.filter(c=>c !== card) : previous.length < 5 ? [...previous,card] : previous); }
  function submit(type:"play"|"discard") { action({type,cards:selected}); setSelection([]); }
  return <div className="af-balatro"><span className="af-balatro-eyebrow">BALATRO LITE · AGENT CHALLENGE</span><h2>{v?.phase === "reward" ? "通过盲注，选择下一关奖励。" : v?.phase === "complete" ? "挑战结束，查看得分与记录。" : "打出组合，闯过 4 个 Ante · 12 道盲注。"}</h2><p>单人构筑挑战 · 服务端裁判 · 游戏得分无需投入资金</p><div className="af-blind-grid">{targets.map((target,i)=><div className={`${v?.round === i+1 ? "current" : ""}${v && i < v.cleared ? " cleared" : ""}`} key={target}><span>{i+1} / Ante {Math.floor(i/3)+1} · {["小盲注","大盲注","Boss 盲注"][i%3]}</span><strong>{number(target)} 分{v && i < v.cleared ? " ✓" : ""}</strong></div>)}</div><div className="af-balatro-stats"><div><small>本关得分 / 目标</small><strong>{v ? number(v.roundScore) : "0"}<span> / {number(v?.target || 300)}</span></strong></div><div><small>剩余出牌</small><strong>{v?.handsLeft ?? 4}</strong></div><div><small>剩余弃牌</small><strong>{v?.discardsLeft ?? 3}</strong></div><div><small>累计得分</small><strong>{v ? number(v.totalScore) : "0"}</strong></div></div><progress value={v?.roundScore || 0} max={v?.target || 300} aria-label="盲注完成进度" /><div className="af-jokers-heading"><strong>已装备小丑</strong><small>{v?.jokers.length || 0} / 5 槽位</small></div>{v?.jokers.length ? <div className="af-joker-cards">{v.jokers.map(j=><div key={j.id}><span>✦</span><strong>{j.name}</strong><p>{j.description}</p></div>)}</div> : <p className="af-joker-empty">尚无小丑。通过第一关后，选择奖励构筑组合。</p>}
    {v?.phase === "reward" ? <div className="af-rewards"><h3>关卡奖励</h3><label>牌型升级 · +3 级<select value={upgrade} onChange={e=>setUpgrade(e.target.value as HandType)}>{Object.entries(HAND_NAMES).map(([id,label])=><option key={id} value={id}>{label} · Lv.{v.handLevels[id as HandType]}</option>)}</select></label>{v.jokers.length >= v.jokerSlots ? <label>替换已装备的小丑<select value={replacement} onChange={e=>setReplace(e.target.value)}>{v.jokers.map(j=><option value={j.id} key={j.id}>{j.name}</option>)}</select></label> : null}<div className="af-joker-cards">{v.rewardChoices.map(j=><button key={j.id} disabled={!canAct} onClick={()=>action({type:"choose_joker",jokerId:j.id,upgradeHand:upgrade,...(v.jokers.length >= v.jokerSlots ? {replaceJokerId:replacement} : {})})}><span>✦</span><strong>{j.name}</strong><p>{j.description}</p><small>选择奖励 →</small></button>)}</div><button className="af-button" disabled={!canAct} onClick={()=>action({type:"skip_reward",upgradeHand:upgrade})}>跳过小丑 · 只升级牌型</button></div> : null}
    <div className="af-hand-heading"><span>{v ? "选择手牌 · 最多 5 张" : "手牌将在开局后发放"}</span><span>牌堆剩余 {v?.deckRemaining ?? "—"} 张</span></div>{v?.hand.length ? <div className="af-balatro-hand">{v.hand.map(card=><button key={card} role="checkbox" aria-checked={selected.includes(card)} aria-label={`${card} ${selected.includes(card) ? "已选择" : "未选择"}`} disabled={!canAct || v.phase !== "playing" || selected.length >= 5 && !selected.includes(card)} onClick={()=>choose(card)} className={selected.includes(card) ? "selected" : ""}><Card card={card} balatro /><small>{card[0] === "A" ? 11 : "TJQK".includes(card[0]) ? 10 : Number(card[0])} 筹码</small></button>)}</div> : <div className="af-hand-placeholder">开始游戏并准备后，服务端会发出 8 张手牌。</div>}{v?.phase === "playing" ? <div className="af-balatro-actions"><span>已选 {selected.length} / 5 张</span><button className="af-button primary" disabled={!canAct || !selected.length || !v.handsLeft} onClick={()=>submit("play")}>出牌</button><button className="af-button" disabled={!canAct || !selected.length || !v.discardsLeft} onClick={()=>submit("discard")}>弃牌</button><button className="af-subtle" disabled={!selected.length} onClick={()=>setSelection([])}>清空选择</button></div> : null}{v?.lastScore ? <div className="af-score"><strong>{v.lastScore.handName} · {number(v.lastScore.score)} 分</strong><p>{number(v.lastScore.chips)} 筹码 × {v.lastScore.mult} 倍率</p>{v.lastScore.effects.length ? <p>{v.lastScore.effects.join(" · ")}</p> : null}</div> : null}<details className="af-balatro-rules"><summary>牌型与简化规则</summary><p>每关最多出牌 4 次、弃牌 3 次，每次选择 1–5 张。得分为筹码 × 倍率；只有组成牌型的牌计分。A 为 11 筹码，J/Q/K/10 为 10，其余按点数。每关重置手牌与牌堆，保留小丑和牌型等级。</p>{v ? <div className="af-hand-levels">{Object.entries(HAND_NAMES).map(([id,label])=><span key={id}>{label} <b>Lv.{v.handLevels[id as HandType]}</b></span>)}</div> : null}</details>
  </div>;
}
