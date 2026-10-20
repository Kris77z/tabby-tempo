import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { JsonRpcProvider } from "ethers";
import { accountInterface, paymentId, requestDigest } from "@agentfuel/sdk/protocol";

const address = byte => `0x${byte.repeat(20)}`;
export const bindings = Object.freeze({ chainId: 31337n, agentId: "1", account: address("11"),
  asset: address("22"), provider: address("33"), wallet: address("44"), maxPrice: 10000n });
export const body = Object.freeze({ service: "infercredit/coder", model: "coder",
  messages: [{ role: "user", content: "Controlled standalone SDK example; no inference requested." }] });

/** A deliberately incomplete RPC/relay fixture. It cannot sign, broadcast, or contact an upstream. */
export async function startFixture({ mutateQuote = quote => quote, chainId = bindings.chainId } = {}) {
  const quotes = new Map();
  const counts = { quotes: 0, statuses: 0, transactionSends: 0, rawTransactionSends: 0 };
  const rpcMethods = [];
  function rpc({ id, method, params = [] }) {
    rpcMethods.push(method);
    let result;
    try {
      if (method === "eth_chainId") result = `0x${chainId.toString(16)}`;
      else if (method === "eth_accounts") result = [bindings.wallet];
      else if (method === "eth_call") {
        assert.equal(params[0].to.toLowerCase(), bindings.account);
        const call = accountInterface.parseTransaction({ data: params[0].data });
        if (call.name === "settlementAsset") result = accountInterface.encodeFunctionResult(call.name, [bindings.asset]);
        else if (call.name === "getPayment") result = accountInterface.encodeFunctionResult(call.name, [[1n, 0n, 0n, 0n, 0n]]);
        else throw new Error("Unexpected contract call: " + call.name);
      } else if (method === "eth_sendTransaction") {
        counts.transactionSends++; throw new Error("Fixture forbids transaction submission");
      } else if (method === "eth_sendRawTransaction") {
        counts.rawTransactionSends++; throw new Error("Fixture forbids raw transaction broadcast");
      } else throw new Error("Unsupported fixture RPC method: " + method);
      return { jsonrpc: "2.0", id, result };
    } catch (error) { return { jsonrpc: "2.0", id, error: { code: -32601, message: error.message } }; }
  }
  const server = createServer(async (request, response) => {
    const send = (status, value) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      if (request.method === "POST") {
        const chunks = [];
        for await (const chunk of request) chunks.push(chunk);
        const input = JSON.parse(Buffer.concat(chunks).toString());
        if (url.pathname === "/rpc") return send(200, Array.isArray(input) ? input.map(rpc) : rpc(input));
        if (url.pathname === "/v1/chat" && !request.headers["x-payment-id"]) {
          counts.quotes++;
          const digest = requestDigest(input), nonce = `0x${"55".repeat(32)}`;
          const quote = mutateQuote({ agentId: input.agentId, taskId: input.taskId, service: input.service, model: input.model,
            requestDigest: digest, paymentId: paymentId(input.taskId, digest, nonce), serverNonce: nonce,
            chainId: bindings.chainId.toString(), account: bindings.account, asset: bindings.asset, payTo: bindings.provider,
            price: bindings.maxPrice.toString(), createdBlock: 1, quoteExpiry: String(Math.floor(Date.now() / 1000) + 600) });
          quotes.set(quote.paymentId, { input, quote, state: "Quoted" });
          return send(402, { quote });
        }
      }
      if (request.method === "GET" && url.pathname.startsWith("/payments/")) {
        counts.statuses++;
        const record = quotes.get(url.pathname.slice("/payments/".length));
        if (!record || url.searchParams.get("agentId") !== record.input.agentId ||
          url.searchParams.get("requestDigest") !== record.quote.requestDigest) return send(404, { error: "UNKNOWN_PAYMENT" });
        return send(200, { state: record.state, result: record.result, receipt: record.receipt });
      }
      send(404, { error: "UNSUPPORTED_FIXTURE_ROUTE" });
    } catch { send(400, { error: "INVALID_FIXTURE_REQUEST" }); }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const origin = `http://127.0.0.1:${server.address().port}`;
  const provider = new JsonRpcProvider(`${origin}/rpc`, undefined, { cacheTimeout: -1, batchMaxCount: 1 });
  try {
    const signer = await provider.getSigner(bindings.wallet);
    return {
      options: { ...bindings, signer }, relayUrl: `${origin}/v1/chat`, counts, rpcMethods,
      // This is a preset delivery fixture, not a transaction confirmation or independently verified receipt.
      setDelivered(handle) {
        const record = quotes.get(handle.quote.paymentId);
        assert.ok(record); assert.deepEqual(record.quote, handle.quote);
        record.state = "Delivered";
        record.result = { mode: "fixture-only", content: "Preset cached response; no model was called." };
        record.receipt = { ...record.quote, txHash: `0x${"66".repeat(32)}`, blockHash: `0x${"77".repeat(32)}`,
          blockNumber: 2, timestamp: 1, fromCash: record.quote.price, fromCredit: "0",
          upstream: "loopback-fixture-not-a-real-provider", model: "fixture-model", usage: null };
      },
      async close() { provider.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); },
    };
  } catch (error) {
    provider.destroy(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); throw error;
  }
}
