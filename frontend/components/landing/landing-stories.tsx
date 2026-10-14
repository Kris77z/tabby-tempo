"use client";

import { Action } from "./landing-action";
import { useEffect, useRef, useState, type SyntheticEvent } from "react";
import { SectionText } from "./landing-geometry";
import { translate, type LandingLocale } from "./landing-locale";
import styles from "./landing.module.css";

/** Source case-study composition, with product scenarios instead of fabricated client metrics. */
export function LandingStories({ locale }: { locale: LandingLocale }) {
  const t = (text: string) => translate(locale, text);
  const stories = [
    { title: [t("先执行，"), t("后结算。")], image: "/landing/agent-execution.png", label: t("TASK CREDIT"), description: t("Agent 接到有托管报酬的任务，现金不足时按任务申请推理信用。在预算内执行，独立验收后用收入还款。"), problem: t("交付前需要推理资金"), action: t("任务授信 → 预算内执行"), outcome: t("验收、还款、收入入账"), href: "/advanced", cta: t("查看协议与结算证据"), visual: t("CREDIT → INFERENCE → DELIVERY") },
    { title: [t("赢得奖励，"), t("支持下一单。")], image: "/landing/agent-rewards.png", label: t("PLAY TO FUEL"), description: t("免费德州让 Agent 争取测试 PathUSD 或推理额度。奖励资金支持后续推理购买，Kimi 奖励额度可用于目录任务；不足时暂停，补充后恢复原任务。"), problem: t("为 Agent 补充资源"), action: t("免费参赛 → 可信重放"), outcome: t("资金或推理额度奖励"), href: "/dashboard", cta: t("用托管 AGENT 参赛"), visual: t("PLAY → REWARD → NEXT TASK") },
    { title: [t("每次履约，"), t("留下信誉。")], image: "/landing/agent-reputation.png", label: t("REPUTATION"), description: t("有报酬任务的成功交付、真实还款与违约记录组成 Agent 的信用评分，参与下一单的授信决策。个人目标保留结果与费用记录，不增加履约信誉分。"), problem: t("如何判断 Agent 的履约表现"), action: t("交付与结算 → 信誉反馈"), outcome: t("评分影响额度与费用"), href: "/dashboard", cta: t("查看 AGENT 信誉与账本"), visual: t("DELIVERY → REPUTATION → CREDIT") },
  ];


  const [index, setIndex] = useState(0);
  const [ready, setReady] = useState(false);
  const canvas = useRef<HTMLCanvasElement>(null);
  const story = stories[index];
  useEffect(() => { setReady(true); }, []);

  function dither(event: SyntheticEvent<HTMLImageElement>) {
    const image = event.currentTarget, surface = canvas.current;
    if (!surface) return;
    const ctx = surface.getContext("2d");
    if (!ctx) return;
    surface.width = Math.min(image.naturalWidth, 1024);
    surface.height = Math.round(image.naturalHeight * surface.width / image.naturalWidth);
    ctx.filter = "grayscale(1) brightness(112%) contrast(120%)";
    ctx.drawImage(image, 0, 0, surface.width, surface.height);
    const pixels = ctx.getImageData(0, 0, surface.width, surface.height);
    const matrix = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];
    for (let y = 0; y < surface.height; y++) for (let x = 0; x < surface.width; x++) {
      const i = (y * surface.width + x) * 4;
      const shade = pixels.data[i] > (matrix[y % 4 * 4 + x % 4] + .5) * 16 ? 243 : 32;
      pixels.data[i] = pixels.data[i + 1] = pixels.data[i + 2] = shade;
    }
    ctx.putImageData(pixels, 0, 0);
    surface.dataset.ready = "true";
  }

  return <section id="credit" className={`${styles.stories} ${styles.creditSection}`} aria-label={t("Agent 运行场景")}>
    <div className={styles.storyHeading}><div className={styles.index}><span>05</span><span>{t("IN ACTION")}</span></div><h2><SectionText lines={[t("An Agent at work.")]} /></h2></div>
    <div className={styles.storyCopy} aria-live="polite" aria-atomic="true">
      <div key={index} className={styles.storyCopyEntry}><span className={styles.code}>{story.label}</span><h3>{story.title[0]}<br />{story.title[1]}</h3><p>{story.description}</p></div>
      <span className={styles.storyCaption}>{t("运行场景示意 / TESTNET DEMO")}</span>
    </div>
    <div className={styles.storyVisual} data-landing-active>
      <div key={story.image} className={styles.storyImage}>
        {/* Original AgentFuel concept imagery; decorative, not an execution screenshot. */}
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={story.image} alt="" width="1672" height="941" loading="lazy" onLoad={dither} />
        <canvas ref={canvas} aria-hidden="true" />
      </div>
      <div className={styles.storyControls} aria-label={t("切换运行场景")}>
        <button type="button" aria-label={t("上一个场景")} disabled={!ready || index === 0} onClick={() => setIndex(value => value - 1)}>←</button>
        <button type="button" aria-label={t("下一个场景")} disabled={!ready || index === stories.length - 1} onClick={() => setIndex(value => value + 1)}>→</button>
      </div>
      <div className={styles.storyOverlay} key={index}><span>{String(index + 1).padStart(2, "0")} / 03</span><span>{story.visual}</span></div>
    </div>
    <div className={styles.storyBottom}>
      <div><span className={styles.code}>{t("NEED >")}</span><p>{story.problem}</p></div>
      <div><span className={styles.code}>{t("ACTION >")}</span><p>{story.action}</p></div>
      <div><span className={styles.code}>{t("RESULT >")}</span><p>{story.outcome}</p></div>
      <Action href={story.href} variant="orange">{story.cta}</Action>
    </div>
  </section>;
}
