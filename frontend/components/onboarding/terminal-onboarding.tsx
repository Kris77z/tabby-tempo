"use client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { useHostedAgents } from "../../lib/hosted-agents-provider";
import { inputUsdc, strategyLabel, type AgentCreation, type AgentSettings } from "../../lib/hosted-client";
import { TerminalHeader } from "../terminal/terminal-header";
import { settlementSymbol } from "../../lib/networks";
import styles from "./onboarding.module.css";

type Line = { text: string; style: "cmd" | "out" | "ok" | "dim" | "accent" };
const bannerRow = (text: string) => `║${text.padStart(Math.floor((32 + text.length) / 2), " ").padEnd(32, " ")}║`;
const boot: Line[] = [
  { text: "$ tabby init --hosted", style: "cmd" },
  { text: "", style: "out" },
  { text: [`╔${"═".repeat(32)}╗`, bannerRow("T A B B Y"), bannerRow("Hosted Agent Terminal"), `╚${"═".repeat(32)}╝`].join("\n"), style: "accent" },
  { text: "", style: "out" },
  { text: "target: 你的钱包 → 独立托管 Agent", style: "dim" },
  { text: "钱包签名登录 / 为 Agent 命名 / 确认创建", style: "out" },
];
/** Port of Agora Mesh's terminal-onboarding: boot transcript, typewriter, one
 * command prompt at a time, review and launch. All facts come from the hosted API. */
