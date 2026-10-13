// Server-only: this module owns Node RPC transport and is never imported by client components.
import { JsonRpcProvider, Network } from "ethers";
import { setTimeout as delay } from "node:timers/promises";
import { readRpcUrlFile, rpcRequest, systemHttpsProxy, tempoReadTransport } from "../../scripts/demo-rpc";

export function frontendTransport(value = process.env.FRONTEND_RPC_TRANSPORT ?? "direct") {
  if (value !== "direct" && value !== "system-https-proxy") throw new Error("FRONTEND_RPC_TRANSPORT_INVALID");
  return { transport: value, creditTimeoutMs: value === "direct" ? 12_000 : 120_000, arenaTimeoutMs: value === "direct" ? 15_000 : 90_000 };
}

// Shared across SSR/API connections: nested task reads and overlapping page
// requests must not multiply the physical RPC concurrency.
let activeRpc = 0, nextRpcAt = 0;
let launchRpc: Promise<void> = Promise.resolve();
const waitingRpc: (() => void)[] = [];
async function boundedRpc<T>(interval: number, action: () => Promise<T>): Promise<T> {
  if (activeRpc >= 8) await new Promise<void>(resolve => waitingRpc.push(resolve));
  else activeRpc++;
  try {
    const launch = launchRpc.then(async () => {
      const wait = Math.max(0, nextRpcAt - Date.now());
      if (wait) await delay(wait);
      nextRpcAt = Date.now() + interval;
    });
    launchRpc = launch.catch(() => undefined);
    await launch;
    return await action();
  } finally {
    const next = waitingRpc.shift();
    if (next) next(); else activeRpc--;
  }
}

export async function createServerRpc(rpcUrl: string, resolveProxy = systemHttpsProxy, chainId?: string) {
  const { transport } = frontendTransport();
  const interval = Number(process.env.AGENTFUEL_RPC_INTERVAL_MS ?? "0");
  if (!Number.isInteger(interval) || interval < 0 || interval > 5000) throw new Error("RPC_INTERVAL_INVALID");
  const callGas = process.env.AGENTFUEL_RPC_CALL_GAS_LIMIT;
  if (callGas !== undefined && (!/^[1-9][0-9]*$/.test(callGas) || !Number.isSafeInteger(Number(callGas)) || Number(callGas) < 21000 || Number(callGas) > 1000000)) throw new Error("RPC_CALL_GAS_LIMIT_INVALID");
  const file = process.env.FRONTEND_RPC_URL_FILE;
  const effectiveRpcUrl = file ? await readRpcUrlFile(file) : rpcUrl;
  const proxyUrl = transport === "system-https-proxy" ? await resolveProxy() : undefined;
  const tempo = chainId === "42431" ? tempoReadTransport(effectiveRpcUrl) : undefined;
  const connection = rpcRequest(effectiveRpcUrl, proxyUrl, 30_000, transport === "system-https-proxy" || process.env.AGENTFUEL_RPC_RETRY_READ_503 === "1", tempo?.send, Boolean(tempo));
  const provider = new JsonRpcProvider(connection.request, chainId ? Network.from(BigInt(chainId)) : undefined,
    { ...(chainId ? { staticNetwork: true } : {}), cacheTimeout: -1, batchMaxCount: 1 });
  let closed = false;
  const originalSend = provider._send.bind(provider);
  provider._send = payload => {
    const send = () => {
    if (closed) throw Object.assign(new Error("RPC_CONNECTION_CLOSED"), { code: "CANCELLED" });
    const requests = Array.isArray(payload) ? payload : [payload];
    const adjusted = requests.map(request => {
      if (callGas === undefined || request.method !== "eth_call" || !Array.isArray(request.params) || !request.params[0] || request.params[0].gas !== undefined) return request;
      return { ...request, params: [{ ...request.params[0], gas: `0x${BigInt(callGas).toString(16)}` }, ...request.params.slice(1)] };
    });
      return originalSend(Array.isArray(payload) ? adjusted : adjusted[0]);
    };
    // Tempo's shared endpoint queue gates every HTTP attempt, including read
    // retries; avoid a separate outer queue with a different concurrency cap.
    return tempo ? send() : boundedRpc(interval, send);
  };
  return { provider, close() { closed = true; try { provider.destroy(); } finally { tempo?.close(); connection.close(); } } };
}
