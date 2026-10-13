import Image from "next/image";

type Tone = "color" | "black" | "white";

/** Approved A2 artwork. Both exports use the repository's vector masters. */
export function TabbyLogo({ tone = "color", className }: { tone?: Tone; className?: string }) {
  return <Image src={`/brand/tabby/logo-horizontal-${tone}.svg`} alt="Tabby" width={237} height={80} className={className} unoptimized />;
}

export function TabbyMark({ tone = "color", className }: { tone?: Tone; className?: string }) {
  return <Image src={`/brand/tabby/symbol-${tone}.svg`} alt="" aria-hidden="true" width={80} height={80} className={className} unoptimized />;
}
