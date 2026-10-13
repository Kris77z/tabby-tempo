import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./terminal.module.css";

type Section = "hosted" | "arena" | "holdem" | "protocol" | "finance";
const pages = [{ section: "hosted", href: "/dashboard", label: "Dashboard" }, { section: "arena", href: "/arena", label: "游戏大厅" }];

/** Agora dashboard title bar, shared without coupling page-specific API state. */
export function TerminalHeader({ workspace, actions, status, section, inlineNavigation = true, boundary, testId = "terminal-page-header", dotTestId = "terminal-page-dot", title }: { workspace: string; actions?: ReactNode; status?: string; section?: Section; inlineNavigation?: boolean; boundary?: ReactNode; testId?: string; dotTestId?: string; title?: string }) {
  const navigation = section && <nav className={inlineNavigation ? styles.inlineNav : styles.nav} aria-label="页面导航">{pages.map(page => <Link key={page.href} href={page.href} aria-current={page.section === section ? "page" : undefined}>{page.label}</Link>)}</nav>;
  return <>
    <header className={styles.header} data-testid={testId}>
      <div className={styles.titleLeft}><div className={styles.windowDots} aria-hidden="true"><span data-testid={dotTestId} /><span data-testid={dotTestId} /><span data-testid={dotTestId} /></div><Link href="/" className={styles.prompt} aria-label="返回 Tabby 产品首页"><span>Tabby</span></Link>{title && <h1 className={styles.srOnly}>{title}</h1>}</div>
      {inlineNavigation && navigation}
      <div className={styles.actions}>{actions}{status && <span className={styles.status}>{status}</span>}</div>
    </header>
    {!inlineNavigation && navigation}
    {boundary && <div className={styles.boundary}>{boundary}</div>}
  </>;
}
