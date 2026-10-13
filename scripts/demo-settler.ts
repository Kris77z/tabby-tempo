import { ArenaSettler } from "../services/arena/src/settler.js";
import { loadArenaConfig } from "../services/arena/src/protocol.js";
import { readSecret, loadMonadConfig } from "./demo-monad-config.js";
import { getAddress, Wallet } from "ethers";
import { chainRpcProvider, readRpcUrlFile, rpcRequest, type RpcTransport } from "./demo-rpc.js";
import { JsonRpcProvider } from "ethers";

// Only this independent process reads the verifier key file. The controller
// receives neither its bytes nor a public passed=true settlement endpoint.
let settler: ArenaSettler | undefined;
let connection: Awaited<ReturnType<typeof chainRpcProvider>> | undefined;
let closing: Promise<void> | undefined;
const close = () => closing ??= (async () => {
  try { await settler?.close(); }
  finally { connection?.close(); }
})();
try {
  const config = process.env.ARENA_CONFIG, file = process.env.ARENA_VERIFIER_KEY_FILE;
  if (!file) throw new Error("SETTLER_FILE_CONFIGURATION_REQUIRED");
  if (process.env.ARENA_KEY_CHECK_EXPECTED) {
    if (new Wallet(await readSecret(file)).address !== getAddress(process.env.ARENA_KEY_CHECK_EXPECTED)) throw new Error("VERIFIER_KEY_ADDRESS_MISMATCH");
    console.log(JSON.stringify({ checked: true }));
  } else {
    if (!config) throw new Error("SETTLER_FILE_CONFIGURATION_REQUIRED");
    const arenaConfig = await loadArenaConfig(config);
    const transport = process.env.ARENA_RPC_TRANSPORT ?? "direct";
    if (transport !== "direct" && transport !== "system-https-proxy") throw new Error("UNKNOWN_RPC_TRANSPORT");
    const rpcUrl = process.env.ARENA_RPC_URL_FILE ? await readRpcUrlFile(process.env.ARENA_RPC_URL_FILE)
      : process.env.ARENA_RPC_CONFIG_FILE ? (await loadMonadConfig(process.env.ARENA_RPC_CONFIG_FILE)).rpcUrl : arenaConfig.rpcUrl;
    if (transport === "system-https-proxy" || arenaConfig.chainId !== "31337") connection = await chainRpcProvider(rpcUrl, arenaConfig.chainId, transport as RpcTransport);
    else if (process.env.ARENA_RPC_URL_FILE) {
      const transport = rpcRequest(rpcUrl);
      const provider = new JsonRpcProvider(transport.request, undefined, { cacheTimeout: -1, pollingInterval: 100 });
      connection = { provider, proxyUrl: undefined, close: () => { provider.destroy(); transport.close(); } };
    }
    const ceiling = process.env.ARENA_MAX_FEE_PER_GAS;
    if (ceiling !== undefined && !/^[1-9][0-9]*$/.test(ceiling)) throw new Error("INVALID_GAS_CEILING");
    settler = new ArenaSettler(arenaConfig, await readSecret(file), connection?.provider, ceiling ? BigInt(ceiling) : undefined);
    await settler.start(); console.log(JSON.stringify({ ready: true, pid: process.pid }));
    const shutdown = () => void close().catch(() => { console.error("SETTLER_CLOSE_FAILED"); process.exitCode = 1; });
    process.once("SIGINT", shutdown); process.once("SIGTERM", shutdown);
  }
} catch (error) {
  await close();
  const message = (error as Error).message;
  console.error(/^[A-Z_]+$/.test(message) ? message : "SETTLER_START_FAILED"); process.exitCode = 1;
}
