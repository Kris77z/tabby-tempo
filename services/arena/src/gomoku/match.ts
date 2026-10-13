import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getAddress, JsonRpcProvider, Transaction, type Signer } from "ethers";
import { SessionStore } from "@agentfuel/pi-loop/session";
import { InferCredit, PaymentError, accountInterface, canonical, paymentId, requestDigest, sameAddress, uint,
  type Inference, type Json, type PaymentHandle, type RoutingTier } from "@agentfuel/sdk";
import { boardHash, emptyBoard, IllegalMove, other, parseDecision, play, RULES, type Board, type Side } from "./rules.js";

export interface PlayerConfig {
  agentId: string; wallet: string; rpcUrl: string; chainId: string; account: string; asset: string; provider: string;
  relayUrl: string; service: string; model: string; tier: RoutingTier; maxTotalPrice: string; maxPricePerMove: string; maxCompletionTokens: number;
  thinking?: { type: "disabled" }; reasoning_effort?: "low";
}
export interface MatchConfig { matchId: string; rules: typeof RULES; maxPlies: number; deadlineMs: number; players: Record<Side, PlayerConfig> }
type RequestBody = Record<string, Json> & { service: string; model: string; tier: RoutingTier; messages: Json[] };
export interface Turn {
  ply: number; side: Side; boardHash: string; body: RequestBody; dispatchIntent: boolean; handle?: PaymentHandle;
  inference?: Inference; rawPaymentReceipt?: Json; applied: boolean; afterBoardHash?: string; rejection?: string;
}
export interface MatchSession {
  version: 1; binding: string; config: MatchConfig; phase: "Running" | "Paused" | "Stopped" | "Finished"; reason?: string;
  result?: { kind: "win" | "forfeit"; winner: Side; reason?: string } | { kind: "draw" };
  reservedPrice: Record<Side, string>; turns: Turn[];
}
export interface MatchOptions { signers: Record<Side, Signer>; recoverLock?: boolean; timeoutMs?: number; stopAfterPlies?: number }
const digest = (value: unknown) => createHash("sha256").update(canonical(value as Json)).digest("hex");
const fail = (code: string): never => { throw new PaymentError(code, code); };

export function validateMatchConfig(value: unknown): MatchConfig {
  const c = value as MatchConfig;
  if (!c || typeof c !== "object" || Object.keys(c).sort().join(",") !== "deadlineMs,matchId,maxPlies,players,rules" || !/^[a-zA-Z0-9_-]{1,80}$/.test(c.matchId) || c.rules !== RULES || !Number.isSafeInteger(c.maxPlies) || c.maxPlies < 1 || c.maxPlies > 225 ||
    !Number.isSafeInteger(c.deadlineMs) || c.deadlineMs < 1 || !c.players || Object.keys(c.players).sort().join(",") !== "black,white") throw new Error("INVALID_GOMOKU_CONFIG");
  for (const player of Object.values(c.players)) {
    if (!player || !player.service || !player.model || !["cheap", "strong"].includes(player.tier) || !Number.isInteger(player.maxCompletionTokens) || player.maxCompletionTokens < 1 || player.maxCompletionTokens > 1024) throw new Error("INVALID_PLAYER_CONFIG");
    if (Object.keys(player).some(key => !["agentId", "wallet", "rpcUrl", "chainId", "account", "asset", "provider", "relayUrl", "service", "model", "tier", "maxTotalPrice", "maxPricePerMove", "maxCompletionTokens", "thinking", "reasoning_effort"].includes(key))) throw new Error("UNKNOWN_PLAYER_CONFIG_FIELD");
    for (const field of ["agentId", "chainId", "maxTotalPrice", "maxPricePerMove"] as const) if (uint(player[field], field) === 0n) throw new Error("INVALID_PLAYER_CONFIG");
    for (const field of ["wallet", "account", "asset", "provider"] as const) getAddress(player[field]);
    for (const field of ["rpcUrl", "relayUrl"] as const) { const url = new URL(player[field]); if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error("INVALID_PLAYER_URL"); }
    if (player.thinking && (player.thinking.type !== "disabled" || Object.keys(player.thinking).join(",") !== "type") || player.reasoning_effort !== undefined && player.reasoning_effort !== "low") throw new Error("INVALID_MODEL_PARAMETERS");
  }
  if (sameAddress(c.players.black.wallet, c.players.white.wallet) ||
    c.players.black.chainId === c.players.white.chainId && sameAddress(c.players.black.account, c.players.white.account) && c.players.black.agentId === c.players.white.agentId) throw new Error("INDEPENDENT_PLAYERS_REQUIRED");
  return structuredClone(c);
}

