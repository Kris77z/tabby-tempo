import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { NonceManager, Wallet } from "ethers";
import { fixture, key, startAnvil, stopAnvil, tx } from "../services/underwriter/test/fixture.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { DemoJournal } from "./demo-journal.js";

export const SPONSORED_REWARD = 100000n; // Six-decimal mock USDC: 0.1 USDC.
export const REWARD_INFERENCE_PRICE = 10000n; // Six-decimal mock USDC: 0.01 USDC.

/** Local-only plumbing. The game never sends strategy decisions to this HTTP endpoint. */
export async function createHoldemFixture(directory: string, options: { loseResponseOnCall?: number } = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const privateDirectory = join(directory, ".private");
  await mkdir(privateDirectory, { mode: 0o700 });
  const local = await startAnvil();
  let f: Awaited<ReturnType<typeof fixture>> | undefined;
  let relay: Relay | undefined;
  let relayServer: ReturnType<typeof createHttpServer> | undefined;
  const calls: { model: string; request: unknown }[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    try {
      const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push({ model: body.model, request: body });
      // One actual loopback request can lose its response for recovery tests.
      if (options.loseResponseOnCall === calls.length) { req.socket.destroy(); return; }
      const response = { id: `controlled-reward-${calls.length}`, object: "chat.completion", model: body.model,
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "Reward-funded local inference completed." } }],
        usage: { prompt_tokens: 8, completion_tokens: 6, total_tokens: 14 } };
      res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify(response));
    } catch { res.writeHead(400); res.end(); }
  });
  const close = async () => {
    relayServer?.closeAllConnections();
    if (relayServer?.listening) await new Promise<void>(done => relayServer!.close(() => done()));
    relay?.close();
    upstream.closeAllConnections();
    if (upstream.listening) await new Promise<void>(done => upstream.close(() => done()));
    await f?.close(); await stopAnvil(local.child);
  };
  try {
    f = await fixture(local.rpc, join(privateDirectory, "underwriter"), 6);
    const signers = [new Wallet(key(2), f.provider), new Wallet(key(5), f.provider)] as const;
    const second = new NonceManager(signers[1]);
    await f.provider.send("anvil_setBalance", [signers[1].address, "0x3635c9adc5dea00000"]);
    await tx(f.identity, f.admin, "registerFor", [signers[1].address, signers[1].address]);
    await tx(f.manager, f.admin, "enrollAgent", [2n]);
    // This path is cash-only even if an unrelated credit authorization were supplied.
    const cashOnly = { maxCashPerTx: SPONSORED_REWARD, maxDebtPerTx: 0n, maxDebtPerDay: 0n, ownerFrozen: false };
    await tx(f.account, f.agent, "setPolicy", [1n, cashOnly]);
    await tx(f.account, second, "setPolicy", [2n, cashOnly]);
    await tx(f.token!, second, "approve", [await f.account.getAddress(), SPONSORED_REWARD]);
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening");
    const route = [{ name: "controlled-reward", model: "controlled-reward-physical", baseUrl: `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`, key: "synthetic-local-key" }];
    const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset,
      assetDecimals: 6, payTo: f.payee, service: { id: "infercredit/holdem-reward", model: "controlled-reward", price: REWARD_INFERENCE_PRICE, upstreams: route },
      dataDir: join(privateDirectory, "relay"), quoteTtl: 300, confirmations: 1, upstreamTimeout: 1000, host: "127.0.0.1", port: 8788 };
    relay = new Relay(config, { provider: f.provider }); await relay.initialize();
    relayServer = createHttpServer(relay, new Refunder(relay)); relayServer.listen(0, "127.0.0.1"); await once(relayServer, "listening");
    const sponsor = new Wallet(key(1), f.provider);
    const rewardJournal = new DemoJournal(f.provider, join(privateDirectory, "reward-journal.json")); await rewardJournal.load();
    return { local, f, signers, sponsor, privateDirectory, calls, relay, rewardJournal, config,
      relayUrl: `http://127.0.0.1:${(relayServer.address() as { port: number }).port}/v1/chat`, close };
  } catch (error) { await close(); throw error; }
}

export type HoldemFixture = Awaited<ReturnType<typeof createHoldemFixture>>;
