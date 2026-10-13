export interface Counts { repayment: bigint; success: bigint; default: bigint }

export function creditTerms(mirror: Counts, trueRepayments: bigint) {
  const min10 = (n: bigint) => n < 10n ? n : 10n;
  const score = 500n + 40n * min10(mirror.repayment) + 30n * min10(mirror.success) - 400n * mirror.default;
  if (score >= 700n && mirror.repayment >= 3n && trueRepayments >= 3n) {
    return { score, tier: "A", riskTier: 1, feeBps: 300n, capUsdCents: 200n };
  }
  if (score >= 580n && mirror.repayment >= 1n && trueRepayments >= 1n) {
    return { score, tier: "B", riskTier: 2, feeBps: 800n, capUsdCents: 50n };
  }
  return { score, tier: "C", riskTier: 3, feeBps: 1500n, capUsdCents: 20n };
}

export function principalCap(capUsdCents: bigint, decimals: number, tokenUsdPrice: bigint,
  payableEscrow: bigint, ltvBps: bigint, feeBps: bigint) {
  const tierCap = capUsdCents * (10n ** BigInt(decimals)) * (10n ** 18n) / (100n * tokenUsdPrice);
  const escrowCap = (payableEscrow * ltvBps / 10_000n) * 10_000n / (10_000n + feeBps);
  return { tierCap, escrowCap, principalCap: tierCap < escrowCap ? tierCap : escrowCap };
}