export function moveRequest(config: MatchConfig, side: Side, board: Board): RequestBody {
  const player = config.players[side];
  return { service: player.service, model: player.model, tier: player.tier, stream: false, max_completion_tokens: player.maxCompletionTokens,
    ...(player.thinking ? { thinking: player.thinking } : {}), ...(player.reasoning_effort ? { reasoning_effort: player.reasoning_effort } : {}),
    messages: [{ role: "system", content: "You are one Gomoku player. The trusted Arena adjudicates. 15x15 free-style: black first, alternate one stone each turn; five or more contiguous stones horizontally, vertically or diagonally wins, no forbidden moves. X=black, O=white, .=empty. Coordinates are zero-based row/col 0..14. Return exactly one JSON object {\"row\":integer,\"col\":integer}, no Markdown, no verdict, no tools." },
      { role: "user", content: JSON.stringify({ matchId: config.matchId, rules: config.rules, side, ply: board.moves.length + 1, board: board.rows, moves: board.moves }) }] };
}
function validateHandle(turn: Turn, player: PlayerConfig) {
  const handle = turn.handle!; const quote = handle.quote;
  if (handle.version !== 1 || handle.relayUrl !== player.relayUrl || !isDeepStrictEqual(handle.input, { ...turn.body, agentId: player.agentId, taskId: "0" }) ||
    quote.agentId !== player.agentId || quote.taskId !== "0" || quote.service !== player.service || quote.model !== player.model || quote.tier !== player.tier ||
    quote.chainId !== player.chainId || !sameAddress(quote.account, player.account) || !sameAddress(quote.asset, player.asset) || !sameAddress(quote.payTo, player.provider) ||
    quote.requestDigest !== requestDigest(handle.input) || quote.paymentId !== paymentId("0", quote.requestDigest, quote.serverNonce) || uint(quote.price, "price") === 0n || BigInt(quote.price) > BigInt(player.maxPricePerMove)) fail("HANDLE_BINDING_MISMATCH");
  if (handle.submission?.rawTransaction) {
    const signed = Transaction.from(handle.submission.rawTransaction); const parsed = accountInterface.parseTransaction({ data: signed.data, value: signed.value });
    if (signed.hash !== handle.submission.txHash || signed.chainId !== BigInt(player.chainId) || !signed.from || !sameAddress(signed.from, player.wallet) || !signed.to || !sameAddress(signed.to, player.account) ||
      signed.nonce !== handle.submission.nonce || !parsed || parsed.name !== "payProvider" || parsed.args[0] !== BigInt(player.agentId) || !sameAddress(parsed.args[1], player.provider) || parsed.args[2] !== BigInt(quote.price) || parsed.args[3] !== quote.paymentId) fail("SIGNED_PAYMENT_MISMATCH");
  }
}
function validateInference(turn: Turn, player: PlayerConfig) {
  validateHandle(turn, player); const inference = turn.inference!; const receipt = inference.receipt; const quote = turn.handle!.quote;
  if (!isDeepStrictEqual(inference.handle, turn.handle) || ["paymentId", "agentId", "taskId", "requestDigest", "service", "price", "chainId", "tier"].some(field => (receipt as any)[field] !== (quote as any)[field]) ||
    ["account", "asset", "payTo"].some(field => !sameAddress((receipt as any)[field], (quote as any)[field])) ||
    receipt.fromCash !== quote.price || receipt.fromCredit !== "0" || receipt.txHash !== turn.handle!.submission?.txHash || !receipt.upstream || !receipt.model ||
    !Number.isSafeInteger(receipt.blockNumber) || receipt.blockNumber < quote.createdBlock || !Number.isSafeInteger(receipt.timestamp) || BigInt(receipt.timestamp) > BigInt(quote.quoteExpiry) || !/^0x[0-9a-fA-F]{64}$/.test(receipt.blockHash)) fail("INFERENCE_RECEIPT_MISMATCH");
  if (turn.rawPaymentReceipt) {
    const raw = turn.rawPaymentReceipt as any;
    const paid = (raw.logs as any[]).filter(log => sameAddress(log.address, player.account)).map(log => { try { return accountInterface.parseLog(log); } catch { return null; } }).filter(event => event?.name === "ProviderPaid");
    if (raw.status !== 1 || raw.hash !== receipt.txHash || raw.blockHash !== receipt.blockHash || raw.blockNumber !== receipt.blockNumber || paid.length !== 1 ||
      paid[0]!.args.agentId !== BigInt(player.agentId) || paid[0]!.args.paymentId !== quote.paymentId || !sameAddress(paid[0]!.args.provider, player.provider) || paid[0]!.args.fromCash !== BigInt(quote.price) || paid[0]!.args.fromCredit !== 0n) fail("RAW_PAYMENT_RECEIPT_MISMATCH");
  }
}

