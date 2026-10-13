import { TerminalTheme } from "../../components/terminal/terminal-theme";
import type { Metadata } from "next";
import { dashboard } from "../../lib/dashboard";
import DashboardApp from "../../components/dashboard-app";
import type { Dashboard } from "../../lib/types";
import { frontendTransport } from "../../lib/server-transport";
export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "协议档案与链上证据 · AgentFuel Tempo", description: "部署清单中 Agent 的信用档案、完整任务账本与链上协议证据。" };
export default async function AdvancedPage() {
  let initial: Dashboard;
  let arenaTimeoutMs = 15_000;
  try { arenaTimeoutMs = frontendTransport().arenaTimeoutMs; initial = await dashboard(); }
  catch { initial = { mode: "chain", configured: false, profiles: [], openTasks: [], updatedAt: new Date().toISOString(), message: "部署数据暂时无法读取，请稍后重试。" }; }
  return <TerminalTheme><DashboardApp initial={initial} arenaTimeoutMs={arenaTimeoutMs} /></TerminalTheme>;
}
