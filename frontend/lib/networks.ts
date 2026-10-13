/** Public network metadata only; RPC URLs and service credentials stay server-side. */
export const TEMPO_TESTNET = {
  chainId: "42431",
  name: "Tempo Moderato Testnet",
  explorerUrl: "https://explore.testnet.tempo.xyz",
  settlementSymbol: "PathUSD",
} as const;

const networks: Record<string, { name: string; explorerUrl: string; settlementSymbol: string }> = {
  [TEMPO_TESTNET.chainId]: TEMPO_TESTNET,
  "31337": { name: "本地 Anvil", explorerUrl: "", settlementSymbol: "USDC" },
  "10143": { name: "Monad Testnet", explorerUrl: "https://testnet.monadexplorer.com", settlementSymbol: "USDC" },
};

export function networkName(chainId: string): string { return networks[chainId]?.name ?? `Chain ${chainId}`; }
export function settlementSymbol(chainId: string = TEMPO_TESTNET.chainId): string { return networks[chainId]?.settlementSymbol ?? "结算资产"; }
export function hostedTransactionUrl(chainId: string | undefined, hash: string): string | null {
  const explorer = chainId ? networks[chainId]?.explorerUrl : undefined;
  return explorer && /^0x[0-9a-f]{64}$/i.test(hash) ? `${explorer}/tx/${hash}` : null;
}
export function hostedAddressUrl(chainId: string | undefined, address: string): string | null {
  const explorer = chainId ? networks[chainId]?.explorerUrl : undefined;
  return explorer && /^0x[0-9a-f]{40}$/i.test(address) ? `${explorer}/address/${address}` : null;
}

export function networkFeeSymbol(chainId: string = TEMPO_TESTNET.chainId): string { return chainId === "42431" ? "PathUSD" : chainId === "10143" ? "MON" : "ETH"; }
