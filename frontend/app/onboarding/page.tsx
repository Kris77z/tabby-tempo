import type { Metadata } from "next";
import { TerminalTheme } from "../../components/terminal/terminal-theme";
import { TerminalOnboarding } from "../../components/onboarding/terminal-onboarding";

export const metadata: Metadata = { title: "Tabby · 创建你的 Agent" };
export default function Page() { return <TerminalTheme><TerminalOnboarding /></TerminalTheme>; }
