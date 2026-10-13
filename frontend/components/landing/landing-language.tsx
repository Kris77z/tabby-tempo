"use client";

import { useEffect, type MouseEvent } from "react";
import type { LandingLocale } from "./landing-locale";
import styles from "./landing.module.css";

export function LandingLanguage({ locale }: { locale: LandingLocale }) {
  useEffect(() => {
    const previous = document.documentElement.lang;
    document.documentElement.lang = locale === "zh" ? "zh-CN" : "en";
    return () => { document.documentElement.lang = previous; };
  }, [locale]);

  function preserveSection(event: MouseEvent<HTMLAnchorElement>) {
    // Keep native links (including new-tab navigation) and the current chapter.
    const destination = new URL(event.currentTarget.href);
    destination.hash = window.location.hash;
    event.currentTarget.href = destination.toString();
  }

  return <nav className={styles.language} aria-label={locale === "en" ? "Language" : "语言"}>
    <a href="/?lang=en" hrefLang="en" lang="en" aria-current={locale === "en" ? "page" : undefined} onClick={preserveSection}>EN</a>
    <span aria-hidden="true">/</span>
    <a href="/?lang=zh" hrefLang="zh-CN" lang="zh-CN" aria-current={locale === "zh" ? "page" : undefined} onClick={preserveSection}>中文</a>
  </nav>;
}
