"use client";
import * as React from "react";
import { Icon } from "../icons";
import styles from "./hosted.module.css";
import { actionLabel, statusLabel, strategyLabel, type HostedAgent, type HostedRun } from "../../lib/hosted-client";
import { hostedAddressUrl, settlementSymbol } from "../../lib/networks";
import { short } from "../../lib/format";

// Adapted from Agora Mesh src/components/ui/card.tsx. Keep its composable structure.
const Card = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) =>
  <div ref={ref} className={`${styles.card} ${className ?? ""}`} {...props} />);
Card.displayName = "Card";
const CardHeader = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) =>
  <div ref={ref} className={`${styles.cardHeader} ${className ?? ""}`} {...props} />);
CardHeader.displayName = "CardHeader";
const CardContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(({ className, ...props }, ref) =>
  <div ref={ref} className={`${styles.cardContent} ${className ?? ""}`} {...props} />);
CardContent.displayName = "CardContent";
export { Card, CardHeader, CardContent };

// Agora src/components/panels/status-orb.tsx terminal markers and breathing state.
export function StatusOrb({ status }: { status: string }) {
  const running = ["Pending", "Running", "Queued"].includes(status);
  return <span aria-hidden="true" className={`${styles.orb} ${status === "Failed" ? styles.orbError : status === "Paused" || running ? styles.orbPaused : status === "Ready" ? styles.orbIdle : styles.orbReady} ${running || status === "Ready" ? styles.orbActive : ""}`} />;
}
// Agora MissionTimeline / LiveRunStats bracketed terminal status markers.
export function Badge({ children, status, outline }: { children: React.ReactNode; status?: string; outline?: boolean }) {
  return <span className={`${styles.badge} ${outline ? styles.badgeOutline : ""} ${status === "Failed" ? styles.badgeError : status === "Paused" || status === "Pending" ? styles.badgeWarning : ""}`}>[{status && <StatusOrb status={status} />}{children}]</span>;
}
// Agora AgentIdentityCard's connected identity/copy-wallet block, now a user-owned wallet.
export function AgentIdentityCard({ agent, description, balance, nameControl }: { agent: HostedAgent; description?: string; balance?: string; nameControl?: React.ReactNode }) {
  const [copyState, setCopyState] = React.useState("");
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  async function copyAddress() {
    try { await navigator.clipboard.writeText(agent.wallet); setCopyState("已复制"); }
    catch { setCopyState("复制失败，请选中下方地址复制"); }
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopyState(""), 2500);
  }
  return <div className={styles.identity}>
    <div className={styles.identityHeading}><span aria-hidden="true">🤖</span><div><div className={styles.identityTitle}>{nameControl??<h2>{agent.name}</h2>}<div className={styles.walletBlock}>{hostedAddressUrl(agent.binding?.chainId,agent.wallet)&&<a href={hostedAddressUrl(agent.binding?.chainId,agent.wallet)!} target="_blank" rel="noopener noreferrer" aria-label="查看钱包 ↗"> ↗</a>}<code title={agent.wallet}>{short(agent.wallet,4)}</code><button className={styles.iconButton} aria-label="复制地址" title={copyState || "复制地址"} onClick={() => void copyAddress()}><Icon name={copyState === "已复制" ? "check" : "copy"} size={14} /></button><span className={styles.srOnly} role="status">{copyState}</span></div></div>{description!==""&&<p>{description??"平台托管 Agent · 独立钱包执行与结算"}</p>}{balance&&<small className={styles.identityBalance}>{balance}</small>}</div></div>
  </div>;
}

// Compact selectable node row, using AgentMeshPanel's title/status and kind/id rows.
// Listing is for the authenticated owner's hosted Agents, never a synthetic mesh.
export function AgentServiceCard({ agent, model, selected, onSelect }: { agent: HostedAgent; model: string; selected: boolean; onSelect: () => void }) {
  return <article className={`${styles.serviceCard} ${selected ? styles.serviceSelected : ""}`} data-testid={`hosted-agent-${agent.id}`}>
    <div className={styles.rowBetween}><p>{agent.name}</p><Badge status={agent.status}>{statusLabel[agent.status]}</Badge></div>
    <p className={styles.micro}>{model} · {strategyLabel[agent.strategy]} · {short(agent.wallet, 4)}</p>
    <button className={styles.textButton} aria-pressed={selected} onClick={onSelect}>{selected ? "当前 Agent" : "查看 Agent"} →</button>
  </article>;
}

// Agora CollapsibleSection's label/toggle/content organization. Native details keeps
// keyboard operation without importing the unrelated terminal animation dependency.
export function CollapsibleSection({ label, children, defaultOpen = false }: { label: string; children: React.ReactNode; defaultOpen?: boolean }) {
  return <details className={styles.collapsible} open={defaultOpen || undefined}><summary>{label}<Icon name="chevron" size={13} /></summary><div>{children}</div></details>;
}

export function runTitle(run: HostedRun, chainId?: string) { return `${actionLabel[run.action]}${run.rewardKind ? run.rewardKind === "usdc" ? ` · ${settlementSymbol(run.result?.chainId ?? chainId)} 奖励` : " · LLM credits 奖励" : ""}`; }
