import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./terminal.module.css";

type Section = "hosted" | "arena" | "holdem" | "protocol";
const pages = [{ section: "home", href: "/", label: "产品首页" }, { section: "hosted", href: "/dashboard", label: "我的 Agent" }, { section: "arena", href: "/arena", label: "游戏大厅" }, { section: "protocol", href: "/advanced", label: "高级协议" }];

/** Agora dashboard title bar, shared without coupling page-specific API state. */
export function TerminalHeader({ workspace, actions, status, section, boundary, testId = "terminal-page-header", dotTestId = "terminal-page-dot", title }: { workspace: string; actions?: ReactNode; status?: string; section?: Section; boundary?: ReactNode; testId?: string; dotTestId?: string; title?: string }) {
  return <>
    <header className={styles.header} data-testid={testId}>
      <div className={styles.titleLeft}><div className={styles.windowDots} aria-hidden="true"><span data-testid={dotTestId} /><span data-testid={dotTestId} /><span data-testid={dotTestId} /></div><Link href="/" className={styles.prompt} aria-label="返回 AgentFuel 产品首页"><span>agentfuel</span><i>@</i>{workspace}<i>:</i><span>~</span><i>$</i></Link>{title && <h1 className={styles.srOnly}>{title}</h1>}</div>
      <div className={styles.actions}>{actions}{status && <span className={styles.status}>{status}</span>}</div>
    </header>
    {section && <nav className={styles.nav} aria-label="页面导航">{pages.map(page => <Link key={page.href} href={page.href} aria-current={page.section === section ? "page" : undefined}>{page.label}</Link>)}</nav>}
    {boundary && <div className={styles.boundary}>{boundary}</div>}
  </>;
}
