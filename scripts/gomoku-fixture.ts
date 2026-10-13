import { createServer } from "node:http";
import { once } from "node:events";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { NonceManager, Wallet } from "ethers";
import { fixture, key, startAnvil, stopAnvil, tx } from "../services/underwriter/test/fixture.js";
import { Relay } from "../services/provider-relay/src/relay.js";
import { Refunder } from "../services/provider-relay/src/refunder.js";
import { createHttpServer } from "../services/provider-relay/src/http.js";
import type { RelayConfig } from "../services/provider-relay/src/config.js";
import { RULES, type Side } from "../services/arena/src/gomoku/rules.js";
import type { MatchConfig, PlayerConfig } from "../services/arena/src/gomoku/match.js";

export interface GomokuUpstreamCall { model: string; request: any; response?: any; side: Side; matchId: string; ply: number }
export interface GomokuFixtureOptions {
  physicalModel?: string; price?: bigint; upstreamTimeoutMs?: number;
  /** Optional one-shot model responder behind the same actual loopback HTTP boundary. No CLI hook. */
  responder?: (call: GomokuUpstreamCall, signal: AbortSignal) => Promise<Response>;
}

export async function createGomokuFixture(directory: string, options: GomokuFixtureOptions = {}) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const local = await startAnvil(); let f: Awaited<ReturnType<typeof fixture>> | undefined;
  const relays: Relay[] = []; const servers: ReturnType<typeof createHttpServer>[] = [];
  const calls: GomokuUpstreamCall[] = [];
  const upstream = createServer(async (req, res) => {
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") { res.writeHead(404); res.end(); return; }
    const chunks: Buffer[] = []; for await (const chunk of req) chunks.push(Buffer.from(chunk)); const body = JSON.parse(Buffer.concat(chunks).toString());
    const game = JSON.parse(body.messages.at(-1).content); const side = game.side as Side;
    const entry = { model: body.model, request: body, side, matchId: game.matchId, ply: game.ply, response: undefined as any }; calls.push(entry);
    res.setHeader("content-type", "application/json");
    if (options.responder) {
      const abort = new AbortController(); const onClose = () => { if (!res.writableFinished) abort.abort(); }; res.once("close", onClose);
      try {
        const response = await options.responder(entry, abort.signal); const text = await response.text();
        try { entry.response = JSON.parse(text); } catch { entry.response = { rawText: text }; }
        res.writeHead(response.status, { "content-type": response.headers.get("content-type") || "application/json" }); res.end(text);
      } catch { req.socket.destroy(); }
      finally { res.removeListener("close", onClose); }
      return;
    }
    if (game.matchId.startsWith("lost-model")) { req.socket.destroy(); return; }
    if (game.matchId === "model-timeout") return;
    const marker = side === "black" ? "X" : "O"; const ownCount = game.board.join("").split("").filter((c: string) => c === marker).length;
    let content = JSON.stringify({ row: side === "black" ? 7 : 8, col: 3 + ownCount });
    if (game.matchId === "invalid-json") content = "I declare that I won";
    if (game.matchId === "occupied" && side === "white") content = JSON.stringify({ row: 7, col: 3 });
    const response = { id: `controlled-gomoku-${calls.length}`, object: "chat.completion", model: body.model,
      choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }], usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } };
    entry.response = response; res.end(JSON.stringify(response));
  });
  const cleanup = async () => {
    for (const server of servers) { server.closeAllConnections(); if (server.listening) await new Promise<void>(done => server.close(() => done())); }
    for (const relay of relays) relay.close();
    upstream.closeAllConnections(); if (upstream.listening) await new Promise<void>(done => upstream.close(() => done()));
    await f?.close(); await stopAnvil(local.child);
  };
  try {
    f = await fixture(local.rpc, join(directory, "underwriter"), 6);
    f.agent.reset(); await tx(f.account, f.agent, "depositCash", [1n, 460000n]);
    const whiteWallet = new Wallet(key(5), f.provider); const white = new NonceManager(whiteWallet);
    await f.provider.send("anvil_setBalance", [whiteWallet.address, "0x3635c9adc5dea00000"]);
    await tx(f.identity, f.admin, "registerFor", [whiteWallet.address, whiteWallet.address]);
    await tx(f.manager, f.admin, "enrollAgent", [2n]);
    await tx(f.account, white, "setPolicy", [2n, { maxCashPerTx: 1000000n, maxDebtPerTx: 1000000n, maxDebtPerDay: 10000000n, ownerFrozen: false }]);
    await tx(f.token!, f.admin, "mint", [whiteWallet.address, 500000n]);
    await tx(f.token!, white, "approve", [await f.account.getAddress(), 500000n]);
    await tx(f.account, white, "depositCash", [2n, 500000n]);
    upstream.listen(0, "127.0.0.1"); await once(upstream, "listening"); const upstreamUrl = `http://127.0.0.1:${(upstream.address() as { port: number }).port}/v1`;
    const playerConfigs = {} as Record<Side, PlayerConfig>;
    for (const side of ["black", "white"] as const) {
      const price = options.price ?? 1000n;
      const route = [{ name: `${options.responder ? "model-bridge" : "controlled"}-${side}`, model: options.physicalModel ?? `${side}-physical`, baseUrl: upstreamUrl, key: "synthetic-gomoku-upstream" }];
      const config: RelayConfig = { rpcUrl: local.rpc, chainId: 31337n, account: await f.account.getAddress(), asset: f.config.settlementAsset, assetDecimals: 6, payTo: f.payee,
        service: { id: "infercredit/gomoku", model: "gomoku", price, upstreams: route, tiers: { cheap: { price, upstreams: route }, strong: { price: price * 2n, upstreams: route } } },
        dataDir: join(directory, `relay-${side}`), quoteTtl: 300, confirmations: 1, upstreamTimeout: options.upstreamTimeoutMs ?? 1000, host: "127.0.0.1", port: 8788 };
      const relay = new Relay(config, { provider: f.provider }); await relay.initialize(); relays.push(relay);
      const server = createHttpServer(relay, new Refunder(relay)); server.listen(0, "127.0.0.1"); await once(server, "listening"); servers.push(server);
      playerConfigs[side] = { agentId: side === "black" ? "1" : "2", wallet: side === "black" ? f.agentAddress : whiteWallet.address, rpcUrl: local.rpc, chainId: "31337", account: config.account, asset: config.asset, provider: config.payTo,
        relayUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1/chat`, service: config.service.id, model: config.service.model, tier: "cheap", maxTotalPrice: "20000", maxPricePerMove: price.toString(), maxCompletionTokens: 128 };
    }
    const config = (matchId: string, overrides: Partial<Omit<MatchConfig, "players" | "matchId" | "rules">> = {}): MatchConfig => ({ matchId, rules: RULES, maxPlies: 225, deadlineMs: Date.now() + 120000, ...overrides, players: structuredClone(playerConfigs) });
    const signers = { black: new Wallet(key(2), f.provider), white: whiteWallet };
    return { local, f, calls, relays, servers, config, signers, close: cleanup };
  } catch (error) { await cleanup(); throw error; }
}
