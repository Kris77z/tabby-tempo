import { TerminalTheme } from "../../../components/terminal/terminal-theme";
import "server-only";
import type { Metadata } from "next";
import HoldemArena from "../../../components/holdem-arena";
import { loadHoldemSnapshot } from "../../../lib/holdem-report";
import "./holdem.css";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "德州证据 · AgentFuel", description: "免费双人德州公开回放、赞助奖励与推理消费证据。" };
export default async function HoldemPage() {
  return <TerminalTheme><HoldemArena initial={await loadHoldemSnapshot()} /></TerminalTheme>;
}
