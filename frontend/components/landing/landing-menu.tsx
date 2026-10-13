"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { translate, type LandingLocale } from "./landing-locale";
import styles from "./landing.module.css";

export function LandingMenu({ locale }: { locale: LandingLocale }) {
  const t = (text: string) => translate(locale, text);
  const links = [
    { href: "#capabilities", label: t("产品能力"), number: "02" },
    { href: "#how-it-works", label: t("运行方式"), number: "03" },
    { href: "#reputation", label: t("信誉与信用"), number: "04" },
    { href: "#credit", label: t("运行场景"), number: "05" },
    { href: "#arena", label: t("免费竞技场"), number: "06" },
    { href: "#faq", label: t("常见问题"), number: "08" },
  ];


  const [open, setOpen] = useState(false);
  const menu = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!open) return;
    function close(event: KeyboardEvent) {
      if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); }
    }
    function outside(event: PointerEvent) {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    }
    document.addEventListener("keydown", close);
    document.addEventListener("pointerdown", outside);
    return () => { document.removeEventListener("keydown", close); document.removeEventListener("pointerdown", outside); };
  }, [open]);

  return <div className={styles.menu} ref={menu}>
    <button ref={toggle} type="button" className={styles.menuToggle} aria-label={open ? t("关闭导航菜单") : t("打开导航菜单")} aria-expanded={open} aria-controls="landing-navigation" onClick={() => setOpen(value => !value)}>
      <span /><span />
    </button>
    {open ? <nav id="landing-navigation" className={styles.menuPanel} aria-label={t("首页导航")}>
      {links.map(link => <a key={link.href} href={link.href} onClick={() => setOpen(false)}><span>{link.number}</span>{link.label}<span>↗</span></a>)}
      <Link href="/dashboard" onClick={() => setOpen(false)}><span>→</span>{t("进入工作台")}<span>↗</span></Link>
      <Link href="/arena" onClick={() => setOpen(false)}><span>→</span>{t("游戏大厅")}<span>↗</span></Link>
      <Link href="/advanced" onClick={() => setOpen(false)}><span>→</span>{t("高级协议")}<span>↗</span></Link>
    </nav> : null}
  </div>;
}

/** Only progressive motion needs client JavaScript; landing content stays server-rendered. */
export function LandingMotion() {
  useEffect(() => {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches || !("IntersectionObserver" in window)) return;
    const elements = document.querySelectorAll<HTMLElement>("[data-landing-reveal]");
    const observer = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) { entry.target.classList.add(styles.visible); observer.unobserve(entry.target); }
    }, { threshold: 0.08 });
    for (const element of elements) { element.classList.add(styles.reveal); observer.observe(element); }

    // Chapter headings retain the source's character reveal; only the hero runs at first paint.
    const headings = document.querySelectorAll<HTMLElement>("[data-section-text]");
    const textObserver = new IntersectionObserver(entries => {
      for (const entry of entries) if (entry.isIntersecting) {
        (entry.target as HTMLElement).dataset.textVisible = "true";
        textObserver.unobserve(entry.target);
      }
    }, { threshold: .5 });
    for (const heading of headings) { heading.classList.add(styles.textReady); textObserver.observe(heading); }

    // Mechanical loops run only for visible modules, and stop when the tab is hidden.
    const active = document.querySelectorAll<HTMLElement>("[data-landing-active]");
    const visible = new Set<HTMLElement>();
    const update = () => { for (const element of active) element.dataset.inView = String(visible.has(element) && !document.hidden); };
    const activeObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement;
        if (entry.isIntersecting) visible.add(element); else visible.delete(element);
      }
      update();
    }, { threshold: .15 });
    for (const element of active) activeObserver.observe(element);
    document.addEventListener("visibilitychange", update);
    return () => {
      observer.disconnect(); textObserver.disconnect(); activeObserver.disconnect();
      document.removeEventListener("visibilitychange", update);
      for (const element of elements) element.classList.remove(styles.reveal);
      for (const heading of headings) heading.classList.remove(styles.textReady);
      for (const element of active) delete element.dataset.inView;
    };
  }, []);
  return null;
}