export function TerminalOnboarding() {
  const state = useHostedAgents(), router = useRouter();
  const symbol = settlementSymbol(state.selected?.binding?.chainId);
  const labels = ["名称", "模型", "策略", `单次推理预算（${symbol}）`, `累计推理预算（${symbol}）`, "允许任务授信"];
  const [phase, setPhase] = useState<"boot" | "auth" | "config" | "review">("boot");
  const [input, setInput] = useState("");
  const [review, setReview] = useState<AgentCreation | null>(null), [error, setError] = useState("");
  const [lines, setLines] = useState<Line[]>(boot), [typed, setTyped] = useState(0);
  const [reducedMotion, setReducedMotion] = useState(false);
  const [paused, setPaused] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null), inputRef = useRef<HTMLInputElement>(null), composing = useRef(false), mounted = useRef(true);
  const models = state.snapshot?.models ?? [], authenticated = state.access === "authenticated" && !!state.owner;
  const blocked = state.busy || !!state.pending || !authenticated;
  const pendingCreate = state.pending?.kind === "create" ? state.pending : null;
  const identity = authenticated ? state.owner!.toLowerCase() : null, previousIdentity = useRef(identity);
  const allText = lines.map(line => line.text).join("\n"), typing = typed < allText.length;
  useEffect(() => { mounted.current = true; setReducedMotion(matchMedia("(prefers-reduced-motion: reduce)").matches); return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    const syncVisibility = () => setPaused(document.hidden);
    syncVisibility(); document.addEventListener("visibilitychange", syncVisibility);
    return () => document.removeEventListener("visibilitychange", syncVisibility);
  }, []);
  useEffect(() => {
    if (previousIdentity.current && previousIdentity.current !== identity) {
      setReview(null); setInput(""); setError(""); setLines(boot); setTyped(0); setPhase("auth");
    }
    previousIdentity.current = identity;
  }, [identity]);
  useEffect(() => {
    if (reducedMotion) { setTyped(allText.length); return; }
    if (!typing) return;
    const timer = setTimeout(() => setTyped(value => Math.min(allText.length, value + 8)), 12);
    return () => clearTimeout(timer);
  }, [allText.length, typed, typing, reducedMotion]);
  useEffect(() => { scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight }); }, [typed, phase, error, state.error, state.pending]);
  useEffect(() => { if (!typing && phase === "config") inputRef.current?.focus(); }, [typing, phase]);
  useEffect(() => {
    if (phase === "auth" && authenticated && !state.pending) {
      setLines(current => [...current, { text: `✓ owner ${state.owner}\n✓ 登录已确认\n\n$ agent create`, style: "ok" }]);
      setPhase("config");
    }
  }, [phase, authenticated, state.owner, state.pending]);
  const append = (text: string, style: Line["style"] = "cmd") => setLines(current => [...current, { text, style }]);
  function start() { append("\n$ wallet sign-in\n个人消息签名只用于平台登录，不发送链上交易。", "out"); setPhase("auth"); }
  async function login() { setError(""); await state.login(); }
  function next() {
    if (blocked || composing.current) return;
    const name = input.trim();
    if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) { setError("名称须为 1–80 个字符。"); return; }
    setError(""); setReview({ name }); setPhase("review");
    append(`✓ 名称 › ${name}\n\n$ agent create --review\n创建后，在工作台设置模型、预算和借贷权限。`, "out");
  }
  async function create() {
    if (!review || blocked) return;
    append("\n$ agent create --confirm\n等待服务器确认；请求 ID 和原参数已由托管客户端保存。", "out");
    if (await state.create(review) && mounted.current) router.push("/dashboard");
  }
  async function recover() {
    if (await state.retryPending() && mounted.current) router.push("/dashboard");
  }
  function edit() { setPhase("config"); setInput(review?.name ?? input); setError(""); append("\n$ agent create --edit"); }
  const effectiveReview = pendingCreate?.input ?? review;
  const legacyReview = effectiveReview && "modelId" in effectiveReview ? effectiveReview as AgentSettings : null;
  let offset = 0;
  const status = state.access === "loading" ? "CONNECTING" : state.access === "unavailable" ? "UNAVAILABLE" : authenticated ? state.busy ? "WAITING" : "AUTHENTICATED" : "SIGN IN REQUIRED";
  return <div className={styles.shell} data-testid="onboarding-terminal-shell" data-paused={paused}>
    <TerminalHeader workspace="onboarding" title="创建你的 Agent" testId="onboarding-terminal-header" status={status} actions={<Link className={styles.headerLink} href="/dashboard">进入工作台 →</Link>} />
    <div className={styles.screen}>
    <main ref={scrollRef} className={styles.terminal} aria-label="Agent 创建终端">
      <div className={styles.transcript} data-testid="onboarding-transcript" aria-hidden={typing ? true : undefined}>{lines.map((line, index) => {
        const text = line.text.slice(0, Math.max(0, typed - offset)); offset += line.text.length + 1;
        return <div key={index} className={styles[line.style]}>{text || "\u00a0"}</div>;
      })}{typing && <span className={styles.cursor} aria-hidden="true">▋</span>}</div>
      {!typing && phase === "boot" && !state.pending && <div className={styles.prompt}><span>按 Enter 开始创建你的 Agent</span><button autoFocus onClick={start}>开始创建 ↵</button></div>}
      {!typing && (phase === "auth" || !authenticated && phase !== "boot") && <div className={styles.prompt}>
        <p>› wallet sign-in <span className={styles.dim}>连接你的钱包，签署平台登录消息。</span></p>
        <button onClick={() => void login()} disabled={state.busy || state.access === "loading" || state.access === "unavailable"}>{state.busy ? "等待钱包…" : "签名登录"}</button>
        {state.access === "unavailable" && <button disabled={state.refreshing || state.busy} onClick={() => void state.refresh()}>重新读取平台状态</button>}
      </div>}
      {!typing && phase === "config" && authenticated && !state.pending && <form className={styles.commandForm} noValidate onSubmit={event => { event.preventDefault(); next(); }}>
        <div className={styles.questionLine}>
          <span className={styles.questionMark} aria-hidden="true">?</span>
          <label htmlFor="terminal-value">名称</label>
          <span className={styles.separator} aria-hidden="true">›</span>
          <input id="terminal-value" aria-label="名称" aria-describedby="terminal-hint" aria-invalid={!!error} aria-errormessage={error ? "terminal-error" : undefined} ref={inputRef} value={input} maxLength={80} enterKeyHint="done" required disabled={blocked} autoComplete="off" spellCheck={false} placeholder="your-agent" onChange={event => setInput(event.target.value)} onCompositionStart={() => { composing.current = true; }} onCompositionEnd={() => { composing.current = false; }} onKeyDown={event => { if (event.key === "Enter" && (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || event.repeat)) event.preventDefault(); }} />
          <button className={styles.enterKey} type="submit" disabled={blocked} aria-label="确认名称">↵</button>
        </div>
        <p id="terminal-hint" className={styles.hint}>Enter 确认 · 模型、预算和借贷权限在创建后设置</p>
      </form>}
      {!typing && effectiveReview && authenticated && (phase === "review" || !!pendingCreate) && <section className={styles.review} aria-label="确认创建 Agent">
        <p className={styles.accent}>{pendingCreate ? "原请求等待确认 · 已保存原参数" : "review / 确认创建 Agent"}</p>
        <dl><div><dt>名称</dt><dd>{effectiveReview.name}</dd></div></dl>
        {legacyReview ? <dl><div><dt>模型</dt><dd>{models.find(model => model.id === legacyReview.modelId)?.label ?? legacyReview.modelId}</dd></div><div><dt>策略</dt><dd>{strategyLabel[legacyReview.strategy]}</dd></div><div><dt>单次推理预算</dt><dd>{inputUsdc(legacyReview.perRunBudgetRaw)} USDC</dd></div><div><dt>累计推理预算</dt><dd>{inputUsdc(legacyReview.totalBudgetRaw)} USDC</dd></div><div><dt>任务授信</dt><dd>{legacyReview.allowCredit ? "允许申请" : "关闭"}</dd></div></dl>
          : <p className={styles.dim}>平台生成独立钱包并初始化链上身份。运行配置待设置，尚未授权推理消费或借贷。链上开户需要 Agent 钱包有 gas。</p>}
        {pendingCreate ? <><code className={styles.requestId}>{pendingCreate.input.requestId}</code><button disabled={state.busy} onClick={() => void recover()}>继续确认原请求</button></> : <div className={styles.reviewActions}><button disabled={state.busy} onClick={edit}>返回编辑</button><button disabled={blocked} onClick={() => void create()}>{state.busy ? "等待服务器…" : "确认创建"}</button></div>}
      </section>}
      {state.pending?.kind === "run" && authenticated && <p role="status">已有未确认的操作。请先<Link href="/dashboard">进入工作台</Link>，查看或恢复原请求。</p>}
      {error && <p id="terminal-error" className={styles.error} role="alert">✗ {error}</p>}
      {state.error && <p className={styles.error} role="alert">✗ {state.error}</p>}
      {state.access === "unavailable" && phase === "boot" && <p className={styles.dim}>平台服务尚不可用；连接恢复前无法登录或创建 Agent。</p>}
    </main>
    <div className={styles.tracking} aria-hidden="true" />
    </div>
    <footer className={styles.footer}><span>tabby@onboarding:~$</span><span>{status}</span><span>模型与预算 · 创建后设置</span></footer>
  </div>;
}
