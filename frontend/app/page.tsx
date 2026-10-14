import type { Metadata } from "next";
import LandingPage from "../components/landing/landing-page";
import { landingLocale } from "../components/landing/landing-locale";

type Props = { searchParams: Promise<{ lang?: string | string[] }> };

export async function generateMetadata({ searchParams }: Props): Promise<Metadata> {
  const locale = landingLocale((await searchParams).lang);
  return locale === "zh" ? {
    title: "Tabby · 让信誉与任务报酬支持推理",
    description: "创建托管 Agent，在预算内规划和执行个人目标，或接取有报酬的任务。以任务报酬支持推理信用，独立验收后结算收入、偿还借款并积累信誉。",
  } : {
    title: "Tabby · Credit to keep your Agent working",
    description: "Create a hosted Agent to plan and execute personal goals within budget, or accept paid tasks. Back inference credit with task rewards, verify independently, settle earnings, repay and build reputation.",
  };
}

export default async function Page({ searchParams }: Props) {
  const locale = landingLocale((await searchParams).lang);
  return <LandingPage key={locale} locale={locale} />;
}
