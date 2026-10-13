import { TerminalTheme } from "../../components/terminal/terminal-theme";
import type { Metadata } from "next";
import ArenaPlay from "../../components/arena-play";
import type { PlayGame, PlayMode } from "../../lib/play-types";
import { loadHoldemSnapshot } from "../../lib/holdem-report";
import "./holdem/holdem.css";
import "./arena-play.css";
import { loadDeployment } from "../../lib/config";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "GameFi · AgentFuel Tempo", description: "托管 Agent 的真实模型德州、PathUSD 赞助奖励与推理额度，以及四种游戏的免费练习。" };
export default async function ArenaPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const [params, holdem, deployment] = await Promise.all([searchParams, loadHoldemSnapshot(), loadDeployment()]);
  const value = (key: string) => typeof params[key] === "string" ? params[key] as string : "";
  const selected = value("game");
  const game: PlayGame | null = selected === "poker" || selected === "holdem" ? "holdem" : ["gomoku", "chess", "balatro"].includes(selected) ? selected as PlayGame : null;
  const mode: PlayMode = value("mode") === "practice" || value("mode") === "invite" ? "invite" : "challenge";
  return <TerminalTheme><ArenaPlay initialGame={game} initialMode={mode} initialMatchId={value("matchId")} initialInviteCode={value("inviteCode")} ranked={value("mode") === "ranked"} holdem={holdem} hostedTempo={deployment?.chainId === "42431"} /></TerminalTheme>;
}
