import type { Metadata } from "next";
import HostedApp from "../../components/hosted/hosted-app";
import { TerminalTheme } from "../../components/terminal/terminal-theme";

export const metadata: Metadata = { title: "Tabby · 托管 Agent 工作台" };
export default async function Page({searchParams}:{searchParams:Promise<Record<string,string|string[]|undefined>>}) {const query=await searchParams;return <TerminalTheme><HostedApp initialPanel={query.panel==='finance'?'finance':query.panel==='games'||query.section==='arena'?'games':'mission'} initialOperation={typeof query.operation==='string'?query.operation:undefined}/></TerminalTheme>; }