/** Independent deterministic replay; does not trust the saved winner, board, model verdict or summary. */
export function replayMatch(state: MatchSession): Board {
  const config = validateMatchConfig(state.config);
  if (state.version !== 1 || state.binding !== digest(config) || !["Running", "Paused", "Stopped", "Finished"].includes(state.phase) ||
    !state.reservedPrice || Object.keys(state.reservedPrice).sort().join(",") !== "black,white" || !Array.isArray(state.turns) || state.turns.length > config.maxPlies) throw new Error("TRANSCRIPT_BINDING_MISMATCH");
  let board = emptyBoard(); let outcome: MatchSession["result"];
  const totals = { black: 0n, white: 0n };
  for (const [index, turn] of state.turns.entries()) {
    if (outcome || turn.ply !== board.moves.length + 1 || turn.side !== board.next || turn.boardHash !== boardHash(board) || !isDeepStrictEqual(turn.body, moveRequest(config, turn.side, board)) ||
      typeof turn.applied !== "boolean" || typeof turn.dispatchIntent !== "boolean") throw new Error("TRANSCRIPT_TURN_MISMATCH");
    if (turn.handle) { validateHandle(turn, config.players[turn.side]); totals[turn.side] += BigInt(turn.handle.quote.price); }
    if (turn.inference) validateInference(turn, config.players[turn.side]);
    if (!turn.applied) { if (index !== state.turns.length - 1 || turn.rejection || turn.afterBoardHash) throw new Error("TRANSCRIPT_PENDING_MISMATCH"); continue; }
    if (!turn.inference || !turn.rawPaymentReceipt) throw new Error("MOVE_WITHOUT_PAID_INFERENCE");
    let rejection: string | undefined;
    try { board = play(board, { ply: turn.ply, side: turn.side, ...parseDecision(turn.inference.result) }); outcome = board.result; }
    catch (error) { if (!(error instanceof IllegalMove)) throw error; rejection = error.code; outcome = { kind: "forfeit", winner: other(turn.side), reason: rejection }; }
    if (rejection !== turn.rejection || turn.afterBoardHash !== boardHash(board)) throw new Error("TRANSCRIPT_VERDICT_MISMATCH");
  }
  for (const side of ["black", "white"] as const) if (state.reservedPrice[side] !== totals[side].toString() || totals[side] > BigInt(config.players[side].maxTotalPrice)) throw new Error("TRANSCRIPT_BUDGET_MISMATCH");
  if (!isDeepStrictEqual(state.result, outcome) || (Boolean(outcome) !== (state.phase === "Finished"))) throw new Error("TRANSCRIPT_OUTCOME_MISMATCH");
  return board;
}

