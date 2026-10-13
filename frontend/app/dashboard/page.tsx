import type { Metadata } from "next";
import HostedApp from "../../components/hosted/hosted-app";
import { TerminalTheme } from "../../components/terminal/terminal-theme";

export const metadata: Metadata = { title: "AgentFuel · 托管 Agent 工作台" };
export default function Page() { return <TerminalTheme><HostedApp /></TerminalTheme>; }
