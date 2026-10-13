import type { ReactNode } from "react";
import localFont from "next/font/local";
import styles from "./terminal.module.css";

// The original Agora Dashboard font; copied with its SIL OFL license.
const terminalMono = localFont({ src: "../hosted/fonts/GeistMono-Variable.woff2", variable: "--font-geist-mono", weight: "100 900", adjustFontFallback: false, display: "swap" });
export function TerminalTheme({ children }: { children: ReactNode }) {
  return <div className={`${terminalMono.variable} ${styles.theme}`} data-testid="terminal-page-shell">{children}</div>;
}