export async function runMatch(directory: string, rawConfig: MatchConfig, options: MatchOptions): Promise<MatchSession> {
  const config = validateMatchConfig(rawConfig);
  if (options.timeoutMs !== undefined && (!Number.isSafeInteger(options.timeoutMs) || options.timeoutMs < 1 || options.timeoutMs > 60000)) throw new Error("INVALID_HTTP_TIMEOUT");
  const store = new SessionStore<MatchSession>(directory); await store.start(options.recoverLock);
  if (options.stopAfterPlies !== undefined && (!Number.isSafeInteger(options.stopAfterPlies) || options.stopAfterPlies < 0 || options.stopAfterPlies > config.maxPlies)) { await store.close(); throw new Error("INVALID_PAUSE_PLY"); }
  const providers = { black: new JsonRpcProvider(config.players.black.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 20 }), white: new JsonRpcProvider(config.players.white.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 20 }) };
  let state!: MatchSession;
  const save = () => store.write(state);
  const stop = async (reason: string) => { state.phase = "Stopped"; state.reason = reason; await save(); return structuredClone(state); };
  const pause = async (reason: string) => { state.phase = "Paused"; state.reason = reason; await save(); return structuredClone(state); };
  try {
    for (const side of ["black", "white"] as const) if (!sameAddress(await options.signers[side].getAddress(), config.players[side].wallet)) throw new Error("PLAYER_SIGNER_MISMATCH");
    const prior = await store.read();
    if (prior && (!isDeepStrictEqual(prior.config, config) || prior.binding !== digest(config))) throw new Error("MATCH_CONFIG_MISMATCH");
    state = prior ?? { version: 1, binding: digest(config), config, phase: "Running", reservedPrice: { black: "0", white: "0" }, turns: [] };
    let board = replayMatch(state);
    if (["Stopped", "Finished"].includes(state.phase)) return structuredClone(state);
    state.phase = "Running"; delete state.reason; await save();
    while (!board.result) {
      let turn = state.turns.at(-1); if (turn?.applied) turn = undefined;
      if (!turn) {
        if (Date.now() >= config.deadlineMs) return stop("MATCH_DEADLINE");
        if (board.moves.length >= config.maxPlies) return stop("PLY_LIMIT");
        if (options.stopAfterPlies !== undefined && board.moves.length >= options.stopAfterPlies) return pause("OPERATOR_PAUSE");
        const side = board.next; const player = config.players[side];
        if (BigInt(state.reservedPrice[side]) >= BigInt(player.maxTotalPrice)) return stop(`BUDGET_EXHAUSTED_${side.toUpperCase()}`);
        turn = { ply: board.moves.length + 1, side, boardHash: boardHash(board), body: moveRequest(config, side, board), dispatchIntent: false, applied: false };
        state.turns.push(turn); await save();
      }
      const current = turn; const player = config.players[current.side]; const rpc = providers[current.side];
      if (!current.inference) {
        let delivered: Inference | undefined;
        if (current.handle && current.dispatchIntent) {
          // Recovery is read-only until an exact Delivered cache is available or the original quote is proven unpaid.
          const statusUrl = new URL(player.relayUrl); statusUrl.pathname = `/payments/${current.handle.quote.paymentId}`;
          statusUrl.search = new URLSearchParams({ agentId: player.agentId, requestDigest: current.handle.quote.requestDigest }).toString();
          let status: any;
          try { const response = await fetch(statusUrl, { signal: AbortSignal.timeout(options.timeoutMs ?? 10000) }); status = await response.json(); if (!response.ok) return pause(status.error || "RELAY_STATUS_UNCERTAIN"); }
          catch { return pause("RELAY_STATUS_UNCERTAIN"); }
          if (status.paymentId !== current.handle.quote.paymentId) return pause("RELAY_STATUS_MISMATCH");
          if (status.state === "Delivered") delivered = { result: status.result, receipt: status.receipt, handle: structuredClone(current.handle) };
          else if (status.state === "Refunded") return stop("INFERENCE_REFUNDED");
          else if (status.state !== "Quoted") return pause("PAID_INFERENCE_UNKNOWN");
          else if (status.expiredPayment || status.refundPending || status.deliveryError) return pause(status.deliveryError || "PAYMENT_RECONCILIATION_REQUIRED");
        }
        if (!delivered) {
          if (Date.now() >= config.deadlineMs) return stop("MATCH_DEADLINE");
          const remaining = BigInt(player.maxTotalPrice) - BigInt(state.reservedPrice[current.side]);
          const cap = current.handle ? BigInt(current.handle.quote.price) : remaining < BigInt(player.maxPricePerMove) ? remaining : BigInt(player.maxPricePerMove);
          if (cap <= 0n) return stop(`BUDGET_EXHAUSTED_${current.side.toUpperCase()}`);
          const sdk = new InferCredit({ agentId: player.agentId, signer: options.signers[current.side], rpcUrl: player.rpcUrl, chainId: BigInt(player.chainId), account: player.account, asset: player.asset, provider: player.provider, maxPrice: cap, timeoutMs: options.timeoutMs ?? 10000,
            onHandle: async handle => {
              if (current.handle && current.handle.quote.paymentId !== handle.quote.paymentId) fail("HANDLE_REPLACED");
              validateHandle({ ...current, handle }, player);
              if (!current.handle) { const price = BigInt(handle.quote.price); if (price > remaining || price > BigInt(player.maxPricePerMove)) fail("BUDGET_LIMIT"); state.reservedPrice[current.side] = (BigInt(state.reservedPrice[current.side]) + price).toString(); }
              current.handle = structuredClone(handle); await save();
            }, beforePayment: () => { if (Date.now() >= config.deadlineMs) fail("MATCH_DEADLINE"); if (!current.handle) fail("HANDLE_NOT_PERSISTED"); } });
          current.dispatchIntent = true; await save();
          try { delivered = current.handle ? await sdk.resume(structuredClone(current.handle)) : await sdk.fetch(player.relayUrl, { body: current.body }); }
          catch (error) {
            const code = error instanceof PaymentError ? error.code : "MATCH_INFRASTRUCTURE_UNCERTAIN";
            if (code === "BUDGET_LIMIT" && !current.handle) return stop(`BUDGET_EXHAUSTED_${current.side.toUpperCase()}`);
            if (code === "CASH_REQUIRED") return stop(`CASH_EXHAUSTED_${current.side.toUpperCase()}`);
            if (code === "MATCH_DEADLINE") return stop(code);
            return pause(code);
          } finally { sdk.close(); }
        }
        validateInference({ ...current, inference: delivered }, player); current.inference = structuredClone(delivered); await save();
      }
      // Validate actual local-chain payment before adjudicating coordinates; raw receipts stay in the replay journal.
      if (!current.rawPaymentReceipt) {
        const receipt = await rpc.getTransactionReceipt(current.inference.receipt.txHash);
        if (!receipt) return pause("PAYMENT_RECEIPT_UNAVAILABLE");
        const block = await rpc.getBlock(receipt.blockNumber);
        if (block?.hash !== receipt.blockHash || block.timestamp !== current.inference.receipt.timestamp) return pause("PAYMENT_BLOCK_MISMATCH");
        const rawReceipt = JSON.parse(JSON.stringify(receipt.toJSON())) as Json; validateInference({ ...current, rawPaymentReceipt: rawReceipt }, player); current.rawPaymentReceipt = rawReceipt; await save();
      }
      if (Date.now() >= config.deadlineMs) return stop("MATCH_DEADLINE");
      try { board = play(board, { ply: current.ply, side: current.side, ...parseDecision(current.inference.result) }); state.result = board.result; }
      catch (error) { if (!(error instanceof IllegalMove)) throw error; current.rejection = error.code; state.result = { kind: "forfeit", winner: other(current.side), reason: error.code }; }
      current.applied = true; current.afterBoardHash = boardHash(board);
      if (state.result) { state.phase = "Finished"; delete state.reason; }
      await save(); replayMatch(state);
      if (state.phase === "Finished") return structuredClone(state);
    }
    return structuredClone(state);
  } catch (error) { if (state && !(error instanceof IllegalMove) && error instanceof PaymentError) return pause(error.code); throw error; }
  finally { providers.black.destroy(); providers.white.destroy(); await store.close(); }
}
