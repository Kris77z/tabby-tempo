import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonRpcProvider } from "ethers";
import { DockerExecutor } from "@agentfuel/arena/docker";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { loadConfig } from "../services/provider-relay/src/config.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import { FixedPriceSolvingRelay, FixedPriceRefunder } from "../services/provider-relay/src/fixed-price.js";
import { monadProvider, proxyUpstreamFetch, readRpcUrlFile, systemHttpsProxy } from "./demo-rpc.js";

/** Persistent fixed-price service; starting it does not create tasks or call a model. */
export async function startFixedRelay(env: NodeJS.ProcessEnv, injected?: { provider: JsonRpcProvider; modelFetch: typeof fetch; runner?: DockerExecutor }) {
  const configured = { ...env, ...(env.RPC_URL_FILE ? { RPC_URL: await readRpcUrlFile(env.RPC_URL_FILE) } : {}) };
  const config = loadConfig(configured);
  if (config.host !== "127.0.0.1" || ![31337n, 10143n].includes(config.chainId)) throw new Error("FIXED_RELAY_LOCAL_OPERATOR_ONLY");
  const rpcTransport = env.RPC_TRANSPORT ?? "direct", upstreamTransport = env.UPSTREAM_TRANSPORT ?? "direct";
  if (!["direct", "system-https-proxy"].includes(rpcTransport) || !["direct", "system-https-proxy"].includes(upstreamTransport)) throw new Error("INVALID_TRANSPORT");
  if (config.chainId === 31337n && (rpcTransport !== "direct" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.rpcUrl).hostname))) throw new Error("LOCAL_RPC_REQUIRED");
  let connection: Awaited<ReturnType<typeof monadProvider>> | undefined;
  let transport: ReturnType<typeof proxyUpstreamFetch> | undefined;
  let provider: JsonRpcProvider | undefined, relay: FixedPriceSolvingRelay | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  const owner = new SessionStore(resolve(config.dataDir, "service-owner"));
  const close = async () => {
    if (server?.listening) await new Promise<void>(done => { server!.close(() => done()); server!.closeIdleConnections(); });
    relay?.close(); transport?.close(); if (!injected) { if (connection) connection.close(); else provider?.destroy(); }
    await owner.close();
  };
  try {
    await owner.start(env.SOLVE_RECOVER_LOCK === "1");
    provider = injected?.provider;
    if (!provider) {
      if (config.chainId === 10143n) { connection = await monadProvider(config.rpcUrl, rpcTransport as "direct" | "system-https-proxy"); provider = connection.provider; }
      else provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    }
    const runner = injected?.runner ?? new DockerExecutor(); await runner.ready();
    if (!injected && upstreamTransport === "system-https-proxy") transport = proxyUpstreamFetch(await systemHttpsProxy(), config.upstreamTimeout);
    relay = new FixedPriceSolvingRelay(config, { provider, runner, modelFetch: injected?.modelFetch ?? transport?.fetch, recoverLock: env.SOLVE_RECOVER_LOCK === "1" });
    const refunder = new FixedPriceRefunder(relay);
    await relay.initialize(); await refunder.initialize(); await refunder.recover(); await relay.recover();
    server = createHttpServer(relay, refunder); server.listen(config.port, config.host); await once(server, "listening");
    return { server, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startFixedRelay(process.env).then(runtime => {
    console.log(JSON.stringify({ ready: true, service: "fixed-relay", port: (runtime.server.address() as { port: number }).port }));
    let closing = false; const stop = () => { if (!closing) { closing = true; void runtime.close(); } };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch(() => { console.error("FIXED_RELAY_START_FAILED"); process.exitCode = 1; });
}
