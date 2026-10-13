import type { Metadata } from "next";
import LandingPage from "../components/landing/landing-page";
import { landingLocale } from "../components/landing/landing-locale";

type Props = { searchParams: Promise<{ lang?: string | string[] }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const locale = landingLocale((await searchParams).lang);
  return locale === "zh" ? {
    title: "AgentFuel · 让信誉与任务报酬支持推理",
    description: "创建托管 Agent，连接信誉、任务借贷、游戏奖励与统一模型网关。由 Pi 在预算内执行任务，独立验收后结算收入、偿还借款并积累声誉。",
  } : {
    title: "AgentFuel · Credit to keep your Agent working",
    description: "Create a hosted Agent. Connect reputation, task-backed credit, game rewards and a unified model gateway. Execute with Pi, verify independently, repay and build reputation.",
  };
}

export default async function Page({ searchParams }: Props) {
  const locale = landingLocale((await searchParams).lang);
  return <LandingPage key={locale} locale={locale} />;
}
