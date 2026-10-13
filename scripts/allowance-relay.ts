import { once } from "node:events";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { JsonRpcProvider } from "ethers";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { loadConfig } from "../services/provider-relay/src/config.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import { ALLOWANCE_MODEL, ALLOWANCE_SERVICE, InferenceAllowanceRelay } from "../services/provider-relay/src/allowance.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { monadProvider, readRpcUrlFile } from "./demo-rpc.js";

/** Operator-only package issuer. It never calls a model or consumes provider API keys. */
export async function startAllowanceRelay(env: NodeJS.ProcessEnv, injected?: { provider: JsonRpcProvider }) {
  if (env.TIERS_JSON?.trim() || env.UPSTREAMS_JSON?.trim()) throw new Error("ALLOWANCE_HAS_NO_MODEL_UPSTREAMS");
  const config = loadConfig({ ...env, ...(env.RPC_URL_FILE ? { RPC_URL: await readRpcUrlFile(env.RPC_URL_FILE) } : {}),
    SERVICE_ID: ALLOWANCE_SERVICE, LOGICAL_MODEL: ALLOWANCE_MODEL, ALLOWANCE_LEDGER_KEY: "local-ledger-no-model-dispatch",
    UPSTREAMS_JSON: JSON.stringify([{ name: "allowance-ledger", model: ALLOWANCE_MODEL, baseUrl: "http://127.0.0.1/allowance-ledger", keyEnv: "ALLOWANCE_LEDGER_KEY" }]) });
  if (config.host !== "127.0.0.1" || ![31337n, 10143n].includes(config.chainId)) throw new Error("ALLOWANCE_RELAY_LOCAL_OPERATOR_ONLY");
  const transport = env.RPC_TRANSPORT ?? "direct";
  if (!["direct", "system-https-proxy"].includes(transport)) throw new Error("INVALID_TRANSPORT");
  if (config.chainId === 31337n && (transport !== "direct" || !["127.0.0.1", "localhost", "[::1]"].includes(new URL(config.rpcUrl).hostname))) throw new Error("LOCAL_RPC_REQUIRED");
  const owner = new SessionStore(resolve(config.dataDir, "service-owner"));
  let provider: JsonRpcProvider | undefined, relay: InferenceAllowanceRelay | undefined;
  let connection: Awaited<ReturnType<typeof monadProvider>> | undefined;
  let server: ReturnType<typeof createHttpServer> | undefined;
  const close = async () => {
    if (server?.listening) await new Promise<void>(done => { server!.close(() => done()); server!.closeIdleConnections(); });
    relay?.close(); if (!injected) { if (connection) connection.close(); else provider?.destroy(); }
    await owner.close();
  };
  try {
    await owner.start(env.ALLOWANCE_RECOVER_LOCK === "1"); provider = injected?.provider;
    if (!provider) {
      if (config.chainId === 10143n) { connection = await monadProvider(config.rpcUrl, transport as "direct" | "system-https-proxy"); provider = connection.provider; }
      else provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
    }
    relay = new InferenceAllowanceRelay(config, { provider, creditsRaw: env.ALLOWANCE_CREDITS_RAW ?? "", modelCatalogDigest: env.MODEL_CATALOG_DIGEST ?? "", recoverLock: env.ALLOWANCE_RECOVER_LOCK === "1" });
    const refunder = new Refunder(relay);
    await relay.initialize(); await refunder.initialize(); await refunder.recover(); await relay.recover();
    server = createHttpServer(relay, refunder); server.listen(config.port, config.host); await once(server, "listening");
    return { server, close };
  } catch (error) { await close(); throw error; }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  startAllowanceRelay(process.env).then(runtime => {
    console.log(JSON.stringify({ ready: true, service: "allowance-relay", port: (runtime.server.address() as { port: number }).port }));
    let closing = false; const stop = () => { if (!closing) { closing = true; void runtime.close(); } };
    process.once("SIGINT", stop); process.once("SIGTERM", stop);
  }).catch(() => { console.error("ALLOWANCE_RELAY_START_FAILED"); process.exitCode = 1; });
}
