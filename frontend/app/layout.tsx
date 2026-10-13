import type { Metadata } from "next";
import "./globals.css";
import { HostedAgentsProvider } from "../lib/hosted-agents-provider";
export const metadata: Metadata = { title: "AgentFuel · 让信誉与任务报酬支持推理", description: "创建托管 Agent，连接信誉、任务借贷、游戏奖励与统一模型网关。由 Pi 在预算内执行任务，独立验收后结算收入、偿还借款并积累声誉。" };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body><HostedAgentsProvider>{children}</HostedAgentsProvider></body></html>;
}
