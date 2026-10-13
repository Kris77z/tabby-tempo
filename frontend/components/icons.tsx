export function Icon({ name, size = 18 }: { name: "chevron-down" | "history" | "bot" | "copy" | "send" | "arrow" | "wallet" | "refresh" | "check" | "shield" | "identity" | "routing" | "external" | "chevron"; size?: number }) {
  const paths = { "chevron-down": "M6 9l6 6 6-6", history: "M3 11a9 9 0 1 1 2 7M3 4v7h7M12 7v5l3 2", bot: "M5 8h14v12H5zM12 8V4M10 4h4M2 12v4M22 12v4M9 12v2M15 12v2M9 17h6", copy: "M9 9h12v12H9zM15 9V3H3v12h6", send: "m22 2-7 20-4-9-9-4 20-7ZM22 2 11 13", arrow: "M4 12h16M14 6l6 6-6 6", wallet: "M3 6h16v14H3zM3 6V4h14v2M15 11h6v5h-6z",
    refresh: "M20 8a8 8 0 1 0 0 8M20 3v5h-5", check: "M5 12l4 4L19 6",
    shield: "M12 3l8 3v6c0 5-8 9-8 9s-8-4-8-9V6zM8 12l3 3 5-6",
    identity: "M4 3h16v18H4zM9 8a3 3 0 1 0 6 0 3 3 0 0 0-6 0M8 17c0-4 8-4 8 0",
    routing: "M4 12h6M10 12c3 0 3-7 7-7h3M10 12c3 0 3 7 7 7h3M16 2l4 3-4 3M16 16l4 3-4 3",
    external: "M14 3h7v7M21 3L10 14M10 3H3v18h18v-7", chevron: "M8 5l7 7-7 7" };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
export function Mark({ small = false }: { small?: boolean }) {
  return <span className={`brand-mark${small ? " small" : ""}`} aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M6 7h11v6H6zm9 12h11v6H15zM13 13h6v6h-6z" fill="currentColor" /></svg></span>;
}
