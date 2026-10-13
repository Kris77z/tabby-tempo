import type { CSSProperties } from "react";
import styles from "./landing.module.css";

/** Oberon's small mechanical illustrations: quiet construction lines and moving orange parts. */
export function Geometry({ kind }: { kind: "identity" | "task" | "credit" | "game" | "model" | "record" }) {
  return <span className={styles.geometry} data-geometry={kind} aria-hidden="true">
    <svg viewBox="0 0 64 64" fill="none" strokeWidth="1.5">
      <g className={styles.geometryGuide}>
        {Array.from({ length: 16 }, (_, i) => <circle key={i} cx={11 + i % 4 * 12} cy={11 + Math.floor(i / 4) * 12} r=".7" fill="currentColor" stroke="none" />)}
        {kind === "record" ? <path d="m7 20 25-14 25 14v28L32 62 7 48ZM7 20l25 15 25-15M32 35v27" />
          : kind === "task" ? <path d="M8 5h30l14 14v38H8ZM38 5v14h14" />
            : kind === "identity" ? <><path d="M6 12h20l12 40h20M6 52h20l12-40h20" /><path d="m52 6 6 6-6 6m0 28 6 6-6 6" /></>
              : kind === "game" ? <><rect x="10" y="6" width="31" height="44" /><rect x="23" y="16" width="31" height="44" /></>
                : <><rect x="7" y="17" width="35" height="35" /><path d="M47 5h12v12M5 5h12M5 5v8M47 59h12V47" /></>}
      </g>
      {kind === "record" ? <g className={styles.geometryTrace}><path d="m7 42 18-15 11 9L58 12m-12 0h12v12" stroke="currentColor" /><rect x="15" y="10" width="8" height="8" fill="currentColor" stroke="none" /></g>
        : kind === "identity" ? <><rect className={styles.geometryTravel} x="8" y="8" width="8" height="8" fill="currentColor" stroke="none" /><rect className={styles.geometryTravelReverse} x="8" y="48" width="8" height="8" fill="currentColor" stroke="none" /></>
          : kind === "game" ? <g className={styles.geometryLift}><path d="m38 29 7 10-7 10-7-10Z" fill="currentColor" stroke="none" /></g>
            : kind === "task" ? <g className={styles.geometryLift}><rect x="21" y="26" width="22" height="25" fill="currentColor" stroke="none" /><path d="M28 33h8m-8 5h8m-8 5h4" stroke="white" /></g>
              : <g className={styles.geometryTile}><rect x="22" y="6" width="27" height="27" fill="currentColor" stroke="none" /><path d={kind === "model" ? "M31 14h9v9h-9ZM28 18h3m9 0h3M35 11v3m0 9v3" : "m31 24 10-10m-8 0h8v8"} stroke="white" /></g>}
    </svg>
  </span>;
}

export function NetworkLines() {
  return <svg className={styles.networkLines} viewBox="0 0 700 460" fill="none" aria-hidden="true">
    {Array.from({ length: 16 }, (_, i) => {
      const angle = i * Math.PI / 8;
      const x = 350 + Math.cos(angle) * 290, y = 230 + Math.sin(angle) * 190;
      return <g key={i} style={{ "--ray-delay": `${-i * .37}s` } as CSSProperties}>
        <path d={`M350 230L${x.toFixed(2)} ${y.toFixed(2)}`} stroke="currentColor" strokeDasharray={i % 2 ? "2 4" : "4 3"} />
        <g className={styles.networkParticle}><circle cx={x} cy={y} r={i % 3 ? 2 : 3} /></g>
      </g>;
    })}
  </svg>;
}

export function SectionText({ lines }: { lines: string[] }) {
  let order = 0;
  return <span data-section-text>{lines.map((line, index) => <span className={styles.sectionTextLine} key={index}>{line.split(" ").map((word, wi) => <span key={wi} className={styles.sectionWord}>{wi > 0 ? " " : null}{Array.from(word).map((letter, li) => <span key={li} data-section-character style={{ "--letter-order": order++ } as CSSProperties}>{letter}</span>)}</span>)}</span>)}</span>;
}
