import Link from "next/link";
import type { ReactNode } from "react";
import styles from "./landing.module.css";

/** Oberon-style layered fill and leading arrow, shared by every landing CTA. */
export function Action({ href, children, variant = "light", className = "" }: { href: string; children: ReactNode; variant?: "light" | "dark" | "orange"; className?: string }) {
  return <Link href={href} className={`${styles.action} ${styles[variant]} ${className}`}>
    <span className={styles.actionLabel}>
      <span className={styles.actionArrow} aria-hidden="true"><svg viewBox="0 0 12 12" fill="none"><path d="M0 6h12M6 0l6 6-6 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg></span>
      <span>{children}</span>
    </span>
  </Link>;
}
