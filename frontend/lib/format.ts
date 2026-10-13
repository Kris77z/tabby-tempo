// Display token values with integer arithmetic. No conversion of raw units through Number.
export function amount(raw: string | bigint, decimals: number, places = Math.min(decimals, 6)): string {
  const value = BigInt(raw), negative = value < 0n;
  const absolute = negative ? -value : value, scale = 10n ** BigInt(decimals);
  const whole = (absolute / scale).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const fraction = (absolute % scale).toString().padStart(decimals, "0").slice(0, places).replace(/0+$/, "");
  if (absolute !== 0n && absolute < scale && !fraction) return `${negative ? "−" : ""}<${places ? `0.${"0".repeat(places - 1)}1` : "1"}`;
  return `${negative ? "−" : ""}${whole}${fraction ? `.${fraction}` : ""}`;
}
export const short = (value: string, size = 6) => value.length > size * 2 + 1 ? `${value.slice(0, size + 2)}…${value.slice(-size)}` : value;
export const fee = (bps: string) => `${amount(bps, 2, 2)}%`;
export const ratio = (used: string | bigint, cap: string | bigint) => {
  const c = BigInt(cap), u = BigInt(used);
  return c > 0n ? Math.min(100, Math.max(0, Number(u * 10_000n / c) / 100)) : 0;
};
export const datetime = (timestamp: string | number) => new Date(Number(timestamp) * 1000).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai", hour12: false });
export const taskCreditCap = (net: string, ltv: string, feeBps: string, tierCap: string) => {
  const collateralCap = (BigInt(net) * BigInt(ltv) / 10_000n) * 10_000n / (10_000n + BigInt(feeBps));
  return collateralCap < BigInt(tierCap) ? collateralCap : BigInt(tierCap);
};
